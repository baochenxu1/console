"""
Jaw Geometry V3: pose-aware, lip-decoupled jaw channel.
"""

from __future__ import annotations

import math
import time
from typing import Any

from mediapipe_mapping_config import _safe_float, clamp
from mouth_pose_frame import build_mouth_pose_frame, evaluate_mouth_pose_gate

_DEFAULT_JAW_GEOMETRY: dict[str, Any] = {
    "enabled": True,
    "neutralFrames": 30,
    "neutralWarmupFrames": 8,
    "minMouthWidth": 0.03,
    "neutralTrackMinQuality": 0.5,
    "neutralMaxJawBlend": 8.0,
    "neutralMaxSmile": 12.0,
    "neutralMaxSideOffset": 10.0,
    "jawOutputSign": -1.0,
    "use3dLocalCoordinate": True,
    "useChinAsPrimary": False,
    "chinWeight": 0.0,
    "apertureGain": 920.0,
    "lowerInnerGain": 520.0,
    "lowerLipCenterGain": 280.0,
    "blendshapeMix": 0.08,
    "apertureWeight": 0.50,
    "lowerInnerWeight": 0.35,
    "lowerLipCenterWeight": 0.15,
    "upperLipOpenCompensation": 0.55,
    "poseGateEnabled": True,
    "maxYawProxyDelta": 0.10,
    "maxPitchProxyDelta": 0.10,
    "maxRollDeltaDeg": 12.0,
    "maxFaceScaleDelta": 0.18,
    "poseMotionSuppressScale": 0.25,
    "deadzone": 2.0,
    "snapToZero": 2.0,
    "outputHoldDeadband": 1.4,
    "outputReleaseThreshold": 2.6,
    "alphaSlow": 0.30,
    "alphaFast": 0.96,
    "fastDelta": 5.0,
    "maxStepPerFrame": 22.0,
    "curveDeadzoneInput": 2.0,
    "inputDeadzone": 2.0,
    "smallEnd": 18.0,
    "midEnd": 60.0,
    "largeEnd": 110.0,
    "smallOutput": 12.0,
    "midOutput": 65.0,
    "maxOutput": 105.0,
    "curvePowerSmall": 1.15,
    "curvePowerMid": 1.45,
    "curvePowerLarge": 1.1,
    "curveSmallKneeInput": 12.0,
    "curveSmallOutput": 8.5,
    "curveFullInput": 38.0,
    "curveMaxOutput": 108.0,
    "openSlewLimit": 20.0,
    "closeSlewLimit": 24.0,
    "smallOpenSlewLimit": 12.0,
    "largeOpenSlewLimit": 28.0,
    "alphaOpen": 0.35,
    "alphaClose": 0.52,
    "jawBlendshapeName": "jawOpen",
    "leftCornerIndex": 61,
    "rightCornerIndex": 291,
    "upperInnerIndex": 13,
    "lowerInnerIndex": 14,
    "upperOuterIndex": 0,
    "lowerOuterIndex": 17,
    "chinIndex": 152,
    "noseTipIndex": 1,
    "foreheadIndex": 10,
    "lowerLipCenterIndices": [14, 17, 87, 317],
}

_BOOL_KEYS = (
    "enabled",
    "use3dLocalCoordinate",
    "useChinAsPrimary",
    "poseGateEnabled",
)


def _rig_imports():
    from mediapipe_to_rig import (
        _clamp_signed100,
        _semantic_strength_base,
        extract_landmarks,
        get_landmark_xy,
    )

    return _clamp_signed100, _semantic_strength_base, extract_landmarks, get_landmark_xy


def default_jaw_geometry_config() -> dict[str, Any]:
    return dict(_DEFAULT_JAW_GEOMETRY)


def create_jaw_geometry_state() -> dict[str, Any]:
    return {
        "neutral_ready": False,
        "neutral_mode": "idle",
        "neutral_count": 0,
        "neutral_warmup_count": 0,
        "neutral_sum": {
            "aperture": 0.0,
            "lowerInnerY": 0.0,
            "lowerLipCenterY": 0.0,
            "poseRollDeg": 0.0,
            "poseYawProxy": 0.0,
            "posePitchProxy": 0.0,
            "faceScale": 0.0,
        },
        "neutral": {
            "aperture": 0.0,
            "lowerInnerY": 0.0,
            "lowerLipCenterY": 0.0,
            "poseRollDeg": 0.0,
            "poseYawProxy": 0.0,
            "posePitchProxy": 0.0,
            "faceScale": 0.0,
        },
        "prev": 0.0,
        "locked_to_zero": True,
        "last_calibrated_at": 0.0,
        "last_debug": {},
    }


def reset_jaw_geometry_state(state: dict[str, Any] | None) -> dict[str, Any]:
    fresh = create_jaw_geometry_state()
    if state is not None:
        state.clear()
        state.update(fresh)
    return fresh


def start_jaw_neutral_calibration(state: dict[str, Any] | None, reason: str = "manual") -> None:
    if state is None:
        return
    reset_jaw_geometry_state(state)
    auto_reasons = ("startCameraTracking", "autoLipNeutralOnStart", "auto_start", "mouthNeutral")
    state["neutral_mode"] = "auto_start" if str(reason) in auto_reasons else "manual"
    state["neutral_ready"] = False


