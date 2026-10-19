"""
嘴唇 Landmark Geometry Driver：局部嘴坐标 + 自动/手动 neutral + 抗漂移 + 输出稳定器。
"""

from __future__ import annotations

import math
import time
from typing import Any

from mediapipe_mapping_config import _safe_float, clamp
from mouth_pose_frame import build_mouth_pose_frame, evaluate_mouth_pose_gate

_LIP_KEYS = ("upperL", "upperR", "lowerL", "lowerR")

_DEFAULT_LIP_GEOMETRY: dict[str, Any] = {
    "enabled": True,
    "neutralFrames": 30,
    "neutralWarmupFrames": 8,
    "minMouthWidth": 0.03,
    "autoNeutralOnStart": True,
    "requireNeutralReadyForOutput": True,
    "neutralMaxJaw": 8.0,
    "neutralMaxJawOpen": 8.0,
    "neutralMaxSmile": 12.0,
    "neutralMaxSideOffset": 10.0,
    "neutralMaxLipDelta": 8.0,
    "neutralMaxLipVelocity": 3.0,
    "neutralStableFrames": 10,
    "neutralTrackMinQuality": 0.5,
    "driftCorrectionEnabled": True,
    "driftCorrectionAlpha": 0.015,
    "driftCorrectionMaxStep": 0.0008,
    "driftCorrectionStartAfterMs": 1500.0,
    "upperGain": 1000.0,
    "lowerGain": 1000.0,
    "upperSign": 1.0,
    "lowerSign": 1.0,
    "deadzone": 2.0,
    "softDeadzoneKnee": 6.0,
    "smallMotionBoostEnabled": True,
    "smallMotionThreshold": 18.0,
    "smallMotionBoost": 1.2,
    "largeMotionThreshold": 45.0,
    "leftGain": 1.0,
    "rightGain": 1.0,
    "upperRightGain": 1.15,
    "lowerRightGain": 1.15,
    "snapToZero": 0.6,
    "alphaSlow": 0.32,
    "alphaFast": 0.86,
    "fastDelta": 7.0,
    "outputHoldDeadband": 1.0,
    "outputReleaseThreshold": 2.0,
    "maxStepPerFrame": 24.0,
    "minOutputDelta": 0.0,
    "stableHoldFrames": 0,
    "blendshapeMix": 0.06,
    "useApertureForLip": False,
    "useJawForLip": False,
    "removeJawFromLip": False,
    "jawToUpperCompensation": 0.18,
    "jawToLowerCompensation": 0.35,
    "reAddJawToLip": False,
    "jawToUpperLipGain": 0.10,
    "jawToLowerLipGain": 0.18,
    "crossTalkSuppressionEnabled": False,
    "poseAwareFrameEnabled": True,
    "poseGateEnabled": True,
    "maxYawProxyDelta": 0.10,
    "maxPitchProxyDelta": 0.10,
    "maxRollDeltaDeg": 12.0,
    "maxFaceScaleDelta": 0.18,
    "poseMotionSuppressScale": 0.20,
    "poseGateZeroWhenNoMouthMotion": True,
    "poseGateMouthMotionThreshold": 6.0,
    "poseGateOutputClamp": 12.0,
    "use3dLocalCoordinate": True,
    "closedHeadTurnLockEnabled": True,
    "headMotionYawThreshold": 0.025,
    "headMotionPitchThreshold": 0.045,
    "headMotionRollThresholdDeg": 5.0,
    "headMotionScaleThreshold": 0.025,
    "closedHeadTurnJawAbsMax": 8.0,
    "closedHeadTurnUseLipAbsAsVeto": False,
    "closedHeadTurnLipVetoAbsMax": 35.0,
    "closedHeadTurnUseApertureEvidence": True,
    "closedHeadTurnApertureDeltaMax": 0.018,
    "closedHeadTurnUseBlendshapeEvidence": True,
    "closedHeadTurnMouthOpenMax": 12.0,
    "closedHeadTurnJawOpenMax": 12.0,
    "closedHeadTurnSmileMax": 18.0,
    "closedHeadTurnUseCornerEvidence": True,
    "closedHeadTurnCornerOffsetMax": 18.0,
    "closedHeadTurnOutputClamp": 0.0,
    "closedHeadTurnResetPrev": True,
    "closedHeadTurnRequirePoseMotion": True,
    "scenarioTransitionFrames": 10,
    "maxLipControlAbsDefault": 100.0,
    "smallJawOpenNormThreshold": 0.01,
    "mediumJawOpenNormThreshold": 0.02,
    "maxLipControlAbsTinyJaw": 22.0,
    "maxLipControlAbsSmallJaw": 30.0,
    "openCloseReleaseJawOpenNorm": 0.012,
    "openCloseReleaseMouthScoreMax": 25.0,
    "openCloseReleaseMaxLipControlAbs": 28.0,
    "openCloseFastReleaseMaxStep": 50.0,
    "openCloseFastReleaseAlpha": 0.96,
    "lipGlobalScale": 0.52,
    "lipFinalAbsLimit": 38.0,
    "frontalMouthMotionThreshold": 4.0,
    "neutralThreshold": 2.0,
    "crossTalkRatio": 1.8,
    "crossTalkPassiveMax": 12.0,
    "crossTalkAttenuation": 0.25,
    "upperLeftIndices": [40, 80, 81],
    "upperRightIndices": [270, 310, 311],
    "lowerLeftIndices": [91, 88, 178],
    "lowerRightIndices": [321, 318, 402],
    "leftCornerIndex": 61,
    "rightCornerIndex": 291,
    "chinIndex": 152,
}

_BOOL_LIP_KEYS = (
    "enabled",
    "autoNeutralOnStart",
    "requireNeutralReadyForOutput",
    "driftCorrectionEnabled",
    "useApertureForLip",
    "useJawForLip",
    "removeJawFromLip",
    "reAddJawToLip",
    "crossTalkSuppressionEnabled",
    "poseAwareFrameEnabled",
    "poseGateEnabled",
    "poseGateZeroWhenNoMouthMotion",
    "use3dLocalCoordinate",
    "closedHeadTurnLockEnabled",
    "closedHeadTurnResetPrev",
    "closedHeadTurnRequirePoseMotion",
    "closedHeadTurnUseLipAbsAsVeto",
    "closedHeadTurnUseApertureEvidence",
    "closedHeadTurnUseBlendshapeEvidence",
    "closedHeadTurnUseCornerEvidence",
    "smallMotionBoostEnabled",
)


def _soft_deadzone_smooth(x: float, dz: float, knee: float) -> float:
    ax = abs(float(x))
    if ax <= dz:
        return 0.0
    y = ax - dz
    k = max(float(knee), 1e-6)
    smooth = (y * y) / (2.0 * k) if y < k else y - k / 2.0
    return math.copysign(smooth, float(x))


def _apply_small_motion_boost(x: float, lg: dict[str, Any]) -> float:
    if not bool(lg.get("smallMotionBoostEnabled", True)):
        return float(x)
    ax = abs(float(x))
    if ax <= 0.0:
        return 0.0
    small_thr = max(1e-6, _safe_float(lg.get("smallMotionThreshold"), 18.0))
    large_thr = max(small_thr + 1e-6, _safe_float(lg.get("largeMotionThreshold"), 45.0))
    boost = max(1.0, _safe_float(lg.get("smallMotionBoost"), 1.2))
    if ax >= large_thr:
        return float(x)
    if ax <= small_thr:
        return float(x) * boost
    t = (ax - small_thr) / (large_thr - small_thr)
    scale = boost + (1.0 - boost) * t
    return float(x) * scale


def _lip_channel_gain(key: str, lg: dict[str, Any]) -> float:
    left_g = _safe_float(lg.get("leftGain"), 1.0)
    right_g = _safe_float(lg.get("rightGain"), 1.0)
    if key == "upperL":
        return left_g
    if key == "upperR":
        return right_g * _safe_float(lg.get("upperRightGain"), 1.0)
    if key == "lowerL":
        return left_g
    if key == "lowerR":
        return right_g * _safe_float(lg.get("lowerRightGain"), 1.0)
    return 1.0


def _process_lip_pre_gate_pipeline(
    delta_raw: dict[str, float],
    lg: dict[str, Any],
) -> tuple[dict[str, float], dict[str, Any]]:
    dz = max(0.0, _safe_float(lg.get("deadzone"), 2.0))
    knee = max(1e-6, _safe_float(lg.get("softDeadzoneKnee"), 6.0))
    after_dz = _axis4_zero()
    after_boost = _axis4_zero()
    after_gain = _axis4_zero()
    for k in _LIP_KEYS:
        v = float(delta_raw.get(k, 0.0))
        v = _soft_deadzone_smooth(v, dz, knee)
        after_dz[k] = v
        v = _apply_small_motion_boost(v, lg)
        after_boost[k] = v
        after_gain[k] = v * _lip_channel_gain(k, lg)
    pipeline = {
        "raw": dict(delta_raw),
        "afterSoftDeadzone": dict(after_dz),
        "afterSmallMotionBoost": dict(after_boost),
        "afterGain": dict(after_gain),
    }
    return after_gain, pipeline


def _rig_helpers():
    from mediapipe_to_rig import (
        _clamp_signed100,
        _pipe_unipolar_strength,
        extract_landmarks,
        get_landmark_xy,
    )

    return (
        _clamp_signed100,
        _pipe_unipolar_strength,
        extract_landmarks,
        get_landmark_xy,
    )


def _axis4_zero() -> dict[str, float]:
    return {"upperL": 0.0, "upperR": 0.0, "lowerL": 0.0, "lowerR": 0.0}


def _axis4_copy(src: dict[str, float] | None) -> dict[str, float]:
    if not isinstance(src, dict):
        return _axis4_zero()
    return {k: float(src.get(k, 0.0)) for k in _LIP_KEYS}


def default_lip_geometry_config() -> dict[str, Any]:
    return dict(_DEFAULT_LIP_GEOMETRY)


def create_lip_geometry_state() -> dict[str, Any]:
    z = _axis4_zero()
    pz = {"rollDeg": 0.0, "yawProxy": 0.0, "pitchProxy": 0.0, "faceScale": 0.0}
    return {
        "neutral_ready": False,
        "neutral_mode": "idle",
        "neutral_count": 0,
        "neutral_warmup_count": 0,
        "neutral_sum": {**dict(z), **dict(pz)},
        "neutral": {**dict(z), **dict(pz)},
        "prev": dict(z),
        "prev_raw": dict(z),
        "locked_to_zero": {k: True for k in _LIP_KEYS},
        "last_calibrated_at": 0.0,
        "last_drift_update_at": 0.0,
        "neutral_stable_count": 0,
        "force_recalibrate": False,
        "auto_calibrate_requested": False,
        "last_debug": {},
        "drift_hold_reason": "",
    }


def reset_lip_geometry_state(state: dict[str, Any] | None) -> dict[str, Any]:
    fresh = create_lip_geometry_state()
    if state is not None:
        state.clear()
        state.update(fresh)
    return fresh


