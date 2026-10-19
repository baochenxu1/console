"""Phase 3.1 — Tracking dataset export (streaming JSONL + optional gzip)."""

from __future__ import annotations

import gzip
import json
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, TextIO

_SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_DATASETS_DIR = _SCRIPT_DIR / "datasets"

ESTIMATED_RAW_BYTES_PER_FRAME = 2800


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _monotonic_ms() -> float:
    return round(time.monotonic() * 1000.0, 3)


def _new_session_id() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    return f"dataset_{stamp}"


def _resolve_compression(request: dict[str, Any]) -> str:
    raw = str(
        request.get("exportCompression")
        or request.get("compression")
        or "gzip"
    ).strip().lower()
    if raw in ("none", "off", "identity", "uncompressed"):
        return "none"
    return "gzip"


def _resolve_dataset_type(source_type: str, request_type: str | None) -> str:
    req = str(request_type or "").strip().lower()
    if req in (
        "teacher-video-tracking",
        "teacher-uploaded-video-tracking",
        "camera-tracking-reference",
    ):
        return req
    if source_type == "uploaded-video":
        return "teacher-uploaded-video-tracking"
    if source_type == "video":
        return "teacher-video-tracking"
    if source_type == "camera":
        return "camera-tracking-reference"
    return "teacher-video-tracking"


def _build_source_metadata(
    source_type: str,
    source_id: str | None,
    source_epoch: int,
    request: dict[str, Any],
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "sourceType": source_type,
        "sourceId": source_id,
        "sourceEpoch": int(source_epoch),
        "videoStartMs": float(request.get("videoStartMs") or 0),
        "playbackRate": float(request.get("playbackRate") or 1),
    }
    for key in (
        "videoPathLabel",
        "videoFileName",
        "videoSourceHash",
        "uploadedVideoId",
        "cameraId",
        "cameraIndex",
        "cameraLabel",
        "cameraWidth",
        "cameraHeight",
        "cameraFps",
    ):
        if request.get(key) is not None:
            out[key] = request.get(key)

    if source_type == "camera":
        sid = str(source_id or "")
        if sid.startswith("camera:index:") and out.get("cameraId") is None:
            out["cameraId"] = sid
        if out.get("cameraIndex") is None:
            idx = out.get("cameraId") or sid
            if isinstance(idx, str) and ":index:" in idx:
                try:
                    out["cameraIndex"] = int(idx.rsplit(":", 1)[-1])
                except ValueError:
                    pass
        if out.get("cameraLabel") is None and out.get("cameraIndex") is not None:
            out["cameraLabel"] = f"Camera {out['cameraIndex']}"

    if out.get("videoPathLabel"):
        return out

    sid = str(source_id or "")
    if source_type == "video" and sid.startswith("video:"):
        parts = sid.split(":")
        if len(parts) >= 4:
            out["videoFileName"] = parts[1]
            out["videoPathLabel"] = parts[1]
            out["videoSourceHash"] = parts[-1]
    elif source_type == "uploaded-video" and sid.startswith("uploaded-video:"):
        parts = sid.split(":")
        if len(parts) >= 3:
            out["uploadedVideoId"] = parts[1]
            out["videoFileName"] = parts[2]
            out["videoPathLabel"] = parts[2]
    return out


def _storage_estimate(compression: str) -> dict[str, Any]:
    frames_10min = 10 * 60 * 30
    raw_mb = round(frames_10min * ESTIMATED_RAW_BYTES_PER_FRAME / (1024 * 1024), 1)
    return {
        "estimatedRawBytesPerFrame": ESTIMATED_RAW_BYTES_PER_FRAME,
        "estimatedRawSizeFor10Min30FpsMB": raw_mb,
        "compression": compression if compression != "none" else "none",
    }