def normalize_jaw_geometry_config(raw: Any) -> dict[str, Any]:
    base = default_jaw_geometry_config()
    if not isinstance(raw, dict):
        return base
    for k, v in _DEFAULT_JAW_GEOMETRY.items():
        if k in _BOOL_KEYS:
            base[k] = bool(raw.get(k, v))
        elif k.endswith("Indices") or k.endswith("Index"):
            rv = raw.get(k, v)
            if isinstance(rv, (list, tuple)):
                base[k] = [int(x) for x in rv]
            elif isinstance(v, list):
                base[k] = list(v)
            else:
                base[k] = int(_safe_float(rv, float(v)))
        elif isinstance(v, (int, float)):
            base[k] = _safe_float(raw.get(k), float(v))
        else:
            base[k] = raw.get(k, v)
    return base


def _v3_sub(a: tuple[float, float, float], b: tuple[float, float, float]) -> tuple[float, float, float]:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _v3_dot(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _v3_norm(v: tuple[float, float, float]) -> float:
    return math.sqrt(max(1e-12, _v3_dot(v, v)))


def _v3_normalize(v: tuple[float, float, float]) -> tuple[float, float, float] | None:
    n = _v3_norm(v)
    if n < 1e-9:
        return None
    return (v[0] / n, v[1] / n, v[2] / n)


def _read_point3(lm: Any, idx: int, get_landmark_xy) -> tuple[float, float, float] | None:
    try:
        p = lm[int(idx)]
    except Exception:
        p = None
    if p is not None and hasattr(p, "x") and hasattr(p, "y"):
        return (float(p.x), float(p.y), float(getattr(p, "z", 0.0)))
    xy = get_landmark_xy(lm, int(idx))
    if xy is None:
        return None
    return (float(xy[0]), float(xy[1]), 0.0)


def _avg_point3(lm: Any, indices: list[int], get_landmark_xy) -> tuple[float, float, float] | None:
    pts: list[tuple[float, float, float]] = []
    for i in indices:
        p = _read_point3(lm, int(i), get_landmark_xy)
        if p is not None:
            pts.append(p)
    if not pts:
        return None
    n = float(len(pts))
    return (
        sum(p[0] for p in pts) / n,
        sum(p[1] for p in pts) / n,
        sum(p[2] for p in pts) / n,
    )


def _build_pose_aware_frame(lm: Any, jg: dict[str, Any], get_landmark_xy) -> tuple[dict[str, Any] | None, float, str]:
    li = int(jg.get("leftCornerIndex", 61))
    ri = int(jg.get("rightCornerIndex", 291))
    ni = int(jg.get("noseTipIndex", 1))
    ci = int(jg.get("chinIndex", 152))
    l = _read_point3(lm, li, get_landmark_xy)
    r = _read_point3(lm, ri, get_landmark_xy)
    n = _read_point3(lm, ni, get_landmark_xy)
    c = _read_point3(lm, ci, get_landmark_xy)
    if l is None or r is None or n is None or c is None:
        return None, 0.0, "invalid"
    mode = "3d"
    if not bool(jg.get("use3dLocalCoordinate", True)):
        mode = "2d_fallback"
        l, r, n, c = (l[0], l[1], 0.0), (r[0], r[1], 0.0), (n[0], n[1], 0.0), (c[0], c[1], 0.0)
    elif abs(l[2]) < 1e-6 and abs(r[2]) < 1e-6 and abs(n[2]) < 1e-6 and abs(c[2]) < 1e-6:
        mode = "2d_fallback"
    mouth_center = ((l[0] + r[0]) * 0.5, (l[1] + r[1]) * 0.5, (l[2] + r[2]) * 0.5)
    x_axis = _v3_normalize(_v3_sub(r, l))
    if x_axis is None:
        return None, 0.0, mode
    face_down = _v3_normalize(_v3_sub(c, n))
    if face_down is None:
        return None, 0.0, mode
    proj = _v3_dot(face_down, x_axis)
    y_raw = (face_down[0] - proj * x_axis[0], face_down[1] - proj * x_axis[1], face_down[2] - proj * x_axis[2])
    y_axis = _v3_normalize(y_raw)
    if y_axis is None:
        return None, 0.0, mode
    if _v3_dot(y_axis, _v3_sub(c, mouth_center)) < 0:
        y_axis = (-y_axis[0], -y_axis[1], -y_axis[2])
    width = _v3_norm(_v3_sub(r, l))
    min_w = max(1e-6, _safe_float(jg.get("minMouthWidth"), 0.03))
    if width < min_w:
        return None, width, mode

    def project_y(point: tuple[float, float, float]) -> float:
        return _v3_dot(_v3_sub(point, mouth_center), y_axis) / max(1e-6, width)

    return {
        "project_y": project_y,
        "mouth_center": mouth_center,
        "left": l,
        "right": r,
        "nose": n,
        "chin": c,
        "y_axis_toward_chin": _v3_dot(y_axis, _v3_sub(c, mouth_center)) > 0,
    }, width, mode


def _apply_curve(x: float, jg: dict[str, Any]) -> tuple[float, dict[str, float]]:
    x = max(0.0, float(x))
    dz = max(0.0, _safe_float(jg.get("inputDeadzone", jg.get("curveDeadzoneInput")), 2.0))
    small_end = max(dz + 1e-6, _safe_float(jg.get("smallEnd"), 18.0))
    mid_end = max(small_end + 1e-6, _safe_float(jg.get("midEnd"), 55.0))
    large_end = max(mid_end + 1e-6, _safe_float(jg.get("largeEnd"), 100.0))
    small_o = max(0.0, _safe_float(jg.get("smallOutput"), 12.0))
    mid_o = max(small_o, _safe_float(jg.get("midOutput"), 55.0))
    max_o = max(mid_o, _safe_float(jg.get("maxOutput", jg.get("curveMaxOutput")), 88.0))
    p_small = max(0.1, _safe_float(jg.get("curvePowerSmall"), 1.2))
    p_mid = max(0.1, _safe_float(jg.get("curvePowerMid"), 1.6))
    p_large = max(0.1, _safe_float(jg.get("curvePowerLarge"), 1.1))

    if x <= dz:
        y = 0.0
        segment = "deadzone"
    elif x <= small_end:
        t = (x - dz) / (small_end - dz)
        y = small_o * (t ** p_small)
        segment = "small"
    elif x <= mid_end:
        t = (x - small_end) / (mid_end - small_end)
        y = small_o + (mid_o - small_o) * (t ** p_mid)
        segment = "mid"
    else:
        t = clamp((x - mid_end) / (large_end - mid_end), 0.0, 1.0)
        y = mid_o + (max_o - mid_o) * (t ** p_large)
        segment = "large"
    y = clamp(y, 0.0, max_o)
    return float(y), {
        "rawInput": float(x),
        "afterDeadzone": float(0.0 if x <= dz else x),
        "afterCurve": float(y),
        "segment": segment,
        "inputDeadzone": float(dz),
        "smallEnd": float(small_end),
        "midEnd": float(mid_end),
        "largeEnd": float(large_end),
        "smallOutput": float(small_o),
        "midOutput": float(mid_o),
        "maxOutput": float(max_o),
    }


def _pick_jaw_slew_limit(target: float, prev: float, jg: dict[str, Any]) -> float:
    target_abs = abs(float(target))
    prev_abs = abs(float(prev))
    open_slew = max(1e-6, _safe_float(jg.get("openSlewLimit"), 10.0))
    close_slew = max(1e-6, _safe_float(jg.get("closeSlewLimit"), 14.0))
    small_open = max(1e-6, _safe_float(jg.get("smallOpenSlewLimit"), 5.0))
    large_open = max(1e-6, _safe_float(jg.get("largeOpenSlewLimit"), 12.0))
    if target_abs < 15.0:
        return small_open
    if target_abs > prev_abs:
        return large_open if target_abs >= 55.0 else open_slew
    return close_slew


def _stabilize(raw: float, st: dict[str, Any], jg: dict[str, Any]) -> tuple[float, dict[str, Any]]:
    prev = float(st.get("prev", 0.0))
    locked = bool(st.get("locked_to_zero", True))
    hold = max(0.0, _safe_float(jg.get("outputHoldDeadband"), 1.4))
    release = max(hold, _safe_float(jg.get("outputReleaseThreshold"), 2.6))
    snap = max(0.0, _safe_float(jg.get("snapToZero"), 2.0))
    dz = max(0.0, _safe_float(jg.get("deadzone"), 2.0))
    alpha_open = clamp(_safe_float(jg.get("alphaOpen"), 0.38), 0.0, 1.0)
    alpha_close = clamp(_safe_float(jg.get("alphaClose"), 0.55), 0.0, 1.0)
    fast_d = max(1e-6, _safe_float(jg.get("fastDelta"), 5.0))
    adj = 0.0 if abs(raw) < dz else float(raw)
    if locked:
        if abs(adj) >= release:
            locked = False
            target = adj
        else:
            target = 0.0
    else:
        if abs(adj) < hold:
            locked = True
            target = 0.0
        else:
            target = adj
    delta = abs(target - prev)
    opening = abs(target) >= abs(prev)
    alpha = alpha_open if opening else alpha_close
    smooth = prev + alpha * (target - prev)
    max_step = _pick_jaw_slew_limit(target, prev, jg)
    step = clamp(smooth - prev, -max_step, max_step)
    clipped = abs((smooth - prev) - step) > 1e-9
    smooth = prev + step
    if abs(smooth) < snap:
        smooth = 0.0
        locked = True
    st["prev"] = float(smooth)
    st["locked_to_zero"] = bool(locked)
    return float(smooth), {
        "raw": float(raw),
        "target": float(target),
        "smooth": float(smooth),
        "alpha": float(alpha),
        "effectiveStep": float(step),
        "slewLimit": float(max_step),
        "slewDelta": float(step),
        "slewClipped": bool(clipped),
        "lockedToZero": bool(locked),
    }


def _neutral_dbg(st: dict[str, Any]) -> dict[str, Any]:
    return {
        "mode": str(st.get("neutral_mode", "idle")),
        "neutralReady": bool(st.get("neutral_ready")),
        "neutralCount": int(st.get("neutral_count", 0)),
        "neutralWarmupCount": int(st.get("neutral_warmup_count", 0)),
        "lastCalibratedAt": float(st.get("last_calibrated_at", 0.0)),
    }


def apply_jaw_geometry_drive(
    *,
    result: Any,
    cfg: dict[str, Any],
    jaw_state: dict[str, Any] | None,
    rig: dict[str, Any],
    mapping: dict[str, float],
    blend: dict[str, float],
    neutral_bs: dict[str, float],
    gains: dict[str, Any],
    invert_jaw: bool,
    deadzone: dict[str, Any],
    limits: dict[str, Any],
    quality: float,
    face_detected: bool,
    timestamp_ms: float | None,
    lip_neutral_ready: bool,
    nose_motion: dict[str, Any] | None = None,
    final_scenario: str | None = None,
    head_motion_output_scale: float | None = None,
) -> dict[str, Any]:
    _clamp_signed100, _semantic_strength_base, extract_landmarks, get_landmark_xy = _rig_imports()
    _ = (invert_jaw, limits)
    now_ms = float(timestamp_ms) if timestamp_ms is not None else time.time() * 1000.0
    jg = normalize_jaw_geometry_config(cfg.get("jawGeometry"))
    st = jaw_state if jaw_state is not None else create_jaw_geometry_state()
    jaw_sign = -1.0 if _safe_float(jg.get("jawOutputSign"), -1.0) < 0 else 1.0
    dz_j = _safe_float(deadzone.get("jaw"), 0.03)
    jaw_bs = _semantic_strength_base(
        blend.get(jg.get("jawBlendshapeName", "jawOpen"), 0.0) - _safe_float(neutral_bs.get(jg.get("jawBlendshapeName", "jawOpen"), 0.0), 0.0),
        deadzone_thr=dz_j,
        gain=_safe_float(gains.get("jaw"), 1.0),
        lim_lo=0.0,
        lim_hi=100.0,
    )
    lm = extract_landmarks(result)
    frame, mouth_width, coord_mode = (None, 0.0, "invalid")
    if lm is not None:
        f = build_mouth_pose_frame(lm, jg, get_landmark_xy)
        if bool(f.get("ok")):
            frame = f
            mouth_width = float(f.get("mouthWidth", 0.0))
            coord_mode = str(f.get("coordinateMode", "invalid"))
        else:
            frame = None
            mouth_width = float(f.get("mouthWidth", 0.0))
            coord_mode = str(f.get("coordinateMode", "invalid"))
    base_dbg = {
        "enabled": bool(jg.get("enabled", True)),
        "neutralReady": bool(st.get("neutral_ready", False)),
        "neutralCount": int(st.get("neutral_count", 0)),
        "coordinateMode": coord_mode,
        "pose": {"rollDeg": 0.0, "yawProxy": 0.0, "pitchProxy": 0.0, "faceScale": 0.0},
        "poseNeutral": {"rollDeg": 0.0, "yawProxy": 0.0, "pitchProxy": 0.0, "faceScale": 0.0},
        "poseGate": {
            "active": False,
            "reasons": [],
            "yawDelta": 0.0,
            "pitchDelta": 0.0,
            "rollDelta": 0.0,
            "scaleDelta": 0.0,
            "poseMotionSuppressScale": float(_safe_float(jg.get("poseMotionSuppressScale"), 0.25)),
        },
        "current": {"aperture": 0.0, "lowerInnerY": 0.0, "lowerLipCenterY": 0.0},
        "neutral": {"aperture": 0.0, "lowerInnerY": 0.0, "lowerLipCenterY": 0.0},
        "components": {
            "jawAperture": 0.0,
            "jawApertureCompensated": 0.0,
            "jawLowerInner": 0.0,
            "jawLowerLipCenter": 0.0,
            "jawBlendshape": float(jaw_bs),
            "jawChin": 0.0,
        },
        "weights": {
            "apertureWeight": float(_safe_float(jg.get("apertureWeight"), 0.50)),
            "lowerInnerWeight": float(_safe_float(jg.get("lowerInnerWeight"), 0.35)),
            "lowerLipCenterWeight": float(_safe_float(jg.get("lowerLipCenterWeight"), 0.15)),
            "chinWeight": float(_safe_float(jg.get("chinWeight"), 0.0)),
            "blendshapeMix": float(_safe_float(jg.get("blendshapeMix"), 0.08)),
        },
        "curve": {},
        "stabilizer": {},
        "raw": 0.0,
        "curved": 0.0,
        "jawSignedRaw": 0.0,
        "jawSmooth": 0.0,
        "rigWrite": {"jaw": 0.0},
        "semanticOpen": 0.0,
        "signConvention": {
            "internalOpenPositive": True,
            "jawOutputSign": float(jaw_sign),
            "rigOpenNegative": bool(jaw_sign < 0),
        },
        "neutralState": _neutral_dbg(st),
        "mouthScenario": "unknown",
        "noseAnchorMotion": False,
        "oldMouthPoseHeadMotionActive": False,
        "gateDecision": {
            "frontalPassThrough": False,
            "closedHeadTurnLockApplied": False,
            "poseGateSuppressionApplied": False,
            "reason": "init",
        },
        "noseAnchor": dict(nose_motion) if isinstance(nose_motion, dict) else {},
        "skipped": "",
    }
    if not bool(jg.get("enabled", True)):
        rig["jaw"]["val"] = 0.0
        mapping["jaw"] = 0.0
        base_dbg["skipped"] = "jawGeometry-disabled"
        st["last_debug"] = base_dbg
        return base_dbg
    if lm is None or frame is None:
        rig["jaw"]["val"] = 0.0
        mapping["jaw"] = 0.0
        base_dbg["skipped"] = "mouth-frame-invalid"
        st["last_debug"] = base_dbg
        return base_dbg
    li = int(jg.get("leftCornerIndex", 61))
    ri = int(jg.get("rightCornerIndex", 291))
    ui = int(jg.get("upperInnerIndex", 13))
    loi = int(jg.get("lowerInnerIndex", 14))
    ci = int(jg.get("chinIndex", 152))
    ni = int(jg.get("noseTipIndex", 1))
    l = _read_point3(lm, li, get_landmark_xy)
    r = _read_point3(lm, ri, get_landmark_xy)
    up = _read_point3(lm, ui, get_landmark_xy)
    lo = _read_point3(lm, loi, get_landmark_xy)
    chin = _read_point3(lm, ci, get_landmark_xy)
    nose = _read_point3(lm, ni, get_landmark_xy)
    lower_center = _avg_point3(lm, list(jg.get("lowerLipCenterIndices") or [14, 17, 87, 317]), get_landmark_xy)
    if any(x is None for x in (l, r, up, lo, chin, nose, lower_center)):
        rig["jaw"]["val"] = 0.0
        mapping["jaw"] = 0.0
        base_dbg["skipped"] = "landmark-missing"
        st["last_debug"] = base_dbg
        return base_dbg
    py = frame["projectY"] if "projectY" in frame else frame["project_y"]
    upper_y = float(py(up))
    lower_inner_y = float(py(lo))
    lower_center_y = float(py(lower_center))
    chin_y = float(py(chin))
    aperture = float(lower_inner_y - upper_y)
    mouth_center = frame["mouthCenter"]
    face_scale = float(mouth_width)
    yaw = float((_v3_norm(_v3_sub(nose, r)) - _v3_norm(_v3_sub(nose, l))) / max(1e-6, mouth_width))
    pitch = float(_v3_norm(_v3_sub(chin, mouth_center)) / max(1e-6, mouth_width))
    roll = math.degrees(math.atan2(r[1] - l[1], r[0] - l[0]))
    base_dbg["pose"] = {"rollDeg": roll, "yawProxy": yaw, "pitchProxy": pitch, "faceScale": face_scale}
    if not face_detected or float(quality) < _safe_float(jg.get("neutralTrackMinQuality"), 0.5):
        rig["jaw"]["val"] = 0.0
        mapping["jaw"] = 0.0
        base_dbg["skipped"] = "waiting-stable-face"
        st["last_debug"] = base_dbg
        return base_dbg
    fi = {
        "face_detected": True,
        "quality": float(quality),
        "mouth_width": float(mouth_width),
        "jaw_val": float(abs(jaw_bs)),
        "smile_l": _safe_float(mapping.get("smileLeft"), 0.0),
        "smile_r": _safe_float(mapping.get("smileRight"), 0.0),
        "side_l_x": _safe_float(rig.get("mouth", {}).get("sideL", {}).get("x"), 50.0),
        "side_l_y": _safe_float(rig.get("mouth", {}).get("sideL", {}).get("y"), 50.0),
        "side_r_x": _safe_float(rig.get("mouth", {}).get("sideR", {}).get("x"), 50.0),
        "side_r_y": _safe_float(rig.get("mouth", {}).get("sideR", {}).get("y"), 50.0),
    }
    from lip_geometry import is_lip_neutral_candidate
    candidate = bool(is_lip_neutral_candidate(fi, {"neutralTrackMinQuality": jg.get("neutralTrackMinQuality"), "minMouthWidth": jg.get("minMouthWidth"), "neutralMaxJaw": jg.get("neutralMaxJawBlend"), "neutralMaxSmile": jg.get("neutralMaxSmile"), "neutralMaxSideOffset": jg.get("neutralMaxSideOffset")}))
    if not st.get("neutral_ready"):
        if candidate:
            wc = int(st.get("neutral_warmup_count", 0))
            need_w = max(0, int(jg.get("neutralWarmupFrames", 8)))
            if wc < need_w:
                st["neutral_warmup_count"] = wc + 1
            else:
                ns = st["neutral_sum"]
                ns["aperture"] += aperture
                ns["lowerInnerY"] += lower_inner_y
                ns["lowerLipCenterY"] += lower_center_y
                ns["poseRollDeg"] += roll
                ns["poseYawProxy"] += yaw
                ns["posePitchProxy"] += pitch
                ns["faceScale"] += face_scale
                st["neutral_count"] = int(st.get("neutral_count", 0)) + 1
                if int(st.get("neutral_count", 0)) >= max(1, int(jg.get("neutralFrames", 30))):
                    nc = float(st["neutral_count"])
                    st["neutral"] = {
                        "aperture": ns["aperture"] / nc,
                        "lowerInnerY": ns["lowerInnerY"] / nc,
                        "lowerLipCenterY": ns["lowerLipCenterY"] / nc,
                        "poseRollDeg": ns["poseRollDeg"] / nc,
                        "poseYawProxy": ns["poseYawProxy"] / nc,
                        "posePitchProxy": ns["posePitchProxy"] / nc,
                        "faceScale": max(1e-6, ns["faceScale"] / nc),
                    }
                    st["neutral_ready"] = True
                    st["neutral_mode"] = "ready"
                    st["last_calibrated_at"] = now_ms
                    st["prev"] = 0.0
                    st["locked_to_zero"] = True
        rig["jaw"]["val"] = 0.0
        mapping["jaw"] = 0.0
        base_dbg["skipped"] = "jaw-neutral-calibrating"
        base_dbg["neutralState"] = _neutral_dbg(st)
        st["last_debug"] = base_dbg
        return base_dbg
    if not lip_neutral_ready:
        rig["jaw"]["val"] = 0.0
        mapping["jaw"] = 0.0
        base_dbg["skipped"] = "lip-neutral-wait"
        st["last_debug"] = base_dbg
        return base_dbg
    n = st["neutral"]
    base_dbg["neutral"] = {
        "aperture": float(n["aperture"]),
        "lowerInnerY": float(n["lowerInnerY"]),
        "lowerLipCenterY": float(n["lowerLipCenterY"]),
    }
    base_dbg["poseNeutral"] = {
        "rollDeg": float(n["poseRollDeg"]),
        "yawProxy": float(n["poseYawProxy"]),
        "pitchProxy": float(n["posePitchProxy"]),
        "faceScale": float(n["faceScale"]),
    }
    base_dbg["current"] = {"aperture": float(aperture), "lowerInnerY": float(lower_inner_y), "lowerLipCenterY": float(lower_center_y)}
    aperture_delta = max(0.0, aperture - float(n["aperture"]))
    lower_inner_delta = max(0.0, lower_inner_y - float(n["lowerInnerY"]))
    lower_center_delta = max(0.0, lower_center_y - float(n["lowerLipCenterY"]))
    upper_open = max(0.0, float(n["lowerInnerY"]) - lower_inner_y)
    jaw_aperture = aperture_delta * _safe_float(jg.get("apertureGain"), 620.0)
    jaw_lower_inner = lower_inner_delta * _safe_float(jg.get("lowerInnerGain"), 520.0)
    jaw_lower_center = lower_center_delta * _safe_float(jg.get("lowerLipCenterGain"), 280.0)
    jaw_ap_comp = max(0.0, jaw_aperture - upper_open * _safe_float(jg.get("upperLipOpenCompensation"), 0.55))
    jaw_chin = max(0.0, (chin_y - (float(n["lowerInnerY"]) + 0.5 * float(n["aperture"]))) * _safe_float(jg.get("lowerLipCenterGain"), 280.0))
    jaw_input = (
        _safe_float(jg.get("apertureWeight"), 0.50) * jaw_ap_comp
        + _safe_float(jg.get("lowerInnerWeight"), 0.35) * jaw_lower_inner
        + _safe_float(jg.get("lowerLipCenterWeight"), 0.15) * jaw_lower_center
    )
    if bool(jg.get("useChinAsPrimary", False)):
        jaw_input += _safe_float(jg.get("chinWeight"), 0.0) * jaw_chin
    pose_gate_dbg = evaluate_mouth_pose_gate(
        {"yawProxy": yaw, "pitchProxy": pitch, "rollDeg": roll, "faceScale": face_scale},
        {
            "yawProxy": n["poseYawProxy"],
            "pitchProxy": n["posePitchProxy"],
            "rollDeg": n["poseRollDeg"],
            "faceScale": n["faceScale"],
        },
        jg,
    )
    yaw_d = float(pose_gate_dbg["yawDelta"])
    pitch_d = float(pose_gate_dbg["pitchDelta"])
    roll_d = float(pose_gate_dbg["rollDelta"])
    scale_d = float(pose_gate_dbg["scaleDelta"])
    reasons = list(pose_gate_dbg["reasons"])
    pose_gate = bool(pose_gate_dbg["active"])

    # Nose Anchor Gate V1：head motion 改由鼻部锚点判断。
    nose_dbg = nose_motion if isinstance(nose_motion, dict) else {}
    nose_ready = bool(nose_dbg.get("neutralReady"))
    nose_enabled = bool(nose_dbg.get("enabled", True)) and bool(nose_dbg) and ("motionActive" in nose_dbg)
    nose_anchor_motion = bool(nose_dbg.get("motionActive")) if (nose_enabled and nose_ready) else False
    head_motion_active = nose_anchor_motion if (nose_enabled and nose_ready) else pose_gate

    mix = clamp(_safe_float(jg.get("blendshapeMix"), 0.08), 0.0, 1.0)
    jaw_input_full = jaw_input * (1.0 - mix) + max(0.0, float(jaw_bs)) * mix
    after_curve_full, _ = _apply_curve(jaw_input_full, jg)
    # Evidence-First：finalScenario 由中央 classifier 统一产出（lip / jaw 共用）。
    if final_scenario is not None:
        mouth_scenario = str(final_scenario)
    else:
        msc = cfg.get("mouthScenario") if isinstance(cfg.get("mouthScenario"), dict) else {}
        frontal_thr = max(0.0, _safe_float(msc.get("frontalMouthMotionThreshold"), 4.0))
        neutral_thr = max(0.0, _safe_float(msc.get("neutralThreshold"), 2.0))
        if (not head_motion_active) and after_curve_full < neutral_thr:
            mouth_scenario = "neutral_still"
        elif head_motion_active and after_curve_full < frontal_thr:
            mouth_scenario = "closed_head_turn"
        elif (not head_motion_active) and after_curve_full >= frontal_thr:
            mouth_scenario = "frontal_mouth_motion"
        else:
            mouth_scenario = "unknown"

    suppress_scale = clamp(_safe_float(jg.get("poseMotionSuppressScale"), 0.25), 0.0, 1.0)
    gate_reason = "normal-flow"
    pose_gate_suppression_applied = False
    gate_scale = 1.0
    hm_scale = None
    if mouth_scenario == "closed_head_turn":
        jaw_input = 0.0
        if bool(jg.get("closedHeadTurnResetPrev", True)):
            st["prev"] = 0.0
            st["locked_to_zero"] = True
        gate_reason = "closed-head-turn-zero"
        gate_scale = 0.0
    elif mouth_scenario == "frontal_mouth_motion":
        gate_reason = "frontal-pass-through"
    elif mouth_scenario == "head_motion_mouth_motion":
        # 转头同时说话 / Open-Close Guard：保守输出。
        msc = cfg.get("mouthScenario") if isinstance(cfg.get("mouthScenario"), dict) else {}
        if head_motion_output_scale is not None:
            hm_scale = clamp(float(head_motion_output_scale), 0.0, 1.0)
        else:
            hm_scale = clamp(
                _safe_float(
                    msc.get("headMotionMouthJawScale"),
                    _safe_float(msc.get("headMotionJawSuppressScale"), 0.85),
                ),
                0.0,
                1.0,
            )
        jaw_input *= hm_scale
        gate_scale = float(hm_scale)
        pose_gate_suppression_applied = True
        gate_reason = "head-motion-mouth-motion"
    elif mouth_scenario == "neutral_still":
        gate_reason = "neutral-still"
    else:
        # unknown：保守轻度 suppress。
        jaw_input *= suppress_scale
        gate_scale = float(suppress_scale)
        pose_gate_suppression_applied = True
        gate_reason = "unknown-conservative"
    jaw_input_pre_curve = float(jaw_input)
    jaw_input = jaw_input * (1.0 - mix) + max(0.0, float(jaw_bs)) * mix
    combined_input = float(jaw_input)
    after_curve, curve_dbg = _apply_curve(jaw_input, jg)
    frontal_pass_through = bool(mouth_scenario == "frontal_mouth_motion")
    gate_decision = {
        "finalScenario": str(mouth_scenario),
        "frontalPassThrough": frontal_pass_through,
        "closedHeadTurnApplied": bool(mouth_scenario == "closed_head_turn"),
        "closedHeadTurnLockApplied": bool(mouth_scenario == "closed_head_turn"),
        "poseGateSuppressionApplied": pose_gate_suppression_applied,
        "reason": gate_reason,
    }
    jaw_signed_raw = float(_clamp_signed100(jaw_sign * after_curve))
    jaw_smooth, stab_dbg = _stabilize(jaw_signed_raw, st, jg)
    rig["jaw"]["val"] = float(_clamp_signed100(jaw_smooth))
    mapping["jaw"] = float(rig["jaw"]["val"])
    base_dbg["gate"] = {
        "scenario": str(mouth_scenario),
        "scale": float(gate_scale),
        "reason": gate_reason,
    }
    base_dbg["slew"] = {
        "limit": float(stab_dbg.get("slewLimit", 0.0)),
        "delta": float(stab_dbg.get("slewDelta", stab_dbg.get("effectiveStep", 0.0))),
        "clipped": bool(stab_dbg.get("slewClipped", False)),
    }
    base_dbg["components"] = {
        "aperture": float(jaw_aperture),
        "lowerLip": float(jaw_lower_inner),
        "blendshape": float(jaw_bs),
        "chin": float(jaw_chin),
        "combined": float(combined_input),
        "jawAperture": float(jaw_aperture),
        "jawApertureCompensated": float(jaw_ap_comp),
        "jawLowerInner": float(jaw_lower_inner),
        "jawLowerLipCenter": float(jaw_lower_center),
        "jawBlendshape": float(jaw_bs),
        "jawChin": float(jaw_chin),
    }
    base_dbg["curve"] = {
        **curve_dbg,
        "target": float(after_curve),
        "afterSlew": float(jaw_smooth),
        "final": float(rig["jaw"]["val"]),
    }
    base_dbg["raw"] = float(combined_input)
    base_dbg["curved"] = float(after_curve)
    base_dbg["neutralReady"] = True
    base_dbg["neutralState"] = _neutral_dbg(st)
    base_dbg["poseGate"] = pose_gate_dbg
    base_dbg["jawSignedRaw"] = float(jaw_signed_raw)
    base_dbg["jawSmooth"] = float(jaw_smooth)
    base_dbg["semanticOpen"] = float(max(0.0, after_curve))
    base_dbg["stabilizer"] = stab_dbg
    base_dbg["rigWrite"] = {"jaw": float(rig["jaw"]["val"])}
    base_dbg["mouthScenario"] = str(mouth_scenario)
    base_dbg["noseAnchorMotion"] = bool(nose_anchor_motion)
    base_dbg["oldMouthPoseHeadMotionActive"] = bool(pose_gate)
    base_dbg["gateDecision"] = gate_decision
    base_dbg["afterCurveFull"] = float(after_curve_full)
    base_dbg["noseAnchor"] = dict(nose_dbg)
    st["last_debug"] = base_dbg
    return base_dbg


def compute_jaw_raw_evidence(
    result: Any,
    cfg: dict[str, Any],
    jaw_state: dict[str, Any] | None,
    blend: dict[str, float],
    neutral_bs: dict[str, float],
    gains: dict[str, Any],
    deadzone: dict[str, Any],
) -> dict[str, Any]:
    """Mouth-Evidence-First：返回 jaw 的 raw 证据（pre-gate / pre-smoothing）。

    jawInputAbs = 进 curve 前的加权 raw 输入；jawScore = 进 gate 前、过 curve 的 0~100 值。
    两者都不是 gate/clamp/smooth 后的值。
    """
    _clamp_signed100, _semantic_strength_base, extract_landmarks, get_landmark_xy = _rig_imports()
    jg = normalize_jaw_geometry_config(cfg.get("jawGeometry"))
    st = jaw_state if isinstance(jaw_state, dict) else {}
    dz_j = _safe_float(deadzone.get("jaw"), 0.03)
    jaw_bs = _semantic_strength_base(
        blend.get(jg.get("jawBlendshapeName", "jawOpen"), 0.0) - _safe_float(neutral_bs.get(jg.get("jawBlendshapeName", "jawOpen"), 0.0), 0.0),
        deadzone_thr=dz_j,
        gain=_safe_float(gains.get("jaw"), 1.0),
        lim_lo=0.0,
        lim_hi=100.0,
    )
    out = {
        "jawInputAbs": 0.0,
        "jawScore": 0.0,
        "apertureAbs": 0.0,
        "available": {"jaw": False, "aperture": False},
    }
    if not bool(st.get("neutral_ready")):
        return out
    lm = extract_landmarks(result)
    if lm is None:
        return out
    f = build_mouth_pose_frame(lm, jg, get_landmark_xy)
    if not bool(f.get("ok")):
        return out
    mouth_width = float(f.get("mouthWidth", 0.0))
    ui = int(jg.get("upperInnerIndex", 13))
    loi = int(jg.get("lowerInnerIndex", 14))
    up = _read_point3(lm, ui, get_landmark_xy)
    lo = _read_point3(lm, loi, get_landmark_xy)
    lower_center = _avg_point3(lm, list(jg.get("lowerLipCenterIndices") or [14, 17, 87, 317]), get_landmark_xy)
    if any(x is None for x in (up, lo, lower_center)):
        return out
    py = f["projectY"] if "projectY" in f else f["project_y"]
    upper_y = float(py(up))
    lower_inner_y = float(py(lo))
    lower_center_y = float(py(lower_center))
    aperture = float(lower_inner_y - upper_y)
    n = st.get("neutral") or {}
    aperture_delta = max(0.0, aperture - _safe_float(n.get("aperture"), 0.0))
    lower_inner_delta = max(0.0, lower_inner_y - _safe_float(n.get("lowerInnerY"), 0.0))
    lower_center_delta = max(0.0, lower_center_y - _safe_float(n.get("lowerLipCenterY"), 0.0))
    upper_open = max(0.0, _safe_float(n.get("lowerInnerY"), 0.0) - lower_inner_y)
    jaw_aperture = aperture_delta * _safe_float(jg.get("apertureGain"), 620.0)
    jaw_lower_inner = lower_inner_delta * _safe_float(jg.get("lowerInnerGain"), 520.0)
    jaw_lower_center = lower_center_delta * _safe_float(jg.get("lowerLipCenterGain"), 280.0)
    jaw_ap_comp = max(0.0, jaw_aperture - upper_open * _safe_float(jg.get("upperLipOpenCompensation"), 0.55))
    jaw_input = (
        _safe_float(jg.get("apertureWeight"), 0.50) * jaw_ap_comp
        + _safe_float(jg.get("lowerInnerWeight"), 0.35) * jaw_lower_inner
        + _safe_float(jg.get("lowerLipCenterWeight"), 0.15) * jaw_lower_center
    )
    mix = clamp(_safe_float(jg.get("blendshapeMix"), 0.08), 0.0, 1.0)
    jaw_input_full = jaw_input * (1.0 - mix) + max(0.0, float(jaw_bs)) * mix
    after_curve_full, _ = _apply_curve(jaw_input_full, jg)
    return {
        "jawInputAbs": float(abs(jaw_input)),
        "jawScore": float(abs(after_curve_full)),
        "apertureAbs": float(abs(aperture - _safe_float(n.get("aperture"), 0.0))),
        "available": {"jaw": True, "aperture": True},
        "mouthWidth": float(mouth_width),
    }


def jaw_geometry_overlay_indices(cfg: dict[str, Any] | None = None) -> tuple[int, ...]:
    jg = normalize_jaw_geometry_config(cfg.get("jawGeometry") if isinstance(cfg, dict) else None)
    s: set[int] = {
        int(jg.get("leftCornerIndex", 61)),
        int(jg.get("rightCornerIndex", 291)),
        int(jg.get("upperInnerIndex", 13)),
        int(jg.get("lowerInnerIndex", 14)),
        int(jg.get("upperOuterIndex", 0)),
        int(jg.get("lowerOuterIndex", 17)),
        int(jg.get("chinIndex", 152)),
        int(jg.get("noseTipIndex", 1)),
        int(jg.get("foreheadIndex", 10)),
    }
    for i in jg.get("lowerLipCenterIndices") or []:
        s.add(int(i))
    return tuple(sorted(s))
