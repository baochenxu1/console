from __future__ import annotations

import math
from typing import Any

from mediapipe_mapping_config import _safe_float


def _sub(a: tuple[float, float, float], b: tuple[float, float, float]) -> tuple[float, float, float]:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _dot(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _norm(v: tuple[float, float, float]) -> float:
    return math.sqrt(max(1e-12, _dot(v, v)))


def _normalize(v: tuple[float, float, float]) -> tuple[float, float, float] | None:
    n = _norm(v)
    if n < 1e-9:
        return None
    return (v[0] / n, v[1] / n, v[2] / n)


def _read_point3(
    landmarks: Any,
    idx: int,
    get_landmark_xy,
) -> tuple[float, float, float] | None:
    try:
        p = landmarks[int(idx)]
    except Exception:
        p = None
    if p is not None and hasattr(p, "x") and hasattr(p, "y"):
        return (float(p.x), float(p.y), float(getattr(p, "z", 0.0)))
    xy = get_landmark_xy(landmarks, int(idx))
    if xy is None:
        return None
    return (float(xy[0]), float(xy[1]), 0.0)


def build_mouth_pose_frame(
    landmarks: Any,
    cfg: dict[str, Any],
    get_landmark_xy,
) -> dict[str, Any]:
    li = int(cfg.get("leftCornerIndex", 61))
    ri = int(cfg.get("rightCornerIndex", 291))
    ni = int(cfg.get("noseTipIndex", 1))
    ci = int(cfg.get("chinIndex", 152))
    l = _read_point3(landmarks, li, get_landmark_xy)
    r = _read_point3(landmarks, ri, get_landmark_xy)
    n = _read_point3(landmarks, ni, get_landmark_xy)
    c = _read_point3(landmarks, ci, get_landmark_xy)
    if l is None or r is None or n is None or c is None:
        return {"ok": False, "error": "key-landmarks-missing", "coordinateMode": "invalid", "mouthWidth": 0.0}

    use_3d = bool(cfg.get("use3dLocalCoordinate", True))
    coordinate_mode = "3d"
    if not use_3d:
        coordinate_mode = "2d_fallback"
        l, r, n, c = (l[0], l[1], 0.0), (r[0], r[1], 0.0), (n[0], n[1], 0.0), (c[0], c[1], 0.0)
    elif abs(l[2]) < 1e-6 and abs(r[2]) < 1e-6 and abs(n[2]) < 1e-6 and abs(c[2]) < 1e-6:
        coordinate_mode = "2d_fallback"

    mouth_center = ((l[0] + r[0]) * 0.5, (l[1] + r[1]) * 0.5, (l[2] + r[2]) * 0.5)
    x_axis = _normalize(_sub(r, l))
    if x_axis is None:
        return {"ok": False, "error": "x-axis-invalid", "coordinateMode": coordinate_mode, "mouthWidth": 0.0}

    face_down = _normalize(_sub(c, n))
    if face_down is None:
        return {"ok": False, "error": "face-down-invalid", "coordinateMode": coordinate_mode, "mouthWidth": 0.0}
    proj = _dot(face_down, x_axis)
    y_raw = (
        face_down[0] - proj * x_axis[0],
        face_down[1] - proj * x_axis[1],
        face_down[2] - proj * x_axis[2],
    )
    y_axis = _normalize(y_raw)
    if y_axis is None:
        return {"ok": False, "error": "y-axis-invalid", "coordinateMode": coordinate_mode, "mouthWidth": 0.0}
    if _dot(y_axis, _sub(c, mouth_center)) < 0:
        y_axis = (-y_axis[0], -y_axis[1], -y_axis[2])
    y_axis_toward_chin = _dot(y_axis, _sub(c, mouth_center)) > 0

    mouth_width = _norm(_sub(r, l))
    min_w = max(1e-6, _safe_float(cfg.get("minMouthWidth"), 0.03))
    if mouth_width < min_w:
        return {
            "ok": False,
            "error": "mouth-width-too-small",
            "coordinateMode": coordinate_mode,
            "mouthWidth": float(mouth_width),
            "yAxisTowardChin": bool(y_axis_toward_chin),
        }

    def project_y(point: tuple[float, float, float]) -> float:
        return _dot(_sub(point, mouth_center), y_axis) / max(1e-6, mouth_width)

    yaw_proxy = (_norm(_sub(n, r)) - _norm(_sub(n, l))) / max(1e-6, mouth_width)
    pitch_proxy = _norm(_sub(c, mouth_center)) / max(1e-6, mouth_width)
    roll_deg = math.degrees(math.atan2(r[1] - l[1], r[0] - l[0]))
    pose = {
        "rollDeg": float(roll_deg),
        "yawProxy": float(yaw_proxy),
        "pitchProxy": float(pitch_proxy),
        "faceScale": float(mouth_width),
    }
    return {
        "ok": True,
        "coordinateMode": coordinate_mode,
        "mouthCenter": mouth_center,
        "mouthWidth": float(mouth_width),
        "xAxis": x_axis,
        "yAxis": y_axis,
        "projectY": project_y,
        "pose": pose,
        "yAxisTowardChin": bool(y_axis_toward_chin),
        "error": "",
    }


def evaluate_mouth_pose_gate(
    current_pose: dict[str, Any],
    neutral_pose: dict[str, Any],
    cfg: dict[str, Any],
) -> dict[str, Any]:
    yaw_delta = abs(_safe_float(current_pose.get("yawProxy"), 0.0) - _safe_float(neutral_pose.get("yawProxy"), 0.0))
    pitch_delta = abs(_safe_float(current_pose.get("pitchProxy"), 0.0) - _safe_float(neutral_pose.get("pitchProxy"), 0.0))
    roll_delta = abs(_safe_float(current_pose.get("rollDeg"), 0.0) - _safe_float(neutral_pose.get("rollDeg"), 0.0))
    ns = max(1e-6, _safe_float(neutral_pose.get("faceScale"), 1.0))
    scale_delta = abs(_safe_float(current_pose.get("faceScale"), ns) - ns) / ns

    reasons: list[str] = []
    if yaw_delta > _safe_float(cfg.get("maxYawProxyDelta"), 0.10):
        reasons.append("yaw")
    if pitch_delta > _safe_float(cfg.get("maxPitchProxyDelta"), 0.10):
        reasons.append("pitch")
    if roll_delta > _safe_float(cfg.get("maxRollDeltaDeg"), 12.0):
        reasons.append("roll")
    if scale_delta > _safe_float(cfg.get("maxFaceScaleDelta"), 0.18):
        reasons.append("scale")

    active = bool(cfg.get("poseGateEnabled", True)) and bool(reasons)
    return {
        "active": active,
        "reasons": reasons,
        "yawDelta": float(yaw_delta),
        "pitchDelta": float(pitch_delta),
        "rollDelta": float(roll_delta),
        "scaleDelta": float(scale_delta),
        "poseMotionSuppressScale": float(_safe_float(cfg.get("poseMotionSuppressScale"), 0.25)),
    }
