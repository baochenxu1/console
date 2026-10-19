"""Phase 3.2B — Camera device scan, test, preferred selection."""

from __future__ import annotations

import json
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import cv2

_SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_DIR = _SCRIPT_DIR / "config"
DEFAULT_CONFIG_PATH = CONFIG_DIR / "camera_preferences.json"

_LOCK = threading.RLock()
_MANAGER: "CameraDeviceManager | None" = None


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def make_camera_id(camera_index: int) -> str:
    return f"camera:index:{int(camera_index)}"


def parse_camera_id(camera_id: str | None) -> int | None:
    raw = str(camera_id or "").strip()
    if raw.startswith("camera:index:"):
        try:
            return int(raw.rsplit(":", 1)[-1])
        except ValueError:
            return None
    if raw.startswith("camera:"):
        tail = raw.split(":", 1)[-1]
        try:
            return int(tail)
        except ValueError:
            return None
    return None


def make_camera_label(camera_index: int) -> str:
    return f"Camera {int(camera_index)}"


def _open_camera(camera_index: int, backend: str = "auto") -> tuple[Any, str]:
    """Open camera; on Windows try DSHOW then MSMF when auto."""
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


def _read_camera_props(cap: Any) -> tuple[int, int, float]:
    try:
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = float(cap.get(cv2.CAP_PROP_FPS))
    except Exception:
        width = height = 0
        fps = 0.0
    if width <= 0:
        width = 640
    if height <= 0:
        height = 480
    if fps <= 1e-3:
        fps = 30.0
    return width, height, fps