class _DatasetSession:
    def __init__(
        self,
        *,
        session_id: str,
        request: dict[str, Any],
        source_state: dict[str, Any],
        datasets_dir: Path,
    ) -> None:
        self.session_id = session_id
        self.request = dict(request or {})
        self.source_state = dict(source_state or {})
        self.datasets_dir = datasets_dir
        self.datasets_dir.mkdir(parents=True, exist_ok=True)
        self.created_at = _utc_now_iso()
        self.frame_count = 0
        self.bytes_written = 0
        self.first_video_time_ms: float | None = None
        self.last_video_time_ms: float | None = None
        self.first_timestamp_ms: float | None = None
        self.last_timestamp_ms: float | None = None
        self.compression = _resolve_compression(self.request)
        ext = ".frames.jsonl.gz" if self.compression == "gzip" else ".frames.jsonl"
        self.frames_path = self.datasets_dir / f"{session_id}{ext}"
        self.metadata_path = self.datasets_dir / f"{session_id}.metadata.json"
        self._file: TextIO
        if self.compression == "gzip":
            self._file = gzip.open(self.frames_path, "wt", encoding="utf-8")
        else:
            self._file = open(self.frames_path, "w", encoding="utf-8")
        self.source_type = str(self.source_state.get("sourceType") or "idle")
        self.source_epoch = int(self.source_state.get("sourceEpoch") or 0)
        self.dataset_type = _resolve_dataset_type(
            self.source_type,
            self.request.get("datasetType"),
        )

    def status_dict(self) -> dict[str, Any]:
        return {
            "recording": True,
            "sessionId": self.session_id,
            "frameCount": int(self.frame_count),
            "sourceType": self.source_type,
            "sourceEpoch": int(self.source_epoch),
            "datasetType": self.dataset_type,
            "createdAt": self.created_at,
            "exportCompression": self.compression,
            "framesPath": str(self.frames_path.relative_to(_SCRIPT_DIR)).replace("\\", "/"),
            "metadataPath": None,
        }

    def append_frame(self, frame: dict[str, Any]) -> None:
        if not isinstance(frame, dict):
            raise ValueError("frame must be object")
        sync = frame.get("sync") if isinstance(frame.get("sync"), dict) else {}
        sync = dict(sync)
        sync["appendServerReceiveTimeMs"] = _monotonic_ms()
        frame["sync"] = sync
        line = json.dumps(frame, ensure_ascii=False, separators=(",", ":"))
        self._file.write(line + "\n")
        self._file.flush()
        self.bytes_written += len(line.encode("utf-8")) + 1
        self.frame_count += 1
        src = frame.get("source") if isinstance(frame.get("source"), dict) else {}
        ts = src.get("timestampMs")
        vt = src.get("videoTimeMs")
        if ts is not None:
            tsv = float(ts)
            if self.first_timestamp_ms is None:
                self.first_timestamp_ms = tsv
            self.last_timestamp_ms = tsv
        if vt is not None:
            vtv = float(vt)
            if self.first_video_time_ms is None:
                self.first_video_time_ms = vtv
            self.last_video_time_ms = vtv

    def finalize(self, safety: dict[str, Any] | None = None) -> dict[str, Any]:
        self._file.close()
        frames_size_bytes = (
            int(self.frames_path.stat().st_size) if self.frames_path.is_file() else 0
        )
        duration_ms = None
        if (
            self.first_video_time_ms is not None
            and self.last_video_time_ms is not None
            and self.last_video_time_ms > self.first_video_time_ms
        ):
            duration_ms = self.last_video_time_ms - self.first_video_time_ms
        processed_fps = None
        if duration_ms and duration_ms > 0 and self.frame_count > 1:
            processed_fps = round(self.frame_count / (duration_ms / 1000.0), 2)

        preview_only = bool(self.source_state.get("previewOnlyForced"))
        safety_out = {
            "previewOnlyForced": preview_only,
            "realDeviceSendAllowed": False,
            "realSentFrameCount": 0,
            "realTxCount": 0,
            "realBusPacketCount": 0,
        }
        if isinstance(safety, dict):
            for k in safety_out:
                if k in safety and safety[k] is not None:
                    safety_out[k] = safety[k]

        source_id = self.source_state.get("sourceId")
        source_meta = _build_source_metadata(
            self.source_type,
            source_id,
            int(self.source_epoch),
            self.request,
        )
        for key in (
            "cameraId",
            "cameraIndex",
            "cameraLabel",
            "cameraWidth",
            "cameraHeight",
            "cameraFps",
        ):
            if self.source_state.get(key) is not None and source_meta.get(key) is None:
                source_meta[key] = self.source_state.get(key)
        compression = self.compression
        frame_schema: dict[str, Any] = {
            "format": "jsonl",
            "oneLinePerFrame": True,
            "chunked": False,
        }
        if compression == "gzip":
            frame_schema["compression"] = "gzip"

        metadata = {
            "schemaVersion": "tracking-dataset-v1",
            "sessionId": self.session_id,
            "createdAt": self.created_at,
            "stoppedAt": _utc_now_iso(),
            "datasetType": self.dataset_type,
            "exportCompression": compression,
            "source": source_meta,
            "safety": safety_out,
            "trackingConfig": {
                "videoSourceTuningEnabled": bool(
                    self.request.get("videoSourceTuningEnabled")
                ),
                "videoNeutralEnabled": bool(self.request.get("videoNeutralEnabled")),
                "roiEnabled": bool(self.request.get("roiEnabled")),
                "diagnosticExportMode": "dataset",
                "includeLandmarks": bool(self.request.get("includeLandmarks")),
                "includeBlendshapes": bool(self.request.get("includeBlendshapes", True)),
                "includeRawTrackingSignals": bool(
                    self.request.get("includeRawTrackingSignals", True)
                ),
                "includeTunedRig": bool(self.request.get("includeTunedRig", True)),
                "includePreviewCommand": bool(
                    self.request.get("includePreviewCommand", True)
                ),
            },
            "sampling": {
                "mode": str(self.request.get("samplingMode") or "source-fps"),
                "targetFps": float(self.request.get("targetFps") or 30),
                "frameDropStrategy": str(
                    self.request.get("frameDropStrategy") or "none"
                ),
            },
            "frameSchema": frame_schema,
            "syncSchema": {
                "timebase": "monotonic-ms",
                "primaryVideoAlignment": [
                    "source.sourceEpoch",
                    "source.sourceSeq",
                    "source.videoTimeMs",
                ],
                "crossModalAlignment": [
                    "sync.appendServerReceiveTimeMs",
                    "sync.sourceMonotonicTimeMs",
                    "sync.trackingCompleteTimeMs",
                ],
                "futurePairingFields": [
                    "deviceCommandTimeMs",
                    "cameraCaptureTimeMs",
                    "pairMethod",
                ],
            },
            "storageEstimate": _storage_estimate(compression),
            "summary": {
                "frameCount": int(self.frame_count),
                "videoTimeMsFirst": self.first_video_time_ms,
                "videoTimeMsLast": self.last_video_time_ms,
                "processedFpsFromVideoTime": processed_fps,
                "framesSizeBytes": frames_size_bytes,
                **(
                    {
                        "recordingWindowStartMs": float(
                            self.request["recordingWindowStartMs"]
                        ),
                        "recordingWindowEndMs": float(
                            self.request["recordingWindowEndMs"]
                        ),
                    }
                    if self.request.get("recordingWindowStartMs") is not None
                    and self.request.get("recordingWindowEndMs") is not None
                    else {}
                ),
            },
        }
        self.metadata_path.write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        rel_meta = str(self.metadata_path.relative_to(_SCRIPT_DIR)).replace("\\", "/")
        rel_frames = str(self.frames_path.relative_to(_SCRIPT_DIR)).replace("\\", "/")
        return {
            "ok": True,
            "sessionId": self.session_id,
            "frameCount": int(self.frame_count),
            "metadataPath": rel_meta,
            "framesPath": rel_frames,
            "framesSizeBytes": frames_size_bytes,
            "exportCompression": compression,
            "metadata": metadata,
        }


