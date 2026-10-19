"""mediapipe_iris_only_v1：眼眶局部 iris offset → sharedRadar（无 session 校准）。"""

from __future__ import annotations

import math
import statistics
from typing import Any, Callable

LEFT_IRIS_IDX = tuple(range(468, 473))
RIGHT_IRIS_IDX = tuple(range(473, 478))
LEFT_EYE_OUTER = 33
LEFT_EYE_INNER = 133
RIGHT_EYE_OUTER = 263
RIGHT_EYE_INNER = 362

IRIS_ONLY_MODE = "mediapipe_iris_only_v1"


def _safe_float(v: Any, fallback: float = 0.0) -> float:
    try:
        n = float(v)
        if n != n or n in (float("inf"), float("-inf")):
            return fallback
        return n
    except (TypeError, ValueError):
        return fallback


def _clamp(v: float, lo: float, hi: float) -> float:
    return float(max(lo, min(hi, v)))


def _soft_norm(v: float, *, gain: float, knee: float) -> float:
    """tanh 软限幅，避免小 delta × 高 gain 直接钉死在 ±1。"""
    k = max(1e-6, float(knee))
    return float(math.tanh(float(v) * float(gain) / k))


def _pick_iris_y_gain(
    drive_y: float,
    y_sign: float,
    gz: dict[str, Any],
) -> float:
    """垂直 iris 几何对下视幅度约为上视 1/3，对输出向下单独提高 gain。"""
    up_gain = _safe_float(gz.get("irisYGainUp"), _safe_float(gz.get("irisYGain"), 5.0))
    down_gain = _safe_float(
        gz.get("irisYGainDown"),
        up_gain * _safe_float(gz.get("irisYGainDownRatio"), 2.6),
    )
    effective = float(drive_y) * float(y_sign)
    return float(down_gain if effective < 0.0 else up_gain)


def _frame_head_motion_px(st: dict[str, Any], gz: dict[str, Any]) -> float:
    fm = st.get("init_frame_motion")
    if not isinstance(fm, dict):
        return 0.0
    vals = [
        _safe_float(fm.get("noseDeltaPx"), 0.0),
        _safe_float(fm.get("eyeCenterDeltaPx"), 0.0),
        _safe_float(fm.get("faceBoxCenterDeltaPx"), 0.0),
    ]
    return float(max(vals))


def _lerp(a: float, b: float, t: float) -> float:
    return float(a + (b - a) * t)


def _median(values: list[float]) -> float:
    if not values:
        return 0.0
    return float(statistics.median(values))


def _compute_eye_local_iris_offset(
    lm: Any,
    iris_indices: tuple[int, ...],
    outer_idx: int,
    inner_idx: int,
    get_xy: Callable[[Any, int], tuple[float, float] | None],
) -> tuple[float, float, float] | None:
    """iris 相对眼眶 inner-outer 轴的局部 offset；eye contour 仅作坐标锚点。"""
    iris_pts: list[tuple[float, float]] = []
    for i in iris_indices:
        p = get_xy(lm, i)
        if p:
            iris_pts.append(p)
    if len(iris_pts) < 2:
        return None

    outer = get_xy(lm, outer_idx)
    inner = get_xy(lm, inner_idx)
    if not outer or not inner:
        return None

    iris_cx = sum(p[0] for p in iris_pts) / len(iris_pts)
    iris_cy = sum(p[1] for p in iris_pts) / len(iris_pts)
    eye_cx = (outer[0] + inner[0]) * 0.5
    eye_cy = (outer[1] + inner[1]) * 0.5

    vx = inner[0] - outer[0]
    vy = inner[1] - outer[1]
    eye_width = math.hypot(vx, vy)
    if eye_width < 1e-6:
        return None

    ux = vx / eye_width
    uy = vy / eye_width
    perp_x = -uy
    perp_y = ux

    rx = iris_cx - eye_cx
    ry = iris_cy - eye_cy
    local_x = (rx * ux + ry * uy) / eye_width
    local_y = (rx * perp_x + ry * perp_y) / eye_width
    local_x = _clamp(local_x, -1.5, 1.5)
    local_y = _clamp(local_y, -1.5, 1.5)
    return float(local_x), float(local_y), float(eye_width)


