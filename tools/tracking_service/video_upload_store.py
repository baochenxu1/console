"""Phase 3.2 — Uploaded video storage, index, and probe."""

from __future__ import annotations

import json
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import cv2

_SCRIPT_DIR = Path(__file__).resolve().parent
UPLOADS_DIR = _SCRIPT_DIR / "uploads" / "videos"
INDEX_PATH = UPLOADS_DIR / "index.json"

MAX_FILE_SIZE_MB = 500
MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024
ALLOWED_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}

_LOCK = threading.RLock()
_INDEX: dict[str, Any] = {"videos": []}


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _new_upload_id() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    return f"upload_{stamp}"


def sanitize_filename(name: str) -> str:
    base = Path(str(name or "upload.mp4")).name
    base = re.sub(r"[^\w.\- ()\[\]]+", "_", base, flags=re.UNICODE)
    base = base.strip("._ ")
    if not base:
        base = "upload.mp4"
    if not Path(base).suffix:
        base = f"{base}.mp4"
    return base[:180]


def _ensure_dirs() -> None:
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)


def _load_index_unlocked() -> None:
    global _INDEX
    _ensure_dirs()
    if INDEX_PATH.is_file():
        try:
            data = json.loads(INDEX_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("videos"), list):
                _INDEX = data
                return
        except Exception:
            pass
    _INDEX = {"videos": []}


