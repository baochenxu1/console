"""Phase 2.3 — ROI tracking：基于上一帧 fullFaceBox 裁剪放大后推理，landmark 映射回全帧坐标。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np


@dataclass(frozen=True)
class RoiRect:
    x: int
    y: int
    w: int
    h: int

    @property
    def width_px(self) -> int:
        return int(self.w)

    @property
    def height_px(self) -> int:
        return int(self.h)


class _RemappedLandmark:
    __slots__ = ("x", "y", "z", "visibility")

    def __init__(
        self,
        x: float,
        y: float,
        z: float | None = None,
        visibility: float | None = None,
    ) -> None:
        self.x = float(x)
        self.y = float(y)
        self.z = float(z) if z is not None else 0.0
        self.visibility = float(visibility) if visibility is not None else None


class _RemappedResult:
    """透传 blendshapes / matrix，仅替换 face_landmarks 为全帧坐标。"""

    def __init__(self, base: Any, face_landmarks: list[list[_RemappedLandmark]]) -> None:
        self._base = base
        self.face_landmarks = face_landmarks

    def __getattr__(self, name: str) -> Any:
        return getattr(self._base, name)


def normalize_tracking_mode(mode: str | None) -> str:
    m = str(mode or "full-frame").strip().lower()
    if m in ("stable-roi", "stable_roi", "stable"):
        return "stable-roi"
    if m in ("roi", "roi-tracking", "roi_tracking"):
        return "roi-tracking"
    return "full-frame"


def is_roi_tracking_mode(mode: str | None) -> bool:
    m = normalize_tracking_mode(mode)
    return m in ("roi-tracking", "stable-roi")


def normalize_roi_multiplier(value: float | int | str | None, default: float = 1.8) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        v = float(default)
    if v < 1.0:
        v = 1.0
    if v > 4.0:
        v = 4.0
    return round(v, 2)


def compute_roi_rect(
    full_face_box: dict[str, float],
    frame_width: int,
    frame_height: int,
    multiplier: float,
    *,
    min_px: int = 96,
) -> RoiRect:
    fw = max(1, int(frame_width))
    fh = max(1, int(frame_height))
    cx = float(full_face_box.get("centerX", 0.5))
    cy = float(full_face_box.get("centerY", 0.5))
    face_w = float(full_face_box.get("width", 0.1))
    face_h = float(full_face_box.get("height", 0.1))
    if "centerXPx" in full_face_box and "widthPx" in full_face_box:
        cx = float(full_face_box["centerXPx"]) / fw
        cy = float(full_face_box["centerYPx"]) / fh
        face_w = float(full_face_box["widthPx"]) / fw
        face_h = float(full_face_box["heightPx"]) / fh

    side_norm = max(face_w, face_h) * float(multiplier)
    side_px = max(int(min_px), int(round(side_norm * max(fw, fh))))
    cx_px = cx * fw
    cy_px = cy * fh
    x = int(round(cx_px - side_px / 2.0))
    y = int(round(cy_px - side_px / 2.0))
    x = max(0, min(x, fw - min_px))
    y = max(0, min(y, fh - min_px))
    w = min(side_px, fw - x)
    h = min(side_px, fh - y)
    w = max(min_px, w)
    h = max(min_px, h)
    if x + w > fw:
        x = max(0, fw - w)
    if y + h > fh:
        y = max(0, fh - h)
    return RoiRect(x=x, y=y, w=w, h=h)


def crop_bgr_frame(frame: np.ndarray, rect: RoiRect) -> np.ndarray:
    fh, fw = frame.shape[:2]
    x1 = max(0, min(rect.x, fw - 1))
    y1 = max(0, min(rect.y, fh - 1))
    x2 = max(x1 + 1, min(rect.x + rect.w, fw))
    y2 = max(y1 + 1, min(rect.y + rect.h, fh))
    return frame[y1:y2, x1:x2].copy()


def _landmark_xy(p: Any) -> tuple[float, float, float | None, float | None]:
    x = getattr(p, "x", None)
    y = getattr(p, "y", None)
    z = getattr(p, "z", None)
    vis = getattr(p, "visibility", None)
    if x is None and isinstance(p, dict):
        x = p.get("x")
        y = p.get("y")
        z = p.get("z")
        vis = p.get("visibility")
    return float(x), float(y), z, vis


def remap_result_landmarks_to_full(
    result: Any,
    roi_rect: RoiRect,
    frame_width: int,
    frame_height: int,
) -> Any:
    lm = getattr(result, "face_landmarks", None)
    if lm is None:
        return result
    faces = list(lm)
    if not faces:
        return result

    fw = max(1, int(frame_width))
    fh = max(1, int(frame_height))
    rx, ry, rw, rh = roi_rect.x, roi_rect.y, roi_rect.w, roi_rect.h

    remapped_faces: list[list[_RemappedLandmark]] = []
    for face in faces:
        pts = list(face)
        out_pts: list[_RemappedLandmark] = []
        for p in pts:
            xc, yc, zc, vis = _landmark_xy(p)
            x_full = (rx + xc * rw) / fw
            y_full = (ry + yc * rh) / fh
            out_pts.append(_RemappedLandmark(x_full, y_full, zc, vis))
        remapped_faces.append(out_pts)
    return _RemappedResult(result, remapped_faces)


def face_detected_in_result(result: Any) -> bool:
    lm = getattr(result, "face_landmarks", None)
    if lm is None:
        return False
    try:
        return len(list(lm)) > 0
    except TypeError:
        return bool(lm)


def build_face_scale_debug(
    *,
    frame_width: int,
    frame_height: int,
    full_face_box: dict[str, float] | None,
    roi_enabled: bool,
    roi_rect: RoiRect | None = None,
    roi_multiplier: float = 1.0,
    inference_path: str = "full",
    stable_roi_debug: dict[str, Any] | None = None,
) -> dict[str, float | bool | int | str]:
    fw = max(1, int(frame_width))
    fh = max(1, int(frame_height))
    face_w_px = 0.0
    face_h_px = 0.0
    if full_face_box:
        if "widthPx" in full_face_box and "heightPx" in full_face_box:
            face_w_px = float(full_face_box["widthPx"])
            face_h_px = float(full_face_box["heightPx"])
        else:
            face_w_px = float(full_face_box.get("width", 0.0)) * fw
            face_h_px = float(full_face_box.get("height", 0.0)) * fh
    coverage = (face_w_px * face_h_px) / float(fw * fh) if fw > 0 and fh > 0 else 0.0

    roi_x = int(roi_rect.x) if roi_rect is not None else 0
    roi_y = int(roi_rect.y) if roi_rect is not None else 0
    roi_w = int(roi_rect.w) if roi_rect is not None else fw
    roi_h = int(roi_rect.h) if roi_rect is not None else fh

    path = str(inference_path or "full").strip().lower()
    roi_inference = roi_enabled and roi_rect is not None and path in ("roi", "stable-roi")
    if roi_inference:
        inf_w, inf_h = roi_w, roi_h
        inf_face_w, inf_face_h = face_w_px, face_h_px
        inf_coverage = (face_w_px * face_h_px) / float(inf_w * inf_h) if inf_w > 0 and inf_h > 0 else 0.0
    else:
        inf_w, inf_h = fw, fh
        inf_face_w, inf_face_h = face_w_px, face_h_px
        inf_coverage = coverage

    out: dict[str, float | bool | int | str] = {
        "frameWidthPx": fw,
        "frameHeightPx": fh,
        "faceWidthPx": round(face_w_px, 2),
        "faceHeightPx": round(face_h_px, 2),
        "faceCoverageRatio": round(coverage, 6),
        "roiEnabled": bool(roi_enabled),
        "roiX": roi_x,
        "roiY": roi_y,
        "roiWidthPx": roi_w,
        "roiHeightPx": roi_h,
        "roiScale": round(float(roi_multiplier), 2) if roi_enabled else 1.0,
        "inferenceInputWidthPx": int(inf_w),
        "inferenceInputHeightPx": int(inf_h),
        "inferenceInputFaceWidthPx": round(inf_face_w, 2),
        "inferenceInputFaceHeightPx": round(inf_face_h, 2),
        "inferenceInputFaceCoverageRatio": round(inf_coverage, 6),
    }
    if roi_rect is not None:
        out["roiCenterXPx"] = round(roi_x + roi_w / 2.0, 2)
        out["roiCenterYPx"] = round(roi_y + roi_h / 2.0, 2)
    if stable_roi_debug and isinstance(stable_roi_debug, dict):
        for k in (
            "roiCenterXPx",
            "roiCenterYPx",
            "roiTargetCenterXPx",
            "roiTargetCenterYPx",
            "roiSmoothedCenterXPx",
            "roiSmoothedCenterYPx",
            "roiTargetWidthPx",
            "roiTargetHeightPx",
            "roiSmoothedWidthPx",
            "roiSmoothedHeightPx",
            "roiUpdateApplied",
            "roiUpdateReason",
            "roiClampCount",
        ):
            if k in stable_roi_debug:
                out[k] = stable_roi_debug[k]
    return out