def reset_iris_gaze_runtime(gaze_state: dict[str, Any]) -> None:
    """摄像头 / sourceEpoch / session 变化时清空 iris 输出状态。"""
    gaze_state.pop("_iris_init_session", None)
    gaze_state.pop("iris_init", None)
    gaze_state.pop("baseline_lx", None)
    gaze_state.pop("baseline_ly", None)
    gaze_state.pop("_warmup_lx", None)
    gaze_state.pop("_warmup_ly", None)
    gaze_state.pop("iris_warmup_frame", None)
    gaze_state["iris_warmup_done"] = False
    gaze_state["iris_x_norm"] = 0.0
    gaze_state["iris_y_norm"] = 0.0
    gaze_state["last_emit"] = {"x": 50.0, "y": 50.0}
    gaze_state["iris_missing_count"] = 0
    gaze_state.pop("iris_blink_hold", None)
    gaze_state.pop("iris_blink_freeze_active", None)
    gaze_state.pop("iris_blink_release_count", None)
    gaze_state.pop("iris_blink_freeze_frames", None)
    gaze_state.pop("iris_blink_level", None)
    gaze_state.pop("iris_blink_release_blend", None)
    gaze_state.pop("iris_blink_release_from", None)
    gaze_state.pop("iris_blink_last_hold", None)


def _iris_blink_level(raw_blink_l: float, raw_blink_r: float) -> float:
    return max(_safe_float(raw_blink_l), _safe_float(raw_blink_r))


def _iris_blink_enter_threshold(gz: dict[str, Any]) -> float:
    return _safe_float(
        gz.get("blinkFreezeEnterThreshold"),
        _safe_float(gz.get("blinkFreezeThreshold"), 0.48),
    )


def _iris_blink_release_threshold(gz: dict[str, Any]) -> float:
    return _safe_float(gz.get("blinkFreezeReleaseThreshold"), 0.38)


def _iris_blink_instant_threshold(gz: dict[str, Any]) -> float:
    return _safe_float(gz.get("blinkInstantHoldThreshold"), 0.42)


def _iris_blink_blocks_warmup(raw_blink_l: float, raw_blink_r: float, gz: dict[str, Any]) -> bool:
    if not bool(gz.get("freezeOnBlink", True)):
        return False
    blink = _iris_blink_level(raw_blink_l, raw_blink_r)
    thr = _safe_float(gz.get("blinkWarmupBlockThreshold"), _iris_blink_enter_threshold(gz))
    return blink >= thr


def _iris_update_blink_freeze_state(
    st: dict[str, Any],
    lemit: dict[str, Any],
    raw_blink_l: float,
    raw_blink_r: float,
    gz: dict[str, Any],
) -> tuple[bool, str, float, bool]:
    """眨眼冻结状态机；仅在明显闭眼时进入，释放后由调用方做平滑过渡。"""
    blink = _iris_blink_level(raw_blink_l, raw_blink_r)
    if not bool(gz.get("freezeOnBlink", True)):
        st.pop("iris_blink_hold", None)
        st["iris_blink_freeze_active"] = False
        st["iris_blink_release_count"] = 0
        st["iris_blink_freeze_frames"] = 0
        st["iris_blink_level"] = blink
        return False, "", blink, False

    enter_thr = _iris_blink_enter_threshold(gz)
    release_thr = _iris_blink_release_threshold(gz)
    hold_frames = max(1, int(_safe_float(gz.get("blinkFreezeReleaseHoldFrames"), 3)))
    max_frames = max(hold_frames + 1, int(_safe_float(gz.get("blinkFreezeMaxFrames"), 10)))

    was_active = bool(st.get("iris_blink_freeze_active", False))
    active = was_active
    release_count = int(st.get("iris_blink_release_count", 0))
    freeze_frames = int(st.get("iris_blink_freeze_frames", 0))
    reason = ""

    if not active:
        if blink >= enter_thr:
            active = True
            release_count = 0
            freeze_frames = 0
            reason = "blink_enter"
            st["iris_blink_hold"] = {
                "x": _safe_float(lemit.get("x"), 50.0),
                "y": _safe_float(lemit.get("y"), 50.0),
                "xn": _safe_float(st.get("iris_x_norm"), 0.0),
                "yn": _safe_float(st.get("iris_y_norm"), 0.0),
            }
    else:
        freeze_frames += 1
        if blink <= release_thr:
            release_count += 1
            reason = "blink_release_wait"
        else:
            release_count = 0
            reason = "blink_hold"
        timed_out = freeze_frames >= max_frames
        if release_count >= hold_frames or timed_out:
            hold = st.get("iris_blink_hold")
            if isinstance(hold, dict):
                st["iris_blink_last_hold"] = dict(hold)
            active = False
            release_count = 0
            freeze_frames = 0
            st.pop("iris_blink_hold", None)
            reason = "blink_max_hold" if timed_out else ""

    st["iris_blink_freeze_active"] = active
    st["iris_blink_release_count"] = release_count
    st["iris_blink_freeze_frames"] = freeze_frames if active else 0
    st["iris_blink_level"] = blink
    just_released = was_active and not active
    return active, reason, blink, just_released