class TrackingDatasetRecorder:
    """Process-wide dataset session manager (thread-safe)."""

    _lock = threading.RLock()
    _active: _DatasetSession | None = None

    @classmethod
    def get_status(cls) -> dict[str, Any]:
        with cls._lock:
            if cls._active is None:
                return {"recording": False}
            return cls._active.status_dict()

    @classmethod
    def _resolve_frames_path(cls, root: Path, session_id: str) -> Path | None:
        gz = root / f"{session_id}.frames.jsonl.gz"
        if gz.is_file():
            return gz
        plain = root / f"{session_id}.frames.jsonl"
        if plain.is_file():
            return plain
        return None

    @classmethod
    def list_files(cls, datasets_dir: Path | None = None) -> list[dict[str, Any]]:
        root = datasets_dir or DEFAULT_DATASETS_DIR
        if not root.is_dir():
            return []
        out: list[dict[str, Any]] = []
        for meta in sorted(root.glob("dataset_*.metadata.json"), reverse=True):
            try:
                data = json.loads(meta.read_text(encoding="utf-8"))
            except Exception:
                continue
            sid = str(data.get("sessionId") or meta.stem.replace(".metadata", ""))
            frames = cls._resolve_frames_path(root, sid)
            compression = (data.get("frameSchema") or {}).get("compression") or data.get(
                "exportCompression"
            )
            out.append(
                {
                    "sessionId": sid,
                    "createdAt": data.get("createdAt"),
                    "datasetType": data.get("datasetType"),
                    "frameCount": (data.get("summary") or {}).get("frameCount"),
                    "exportCompression": compression,
                    "metadataPath": str(meta.relative_to(_SCRIPT_DIR)).replace("\\", "/"),
                    "framesPath": str(frames.relative_to(_SCRIPT_DIR)).replace("\\", "/")
                    if frames is not None
                    else None,
                }
            )
        return out

    @classmethod
    def resolve_download_path(
        cls, session_id: str, file_kind: str, datasets_dir: Path | None = None
    ) -> Path | None:
        root = datasets_dir or DEFAULT_DATASETS_DIR
        sid = str(session_id or "").strip()
        kind = str(file_kind or "").strip().lower()
        if not sid or ".." in sid or "/" in sid or "\\" in sid:
            return None
        if kind in ("metadata", "metadata.json"):
            path = root / f"{sid}.metadata.json"
        elif kind in ("frames", "frames.jsonl", "frames.jsonl.gz", "frames.gz"):
            path = cls._resolve_frames_path(root, sid)
            if path is None:
                return None
            return path.resolve()
        else:
            return None
        if not path.is_file():
            return None
        return path.resolve()

    @classmethod
    def start(
        cls,
        request: dict[str, Any],
        source_state: dict[str, Any],
        *,
        datasets_dir: Path | None = None,
    ) -> dict[str, Any]:
        with cls._lock:
            if cls._active is not None:
                return {"ok": False, "error": "dataset-already-recording"}
            source_type = str(source_state.get("sourceType") or "idle")
            if source_type == "idle":
                return {"ok": False, "error": "dataset-source-idle"}
            if source_state.get("status") == "error":
                return {"ok": False, "error": "dataset-source-error"}
            session_id = str(request.get("sessionId") or _new_session_id())
            cls._active = _DatasetSession(
                session_id=session_id,
                request=request,
                source_state=source_state,
                datasets_dir=datasets_dir or DEFAULT_DATASETS_DIR,
            )
            return {
                "ok": True,
                "sessionId": session_id,
                "datasetType": cls._active.dataset_type,
                "sourceType": source_type,
                "sourceEpoch": int(cls._active.source_epoch),
                "exportCompression": cls._active.compression,
            }

    @classmethod
    def append(cls, frame: dict[str, Any]) -> dict[str, Any]:
        with cls._lock:
            if cls._active is None:
                return {"ok": False, "error": "dataset-not-recording"}
            cls._active.append_frame(frame)
            return {"ok": True, "frameCount": int(cls._active.frame_count)}

    @classmethod
    def stop(cls, safety: dict[str, Any] | None = None) -> dict[str, Any]:
        with cls._lock:
            if cls._active is None:
                return {"ok": False, "error": "dataset-not-recording"}
            result = cls._active.finalize(safety)
            cls._active = None
            return result