def start_lip_neutral_calibration(state: dict[str, Any] | None, reason: str = "manual") -> None:
    """开始嘴唇 neutral 采集（自动 Start 或手动 Set Lip Neutral）。"""
    if state is None:
        return
    reset_lip_geometry_state(state)
    auto_reasons = ("startCameraTracking", "autoLipNeutralOnStart", "auto_start", "mouthNeutral")
    state["neutral_mode"] = "auto_start" if str(reason) in auto_reasons else "manual"
    state["auto_calibrate_requested"] = state["neutral_mode"] == "auto_start"
    state["neutral_ready"] = False


def request_lip_neutral_recalibration(state: dict[str, Any] | None) -> None:
    start_lip_neutral_calibration(state, "manual")


def normalize_lip_geometry_config(raw: Any) -> dict[str, Any]:
    base = default_lip_geometry_config()
    if not isinstance(raw, dict):
        return base
    for k, v in _DEFAULT_LIP_GEOMETRY.items():
        if k in _BOOL_LIP_KEYS:
            base[k] = bool(raw.get(k, v))
        elif k.endswith("Indices") or k.endswith("Index"):
            arr = raw.get(k, v)
            if isinstance(arr, (list, tuple)):
                base[k] = [int(x) for x in arr]
            else:
                base[k] = list(v) if isinstance(v, (list, tuple)) else v
        elif isinstance(v, (int, float)):
            base[k] = _safe_float(raw.get(k), float(v))
        else:
            base[k] = raw.get(k, v)
    return base


def _vec2_sub(a: tuple[float, float], b: tuple[float, float]) -> tuple[float, float]:
    return (a[0] - b[0], a[1] - b[1])


def _vec2_norm(v: tuple[float, float]) -> float:
    return math.hypot(v[0], v[1])


def _vec2_normalize(v: tuple[float, float]) -> tuple[float, float] | None:
    n = _vec2_norm(v)
    if n < 1e-9:
        return None
    return (v[0] / n, v[1] / n)


def _vec2_dot(a: tuple[float, float], b: tuple[float, float]) -> float:
    return a[0] * b[0] + a[1] * b[1]


def _perpendicular(v: tuple[float, float]) -> tuple[float, float]:
    return (-v[1], v[0])


def _average_landmark_xy(
    landmarks: Any, indices: list[int], get_landmark_xy
) -> tuple[float, float] | None:
    pts: list[tuple[float, float]] = []
    for i in indices:
        xy = get_landmark_xy(landmarks, int(i))
        if xy is not None:
            pts.append(xy)
    if not pts:
        return None
    return (
        sum(p[0] for p in pts) / len(pts),
        sum(p[1] for p in pts) / len(pts),
    )


def _read_point3(landmarks: Any, idx: int, get_landmark_xy) -> tuple[float, float, float] | None:
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


def _average_landmark_xyz(
    landmarks: Any,
    indices: list[int],
    get_landmark_xy,
) -> tuple[float, float, float] | None:
    pts: list[tuple[float, float, float]] = []
    for i in indices:
        p = _read_point3(landmarks, int(i), get_landmark_xy)
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


def _build_mouth_frame(
    landmarks: Any, lg: dict[str, Any], get_landmark_xy
) -> tuple[dict[str, Any] | None, float]:
    lc = int(lg.get("leftCornerIndex", 61))
    rc = int(lg.get("rightCornerIndex", 291))
    chin_i = int(lg.get("chinIndex", 152))
    corner_l = get_landmark_xy(landmarks, lc)
    corner_r = get_landmark_xy(landmarks, rc)
    chin = get_landmark_xy(landmarks, chin_i)
    if corner_l is None or corner_r is None or chin is None:
        return None, 0.0

    mouth_center = (
        (corner_l[0] + corner_r[0]) * 0.5,
        (corner_l[1] + corner_r[1]) * 0.5,
    )
    x_axis = _vec2_normalize(_vec2_sub(corner_r, corner_l))
    if x_axis is None:
        return None, 0.0
    y_axis = _perpendicular(x_axis)
    chin_rel = _vec2_sub(chin, mouth_center)
    if _vec2_dot(y_axis, chin_rel) < 0:
        y_axis = (-y_axis[0], -y_axis[1])
    y_axis_toward_chin = _vec2_dot(y_axis, chin_rel) > 0

    mouth_width = _vec2_norm(_vec2_sub(corner_r, corner_l))
    min_w = max(1e-6, _safe_float(lg.get("minMouthWidth"), 0.03))
    if mouth_width < min_w:
        return None, mouth_width

    def project_y(point: tuple[float, float]) -> float:
        rel = _vec2_sub(point, mouth_center)
        return _vec2_dot(rel, y_axis) / mouth_width

    return {
        "mouth_center": mouth_center,
        "x_axis": x_axis,
        "y_axis": y_axis,
        "y_axis_toward_chin": bool(y_axis_toward_chin),
        "project_y": project_y,
    }, mouth_width


def _lip_sign_from_config(lg: dict[str, Any], key: str, default: float = 1.0) -> float:
    s = _safe_float(lg.get(key), default)
    if abs(s) < 1e-9:
        return default
    return 1.0 if s > 0 else -1.0


def _geo_delta_raw(
    neutral_y: float,
    current_y: float,
    gain: float,
    sign: float,
    clamp_fn,
) -> float:
    return clamp_fn(float(sign) * (neutral_y - current_y) * gain)


def _cfg_max_jaw(lg: dict[str, Any]) -> float:
    if "neutralMaxJaw" in lg:
        return _safe_float(lg.get("neutralMaxJaw"), 8.0)
    return _safe_float(lg.get("neutralMaxJawOpen"), 8.0)


def _frame_info_from_rig(
    *,
    rig: dict[str, Any],
    mapping: dict[str, float],
    blend: dict[str, float],
    mouth_width: float,
    quality: float,
    face_detected: bool,
) -> dict[str, Any]:
    mouth = rig.get("mouth") if isinstance(rig.get("mouth"), dict) else {}
    side_l = mouth.get("sideL") if isinstance(mouth.get("sideL"), dict) else {}
    side_r = mouth.get("sideR") if isinstance(mouth.get("sideR"), dict) else {}
    jaw_val = _safe_float((rig.get("jaw") or {}).get("val"), 0.0)
    return {
        "face_detected": bool(face_detected),
        "quality": float(quality),
        "mouth_width": float(mouth_width),
        "jaw_val": jaw_val,
        "smile_l": _safe_float(mapping.get("smileLeft"), 0.0),
        "smile_r": _safe_float(mapping.get("smileRight"), 0.0),
        "side_l_x": _safe_float(side_l.get("x"), 50.0),
        "side_l_y": _safe_float(side_l.get("y"), 50.0),
        "side_r_x": _safe_float(side_r.get("x"), 50.0),
        "side_r_y": _safe_float(side_r.get("y"), 50.0),
        "blend_jaw": _safe_float(blend.get("jawOpen"), 0.0),
    }


def is_lip_neutral_candidate(frame_info: dict[str, Any], lg: dict[str, Any]) -> bool:
    if not frame_info.get("face_detected"):
        return False
    min_q = _safe_float(lg.get("neutralTrackMinQuality"), 0.5)
    if float(frame_info.get("quality", 0.0)) < min_q:
        return False
    min_w = max(1e-6, _safe_float(lg.get("minMouthWidth"), 0.03))
    if float(frame_info.get("mouth_width", 0.0)) < min_w:
        return False

    max_jaw = _cfg_max_jaw(lg)
    jaw = abs(float(frame_info.get("jaw_val", 0.0)))
    if jaw > max_jaw:
        return False

    max_smile = _safe_float(lg.get("neutralMaxSmile"), 12.0)
    if max(abs(float(frame_info.get("smile_l", 0.0))), abs(float(frame_info.get("smile_r", 0.0)))) > max_smile:
        return False

    max_side = _safe_float(lg.get("neutralMaxSideOffset"), 10.0)
    for k in ("side_l_x", "side_l_y", "side_r_x", "side_r_y"):
        if abs(float(frame_info.get(k, 50.0)) - 50.0) > max_side:
            return False
    return True


def is_lip_drift_update_allowed(
    *,
    st: dict[str, Any],
    lg: dict[str, Any],
    frame_info: dict[str, Any],
    delta_smooth: dict[str, float],
    now_ms: float,
) -> tuple[bool, str]:
    if not bool(lg.get("driftCorrectionEnabled", True)):
        return False, "disabled"
    if not st.get("neutral_ready"):
        return False, "not-ready"
    last_cal = float(st.get("last_calibrated_at", 0.0))
    if last_cal <= 0 or (now_ms - last_cal) < _safe_float(lg.get("driftCorrectionStartAfterMs"), 1500.0):
        return False, "warmup-after-calibration"

    if not is_lip_neutral_candidate(frame_info, lg):
        return False, "not-neutral-candidate"

    max_delta = _safe_float(lg.get("neutralMaxLipDelta"), 8.0)
    for k in _LIP_KEYS:
        if abs(float(delta_smooth.get(k, 0.0))) > max_delta:
            return False, "lip-delta-active"

    prev_s = st.get("prev") if isinstance(st.get("prev"), dict) else {}
    max_vel = _safe_float(lg.get("neutralMaxLipVelocity"), 3.0)
    for k in _LIP_KEYS:
        if abs(float(delta_smooth.get(k, 0.0)) - float(prev_s.get(k, 0.0))) > max_vel:
            return False, "lip-velocity-high"

    need_stable = max(1, int(lg.get("neutralStableFrames", 10)))
    if int(st.get("neutral_stable_count", 0)) < need_stable:
        return False, "stabilizing"
    return True, "ok"


def _apply_drift_correction(
    st: dict[str, Any],
    lg: dict[str, Any],
    current_y: dict[str, float],
    now_ms: float,
) -> dict[str, float]:
    """极慢更新 neutral absoluteY；返回每通道 step。"""
    alpha = _safe_float(lg.get("driftCorrectionAlpha"), 0.015)
    max_step = _safe_float(lg.get("driftCorrectionMaxStep"), 0.0008)
    neu = st["neutral"]
    steps = _axis4_zero()
    for k in _LIP_KEYS:
        err = float(current_y[k]) - float(neu[k])
        step = clamp(alpha * err, -max_step, max_step)
        neu[k] = float(neu[k]) + step
        steps[k] = float(step)
    st["last_drift_update_at"] = now_ms
    return steps


def _jaw_open_norm(blend: dict[str, Any], neutral: dict[str, Any]) -> float:
    return abs(_safe_float(blend.get("jawOpen"), 0.0) - _safe_float(neutral.get("jawOpen"), 0.0))