def _iris_begin_blink_release_blend(st: dict[str, Any], gz: dict[str, Any]) -> None:
    hold = st.pop("iris_blink_last_hold", None)
    if not isinstance(hold, dict):
        hold = st.get("iris_blink_hold")
    if not isinstance(hold, dict):
        lemit = st.get("last_emit")
        hold = {
            "x": _safe_float(lemit.get("x") if isinstance(lemit, dict) else None, 50.0),
            "y": _safe_float(lemit.get("y") if isinstance(lemit, dict) else None, 50.0),
        }
    blend_frames = max(1, int(_safe_float(gz.get("blinkReleaseBlendFrames"), 2)))
    st["iris_blink_release_from"] = {
        "x": _safe_float(hold.get("x"), 50.0),
        "y": _safe_float(hold.get("y"), 50.0),
    }
    st["iris_blink_release_blend"] = blend_frames


def _iris_apply_blink_output_gate(
    *,
    st: dict[str, Any],
    gz: dict[str, Any],
    freeze_active: bool,
    freeze_reason: str,
    blink_level: float,
    last_ex: float,
    last_ey: float,
    last_xn: float,
    last_yn: float,
    cand_x: float,
    cand_y: float,
    emit_x: float,
    emit_y: float,
    x_norm: float,
    y_norm: float,
) -> tuple[float, float, float, float, str, bool, str]:
    """冻结时仅覆盖输出；释放时用若干帧平滑回到实时追踪。"""
    if freeze_active:
        hold = st.get("iris_blink_hold")
        if not isinstance(hold, dict):
            hold = {"x": emit_x, "y": emit_y, "xn": x_norm, "yn": y_norm}
            st["iris_blink_hold"] = hold
        out_x = _safe_float(hold.get("x"), emit_x)
        out_y = _safe_float(hold.get("y"), emit_y)
        out_xn = _safe_float(hold.get("xn"), x_norm)
        out_yn = _safe_float(hold.get("yn"), y_norm)
        mode = (
            "iris_blink_release_hold"
            if freeze_reason == "blink_release_wait"
            else "iris_blink_hold"
        )
        return out_x, out_y, out_xn, out_yn, mode, True, freeze_reason or "blink_hold"

    blend_left = int(st.get("iris_blink_release_blend", 0))
    if blend_left > 0:
        blend_total = max(1, int(_safe_float(gz.get("blinkReleaseBlendFrames"), 2)))
        fr = st.get("iris_blink_release_from")
        if not isinstance(fr, dict):
            fr = {"x": emit_x, "y": emit_y}
        progress = _clamp((blend_total - blend_left + 1) / blend_total, 0.0, 1.0)
        out_x = _lerp(_safe_float(fr.get("x"), emit_x), emit_x, progress)
        out_y = _lerp(_safe_float(fr.get("y"), emit_y), emit_y, progress)
        st["iris_blink_release_blend"] = blend_left - 1
        if blend_left <= 1:
            st.pop("iris_blink_release_from", None)
        return out_x, out_y, x_norm, y_norm, "iris_blink_release_blend", False, "blink_release_blend"

    if bool(gz.get("freezeOnBlink", True)) and blink_level >= _iris_blink_instant_threshold(gz):
        return (
            float(last_ex),
            float(last_ey),
            float(last_xn),
            float(last_yn),
            "iris_blink_instant",
            True,
            "blink_instant",
        )

    return emit_x, emit_y, x_norm, y_norm, "iris_tracking", False, ""


def _finalize_iris_warmup(st: dict[str, Any]) -> None:
    samples_x = st.get("_warmup_lx")
    samples_y = st.get("_warmup_ly")
    xs = list(samples_x) if isinstance(samples_x, list) else []
    ys = list(samples_y) if isinstance(samples_y, list) else []
    st["baseline_lx"] = _median(xs) if xs else 0.0
    st["baseline_ly"] = _median(ys) if ys else 0.0
    st["iris_warmup_done"] = True
    st.pop("_warmup_lx", None)
    st.pop("_warmup_ly", None)
    st["iris_x_norm"] = 0.0
    st["iris_y_norm"] = 0.0
    st["last_emit"] = {"x": 50.0, "y": 50.0}


def reset_iris_output_center(gaze_state: dict[str, Any]) -> None:
    gaze_state["iris_x_norm"] = 0.0
    gaze_state["iris_y_norm"] = 0.0
    gaze_state["last_emit"] = {"x": 50.0, "y": 50.0}


