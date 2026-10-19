"""Phase 3.0 — Unified tracking input source manager (camera / video / idle)."""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any, Callable, Literal

from tracking_input_frame import (
    CameraTrackingInputAdapter,
    TrackingInputFrame,
    VideoTrackingInputAdapter,
    make_uploaded_video_source_id,
    make_video_source_id,
    transform_camera_frame,
)
import video_upload_store
import camera_device_manager

TrackingSourceType = Literal["idle", "camera", "video", "uploaded-video"]

_SCRIPT_DIR = Path(__file__).resolve().parent
_PROJECT_ROOT = _SCRIPT_DIR.parent.parent
_TEST_VIDEO_DIR = _PROJECT_ROOT / "test_video"


def _catalog_entry(stem: str, *, default_video_start_ms: int = 3000) -> dict[str, Any]:
    path = (_TEST_VIDEO_DIR / f"{stem}.mp4").resolve()
    entry: dict[str, Any] = {
        "id": stem,
        "label": f"{stem}.mp4",
        "path": str(path),
        "defaultVideoStartMs": default_video_start_ms,
    }
    if path.is_file():
        probe = video_upload_store.probe_video_file(path)
        if probe:
            if probe.get("durationMs"):
                entry["durationMs"] = float(probe["durationMs"])
            if probe.get("fps"):
                entry["fps"] = float(probe["fps"])
    return entry


DEFAULT_VIDEO_CATALOG: list[dict[str, Any]] = [
    _catalog_entry("test01"),
    _catalog_entry("test02"),
    _catalog_entry("test03"),
    _catalog_entry("test04"),
]


def _scan_test_video_dir() -> list[dict[str, Any]]:
    if not _TEST_VIDEO_DIR.is_dir():
        return []
    videos: list[dict[str, Any]] = []
    for path in sorted(_TEST_VIDEO_DIR.glob("*.mp4")):
        videos.append(_catalog_entry(path.stem))
    return videos


def list_default_videos() -> list[dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}
    for entry in DEFAULT_VIDEO_CATALOG:
        by_id[str(entry["id"])] = dict(entry)
    for entry in _scan_test_video_dir():
        by_id[str(entry["id"])] = dict(entry)
    result: list[dict[str, Any]] = []
    for vid_id in sorted(by_id.keys()):
        entry = dict(by_id[vid_id])
        if Path(str(entry.get("path", ""))).is_file():
            result.append(entry)
    if result:
        return result
    return [dict(v) for v in DEFAULT_VIDEO_CATALOG]


def resolve_default_video_path(video_key: str) -> Path | None:
    key = str(video_key or "").strip()
    if not key:
        return None
    for entry in list_default_videos():
        entry_id = str(entry.get("id") or "")
        label = str(entry.get("label") or "")
        path = Path(str(entry.get("path") or ""))
        if key in (entry_id, label) and path.is_file():
            return path
    if key.startswith("video:"):
        parts = key.split(":")
        base = parts[1] if len(parts) > 1 else ""
        stem = Path(base).stem
        for entry in list_default_videos():
            path = Path(str(entry.get("path") or ""))
            if not path.is_file():
                continue
            if (
                str(entry.get("label") or "") == base
                or str(entry.get("id") or "") == stem
                or path.name == base
            ):
                return path
    return None


def _optional_camera_index(request: dict[str, Any]) -> int | None:
    """解析 cameraIndex；0 是合法值，不能用 `or` 链。"""
    for key in ("cameraIndex", "camera_index"):
        if key not in request:
            continue
        raw = request.get(key)
        if raw is None:
            continue
        return int(raw)
    return None


def resolve_video_path_from_request(request: dict[str, Any]) -> Path | None:
    video_path = request.get("videoPath") or request.get("video_path")
    if video_path:
        p = Path(str(video_path))
        if p.is_file():
            return p.resolve()
    source_id = str(request.get("sourceId") or request.get("source_id") or "").strip()
    if source_id:
        resolved = resolve_default_video_path(source_id)
        if resolved is not None and resolved.is_file():
            return resolved.resolve()
        for entry in list_default_videos():
            if source_id in (entry["id"], entry["label"], Path(entry["path"]).name):
                p = Path(entry["path"])
                if p.is_file():
                    return p.resolve()
    return None