def _resolve_max_lip_control_abs(
    jaw_open_norm: float,
    lg: dict[str, Any],
    *,
    open_close_guard_active: bool,
    raw_mouth_score: float,
) -> tuple[float, dict[str, Any]]:
    max_abs = float(_safe_float(lg.get("maxLipControlAbsDefault"), 100.0))
    dbg: dict[str, Any] = {"jawOpenNorm": float(jaw_open_norm)}
    tiny = _safe_float(lg.get("smallJawOpenNormThreshold"), 0.01)
    mild = _safe_float(lg.get("mediumJawOpenNormThreshold"), 0.02)
    if jaw_open_norm < tiny:
        max_abs = min(max_abs, _safe_float(lg.get("maxLipControlAbsTinyJaw"), 12.0))
        dbg["tinyJawCap"] = True
    elif jaw_open_norm < mild:
        max_abs = min(max_abs, _safe_float(lg.get("maxLipControlAbsSmallJaw"), 20.0))
        dbg["smallJawCap"] = True
    oc_jaw = _safe_float(lg.get("openCloseReleaseJawOpenNorm"), 0.012)
    oc_score = _safe_float(lg.get("openCloseReleaseMouthScoreMax"), 25.0)
    if open_close_guard_active and jaw_open_norm < oc_jaw and raw_mouth_score < oc_score:
        max_abs = min(max_abs, _safe_float(lg.get("openCloseReleaseMaxLipControlAbs"), 15.0))
        dbg["openCloseFastRelease"] = True
    elif open_close_guard_active and jaw_open_norm < _safe_float(lg.get("mediumJawOpenNormThreshold"), 0.02):
        max_abs = min(max_abs, _safe_float(lg.get("openCloseReleaseMaxLipControlAbs"), 15.0))
        dbg["openCloseGuardCap"] = True
    dbg["maxLipControlAbs"] = float(max_abs)
    return max_abs, dbg


def _maybe_arm_open_close_fast_release(
    st: dict[str, Any],
    lg: dict[str, Any],
    *,
    jaw_open_norm: float,
    open_close_guard_active: bool,
    raw_mouth_score: float,
) -> bool:
    oc_jaw = _safe_float(lg.get("openCloseReleaseJawOpenNorm"), 0.012)
    oc_score = _safe_float(lg.get("openCloseReleaseMouthScoreMax"), 25.0)
    active = bool(
        open_close_guard_active and jaw_open_norm < oc_jaw and raw_mouth_score < oc_score
    )
    was_active = bool(st.get("oc_fast_release_was_active"))
    st["fast_release_lip"] = active
    if active and not was_active:
        st["prev"] = _axis4_zero()
        st["prev_raw"] = _axis4_zero()
        for k in _LIP_KEYS:
            st["locked_to_zero"][k] = False
    elif active:
        for k in _LIP_KEYS:
            st["locked_to_zero"][k] = False
    st["oc_fast_release_was_active"] = active
    return active


def _cap_lip_channels(delta: dict[str, float], max_abs: float) -> dict[str, float]:
    cap = max(0.0, float(max_abs))
    return {k: clamp(float(delta[k]), -cap, cap) for k in _LIP_KEYS}


def _finalize_mouth_rig_write(rig_write: dict[str, float], lg: dict[str, Any]) -> dict[str, float]:
    """FaceRig mouth 最终限幅：global scale + abs clamp（binding 前）。"""
    scale = clamp(_safe_float(lg.get("lipGlobalScale"), 0.52), 0.05, 1.0)
    limit = max(1.0, _safe_float(lg.get("lipFinalAbsLimit"), 45.0))
    key_map = {
        "upperL": "UL",
        "upperR": "UR",
        "lowerL": "LL",
        "lowerR": "LR",
    }
    out: dict[str, float] = {}
    for geo_k, rig_k in key_map.items():
        v = float(rig_write.get(geo_k, 0.0)) * scale
        out[rig_k] = float(clamp(v, -limit, limit))
    return out


def stabilize_lip_channel(
    key: str,
    raw: float,
    st: dict[str, Any],
    lg: dict[str, Any],
) -> tuple[float, dict[str, Any]]:
    prev = float(st["prev"].get(key, 0.0))
    prev_raw = float(st["prev_raw"].get(key, 0.0))
    locked = bool(st["locked_to_zero"].get(key, True))

    dz = max(0.0, _safe_float(lg.get("deadzone"), 1.0))
    snap = max(0.0, _safe_float(lg.get("snapToZero"), 0.6))
    hold_db = max(0.0, _safe_float(lg.get("outputHoldDeadband"), 1.2))
    release_thr = max(hold_db, _safe_float(lg.get("outputReleaseThreshold"), 2.2))
    alpha_slow = clamp(_safe_float(lg.get("alphaSlow"), 0.32), 0.0, 1.0)
    alpha_fast = clamp(_safe_float(lg.get("alphaFast"), 0.82), 0.0, 1.0)
    fast_delta = max(1e-6, _safe_float(lg.get("fastDelta"), 10.0))
    max_step = max(1e-6, _safe_float(lg.get("maxStepPerFrame"), 18.0))

    fast_release = bool(st.get("fast_release_lip"))
    if fast_release:
        locked = False
        max_step = max(max_step, _safe_float(lg.get("openCloseFastReleaseMaxStep"), 28.0))
        alpha_slow = clamp(_safe_float(lg.get("openCloseFastReleaseAlpha"), 0.88), 0.0, 1.0)
        alpha_fast = alpha_slow

    raw_adj = 0.0 if abs(raw) < dz else float(raw)

    if fast_release:
        target = 0.0
    elif locked:
        if abs(raw_adj) >= release_thr:
            locked = False
            target = raw_adj
        else:
            target = 0.0
    else:
        if abs(raw_adj) < hold_db:
            locked = True
            target = 0.0
        else:
            target = raw_adj

    delta_mag = abs(target - prev)
    t = min(1.0, delta_mag / fast_delta)
    alpha = alpha_slow + (alpha_fast - alpha_slow) * t
    y = prev + alpha * (target - prev)

    step = clamp(y - prev, -max_step, max_step)
    y = prev + step

    if abs(y) < snap:
        y = 0.0
        locked = True

    min_od = max(0.0, _safe_float(lg.get("minOutputDelta"), 0.0))
    if min_od > 0 and abs(y - prev) < min_od:
        y = float(prev)

    velocity = abs(raw_adj - prev_raw)
    st["prev"][key] = float(y)
    st["prev_raw"][key] = float(raw_adj)
    st["locked_to_zero"][key] = locked

    ch_dbg = {
        "locked": locked,
        "raw": float(raw_adj),
        "smooth": float(y),
        "velocity": float(velocity),
        "alpha": float(alpha),
    }
    return float(y), ch_dbg


def _apply_scenario_gate_blend(
    st: dict[str, Any],
    target: dict[str, float],
    mouth_scenario: str,
    lg: dict[str, Any],
) -> tuple[dict[str, float], dict[str, Any]]:
    """finalScenario 切换时对 gate 输出做线性 ramp，避免四唇舵机硬切反向跳变。"""
    frames = max(1, int(_safe_float(lg.get("scenarioTransitionFrames"), 10)))
    prev_scenario = str(st.get("gate_scenario") or mouth_scenario)
    scenario_changed = mouth_scenario != prev_scenario

    if scenario_changed:
        st["gate_scenario_from"] = dict(st.get("gate_scenario_out") or st.get("prev") or _axis4_zero())
        st["gate_scenario_blend_idx"] = 0
        st["gate_scenario"] = mouth_scenario

    idx = int(st.get("gate_scenario_blend_idx", frames))
    if idx < frames:
        from_out = st.get("gate_scenario_from") or _axis4_zero()
        t = (idx + 1) / float(frames)
        st["gate_scenario_blend_idx"] = idx + 1
        blended = {
            k: float(from_out.get(k, 0.0))
            + (float(target[k]) - float(from_out.get(k, 0.0))) * t
            for k in _LIP_KEYS
        }
        blending = True
    else:
        blended = dict(target)
        blending = False

    st["gate_scenario_out"] = dict(blended)
    return blended, {
        "scenario": str(mouth_scenario),
        "prevScenario": prev_scenario,
        "scenarioChanged": bool(scenario_changed),
        "blendIndex": int(st.get("gate_scenario_blend_idx", frames)),
        "blendFrames": int(frames),
        "blending": bool(blending),
    }


def _stabilize_all_channels(
    delta_raw: dict[str, float],
    st: dict[str, Any],
    lg: dict[str, Any],
) -> tuple[dict[str, float], dict[str, Any]]:
    smooth = _axis4_zero()
    stabilizer: dict[str, Any] = {"lockedToZero": {}, "raw": {}, "smooth": {}, "velocity": {}, "alpha": {}}
    for k in _LIP_KEYS:
        y, ch = stabilize_lip_channel(k, float(delta_raw[k]), st, lg)
        smooth[k] = y
        stabilizer["lockedToZero"][k] = ch["locked"]
        stabilizer["raw"][k] = ch["raw"]
        stabilizer["smooth"][k] = ch["smooth"]
        stabilizer["velocity"][k] = ch["velocity"]
        stabilizer["alpha"][k] = ch["alpha"]
    return smooth, stabilizer


def _blendshape_lip_signed_deltas(
    blend: dict[str, float],
    neutral: dict[str, float],
    *,
    gains: dict[str, Any],
    invert: dict[str, Any],
    deadzone: dict[str, Any],
    limits: dict[str, Any],
    dz_lip: float,
    lo_lp: float,
    hi_lp: float,
    up_scale: float,
    lo_scale: float,
    _clamp_signed100,
    _pipe_unipolar_strength,
) -> tuple[float, float, float, float]:
    ull_s = max(0.0, blend["mouthUpperUpLeft"] - _safe_float(neutral.get("mouthUpperUpLeft"), 0.0))
    ulr_s = max(0.0, blend["mouthUpperUpRight"] - _safe_float(neutral.get("mouthUpperUpRight"), 0.0))
    lll_s = max(0.0, blend["mouthLowerDownLeft"] - _safe_float(neutral.get("mouthLowerDownLeft"), 0.0))
    llr_s = max(0.0, blend["mouthLowerDownRight"] - _safe_float(neutral.get("mouthLowerDownRight"), 0.0))

    ull_v = _pipe_unipolar_strength(
        ull_s, deadzone_thr=dz_lip, gain=_safe_float(gains.get("upperLipLeft"), 1.0),
        invert=bool(invert.get("upperLipLeft")), lim_lo=lo_lp, lim_hi=hi_lp,
    )
    ulr_v = _pipe_unipolar_strength(
        ulr_s, deadzone_thr=dz_lip, gain=_safe_float(gains.get("upperLipRight"), 1.0),
        invert=bool(invert.get("upperLipRight")), lim_lo=lo_lp, lim_hi=hi_lp,
    )
    lll_v = _pipe_unipolar_strength(
        lll_s, deadzone_thr=dz_lip, gain=_safe_float(gains.get("lowerLipLeft"), 1.0),
        invert=False, lim_lo=lo_lp, lim_hi=hi_lp,
    )
    llr_v = _pipe_unipolar_strength(
        llr_s, deadzone_thr=dz_lip, gain=_safe_float(gains.get("lowerLipRight"), 1.0),
        invert=False, lim_lo=lo_lp, lim_hi=hi_lp,
    )
    return (
        _clamp_signed100(abs(ull_v * up_scale)),
        _clamp_signed100(abs(ulr_v * up_scale)),
        _clamp_signed100(-abs(lll_v * lo_scale)),
        _clamp_signed100(-abs(llr_v * lo_scale)),
    )


