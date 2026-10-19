"""
MediaPipe Face Landmarker + WebSocket：输出统一 tracking.rigFrame（source=python-mediapipe）。
不写舵机、不涉及绑定与 WebSerial。
阶段 2.5：mapping JSON、debug 字段、命令行中性脸校准。
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import copy
import json
import mimetypes
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote

import cv2
import numpy as np

try:
    import mediapipe as mp
except ImportError as exc:  # pragma: no cover
    print(
        "错误：未安装 mediapipe。请执行: pip install -r requirements.txt\n"
        f"原始错误: {exc}",
        file=sys.stderr,
    )
    sys.exit(3)

import websockets

try:
    from websockets.exceptions import ConnectionClosed
except ImportError:  # pragma: no cover
    ConnectionClosed = Exception  # type: ignore[misc,assignment]

from mediapipe_mapping_config import load_mapping_config, save_mapping_config
from jaw_geometry import (
    create_jaw_geometry_state,
    reset_jaw_geometry_state,
    start_jaw_neutral_calibration,
)
from lip_geometry import (
    create_lip_geometry_state,
    reset_lip_geometry_state,
    start_lip_neutral_calibration,
)
from nose_anchor_frame import (
    create_nose_anchor_state,
    reset_nose_anchor_state,
    start_nose_neutral_calibration,
)
from mouth_scenario import (
    create_mouth_scenario_state,
    reset_mouth_scenario_state,
)
from mouth_corner_geometry import (
    create_mouth_corner_state,
    reset_mouth_corner_state,
    start_mouth_corner_neutral_calibration,
)
from brow_gate import (
    create_brow_state,
    reset_brow_state,
)
from eye_xy_auto_center import (
    EyeXyAutoCenterCollector,
    GAZE_ESTIMATOR_VERSION,
    NEUTRAL_STORE_SCHEMA_VERSION,
)
from gaze_neutral_init import GazeNeutralInitSession
from gaze_iris_only import IRIS_ONLY_MODE, reset_iris_gaze_runtime
from mediapipe_to_rig import (
    create_neutral_rig,
    estimate_eye_gaze_from_landmarks,
    estimate_tracking_quality,
    extract_debug_blendshapes,
    extract_landmarks,
    gaze_trace_keys,
    get_landmark_xy,
    mediapipe_result_to_rig,
    _gaze_blink_update_weight,
)
from preview_landmark_overlay import (
    PreviewOverlayConfig,
    draw_preview_landmark_overlay,
    resolve_preview_overlay_config,
)
from tracking_input_frame import (
    CameraTrackingInputAdapter,
    VideoTrackingInputAdapter,
    input_source_debug_dict,
)
from tracking_source_manager import TrackingSourceManager, list_default_videos, resolve_default_video_path
from tracking_dataset_recorder import TrackingDatasetRecorder
import video_upload_store
import camera_device_manager
from tracking_landmark_debug import build_tracking_debug
from roi_tracking import (
    RoiRect,
    build_face_scale_debug,
    compute_roi_rect,
    crop_bgr_frame,
    face_detected_in_result,
    is_roi_tracking_mode,
    normalize_roi_multiplier,
    normalize_tracking_mode,
    remap_result_landmarks_to_full,
)
from stable_roi_tracking import StableRoiTracker

TRACKING_FRAME_TYPE = "tracking.rigFrame"
SOURCE = "python-mediapipe"
_VIDEO_DEBUG_WS_LOGGED = False


def _log_video_debug_ws_payload(d: dict) -> None:
    global _VIDEO_DEBUG_WS_LOGGED
    if _VIDEO_DEBUG_WS_LOGGED:
        return
    dbg = d.get("debug") if isinstance(d.get("debug"), dict) else None
    if not isinstance(dbg, dict):
        return
    src = dbg.get("inputSource") if isinstance(dbg.get("inputSource"), dict) else None
    if not isinstance(src, dict) or src.get("sourceType") != "video":
        return
    td = dbg.get("trackingDebug") if isinstance(dbg.get("trackingDebug"), dict) else None
    _VIDEO_DEBUG_WS_LOGGED = True
    keys = list((td or {}).get("selectedLandmarks", {}).keys()) if td else []
    mesh_n = len((td or {}).get("allLandmarks") or []) if td else 0
    print(
        f"[video-debug] ws payload debug.trackingDebug exists: {bool(td)}",
        flush=True,
    )
    print(f"[video-debug] selectedLandmarks keys: {keys[:12]}", flush=True)
    print(f"[video-debug] faceBox exists: {bool(td and td.get('faceBox'))}", flush=True)
    print(f"[video-debug] allLandmarks count: {mesh_n}", flush=True)

_SCRIPT_DIR = Path(__file__).resolve().parent
_DEFAULT_MAPPING = _SCRIPT_DIR / "mediapipe_mapping.default.json"
_DEFAULT_SAVE_MAPPING = _SCRIPT_DIR / "models" / "mediapipe_mapping.json"
_CALIB_FRAMES = 30
_DEFAULT_PREVIEW_PATH = "/preview.mjpg"

_FPS_WINDOW_SEC = 0.55


class _SlidingFps:
    """滑窗内事件 tick 次数 → 近似 FPS（与前端 adapter 500ms 窗口同量级）。"""

    __slots__ = ("_w", "_t")

    def __init__(self, window_sec: float = _FPS_WINDOW_SEC) -> None:
        self._w = float(window_sec)
        self._t: list[float] = []

    def tick(self) -> None:
        now = time.perf_counter()
        self._t.append(now)
        self._trim(now)

    def _trim(self, now: float) -> None:
        while self._t and now - self._t[0] > self._w:
            self._t.pop(0)

    def fps(self) -> float:
        now = time.perf_counter()
        self._trim(now)
        if len(self._t) < 2:
            return 0.0
        return (len(self._t) - 1) / max(1e-9, self._t[-1] - self._t[0])


def _handle_tracking_control_message(session: Any, message: str) -> None:
    """客户端 tracking.control 消息（如 Set Lip Neutral）。"""
    try:
        data = json.loads(message)
    except (json.JSONDecodeError, TypeError):
        return
    if not isinstance(data, dict) or data.get("type") != "tracking.control":
        return
    action = str(data.get("action") or "").strip()
    if action in (
        "resetLipNeutral",
        "setLipNeutral",
        "resetLipGeometry",
        "autoLipNeutralOnStart",
        "resetBrowNeutral",
        "autoBrowNeutralOnStart",
    ):
        reason = str(data.get("reason") or action)
        start_lip_neutral_calibration(getattr(session, "_lip_state", None), reason)
        start_jaw_neutral_calibration(getattr(session, "_jaw_state", None), reason)
        start_mouth_corner_neutral_calibration(getattr(session, "_mouth_corner_state", None), reason)
        start_nose_neutral_calibration(getattr(session, "_nose_state", None), reason)
        reset_mouth_scenario_state(getattr(session, "_mouth_scenario_state", None))
        reset_brow_state(getattr(session, "_brow_state", None))
        print(f"[mediapipe] mouth (lip+jaw+nose) neutral calibration started ({reason})", flush=True)
    elif action in ("resetIrisGaze", "startCameraTracking", "stopCameraTracking"):
        reason = str(data.get("reason") or action)
        armed = data.get("armed")
        if action == "startCameraTracking":
            armed = True
        elif action == "stopCameraTracking":
            armed = False
        elif armed is None:
            armed = "stop" not in reason.lower()
        armed_bool = bool(armed)
        gaze_state = getattr(session, "_gaze_state", None)
        if isinstance(gaze_state, dict):
            reset_iris_gaze_runtime(gaze_state)
            gaze_state["iris_gaze_armed"] = armed_bool
        session._iris_gaze_armed = armed_bool
        session._iris_init_session_key = None
        session._iris_init_ready_logged = False
        print(
            f"[mediapipe] Iris-only gaze runtime reset ({reason}), armed={armed_bool}",
            flush=True,
        )
    elif action == "replayVideo":
        reason = str(data.get("reason") or action)
        replay = getattr(session, "replay_video", None)
        if callable(replay):
            replay(reason)
    elif action == "setRoiTracking":
        setter = getattr(session, "set_roi_tracking", None)
        if callable(setter):
            mode = data.get("mode")
            enabled = data.get("enabled")
            multiplier = data.get("multiplier")
            if enabled is None and mode is not None:
                enabled = is_roi_tracking_mode(normalize_tracking_mode(mode))
            setter(
                mode=mode,
                enabled=bool(enabled) if enabled is not None else None,
                multiplier=multiplier,
            )
    elif action == "seekVideo":
        seeker = getattr(session, "seek_video", None)
        ms = data.get("videoTimeMs")
        if callable(seeker) and ms is not None:
            seeker(float(ms))
    elif action == "pauseVideo":
        pauser = getattr(session, "pause_video", None)
        if callable(pauser):
            pauser()
    elif action == "resumeVideo":
        resumer = getattr(session, "resume_video", None)
        if callable(resumer):
            resumer()
    elif action == "prepareVideoDiagnostic":
        ms = float(data.get("videoStartMs") or data.get("videoTimeMs") or 0)
        replay = getattr(session, "replay_video", None)
        if callable(replay):
            replay(str(data.get("reason") or "prepareVideoDiagnostic"), video_time_ms=ms)
    elif action == "setVideoDeviceDryRun":
        enabled = bool(data.get("enabled"))
        mgr = getattr(session, "_source_manager", None)
        if mgr is not None:
            mgr.video_device_dry_run_enabled = enabled
        session._video_device_dry_run_enabled = enabled
        print(
            f"[mediapipe] Video device dry-run enabled={enabled}",
            flush=True,
        )
    elif action == "setVideoRealSendSmokeTest":
        enabled = bool(data.get("enabled"))
        profile = data.get("profile")
        mgr = getattr(session, "_source_manager", None)
        if mgr is not None:
            mgr.video_real_send_smoke_test_enabled = enabled
            mgr.video_smoke_test_profile = str(profile) if profile else None
        session._video_real_send_smoke_test_enabled = enabled
        session._video_smoke_test_profile = str(profile) if profile else None
        print(
            f"[mediapipe] Video real-send smoke test enabled={enabled} profile={profile!r}",
            flush=True,
        )


def _connection_path(websocket) -> str:
    req = getattr(websocket, "request", None)
    if req is not None:
        return getattr(req, "path", "/") or "/"
    return getattr(websocket, "path", "/") or "/"


def _parse_fourcc_arg(s: str) -> int | None:
    t = (s or "").strip().upper()
    if len(t) < 4:
        return None
    return cv2.VideoWriter_fourcc(t[0], t[1], t[2], t[3])


def _fourcc_prop_to_str(v: float) -> str:
    try:
        i = int(round(float(v)))
        return "".join(chr((i >> (8 * k)) & 0xFF) for k in range(4)).strip("\x00") or "?"
    except Exception:
        return "?"


def _open_video_capture(camera_index: int, backend: str) -> tuple[Any, str]:
    """Open camera; on Windows try DSHOW then MSMF when the preferred backend fails."""
    b = (backend or "auto").strip().lower()

    def _try_open(api: int | None, label: str) -> tuple[Any, str] | None:
        cap = cv2.VideoCapture(camera_index, api) if api is not None else cv2.VideoCapture(camera_index)
        if cap is not None and cap.isOpened():
            return cap, label
        try:
            cap.release()
        except Exception:
            pass
        return None

    if b == "dshow" and hasattr(cv2, "CAP_DSHOW"):
        opened = _try_open(int(cv2.CAP_DSHOW), "DSHOW")
        if opened:
            return opened
    elif b == "msmf" and hasattr(cv2, "CAP_MSMF"):
        opened = _try_open(int(cv2.CAP_MSMF), "MSMF")
        if opened:
            return opened
    elif b == "auto" and sys.platform == "win32":
        for api, label in (
            (getattr(cv2, "CAP_DSHOW", None), "DSHOW"),
            (getattr(cv2, "CAP_MSMF", None), "MSMF"),
        ):
            if api is None:
                continue
            opened = _try_open(int(api), label)
            if opened:
                return opened

    opened = _try_open(None, "ANY")
    if opened:
        return opened
    cap = cv2.VideoCapture(camera_index)
    return cap, "ANY"


def _print_camera_props(
    cap: Any,
    *,
    req_w: int,
    req_h: int,
    req_fps: float,
    fourcc_req: str,
    backend_name: str,
    buffer_req: int,
) -> None:
    try:
        aw = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        ah = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        afps = float(cap.get(cv2.CAP_PROP_FPS))
        buf = int(cap.get(cv2.CAP_PROP_BUFFERSIZE))
        fcv = float(cap.get(cv2.CAP_PROP_FOURCC))
        fstr = _fourcc_prop_to_str(fcv)
    except Exception:
        aw = ah = 0
        afps = 0.0
        buf = 0
        fstr = "?"
    fq = (fourcc_req or "").strip().upper() or "—"
    print(
        f"[CAMERA] requested={req_w}x{req_h}@{req_fps:g} fourcc={fq} backend={backend_name} buffer={buffer_req}",
        flush=True,
    )
    print(
        f"[CAMERA] actual={aw}x{ah} fps={afps:g} fourcc={fstr} backend={backend_name} buffer={buf}",
        flush=True,
    )


def _resolve_mp_image_api():
    Image = getattr(mp, "Image", None)
    ImageFormat = getattr(mp, "ImageFormat", None)
    if Image is not None and ImageFormat is not None:
        return Image, ImageFormat
    raise RuntimeError(
        "当前 mediapipe 版本缺少 mp.Image / mp.ImageFormat。\n"
        "请升级 mediapipe>=0.10（见 requirements.txt）。"
    )


def _resolve_face_landmarker_api():
    try:
        BaseOptions = mp.tasks.BaseOptions
        FaceLandmarker = mp.tasks.vision.FaceLandmarker
        FaceLandmarkerOptions = mp.tasks.vision.FaceLandmarkerOptions
        RunningMode = mp.tasks.vision.RunningMode
    except AttributeError as exc:  # pragma: no cover
        raise RuntimeError(
            "mediapipe.tasks API 不可用；请安装 mediapipe>=0.10。\n" f"详情: {exc}"
        ) from exc
    return BaseOptions, FaceLandmarker, FaceLandmarkerOptions, RunningMode


def _make_frame_dict(
    *,
    timestamp_ms: float,
    face_detected: bool,
    quality: float,
    rig: dict,
    debug: dict | None = None,
    input_source: dict | None = None,
    diagnostic: dict | None = None,
) -> dict:
    d: dict = {
        "type": TRACKING_FRAME_TYPE,
        "source": SOURCE,
        "timestampMs": timestamp_ms,
        "faceDetected": bool(face_detected),
        "quality": float(quality),
        "rig": rig,
    }
    dbg_out: dict | None = None
    if debug is not None and isinstance(debug, dict):
        dbg_out = dict(debug)
    elif input_source is not None:
        dbg_out = {}
    if dbg_out is not None and input_source is not None:
        dbg_out["inputSource"] = input_source
    if face_detected and dbg_out is not None:
        d["debug"] = dbg_out
    elif input_source is not None:
        d["debug"] = dbg_out
    elif dbg_out is not None:
        d["debug"] = dbg_out
    if isinstance(diagnostic, dict) and diagnostic:
        d["diagnostic"] = dict(diagnostic)
    return d


def _compact_frame_dict(d: dict) -> dict:
    """仅保留实时驱动与轻量 performance；不含 blendshapes / mapping / gaze。"""
    out: dict = {
        "type": d["type"],
        "source": d["source"],
        "timestampMs": d["timestampMs"],
        "faceDetected": bool(d["faceDetected"]),
        "quality": float(d["quality"]),
        "rig": d["rig"],
    }
    if "frameSeq" in d:
        out["frameSeq"] = int(d["frameSeq"])
    if "serverSentAtMs" in d:
        out["serverSentAtMs"] = float(d["serverSentAtMs"])
    dbg = d.get("debug")
    if isinstance(dbg, dict):
        slim_dbg: dict[str, Any] = {}
        if isinstance(dbg.get("inputSource"), dict):
            slim_dbg["inputSource"] = dbg["inputSource"]
        if isinstance(dbg.get("videoPlayback"), dict):
            slim_dbg["videoPlayback"] = dbg["videoPlayback"]
        if isinstance(dbg.get("trackingDebug"), dict):
            td = dict(dbg["trackingDebug"])
            is_video = (
                isinstance(dbg.get("inputSource"), dict)
                and dbg["inputSource"].get("sourceType") == "video"
            )
            # video debug overlay 需要 dense mesh；camera compact 仍省略
            if not is_video:
                td.pop("allLandmarks", None)
            slim_dbg["trackingDebug"] = td
        if isinstance(dbg.get("performance"), dict):
            p = dbg["performance"]
            slim_perf: dict[str, Any] = {}
            for k in (
                "fps",
                "broadcastFps",
                "broadcastFrameSeq",
                "captureFps",
                "inferenceFps",
                "mappingFps",
                "generatedFrameFps",
                "jsonEncodeFps",
                "broadcastAttemptFps",
                "broadcastSuccessFps",
                "perClientSendFps",
                "clientCount",
                "loopMs",
                "captureMs",
                "capReadMs",
                "preprocessMs",
                "inferenceMs",
                "mappingMs",
                "encodeMs",
                "jsonEncodeMs",
                "broadcastMs",
                "sleepMs",
                "totalPeriodMs",
                "targetIntervalMs",
            ):
                if k in p and p[k] is not None:
                    slim_perf[k] = p[k]
            if "frameSeq" in p and p["frameSeq"] is not None:
                slim_perf["frameSeq"] = p["frameSeq"]
            if "broadcastSeq" in p and p["broadcastSeq"] is not None:
                slim_perf["broadcastSeq"] = p["broadcastSeq"]
            if slim_perf:
                slim_dbg["performance"] = slim_perf
        if isinstance(dbg.get("gaze"), dict):
            gz = dbg["gaze"]
            slim_gaze: dict[str, Any] = {}
            for k in gaze_trace_keys():
                if k in gz and gz[k] is not None:
                    slim_gaze[k] = gz[k]
            if slim_gaze:
                slim_dbg["gaze"] = slim_gaze
        if slim_dbg:
            out["debug"] = slim_dbg
    diag = d.get("diagnostic")
    if isinstance(diag, dict) and diag:
        out["diagnostic"] = diag
    return out


def _ema_merge_rig(prev: dict | None, new: dict, alpha: float) -> dict:
    """对 rig 树形数值做指数平滑。"""
    if not prev:
        return copy.deepcopy(new)
    a = max(0.0, min(1.0, float(alpha)))
    out: dict = {}
    for k, v in new.items():
        if isinstance(v, dict):
            out[k] = _ema_merge_rig(prev.get(k) if isinstance(prev.get(k), dict) else None, v, alpha)
        elif isinstance(v, (int, float)):
            pv = prev.get(k)
            pv = float(pv) if isinstance(pv, (int, float)) else float(v)
            out[k] = pv + a * (float(v) - pv)
        else:
            out[k] = v
    return out


def _average_blendshape_samples(samples: list[dict[str, float]]) -> dict[str, float]:
    if not samples:
        return {}
    keys = list(samples[0].keys())
    out: dict[str, float] = {}
    n = len(samples)
    for k in keys:
        out[k] = sum(float(s.get(k, 0.0)) for s in samples) / n
    return out


class MediapipeTrackingSession:
    """摄像头 + FaceLandmarker（VIDEO 模式），生成 JSON 字符串载荷。"""

    def __init__(
        self,
        *,
        model_path: Path,
        camera_index: int,
        interval_sec: float,
        mapping_config_path: Path,
        save_mapping_path: Path,
        calibrate_neutral: bool,
        frame_width: int = 640,
        frame_height: int = 480,
        payload_mode: str = "full",
        camera_fps: float = 30.0,
        fourcc: str = "MJPG",
        buffer_size: int = 1,
        camera_backend: str = "auto",
        preview_overlay: PreviewOverlayConfig | None = None,
        source: str = "idle",
        video_path: str | Path | None = None,
        playback_rate: float = 1.0,
        video_mode: str = "realtime",
        tracking_mode: str = "full-frame",
        roi_multiplier: float = 1.8,
        video_start_ms: float = 0.0,
    ) -> None:
        self._process_interval_sec = max(0.0, float(interval_sec))
        if interval_sec > 1e-12:
            self._interval_ms = max(1, int(round(interval_sec * 1000)))
        else:
            self._interval_ms = 0
        self._last_video_wall: float | None = None
        self._timing_for_next_build: dict[str, float] | None = None
        self._mapping_config_path = mapping_config_path
        self._save_mapping_path = save_mapping_path
        self._calibrate_neutral = bool(calibrate_neutral)
        self._payload_mode = str(payload_mode or "full").lower().strip()
        if self._payload_mode not in ("full", "compact"):
            self._payload_mode = "full"
        self._calib_samples: list[dict[str, float]] = []
        self._calib_gaze_samples: list[tuple[float, float]] = []
        self._calib_done = not bool(calibrate_neutral)
        self._last_smoothed_rig: dict | None = None
        self._gaze_state: dict[str, Any] = {
            "last_valid": None,
            "last_emit": {"x": 50.0, "y": 50.0},
            "range_window": {"right": [], "left": [], "up": [], "down": []},
            "drift_x": 0.0,
            "drift_y": 0.0,
            "emit_x_hist": [],
            "raw_gx0_hist": [],
            "logical_raw_x_hist": [],
            "last_good_y_norm": None,
            "held_y_norm": None,
            "last_good_logical_y": None,
        }
        self._eye_xy_center = EyeXyAutoCenterCollector()
        self._eye_xy_center_session_key: str | None = None
        self._gaze_neutral_init = GazeNeutralInitSession()
        self._gaze_neutral_init_session_key: str | None = None
        self._neutral_init_motion_prev: dict[str, tuple[float, float]] | None = None
        self._neutral_init_ready_logged = False
        self._iris_init_session_key: str | None = None
        self._iris_gaze_armed: bool = False
        self._video_device_dry_run_enabled: bool = False
        self._iris_source_epoch: int | None = None
        self._iris_init_ready_logged = False
        self._lip_state: dict[str, Any] = create_lip_geometry_state()
        self._jaw_state: dict[str, Any] = create_jaw_geometry_state()
        self._nose_state: dict[str, Any] = create_nose_anchor_state()
        self._mouth_scenario_state: dict[str, Any] = create_mouth_scenario_state()
        self._mouth_corner_state: dict[str, Any] = create_mouth_corner_state()
        self._brow_state: dict[str, Any] = create_brow_state()
        self._perf_base: dict[str, float] = {}
        self._prev_broadcast_ms: float | None = None
        self._prev_json_encode_ms: float | None = None
        self._prev_loop_ms: float | None = None
        self._prev_fps: float | None = None
        self._perf_log_anchor = time.perf_counter()
        self._perf_log_acc = {
            "capture": 0.0,
            "infer": 0.0,
            "map": 0.0,
            "bc": 0.0,
            "enc": 0.0,
            "loop": 0.0,
            "payload": 0.0,
            "clients_max": 0,
            "cap_read": 0.0,
            "pre": 0.0,
            "sleep": 0.0,
            "period": 0.0,
            "n": 0.0,
        }
        self._frame_seq = 0
        self._broadcast_seq = 0
        self._extras_for_next_frame: dict[str, Any] | None = None
        self._last_broadcast_fps_for_perf = 0.0
        self._win = _FPS_WINDOW_SEC
        self._m_capture = _SlidingFps(self._win)
        self._m_inference = _SlidingFps(self._win)
        self._m_mapping = _SlidingFps(self._win)
        self._m_generated = _SlidingFps(self._win)
        self._m_json = _SlidingFps(self._win)
        self._m_bc_attempt = _SlidingFps(self._win)
        self._m_bc_success = _SlidingFps(self._win)
        self._preview_lock = threading.Lock()
        self._latest_preview_frame: np.ndarray | None = None
        self._preview_overlay = preview_overlay or PreviewOverlayConfig()
        self._camera_index = int(camera_index)
        self._camera_input: CameraTrackingInputAdapter | None = None
        self._video_input: VideoTrackingInputAdapter | None = None
        self._video_ended = False
        self._video_ended_frame: dict | None = None
        self._last_video_tracking_frame: dict | None = None
        self._last_input_source: dict[str, Any] | None = None
        self._playback_rate = max(0.01, float(playback_rate))
        vm = str(video_mode or "realtime").strip().lower()
        self._video_mode = "deterministic" if vm == "deterministic" else "realtime"
        self._tracking_mode = normalize_tracking_mode(tracking_mode)
        self._roi_multiplier = normalize_roi_multiplier(roi_multiplier)
        self._last_full_face_box: dict[str, float] | None = None
        self._last_roi_rect: RoiRect | None = None
        self._roi_miss_count = 0
        self._last_inference_path = "full"
        self._video_start_ms = max(0.0, float(video_start_ms))
        self._stable_roi = StableRoiTracker()
        self._last_stable_roi_debug: dict[str, Any] | None = None

        self._config = load_mapping_config(mapping_config_path)
        self._model_path = Path(model_path)
        self._session_lock = threading.RLock()
        self._landmarker = self._create_landmarker()
        self._Image, self._ImageFormat = _resolve_mp_image_api()
        self._video_ts_ms = 0
        self._cli_source = str(source or "idle").strip().lower()
        self._cli_video_path = video_path
        self._cli_playback_rate = float(playback_rate)
        self._cli_video_mode = str(video_mode or "realtime")
        self._source_changed_handler: Any = None
        self._source_manager = TrackingSourceManager(
            open_camera_fn=_open_video_capture,
            camera_config={
                "camera_index": int(camera_index),
                "frame_width": int(frame_width),
                "frame_height": int(frame_height),
                "camera_fps": float(camera_fps),
                "buffer_size": int(buffer_size),
                "camera_backend": str(camera_backend),
                "fourcc": str(fourcc),
                "flip_horizontal": True,
            },
        )
        self._source_manager.register_before_switch(self.reset_for_source_change)
        self._bootstrap_cli_source(
            cli_source=self._cli_source,
            video_path=video_path,
            video_start_ms=float(video_start_ms),
            playback_rate=float(playback_rate),
            video_mode=str(video_mode or "realtime"),
            camera_index=int(camera_index),
            frame_width=int(frame_width),
            frame_height=int(frame_height),
            camera_fps=float(camera_fps),
            fourcc=str(fourcc),
            buffer_size=int(buffer_size),
        )

        if self._calibrate_neutral and self._source == "video":
            print(
                "[mediapipe] 警告：视频模式忽略 --calibrate-neutral（请使用 camera 模式校准）。",
                flush=True,
            )
            self._calib_done = True

        if self._calibrate_neutral and self._source == "camera":
            print(
                "[mediapipe] 已启用 --calibrate-neutral：请在摄像头前保持中性表情，"
                f"将连续采集 {_CALIB_FRAMES} 帧 blendshape，并在 gaze（iris）可用时写入 neutral.eyeLookX/Y，"
                "然后写入 neutral 并保存到 --save-mapping。",
                flush=True,
            )

    def _sync_source_refs(self) -> None:
        mgr = self._source_manager
        if mgr.is_idle:
            self._source = "idle"
        else:
            self._source = str(mgr.current_source_type)
        self._cap = mgr.cap
        self._camera_input = mgr.camera_input
        self._video_input = mgr.video_input
        self._video_ended = mgr.video_ended

    def _bootstrap_cli_source(
        self,
        *,
        cli_source: str,
        video_path: str | Path | None,
        video_start_ms: float,
        playback_rate: float,
        video_mode: str,
        camera_index: int,
        frame_width: int,
        frame_height: int,
        camera_fps: float,
        fourcc: str,
        buffer_size: int,
    ) -> None:
        src = str(cli_source or "idle").strip().lower()
        if src in ("idle", "auto"):
            self._source = "idle"
            self._sync_source_refs()
            print("[SOURCE] idle — 等待前端 POST /api/tracking/source 切换", flush=True)
            return
        if src == "video":
            if not video_path:
                print(
                    "错误：--source video 需要 --video-path（或 --video）指定视频文件。",
                    file=sys.stderr,
                )
                sys.exit(5)
            sw = self._source_manager.switch_source(
                {
                    "sourceType": "video",
                    "videoPath": str(video_path),
                    "videoStartMs": float(video_start_ms),
                    "playbackRate": float(playback_rate),
                    "deterministic": str(video_mode).strip().lower() == "deterministic",
                }
            )
            if not sw.get("ok"):
                print(f"错误：无法启动 video 源: {sw.get('error')}", file=sys.stderr)
                sys.exit(5)
            self._sync_source_refs()
            vi = self._video_input
            vi_fps = vi.fps if vi is not None else 0.0
            print(
                f"[VIDEO] source={self._source_manager.source_id} "
                f"fps={vi_fps:g} epoch={self._source_manager.source_epoch}",
                flush=True,
            )
            return
        self._source = "camera"
        sw = self._source_manager.switch_source(
            {"sourceType": "camera", "cameraIndex": int(camera_index)}
        )
        if not sw.get("ok"):
            print(f"错误：无法打开摄像头: {sw.get('error')}", file=sys.stderr)
            sys.exit(4)
        self._sync_source_refs()
        _print_camera_props(
            self._cap,
            req_w=max(160, int(frame_width)),
            req_h=max(120, int(frame_height)),
            req_fps=max(1.0, float(camera_fps)),
            fourcc_req=str(fourcc),
            backend_name="DSHOW/MSMF",
            buffer_req=max(1, int(buffer_size)),
        )

    def _create_landmarker(self) -> Any:
        BaseOptions, FaceLandmarker, FaceLandmarkerOptions, RunningMode = (
            _resolve_face_landmarker_api()
        )
        opts_kw = dict(
            base_options=BaseOptions(model_asset_path=str(self._model_path.resolve())),
            running_mode=RunningMode.VIDEO,
            num_faces=1,
            output_face_blendshapes=True,
            output_facial_transformation_matrixes=True,
        )
        try:
            opts = FaceLandmarkerOptions(**opts_kw, output_face_landmarks=True)
        except TypeError:
            opts = FaceLandmarkerOptions(**opts_kw)
        return FaceLandmarker.create_from_options(opts)

    def _recreate_landmarker(self) -> None:
        """VIDEO 模式要求 timestamp 单调递增；切换 source / seek 后须重建 landmarker。"""
        closer = getattr(self._landmarker, "close", None)
        if callable(closer):
            try:
                closer()
            except Exception:
                pass
        self._landmarker = self._create_landmarker()
        self._video_ts_ms = 0
        self._last_video_wall = None

    def reset_for_source_change(self) -> None:
        """切换 source 时重置 temporal / smoothing / neutral runtime 状态。"""
        self._recreate_landmarker()
        self._reset_gaze_state()
        self._eye_xy_center.reset()
        self._eye_xy_center_session_key = None
        self._gaze_neutral_init.reset()
        self._gaze_neutral_init_session_key = None
        self._neutral_init_motion_prev = None
        self._neutral_init_ready_logged = False
        self._iris_init_session_key = None
        self._iris_source_epoch = None
        self._iris_init_ready_logged = False
        self._iris_gaze_armed = False
        reset_iris_gaze_runtime(self._gaze_state)
        self._gaze_state["iris_gaze_armed"] = False
        self._reset_mouth_geometry_state()
        self._last_smoothed_rig = None
        self._last_full_face_box = None
        self._last_roi_rect = None
        self._roi_miss_count = 0
        self._stable_roi.reset()
        self._last_stable_roi_debug = None
        self._video_ended = False
        self._video_ended_frame = None
        self._last_video_tracking_frame = None
        self._last_input_source = None
        with self._preview_lock:
            self._latest_preview_frame = None

    def set_source_changed_handler(self, handler: Any) -> None:
        self._source_changed_handler = handler

    def get_tracking_source_state(self) -> dict[str, Any]:
        return self._source_manager.get_current_source()

    def switch_tracking_source(self, request: dict[str, Any]) -> dict[str, Any]:
        with self._session_lock:
            result = self._source_manager.switch_source(request)
            self._sync_source_refs()
        handler = self._source_changed_handler
        if callable(handler) and result.get("ok"):
            try:
                handler(result)
            except Exception:
                pass
        return result

    def publish_preview_frame(self, frame: np.ndarray) -> None:
        """供 MJPEG 预览读取的最新 BGR 帧（与 tracking 同一次 cap.read，不额外开摄像头）。"""
        with self._preview_lock:
            self._latest_preview_frame = frame.copy()

    def _finalize_preview_frame(
        self,
        frame: np.ndarray,
        *,
        result: Any | None = None,
        face_detected: bool = False,
    ) -> None:
        """推理后发布 MJPEG 帧；overlay 在 BGR 副本上绘制，不进入 WebSocket。"""
        out = frame
        if self._preview_overlay.enabled and face_detected and result is not None:
            lm = extract_landmarks(result)
            if lm is not None:
                out = frame.copy()
                draw_preview_landmark_overlay(
                    out, lm, self._preview_overlay, self._config
                )
        self.publish_preview_frame(out)

    def _tracking_debug_preview_overlay(self) -> dict[str, Any]:
        ov = self._preview_overlay
        return {
            "serverDebugOverlayEnabled": bool(ov.enabled),
            "serverOverlayStyle": str(ov.style or ""),
        }

    def encode_preview_jpeg(self, quality: int = 60) -> bytes | None:
        with self._preview_lock:
            frame = self._latest_preview_frame
            if frame is None:
                return None
            img = frame.copy()
        q = max(1, min(100, int(quality)))
        ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), q])
        if not ok:
            return None
        return buf.tobytes()

    def close(self) -> None:
        self._reset_mouth_geometry_state()
        if self._source_manager is not None:
            self._source_manager.close()
        self._sync_source_refs()
        with self._preview_lock:
            self._latest_preview_frame = None
        closer = getattr(self._landmarker, "close", None)
        if callable(closer):
            try:
                closer()
            except Exception:
                pass

    def _maybe_calibrate(self, result: Any) -> None:
        if self._calib_done or not self._calibrate_neutral:
            return
        blend = extract_debug_blendshapes(result)
        self._calib_samples.append(blend)
        try:
            ginfo = estimate_eye_gaze_from_landmarks(result, self._config)
            if ginfo.get("available"):
                self._calib_gaze_samples.append(
                    (float(ginfo["eyeLookX"]), float(ginfo["eyeLookY"]))
                )
        except Exception:
            pass
        n = len(self._calib_samples)
        if n % 10 == 0 or n == _CALIB_FRAMES:
            print(f"[mediapipe] 中性脸校准采集中… 已采集 {n}/{_CALIB_FRAMES} 帧", flush=True)
        if n < _CALIB_FRAMES:
            return
        avg = _average_blendshape_samples(self._calib_samples)
        neutral = self._config.setdefault("neutral", {})
        for k, v in avg.items():
            neutral[k] = float(v)
        if self._calib_gaze_samples:
            n_g = len(self._calib_gaze_samples)
            ax = sum(t[0] for t in self._calib_gaze_samples) / n_g
            ay = sum(t[1] for t in self._calib_gaze_samples) / n_g
            neutral["eyeLookX"] = float(ax)
            neutral["eyeLookY"] = float(ay)
        save_mapping_config(self._save_mapping_path, self._config)
        self._calib_done = True
        self._calib_samples.clear()
        self._calib_gaze_samples.clear()
        print(
            "[mediapipe] 中性脸校准完成，已写入 neutral 并保存到:",
            str(self._save_mapping_path.resolve()),
            flush=True,
        )

    def _camera_flip_horizontal(self) -> bool:
        mgr = self._source_manager
        if mgr is not None:
            return bool(getattr(mgr, "_camera_flip_horizontal", True))
        return True

    def _ensure_eye_xy_auto_center(self, input_src: dict[str, Any] | None) -> None:
        if not isinstance(input_src, dict) or input_src.get("sourceType") != "camera":
            return
        gaze_cfg = self._config.get("gaze") if isinstance(self._config.get("gaze"), dict) else {}
        if not bool(gaze_cfg.get("autoEyeCenterEnabled", True)):
            return
        camera_id = str(
            input_src.get("cameraId")
            or f"camera:index:{input_src.get('cameraIndex', self._camera_index)}"
        )
        width = int(input_src.get("cameraWidth") or 640)
        height = int(input_src.get("cameraHeight") or 480)
        flip = self._camera_flip_horizontal()
        session_key = f"{camera_id}|{width}x{height}|flip:{1 if flip else 0}"
        if session_key == self._eye_xy_center_session_key:
            return
        self._eye_xy_center_session_key = session_key
        self._eye_xy_center.begin_camera(
            camera_id=camera_id,
            width=width,
            height=height,
            flip_horizontal=flip,
            gaze_cfg=gaze_cfg,
        )
        if self._eye_xy_center.apply_to_config(self._config):
            print(
                "[mediapipe] Eye XY auto-neutral loaded:",
                session_key,
                f"X={self._config.get('neutral', {}).get('eyeLookX')}",
                f"Y={self._config.get('neutral', {}).get('eyeLookY')}",
                flush=True,
            )

    def _update_eye_xy_auto_center(
        self,
        *,
        input_src: dict[str, Any] | None,
        result: Any,
        blend: dict[str, float],
        gaze_dbg: dict[str, Any],
    ) -> dict[str, Any]:
        self._ensure_eye_xy_auto_center(input_src)
        if not isinstance(input_src, dict) or input_src.get("sourceType") != "camera":
            return {"mode": "off", "ready": False, "collecting": False}
        if self._eye_xy_center.is_session_locked():
            return self._eye_xy_center.status_dict()

        nose_xy = None
        face_center = None
        try:
            lm = extract_landmarks(result)
            if lm:
                nose_xy = get_landmark_xy(lm, 1)
                pts = []
                for idx in (33, 263, 61, 291):
                    p = get_landmark_xy(lm, idx)
                    if p:
                        pts.append(p)
                if pts:
                    face_center = (
                        sum(p[0] for p in pts) / len(pts),
                        sum(p[1] for p in pts) / len(pts),
                    )
        except Exception:
            pass

        prev_ready = bool(self._eye_xy_center.status_dict().get("ready"))
        status = self._eye_xy_center.maybe_collect(
            face_detected=True,
            gaze=gaze_dbg,
            blink_left=float(blend.get("eyeBlinkLeft", 0.0)),
            blink_right=float(blend.get("eyeBlinkRight", 0.0)),
            nose_xy=nose_xy,
            face_center=face_center,
        )
        if (not prev_ready) and status.get("ready"):
            self._eye_xy_center.apply_to_config(self._config)
            print(
                "[mediapipe] Eye XY auto-neutral calibrated:",
                status.get("storageKey"),
                f"samples={status.get('sampleCount')}",
                f"X={status.get('autoNeutralX')}",
                f"Y={status.get('autoNeutralY')}",
                flush=True,
            )
        return status

    def _ensure_gaze_neutral_init(self, input_src: dict[str, Any] | None) -> None:
        if not isinstance(input_src, dict) or input_src.get("sourceType") != "camera":
            return
        gaze_cfg = self._config.get("gaze") if isinstance(self._config.get("gaze"), dict) else {}
        if not bool(gaze_cfg.get("neutralInitEnabled", True)):
            return
        if str(gaze_cfg.get("gazeEstimatorMode", "")) != "neutral_init_geometry_v1":
            return
        camera_id = str(
            input_src.get("cameraId")
            or f"camera:index:{input_src.get('cameraIndex', self._camera_index)}"
        )
        width = int(input_src.get("cameraWidth") or 640)
        height = int(input_src.get("cameraHeight") or 480)
        flip = self._camera_flip_horizontal()
        session_key = f"{camera_id}|{width}x{height}|flip:{1 if flip else 0}|neutral_init"
        if session_key == self._gaze_neutral_init_session_key:
            return
        self._gaze_neutral_init_session_key = session_key
        self._neutral_init_motion_prev = None
        self._neutral_init_ready_logged = False
        self._gaze_neutral_init.begin_session(session_key=session_key, gaze_cfg=gaze_cfg)
        print("[mediapipe] Gaze neutral init started:", session_key, flush=True)

    def _compute_neutral_init_motion(
        self,
        *,
        result: Any,
        frame_width: int,
        frame_height: int,
    ) -> dict[str, float] | None:
        fw = max(1, int(frame_width))
        fh = max(1, int(frame_height))
        try:
            lm = extract_landmarks(result)
            if not lm:
                return None
            nose = get_landmark_xy(lm, 1)
            if not nose:
                return None
            nose_px = (float(nose[0]) * fw, float(nose[1]) * fh)
            le = get_landmark_xy(lm, 33)
            re = get_landmark_xy(lm, 263)
            eye_center_px = None
            if le and re:
                eye_center_px = (
                    (float(le[0]) + float(re[0])) * 0.5 * fw,
                    (float(le[1]) + float(re[1])) * 0.5 * fh,
                )
            face_pts = []
            for idx in (33, 263, 61, 291):
                p = get_landmark_xy(lm, idx)
                if p:
                    face_pts.append(p)
            face_center_px = None
            if face_pts:
                face_center_px = (
                    sum(float(p[0]) for p in face_pts) / len(face_pts) * fw,
                    sum(float(p[1]) for p in face_pts) / len(face_pts) * fh,
                )
            prev = self._neutral_init_motion_prev
            motion: dict[str, float] = {}
            if isinstance(prev, dict) and prev.get("nose"):
                dx = nose_px[0] - prev["nose"][0]
                dy = nose_px[1] - prev["nose"][1]
                motion["noseDeltaPx"] = float((dx * dx + dy * dy) ** 0.5)
            if isinstance(prev, dict) and prev.get("eye") and eye_center_px:
                dx = eye_center_px[0] - prev["eye"][0]
                dy = eye_center_px[1] - prev["eye"][1]
                motion["eyeCenterDeltaPx"] = float((dx * dx + dy * dy) ** 0.5)
            if isinstance(prev, dict) and prev.get("face") and face_center_px:
                dx = face_center_px[0] - prev["face"][0]
                dy = face_center_px[1] - prev["face"][1]
                motion["faceBoxCenterDeltaPx"] = float((dx * dx + dy * dy) ** 0.5)
            self._neutral_init_motion_prev = {
                "nose": nose_px,
                "eye": eye_center_px,
                "face": face_center_px,
            }
            return motion or None
        except Exception:
            return None

    def _update_gaze_neutral_init(
        self,
        *,
        input_src: dict[str, Any] | None,
        result: Any,
        blend: dict[str, float],
        gaze_dbg: dict[str, Any],
        frame_width: int,
        frame_height: int,
        face_detected: bool = True,
    ) -> dict[str, Any]:
        self._ensure_gaze_neutral_init(input_src)
        gaze_cfg = self._config.get("gaze") if isinstance(self._config.get("gaze"), dict) else {}
        if not bool(gaze_cfg.get("neutralInitEnabled", True)):
            return self._gaze_neutral_init.status_dict()
        if str(gaze_cfg.get("gazeEstimatorMode", "")) != "neutral_init_geometry_v1":
            return self._gaze_neutral_init.status_dict()

        raw_l = float(blend.get("eyeBlinkLeft", 0.0))
        raw_r = float(blend.get("eyeBlinkRight", 0.0))
        blink_w, _ = _gaze_blink_update_weight(raw_l, raw_r, gaze_cfg)

        motion = self._compute_neutral_init_motion(
            result=result,
            frame_width=frame_width,
            frame_height=frame_height,
        )

        face_center = None
        try:
            lm = extract_landmarks(result)
            if lm:
                pts = []
                for idx in (33, 263, 61, 291):
                    p = get_landmark_xy(lm, idx)
                    if p:
                        pts.append(p)
                if pts:
                    face_center = (
                        sum(p[0] for p in pts) / len(pts),
                        sum(p[1] for p in pts) / len(pts),
                    )
        except Exception:
            pass

        mouth = {
            "jawOpen": float(blend.get("jawOpen", 0.0)),
            "rawMouthScore": None,
        }

        prev_ready = bool(self._neutral_init_ready_logged)
        status = self._gaze_neutral_init.maybe_collect(
            gaze_cfg=gaze_cfg,
            face_detected=bool(face_detected),
            gaze=gaze_dbg,
            blend=blend,
            blink_gaze_weight=float(blink_w),
            motion=motion,
            mouth=mouth,
            face_center=face_center,
        )
        if isinstance(motion, dict):
            self._gaze_state["init_frame_motion"] = dict(motion)
        self._gaze_neutral_init.sync_to_gaze_state(self._gaze_state)
        if status.get("neutralInitReady") and not prev_ready:
            self._neutral_init_ready_logged = True
            print(
                "[mediapipe] Gaze neutral init ready:",
                f"samples={status.get('neutralInitSampleCount')}",
                f"X={status.get('sessionNeutralX'):.4f}",
                f"Y={status.get('sessionNeutralStableY'):.4f}",
                flush=True,
            )
        return status

    def _ensure_iris_init_session(self, input_src: dict[str, Any] | None) -> None:
        if not getattr(self, "_iris_gaze_armed", False):
            return
        if not isinstance(input_src, dict) or input_src.get("sourceType") != "camera":
            return
        gaze_cfg = self._config.get("gaze") if isinstance(self._config.get("gaze"), dict) else {}
        if str(gaze_cfg.get("gazeEstimatorMode", "")) != IRIS_ONLY_MODE:
            return
        camera_id = str(
            input_src.get("cameraId")
            or f"camera:index:{input_src.get('cameraIndex', self._camera_index)}"
        )
        width = int(input_src.get("cameraWidth") or 640)
        height = int(input_src.get("cameraHeight") or 480)
        flip = self._camera_flip_horizontal()
        source_epoch = int(input_src.get("sourceEpoch") or 0)
        session_key = (
            f"{camera_id}|{width}x{height}|flip:{1 if flip else 0}"
            f"|epoch:{source_epoch}|iris_only"
        )
        epoch_changed = (
            self._iris_source_epoch is not None and source_epoch != self._iris_source_epoch
        )
        if session_key == self._iris_init_session_key and not epoch_changed:
            return
        self._iris_init_session_key = session_key
        self._iris_source_epoch = source_epoch
        self._iris_init_ready_logged = False
        armed = bool(getattr(self, "_iris_gaze_armed", False))
        reset_iris_gaze_runtime(self._gaze_state)
        self._gaze_state["iris_gaze_armed"] = armed
        self._gaze_state["iris_init_session_key"] = session_key
        print("[mediapipe] Iris-only init session started:", session_key, flush=True)

    def _log_iris_init_ready_if_needed(self) -> None:
        init = (
            self._gaze_state.get("iris_init")
            if isinstance(self._gaze_state.get("iris_init"), dict)
            else {}
        )
        if not init.get("irisInitReady") or self._iris_init_ready_logged:
            return
        self._iris_init_ready_logged = True
        print(
            "[mediapipe] Iris-only neutral ready:",
            f"cx={init.get('neutralIrisCx')}",
            f"cy={init.get('neutralIrisCy')}",
            f"samples={init.get('irisInitSampleCount')}",
            flush=True,
        )

    def _reset_gaze_state(self) -> None:
        self._gaze_state = {
            "last_valid": None,
            "last_emit": {"x": 50.0, "y": 50.0},
            "range_window": {"right": [], "left": [], "up": [], "down": []},
            "drift_x": 0.0,
            "drift_y": 0.0,
            "emit_x_hist": [],
            "raw_gx0_hist": [],
            "logical_raw_x_hist": [],
            "last_good_y_norm": None,
            "held_y_norm": None,
            "last_good_logical_y": None,
        }

    def _reset_mouth_geometry_state(self) -> None:
        reset_lip_geometry_state(self._lip_state)
        reset_jaw_geometry_state(self._jaw_state)
        reset_nose_anchor_state(self._nose_state)
        reset_mouth_scenario_state(self._mouth_scenario_state)
        reset_mouth_corner_state(self._mouth_corner_state)
        reset_brow_state(self._brow_state)

    def finalize_extras_after_wire(
        self,
        *,
        frame_seq: int,
        broadcast_seq: int,
        json_encode_ms: float,
        broadcast_send_ms: float,
        clients: int,
        successful_sends: int,
    ) -> None:
        """序列化 + 广播完成后更新滑窗计数，并写入下一帧 build 可读的 transport 统计。"""
        self._prev_json_encode_ms = float(json_encode_ms)
        self._prev_broadcast_ms = float(broadcast_send_ms)
        self._m_json.tick()
        self._m_bc_attempt.tick()
        for _ in range(max(0, int(successful_sends))):
            self._m_bc_success.tick()
        bs_ok = float(self._m_bc_success.fps())
        self._last_broadcast_fps_for_perf = bs_ok
        cc = max(0, int(clients))
        per_client = bs_ok / max(1, cc) if cc > 0 else 0.0
        self._extras_for_next_frame = {
            "jsonEncodeFps": round(float(self._m_json.fps()), 2),
            "broadcastAttemptFps": round(float(self._m_bc_attempt.fps()), 2),
            "broadcastSuccessFps": round(bs_ok, 2),
            "broadcastFps": round(bs_ok, 2),
            "broadcastFrameSeq": int(frame_seq),
            "perClientSendFps": round(per_client, 2),
            "clientCount": cc,
            "frameSeq": int(frame_seq),
            "broadcastSeq": int(broadcast_seq),
            "encodeMs": round(float(json_encode_ms), 2),
            "jsonEncodeMs": round(float(json_encode_ms), 2),
        }

    def record_post_send_perf(
        self,
        broadcast_send_ms: float,
        loop_ms: float,
        *,
        clients: int = 0,
        payload_bytes: int = 0,
        json_encode_ms: float = 0.0,
        sleep_ms: float = 0.0,
        total_period_ms: float = 0.0,
    ) -> None:
        """记录本帧序列化+广播耗时；每约 2s 打印摘要。fps 不再用 1000/loop_ms（不含 sleep，会虚高）。"""
        self._prev_loop_ms = float(loop_ms)
        self._prev_fps = float(self._m_generated.fps()) if self._m_generated.fps() > 0 else None
        acc = self._perf_log_acc
        acc["n"] += 1.0
        pb = self._perf_base
        acc["capture"] += float(pb.get("captureMs", 0.0))
        acc["cap_read"] += float(pb.get("capReadMs", pb.get("captureMs", 0.0)))
        acc["pre"] += float(pb.get("preprocessMs", 0.0))
        acc["infer"] += float(pb.get("inferenceMs", 0.0))
        acc["map"] += float(pb.get("mappingMs", 0.0))
        acc["bc"] += float(broadcast_send_ms)
        acc["enc"] += float(json_encode_ms)
        acc["loop"] += float(loop_ms)
        acc["payload"] += float(max(0, int(payload_bytes)))
        acc["clients_max"] = max(int(acc.get("clients_max", 0)), int(max(0, clients)))
        acc["sleep"] += float(sleep_ms)
        acc["period"] += float(total_period_ms)
        now = time.perf_counter()
        if now - self._perf_log_anchor < 2.0:
            return
        n = max(1.0, acc["n"])
        cap_fp = self._m_capture.fps()
        inf_fp = self._m_inference.fps()
        map_fp = self._m_mapping.fps()
        gen_fp = self._m_generated.fps()
        enc_fp = self._m_json.fps()
        att_fp = self._m_bc_attempt.fps()
        suc_fp = self._m_bc_success.fps()
        payload_kb = (acc["payload"] / n) / 1024.0
        print(
            f"[PERF] captureFps={cap_fp:.1f} inferFps={inf_fp:.1f} mapFps={map_fp:.1f} genFps={gen_fp:.1f} "
            f"encodeFps={enc_fp:.1f} broadcastAttemptFps={att_fp:.1f} broadcastSuccessFps={suc_fp:.1f} "
            f"clients={int(acc['clients_max'])} payload={payload_kb:.1f}KB "
            f"capRead={acc['cap_read'] / n:.0f}ms sleep={acc['sleep'] / n:.0f}ms period={acc['period'] / n:.0f}ms "
            f"infer={acc['infer'] / n:.0f}ms encode={acc['enc'] / n:.0f}ms send={acc['bc'] / n:.0f}ms loop={acc['loop'] / n:.0f}ms",
            flush=True,
        )
        self._perf_log_anchor = now
        self._perf_log_acc = {
            "capture": 0.0,
            "infer": 0.0,
            "map": 0.0,
            "bc": 0.0,
            "enc": 0.0,
            "loop": 0.0,
            "payload": 0.0,
            "clients_max": 0,
            "cap_read": 0.0,
            "pre": 0.0,
            "sleep": 0.0,
            "period": 0.0,
            "n": 0.0,
        }

    def _build_common_performance_fragment(self) -> dict[str, Any]:
        pb = self._perf_base or {}
        cap_read = float(pb.get("capReadMs", pb.get("captureMs", 0.0)))
        pre_ms = float(pb.get("preprocessMs", 0.0))
        inf_ms = float(pb.get("inferenceMs", 0.0))
        map_ms = float(pb.get("mappingMs", 0.0))
        gf = round(float(self._m_generated.fps()), 2)
        p_perf: dict[str, Any] = {
            "capReadMs": round(cap_read, 2),
            "preprocessMs": round(pre_ms, 2),
            "inferenceMs": round(inf_ms, 2),
            "mappingMs": round(map_ms, 2),
            "captureMs": round(cap_read + pre_ms, 2),
            "captureFps": round(float(self._m_capture.fps()), 2),
            "inferenceFps": round(float(self._m_inference.fps()), 2),
            "mappingFps": round(float(self._m_mapping.fps()), 2),
            "generatedFrameFps": gf,
            "fps": gf,
        }
        tm = self._timing_for_next_build
        if isinstance(tm, dict):
            for key in ("totalPeriodMs", "sleepMs", "targetIntervalMs"):
                if tm.get(key) is not None:
                    p_perf[key] = round(float(tm[key]), 2)
        ex = self._extras_for_next_frame
        if isinstance(ex, dict):
            for key in (
                "jsonEncodeFps",
                "broadcastAttemptFps",
                "broadcastSuccessFps",
                "broadcastFps",
                "broadcastFrameSeq",
                "perClientSendFps",
                "clientCount",
                "encodeMs",
                "jsonEncodeMs",
                "frameSeq",
                "broadcastSeq",
            ):
                if ex.get(key) is not None:
                    p_perf[key] = ex[key]
        if self._prev_broadcast_ms is not None:
            p_perf["broadcastMs"] = round(float(self._prev_broadcast_ms), 2)
        else:
            p_perf["broadcastMs"] = None
        if self._prev_loop_ms is not None:
            p_perf["loopMs"] = round(float(self._prev_loop_ms), 2)
        else:
            p_perf["loopMs"] = None
        return p_perf

    def decorate_frame_performance_after_build(self, d: dict) -> None:
        """无人脸等无 debug.performance 的帧，补上与有人脸一致的 performance 块。"""
        dbg = d.get("debug")
        if isinstance(dbg, dict) and isinstance(dbg.get("performance"), dict):
            return
        d.setdefault("debug", {})["performance"] = self._build_common_performance_fragment()

    def get_loop_interval_sec(self) -> float:
        return self._source_manager.get_loop_interval_sec(self._process_interval_sec)

    def is_video_ended(self) -> bool:
        return bool(self._source_manager.is_video_source and self._video_ended)

    def should_defer_video_frame_build(self, clients: int, can_send: bool) -> bool:
        return self._source_manager.should_defer_video_frame_build(clients, can_send)

    def replay_video(self, reason: str = "", video_time_ms: float | None = None) -> bool:
        """Stop→Start 或 control replayVideo：重播视频，可选 seek 到指定 videoTimeMs。"""
        with self._session_lock:
            ok = self._source_manager.replay_video(reason, video_time_ms)
            if ok:
                self._recreate_landmarker()
                self._video_ended = False
                self._video_ended_frame = None
                self._last_full_face_box = None
                self._last_roi_rect = None
                self._roi_miss_count = 0
                self._stable_roi.reset()
                self._last_stable_roi_debug = None
                print(f"[VIDEO] playback reset ({reason or 'replay'})", flush=True)
        return ok

    def seek_video(self, video_time_ms: float) -> bool:
        with self._session_lock:
            ok = self._source_manager.seek_video(video_time_ms)
            if ok:
                self._recreate_landmarker()
                self._video_ended = False
                self._video_ended_frame = None
                self._last_full_face_box = None
                self._last_roi_rect = None
                self._roi_miss_count = 0
                self._stable_roi.reset()
                self._last_stable_roi_debug = None
                self._video_start_ms = max(0.0, float(video_time_ms))
                print(f"[VIDEO] seek to {self._video_start_ms:g}ms", flush=True)
        return ok

    def set_roi_tracking(
        self,
        *,
        mode: str | None = None,
        enabled: bool | None = None,
        multiplier: float | int | str | None = None,
    ) -> None:
        if mode is not None:
            self._tracking_mode = normalize_tracking_mode(mode)
        elif enabled is not None:
            self._tracking_mode = "roi-tracking" if bool(enabled) else "full-frame"
        if multiplier is not None:
            self._roi_multiplier = normalize_roi_multiplier(multiplier)
        self._last_full_face_box = None
        self._last_roi_rect = None
        self._roi_miss_count = 0
        self._stable_roi.reset()
        self._last_stable_roi_debug = None
        print(
            f"[mediapipe] tracking mode={self._tracking_mode} roiMultiplier={self._roi_multiplier}",
            flush=True,
        )

    def _decorate_input_source(self, input_src: dict[str, Any] | None) -> dict[str, Any] | None:
        if not input_src:
            return input_src
        stamped = self._source_manager.stamp_input_source(input_src)
        if not stamped:
            return stamped
        out = {**stamped, "trackingMode": self._tracking_mode}
        if is_roi_tracking_mode(self._tracking_mode):
            out["roiMultiplier"] = float(self._roi_multiplier)
        return out

    def _resolve_roi_rect_for_inference(self, fw: int, fh: int) -> RoiRect | None:
        mode = self._tracking_mode
        if mode == "roi-tracking":
            if self._last_full_face_box is None:
                return None
            return compute_roi_rect(
                self._last_full_face_box,
                fw,
                fh,
                self._roi_multiplier,
            )
        if mode == "stable-roi":
            return self._stable_roi.get_roi_rect(fw, fh)
        return None

    def _detect_with_optional_roi(
        self,
        frame: np.ndarray,
        rgb: np.ndarray,
        mp_ts: int,
    ) -> tuple[Any, RoiRect | None, str, float]:
        fh, fw = int(frame.shape[0]), int(frame.shape[1])
        mode = self._tracking_mode
        roi_active = is_roi_tracking_mode(mode)
        mp_image_full = self._Image(image_format=self._ImageFormat.SRGB, data=rgb)

        need_seed = (
            not roi_active
            or (mode == "roi-tracking" and self._last_full_face_box is None)
            or (mode == "stable-roi" and not self._stable_roi.initialized)
        )
        if need_seed:
            inf_t0 = time.perf_counter()
            result = self._landmarker.detect_for_video(mp_image_full, mp_ts)
            inference_ms = (time.perf_counter() - inf_t0) * 1000.0
            path = "full" if not roi_active else "full-seed"
            return result, None, path, inference_ms

        roi_rect = self._resolve_roi_rect_for_inference(fw, fh)
        if roi_rect is None:
            inf_t0 = time.perf_counter()
            result = self._landmarker.detect_for_video(mp_image_full, mp_ts)
            inference_ms = (time.perf_counter() - inf_t0) * 1000.0
            return result, None, "roi-fallback-full", inference_ms

        cropped = crop_bgr_frame(frame, roi_rect)
        if cropped.size == 0:
            inf_t0 = time.perf_counter()
            result = self._landmarker.detect_for_video(mp_image_full, mp_ts)
            inference_ms = (time.perf_counter() - inf_t0) * 1000.0
            return result, None, "roi-fallback-full", inference_ms

        rgb_roi = np.ascontiguousarray(cv2.cvtColor(cropped, cv2.COLOR_BGR2RGB))
        mp_image_roi = self._Image(image_format=self._ImageFormat.SRGB, data=rgb_roi)
        inf_t0 = time.perf_counter()
        result_roi = self._landmarker.detect_for_video(mp_image_roi, mp_ts)
        inference_ms = (time.perf_counter() - inf_t0) * 1000.0

        if face_detected_in_result(result_roi):
            self._roi_miss_count = 0
            result = remap_result_landmarks_to_full(result_roi, roi_rect, fw, fh)
            self._last_roi_rect = roi_rect
            path = "stable-roi" if mode == "stable-roi" else "roi"
            return result, roi_rect, path, inference_ms

        self._roi_miss_count += 1
        if self._roi_miss_count >= 3:
            self._last_full_face_box = None
            if mode == "stable-roi":
                self._stable_roi.reset()
        inf_t0 = time.perf_counter()
        result = self._landmarker.detect_for_video(mp_image_full, mp_ts)
        inference_ms += (time.perf_counter() - inf_t0) * 1000.0
        return result, None, "roi-fallback-full", inference_ms

    def _attach_face_scale_to_tracking_debug(
        self,
        tracking_debug: dict[str, Any] | None,
        *,
        frame_width: int,
        frame_height: int,
        roi_rect: RoiRect | None,
    ) -> None:
        if not isinstance(tracking_debug, dict):
            return
        ffb = tracking_debug.get("fullFaceBox")
        stable_debug = None
        if self._tracking_mode == "stable-roi" and isinstance(ffb, dict):
            stable_debug = self._stable_roi.observe_after_frame(
                ffb,
                frame_width,
                frame_height,
                self._roi_multiplier,
            )
            self._last_stable_roi_debug = stable_debug
        tracking_debug["faceScale"] = build_face_scale_debug(
            frame_width=frame_width,
            frame_height=frame_height,
            full_face_box=ffb if isinstance(ffb, dict) else None,
            roi_enabled=is_roi_tracking_mode(self._tracking_mode),
            roi_rect=roi_rect,
            roi_multiplier=self._roi_multiplier,
            inference_path=self._last_inference_path or "full",
            stable_roi_debug=stable_debug,
        )
        if isinstance(ffb, dict):
            self._last_full_face_box = dict(ffb)

    def _build_video_ended_frame_dict(self) -> dict:
        if self._video_ended_frame is not None:
            return self._video_ended_frame
        last_src = dict(self._last_input_source or {})
        if not last_src:
            vid = self._video_input
            last_src = {
                "sourceType": "video",
                "sourceId": vid.source_id if vid else "video-unknown",
                "sourceSeq": 0,
                "frameIndex": 0,
                "timestampMs": 0.0,
                "videoTimeMs": 0.0,
                "playbackRate": float(self._playback_rate),
                "paused": True,
                "seeking": False,
                "seekEpoch": 0,
            }
        else:
            last_src = {**last_src, "paused": True}
        dbg = {
            "inputSource": last_src,
            "videoPlayback": {
                "ended": True,
                "sourceId": last_src.get("sourceId"),
                "excludeFromSummary": True,
            },
        }
        diag_meta = {
            "isStatusFrame": True,
            "excludeFromSummary": True,
            "statusReason": "video-ended",
        }
        ts = float(last_src.get("timestampMs") or 0.0)
        self._video_ended_frame = _make_frame_dict(
            timestamp_ms=ts,
            face_detected=False,
            quality=0.0,
            rig=create_neutral_rig(),
            debug=dbg,
            input_source=last_src,
            diagnostic=diag_meta,
        )
        return self._video_ended_frame

    def _build_video_paused_frame_dict(self) -> dict:
        cached = self._last_video_tracking_frame
        if cached is not None:
            frame = copy.deepcopy(cached)
            dbg = dict(frame.get("debug") or {})
            src = dict(dbg.get("inputSource") or self._last_input_source or {})
            src["paused"] = True
            dbg["inputSource"] = src
            frame["debug"] = dbg
            self._m_generated.tick()
            return frame
        now_ms = float((self._last_input_source or {}).get("videoTimeMs") or 0.0)
        paused_src = self._decorate_input_source(
            {
                **(self._last_input_source or {}),
                "paused": True,
                "timestampMs": now_ms,
                "videoTimeMs": now_ms,
            }
        )
        self._m_generated.tick()
        return _make_frame_dict(
            timestamp_ms=now_ms,
            face_detected=False,
            quality=0.0,
            rig=create_neutral_rig(),
            debug={"inputSource": paused_src} if paused_src else None,
            input_source=paused_src,
        )

    def pause_video(self) -> bool:
        with self._session_lock:
            ok = self._source_manager.pause_video()
            if ok:
                print("[VIDEO] paused", flush=True)
        return ok

    def resume_video(self) -> bool:
        with self._session_lock:
            ok = self._source_manager.resume_video()
            if ok:
                print("[VIDEO] resumed", flush=True)
        return ok

    def _build_idle_frame_dict(self) -> dict:
        now_ms = time.time() * 1000.0
        idle_src = self._decorate_input_source(
            {
                "sourceType": "idle",
                "sourceId": "idle",
                "sourceSeq": 0,
                "frameIndex": 0,
                "timestampMs": now_ms,
                "videoTimeMs": None,
                "seekEpoch": 0,
            }
        )
        self._m_generated.tick()
        return _make_frame_dict(
            timestamp_ms=now_ms,
            face_detected=False,
            quality=0.0,
            rig=create_neutral_rig(),
            debug={"inputSource": idle_src} if idle_src else None,
            input_source=idle_src,
        )

    def build_frame_dict(self) -> dict:
        with self._session_lock:
            return self._build_frame_dict_impl()

    def _build_frame_dict_impl(self) -> dict:
        mgr = self._source_manager
        if mgr.is_idle:
            self._sync_source_refs()
            return self._build_idle_frame_dict()

        cap_t0 = time.perf_counter()
        input_frame = mgr.read_frame()
        cap_read_ms = (time.perf_counter() - cap_t0) * 1000.0
        self._sync_source_refs()

        if mgr.is_idle:
            return self._build_idle_frame_dict()

        self._m_capture.tick()

        if mgr.is_video_source:
            if input_frame is None:
                if mgr.video_paused and not mgr.video_ended:
                    return self._build_video_paused_frame_dict()
                self._video_ended = mgr.video_ended
                if self._video_ended:
                    print("[VIDEO] playback ended", flush=True)
                    return self._build_video_ended_frame_dict()
                return self._build_idle_frame_dict()
            frame_dict = self.process_tracking_frame(input_frame, cap_read_ms=cap_read_ms)
            if not mgr.video_paused:
                self._last_video_tracking_frame = frame_dict
            return frame_dict

        if input_frame is None:
            return self._build_idle_frame_dict()
        return self.process_tracking_frame(input_frame, cap_read_ms=cap_read_ms)

    def process_tracking_frame(
        self,
        input_frame: dict,
        *,
        cap_read_ms: float | None = None,
    ) -> dict:
        """TrackingInputFrame → MediaPipe → rig（Phase 0 主 pipeline 入口）。"""
        frame = input_frame.get("image")
        now_ms = float(input_frame.get("timestampMs") or time.time() * 1000.0)
        is_video_input = str(input_frame.get("sourceType")) in ("video", "uploaded-video")
        source_monotonic_ms = round(time.monotonic() * 1000.0, 3)
        input_src = input_source_debug_dict(input_frame)
        if input_src and is_video_input:
            input_src = {**input_src, "videoMode": self._video_mode}
        if input_src:
            input_src["sourceMonotonicTimeMs"] = source_monotonic_ms
        input_src = self._decorate_input_source(input_src)
        if input_src:
            self._last_input_source = dict(input_src)

        if frame is None:
            self._perf_base = {
                "capReadMs": float(cap_read_ms or 0.0),
                "preprocessMs": 0.0,
                "inferenceMs": 0.0,
                "mappingMs": 0.0,
                "captureMs": float(cap_read_ms or 0.0),
            }
            self._last_smoothed_rig = None
            self._m_generated.tick()
            return _make_frame_dict(
                timestamp_ms=now_ms,
                face_detected=False,
                quality=0.0,
                rig=create_neutral_rig(),
                debug=None,
                input_source=input_src,
            )

        if cap_read_ms is None:
            cap_t0 = time.perf_counter()
            cap_read_ms = (time.perf_counter() - cap_t0) * 1000.0

        pp_t0 = time.perf_counter()
        rgb = np.ascontiguousarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        preprocess_ms = (time.perf_counter() - pp_t0) * 1000.0
        if is_video_input:
            video_ts = int(float(input_frame.get("videoTimeMs") or now_ms))
            if video_ts <= self._video_ts_ms:
                video_ts = self._video_ts_ms + 1
            self._video_ts_ms = video_ts
            mp_ts = self._video_ts_ms
        else:
            vw = time.perf_counter()
            if self._interval_ms > 0:
                self._video_ts_ms += self._interval_ms
            else:
                if self._last_video_wall is None:
                    self._video_ts_ms += 33
                else:
                    self._video_ts_ms += max(1, int((vw - self._last_video_wall) * 1000))
            self._last_video_wall = vw
            mp_ts = self._video_ts_ms
        fh, fw = int(frame.shape[0]), int(frame.shape[1])
        result, roi_rect_used, inference_path, inference_ms = self._detect_with_optional_roi(
            frame, rgb, mp_ts
        )
        self._last_inference_path = inference_path
        self._m_inference.tick()

        lm = getattr(result, "face_landmarks", None)
        face_detected = False
        if lm is not None:
            try:
                face_detected = len(lm) > 0
            except TypeError:
                face_detected = bool(lm)

        gaze_mode = str((self._config.get("gaze") or {}).get("gazeEstimatorMode", ""))
        is_iris_only = gaze_mode == IRIS_ONLY_MODE

        if not face_detected:
            if is_iris_only:
                self._gaze_state["iris_missing_count"] = int(
                    self._gaze_state.get("iris_missing_count", 0)
                ) + 1
            else:
                self._reset_gaze_state()
            self._reset_mouth_geometry_state()
            self._last_smoothed_rig = None
            self._perf_base = {
                "capReadMs": float(cap_read_ms),
                "preprocessMs": preprocess_ms,
                "inferenceMs": inference_ms,
                "mappingMs": 0.0,
                "captureMs": float(cap_read_ms) + preprocess_ms,
            }
            self._m_generated.tick()
            self._finalize_preview_frame(frame, result=result, face_detected=False)
            fh, fw = int(frame.shape[0]), int(frame.shape[1])
            no_face_dbg: dict[str, Any] | None = None
            try:
                td_no_face = build_tracking_debug(
                    result,
                    frame_width=fw,
                    frame_height=fh,
                    face_detected=False,
                    preview_overlay=self._tracking_debug_preview_overlay(),
                )
                self._attach_face_scale_to_tracking_debug(
                    td_no_face,
                    frame_width=fw,
                    frame_height=fh,
                    roi_rect=roi_rect_used,
                )
                no_face_dbg = {
                    "inputSource": input_src,
                    "trackingDebug": td_no_face,
                }
            except Exception:
                no_face_dbg = {"inputSource": input_src} if input_src else None
            return _make_frame_dict(
                timestamp_ms=now_ms,
                face_detected=False,
                quality=0.0,
                rig=create_neutral_rig(),
                debug=no_face_dbg,
                input_source=input_src,
            )

        if not is_iris_only:
            self._maybe_calibrate(result)
        eye_xy_center_status: dict[str, Any] = {}
        neutral_init_status: dict[str, Any] = {}
        neutral_just_ready = False
        fh, fw = int(frame.shape[0]), int(frame.shape[1])

        if is_iris_only:
            self._gaze_state["iris_gaze_armed"] = bool(getattr(self, "_iris_gaze_armed", False))
            self._ensure_iris_init_session(input_src)
            motion = self._compute_neutral_init_motion(
                result=result,
                frame_width=fw,
                frame_height=fh,
            )
            if isinstance(motion, dict):
                self._gaze_state["init_frame_motion"] = dict(motion)
        else:
            self._ensure_eye_xy_auto_center(input_src)
            blend_for_center = extract_debug_blendshapes(result)
            gaze_for_center = estimate_eye_gaze_from_landmarks(result, self._config)
            prev_center_ready = bool(self._eye_xy_center.status_dict().get("ready"))
            eye_xy_center_status = self._update_eye_xy_auto_center(
                input_src=input_src,
                result=result,
                blend=blend_for_center,
                gaze_dbg=gaze_for_center,
            )
            neutral_init_status = self._update_gaze_neutral_init(
                input_src=input_src,
                result=result,
                blend=blend_for_center,
                gaze_dbg=gaze_for_center,
                frame_width=fw,
                frame_height=fh,
                face_detected=True,
            )
            neutral_just_ready = (not prev_center_ready) and bool(eye_xy_center_status.get("ready"))
        map_t0 = time.perf_counter()
        pack = mediapipe_result_to_rig(
            result,
            self._config,
            self._gaze_state,
            self._lip_state,
            self._jaw_state,
            self._nose_state,
            self._mouth_scenario_state,
            self._brow_state,
            self._mouth_corner_state,
            timestamp_ms=now_ms,
        )
        rig = pack["rig"]
        dbg = pack.get("debug") or {}
        if is_iris_only:
            self._log_iris_init_ready_if_needed()
        if isinstance(dbg, dict):
            if neutral_just_ready and not is_iris_only:
                pack2 = mediapipe_result_to_rig(
                    result,
                    self._config,
                    self._gaze_state,
                    self._lip_state,
                    self._jaw_state,
                    self._nose_state,
                    self._mouth_scenario_state,
                    self._brow_state,
                    self._mouth_corner_state,
                    timestamp_ms=now_ms,
                )
                rig = pack2["rig"]
                dbg = pack2.get("debug") or dbg
            gaze_blk = dbg.get("gaze") if isinstance(dbg.get("gaze"), dict) else {}
            if not is_iris_only:
                center_status = eye_xy_center_status
                center_ready = bool(center_status.get("ready"))
                center_collecting = bool(center_status.get("collecting"))
                session_locked = bool(center_status.get("sessionLocked"))
                gaze_blk["eyeXyCenter"] = center_status
                gaze_blk["eyeXyCenterReady"] = center_ready
                gaze_blk["eyeXyCenterCollecting"] = center_collecting
                gaze_blk["eyeXyCenterSessionLocked"] = session_locked
                gaze_blk["eyeXyCenterSampleCount"] = int(center_status.get("sampleCount") or 0)
                gaze_blk["eyeXyCenterEstimatorVersion"] = str(
                    center_status.get("estimatorVersion") or GAZE_ESTIMATOR_VERSION
                )
                gaze_blk["neutralCacheVersion"] = str(
                    center_status.get("schemaVersion") or NEUTRAL_STORE_SCHEMA_VERSION
                )
                gaze_blk["neutralCacheInvalidated"] = (
                    False
                    if session_locked
                    else bool(center_status.get("cacheInvalidated")) and not center_ready
                )
                gaze_blk["estimatorVersion"] = str(
                    center_status.get("estimatorVersion") or GAZE_ESTIMATOR_VERSION
                )
                for k in (
                    "neutralInitState",
                    "neutralInitSampleCount",
                    "neutralInitRequiredSamples",
                    "neutralInitProgress",
                    "neutralInitReady",
                    "neutralInitFailed",
                    "neutralInitReason",
                    "neutralInitRemainingMs",
                    "neutralInitShowPrompt",
                    "sessionNeutralX",
                    "sessionNeutralY",
                    "sessionNeutralStableY",
                    "neutralPostValidated",
                    "neutralPostValidationAdjusted",
                    "neutralPostValidationDeltaX",
                    "neutralPostValidationDeltaY",
                ):
                    if k in neutral_init_status:
                        gaze_blk[k] = neutral_init_status[k]
                dbg["eyeXyCenter"] = center_status
            dbg["gaze"] = gaze_blk
        if isinstance(dbg, dict) and input_src is not None:
            dbg["inputSource"] = input_src
        sm = self._config.get("smoothing") or {}
        if bool(sm.get("enabled")):
            alpha = float(sm.get("alpha", 0.35))
            rig = _ema_merge_rig(self._last_smoothed_rig, rig, alpha)
            self._last_smoothed_rig = copy.deepcopy(rig)
        else:
            self._last_smoothed_rig = copy.deepcopy(rig)
        mapping_ms = (time.perf_counter() - map_t0) * 1000.0
        self._m_mapping.tick()
        self._perf_base = {
            "capReadMs": float(cap_read_ms),
            "preprocessMs": preprocess_ms,
            "inferenceMs": inference_ms,
            "mappingMs": mapping_ms,
            "captureMs": float(cap_read_ms) + preprocess_ms,
        }

        quality = estimate_tracking_quality(result, True)

        if isinstance(dbg, dict):
            fh, fw = int(frame.shape[0]), int(frame.shape[1])
            try:
                td_face = build_tracking_debug(
                    result,
                    frame_width=fw,
                    frame_height=fh,
                    face_detected=True,
                    face_presence_confidence=float(quality),
                    preview_overlay=self._tracking_debug_preview_overlay(),
                )
                self._attach_face_scale_to_tracking_debug(
                    td_face,
                    frame_width=fw,
                    frame_height=fh,
                    roi_rect=roi_rect_used,
                )
                dbg["trackingDebug"] = td_face
            except Exception as exc:
                print(
                    f"[tracking_debug] build_tracking_debug failed: {exc}",
                    file=sys.stderr,
                    flush=True,
                )

        if isinstance(dbg, dict):
            self._m_generated.tick()
            dbg["performance"] = self._build_common_performance_fragment()

        self._finalize_preview_frame(frame, result=result, face_detected=True)
        if input_src:
            input_src["trackingCompleteTimeMs"] = round(time.monotonic() * 1000.0, 3)
            if isinstance(dbg, dict):
                dbg["inputSource"] = input_src
        return _make_frame_dict(
            timestamp_ms=now_ms,
            face_detected=True,
            quality=float(quality),
            rig=rig,
            debug=dbg,
            input_source=input_src,
        )

    def capture_json_payload(self) -> str:
        """兼容旧调用；推荐 WebSocket 泵使用 build_frame_dict 以附带完整 performance。"""
        return json.dumps(self.build_frame_dict())


class _TrackingServiceHttpHandler(BaseHTTPRequestHandler):
    """MJPEG preview + Phase 3.0 source control REST API."""

    def log_message(self, _format: str, *_args) -> None:
        return

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def _send_dataset_file(self, file_path: Path, file_kind: str) -> None:
        kind = str(file_kind or "").lower()
        if kind in ("metadata", "metadata.json"):
            content_type = "application/json; charset=utf-8"
        elif file_path.suffix == ".gz":
            content_type = "application/gzip"
        else:
            content_type = "application/x-ndjson; charset=utf-8"
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header(
            "Content-Disposition",
            f'attachment; filename="{file_path.name}"',
        )
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def _guess_video_content_type(self, file_path: Path) -> str:
        guessed, _ = mimetypes.guess_type(str(file_path))
        if guessed and guessed.startswith("video/"):
            return guessed
        ext = file_path.suffix.lower()
        if ext in (".mov",):
            return "video/quicktime"
        if ext in (".webm",):
            return "video/webm"
        if ext in (".mkv",):
            return "video/x-matroska"
        return "video/mp4"

    def _serve_media_file(self, file_path: Path) -> None:
        path = file_path.resolve()
        if not path.is_file():
            self._send_json(404, {"ok": False, "error": "video-not-found"})
            return
        file_size = int(path.stat().st_size)
        content_type = self._guess_video_content_type(path)
        range_header = self.headers.get("Range")
        if range_header:
            try:
                units, _, spec = range_header.partition("=")
                if units.strip().lower() != "bytes":
                    raise ValueError("unsupported range unit")
                start_text, _, end_text = spec.partition("-")
                start = int(start_text) if start_text else 0
                end = int(end_text) if end_text else file_size - 1
                start = max(0, min(start, file_size - 1))
                end = max(start, min(end, file_size - 1))
            except (ValueError, TypeError):
                self.send_error(416, "Invalid Range")
                return
            length = end - start + 1
            self.send_response(206)
            self.send_header("Content-Type", content_type)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
            self.send_header("Content-Length", str(length))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            with path.open("rb") as fh:
                fh.seek(start)
                self.wfile.write(fh.read(length))
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(file_size))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        with path.open("rb") as fh:
            while True:
                chunk = fh.read(1024 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)

    def _handle_video_upload(self) -> None:
        content_type = self.headers.get("Content-Type", "")
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length > 0 else b""
        filename, file_bytes = video_upload_store.parse_multipart_file(content_type, body)
        if not file_bytes:
            self._send_json(400, {"ok": False, "error": "invalid-multipart-upload"})
            return
        result = video_upload_store.upload_video(file_bytes, filename or "upload.mp4")
        status = 200 if result.get("ok") else 400
        self._send_json(status, result)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:
        path = (self.path or "").split("?", 1)[0]
        session: MediapipeTrackingSession = self.server.session  # type: ignore[attr-defined]
        if path == self.server.preview_path:  # type: ignore[attr-defined]
            if not getattr(self.server, "mjpeg_enabled", False):  # type: ignore[attr-defined]
                self.send_error(404, "MJPEG preview disabled")
                return
            self._serve_mjpeg(session)
            return
        if path == "/api/tracking/cameras":
            mgr = camera_device_manager.get_camera_device_manager(
                open_camera_fn=_open_video_capture,
            )
            self._send_json(200, mgr.list_response())
            return
        if path == "/api/tracking/source":
            self._send_json(200, session.get_tracking_source_state())
            return
        if path == "/api/tracking/videos":
            self._send_json(200, {"videos": list_default_videos()})
            return
        if path.startswith("/api/tracking/videos/file/"):
            parts = [p for p in path.split("/") if p]
            if len(parts) >= 5:
                video_id = unquote(parts[4])
                resolved = resolve_default_video_path(video_id)
                if resolved is not None:
                    self._serve_media_file(resolved)
                    return
            self._send_json(404, {"ok": False, "error": "video-not-found"})
            return
        if path.startswith("/api/tracking/videos/uploads/") and path.endswith("/file"):
            parts = [p for p in path.split("/") if p]
            if len(parts) >= 6:
                uploaded_id = unquote(parts[4])
                entry = video_upload_store.get_by_id(uploaded_id)
                if entry:
                    stored = video_upload_store.resolve_stored_path(entry)
                    if stored is not None:
                        self._serve_media_file(stored)
                        return
            self._send_json(404, {"ok": False, "error": "uploaded-video-not-found"})
            return
        if path == "/api/tracking/videos/uploads":
            videos = [
                video_upload_store.public_video_dict(v)
                for v in video_upload_store.load_index()
            ]
            self._send_json(200, {"ok": True, "videos": videos})
            return
        if path == "/api/tracking/dataset/status":
            self._send_json(200, TrackingDatasetRecorder.get_status())
            return
        if path == "/api/tracking/dataset/files":
            self._send_json(200, {"files": TrackingDatasetRecorder.list_files()})
            return
        if path.startswith("/api/tracking/dataset/download/"):
            parts = [p for p in path.split("/") if p]
            if len(parts) >= 6:
                session_id = parts[4]
                file_kind = parts[5]
                file_path = TrackingDatasetRecorder.resolve_download_path(
                    session_id, file_kind
                )
                if file_path is not None:
                    self._send_dataset_file(file_path, file_kind)
                    return
            self._send_json(404, {"ok": False, "error": "dataset-file-not-found"})
            return
        self.send_error(404, "Not Found")

    def do_POST(self) -> None:
        path = (self.path or "").split("?", 1)[0]
        session: MediapipeTrackingSession = self.server.session  # type: ignore[attr-defined]
        if path == "/api/tracking/videos/upload":
            self._handle_video_upload()
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_json(400, {"ok": False, "error": "invalid-json"})
            return
        if not isinstance(body, dict):
            body = {}
        mgr = camera_device_manager.get_camera_device_manager(
            open_camera_fn=_open_video_capture,
        )
        if path == "/api/tracking/cameras/rescan":
            max_index = int(body.get("maxIndex") or body.get("max_index") or 8)
            mgr.scan_cameras(max_index=max_index)
            self._send_json(200, mgr.list_response())
            return
        if path == "/api/tracking/cameras/test":
            result = mgr.test_camera(
                camera_id=str(body.get("cameraId") or body.get("camera_id") or "").strip() or None,
                camera_index=body.get("cameraIndex") if "cameraIndex" in body else None,
            )
            status = 200 if result.get("ok") else 400
            self._send_json(status, result)
            return
        if path == "/api/tracking/cameras/preferred":
            cid = str(body.get("cameraId") or body.get("camera_id") or "").strip()
            result = mgr.save_preferred_camera(cid)
            status = 200 if result.get("ok") else 400
            self._send_json(status, result)
            return
        if path == "/api/tracking/source":
            result = session.switch_tracking_source(body)
            status = 200 if result.get("ok") else 400
            self._send_json(status, result)
            return
        if path == "/api/tracking/video/seek":
            ms = body.get("videoTimeMs")
            if ms is None:
                self._send_json(400, {"ok": False, "error": "missing-videoTimeMs"})
                return
            ok = bool(session.seek_video(float(ms)))
            if ok:
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "videoTimeMs": float(ms),
                        **session.get_tracking_source_state(),
                    },
                )
            else:
                self._send_json(
                    400,
                    {"ok": False, "error": "seek-failed", **session.get_tracking_source_state()},
                )
            return
        if path == "/api/tracking/video/pause":
            paused = body.get("paused")
            if paused is None:
                self._send_json(400, {"ok": False, "error": "missing-paused"})
                return
            ok = bool(
                session.pause_video() if bool(paused) else session.resume_video()
            )
            status = 200 if ok else 400
            self._send_json(
                status,
                {
                    "ok": ok,
                    "videoPaused": bool(paused),
                    **session.get_tracking_source_state(),
                },
            )
            return
        if path == "/api/tracking/dataset/start":
            source_state = session.get_tracking_source_state()
            result = TrackingDatasetRecorder.start(body, source_state)
            status = 200 if result.get("ok") else 400
            self._send_json(status, result)
            return
        if path == "/api/tracking/dataset/stop":
            safety = body.get("safety") if isinstance(body.get("safety"), dict) else None
            result = TrackingDatasetRecorder.stop(safety)
            status = 200 if result.get("ok") else 400
            self._send_json(status, result)
            return
        if path == "/api/tracking/dataset/append":
            frame = body.get("frame")
            if not isinstance(frame, dict):
                self._send_json(400, {"ok": False, "error": "invalid-frame"})
                return
            result = TrackingDatasetRecorder.append(frame)
            status = 200 if result.get("ok") else 400
            self._send_json(status, result)
            return
        self.send_error(404, "Not Found")

    def do_DELETE(self) -> None:
        path = (self.path or "").split("?", 1)[0]
        session: MediapipeTrackingSession = self.server.session  # type: ignore[attr-defined]
        if path.startswith("/api/tracking/videos/uploads/"):
            parts = [p for p in path.split("/") if p]
            if len(parts) >= 5:
                uploaded_id = parts[4]
                state = session.get_tracking_source_state()
                result = video_upload_store.delete_video(
                    uploaded_id,
                    current_source_id=state.get("sourceId"),
                )
                status = 200 if result.get("ok") else 400
                self._send_json(status, result)
                return
            self._send_json(400, {"ok": False, "error": "invalid-upload-id"})
            return
        self.send_error(404, "Not Found")

    def _serve_mjpeg(self, session: MediapipeTrackingSession) -> None:
        self.send_response(200)
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Connection", "close")
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.end_headers()
        boundary = b"--frame\r\n"
        interval = float(self.server.frame_interval)  # type: ignore[attr-defined]
        quality = int(self.server.jpeg_quality)  # type: ignore[attr-defined]
        try:
            while getattr(self.server, "running", False):  # type: ignore[attr-defined]
                jpeg = session.encode_preview_jpeg(quality)
                if jpeg:
                    try:
                        self.wfile.write(boundary)
                        self.wfile.write(b"Content-Type: image/jpeg\r\n\r\n")
                        self.wfile.write(jpeg)
                        self.wfile.write(b"\r\n")
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError, OSError):
                        break
                time.sleep(interval)
        except Exception:
            pass


class _MjpegPreviewHandler(_TrackingServiceHttpHandler):
    """Backward-compatible alias."""


class MjpegPreviewHttpServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def start_tracking_http_server(
    session: MediapipeTrackingSession,
    *,
    host: str,
    port: int,
    path: str = _DEFAULT_PREVIEW_PATH,
    fps: float = 12.0,
    quality: int = 60,
    mjpeg_enabled: bool = True,
) -> MjpegPreviewHttpServer:
    if not path.startswith("/"):
        path = "/" + path
    frame_interval = 1.0 / max(1e-3, float(fps))
    httpd = MjpegPreviewHttpServer((host, int(port)), _TrackingServiceHttpHandler)
    httpd.preview_path = path
    httpd.frame_interval = frame_interval
    httpd.jpeg_quality = int(quality)
    httpd.session = session
    httpd.mjpeg_enabled = bool(mjpeg_enabled)
    httpd.running = True
    thread = threading.Thread(
        target=httpd.serve_forever,
        name="tracking-http",
        daemon=True,
    )
    thread.start()
    print(
        f"[mediapipe_tracking_server] HTTP API: http://{host}:{port}/api/tracking/source",
        flush=True,
    )
    print(
        f"[mediapipe_tracking_server] Dataset API: http://{host}:{port}/api/tracking/dataset/start",
        flush=True,
    )
    if mjpeg_enabled:
        print(
            f"[mediapipe_tracking_server] MJPEG preview: http://{host}:{port}{path} "
            f"fps={fps:g} quality={quality}",
            flush=True,
        )
    return httpd


def start_mjpeg_preview_server(
    session: MediapipeTrackingSession,
    *,
    host: str,
    port: int,
    path: str = _DEFAULT_PREVIEW_PATH,
    fps: float = 12.0,
    quality: int = 60,
) -> MjpegPreviewHttpServer:
    return start_tracking_http_server(
        session,
        host=host,
        port=port,
        path=path,
        fps=fps,
        quality=quality,
        mjpeg_enabled=True,
    )


def stop_mjpeg_preview_server(httpd: MjpegPreviewHttpServer | None) -> None:
    if httpd is None:
        return
    httpd.running = False
    with contextlib.suppress(Exception):
        httpd.shutdown()
    with contextlib.suppress(Exception):
        httpd.server_close()


async def run_server(
    *,
    host: str,
    port: int,
    ws_path: str,
    session: MediapipeTrackingSession,
    process_interval_sec: float,
    broadcast_interval_sec: float,
) -> None:
    import logging

    class _SuppressInvalidWsProbe(logging.Filter):
        """Port health-check probes (plain TCP) are not WebSocket clients."""

        def filter(self, record: logging.LogRecord) -> bool:
            msg = record.getMessage()
            if "opening handshake failed" in msg:
                return False
            if "did not receive a valid HTTP request" in msg:
                return False
            return True

    for logger_name in ("websockets.server", "websockets.asyncio.server", "websockets"):
        logging.getLogger(logger_name).addFilter(_SuppressInvalidWsProbe())
    connections: set = set()
    loop = asyncio.get_running_loop()
    stop = loop.create_future()

    async def broadcast_source_changed(payload: dict[str, Any]) -> None:
        msg = json.dumps({"type": "tracking.sourceChanged", **payload})
        dead: list = []
        for ws in list(connections):
            try:
                await ws.send(msg)
            except (ConnectionClosed, BrokenPipeError, ConnectionError):
                dead.append(ws)
            except Exception:
                dead.append(ws)
        for ws in dead:
            connections.discard(ws)

    def on_source_changed_sync(payload: dict[str, Any]) -> None:
        asyncio.run_coroutine_threadsafe(broadcast_source_changed(payload), loop)

    session.set_source_changed_handler(on_source_changed_sync)

    def _shutdown(*_a) -> None:
        if not stop.done():
            stop.set_result(True)

    signal.signal(signal.SIGINT, _shutdown)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _shutdown)

    async def handler(websocket) -> None:
        try:
            if _connection_path(websocket) != ws_path:
                await websocket.close(code=1008, reason="invalid path")
                return
        except Exception:
            await websocket.close(code=1011, reason="handshake error")
            return

        connections.add(websocket)
        try:
            async for message in websocket:
                if isinstance(message, str):
                    _handle_tracking_control_message(session, message)
        except ConnectionClosed:
            pass
        finally:
            connections.discard(websocket)

    # -------------------------------------------------------------------------
    # 单 asyncio.Task「泵」顺序结构（非 producer/consumer 双队列）：
    #
    #   await run_in_executor(build_frame_dict)
    #        └ 同步在同一线程池 worker：cap.read → detect_for_video → mapping
    #          （mediapipe_result_to_rig，含 gaze guard）
    #   decorate_frame_performance_after_build（无人脸时补 performance）
    #   若满足 broadcast 策略且存在客户端：
    #        frameSeq++ → json.dumps → 各客户端 await ws.send
    #   record_post_send_perf（含本轮 wall loop_ms；与上一帧 transport 合并进下一帧 JSON）
    #
    #   睡眠：
    #     --broadcast-interval > 0 时，两次「实际 send」之间至少间隔该秒数（无客户端时不发）。
    #     否则仅 sleep(max(0, --interval - elapsed))，其中 --interval 为「相邻两次 build
    #     调用」的最小墙钟间隔（默认 0.033s）；旧版把 asyncio.sleep 放在本轮末尾，会同时
    #     限制 MediaPipe 与 WebSocket；且 debug.performance.fps 曾用 1000/loop_ms（不含
    #     sleep）导致「Python 60 / Broadcast 16」的错觉，现已用滑窗 generatedFrameFps 等
    #     与 broadcastSuccessFps 区分。
    # -------------------------------------------------------------------------
    last_bcast_wall = 0.0

    async def pump() -> None:
        nonlocal last_bcast_wall
        proc_iv = max(0.0, float(process_interval_sec))
        b_iv = max(0.0, float(broadcast_interval_sec))
        prev_iter_t0: float | None = None
        last_sleep_ms = 0.0

        while not stop.done():
            t_loop0 = time.perf_counter()
            loop_iv = max(0.0, float(session.get_loop_interval_sec()))
            total_period_ms = (t_loop0 - prev_iter_t0) * 1000.0 if prev_iter_t0 is not None else 0.0
            session._timing_for_next_build = {
                "totalPeriodMs": float(total_period_ms),
                "sleepMs": float(last_sleep_ms),
                "targetIntervalMs": float(loop_iv * 1000.0) if loop_iv > 1e-12 else 0.0,
            }
            prev_iter_t0 = t_loop0

            clients = len(connections)
            mon = time.monotonic()
            can_send = b_iv <= 1e-12 or (mon - last_bcast_wall) >= b_iv - 1e-12

            if session.should_defer_video_frame_build(clients, can_send):
                elapsed = time.perf_counter() - t_loop0
                await asyncio.sleep(max(0.02, 0.02 - elapsed))
                continue

            try:
                d = await loop.run_in_executor(None, session.build_frame_dict)
            except Exception as exc:  # pragma: no cover
                print(f"[mediapipe_tracking_server] 推理异常: {exc}", file=sys.stderr)
                d = _make_frame_dict(
                    timestamp_ms=time.time() * 1000,
                    face_detected=False,
                    quality=0.0,
                    rig=create_neutral_rig(),
                    debug=None,
                )
                session._perf_base = {
                    "capReadMs": 0.0,
                    "preprocessMs": 0.0,
                    "inferenceMs": 0.0,
                    "mappingMs": 0.0,
                    "captureMs": 0.0,
                }

            session.decorate_frame_performance_after_build(d)

            dead: list = []
            seq = int(getattr(session, "_frame_seq", 0))
            bc_seq = int(getattr(session, "_broadcast_seq", 0))
            json_ms = 0.0
            send_ms_total = 0.0
            succ = 0
            payload = ""
            did_send = False

            if can_send and clients > 0:
                try:
                    session._frame_seq += 1
                    seq = int(session._frame_seq)
                    d["frameSeq"] = seq
                    d["serverSentAtMs"] = time.time() * 1000.0
                    if getattr(session, "_payload_mode", "full") == "compact":
                        d = _compact_frame_dict(d)
                    _log_video_debug_ws_payload(d)
                    t_j0 = time.perf_counter()
                    payload = json.dumps(d)
                    json_ms = (time.perf_counter() - t_j0) * 1000.0
                    t_send0 = time.perf_counter()
                    for ws in list(connections):
                        try:
                            await ws.send(payload)
                            succ += 1
                        except (ConnectionClosed, BrokenPipeError, ConnectionError):
                            dead.append(ws)
                        except Exception:
                            dead.append(ws)
                    send_ms_total = (time.perf_counter() - t_send0) * 1000.0
                    session._broadcast_seq += 1
                    bc_seq = int(session._broadcast_seq)
                    did_send = True
                    last_bcast_wall = time.monotonic()
                    session.finalize_extras_after_wire(
                        frame_seq=seq,
                        broadcast_seq=bc_seq,
                        json_encode_ms=json_ms,
                        broadcast_send_ms=send_ms_total,
                        clients=clients,
                        successful_sends=succ,
                    )
                except Exception as exc:  # pragma: no cover
                    print(f"[mediapipe_tracking_server] 发送异常: {exc}", file=sys.stderr)

            for ws in dead:
                connections.discard(ws)

            loop_ms = (time.perf_counter() - t_loop0) * 1000.0
            sleep_for_log = last_sleep_ms
            session.record_post_send_perf(
                send_ms_total if did_send else 0.0,
                loop_ms,
                clients=clients,
                payload_bytes=len(payload) if payload else 0,
                json_encode_ms=json_ms if did_send else 0.0,
                sleep_ms=sleep_for_log,
                total_period_ms=total_period_ms,
            )

            elapsed = time.perf_counter() - t_loop0
            last_sleep_ms = 0.0
            sleep_iv = loop_iv
            if session.is_video_ended():
                sleep_iv = max(sleep_iv, 0.25)
            if sleep_iv > 1e-12:
                t_slp = time.perf_counter()
                await asyncio.sleep(max(0.0, sleep_iv - elapsed))
                last_sleep_ms = (time.perf_counter() - t_slp) * 1000.0

    pump_task = asyncio.create_task(pump())
    try:
        async with websockets.serve(handler, host, port):
            print(f"MediaPipe Tracking WS (Ctrl+C exit): ws://{host}:{port}{ws_path}")
            await stop
    finally:
        pump_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await pump_task


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    default_model = _SCRIPT_DIR / "models" / "face_landmarker.task"
    p = argparse.ArgumentParser(description="MediaPipe Face Landmarker → WebSocket RigFrame")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8766)
    p.add_argument("--path", default="/tracking", help="WebSocket path，须与前端 URL 一致")
    p.add_argument("--camera", type=int, default=0)
    p.add_argument(
        "--source",
        choices=("idle", "auto", "camera", "video"),
        default="idle",
        help="输入源：idle/auto=等待前端切换；camera=摄像头；video=视频文件（兼容 CLI）",
    )
    p.add_argument(
        "--video-path",
        "--video",
        dest="video_path",
        type=str,
        default="",
        help="--source video 时的视频文件路径",
    )
    p.add_argument(
        "--playback-rate",
        type=float,
        default=1.0,
        help="视频播放倍速（第一版仅影响读取节奏字段；默认 1.0）",
    )
    p.add_argument(
        "--video-mode",
        choices=("realtime", "deterministic"),
        default="realtime",
        help="video 处理模式：realtime=按 fps 节奏预览；deterministic=逐帧处理不追实时",
    )
    p.add_argument(
        "--tracking-mode",
        choices=("full-frame", "roi-tracking", "stable-roi"),
        default="full-frame",
        help="跟踪输入：full-frame / roi-tracking（每帧跟随）/ stable-roi（稳定观察窗口）",
    )
    p.add_argument(
        "--roi-multiplier",
        type=float,
        default=1.8,
        help="roi-tracking 模式下 ROI 边长相对人脸 max(w,h) 的倍数（1.5/1.8/2.0）",
    )
    p.add_argument(
        "--video-start-ms",
        type=float,
        default=0.0,
        help="video 源启动 / replay 后 seek 到的起始 videoTimeMs（A/B diagnostic 对齐用）",
    )
    p.add_argument("--model", type=str, default=str(default_model), help="face_landmarker.task 路径")
    p.add_argument("--interval", type=float, default=0.033, help="相邻两次 build_frame_dict（含 WS）的最小墙钟间隔（秒），如 0.02 / 0；0 表示不为此 sleep")
    p.add_argument(
        "--broadcast-interval",
        type=float,
        default=0.0,
        help="两次实际 WebSocket send 之间的最小间隔（秒）；0=每帧有客户端则发（仅受 --interval 与摄像头/Mediapipe 耗时限制）",
    )
    p.add_argument(
        "--width",
        type=int,
        default=640,
        help="摄像头请求宽度（像素），如 640 / 320",
    )
    p.add_argument(
        "--height",
        type=int,
        default=480,
        help="摄像头请求高度（像素），如 480 / 240",
    )
    p.add_argument(
        "--mapping",
        type=str,
        default=str(_DEFAULT_MAPPING),
        help="映射 JSON 路径，默认 mediapipe_mapping.default.json",
    )
    p.add_argument(
        "--save-mapping",
        type=str,
        default=str(_DEFAULT_SAVE_MAPPING),
        help="中性脸校准保存路径，默认 models/mediapipe_mapping.json",
    )
    p.add_argument(
        "--calibrate-neutral",
        action="store_true",
        help="启动后采集中性脸 30 帧并更新 neutral 后保存到 --save-mapping",
    )
    p.add_argument(
        "--payload",
        choices=("full", "compact"),
        default="full",
        help="WebSocket 每帧 JSON：full=全部 debug；compact=仅 rig + 轻量 performance（低延迟联调）",
    )
    p.add_argument(
        "--camera-fps",
        type=float,
        default=30.0,
        help="CAP_PROP_FPS 请求值（驱动可能忽略）",
    )
    p.add_argument(
        "--fourcc",
        type=str,
        default="MJPG",
        help="CAP_PROP_FOURCC，4 字符如 MJPG；空字符串则跳过设置",
    )
    p.add_argument(
        "--buffer-size",
        type=int,
        default=1,
        help="CAP_PROP_BUFFERSIZE（低延迟建议 1）",
    )
    p.add_argument(
        "--camera-backend",
        choices=("auto", "dshow", "msmf"),
        default="auto",
        help="OpenCV 采集后端；Windows 下 auto 优先 DSHOW",
    )
    p.add_argument(
        "--preview-mjpeg",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="启用独立 HTTP MJPEG 预览（默认开；与 WebSocket tracking 双通道）",
    )
    p.add_argument(
        "--preview-host",
        default="127.0.0.1",
        help="MJPEG 预览监听地址",
    )
    p.add_argument("--preview-port", type=int, default=8767, help="MJPEG 预览端口")
    p.add_argument(
        "--preview-fps",
        type=float,
        default=12.0,
        help="MJPEG 编码/推送目标帧率（不阻塞 MediaPipe 主循环）",
    )
    p.add_argument(
        "--preview-quality",
        type=int,
        default=60,
        help="JPEG 质量 1–100",
    )
    p.add_argument(
        "--preview-path",
        default=_DEFAULT_PREVIEW_PATH,
        help="MJPEG URL 路径，默认 /preview.mjpg",
    )
    p.add_argument(
        "--preview-landmark-style",
        choices=("minimal", "mesh", "regions", "full"),
        default="minimal",
        help="MJPEG overlay 预设：minimal=少量关键点(默认)；mesh=网格；regions=分区轮廓；full=全部",
    )
    p.add_argument(
        "--preview-draw-landmarks",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="绘制 landmark 点（默认由 --preview-landmark-style 决定）",
    )
    p.add_argument(
        "--preview-draw-mesh",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="绘制 tessellation 网格（默认由 style 决定）",
    )
    p.add_argument(
        "--preview-draw-regions",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="绘制眼/唇/眉/脸廓等区域（默认由 style 决定）",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    video_upload_store.load_index()
    model_path = Path(args.model)
    if not model_path.is_file():
        print(
            "错误：找不到 Face Landmarker 模型文件。\n"
            f"  期望路径: {model_path.resolve()}\n"
            "  请将 Google 提供的 face_landmarker.task 放到:\n"
            f"    {_SCRIPT_DIR / 'models' / 'face_landmarker.task'}\n"
            "  或使用 --model 指定绝对路径。\n"
            "  下载（官方存储桶，文件名以实际为准）:\n"
            "    https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task",
            file=sys.stderr,
        )
        sys.exit(2)

    mapping_path = Path(args.mapping)
    save_mapping_path = Path(args.save_mapping)

    preview_overlay = (
        resolve_preview_overlay_config(
            style=str(args.preview_landmark_style),
            draw_landmarks=args.preview_draw_landmarks,
            draw_mesh=args.preview_draw_mesh,
            draw_regions=args.preview_draw_regions,
        )
        if bool(args.preview_mjpeg)
        else PreviewOverlayConfig()
    )

    session = MediapipeTrackingSession(
        model_path=model_path,
        camera_index=args.camera,
        interval_sec=args.interval,
        mapping_config_path=mapping_path,
        save_mapping_path=save_mapping_path,
        calibrate_neutral=bool(args.calibrate_neutral),
        frame_width=int(args.width),
        frame_height=int(args.height),
        payload_mode=str(args.payload),
        camera_fps=float(args.camera_fps),
        fourcc=str(args.fourcc),
        buffer_size=int(args.buffer_size),
        camera_backend=str(args.camera_backend),
        preview_overlay=preview_overlay,
        source=str(args.source),
        video_path=str(args.video_path).strip() or None,
        playback_rate=float(args.playback_rate),
        video_mode=str(args.video_mode),
        tracking_mode=str(args.tracking_mode),
        roi_multiplier=float(args.roi_multiplier),
        video_start_ms=float(args.video_start_ms),
    )
    video_mode_note = (
        f" video_mode={args.video_mode}" if str(args.source) == "video" else ""
    )
    print(
        f"[mediapipe_tracking_server] source={args.source} payload={args.payload} "
        f"process_interval={args.interval}s broadcast_interval={args.broadcast_interval}s "
        f"loop_interval={session.get_loop_interval_sec():g}s "
        f"camera_fps={args.camera_fps} fourcc={args.fourcc!r} buffer={args.buffer_size} "
        f"backend={args.camera_backend}{video_mode_note}",
        flush=True,
    )
    if bool(args.preview_mjpeg) and preview_overlay.enabled:
        print(
            f"[mediapipe_tracking_server] preview overlay: style={preview_overlay.style} "
            f"landmarks={preview_overlay.draw_landmarks} mesh={preview_overlay.draw_mesh} "
            f"regions={preview_overlay.draw_regions}",
            flush=True,
        )
    preview_httpd: MjpegPreviewHttpServer | None = None
    preview_httpd = start_tracking_http_server(
        session,
        host=str(args.preview_host),
        port=int(args.preview_port),
        path=str(args.preview_path),
        fps=float(args.preview_fps),
        quality=int(args.preview_quality),
        mjpeg_enabled=bool(args.preview_mjpeg),
    )
    try:
        asyncio.run(
            run_server(
                host=args.host,
                port=args.port,
                ws_path=args.path,
                session=session,
                process_interval_sec=float(args.interval),
                broadcast_interval_sec=float(args.broadcast_interval),
            )
        )
    except KeyboardInterrupt:
        pass
    finally:
        stop_mjpeg_preview_server(preview_httpd)
        session.close()


if __name__ == "__main__":
    main()
