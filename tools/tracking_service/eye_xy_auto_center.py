"""Camera 启动后自动采集 gaze neutral（按 cameraId + 分辨率 + flip 持久化）。"""

from __future__ import annotations

import json
import statistics
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_DIR = _SCRIPT_DIR / "config"
DEFAULT_STORE_PATH = CONFIG_DIR / "eye_xy_neutral.json"

NEUTRAL_STORE_SCHEMA_VERSION = "2.0.0"
GAZE_ESTIMATOR_VERSION = "safe-center-v1"

_LOCK = threading.RLock()


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def make_eye_xy_storage_key(
    camera_id: str,
    width: int,
    height: int,
    flip_horizontal: bool,
) -> str:
    cid = str(camera_id or "camera:unknown").strip()
    w = max(0, int(width))
    h = max(0, int(height))
    flip = 1 if bool(flip_horizontal) else 0
    return f"{cid}|{w}x{h}|flip:{flip}"


class EyeXyNeutralStore:
    def __init__(self, path: Path | None = None) -> None:
        self._path = path or DEFAULT_STORE_PATH

    def load_entry(self, key: str) -> dict[str, Any] | None:
        with _LOCK:
            data = self._read_all()
            ent = data.get("entries", {}).get(key)
            if not isinstance(ent, dict):
                return None
            if not self._entry_version_ok(ent):
                return None
            return dict(ent)

    def load_entry_raw(self, key: str) -> dict[str, Any] | None:
        with _LOCK:
            data = self._read_all()
            ent = data.get("entries", {}).get(key)
            return dict(ent) if isinstance(ent, dict) else None

    def delete_entry(self, key: str) -> None:
        with _LOCK:
            data = self._read_all()
            entries = data.get("entries", {})
            if key in entries:
                del entries[key]
                self._write_all(data)

    @staticmethod
    def _entry_version_ok(ent: dict[str, Any]) -> bool:
        return (
            str(ent.get("schemaVersion") or "") == NEUTRAL_STORE_SCHEMA_VERSION
            and str(ent.get("estimatorVersion") or "") == GAZE_ESTIMATOR_VERSION
        )

    def save_entry(self, key: str, entry: dict[str, Any]) -> None:
        with _LOCK:
            data = self._read_all()
            entries = data.setdefault("entries", {})
            entries[key] = {
                **entry,
                "storageKey": key,
                "schemaVersion": NEUTRAL_STORE_SCHEMA_VERSION,
                "estimatorVersion": GAZE_ESTIMATOR_VERSION,
                "updatedAt": _utc_now_iso(),
            }
            data["schemaVersion"] = NEUTRAL_STORE_SCHEMA_VERSION
            data["estimatorVersion"] = GAZE_ESTIMATOR_VERSION
            self._write_all(data)

    def _read_all(self) -> dict[str, Any]:
        if not self._path.is_file():
            return {
                "schemaVersion": NEUTRAL_STORE_SCHEMA_VERSION,
                "estimatorVersion": GAZE_ESTIMATOR_VERSION,
                "entries": {},
            }
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                raw.setdefault("entries", {})
                return raw
        except Exception:
            pass
        return {
            "schemaVersion": NEUTRAL_STORE_SCHEMA_VERSION,
            "estimatorVersion": GAZE_ESTIMATOR_VERSION,
            "entries": {},
        }

    def _write_all(self, data: dict[str, Any]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )


def _median(values: list[float]) -> float:
    if not values:
        return 0.0
    return float(statistics.median(values))


