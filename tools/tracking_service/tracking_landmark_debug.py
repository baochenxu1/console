"""MediaPipe 关键点诊断：selected landmarks、feature box、full face box（Phase 2.0）。"""

from __future__ import annotations

import math
from typing import Any

from mediapipe_to_rig import extract_landmarks, get_landmark_xy

# MediaPipe Face Landmarker 478 点模型常用索引（与 preview minimal 集对齐）
FACE_LANDMARK_KEYS: dict[str, int] = {
    "noseTip": 1,
    "chin": 152,
    "leftEyeOuter": 33,
    "leftEyeInner": 133,
    "rightEyeInner": 362,
    "rightEyeOuter": 263,
    "leftBrowMid": 105,
    "rightBrowMid": 334,
    "leftMouthCorner": 61,
    "rightMouthCorner": 291,
    "upperLip": 13,
    "lowerLip": 14,
    "forehead": 10,
}


def _landmark_components(p: Any) -> tuple[float | None, float | None, float | None, float | None]:
    x = getattr(p, "x", None)
    y = getattr(p, "y", None)
    z = getattr(p, "z", None)
    vis = getattr(p, "visibility", None)
    if x is None and isinstance(p, dict):
        x = p.get("x")
        y = p.get("y")
        z = p.get("z")
        vis = p.get("visibility")
    try:
        xf = float(x) if x is not None else None
        yf = float(y) if y is not None else None
        zf = float(z) if z is not None else None
        vf = float(vis) if vis is not None else None
        return xf, yf, zf, vf
    except (TypeError, ValueError):
        return None, None, None, None


def landmark_point(
    landmarks: Any,
    index: int,
    frame_width: int,
    frame_height: int,
) -> dict[str, float] | None:
    """归一化 x/y + 源像素 px/py。"""
    try:
        if landmarks is None or index < 0:
            return None
        seq = list(landmarks)
        if index >= len(seq):
            return None
        p = seq[index]
        xf, yf, zf, vf = _landmark_components(p)
        if xf is None or yf is None:
            xy = get_landmark_xy(landmarks, index)
            if xy is None:
                return None
            xf, yf = xy
        fw = max(1, int(frame_width))
        fh = max(1, int(frame_height))
        out: dict[str, float] = {
            "x": float(xf),
            "y": float(yf),
            "px": float(xf * fw),
            "py": float(yf * fh),
        }
        if zf is not None and math.isfinite(zf):
            out["z"] = float(zf)
        if vf is not None and math.isfinite(vf):
            out["visibility"] = float(vf)
        return out
    except Exception:
        return None


def _bbox_from_normalized_bounds(
    min_x: float,
    max_x: float,
    min_y: float,
    max_y: float,
    frame_width: int,
    frame_height: int,
) -> dict[str, float]:
    fw = max(1, int(frame_width))
    fh = max(1, int(frame_height))
    width = max(1e-6, max_x - min_x)
    height = max(1e-6, max_y - min_y)
    cx = (min_x + max_x) / 2.0
    cy = (min_y + max_y) / 2.0
    return {
        "x": float(min_x),
        "y": float(min_y),
        "width": float(width),
        "height": float(height),
        "centerX": float(cx),
        "centerY": float(cy),
        "px": float(min_x * fw),
        "py": float(min_y * fh),
        "widthPx": float(width * fw),
        "heightPx": float(height * fh),
        "centerXPx": float(cx * fw),
        "centerYPx": float(cy * fh),
    }


def _full_face_bbox_from_landmarks(
    landmarks: Any,
    frame_width: int,
    frame_height: int,
) -> dict[str, float] | None:
    """基于全部 landmark 点的归一化外接框。"""
    xs: list[float] = []
    ys: list[float] = []
    try:
        seq = list(landmarks)
        for i in range(len(seq)):
            pt = landmark_point(landmarks, i, frame_width, frame_height)
            if pt is not None:
                xs.append(float(pt["x"]))
                ys.append(float(pt["y"]))
    except Exception:
        return None
    if not xs or not ys:
        return None
    return _bbox_from_normalized_bounds(min(xs), max(xs), min(ys), max(ys), frame_width, frame_height)


def _dist_px(a: dict[str, float] | None, b: dict[str, float] | None) -> float | None:
    if not a or not b:
        return None
    ax = float(a.get("px", a.get("x", 0.0)))
    ay = float(a.get("py", a.get("y", 0.0)))
    bx = float(b.get("px", b.get("x", 0.0)))
    by = float(b.get("py", b.get("y", 0.0)))
    return float(math.hypot(ax - bx, ay - by))