def _zero_lip_outputs(rig: dict[str, Any], mapping: dict[str, float]) -> None:
    rig["mouth"]["UL"] = 0.0
    rig["mouth"]["UR"] = 0.0
    rig["mouth"]["LL"] = 0.0
    rig["mouth"]["LR"] = 0.0
    mapping["lipGeoUpperL"] = 0.0
    mapping["lipGeoUpperR"] = 0.0
    mapping["lipGeoLowerL"] = 0.0
    mapping["lipGeoLowerR"] = 0.0
    mapping["upperLipLeft"] = 0.0
    mapping["upperLipRight"] = 0.0
    mapping["lowerLipLeft"] = 0.0
    mapping["lowerLipRight"] = 0.0


def _apply_lip_cross_talk(
    d: dict[str, float],
    lg: dict[str, Any],
) -> tuple[dict[str, float], dict[str, Any]]:
    if not bool(lg.get("crossTalkSuppressionEnabled", True)):
        return dict(d), {"suppressedUpper": False, "suppressedLower": False}
    ratio = max(1.001, _safe_float(lg.get("crossTalkRatio"), 1.8))
    passive_max = max(0.0, _safe_float(lg.get("crossTalkPassiveMax"), 12.0))
    atten = clamp(_safe_float(lg.get("crossTalkAttenuation"), 0.25), 0.0, 1.0)

    upper_mag = max(abs(float(d["upperL"])), abs(float(d["upperR"])))
    lower_mag = max(abs(float(d["lowerL"])), abs(float(d["lowerR"])))
    out = {k: float(d[k]) for k in _LIP_KEYS}
    suppressed_upper = False
    suppressed_lower = False

    if upper_mag > lower_mag * ratio and lower_mag < passive_max:
        out["lowerL"] *= atten
        out["lowerR"] *= atten
        suppressed_lower = True

    if lower_mag > upper_mag * ratio and upper_mag < passive_max:
        out["upperL"] *= atten
        out["upperR"] *= atten
        suppressed_upper = True

    return out, {
        "suppressedUpper": suppressed_upper,
        "suppressedLower": suppressed_lower,
        "upperMag": float(upper_mag),
        "lowerMag": float(lower_mag),
        "ratio": float(ratio),
    }


def _neutral_state_debug(st: dict[str, Any]) -> dict[str, Any]:
    return {
        "mode": str(st.get("neutral_mode", "idle")),
        "neutralReady": bool(st.get("neutral_ready")),
        "neutralCount": int(st.get("neutral_count", 0)),
        "neutralWarmupCount": int(st.get("neutral_warmup_count", 0)),
        "stableCount": int(st.get("neutral_stable_count", 0)),
        "autoCalibrateRequested": bool(st.get("auto_calibrate_requested")),
        "forceRecalibrate": bool(st.get("force_recalibrate")),
        "lastCalibratedAt": float(st.get("last_calibrated_at", 0.0)),
    }


def _build_mouth_debug(
    *,
    current_y: dict[str, float],
    neutral_y: dict[str, float],
    upper_sign: float,
    lower_sign: float,
    blend: dict[str, float] | None,
    neutral_bs: dict[str, float] | None,
    aperture_current: float | None = None,
    upper_inner_y: float | None = None,
    lower_inner_y: float | None = None,
    delta_before_clamp: dict[str, float] | None = None,
    delta_after_clamp: dict[str, float] | None = None,
    rig_write: dict[str, float] | None = None,
    raw_mouth_score: float = 0.0,
) -> dict[str, Any]:
    """五段式 mouth debug：geometryRaw → relative → normalized → final。"""
    cur = _axis4_copy(current_y)
    neu = _axis4_copy(neutral_y)
    us = float(upper_sign) if abs(float(upper_sign)) > 1e-9 else 1.0
    ls = float(lower_sign) if abs(float(lower_sign)) > 1e-9 else 1.0
    bs = blend if isinstance(blend, dict) else {}
    nbs = neutral_bs if isinstance(neutral_bs, dict) else {}

    upper_lip_y = float(upper_inner_y) if upper_inner_y is not None else (cur["upperL"] + cur["upperR"]) * 0.5
    lower_lip_y = float(lower_inner_y) if lower_inner_y is not None else (cur["lowerL"] + cur["lowerR"]) * 0.5
    pucker = max(0.0, _safe_float(bs.get("mouthPucker"), 0.0) - _safe_float(nbs.get("mouthPucker"), 0.0))
    funnel = max(0.0, _safe_float(bs.get("mouthFunnel"), 0.0) - _safe_float(nbs.get("mouthFunnel"), 0.0))
    aperture = float(aperture_current) if aperture_current is not None else 0.0
    aperture_neu = _safe_float(neu.get("aperture"), 0.0) if "aperture" in neu else 0.0

    before = _axis4_copy(delta_before_clamp or {})
    after = _axis4_copy(delta_after_clamp or before)
    final = _axis4_copy(rig_write or after)

    score = float(raw_mouth_score)
    return {
        "geometryRaw": {
            "upperL": float(cur["upperL"]),
            "upperR": float(cur["upperR"]),
            "lowerL": float(cur["lowerL"]),
            "lowerR": float(cur["lowerR"]),
            "aperture": float(aperture),
            "upperLip": float(upper_lip_y),
            "lowerLip": float(lower_lip_y),
            "pucker": float(pucker),
            "funnel": float(funnel),
        },
        "relative": {
            "upperL": float(us * (neu["upperL"] - cur["upperL"])),
            "upperR": float(us * (neu["upperR"] - cur["upperR"])),
            "lowerL": float(ls * (neu["lowerL"] - cur["lowerL"])),
            "lowerR": float(ls * (neu["lowerR"] - cur["lowerR"])),
            "aperture": float(aperture - aperture_neu),
        },
        "normalizedBeforeClamp": {
            "upperL": float(before["upperL"]),
            "upperR": float(before["upperR"]),
            "lowerL": float(before["lowerL"]),
            "lowerR": float(before["lowerR"]),
            "rawMouthScore": float(score),
        },
        "normalizedAfterClamp": {
            "upperL": float(after["upperL"]),
            "upperR": float(after["upperR"]),
            "lowerL": float(after["lowerL"]),
            "lowerR": float(after["lowerR"]),
            "rawMouthScore": float(score),
        },
        "final": {
            "upperL": float(final["upperL"]),
            "upperR": float(final["upperR"]),
            "lowerL": float(final["lowerL"]),
            "lowerR": float(final["lowerR"]),
        },
    }


def _pack_lip_debug(
    *,
    lg: dict[str, Any],
    st: dict[str, Any],
    mouth_width: float,
    current_y: dict[str, float],
    neutral_y: dict[str, float],
    delta_raw: dict[str, float],
    delta_after_pose_gate: dict[str, float] | None = None,
    delta_smooth: dict[str, float],
    rig_write: dict[str, float],
    blend_term: dict[str, float],
    sign_convention: dict[str, Any] | None = None,
    coordinate_mode: str = "unknown",
    pose: dict[str, Any] | None = None,
    pose_neutral: dict[str, Any] | None = None,
    pose_gate: dict[str, Any] | None = None,
    closed_head_turn_lock: dict[str, Any] | None = None,
    mouth_scenario: str = "unknown",
    gate_decision: dict[str, Any] | None = None,
    drift_correction: dict[str, Any] | None = None,
    stabilizer: dict[str, Any] | None = None,
    source_breakdown: dict[str, Any] | None = None,
    cross_talk: dict[str, Any] | None = None,
    skipped: str = "",
    mouth_debug: dict[str, Any] | None = None,
    blend: dict[str, float] | None = None,
    neutral_bs: dict[str, float] | None = None,
    upper_sign: float = 1.0,
    lower_sign: float = 1.0,
    aperture_current: float | None = None,
    upper_inner_y: float | None = None,
    lower_inner_y: float | None = None,
    delta_before_clamp: dict[str, float] | None = None,
    delta_after_clamp: dict[str, float] | None = None,
    raw_mouth_score: float = 0.0,
) -> dict[str, Any]:
    sc = sign_convention if isinstance(sign_convention, dict) else {}
    iso_u = max(abs(float(delta_smooth.get("upperL", 0.0))), abs(float(delta_smooth.get("upperR", 0.0))))
    iso_l = max(abs(float(delta_smooth.get("lowerL", 0.0))), abs(float(delta_smooth.get("lowerR", 0.0))))
    denom = iso_u + iso_l + 1e-6
    isolation = float((iso_u - iso_l) / denom)
    out = {
        "enabled": bool(lg.get("enabled", True)),
        "neutralReady": bool(st.get("neutral_ready")),
        "neutralCount": int(st.get("neutral_count", 0)),
        "mouthWidth": float(mouth_width),
        "coordinateMode": str(coordinate_mode),
        "neutralState": _neutral_state_debug(st),
        "driftCorrection": dict(drift_correction or {}),
        "stabilizer": dict(stabilizer or {}),
        "signConvention": dict(sc),
        "currentY": dict(current_y),
        "neutralY": dict(neutral_y),
        "deltaRaw": dict(delta_raw),
        "deltaAfterPoseGate": dict(delta_after_pose_gate or delta_raw),
        "deltaSmooth": dict(delta_smooth),
        "rigWrite": dict(rig_write),
        "blendshapeTerm": dict(blend_term),
        "skipped": skipped,
        "upperL": float(delta_smooth.get("upperL", 0.0)),
        "upperR": float(delta_smooth.get("upperR", 0.0)),
        "lowerL": float(delta_smooth.get("lowerL", 0.0)),
        "lowerR": float(delta_smooth.get("lowerR", 0.0)),
        "upperLRaw": float(delta_raw.get("upperL", 0.0)),
        "upperRRaw": float(delta_raw.get("upperR", 0.0)),
        "lowerLRaw": float(delta_raw.get("lowerL", 0.0)),
        "lowerRRaw": float(delta_raw.get("lowerR", 0.0)),
        "isolation": isolation,
        "pose": dict(pose or {}),
        "poseNeutral": dict(pose_neutral or {}),
        "poseGate": dict(pose_gate or {}),
        "closedHeadTurnLock": dict(closed_head_turn_lock or {}),
        "mouthScenario": str(mouth_scenario),
        "gateDecision": dict(gate_decision or {}),
    }
    if source_breakdown:
        out["sourceBreakdown"] = source_breakdown
    if cross_talk:
        out["crossTalk"] = cross_talk
    out["mouthDebug"] = mouth_debug or _build_mouth_debug(
        current_y=current_y,
        neutral_y=neutral_y,
        upper_sign=upper_sign,
        lower_sign=lower_sign,
        blend=blend,
        neutral_bs=neutral_bs,
        aperture_current=aperture_current,
        upper_inner_y=upper_inner_y,
        lower_inner_y=lower_inner_y,
        delta_before_clamp=delta_before_clamp or delta_after_pose_gate or delta_raw,
        delta_after_clamp=delta_after_clamp or delta_smooth,
        rig_write=rig_write,
        raw_mouth_score=float(raw_mouth_score),
    )
    return out