class EyeXyAutoCenterCollector:
    """camera source 启动后采集 30～60 帧可靠 gaze，中位数写入 autoNeutral。"""

    def __init__(self, store: EyeXyNeutralStore | None = None) -> None:
        self._store = store or EyeXyNeutralStore()
        self._active = False
        self._ready = False
        self._collecting = False
        self._loaded_from_store = False
        self._key: str | None = None
        self._camera_meta: dict[str, Any] = {}
        self._samples_x: list[float] = []
        self._samples_y: list[float] = []
        self._attempt_frames = 0
        self._prev_nose: tuple[float, float] | None = None
        self._prev_face_center: tuple[float, float] | None = None
        self._auto_neutral_x = 0.0
        self._auto_neutral_y = 0.0
        self._min_frames = 30
        self._max_frames = 60
        self._blink_thr = 0.35
        self._max_nose_motion = 0.012
        self._max_face_motion = 0.025
        self._raw_x_max = 0.12
        self._raw_y_max = 0.75
        self._cache_invalidated = False
        self._invalidate_reason = ""
        self._session_locked = False

    def configure_from_gaze_cfg(self, gaze_cfg: dict[str, Any] | None) -> None:
        gz = gaze_cfg if isinstance(gaze_cfg, dict) else {}
        self._min_frames = max(1, int(float(gz.get("autoEyeCenterMinFrames", 30))))
        self._max_frames = max(self._min_frames, int(float(gz.get("autoEyeCenterMaxFrames", 60))))
        self._blink_thr = float(gz.get("autoEyeCenterBlinkThreshold", 0.35))
        self._max_nose_motion = float(gz.get("autoEyeCenterMaxNoseMotion", 0.012))
        self._max_face_motion = float(gz.get("autoEyeCenterMaxFaceBoxMotion", 0.025))
        self._raw_x_max = float(gz.get("autoEyeCenterRawXMax", 0.12))
        self._raw_y_max = float(gz.get("autoEyeCenterRawYMax", 0.75))

    def reset(self) -> None:
        self._active = False
        self._ready = False
        self._collecting = False
        self._loaded_from_store = False
        self._key = None
        self._camera_meta = {}
        self._samples_x.clear()
        self._samples_y.clear()
        self._attempt_frames = 0
        self._prev_nose = None
        self._prev_face_center = None
        self._auto_neutral_x = 0.0
        self._auto_neutral_y = 0.0
        self._cache_invalidated = False
        self._invalidate_reason = ""
        self._session_locked = False

    def is_session_locked(self) -> bool:
        return bool(self._session_locked)

    def _lock_session_if_ready(self) -> None:
        if self._ready and (
            self._loaded_from_store
            or len(self._samples_x) >= self._min_frames
        ):
            self._session_locked = True
            self._collecting = False
            self._active = False
            self._cache_invalidated = False
            self._invalidate_reason = ""

    def begin_camera(
        self,
        *,
        camera_id: str,
        width: int,
        height: int,
        flip_horizontal: bool,
        gaze_cfg: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """camera 源切换时调用；若已有持久化 neutral 则直接 ready。"""
        self.reset()
        self.configure_from_gaze_cfg(gaze_cfg)
        if gaze_cfg is not None and not bool(gaze_cfg.get("autoEyeCenterEnabled", True)):
            return self.status_dict()

        key = make_eye_xy_storage_key(camera_id, width, height, flip_horizontal)
        self._key = key
        self._camera_meta = {
            "cameraId": str(camera_id),
            "width": int(width),
            "height": int(height),
            "flipHorizontal": bool(flip_horizontal),
        }
        self._active = True

        loaded = self._store.load_entry(key)
        if loaded is not None:
            self._auto_neutral_x = float(loaded.get("eyeLookX", 0.0))
            self._auto_neutral_y = float(loaded.get("eyeLookY", 0.0))
            self._ready = True
            self._loaded_from_store = True
            self._active = False
            self._cache_invalidated = False
            self._lock_session_if_ready()
            return self.status_dict()

        # 旧版缓存或版本不匹配：丢弃并重新采集
        stale = self._store.load_entry_raw(key)
        if stale is not None:
            self._store.delete_entry(key)
            self._cache_invalidated = True
            self._invalidate_reason = "version_mismatch"

        self._collecting = True
        return self.status_dict()

    def force_recollection(self, reason: str = "x_neutral_invalid") -> None:
        """丢弃当前 neutral 并重新采集；session locked 时禁止。"""
        if self._session_locked:
            return
        if self._key:
            self._store.delete_entry(self._key)
        self._ready = False
        self._loaded_from_store = False
        self._collecting = True
        self._active = True
        self._samples_x.clear()
        self._samples_y.clear()
        self._attempt_frames = 0
        self._prev_nose = None
        self._prev_face_center = None
        self._auto_neutral_x = 0.0
        self._auto_neutral_y = 0.0
        self._cache_invalidated = True
        self._invalidate_reason = str(reason or "forced")

    def apply_to_config(self, config: dict[str, Any]) -> bool:
        if not self._ready:
            return False
        neutral = config.setdefault("neutral", {})
        neutral["eyeLookX"] = float(self._auto_neutral_x)
        neutral["eyeLookY"] = float(self._auto_neutral_y)
        return True

    def _motion_ok(
        self,
        nose_xy: tuple[float, float] | None,
        face_center: tuple[float, float] | None,
    ) -> bool:
        ok = True
        if nose_xy is not None and self._prev_nose is not None:
            dx = nose_xy[0] - self._prev_nose[0]
            dy = nose_xy[1] - self._prev_nose[1]
            if (dx * dx + dy * dy) ** 0.5 > self._max_nose_motion:
                ok = False
        if face_center is not None and self._prev_face_center is not None:
            dx = face_center[0] - self._prev_face_center[0]
            dy = face_center[1] - self._prev_face_center[1]
            if (dx * dx + dy * dy) ** 0.5 > self._max_face_motion:
                ok = False
        if nose_xy is not None:
            self._prev_nose = nose_xy
        if face_center is not None:
            self._prev_face_center = face_center
        return ok

    def maybe_collect(
        self,
        *,
        face_detected: bool,
        gaze: dict[str, Any],
        blink_left: float,
        blink_right: float,
        nose_xy: tuple[float, float] | None = None,
        face_center: tuple[float, float] | None = None,
    ) -> dict[str, Any]:
        if self._session_locked:
            return self.status_dict()
        if not self._active or self._ready:
            return self.status_dict()

        self._attempt_frames += 1
        if self._attempt_frames > self._max_frames and len(self._samples_x) < self._min_frames:
            self._active = False
            self._collecting = False
            self._ready = False
            self._invalidate_reason = "insufficient_neutral_samples"
            return self.status_dict()

        if not face_detected:
            return self.status_dict()
        if bool(gaze.get("safeCenterActive")):
            return self.status_dict()
        if not bool(gaze.get("available")):
            return self.status_dict()
        rel = float(gaze.get("reliabilityScore", 0.0) or 0.0)
        if rel < 0.45 and not bool(gaze.get("irisReliable")):
            return self.status_dict()
        if float(blink_left) >= self._blink_thr or float(blink_right) >= self._blink_thr:
            return self.status_dict()
        if not self._motion_ok(nose_xy, face_center):
            return self.status_dict()
        if bool(gaze.get("verticalRawClipped")):
            return self.status_dict()

        raw_x = gaze.get("rawPrimaryX", gaze.get("eyeLookX"))
        raw_y = gaze.get("eyeLookY", gaze.get("rawStableY", gaze.get("rawPrimaryY")))
        if not isinstance(raw_x, (int, float)) or not isinstance(raw_y, (int, float)):
            return self.status_dict()
        if abs(float(raw_x)) > self._raw_x_max or abs(float(raw_y)) > self._raw_y_max:
            return self.status_dict()

        self._samples_x.append(float(raw_x))
        self._samples_y.append(float(raw_y))

        if len(self._samples_x) >= self._min_frames:
            self._finalize()
        return self.status_dict()

    def _finalize(self) -> None:
        if not self._samples_x or len(self._samples_x) < self._min_frames:
            self._active = False
            self._collecting = False
            self._ready = False
            return
        self._auto_neutral_x = _median(self._samples_x)
        self._auto_neutral_y = _median(self._samples_y)
        self._ready = True
        self._active = False
        self._collecting = False
        self._cache_invalidated = False
        self._invalidate_reason = ""
        self._lock_session_if_ready()
        if self._key:
            self._store.save_entry(
                self._key,
                {
                    **self._camera_meta,
                    "eyeLookX": self._auto_neutral_x,
                    "eyeLookY": self._auto_neutral_y,
                    "sampleCount": len(self._samples_x),
                },
            )

    def status_dict(self) -> dict[str, Any]:
        locked = bool(self._session_locked)
        return {
            "mode": "auto",
            "ready": bool(self._ready or locked),
            "collecting": False if locked else bool(self._collecting),
            "sessionLocked": locked,
            "loadedFromStore": bool(self._loaded_from_store),
            "sampleCount": len(self._samples_x),
            "attemptFrames": int(self._attempt_frames),
            "minFrames": int(self._min_frames),
            "maxFrames": int(self._max_frames),
            "autoNeutralX": float(self._auto_neutral_x),
            "autoNeutralY": float(self._auto_neutral_y),
            "storageKey": self._key,
            "schemaVersion": NEUTRAL_STORE_SCHEMA_VERSION,
            "estimatorVersion": GAZE_ESTIMATOR_VERSION,
            "cacheInvalidated": False if locked else bool(self._cache_invalidated and not self._ready),
            "cacheInvalidateReason": "" if locked else str(self._invalidate_reason or ""),
        }
