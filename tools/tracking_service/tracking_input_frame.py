"""Tracking 输入源抽象：camera / video / replay 统一 envelope。"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Literal, TypedDict

import cv2
import numpy as np

TrackingInputSource = Literal["camera", "video", "uploaded-video", "replay"]


def transform_camera_frame(image: Any, *, flip_horizontal: bool = True) -> Any:
    """
    多数 UVC / 内置摄像头默认输出自拍镜像帧；统一水平翻转后再做 tracking / MJPEG，
    使预览与 MediaPipe 坐标系一致（非镜像、左即左）。
    """
    if not flip_horizontal or image is None:
        return image
    return cv2.flip(image, 1)


class TrackingInputFrame(TypedDict, total=False):
    sourceType: TrackingInputSource
    sourceId: str
    sourceSeq: int
    frameIndex: int
    timestampMs: float
    videoTimeMs: float | None
    playbackRate: float | None
    paused: bool | None
    seeking: bool | None
    seekEpoch: int | None
    image: Any  # np.ndarray (BGR) on Python; not serialized over WebSocket


def input_source_debug_dict(input_frame: dict[str, Any] | None) -> dict[str, Any] | None:
    """从 TrackingInputFrame 提取可 JSON 序列化的 inputSource 诊断块。"""
    if not isinstance(input_frame, dict):
        return None
    out: dict[str, Any] = {
        "sourceType": str(input_frame.get("sourceType") or "camera"),
        "sourceId": str(input_frame.get("sourceId") or "camera-default"),
        "sourceSeq": int(input_frame.get("sourceSeq") or 0),
        "frameIndex": int(input_frame.get("frameIndex") or 0),
        "timestampMs": float(input_frame.get("timestampMs") or 0.0),
        "videoTimeMs": (
            float(input_frame["videoTimeMs"])
            if input_frame.get("videoTimeMs") is not None
            else None
        ),
        "playbackRate": (
            float(input_frame["playbackRate"])
            if input_frame.get("playbackRate") is not None
            else None
        ),
        "paused": bool(input_frame.get("paused")) if "paused" in input_frame else False,
        "seeking": bool(input_frame.get("seeking")) if "seeking" in input_frame else False,
        "seekEpoch": int(input_frame.get("seekEpoch") or 0),
        "sourceEpoch": int(input_frame.get("sourceEpoch") or 0),
    }
    if input_frame.get("uploadedVideoId") is not None:
        out["uploadedVideoId"] = str(input_frame.get("uploadedVideoId"))
    if input_frame.get("videoMode") is not None:
        out["videoMode"] = str(input_frame.get("videoMode"))
    for key in (
        "cameraId",
        "cameraIndex",
        "cameraLabel",
        "cameraWidth",
        "cameraHeight",
        "cameraFps",
    ):
        if input_frame.get(key) is not None:
            out[key] = input_frame.get(key)
    return out


def make_camera_source_id(camera_index: int) -> str:
    return f"camera:index:{int(camera_index)}"


class CameraTrackingInputAdapter:
    """OpenCV 摄像头帧 → TrackingInputFrame。"""

    __slots__ = (
        "_source_id",
        "_camera_id",
        "_camera_index",
        "_camera_label",
        "_camera_width",
        "_camera_height",
        "_camera_fps",
        "_source_seq",
        "_frame_index",
    )

    def __init__(
        self,
        *,
        camera_id: str | None = None,
        camera_index: int = 0,
        label: str | None = None,
        width: int = 640,
        height: int = 480,
        fps: float = 30.0,
        source_id: str | None = None,
    ) -> None:
        idx = int(camera_index)
        self._camera_id = str(camera_id or make_camera_source_id(idx))
        self._camera_index = idx
        self._camera_label = str(label or f"Camera {idx}")
        self._camera_width = int(width)
        self._camera_height = int(height)
        self._camera_fps = float(fps)
        self._source_id = str(source_id or self._camera_id)
        self._source_seq = 0
        self._frame_index = 0

    @property
    def source_id(self) -> str:
        return self._source_id

    @property
    def camera_info(self) -> dict[str, Any]:
        return {
            "cameraId": self._camera_id,
            "cameraIndex": self._camera_index,
            "cameraLabel": self._camera_label,
            "cameraWidth": self._camera_width,
            "cameraHeight": self._camera_height,
            "cameraFps": self._camera_fps,
        }

    def next_frame(
        self,
        image: np.ndarray,
        timestamp_ms: float | None = None,
    ) -> TrackingInputFrame:
        now = float(timestamp_ms if timestamp_ms is not None else time.time() * 1000.0)
        self._source_seq += 1
        self._frame_index += 1
        return {
            "sourceType": "camera",
            "sourceId": self._source_id,
            "sourceSeq": int(self._source_seq),
            "frameIndex": int(self._frame_index),
            "timestampMs": now,
            "videoTimeMs": None,
            "cameraId": self._camera_id,
            "cameraIndex": self._camera_index,
            "cameraLabel": self._camera_label,
            "cameraWidth": self._camera_width,
            "cameraHeight": self._camera_height,
            "cameraFps": self._camera_fps,
            "image": image,
        }

    def reset(self, reason: str | None = None) -> None:
        _ = reason
        self._source_seq = 0
        self._frame_index = 0


def make_uploaded_video_source_id(uploaded_video_id: str, filename: str) -> str:
    safe = sanitize_upload_filename(filename)
    return f"uploaded-video:{uploaded_video_id}:{safe}"


def sanitize_upload_filename(name: str) -> str:
    base = Path(str(name or "upload.mp4")).name
    return base or "upload.mp4"


def make_video_source_id(video_path: str | Path) -> str:
    """video:<basename>:<size>:<mtime> — 第一版不做全文件 hash。"""
    p = Path(video_path)
    try:
        st = p.stat()
        size = int(st.st_size)
        mtime = int(st.st_mtime)
    except OSError:
        size = 0
        mtime = 0
    base = p.name or "unknown"
    return f"video:{base}:{size}:{mtime}"


def resolve_video_time_ms(cap: Any, *, frame_index: int, fps: float) -> float:
    """基于 frame_index / fps 计算时间；POS_MSEC 仅作参考。"""
    safe_fps = max(float(fps), 1.0)
    idx = max(0, int(frame_index))
    from_index = float(idx * 1000.0 / safe_fps)
    pos_msec = 0.0
    try:
        pos_msec = float(cap.get(cv2.CAP_PROP_POS_MSEC))
    except Exception:
        pos_msec = 0.0
    if not pos_msec or pos_msec <= 0.0:
        return from_index
    frame_ms = 1000.0 / safe_fps
    if abs(pos_msec - from_index) > frame_ms * 2.0:
        return from_index
    return float(pos_msec)


def _read_cap_frame_index(cap: Any, fallback: int = 0) -> int:
    try:
        pos = int(cap.get(cv2.CAP_PROP_POS_FRAMES))
    except Exception:
        pos = int(fallback)
    return max(0, pos - 1)


class VideoTrackingInputAdapter:
    """视频文件 → TrackingInputFrame（timestampMs = videoTimeMs）。"""

    __slots__ = (
        "_video_path",
        "_source_id",
        "_source_type",
        "_uploaded_video_id",
        "_playback_rate",
        "_cap",
        "_source_seq",
        "_frame_index",
        "_seek_epoch",
        "_paused",
        "_seeking",
        "_fps",
        "_frame_interval_ms",
        "_ended",
        "_last_frame",
        "_seek_base_frame",
        "_seek_base_ms",
        "_last_video_time_ms",
        "_play_wall_t0",
        "_pause_anchor_video_ms",
    )

    def __init__(
        self,
        video_path: str | Path,
        source_id: str | None = None,
        playback_rate: float = 1.0,
        *,
        source_type: Literal["video", "uploaded-video"] = "video",
        uploaded_video_id: str | None = None,
    ) -> None:
        self._video_path = Path(video_path)
        if not self._video_path.is_file():
            raise FileNotFoundError(f"video file not found: {self._video_path}")
        self._source_type = source_type
        self._uploaded_video_id = str(uploaded_video_id) if uploaded_video_id else None
        self._source_id = str(source_id or make_video_source_id(self._video_path))
        self._playback_rate = max(0.01, float(playback_rate))
        self._cap = cv2.VideoCapture(str(self._video_path.resolve()))
        if not self._cap.isOpened():
            raise RuntimeError(f"cannot open video: {self._video_path}")
        self._source_seq = 0
        self._frame_index = 0
        self._seek_epoch = 0
        self._paused = False
        self._seeking = False
        self._ended = False
        self._last_frame: np.ndarray | None = None
        self._seek_base_frame = 0
        self._seek_base_ms = 0.0
        self._last_video_time_ms = 0.0
        try:
            fps_raw = float(self._cap.get(cv2.CAP_PROP_FPS))
        except Exception:
            fps_raw = 0.0
        self._fps = fps_raw if fps_raw > 1e-3 else 30.0
        self._frame_interval_ms = 1000.0 / self._fps / self._playback_rate
        self._play_wall_t0 = time.monotonic()
        self._pause_anchor_video_ms = 0.0

    @property
    def source_id(self) -> str:
        return self._source_id

    @property
    def fps(self) -> float:
        return float(self._fps)

    @property
    def duration_ms(self) -> float:
        try:
            frame_count = float(self._cap.get(cv2.CAP_PROP_FRAME_COUNT))
        except Exception:
            frame_count = 0.0
        if frame_count > 0.5:
            return float(frame_count * 1000.0 / self._fps)
        try:
            pos_ms = float(self._cap.get(cv2.CAP_PROP_POS_MSEC))
        except Exception:
            pos_ms = 0.0
        return max(0.0, pos_ms)

    @property
    def frame_interval_sec(self) -> float:
        return max(1e-6, float(self._frame_interval_ms) / 1000.0)

    @property
    def ended(self) -> bool:
        return bool(self._ended)

    @property
    def last_frame(self) -> np.ndarray | None:
        return self._last_frame

    @property
    def paused(self) -> bool:
        return bool(self._paused)

    def set_paused(self, value: bool) -> None:
        next_paused = bool(value)
        if next_paused and not self._paused:
            self._pause_anchor_video_ms = float(self._last_video_time_ms)
            self._play_wall_t0 = None
        elif not next_paused and self._paused:
            self._sync_play_wall_from_video_ms(self._pause_anchor_video_ms)
        self._paused = next_paused

    def _sync_play_wall_from_video_ms(self, video_ms: float) -> None:
        elapsed_video_sec = max(
            0.0,
            (float(video_ms) - self._seek_base_ms) / 1000.0 / self._playback_rate,
        )
        self._play_wall_t0 = time.monotonic() - elapsed_video_sec

    def _target_video_time_ms(self) -> float:
        if self._play_wall_t0 is None or self._paused:
            return float(self._last_video_time_ms)
        elapsed = max(
            0.0,
            (time.monotonic() - self._play_wall_t0) * 1000.0 * self._playback_rate,
        )
        return float(self._seek_base_ms) + elapsed

    def _read_and_advance(self) -> tuple[Any, int, float] | None:
        ok, frame = self._cap.read()
        if not ok or frame is None:
            self._ended = True
            return None
        self._last_frame = frame
        frame_index = int(self._frame_index)
        video_time_ms = self._compute_video_time_ms(frame_index)
        self._frame_index = frame_index + 1
        return frame, frame_index, video_time_ms

    def _sync_seek_anchor(self, video_time_ms: float) -> None:
        ms = max(0.0, float(video_time_ms))
        safe_fps = max(float(self._fps), 1.0)
        base_frame = max(0, int(round(ms * safe_fps / 1000.0)))
        self._seek_base_frame = base_frame
        self._seek_base_ms = ms
        self._last_video_time_ms = ms
        self._frame_index = base_frame

    def _compute_video_time_ms(self, frame_index: int) -> float:
        safe_fps = max(float(self._fps), 1.0)
        idx = max(0, int(frame_index))
        from_index = self._seek_base_ms + (idx - self._seek_base_frame) * 1000.0 / safe_fps
        next_ms = max(float(self._last_video_time_ms), float(from_index))
        self._last_video_time_ms = next_ms
        return next_ms

    def next_frame(self, *, realtime_catch_up: bool = False) -> TrackingInputFrame | None:
        if self._ended or self._paused:
            return None

        if realtime_catch_up and self._play_wall_t0 is not None:
            target_ms = self._target_video_time_ms()
            slack_ms = float(self._frame_interval_ms) * 0.5
            max_skip = max(2, int(self._fps * 3))
            skipped = 0
            while skipped < max_skip and not self._ended:
                next_projected = float(self._last_video_time_ms) + float(self._frame_interval_ms)
                if next_projected >= target_ms - slack_ms:
                    break
                if self._read_and_advance() is None:
                    return None
                skipped += 1

        advanced = self._read_and_advance()
        if advanced is None:
            return None
        frame, frame_index, video_time_ms = advanced

        self._source_seq += 1

        return {
            "sourceType": self._source_type,
            "sourceId": self._source_id,
            "sourceSeq": int(self._source_seq),
            "frameIndex": int(frame_index),
            "timestampMs": float(video_time_ms),
            "videoTimeMs": float(video_time_ms),
            "playbackRate": float(self._playback_rate),
            "paused": bool(self._paused),
            "seeking": bool(self._seeking),
            "seekEpoch": int(self._seek_epoch),
            "image": frame,
            **(
                {"uploadedVideoId": self._uploaded_video_id}
                if self._uploaded_video_id
                else {}
            ),
        }

    def seek(self, video_time_ms: float) -> None:
        ms = max(0.0, float(video_time_ms))
        self._seeking = True
        try:
            self._cap.set(cv2.CAP_PROP_POS_MSEC, ms)
        finally:
            self._seeking = False
        self._sync_seek_anchor(ms)
        self._seek_epoch += 1
        self._ended = False
        if not self._paused:
            self._sync_play_wall_from_video_ms(ms)

    def reset(self, reason: str = "") -> None:
        _ = reason
        self._source_seq = 0
        self._frame_index = 0
        self._seek_epoch = 0
        self._paused = False
        self._seeking = False
        self._ended = False
        self._last_frame = None
        try:
            self._cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        except Exception:
            pass
        self._sync_seek_anchor(0.0)
        self._sync_play_wall_from_video_ms(0.0)

    def close(self) -> None:
        try:
            self._cap.release()
        except Exception:
            pass