def _process_neutral_calibration(
    st: dict[str, Any],
    lg: dict[str, Any],
    *,
    current_y: dict[str, float],
    pose: dict[str, float],
    candidate: bool,
    now_ms: float,
) -> tuple[bool, bool, str]:
    """返回 (still_calibrating, just_completed, ui_hint)。"""
    if st.get("neutral_ready"):
        return False, False, "ready"

    warmup_need = max(0, int(lg.get("neutralWarmupFrames", 8)))
    n_frames = max(1, int(lg.get("neutralFrames", 30)))

    if not candidate:
        st["neutral_stable_count"] = 0
        return True, False, "waiting-stable-mouth"

    wc = int(st.get("neutral_warmup_count", 0))
    if wc < warmup_need:
        st["neutral_warmup_count"] = wc + 1
        return True, False, "warmup"

    ns = st["neutral_sum"]
    for k in _LIP_KEYS:
        ns[k] += current_y[k]
    ns["rollDeg"] += float(pose.get("rollDeg", 0.0))
    ns["yawProxy"] += float(pose.get("yawProxy", 0.0))
    ns["pitchProxy"] += float(pose.get("pitchProxy", 0.0))
    ns["faceScale"] += float(pose.get("faceScale", 0.0))
    nc = int(st.get("neutral_count", 0)) + 1
    st["neutral_count"] = nc

    if nc < n_frames:
        return True, False, "calibrating"

    st["neutral"] = {
        **{k: ns[k] / nc for k in _LIP_KEYS},
        "rollDeg": float(ns["rollDeg"] / nc),
        "yawProxy": float(ns["yawProxy"] / nc),
        "pitchProxy": float(ns["pitchProxy"] / nc),
        "faceScale": float(ns["faceScale"] / nc) if float(ns["faceScale"] / nc) > 1e-6 else 1.0,
    }
    st["neutral_ready"] = True
    st["neutral_mode"] = "ready"
    st["prev"] = _axis4_zero()
    st["prev_raw"] = _axis4_zero()
    st["locked_to_zero"] = {k: True for k in _LIP_KEYS}
    st["last_calibrated_at"] = now_ms
    st["neutral_stable_count"] = 0
    st["auto_calibrate_requested"] = False
    return False, True, "just-completed"