def _iris_invalid_reason(lm: Any, iris: dict[str, Any]) -> str:
    if not lm:
        return "no_landmarks"
    n = len(lm)
    if n < 468:
        return f"landmark_count_{n}"
    if n < 478:
        return f"landmark_count_{n}_need_iris_478"
    if not iris.get("valid"):
        scale = iris.get("irisLocalScale")
        if isinstance(scale, (int, float)) and math.isfinite(float(scale)):
            return "scale_out_of_range"
        return "iris_local_compute_failed"
    return ""


def _fuse_binocular_iris_local(
    left_local: tuple[float, float, float] | None,
    right_local: tuple[float, float, float] | None,
) -> tuple[float, float, float, str] | None:
    """左右眼 inner-outer 轴镜像，取差分而非 median，避免双眼 gaze 相互抵消。"""
    if left_local is not None and right_local is not None:
        local_x = (float(left_local[0]) - float(right_local[0])) * 0.5
        local_y = (float(left_local[1]) - float(right_local[1])) * 0.5
        local_scale = max(float(left_local[2]), float(right_local[2]))
        return local_x, local_y, local_scale, "binocular_difference_v1"
    if left_local is not None:
        return float(left_local[0]), float(left_local[1]), float(left_local[2]), "monocular_left_v1"
    if right_local is not None:
        return float(right_local[0]), float(right_local[1]), float(right_local[2]), "monocular_right_v1"
    return None