def _save_index_unlocked() -> None:
    _ensure_dirs()
    INDEX_PATH.write_text(
        json.dumps(_INDEX, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def rebuild_index_from_directory() -> list[dict[str, Any]]:
    """Scan uploads dir when index.json is missing or corrupt."""
    _ensure_dirs()
    videos: list[dict[str, Any]] = []
    for path in sorted(UPLOADS_DIR.glob("upload_*")):
        if not path.is_file():
            continue
        ext = path.suffix.lower()
        if ext not in ALLOWED_EXTENSIONS:
            continue
        stem = path.stem
        parts = stem.split("_", 2)
        uploaded_id = "_".join(parts[:2]) if len(parts) >= 2 else stem
        filename = parts[2] if len(parts) >= 3 else path.name
        meta = probe_video_file(path)
        if not meta:
            continue
        videos.append(
            {
                "uploadedVideoId": uploaded_id,
                "filename": filename,
                "storedFilename": path.name,
                "path": str(path.relative_to(_SCRIPT_DIR)).replace("\\", "/"),
                "createdAt": _utc_now_iso(),
                **meta,
            }
        )
    with _LOCK:
        _INDEX["videos"] = videos
        _save_index_unlocked()
    return [dict(v) for v in videos]


def load_index() -> list[dict[str, Any]]:
    with _LOCK:
        _load_index_unlocked()
        if not _INDEX.get("videos"):
            return rebuild_index_from_directory()
        return [dict(v) for v in _INDEX.get("videos", [])]


def probe_video_file(path: Path) -> dict[str, Any] | None:
    cap = cv2.VideoCapture(str(path.resolve()))
    if not cap.isOpened():
        return None
    try:
        fps = float(cap.get(cv2.CAP_PROP_FPS))
        if fps <= 1e-3:
            fps = 30.0
        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        duration_ms = float(frame_count * 1000.0 / fps) if frame_count > 0 else 0.0
        return {
            "durationMs": round(duration_ms, 2),
            "fps": round(fps, 2),
            "frameCount": int(frame_count),
            "width": int(width),
            "height": int(height),
            "fileSizeBytes": int(path.stat().st_size),
        }
    finally:
        cap.release()


def get_by_id(uploaded_video_id: str) -> dict[str, Any] | None:
    uid = str(uploaded_video_id or "").strip()
    if not uid or ".." in uid or "/" in uid or "\\" in uid:
        return None
    for entry in load_index():
        if entry.get("uploadedVideoId") == uid:
            return dict(entry)
    return None


def resolve_stored_path(entry: dict[str, Any]) -> Path | None:
    stored = entry.get("storedFilename")
    if not stored:
        return None
    name = Path(str(stored)).name
    if ".." in name or "/" in name or "\\" in name:
        return None
    path = (UPLOADS_DIR / name).resolve()
    if not str(path).startswith(str(UPLOADS_DIR.resolve())):
        return None
    if not path.is_file():
        return None
    return path


def public_video_dict(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "uploadedVideoId": entry.get("uploadedVideoId"),
        "filename": entry.get("filename"),
        "storedFilename": entry.get("storedFilename"),
        "durationMs": entry.get("durationMs"),
        "fps": entry.get("fps"),
        "frameCount": entry.get("frameCount"),
        "width": entry.get("width"),
        "height": entry.get("height"),
        "fileSizeBytes": entry.get("fileSizeBytes"),
        "createdAt": entry.get("createdAt"),
    }


def upload_video(file_bytes: bytes, original_filename: str) -> dict[str, Any]:
    if not file_bytes:
        return {"ok": False, "error": "empty-upload"}
    if len(file_bytes) > MAX_FILE_SIZE_BYTES:
        return {
            "ok": False,
            "error": "uploaded-video-too-large",
            "maxFileSizeMB": MAX_FILE_SIZE_MB,
        }
    safe_name = sanitize_filename(original_filename)
    ext = Path(safe_name).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        return {
            "ok": False,
            "error": "unsupported-video-format",
            "allowedExtensions": sorted(ALLOWED_EXTENSIONS),
        }

    _ensure_dirs()
    uploaded_id = _new_upload_id()
    stored_filename = f"{uploaded_id}_{safe_name}"
    stored_path = UPLOADS_DIR / stored_filename

    with _LOCK:
        stored_path.write_bytes(file_bytes)
        meta = probe_video_file(stored_path)
        if not meta:
            try:
                stored_path.unlink(missing_ok=True)
            except Exception:
                pass
            return {"ok": False, "error": "uploaded-video-open-failed"}

        entry = {
            "uploadedVideoId": uploaded_id,
            "filename": safe_name,
            "storedFilename": stored_filename,
            "path": str(stored_path.relative_to(_SCRIPT_DIR)).replace("\\", "/"),
            "createdAt": _utc_now_iso(),
            **meta,
        }
        _load_index_unlocked()
        videos = list(_INDEX.get("videos") or [])
        videos.append(entry)
        _INDEX["videos"] = videos
        _save_index_unlocked()

    return {"ok": True, "uploadedVideo": public_video_dict(entry)}


def delete_video(
    uploaded_video_id: str,
    *,
    current_source_id: str | None = None,
) -> dict[str, Any]:
    uid = str(uploaded_video_id or "").strip()
    if not uid:
        return {"ok": False, "error": "invalid-upload-id"}
    if current_source_id and f"uploaded-video:{uid}:" in str(current_source_id):
        return {"ok": False, "error": "uploaded-video-in-use"}

    with _LOCK:
        _load_index_unlocked()
        videos = list(_INDEX.get("videos") or [])
        target = None
        rest: list[dict[str, Any]] = []
        for v in videos:
            if v.get("uploadedVideoId") == uid:
                target = v
            else:
                rest.append(v)
        if target is None:
            return {"ok": False, "error": "uploaded-video-not-found"}

        path = resolve_stored_path(target)
        if path is not None:
            try:
                path.unlink(missing_ok=True)
            except Exception as exc:
                return {"ok": False, "error": str(exc)}

        _INDEX["videos"] = rest
        _save_index_unlocked()

    return {"ok": True, "deleted": True, "uploadedVideoId": uid}


def parse_multipart_file(content_type: str, body: bytes) -> tuple[str | None, bytes | None]:
    """Extract first file field from multipart/form-data."""
    if "multipart/form-data" not in (content_type or ""):
        return None, None
    boundary = None
    for part in content_type.split(";"):
        part = part.strip()
        if part.startswith("boundary="):
            boundary = part.split("=", 1)[1].strip().strip('"')
            break
    if not boundary:
        return None, None
    delim = ("--" + boundary).encode("utf-8")
    parts = body.split(delim)
    for chunk in parts:
        chunk = chunk.strip(b"\r\n")
        if not chunk or chunk == b"--":
            continue
        header_blob, _, data = chunk.partition(b"\r\n\r\n")
        if not data:
            continue
        data = data.rstrip(b"\r\n")
        headers = header_blob.decode("utf-8", errors="replace").split("\r\n")
        disp = next((h for h in headers if h.lower().startswith("content-disposition:")), "")
        if "filename=" not in disp.lower():
            continue
        filename = disp.split("filename=", 1)[1].strip().strip('"')
        return filename or None, data
    return None, None