def apply_lip_geometry_drive(
    *,
    result: Any,
    rig: dict[str, Any],
    mapping: dict[str, float],
    cfg: dict[str, Any],
    lip_state: dict[str, Any] | None,
    blend: dict[str, float],
    neutral: dict[str, float],
    gains: dict[str, Any],
    invert: dict[str, Any],
    deadzone: dict[str, Any],
    limits: dict[str, Any],
    quality: float = 0.0,
    face_detected: bool = True,
    timestamp_ms: float | None = None,
    jaw_semantic_open: float = 0.0,
    nose_motion: dict[str, Any] | None = None,
    final_scenario: str | None = None,
    head_motion_output_scale: float | None = None,
    open_close_guard_active: bool = False,
    raw_mouth_score: float = 0.0,
) -> dict[str, Any]:
    """写入 rig.mouth.UL/UR/LL/LR；返回 debug.lipGeometry。"""
    (
        _clamp_signed100,
        _pipe_unipolar_strength,
        extract_landmarks,
        get_landmark_xy,
    ) = _rig_helpers()

    now_ms = float(timestamp_ms) if timestamp_ms is not None else time.time() * 1000.0
    lip_cfg = cfg.get("lip") if isinstance(cfg.get("lip"), dict) else {}
    lip_on = bool(lip_cfg.get("enabled", True))
    lim_lip = limits.get("lip", [0.0, 100.0])
    lo_lp, hi_lp = _safe_float(lim_lip[0], 0.0), _safe_float(lim_lip[1], 100.0)
    dz_lip = _safe_float(deadzone.get("lip"), 0.03)
    up_scale = _safe_float(lip_cfg.get("upperScale"), 100.0) / 100.0
    lo_scale = _safe_float(lip_cfg.get("lowerScale"), 100.0) / 100.0

    lg = normalize_lip_geometry_config(cfg.get("lipGeometry"))
    st = lip_state if lip_state is not None else create_lip_geometry_state()
    upper_sign = _lip_sign_from_config(lg, "upperSign", 1.0)
    lower_sign = _lip_sign_from_config(lg, "lowerSign", 1.0)
    require_ready = bool(lg.get("requireNeutralReadyForOutput", True))

    empty_y = _axis4_zero()
    drift_dbg: dict[str, Any] = {
        "enabled": bool(lg.get("driftCorrectionEnabled", True)),
        "allowed": False,
        "updated": False,
        "reason": "",
        "stepUpperL": 0.0,
        "stepUpperR": 0.0,
        "stepLowerL": 0.0,
        "stepLowerR": 0.0,
    }
    lock_dbg: dict[str, Any] = {
        "enabled": bool(lg.get("closedHeadTurnLockEnabled", True)),
        "active": False,
        "headMotionActive": False,
        "closedMouthLike": False,
        "lipAbsMax": 0.0,
        "lipAbsUsedAsVeto": bool(lg.get("closedHeadTurnUseLipAbsAsVeto", False)),
        "lipVetoTriggered": False,
        "jawAbs": 0.0,
        "evidence": {
            "aperture": {"available": False, "deltaAbs": 0.0, "threshold": float(_safe_float(lg.get("closedHeadTurnApertureDeltaMax"), 0.018)), "ok": True},
            "blendshape": {
                "available": False,
                "mouthOpen": 0.0,
                "jawOpen": 0.0,
                "smileAbs": 0.0,
                "thresholds": {
                    "mouthOpenMax": float(_safe_float(lg.get("closedHeadTurnMouthOpenMax"), 12.0)),
                    "jawOpenMax": float(_safe_float(lg.get("closedHeadTurnJawOpenMax"), 12.0)),
                    "smileMax": float(_safe_float(lg.get("closedHeadTurnSmileMax"), 18.0)),
                },
                "ok": True,
            },
            "corner": {
                "available": False,
                "cornerOffsetAbs": 0.0,
                "threshold": float(_safe_float(lg.get("closedHeadTurnCornerOffsetMax"), 18.0)),
                "ok": True,
            },
        },
        "pose": {
            "yawDelta": 0.0,
            "pitchDelta": 0.0,
            "rollDelta": 0.0,
            "scaleDelta": 0.0,
            "thresholds": {
                "headMotionYawThreshold": float(_safe_float(lg.get("headMotionYawThreshold"), 0.025)),
                "headMotionPitchThreshold": float(_safe_float(lg.get("headMotionPitchThreshold"), 0.045)),
                "headMotionRollThresholdDeg": float(_safe_float(lg.get("headMotionRollThresholdDeg"), 5.0)),
                "headMotionScaleThreshold": float(_safe_float(lg.get("headMotionScaleThreshold"), 0.025)),
            },
            "reasons": [],
        },
        "thresholds": {
            "closedHeadTurnJawAbsMax": float(_safe_float(lg.get("closedHeadTurnJawAbsMax"), 8.0)),
            "closedHeadTurnLipVetoAbsMax": float(_safe_float(lg.get("closedHeadTurnLipVetoAbsMax"), 35.0)),
        },
        "resetPrev": bool(lg.get("closedHeadTurnResetPrev", True)),
    }
    gate_decision: dict[str, Any] = {
        "closedHeadTurnLockApplied": False,
        "poseGateSuppressionApplied": False,
        "frontalPassThrough": False,
        "reason": "init",
    }
    sign_conv_base = {
        "upperOpenPositive": True,
        "lowerOpenNegative": True,
        "upperSign": float(upper_sign),
        "lowerSign": float(lower_sign),
        "yAxisTowardChin": False,
    }

    blend_ul, blend_ur, blend_ll, blend_lr = _blendshape_lip_signed_deltas(
        blend, neutral, gains=gains, invert=invert, deadzone=deadzone, limits=limits,
        dz_lip=dz_lip, lo_lp=lo_lp, hi_lp=hi_lp, up_scale=up_scale, lo_scale=lo_scale,
        _clamp_signed100=_clamp_signed100, _pipe_unipolar_strength=_pipe_unipolar_strength,
    )
    blend_term = {"upperL": float(blend_ul), "upperR": float(blend_ur), "lowerL": float(blend_ll), "lowerR": float(blend_lr)}

    mouth_dbg_ctx = {
        "blend": blend,
        "neutral_bs": neutral,
        "upper_sign": upper_sign,
        "lower_sign": lower_sign,
        "aperture_current": None,
        "upper_inner_y": None,
        "lower_inner_y": None,
        "delta_before_clamp": None,
        "delta_after_clamp": None,
        "raw_mouth_score": float(raw_mouth_score),
    }

    def _finish_dbg(**kwargs) -> dict[str, Any]:
        dbg = _pack_lip_debug(
            lg=lg, st=st, mouth_width=float(kwargs.get("mouth_width", 0.0)),
            current_y=kwargs.get("current_y", empty_y),
            neutral_y=kwargs.get("neutral_y", empty_y),
            delta_raw=kwargs.get("delta_raw", empty_y),
            delta_after_pose_gate=kwargs.get("delta_after_pose_gate", kwargs.get("delta_raw", empty_y)),
            delta_smooth=kwargs.get("delta_smooth", empty_y),
            rig_write=kwargs.get("rig_write", empty_y),
            blend_term=blend_term,
            sign_convention=kwargs.get("sign_convention", sign_conv_base),
            coordinate_mode=str(kwargs.get("coordinate_mode", "unknown")),
            pose=kwargs.get("pose", {}),
            pose_neutral=kwargs.get("pose_neutral", {}),
            pose_gate=kwargs.get("pose_gate", {}),
            closed_head_turn_lock=kwargs.get("closed_head_turn_lock", lock_dbg),
            mouth_scenario=str(kwargs.get("mouth_scenario", "unknown")),
            gate_decision=kwargs.get("gate_decision", gate_decision),
            drift_correction=kwargs.get("drift_correction", drift_dbg),
            stabilizer=kwargs.get("stabilizer", {}),
            source_breakdown=kwargs.get("source_breakdown"),
            cross_talk=kwargs.get("cross_talk"),
            skipped=kwargs.get("skipped", ""),
            mouth_debug=kwargs.get("mouth_debug"),
            blend=mouth_dbg_ctx["blend"],
            neutral_bs=mouth_dbg_ctx["neutral_bs"],
            upper_sign=mouth_dbg_ctx["upper_sign"],
            lower_sign=mouth_dbg_ctx["lower_sign"],
            aperture_current=kwargs.get("aperture_current", mouth_dbg_ctx["aperture_current"]),
            upper_inner_y=kwargs.get("upper_inner_y", mouth_dbg_ctx["upper_inner_y"]),
            lower_inner_y=kwargs.get("lower_inner_y", mouth_dbg_ctx["lower_inner_y"]),
            delta_before_clamp=kwargs.get("delta_before_clamp", mouth_dbg_ctx["delta_before_clamp"]),
            delta_after_clamp=kwargs.get("delta_after_clamp", mouth_dbg_ctx["delta_after_clamp"]),
            raw_mouth_score=float(kwargs.get("raw_mouth_score", mouth_dbg_ctx["raw_mouth_score"])),
        )
        nm = nose_motion if isinstance(nose_motion, dict) else {}
        dbg["noseAnchor"] = dict(nm)
        dbg["noseAnchorMotion"] = bool(nm.get("motionActive") and nm.get("neutralReady"))
        st["last_debug"] = dbg
        return dbg

    if not lip_on:
        _zero_lip_outputs(rig, mapping)
        return _finish_dbg(skipped="lip-disabled")

    if not bool(lg.get("enabled", True)):
        rig["mouth"]["UL"] = blend_ul
        rig["mouth"]["UR"] = blend_ur
        rig["mouth"]["LL"] = blend_ll
        rig["mouth"]["LR"] = blend_lr
        mapping["upperLipLeft"] = float(blend_ul)
        mapping["upperLipRight"] = float(blend_ur)
        mapping["lowerLipLeft"] = float(blend_ll)
        mapping["lowerLipRight"] = float(blend_lr)
        return _finish_dbg(skipped="lipGeometry-disabled", rig_write=blend_term)

    lm = extract_landmarks(result)
    if lm is None:
        _zero_lip_outputs(rig, mapping)
        return _finish_dbg(skipped="no-landmarks")

    pf = build_mouth_pose_frame(lm, lg, get_landmark_xy) if bool(lg.get("poseAwareFrameEnabled", True)) else None
    if isinstance(pf, dict) and bool(pf.get("ok")):
        frame = pf
        mouth_width = float(pf.get("mouthWidth", 0.0))
        coordinate_mode = str(pf.get("coordinateMode", "unknown"))
        current_pose = dict(pf.get("pose") or {})
        y_axis_toward_chin = bool(pf.get("yAxisTowardChin"))
    else:
        frame, mouth_width = _build_mouth_frame(lm, lg, get_landmark_xy)
        coordinate_mode = "2d_fallback"
        y_axis_toward_chin = bool(frame.get("y_axis_toward_chin")) if frame else False
        current_pose = {"rollDeg": 0.0, "yawProxy": 0.0, "pitchProxy": 0.0, "faceScale": float(mouth_width)}
    sign_convention = {**sign_conv_base, "yAxisTowardChin": y_axis_toward_chin}
    if frame is None:
        _zero_lip_outputs(rig, mapping)
        return _finish_dbg(
            mouth_width=mouth_width,
            sign_convention=sign_convention,
            coordinate_mode=coordinate_mode,
            pose=current_pose,
            skipped="mouth-frame-invalid",
        )

    py = frame["projectY"] if "projectY" in frame else frame["project_y"]
    upper_l_pt = _average_landmark_xyz(lm, list(lg.get("upperLeftIndices", [])), get_landmark_xy)
    upper_r_pt = _average_landmark_xyz(lm, list(lg.get("upperRightIndices", [])), get_landmark_xy)
    lower_l_pt = _average_landmark_xyz(lm, list(lg.get("lowerLeftIndices", [])), get_landmark_xy)
    lower_r_pt = _average_landmark_xyz(lm, list(lg.get("lowerRightIndices", [])), get_landmark_xy)
    if None in (upper_l_pt, upper_r_pt, lower_l_pt, lower_r_pt):
        _zero_lip_outputs(rig, mapping)
        return _finish_dbg(
            mouth_width=mouth_width,
            coordinate_mode=coordinate_mode,
            pose=current_pose,
            skipped="lip-points-missing",
        )

    current_y = {
        "upperL": float(py(upper_l_pt)),
        "upperR": float(py(upper_r_pt)),
        "lowerL": float(py(lower_l_pt)),
        "lowerR": float(py(lower_r_pt)),
    }
    jgc = cfg.get("jawGeometry") if isinstance(cfg.get("jawGeometry"), dict) else {}
    upper_inner_idx = int(jgc.get("upperInnerIndex", 13))
    lower_inner_idx = int(jgc.get("lowerInnerIndex", 14))
    upper_inner_pt = _read_point3(lm, upper_inner_idx, get_landmark_xy)
    lower_inner_pt = _read_point3(lm, lower_inner_idx, get_landmark_xy)
    aperture_current = None
    upper_inner_y = None
    lower_inner_y = None
    if upper_inner_pt is not None and lower_inner_pt is not None:
        upper_inner_y = float(py(upper_inner_pt))
        lower_inner_y = float(py(lower_inner_pt))
        aperture_current = float(lower_inner_y - upper_inner_y)
    mouth_dbg_ctx["aperture_current"] = aperture_current
    mouth_dbg_ctx["upper_inner_y"] = upper_inner_y
    mouth_dbg_ctx["lower_inner_y"] = lower_inner_y
    frame_info = _frame_info_from_rig(
        rig=rig, mapping=mapping, blend=blend,
        mouth_width=float(mouth_width), quality=float(quality), face_detected=bool(face_detected),
    )
    candidate = is_lip_neutral_candidate(frame_info, lg)

    still_cal, just_done, cal_hint = _process_neutral_calibration(
        st, lg, current_y=current_y, pose=current_pose, candidate=candidate, now_ms=now_ms,
    )
    neu_y = _axis4_copy(st["neutral"]) if st.get("neutral_ready") else empty_y
    pose_neutral = {
        "rollDeg": float((st.get("neutral") or {}).get("rollDeg", 0.0)),
        "yawProxy": float((st.get("neutral") or {}).get("yawProxy", 0.0)),
        "pitchProxy": float((st.get("neutral") or {}).get("pitchProxy", 0.0)),
        "faceScale": float((st.get("neutral") or {}).get("faceScale", 0.0)),
    }

    if still_cal or just_done or (require_ready and not st.get("neutral_ready")):
        _zero_lip_outputs(rig, mapping)
        skip = "neutral-calibrating" if still_cal else ("neutral-just-completed" if just_done else "neutral-not-ready")
        return _finish_dbg(
            mouth_width=mouth_width, current_y=current_y, neutral_y=neu_y,
            sign_convention=sign_convention, coordinate_mode=coordinate_mode,
            pose=current_pose, pose_neutral=pose_neutral, skipped=f"{skip}:{cal_hint}",
        )

    neu = st["neutral"]
    upper_gain = _safe_float(lg.get("upperGain"), 900.0)
    lower_gain = _safe_float(lg.get("lowerGain"), 900.0)

    prev_smooth = _axis4_copy(st["prev"])
    if is_lip_neutral_candidate(frame_info, lg):
        st["neutral_stable_count"] = int(st.get("neutral_stable_count", 0)) + 1
    else:
        st["neutral_stable_count"] = 0
        st["drift_hold_reason"] = "not-neutral-candidate"

    pose_gate = evaluate_mouth_pose_gate(current_pose, pose_neutral, lg)
    if bool(pose_gate.get("active")):
        drift_allowed, drift_reason = False, "pose-gate-active"
    else:
        drift_allowed, drift_reason = is_lip_drift_update_allowed(
        st=st, lg=lg, frame_info=frame_info, delta_smooth=prev_smooth, now_ms=now_ms,
        )
    drift_dbg["allowed"] = drift_allowed
    drift_dbg["reason"] = drift_reason
    if drift_allowed:
        steps = _apply_drift_correction(st, lg, current_y, now_ms)
        drift_dbg["updated"] = True
        drift_dbg["stepUpperL"] = steps["upperL"]
        drift_dbg["stepUpperR"] = steps["upperR"]
        drift_dbg["stepLowerL"] = steps["lowerL"]
        drift_dbg["stepLowerR"] = steps["lowerR"]
        neu = st["neutral"]

    delta_raw = {
        "upperL": float(_geo_delta_raw(neu["upperL"], current_y["upperL"], upper_gain, upper_sign, _clamp_signed100)),
        "upperR": float(_geo_delta_raw(neu["upperR"], current_y["upperR"], upper_gain, upper_sign, _clamp_signed100)),
        "lowerL": float(_geo_delta_raw(neu["lowerL"], current_y["lowerL"], lower_gain, lower_sign, _clamp_signed100)),
        "lowerR": float(_geo_delta_raw(neu["lowerR"], current_y["lowerR"], lower_gain, lower_sign, _clamp_signed100)),
    }
    delta_after_gain, lip_pipeline = _process_lip_pre_gate_pipeline(delta_raw, lg)
    delta_after_pose_gate = dict(delta_after_gain)
    mouth_motion_evidence = max(abs(delta_raw["upperL"]), abs(delta_raw["upperR"]), abs(delta_raw["lowerL"]), abs(delta_raw["lowerR"]))
    jaw_abs = abs(_safe_float((rig.get("jaw") or {}).get("val"), 0.0))
    yaw_delta = abs(_safe_float(pose_gate.get("yawDelta"), 0.0))
    pitch_delta = abs(_safe_float(pose_gate.get("pitchDelta"), 0.0))
    roll_delta = abs(_safe_float(pose_gate.get("rollDelta"), 0.0))
    scale_delta = abs(_safe_float(pose_gate.get("scaleDelta"), 0.0))
    # 旧的 mouth-pose head motion（受嘴部表情污染），仅保留作为对比。
    old_mouth_pose_head_motion_active = (
        yaw_delta > _safe_float(lg.get("headMotionYawThreshold"), 0.025)
        or pitch_delta > _safe_float(lg.get("headMotionPitchThreshold"), 0.045)
        or roll_delta > _safe_float(lg.get("headMotionRollThresholdDeg"), 5.0)
        or scale_delta > _safe_float(lg.get("headMotionScaleThreshold"), 0.025)
    )
    # Nose Anchor Gate V1：head motion 改由鼻部锚点判断，避免眼角/脸颊/嘴部表情污染。
    nose_dbg = nose_motion if isinstance(nose_motion, dict) else {}
    nose_ready = bool(nose_dbg.get("neutralReady"))
    nose_enabled = bool(nose_dbg.get("enabled", True)) and bool(nose_dbg) and ("motionActive" in nose_dbg)
    nose_anchor_motion = bool(nose_dbg.get("motionActive")) if (nose_enabled and nose_ready) else False
    if nose_enabled and nose_ready:
        head_motion_active = nose_anchor_motion
    else:
        # 鼻部锚点未就绪时回退到旧的 mouth-pose 判断。
        head_motion_active = old_mouth_pose_head_motion_active
    aperture_delta_abs = None
    aperture_available = aperture_current is not None and isinstance(neu, dict) and ("aperture" in neu)
    if aperture_available:
        aperture_delta_abs = abs(float(aperture_current) - float(neu.get("aperture", 0.0)))
    use_aperture_evidence = bool(lg.get("closedHeadTurnUseApertureEvidence", True))
    ap_thr = _safe_float(lg.get("closedHeadTurnApertureDeltaMax"), 0.018)
    aperture_ok = (not use_aperture_evidence) or (not aperture_available) or (float(aperture_delta_abs or 0.0) < ap_thr)

    mouth_open_available = "mouthOpen" in blend
    mouth_open_bs = abs((_safe_float(blend.get("mouthOpen"), 0.0) - _safe_float(neutral.get("mouthOpen"), 0.0)) * 100.0) if mouth_open_available else 0.0
    jaw_open_bs = abs((_safe_float(blend.get("jawOpen"), 0.0) - _safe_float(neutral.get("jawOpen"), 0.0)) * 100.0)
    smile_abs = max(abs(_safe_float(mapping.get("smileLeft"), 0.0)), abs(_safe_float(mapping.get("smileRight"), 0.0)))
    use_blend_evidence = bool(lg.get("closedHeadTurnUseBlendshapeEvidence", True))
    mouth_open_thr = _safe_float(lg.get("closedHeadTurnMouthOpenMax"), 12.0)
    jaw_open_thr = _safe_float(lg.get("closedHeadTurnJawOpenMax"), 12.0)
    smile_thr = _safe_float(lg.get("closedHeadTurnSmileMax"), 18.0)
    blendshape_available = mouth_open_available or ("jawOpen" in blend) or ("smileLeft" in mapping) or ("smileRight" in mapping)
    blendshape_ok = (not use_blend_evidence) or (not blendshape_available) or (
        (not mouth_open_available or mouth_open_bs < mouth_open_thr)
        and jaw_open_bs < jaw_open_thr
        and smile_abs < smile_thr
    )

    side_l = (rig.get("mouth") or {}).get("sideL") if isinstance((rig.get("mouth") or {}).get("sideL"), dict) else None
    side_r = (rig.get("mouth") or {}).get("sideR") if isinstance((rig.get("mouth") or {}).get("sideR"), dict) else None
    corner_available = side_l is not None and side_r is not None
    corner_offset_abs = 0.0
    if corner_available:
        corner_offset_abs = max(
            abs(_safe_float(side_l.get("x"), 50.0) - 50.0),
            abs(_safe_float(side_l.get("y"), 50.0) - 50.0),
            abs(_safe_float(side_r.get("x"), 50.0) - 50.0),
            abs(_safe_float(side_r.get("y"), 50.0) - 50.0),
        )
    use_corner_evidence = bool(lg.get("closedHeadTurnUseCornerEvidence", True))
    corner_thr = _safe_float(lg.get("closedHeadTurnCornerOffsetMax"), 18.0)
    corner_ok = (not use_corner_evidence) or (not corner_available) or (corner_offset_abs < corner_thr)

    closed_mouth_like = (
        jaw_abs < _safe_float(lg.get("closedHeadTurnJawAbsMax"), 8.0)
        and aperture_ok
        and blendshape_ok
        and corner_ok
    )
    lip_veto_on = bool(lg.get("closedHeadTurnUseLipAbsAsVeto", False))
    lip_veto_thr = _safe_float(lg.get("closedHeadTurnLipVetoAbsMax"), 35.0)
    lip_veto_triggered = lip_veto_on and (mouth_motion_evidence > lip_veto_thr)
    if lip_veto_triggered:
        closed_mouth_like = False
    # mouthMotionScore：综合多路嘴部证据（不让单独 lipAbs 主导，也不用 head motion 判断嘴动）。
    aperture_delta_scaled = float(aperture_delta_abs or 0.0) * 300.0
    mouth_motion_score = max(
        mouth_motion_evidence,
        jaw_abs,
        aperture_delta_scaled,
        mouth_open_bs,
        jaw_open_bs,
        corner_offset_abs,
    )
    # Evidence-First：finalScenario 由中央 classifier 统一产出（lip / jaw 共用）。
    # 若未传入则回退到本地综合判断（兼容旧调用）。
    if final_scenario is not None:
        mouth_scenario = str(final_scenario)
    else:
        msc = cfg.get("mouthScenario") if isinstance(cfg.get("mouthScenario"), dict) else {}
        frontal_thr = max(0.0, _safe_float(msc.get("frontalMouthMotionThreshold", lg.get("frontalMouthMotionThreshold")), 4.0))
        neutral_thr = max(0.0, _safe_float(msc.get("neutralThreshold", lg.get("neutralThreshold")), 2.0))
        if (not head_motion_active) and mouth_motion_score < neutral_thr:
            mouth_scenario = "neutral_still"
        elif head_motion_active and mouth_motion_score < frontal_thr:
            mouth_scenario = "closed_head_turn"
        elif (not head_motion_active) and mouth_motion_score >= frontal_thr:
            mouth_scenario = "frontal_mouth_motion"
        else:
            mouth_scenario = "unknown"
    closed_head_lock_active = bool(lg.get("closedHeadTurnLockEnabled", True)) and bool(st.get("neutral_ready")) and (
        mouth_scenario == "closed_head_turn"
    )
    lock_dbg = {
        **lock_dbg,
        "active": bool(closed_head_lock_active),
        "headMotionActive": bool(head_motion_active),
        "noseAnchorMotion": bool(nose_anchor_motion),
        "oldMouthPoseHeadMotionActive": bool(old_mouth_pose_head_motion_active),
        "mouthMotionScore": float(mouth_motion_score),
        "mouthScenario": str(mouth_scenario),
        "closedMouthLike": bool(closed_mouth_like),
        "lipAbsMax": float(mouth_motion_evidence),
        "lipAbsUsedAsVeto": bool(lip_veto_on),
        "lipVetoTriggered": bool(lip_veto_triggered),
        "jawAbs": float(jaw_abs),
        "evidence": {
            "aperture": {
                "available": bool(aperture_available),
                "deltaAbs": float(aperture_delta_abs or 0.0),
                "threshold": float(ap_thr),
                "ok": bool(aperture_ok),
            },
            "blendshape": {
                "available": bool(blendshape_available),
                "mouthOpen": float(mouth_open_bs),
                "jawOpen": float(jaw_open_bs),
                "smileAbs": float(smile_abs),
                "thresholds": {
                    "mouthOpenMax": float(mouth_open_thr),
                    "jawOpenMax": float(jaw_open_thr),
                    "smileMax": float(smile_thr),
                },
                "ok": bool(blendshape_ok),
            },
            "corner": {
                "available": bool(corner_available),
                "cornerOffsetAbs": float(corner_offset_abs),
                "threshold": float(corner_thr),
                "ok": bool(corner_ok),
            },
        },
        "pose": {
            "yawDelta": float(yaw_delta),
            "pitchDelta": float(pitch_delta),
            "rollDelta": float(roll_delta),
            "scaleDelta": float(scale_delta),
            "thresholds": {
                "headMotionYawThreshold": float(_safe_float(lg.get("headMotionYawThreshold"), 0.025)),
                "headMotionPitchThreshold": float(_safe_float(lg.get("headMotionPitchThreshold"), 0.045)),
                "headMotionRollThresholdDeg": float(_safe_float(lg.get("headMotionRollThresholdDeg"), 5.0)),
                "headMotionScaleThreshold": float(_safe_float(lg.get("headMotionScaleThreshold"), 0.025)),
            },
            "reasons": list(pose_gate.get("reasons") or []),
        },
    }
    # Gate 完全由 finalScenario 驱动（不再让 poseGate / noseAnchorMotion 直接误杀正面嘴动）。
    pose_suppressed_lip = False
    if closed_head_lock_active:
        zero_val = float(_safe_float(lg.get("closedHeadTurnOutputClamp"), 0.0))
        delta_after_pose_gate = {k: zero_val for k in _LIP_KEYS}
        if bool(lg.get("closedHeadTurnResetPrev", True)):
            st["prev"] = _axis4_zero()
            st["prev_raw"] = _axis4_zero()
        for k in _LIP_KEYS:
            st["locked_to_zero"][k] = True
        drift_allowed = False
        drift_reason = "closed-head-turn-lock"
        drift_dbg["allowed"] = False
        drift_dbg["reason"] = "closed-head-turn-lock"
        gate_decision = {
            "finalScenario": str(mouth_scenario),
            "closedHeadTurnLockApplied": True,
            "poseGateSuppressionApplied": False,
            "frontalPassThrough": False,
            "reason": "closed-head-turn-lock",
        }
    elif mouth_scenario == "frontal_mouth_motion":
        # 正面嘴动直通：pre-gate 输出原样进 smoothing，不 clamp 到 ±5。
        delta_after_pose_gate = dict(delta_after_gain)
        gate_decision = {
            "finalScenario": str(mouth_scenario),
            "closedHeadTurnLockApplied": False,
            "poseGateSuppressionApplied": False,
            "frontalPassThrough": True,
            "reason": "frontal-pass-through",
        }
    elif mouth_scenario == "head_motion_mouth_motion":
        # 转头同时说话 / Open-Close Guard：保守输出，避免设备乱动。
        msc = cfg.get("mouthScenario") if isinstance(cfg.get("mouthScenario"), dict) else {}
        # Open-Close Guard 触发时用 openCloseOutputScale（更宽松），否则默认 head motion 抑制比例。
        if head_motion_output_scale is not None:
            hm_scale = clamp(float(head_motion_output_scale), 0.0, 1.0)
        else:
            hm_scale = clamp(
                _safe_float(
                    msc.get("headMotionMouthLipScale"),
                    _safe_float(msc.get("headMotionLipSuppressScale"), 0.95),
                ),
                0.0,
                1.0,
            )
        delta_after_pose_gate = {k: float(delta_after_gain[k]) * hm_scale for k in _LIP_KEYS}
        pose_suppressed_lip = True
        gate_decision = {
            "finalScenario": str(mouth_scenario),
            "closedHeadTurnLockApplied": False,
            "poseGateSuppressionApplied": True,
            "frontalPassThrough": False,
            "headMotionMouthSuppressScale": float(hm_scale),
            "openCloseGuardScale": head_motion_output_scale is not None,
            "reason": "head-motion-mouth-motion",
        }
    elif mouth_scenario == "neutral_still":
        # 正常 deadband / snapToZero（在 stabilizer 中处理）。
        delta_after_pose_gate = dict(delta_after_gain)
        gate_decision = {
            "finalScenario": str(mouth_scenario),
            "closedHeadTurnLockApplied": False,
            "poseGateSuppressionApplied": False,
            "frontalPassThrough": False,
            "reason": "neutral-still",
        }
    else:
        # unknown：保守轻度 suppress，但不完全误杀。
        suppress_scale = clamp(_safe_float(lg.get("poseMotionSuppressScale"), 0.20), 0.0, 1.0)
        clamp_abs = max(0.0, _safe_float(lg.get("poseGateOutputClamp"), 5.0))
        delta_after_pose_gate = {k: clamp(float(delta_after_gain[k]) * suppress_scale, -clamp_abs, clamp_abs) for k in _LIP_KEYS}
        pose_suppressed_lip = True
        gate_decision = {
            "finalScenario": str(mouth_scenario),
            "closedHeadTurnLockApplied": False,
            "poseGateSuppressionApplied": True,
            "frontalPassThrough": False,
            "reason": "unknown-conservative",
        }
    pose_gate = {
        **pose_gate,
        "suppressedLip": bool(pose_suppressed_lip),
        "mouthMotionEvidence": float(mouth_motion_evidence),
    }

    delta_after_pose_gate, scenario_blend_dbg = _apply_scenario_gate_blend(
        st, delta_after_pose_gate, mouth_scenario, lg
    )
    gate_decision = {**gate_decision, "scenarioBlend": scenario_blend_dbg}

    lip_pipeline["afterGate"] = dict(delta_after_pose_gate)

    delta_before_clamp = dict(delta_after_pose_gate)
    mouth_dbg_ctx["delta_before_clamp"] = delta_before_clamp

    # Lip Geometry V2: jaw 与 lip 完全解耦。jaw 不参与 lip 计算。
    delta_geo = {
        "upperL": float(delta_after_pose_gate["upperL"]),
        "upperR": float(delta_after_pose_gate["upperR"]),
        "lowerL": float(delta_after_pose_gate["lowerL"]),
        "lowerR": float(delta_after_pose_gate["lowerR"]),
    }

    jaw_open_norm = _jaw_open_norm(blend, neutral)
    oc_fast_release = _maybe_arm_open_close_fast_release(
        st,
        lg,
        jaw_open_norm=jaw_open_norm,
        open_close_guard_active=bool(open_close_guard_active),
        raw_mouth_score=float(raw_mouth_score),
    )
    max_lip_ctrl, lip_cap_dbg = _resolve_max_lip_control_abs(
        jaw_open_norm,
        lg,
        open_close_guard_active=bool(open_close_guard_active),
        raw_mouth_score=float(raw_mouth_score),
    )
    delta_geo = _cap_lip_channels(delta_geo, max_lip_ctrl)

    delta_xtalk, xt_dbg = _apply_lip_cross_talk(delta_geo, lg)
    lg_stab = {**lg, "deadzone": 0.0}
    delta_smooth, stabilizer = _stabilize_all_channels(delta_xtalk, st, lg_stab)
    delta_smooth = _cap_lip_channels(delta_smooth, max_lip_ctrl)
    mouth_dbg_ctx["delta_after_clamp"] = dict(delta_smooth)
    st["fast_release_lip"] = False
    lip_pipeline["afterSmooth"] = dict(delta_smooth)
    lip_pipeline["final"] = dict(delta_smooth)
    lip_pipeline["lipControlCap"] = {
        **lip_cap_dbg,
        "openCloseFastReleaseActive": bool(oc_fast_release),
    }

    mix = clamp(_safe_float(lg.get("blendshapeMix"), 0.08), 0.0, 1.0)
    w_geo = 1.0 - mix
    rig_write_raw = {
        "upperL": float(_clamp_signed100(delta_smooth["upperL"] * w_geo + blend_ul * mix)),
        "upperR": float(_clamp_signed100(delta_smooth["upperR"] * w_geo + blend_ur * mix)),
        "lowerL": float(_clamp_signed100(delta_smooth["lowerL"] * w_geo + blend_ll * mix)),
        "lowerR": float(_clamp_signed100(delta_smooth["lowerR"] * w_geo + blend_lr * mix)),
    }
    rig_write_final = _finalize_mouth_rig_write(rig_write_raw, lg)
    rig_write = {
        "upperL": rig_write_final["UL"],
        "upperR": rig_write_final["UR"],
        "lowerL": rig_write_final["LL"],
        "lowerR": rig_write_final["LR"],
    }

    src_breakdown = {
        "upperGeometry": {"upperL": delta_raw["upperL"], "upperR": delta_raw["upperR"]},
        "lowerGeometry": {"lowerL": delta_raw["lowerL"], "lowerR": delta_raw["lowerR"]},
        "jawContributionToLip": 0.0,
        "apertureTerm": 0.0,
        "jawTerm": 0.0,
    }

    rig["mouth"]["UL"] = rig_write["upperL"]
    rig["mouth"]["UR"] = rig_write["upperR"]
    rig["mouth"]["LL"] = rig_write["lowerL"]
    rig["mouth"]["LR"] = rig_write["lowerR"]

    mapping["lipGeoUpperL"] = delta_smooth["upperL"]
    mapping["lipGeoUpperR"] = delta_smooth["upperR"]
    mapping["lipGeoLowerL"] = delta_smooth["lowerL"]
    mapping["lipGeoLowerR"] = delta_smooth["lowerR"]
    mapping["upperLipLeft"] = rig_write["upperL"]
    mapping["upperLipRight"] = rig_write["upperR"]
    mapping["lowerLipLeft"] = rig_write["lowerL"]
    mapping["lowerLipRight"] = rig_write["lowerR"]

    dbg = _finish_dbg(
        mouth_width=mouth_width,
        current_y=current_y,
        neutral_y=_axis4_copy(neu),
        delta_raw=delta_raw,
        delta_after_pose_gate=delta_after_pose_gate,
        delta_smooth=delta_smooth,
        rig_write=rig_write,
        sign_convention=sign_convention,
        coordinate_mode=coordinate_mode,
        pose=current_pose,
        pose_neutral=pose_neutral,
        pose_gate=pose_gate,
        closed_head_turn_lock=lock_dbg,
        mouth_scenario=mouth_scenario,
        gate_decision=gate_decision,
        drift_correction=drift_dbg,
        stabilizer=stabilizer,
        source_breakdown=src_breakdown,
        cross_talk=xt_dbg,
        skipped="",
    )
    dbg["lipPipeline"] = lip_pipeline
    return dbg