class TrackingSourceManager:
    """Manages active camera/video adapter; increments sourceEpoch on each switch."""

    def __init__(
        self,
        *,
        open_camera_fn: Callable[..., tuple[Any, str]],
        camera_config: dict[str, Any] | None = None,
    ) -> None:
        self._open_camera_fn = open_camera_fn
        self._camera_config = dict(camera_config or {})
        self._camera_flip_horizontal = bool(
            self._camera_config.get("flip_horizontal", True)
        )
        self._lock = threading.RLock()
        self.source_epoch = 0
        self.current_source_type: TrackingSourceType = "idle"
        self.source_id: str | None = None
        self.status: str = "idle"
        self.message: str = "idle"
        self.preview_only_forced = False
        self.video_source_tuning_enabled = False
        self.video_device_dry_run_enabled = False
        self.video_real_send_smoke_test_enabled = False
        self.video_smoke_test_profile: str | None = None
        self._camera_index = int(self._camera_config.get("camera_index", 0))
        self._playback_rate = 1.0
        self._video_mode = "realtime"
        self._video_start_ms = 0.0
        self._deterministic = False
        self._uploaded_video_id: str | None = None
        self._camera_info: dict[str, Any] | None = None
        self._camera_input: CameraTrackingInputAdapter | None = None
        self._video_input: VideoTrackingInputAdapter | None = None
        self._cap: Any = None
        self._video_ended = False
        self._on_before_switch: list[Callable[[], None]] = []
        self._on_after_switch: list[Callable[[dict[str, Any]], None]] = []

    def register_before_switch(self, cb: Callable[[], None]) -> None:
        self._on_before_switch.append(cb)

    def register_after_switch(self, cb: Callable[[dict[str, Any]], None]) -> None:
        self._on_after_switch.append(cb)

    @property
    def source_type(self) -> TrackingSourceType:
        return self.current_source_type

    @property
    def is_video_source(self) -> bool:
        with self._lock:
            return self.current_source_type in ("video", "uploaded-video")

    @property
    def is_idle(self) -> bool:
        with self._lock:
            return self.current_source_type == "idle"

    @property
    def video_input(self) -> VideoTrackingInputAdapter | None:
        return self._video_input

    @property
    def camera_input(self) -> CameraTrackingInputAdapter | None:
        return self._camera_input

    @property
    def cap(self) -> Any:
        return self._cap

    @property
    def video_ended(self) -> bool:
        with self._lock:
            return bool(self._video_ended)

    @video_ended.setter
    def video_ended(self, value: bool) -> None:
        with self._lock:
            self._video_ended = bool(value)

    @property
    def video_paused(self) -> bool:
        with self._lock:
            if self._video_input is None:
                return False
            return bool(self._video_input.paused)

    def pause_video(self) -> bool:
        with self._lock:
            if not self.is_video_source or self._video_input is None:
                return False
            self._video_input.set_paused(True)
            self._video_ended = False
            return True

    def resume_video(self) -> bool:
        with self._lock:
            if not self.is_video_source or self._video_input is None:
                return False
            self._video_input.set_paused(False)
            self._video_ended = False
            return True

    def get_current_source(self) -> dict[str, Any]:
        with self._lock:
            out: dict[str, Any] = {
                "sourceType": self.current_source_type,
                "sourceEpoch": int(self.source_epoch),
                "sourceId": self.source_id,
                "status": self.status,
                "previewOnlyForced": bool(self.preview_only_forced),
                "videoSourceTuningEnabled": bool(self.video_source_tuning_enabled),
                "videoDeviceDryRunEnabled": bool(self.video_device_dry_run_enabled),
                "videoRealSendSmokeTestEnabled": bool(self.video_real_send_smoke_test_enabled),
                "videoSmokeTestProfile": self.video_smoke_test_profile,
                "message": self.message,
                **(
                    {"uploadedVideoId": self._uploaded_video_id}
                    if self._uploaded_video_id
                    else {}
                ),
            }
            if self._camera_info:
                out["cameraId"] = self._camera_info.get("cameraId")
                out["cameraIndex"] = self._camera_info.get("cameraIndex")
                out["cameraLabel"] = self._camera_info.get("label")
                out["cameraWidth"] = self._camera_info.get("width")
                out["cameraHeight"] = self._camera_info.get("height")
                out["cameraFps"] = self._camera_info.get("fps")
            if self.is_video_source and self._video_input is not None:
                out["videoStartMs"] = float(self._video_start_ms)
                out["videoDurationMs"] = float(self._video_input.duration_ms)
                out["playbackRate"] = float(self._playback_rate)
                out["videoPaused"] = bool(self._video_input.paused)
            return out

    def stop_current(self) -> None:
        if self._cap is not None:
            try:
                self._cap.release()
            except Exception:
                pass
            self._cap = None
        if self._video_input is not None:
            try:
                self._video_input.close()
            except Exception:
                pass
            self._video_input = None
        self._camera_input = None
        self._camera_info = None
        self._video_ended = False
        self._uploaded_video_id = None

    def switch_source(self, request: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            for cb in self._on_before_switch:
                try:
                    cb()
                except Exception:
                    pass

            source_type = str(
                request.get("sourceType") or request.get("source_type") or "idle"
            ).strip().lower()
            if source_type == "auto":
                source_type = "idle"
            if source_type not in ("idle", "camera", "video", "uploaded-video"):
                return {
                    "ok": False,
                    "error": f"invalid-source-type:{source_type}",
                    "sourceEpoch": int(self.source_epoch),
                }

            if source_type == "uploaded-video":
                uploaded_id = str(
                    request.get("uploadedVideoId") or request.get("uploaded_video_id") or ""
                ).strip()
                if not uploaded_id:
                    return {
                        "ok": False,
                        "error": "missing-uploaded-video-id",
                        "sourceEpoch": int(self.source_epoch),
                    }
                entry = video_upload_store.get_by_id(uploaded_id)
                if entry is None:
                    return {
                        "ok": False,
                        "error": "uploaded-video-not-found",
                        "sourceEpoch": int(self.source_epoch),
                    }
                video_path = video_upload_store.resolve_stored_path(entry)
                if video_path is None:
                    return {
                        "ok": False,
                        "error": "uploaded-video-file-missing",
                        "sourceEpoch": int(self.source_epoch),
                    }

                self.stop_current()
                self.source_epoch += 1
                self.current_source_type = "uploaded-video"
                self._playback_rate = max(
                    0.01,
                    float(request.get("playbackRate") or request.get("playback_rate") or 1.0),
                )
                vm = str(request.get("videoMode") or request.get("video_mode") or "realtime").strip().lower()
                self._deterministic = bool(request.get("deterministic")) or vm == "deterministic"
                self._video_mode = "deterministic" if self._deterministic else "realtime"
                self._video_start_ms = max(
                    0.0,
                    float(request.get("videoStartMs") or request.get("video_start_ms") or 0.0),
                )
                self._uploaded_video_id = uploaded_id
                try:
                    filename = str(entry.get("filename") or "upload.mp4")
                    source_id = make_uploaded_video_source_id(uploaded_id, filename)
                    self._video_input = VideoTrackingInputAdapter(
                        video_path,
                        source_id=source_id,
                        playback_rate=self._playback_rate,
                        source_type="uploaded-video",
                        uploaded_video_id=uploaded_id,
                    )
                    if self._video_start_ms > 0:
                        self._video_input.seek(self._video_start_ms)
                    self.source_id = self._video_input.source_id
                    self.status = "running"
                    self.message = "uploaded-video source active"
                    self.preview_only_forced = True
                    self.video_source_tuning_enabled = True
                except Exception as exc:
                    self.stop_current()
                    self.current_source_type = "idle"
                    self.source_id = "idle"
                    self.status = "error"
                    self.message = str(exc)
                    return {
                        "ok": False,
                        "error": str(exc),
                        "sourceType": "idle",
                        "sourceEpoch": int(self.source_epoch),
                    }
                result = self._result_ok("source switched to uploaded-video")
                result["uploadedVideoId"] = uploaded_id
                self._emit_after_switch(result)
                return result

            self.stop_current()
            self.source_epoch += 1
            self.current_source_type = source_type  # type: ignore[assignment]
            self._playback_rate = max(0.01, float(request.get("playbackRate") or request.get("playback_rate") or 1.0))
            vm = str(request.get("videoMode") or request.get("video_mode") or "realtime").strip().lower()
            self._deterministic = bool(request.get("deterministic")) or vm == "deterministic"
            self._video_mode = "deterministic" if self._deterministic else "realtime"
            self._video_start_ms = max(0.0, float(request.get("videoStartMs") or request.get("video_start_ms") or 0.0))

            if source_type == "idle":
                self.source_id = "idle"
                self.status = "idle"
                self.message = "source idle"
                self.preview_only_forced = False
                self.video_source_tuning_enabled = False
                result = self._result_ok("source switched to idle")
                self._emit_after_switch(result)
                return result

            if source_type == "camera":
                mgr = camera_device_manager.get_camera_device_manager(
                    open_camera_fn=self._open_camera_fn,
                    camera_backend=str(self._camera_config.get("camera_backend", "auto")),
                )
                try:
                    resolved = mgr.resolve_camera(
                        camera_id=str(
                            request.get("cameraId") or request.get("camera_id") or ""
                        ).strip()
                        or None,
                        camera_index=_optional_camera_index(request),
                    )
                except ValueError:
                    self.stop_current()
                    self.current_source_type = "idle"
                    self.source_id = "idle"
                    self.status = "error"
                    self.message = "camera-not-found"
                    return {
                        "ok": False,
                        "error": "camera-not-found",
                        "sourceType": "idle",
                        "sourceEpoch": int(self.source_epoch),
                    }
                self._camera_index = int(resolved["cameraIndex"])
                self._camera_info = dict(resolved)
                try:
                    self._cap, _backend = self._open_camera_fn(
                        self._camera_index,
                        str(self._camera_config.get("camera_backend", "auto")),
                    )
                    if not self._cap.isOpened():
                        raise RuntimeError(f"cannot open camera index={self._camera_index}")
                    self._apply_camera_props()
                    try:
                        import cv2

                        aw, ah, afps = (
                            int(self._cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
                            int(self._cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
                            float(self._cap.get(cv2.CAP_PROP_FPS)),
                        )
                        if aw > 0:
                            self._camera_info["width"] = aw
                        if ah > 0:
                            self._camera_info["height"] = ah
                        if afps > 1e-3:
                            self._camera_info["fps"] = round(afps, 2)
                    except Exception:
                        pass
                    self._camera_input = CameraTrackingInputAdapter(
                        camera_id=str(resolved["cameraId"]),
                        camera_index=self._camera_index,
                        label=str(resolved.get("label") or f"Camera {self._camera_index}"),
                        width=int(self._camera_info.get("width") or 640),
                        height=int(self._camera_info.get("height") or 480),
                        fps=float(self._camera_info.get("fps") or 30.0),
                    )
                    self.source_id = self._camera_input.source_id
                    self.status = "running"
                    self.message = "camera source active"
                    self.preview_only_forced = False
                    self.video_source_tuning_enabled = False
                except Exception as exc:
                    self.stop_current()
                    self.current_source_type = "idle"
                    self.source_id = "idle"
                    self.status = "error"
                    self.message = str(exc)
                    return {
                        "ok": False,
                        "error": str(exc),
                        "sourceType": "idle",
                        "sourceEpoch": int(self.source_epoch),
                    }
                result = self._result_ok("source switched to camera")
                for key in (
                    "cameraId",
                    "cameraIndex",
                    "label",
                    "width",
                    "height",
                    "fps",
                ):
                    if key in self._camera_info:
                        if key == "label":
                            result["cameraLabel"] = self._camera_info[key]
                        elif key == "width":
                            result["cameraWidth"] = self._camera_info[key]
                        elif key == "height":
                            result["cameraHeight"] = self._camera_info[key]
                        elif key == "fps":
                            result["cameraFps"] = self._camera_info[key]
                        else:
                            result[key] = self._camera_info[key]
                self._emit_after_switch(result)
                return result

            # video
            video_path = resolve_video_path_from_request(request)
            if video_path is None:
                self.current_source_type = "idle"
                self.source_id = "idle"
                self.status = "error"
                self.message = "video file not found"
                return {
                    "ok": False,
                    "error": "video-file-not-found",
                    "sourceEpoch": int(self.source_epoch),
                }
            try:
                self._video_input = VideoTrackingInputAdapter(
                    video_path,
                    playback_rate=self._playback_rate,
                )
                if self._video_start_ms > 0:
                    self._video_input.seek(self._video_start_ms)
                self.source_id = self._video_input.source_id
                self.status = "running"
                self.message = "video source active"
                self.preview_only_forced = True
                self.video_source_tuning_enabled = True
            except Exception as exc:
                self.stop_current()
                self.current_source_type = "idle"
                self.source_id = "idle"
                self.status = "error"
                self.message = str(exc)
                return {
                    "ok": False,
                    "error": str(exc),
                    "sourceType": "idle",
                    "sourceEpoch": int(self.source_epoch),
                }
            result = self._result_ok("source switched to video")
            self._emit_after_switch(result)
            return result

    def _apply_camera_props(self) -> None:
        import cv2

        cap = self._cap
        if cap is None:
            return
        cfg = self._camera_config
        fw = max(160, int(cfg.get("frame_width", 640)))
        fh = max(120, int(cfg.get("frame_height", 480)))
        cfps = max(1.0, float(cfg.get("camera_fps", 30.0)))
        bsz = max(1, int(cfg.get("buffer_size", 1)))
        try:
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, float(fw))
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, float(fh))
            cap.set(cv2.CAP_PROP_FPS, float(cfps))
            cap.set(cv2.CAP_PROP_BUFFERSIZE, float(bsz))
        except Exception:
            pass

    def _video_source_meta(self) -> dict[str, Any]:
        if not self.is_video_source or self._video_input is None:
            return {}
        return {
            "videoStartMs": float(self._video_start_ms),
            "videoDurationMs": float(self._video_input.duration_ms),
            "playbackRate": float(self._playback_rate),
        }

    def _result_ok(self, message: str) -> dict[str, Any]:
        return {
            "ok": True,
            "sourceType": self.current_source_type,
            "sourceId": self.source_id,
            "sourceEpoch": int(self.source_epoch),
            "status": self.status,
            "previewOnlyForced": bool(self.preview_only_forced),
            "videoSourceTuningEnabled": bool(self.video_source_tuning_enabled),
            "videoDeviceDryRunEnabled": bool(self.video_device_dry_run_enabled),
            "videoRealSendSmokeTestEnabled": bool(self.video_real_send_smoke_test_enabled),
            "videoSmokeTestProfile": self.video_smoke_test_profile,
            "message": message,
            **self._video_source_meta(),
        }

    def _emit_after_switch(self, result: dict[str, Any]) -> None:
        for cb in self._on_after_switch:
            try:
                cb(result)
            except Exception:
                pass

    def stamp_input_source(self, input_src: dict[str, Any] | None) -> dict[str, Any] | None:
        if not input_src:
            return input_src
        out = {**input_src, "sourceEpoch": int(self.source_epoch)}
        if self.is_video_source:
            out["videoMode"] = self._video_mode
        elif self.current_source_type == "camera" and self._camera_input is not None:
            out.update(self._camera_input.camera_info)
            out["videoTimeMs"] = None
        return out

    def read_frame(self) -> TrackingInputFrame | None:
        with self._lock:
            if self.current_source_type == "idle":
                return None
            if self.is_video_source:
                if self._video_ended or self._video_input is None:
                    return None
                frame = self._video_input.next_frame(
                    realtime_catch_up=self._video_mode == "realtime",
                )
                if frame is None and not self._video_input.paused:
                    self._video_ended = True
                return frame
            if self._cap is None or self._camera_input is None:
                return None
            import time

            ok, image = self._cap.read()
            if not ok or image is None:
                return None
            image = transform_camera_frame(
                image, flip_horizontal=self._camera_flip_horizontal
            )
            return self._camera_input.next_frame(image, time.time() * 1000.0)

    def read_camera_raw(self) -> tuple[bool, Any]:
        """Direct cap.read for legacy build_frame_dict camera path."""
        if self._cap is None:
            return False, None
        return self._cap.read()

    def replay_video(self, reason: str = "", video_time_ms: float | None = None) -> bool:
        with self._lock:
            if not self.is_video_source or self._video_input is None:
                return False
            self._video_ended = False
            self._video_input.reset(reason)
            seek_ms = (
                max(0.0, float(video_time_ms))
                if video_time_ms is not None
                else float(self._video_start_ms)
            )
            if seek_ms > 0:
                self._video_input.seek(seek_ms)
                self._video_start_ms = seek_ms
            return True

    def seek_video(self, video_time_ms: float) -> bool:
        with self._lock:
            if not self.is_video_source or self._video_input is None:
                return False
            self._video_ended = False
            ms = max(0.0, float(video_time_ms))
            self._video_input.seek(ms)
            self._video_start_ms = ms
            return True

    def get_loop_interval_sec(self, process_interval_sec: float) -> float:
        if self.is_video_source and self._video_input is not None:
            if self._video_mode == "deterministic":
                return 0.0
            v = float(self._video_input.frame_interval_sec)
            if process_interval_sec > 1e-12:
                return max(v, process_interval_sec)
            return v
        return process_interval_sec

    def should_defer_video_frame_build(self, clients: int, can_send: bool) -> bool:
        if not self.is_video_source or self._video_ended:
            return False
        if self._video_mode == "deterministic":
            return int(clients) <= 0 or not bool(can_send)
        return False

    def close(self) -> None:
        with self._lock:
            self.stop_current()