class CameraDeviceManager:
    """Scan OpenCV indices, resolve cameraId, persist preferred camera."""

    def __init__(
        self,
        config_path: Path | str | None = None,
        *,
        open_camera_fn: Callable[..., tuple[Any, str]] | None = None,
        camera_backend: str = "auto",
    ) -> None:
        self.config_path = Path(config_path or DEFAULT_CONFIG_PATH)
        self._open_camera_fn = open_camera_fn or _open_camera
        self._camera_backend = str(camera_backend or "auto")
        self.cameras: list[dict[str, Any]] = []
        self.preferred_camera_id: str | None = None
        self._load_preferences_unlocked()

    def _load_preferences_unlocked(self) -> None:
        self.preferred_camera_id = None
        if not self.config_path.is_file():
            return
        try:
            data = json.loads(self.config_path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                pid = str(data.get("preferredCameraId") or "").strip()
                if pid:
                    self.preferred_camera_id = pid
        except Exception:
            pass

    def load_preferred_camera(self) -> str | None:
        with _LOCK:
            self._load_preferences_unlocked()
            return self.preferred_camera_id

    def _ensure_config_dir(self) -> None:
        self.config_path.parent.mkdir(parents=True, exist_ok=True)

    def save_preferred_camera(self, camera_id: str) -> dict[str, Any]:
        cid = str(camera_id or "").strip()
        if not cid:
            return {"ok": False, "error": "missing-camera-id"}
        idx = parse_camera_id(cid)
        if idx is None:
            return {"ok": False, "error": "invalid-camera-id", "cameraId": cid}

        cameras = self.get_cameras()
        cam = next((c for c in cameras if c.get("cameraId") == cid), None)
        label = str(cam.get("label") if cam else make_camera_label(idx))
        width = int(cam.get("width") if cam else 640)
        height = int(cam.get("height") if cam else 480)
        fps = float(cam.get("fps") if cam else 30.0)

        payload = {
            "preferredCameraId": cid,
            "preferredCameraLabel": label,
            "preferredResolution": {"width": width, "height": height, "fps": fps},
            "updatedAt": _utc_now_iso(),
        }
        with _LOCK:
            self._ensure_config_dir()
            self.config_path.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            self.preferred_camera_id = cid
            for c in self.cameras:
                c["isPreferred"] = c.get("cameraId") == cid
        return {"ok": True, "preferredCameraId": cid}

    def scan_cameras(self, max_index: int = 8) -> list[dict[str, Any]]:
        preferred = self.load_preferred_camera()
        found: list[dict[str, Any]] = []
        for index in range(max(0, int(max_index)) + 1):
            info = self._probe_index(index)
            if info is not None:
                info["isPreferred"] = info.get("cameraId") == preferred
                found.append(info)
        with _LOCK:
            self.cameras = found
        return [dict(c) for c in found]

    def get_cameras(self) -> list[dict[str, Any]]:
        with _LOCK:
            if not self.cameras:
                self.scan_cameras()
            preferred = self.preferred_camera_id or self.load_preferred_camera()
            out = []
            for c in self.cameras:
                row = dict(c)
                row["isPreferred"] = row.get("cameraId") == preferred
                out.append(row)
            return out

    def list_response(self) -> dict[str, Any]:
        cameras = self.get_cameras()
        preferred = self.load_preferred_camera()
        return {
            "ok": True,
            "preferredCameraId": preferred,
            "cameras": cameras,
        }

    def _probe_index(self, index: int) -> dict[str, Any] | None:
        cap = None
        try:
            cap, _backend = self._open_camera_fn(index, self._camera_backend)
            if cap is None or not cap.isOpened():
                return None
            ok, _frame = cap.read()
            if not ok:
                return None
            width, height, fps = _read_camera_props(cap)
            cid = make_camera_id(index)
            return {
                "cameraId": cid,
                "cameraIndex": int(index),
                "label": make_camera_label(index),
                "backend": "opencv",
                "available": True,
                "width": width,
                "height": height,
                "fps": round(fps, 2),
                "isPreferred": False,
            }
        except Exception:
            return None
        finally:
            if cap is not None:
                try:
                    cap.release()
                except Exception:
                    pass

    def resolve_camera(
        self,
        camera_id: str | None = None,
        camera_index: int | None = None,
    ) -> dict[str, Any]:
        """Resolve cameraId / cameraIndex / preferred / first available."""
        cameras = self.get_cameras()
        available = [c for c in cameras if c.get("available")]

        if camera_id:
            cid = str(camera_id).strip()
            for c in cameras:
                if c.get("cameraId") == cid:
                    if c.get("available"):
                        return dict(c)
                    test = self.test_camera(camera_id=cid)
                    if test.get("ok") and test.get("opened"):
                        return {
                            **c,
                            "width": test.get("width", c.get("width")),
                            "height": test.get("height", c.get("height")),
                            "fps": test.get("fps", c.get("fps")),
                            "available": True,
                        }
            raise ValueError("camera-not-found")

        if camera_index is not None:
            return self.resolve_camera(camera_id=make_camera_id(int(camera_index)))

        preferred = self.load_preferred_camera()
        if preferred:
            for c in available:
                if c.get("cameraId") == preferred:
                    return dict(c)

        if available:
            return dict(available[0])

        raise ValueError("camera-not-found")

    def test_camera(
        self,
        camera_id: str | None = None,
        camera_index: int | None = None,
    ) -> dict[str, Any]:
        idx = parse_camera_id(camera_id) if camera_id else None
        if idx is None and camera_index is not None:
            idx = int(camera_index)
        if idx is None:
            return {"ok": False, "error": "missing-camera-id"}

        cid = make_camera_id(idx)
        cap = None
        try:
            cap, _backend = self._open_camera_fn(idx, self._camera_backend)
            if cap is None or not cap.isOpened():
                return {
                    "ok": False,
                    "error": "camera-open-failed",
                    "cameraId": cid,
                    "cameraIndex": idx,
                    "opened": False,
                    "frameRead": False,
                }
            ok, _frame = cap.read()
            width, height, fps = _read_camera_props(cap)
            if not ok:
                return {
                    "ok": False,
                    "error": "camera-frame-read-failed",
                    "cameraId": cid,
                    "cameraIndex": idx,
                    "opened": True,
                    "frameRead": False,
                }
            return {
                "ok": True,
                "cameraId": cid,
                "cameraIndex": idx,
                "opened": True,
                "frameRead": True,
                "width": width,
                "height": height,
                "fps": round(fps, 2),
            }
        except Exception:
            return {
                "ok": False,
                "error": "camera-open-failed",
                "cameraId": cid,
                "cameraIndex": idx,
                "opened": False,
                "frameRead": False,
            }
        finally:
            if cap is not None:
                try:
                    cap.release()
                except Exception:
                    pass


def get_camera_device_manager(
    *,
    open_camera_fn: Callable[..., tuple[Any, str]] | None = None,
    camera_backend: str = "auto",
) -> CameraDeviceManager:
    global _MANAGER
    with _LOCK:
        if _MANAGER is None:
            _MANAGER = CameraDeviceManager(
                open_camera_fn=open_camera_fn,
                camera_backend=camera_backend,
            )
        return _MANAGER