def compute_lip_raw_evidence(
    result: Any,
    cfg: dict[str, Any],
    lip_state: dict[str, Any] | None,
) -> dict[str, Any]:
    """Mouth-Evidence-First：返回 lip 的 raw 证据（pre-gate / pre-smoothing）。

    只用 deltaRaw（neutral 与 current 的几何差），不使用 gate / smooth / rigWrite。
    """
    _clamp_signed100, _pipe, extract_landmarks, get_landmark_xy = _rig_helpers()
    lg = normalize_lip_geometry_config(cfg.get("lipGeometry"))
    st = lip_state if isinstance(lip_state, dict) else {}
    out = {
        "lipAbsMax": 0.0,
        "available": {"lip": False},
        "pose": {"rollDeg": 0.0, "yawProxy": 0.0, "pitchProxy": 0.0, "faceScale": 0.0},
        "poseNeutral": {"rollDeg": 0.0, "yawProxy": 0.0, "pitchProxy": 0.0, "faceScale": 0.0},
        "mouthPoseMotionScore": 0.0,
    }
    if not bool(st.get("neutral_ready")):
        return out
    lm = extract_landmarks(result)
    if lm is None:
        return out
    pf = build_mouth_pose_frame(lm, lg, get_landmark_xy) if bool(lg.get("poseAwareFrameEnabled", True)) else None
    if isinstance(pf, dict) and bool(pf.get("ok")):
        frame = pf
        current_pose = dict(pf.get("pose") or {})
    else:
        frame, _mw = _build_mouth_frame(lm, lg, get_landmark_xy)
        current_pose = {"rollDeg": 0.0, "yawProxy": 0.0, "pitchProxy": 0.0, "faceScale": float(_mw or 0.0)}
    if frame is None:
        return out
    py = frame["projectY"] if "projectY" in frame else frame["project_y"]
    upper_l_pt = _average_landmark_xyz(lm, list(lg.get("upperLeftIndices", [])), get_landmark_xy)
    upper_r_pt = _average_landmark_xyz(lm, list(lg.get("upperRightIndices", [])), get_landmark_xy)
    lower_l_pt = _average_landmark_xyz(lm, list(lg.get("lowerLeftIndices", [])), get_landmark_xy)
    lower_r_pt = _average_landmark_xyz(lm, list(lg.get("lowerRightIndices", [])), get_landmark_xy)
    if None in (upper_l_pt, upper_r_pt, lower_l_pt, lower_r_pt):
        return out
    current_y = {
        "upperL": float(py(upper_l_pt)),
        "upperR": float(py(upper_r_pt)),
        "lowerL": float(py(lower_l_pt)),
        "lowerR": float(py(lower_r_pt)),
    }
    neu = st.get("neutral") or {}
    upper_gain = _safe_float(lg.get("upperGain"), 900.0)
    lower_gain = _safe_float(lg.get("lowerGain"), 900.0)
    upper_sign = _lip_sign_from_config(lg, "upperSign", 1.0)
    lower_sign = _lip_sign_from_config(lg, "lowerSign", 1.0)
    delta_raw = {
        "upperL": float(_geo_delta_raw(_safe_float(neu.get("upperL"), 0.0), current_y["upperL"], upper_gain, upper_sign, _clamp_signed100)),
        "upperR": float(_geo_delta_raw(_safe_float(neu.get("upperR"), 0.0), current_y["upperR"], upper_gain, upper_sign, _clamp_signed100)),
        "lowerL": float(_geo_delta_raw(_safe_float(neu.get("lowerL"), 0.0), current_y["lowerL"], lower_gain, lower_sign, _clamp_signed100)),
        "lowerR": float(_geo_delta_raw(_safe_float(neu.get("lowerR"), 0.0), current_y["lowerR"], lower_gain, lower_sign, _clamp_signed100)),
    }
    lip_abs_max = max(abs(delta_raw["upperL"]), abs(delta_raw["upperR"]), abs(delta_raw["lowerL"]), abs(delta_raw["lowerR"]))
    pose_neutral = {
        "rollDeg": _safe_float(neu.get("rollDeg"), 0.0),
        "yawProxy": _safe_float(neu.get("yawProxy"), 0.0),
        "pitchProxy": _safe_float(neu.get("pitchProxy"), 0.0),
        "faceScale": _safe_float(neu.get("faceScale"), 0.0),
    }
    ns = max(1e-6, _safe_float(pose_neutral.get("faceScale"), 1.0))
    mouth_pose_motion_score = max(
        abs(_safe_float(current_pose.get("yawProxy"), 0.0) - pose_neutral["yawProxy"]),
        abs(_safe_float(current_pose.get("pitchProxy"), 0.0) - pose_neutral["pitchProxy"]),
        abs(_safe_float(current_pose.get("faceScale"), ns) - ns) / ns,
        abs(_safe_float(current_pose.get("rollDeg"), 0.0) - pose_neutral["rollDeg"]) / 40.0,
    )
    return {
        "lipAbsMax": float(lip_abs_max),
        "deltaRaw": delta_raw,
        "available": {"lip": True},
        "pose": current_pose,
        "poseNeutral": pose_neutral,
        "mouthPoseMotionScore": float(mouth_pose_motion_score),
    }


def lip_geometry_overlay_indices(cfg: dict[str, Any] | None = None) -> tuple[int, ...]:
    lg = normalize_lip_geometry_config(
        cfg.get("lipGeometry") if isinstance(cfg, dict) else None
    )
    indices: set[int] = {
        int(lg.get("leftCornerIndex", 61)),
        int(lg.get("rightCornerIndex", 291)),
        int(lg.get("chinIndex", 152)),
    }
    for key in ("upperLeftIndices", "upperRightIndices", "lowerLeftIndices", "lowerRightIndices"):
        for i in lg.get(key) or []:
            indices.add(int(i))
    return tuple(sorted(indices))