def extract_iris_signal(
    lm: Any,
    *,
    get_xy: Callable[[Any, int], tuple[float, float] | None],
    gaze_cfg: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """生产用 local offset；全局 iris center 仅 debug。"""
    gz = gaze_cfg if isinstance(gaze_cfg, dict) else {}
    out: dict[str, Any] = {
        "valid": False,
        "irisLocalMode": True,
        "landmarkCount": int(len(lm)) if lm else 0,
        "irisLocalX": None,
        "irisLocalY": None,
        "irisLocalScale": None,
        "leftIrisLocalX": None,
        "leftIrisLocalY": None,
        "rightIrisLocalX": None,
        "rightIrisLocalY": None,
        "irisLeftCx": None,
        "irisLeftCy": None,
        "irisRightCx": None,
        "irisRightCy": None,
        "irisCx": None,
        "irisCy": None,
        "irisScale": None,
        "irisLocalFusion": None,
    }
    if not lm or len(lm) < 468:
        out["irisInvalidReason"] = _iris_invalid_reason(lm, out)
        return out

    left_pts: list[tuple[float, float]] = []
    for i in LEFT_IRIS_IDX:
        if i >= len(lm):
            break
        p = get_xy(lm, i)
        if p:
            left_pts.append(p)
    right_pts: list[tuple[float, float]] = []
    for i in RIGHT_IRIS_IDX:
        if i >= len(lm):
            break
        p = get_xy(lm, i)
        if p:
            right_pts.append(p)

    licx = licy = ricx = ricy = None
    if len(left_pts) >= 2:
        licx = sum(p[0] for p in left_pts) / len(left_pts)
        licy = sum(p[1] for p in left_pts) / len(left_pts)
        out["irisLeftCx"] = float(licx)
        out["irisLeftCy"] = float(licy)
    if len(right_pts) >= 2:
        ricx = sum(p[0] for p in right_pts) / len(right_pts)
        ricy = sum(p[1] for p in right_pts) / len(right_pts)
        out["irisRightCx"] = float(ricx)
        out["irisRightCy"] = float(ricy)

    if isinstance(licx, float) and isinstance(ricx, float):
        out["irisCx"] = float((licx + ricx) * 0.5)
        out["irisCy"] = float((licy + ricy) * 0.5)
        out["irisScale"] = float(math.hypot(licx - ricx, licy - ricy))

    left_local = _compute_eye_local_iris_offset(
        lm, LEFT_IRIS_IDX, LEFT_EYE_OUTER, LEFT_EYE_INNER, get_xy
    )
    right_local = _compute_eye_local_iris_offset(
        lm, RIGHT_IRIS_IDX, RIGHT_EYE_OUTER, RIGHT_EYE_INNER, get_xy
    )

    if left_local is not None:
        out["leftIrisLocalX"] = float(left_local[0])
        out["leftIrisLocalY"] = float(left_local[1])
    if right_local is not None:
        out["rightIrisLocalX"] = float(right_local[0])
        out["rightIrisLocalY"] = float(right_local[1])

    fused = _fuse_binocular_iris_local(left_local, right_local)
    if fused is None:
        out["irisInvalidReason"] = _iris_invalid_reason(lm, out)
        return out

    iris_local_x, iris_local_y, iris_local_scale, fusion_mode = fused
    out["irisLocalFusion"] = fusion_mode

    min_scale = max(
        1e-9,
        _safe_float(
            gz.get("irisMinEyeWidth"),
            _safe_float(gz.get("irisMinScale"), 0.001),
        ),
    )
    max_scale = max(
        min_scale,
        _safe_float(
            gz.get("irisMaxEyeWidth"),
            _safe_float(gz.get("irisMaxScale"), 0.5),
        ),
    )
    if not all(math.isfinite(v) for v in (iris_local_x, iris_local_y, iris_local_scale)):
        out["irisInvalidReason"] = "non_finite_local"
        return out
    if iris_local_scale < min_scale or iris_local_scale > max_scale:
        out["irisInvalidReason"] = "scale_out_of_range"
        out["irisLocalX"] = float(iris_local_x)
        out["irisLocalY"] = float(iris_local_y)
        out["irisLocalScale"] = float(iris_local_scale)
        return out

    out["valid"] = True
    out["irisLocalX"] = float(iris_local_x)
    out["irisLocalY"] = float(iris_local_y)
    out["irisLocalScale"] = float(iris_local_scale)
    out["irisInvalidReason"] = ""
    return out


def apply_mediapipe_iris_only_gaze(
    *,
    rig: dict[str, Any],
    mapping: dict[str, float],
    gaze_state: dict[str, Any] | None,
    iris: dict[str, Any],
    gaze_cfg: dict[str, Any],
    limits: dict[str, Any],
    face_detected: bool = True,
    blend: dict[str, float] | None = None,
) -> dict[str, Any]:
    """唯一 gaze XY 生产路径；local_x/y 已是眼眶局部坐标，直接映射 sharedRadar。"""
    gz = gaze_cfg if isinstance(gaze_cfg, dict) else {}
    st = gaze_state if isinstance(gaze_state, dict) else {}
    blend_map = blend if isinstance(blend, dict) else {}
    raw_blink_l = _safe_float(blend_map.get("eyeBlinkLeft"), 0.0)
    raw_blink_r = _safe_float(blend_map.get("eyeBlinkRight"), 0.0)

    if "last_emit" not in st:
        st["last_emit"] = {"x": 50.0, "y": 50.0}
    if "iris_x_norm" not in st:
        st["iris_x_norm"] = 0.0
    if "iris_y_norm" not in st:
        st["iris_y_norm"] = 0.0
    if "iris_missing_count" not in st:
        st["iris_missing_count"] = 0
    lemit = st["last_emit"]

    lim_x = limits.get("eyeLookX", [30.0, 70.0])
    lim_y = limits.get("eyeLookY", [30.0, 70.0])
    lo_x, hi_x = _safe_float(lim_x[0], 30.0), _safe_float(lim_x[1], 70.0)
    lo_y, hi_y = _safe_float(lim_y[0], 30.0), _safe_float(lim_y[1], 70.0)

    icx = iris.get("irisCx")
    icy = iris.get("irisCy")
    invalid_reason = str(iris.get("irisInvalidReason") or "")

    gaze_dbg: dict[str, Any] = {
        "gazeEstimatorMode": IRIS_ONLY_MODE,
        "irisOnlyActive": True,
        "irisLocalMode": True,
        "irisInitState": "iris_tracking",
        "irisInitReady": bool(iris.get("valid")),
        "irisInitShowPrompt": False,
        "landmarkCount": int(iris.get("landmarkCount") or 0),
        "irisInvalidReason": invalid_reason,
        "irisLocalX": iris.get("irisLocalX"),
        "irisLocalY": iris.get("irisLocalY"),
        "irisLocalScale": iris.get("irisLocalScale"),
        "leftIrisLocalX": iris.get("leftIrisLocalX"),
        "leftIrisLocalY": iris.get("leftIrisLocalY"),
        "rightIrisLocalX": iris.get("rightIrisLocalX"),
        "rightIrisLocalY": iris.get("rightIrisLocalY"),
        "irisLeftCx": iris.get("irisLeftCx"),
        "irisLeftCy": iris.get("irisLeftCy"),
        "irisRightCx": iris.get("irisRightCx"),
        "irisRightCy": iris.get("irisRightCy"),
        "irisCx": icx,
        "irisCy": icy,
        "irisScale": iris.get("irisScale"),
        "safeCenterActive": False,
        "available": bool(iris.get("valid")),
        "frozenByBlink": False,
        "freezeReason": "",
        "eyeBlinkLeftRaw": float(raw_blink_l),
        "eyeBlinkRightRaw": float(raw_blink_r),
    }

    def _emit_center(mode: str) -> None:
        center = 50.0
        rig["sharedRadar"]["x"] = center
        rig["sharedRadar"]["y"] = center
        mapping["sharedRadarX"] = center
        mapping["sharedRadarY"] = center
        lemit["x"] = center
        lemit["y"] = center
        gaze_dbg["candidateSharedRadarX"] = center
        gaze_dbg["candidateSharedRadarY"] = center
        gaze_dbg["emittedSharedRadarX"] = center
        gaze_dbg["emittedSharedRadarY"] = center
        gaze_dbg["outputMode"] = mode

    if not bool(st.get("iris_gaze_armed", False)):
        _emit_center("iris_disarmed")
        gaze_dbg["irisInitState"] = "iris_disarmed"
        gaze_dbg["irisGazeArmed"] = False
        return gaze_dbg

    gaze_dbg["irisGazeArmed"] = True

    if not face_detected:
        _emit_center("iris_no_face")
        return gaze_dbg

    if not bool(iris.get("valid")):
        st["iris_missing_count"] = int(st.get("iris_missing_count", 0)) + 1
        hold_thr = max(1, int(_safe_float(gz.get("irisMissingHoldFrames"), 10)))
        last_x = _safe_float(lemit.get("x"), 50.0)
        last_y = _safe_float(lemit.get("y"), 50.0)
        if int(st["iris_missing_count"]) < hold_thr:
            emit_x, emit_y = last_x, last_y
            mode = "iris_missing_hold"
        else:
            decay = _safe_float(gz.get("irisMissingDecayLerp"), 0.05)
            emit_x = _lerp(last_x, 50.0, decay)
            emit_y = _lerp(last_y, 50.0, decay)
            mode = "iris_missing_decay"
        rig["sharedRadar"]["x"] = emit_x
        rig["sharedRadar"]["y"] = emit_y
        mapping["sharedRadarX"] = emit_x
        mapping["sharedRadarY"] = emit_y
        lemit["x"] = emit_x
        lemit["y"] = emit_y
        gaze_dbg["candidateSharedRadarX"] = float(emit_x)
        gaze_dbg["candidateSharedRadarY"] = float(emit_y)
        gaze_dbg["emittedSharedRadarX"] = float(emit_x)
        gaze_dbg["emittedSharedRadarY"] = float(emit_y)
        gaze_dbg["outputMode"] = mode
        return gaze_dbg

    st["iris_missing_count"] = 0

    local_x = float(iris["irisLocalX"])
    local_y = float(iris["irisLocalY"])
    head_motion_px = _frame_head_motion_px(st, gz)

    if not bool(st.get("iris_warmup_done")):
        required = max(8, int(_safe_float(gz.get("irisWarmupFrames"), 20)))
        min_samples = max(6, int(_safe_float(gz.get("irisWarmupMinSamples"), 12)))
        max_wait = max(required + 5, int(_safe_float(gz.get("irisWarmupMaxWaitFrames"), 45)))
        max_head = max(0.1, _safe_float(gz.get("irisWarmupMaxHeadPx"), 0.35))

        frame_idx = int(st.get("iris_warmup_frame", 0)) + 1
        st["iris_warmup_frame"] = frame_idx

        if head_motion_px < max_head and not _iris_blink_blocks_warmup(raw_blink_l, raw_blink_r, gz):
            st.setdefault("_warmup_lx", []).append(local_x)
            st.setdefault("_warmup_ly", []).append(local_y)

        sample_n = len(st.get("_warmup_lx") or [])
        gaze_dbg["irisInitState"] = "iris_warmup"
        gaze_dbg["irisInitReady"] = False
        gaze_dbg["irisWarmupSampleCount"] = int(sample_n)
        gaze_dbg["irisWarmupRequiredSamples"] = int(required)
        gaze_dbg["irisWarmupFrameIndex"] = int(frame_idx)

        warmup_ready = sample_n >= required or (
            frame_idx >= max_wait and sample_n >= min_samples
        )
        if warmup_ready and sample_n >= 3:
            _finalize_iris_warmup(st)
            gaze_dbg["irisInitState"] = "iris_tracking"
            gaze_dbg["irisInitReady"] = True
        else:
            center = 50.0
            rig["sharedRadar"]["x"] = center
            rig["sharedRadar"]["y"] = center
            mapping["sharedRadarX"] = center
            mapping["sharedRadarY"] = center
            lemit["x"] = center
            lemit["y"] = center
            gaze_dbg.update(
                {
                    "irisLocalDx": 0.0,
                    "irisLocalDy": 0.0,
                    "irisBaselineLocalX": None,
                    "irisBaselineLocalY": None,
                    "irisHeadMotionPx": float(head_motion_px),
                    "irisXNorm": 0.0,
                    "irisYNorm": 0.0,
                    "candidateSharedRadarX": center,
                    "candidateSharedRadarY": center,
                    "emittedSharedRadarX": center,
                    "emittedSharedRadarY": center,
                    "outputMode": "iris_warmup",
                }
            )
            return gaze_dbg

    freeze_active, freeze_reason, blink_level, just_released = _iris_update_blink_freeze_state(
        st,
        lemit,
        raw_blink_l,
        raw_blink_r,
        gz,
    )
    if just_released:
        _iris_begin_blink_release_blend(st, gz)

    if "baseline_lx" not in st:
        st["baseline_lx"] = float(local_x)
        st["baseline_ly"] = float(local_y)

    head_hold_px = max(0.5, _safe_float(gz.get("irisHeadMotionHoldPx"), 1.4))
    head_soft_px = max(
        0.2,
        _safe_float(gz.get("irisHeadMotionSoftPx"), 0.65),
    )
    head_soft_px = min(head_soft_px, head_hold_px - 1e-6)

    drive_x = local_x - float(st["baseline_lx"])
    drive_y = local_y - float(st["baseline_ly"])

    quiet_thr = max(0.0, _safe_float(gz.get("irisQuietRecenterDrive"), 0.014))
    quiet_base_alpha_x = _clamp(
        _safe_float(gz.get("irisQuietBaselineAlpha"), 0.006),
        0.0,
        0.03,
    )
    quiet_base_alpha_y = _clamp(
        _safe_float(gz.get("irisQuietBaselineAlphaY"), 0.012),
        0.0,
        0.05,
    )
    if head_motion_px < 0.25:
        if quiet_base_alpha_x > 0.0 and abs(drive_x) < quiet_thr:
            st["baseline_lx"] = _lerp(float(st["baseline_lx"]), local_x, quiet_base_alpha_x)
            drive_x = local_x - float(st["baseline_lx"])
        if quiet_base_alpha_y > 0.0 and abs(drive_y) < quiet_thr:
            st["baseline_ly"] = _lerp(float(st["baseline_ly"]), local_y, quiet_base_alpha_y)
            drive_y = local_y - float(st["baseline_ly"])

    drive_dz_x = max(
        0.0,
        _safe_float(
            gz.get("irisLocalDriveDeadzoneX"),
            _safe_float(gz.get("irisLocalDriveDeadzone"), 0.012),
        ),
    )
    drive_dz_y = max(0.0, _safe_float(gz.get("irisLocalDriveDeadzoneY"), 0.007))
    if abs(drive_x) < drive_dz_x:
        drive_x = 0.0
    if abs(drive_y) < drive_dz_y:
        drive_y = 0.0

    last_ex = _safe_float(lemit.get("x"), 50.0)
    last_ey = _safe_float(lemit.get("y"), 50.0)
    last_xn = _safe_float(st.get("iris_x_norm"), 0.0)
    last_yn = _safe_float(st.get("iris_y_norm"), 0.0)

    head_scale = 1.0
    if head_motion_px > head_soft_px:
        head_scale = _clamp(
            1.0 - (head_motion_px - head_soft_px) / max(1e-6, head_hold_px - head_soft_px),
            0.2,
            1.0,
        )
    drive_x *= head_scale
    drive_y *= head_scale

    x_gain = _safe_float(gz.get("irisLocalXGain"), _safe_float(gz.get("irisXGain"), 5.0))
    norm_knee_x = max(1e-6, _safe_float(gz.get("irisSoftNormKneeX"), _safe_float(gz.get("irisSoftNormKnee"), 0.22)))
    norm_knee_y = max(1e-6, _safe_float(gz.get("irisSoftNormKneeY"), 0.18))
    x_sign = -1.0 if bool(gz.get("irisInvertX", False)) else 1.0
    y_sign = 1.0 if bool(gz.get("irisInvertY", False)) else -1.0
    y_gain = _pick_iris_y_gain(drive_y, y_sign, gz)
    x_norm_raw = _soft_norm(drive_x * x_sign, gain=x_gain, knee=norm_knee_x)
    y_norm_raw = _soft_norm(drive_y * y_sign, gain=y_gain, knee=norm_knee_y)

    dz_x = max(0.0, _safe_float(gz.get("irisDeadzoneX"), 0.0015))
    dz_y = max(0.0, _safe_float(gz.get("irisDeadzoneY"), 0.0015))
    if abs(x_norm_raw) < dz_x:
        x_norm_raw = 0.0
    if abs(y_norm_raw) < dz_y:
        y_norm_raw = 0.0

    x_norm = _clamp(x_norm_raw, -1.0, 1.0)
    y_norm = _clamp(y_norm_raw, -1.0, 1.0)

    ema = _safe_float(gz.get("irisEmaAlpha"), 0.58)
    x_norm = _lerp(last_xn, x_norm, ema)
    y_norm = _lerp(last_yn, y_norm, ema)

    quiet_recenter_alpha_x = _clamp(
        _safe_float(gz.get("irisQuietRecenterAlpha"), 0.32),
        0.0,
        1.0,
    )
    quiet_recenter_alpha_y = _clamp(
        _safe_float(gz.get("irisQuietRecenterAlphaY"), 0.42),
        0.0,
        1.0,
    )
    if head_motion_px < 0.25:
        if abs(drive_x) < quiet_thr:
            x_norm = _lerp(x_norm, 0.0, quiet_recenter_alpha_x)
        if abs(drive_y) < quiet_thr:
            y_norm = _lerp(y_norm, 0.0, quiet_recenter_alpha_y)

    max_delta = _safe_float(gz.get("irisMaxDeltaNormPerFrame"), 0.18)
    x_norm = _clamp(x_norm, last_xn - max_delta, last_xn + max_delta)
    y_norm = _clamp(y_norm, last_yn - max_delta, last_yn + max_delta)

    st["iris_x_norm"] = float(x_norm)
    st["iris_y_norm"] = float(y_norm)

    span_x = max(1.0, _safe_float(gz.get("irisOutputSpanX"), 18.0))
    span_y = max(1.0, _safe_float(gz.get("irisOutputSpanY"), 20.0))
    cand_x = 50.0 + x_norm * span_x
    cand_y = 50.0 + y_norm * span_y
    cand_x = _clamp(cand_x, lo_x, hi_x)
    cand_y = _clamp(cand_y, lo_y, hi_y)

    max_step = max(1.0, _safe_float(gz.get("irisMaxStepSharedRadar"), 10.0))
    emit_x = _clamp(cand_x, last_ex - max_step, last_ex + max_step)
    emit_y = _clamp(cand_y, last_ey - max_step, last_ey + max_step)

    emit_x, emit_y, x_norm, y_norm, output_mode, frozen_by_blink, freeze_reason_out = (
        _iris_apply_blink_output_gate(
            st=st,
            gz=gz,
            freeze_active=freeze_active,
            freeze_reason=freeze_reason,
            blink_level=blink_level,
            last_ex=last_ex,
            last_ey=last_ey,
            last_xn=last_xn,
            last_yn=last_yn,
            cand_x=cand_x,
            cand_y=cand_y,
            emit_x=emit_x,
            emit_y=emit_y,
            x_norm=x_norm,
            y_norm=y_norm,
        )
    )
    st["iris_x_norm"] = float(x_norm)
    st["iris_y_norm"] = float(y_norm)

    rig["sharedRadar"]["x"] = emit_x
    rig["sharedRadar"]["y"] = emit_y
    mapping["sharedRadarX"] = emit_x
    mapping["sharedRadarY"] = emit_y
    lemit["x"] = emit_x
    lemit["y"] = emit_y

    gaze_dbg.update(
        {
            "irisLocalDx": float(drive_x),
            "irisLocalDy": float(drive_y),
            "irisBaselineLocalX": float(st["baseline_lx"]),
            "irisBaselineLocalY": float(st["baseline_ly"]),
            "irisHeadMotionPx": float(head_motion_px),
            "irisHeadMotionScale": float(head_scale),
            "irisLocalFusion": iris.get("irisLocalFusion"),
            "irisXNorm": float(x_norm),
            "irisYNorm": float(y_norm),
            "irisYGainApplied": float(y_gain),
            "candidateSharedRadarX": float(cand_x),
            "candidateSharedRadarY": float(cand_y),
            "emittedSharedRadarX": float(emit_x),
            "emittedSharedRadarY": float(emit_y),
            "outputMode": output_mode,
            "frozenByBlink": bool(frozen_by_blink),
            "freezeReason": str(freeze_reason_out),
            "irisBlinkFreezeActive": bool(freeze_active),
            "irisBlinkLevel": float(blink_level),
            "irisBlinkReleaseCount": int(st.get("iris_blink_release_count", 0)),
            "irisBlinkFreezeFrames": int(st.get("iris_blink_freeze_frames", 0)),
            "irisBlinkReleaseBlendLeft": int(st.get("iris_blink_release_blend", 0)),
            "eyeBlinkLeftRaw": float(raw_blink_l),
            "eyeBlinkRightRaw": float(raw_blink_r),
        }
    )
    return gaze_dbg