def _estimate_head_motion(landmarks: Any, fw: int, fh: int) -> dict[str, float] | None:
    l_outer = landmark_point(landmarks, 33, fw, fh)
    r_outer = landmark_point(landmarks, 263, fw, fh)
    nose = landmark_point(landmarks, 1, fw, fh)
    chin = landmark_point(landmarks, 152, fw, fh)
    if not l_outer or not r_outer or not nose or not chin:
        return None
    mouth_w = _dist_px(
        landmark_point(landmarks, 61, fw, fh),
        landmark_point(landmarks, 291, fw, fh),
    )
    mw = max(mouth_w or 1e-6, 1e-6)
    yaw = (_dist_px(nose, r_outer) or 0.0) - (_dist_px(nose, l_outer) or 0.0)
    yaw /= mw
    mouth_cy = (float(chin.get("py", 0)) + float(nose.get("py", 0))) / 2.0
    pitch = (float(chin.get("py", 0)) - mouth_cy) / mw
    roll = math.degrees(
        math.atan2(
            float(r_outer.get("py", 0)) - float(l_outer.get("py", 0)),
            float(r_outer.get("px", 0)) - float(l_outer.get("px", 0)),
        )
    )
    return {
        "yaw": float(yaw),
        "pitch": float(pitch),
        "roll": float(roll),
    }


def build_tracking_debug(
    result: Any,
    *,
    frame_width: int,
    frame_height: int,
    face_detected: bool,
    face_presence_confidence: float | None = None,
    preview_overlay: dict[str, Any] | None = None,
    face_scale: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """构建 debug.trackingDebug 块。"""
    fw = max(1, int(frame_width))
    fh = max(1, int(frame_height))
    landmarks = extract_landmarks(result) if face_detected else None

    selected: dict[str, dict[str, float]] = {}
    xs: list[float] = []
    ys: list[float] = []

    if landmarks is not None:
        for key, idx in FACE_LANDMARK_KEYS.items():
            pt = landmark_point(landmarks, idx, fw, fh)
            if pt is not None:
                selected[key] = pt
                xs.append(float(pt["x"]))
                ys.append(float(pt["y"]))

    selected_feature_box: dict[str, float] | None = None
    if xs and ys:
        selected_feature_box = _bbox_from_normalized_bounds(
            min(xs), max(xs), min(ys), max(ys), fw, fh
        )

    full_face_box: dict[str, float] | None = None
    if landmarks is not None:
        full_face_box = _full_face_bbox_from_landmarks(landmarks, fw, fh)

    face_size: dict[str, float] | None = None
    if selected:
        eye_dist = _dist_px(selected.get("leftEyeOuter"), selected.get("rightEyeOuter"))
        mouth_w = _dist_px(selected.get("leftMouthCorner"), selected.get("rightMouthCorner"))
        face_size = {}
        if eye_dist is not None:
            face_size["eyeDistancePx"] = float(eye_dist)
        if mouth_w is not None:
            face_size["mouthWidthPx"] = float(mouth_w)
        if selected_feature_box is not None:
            face_size["selectedFeatureBoxAreaRatio"] = float(
                selected_feature_box["width"] * selected_feature_box["height"]
            )
        if full_face_box is not None:
            face_size["fullFaceBoxAreaRatio"] = float(
                full_face_box["width"] * full_face_box["height"]
            )

    head_motion = _estimate_head_motion(landmarks, fw, fh) if landmarks is not None else None

    out: dict[str, Any] = {
        "faceDetected": bool(face_detected),
        "frameWidth": fw,
        "frameHeight": fh,
        "selectedLandmarks": selected,
    }
    if face_presence_confidence is not None:
        out["facePresenceConfidence"] = float(face_presence_confidence)
    if selected_feature_box is not None:
        out["selectedFeatureBox"] = selected_feature_box
        # 兼容旧 overlay / diagnostic 读取路径
        out["faceBox"] = selected_feature_box
    if full_face_box is not None:
        out["fullFaceBox"] = full_face_box
    if face_size:
        out["faceSize"] = face_size
    if face_scale and isinstance(face_scale, dict):
        out["faceScale"] = dict(face_scale)
    if head_motion is not None:
        out["headMotion"] = head_motion
    if preview_overlay and isinstance(preview_overlay, dict):
        out["previewOverlay"] = dict(preview_overlay)
    if landmarks is not None:
        dense: list[dict[str, float | int]] = []
        try:
            seq = list(landmarks)
            for i in range(len(seq)):
                pt = landmark_point(landmarks, i, fw, fh)
                if pt is not None:
                    dense.append({"i": int(i), "px": pt["px"], "py": pt["py"]})
        except Exception:
            dense = []
        if dense:
            out["allLandmarks"] = dense
    return out
