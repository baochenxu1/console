"""
MediaPipe FaceLandmarkerResult → Elite Rig JSON（与前端 createInitialEliteRig / normalizeEliteRig 兼容）。
仅做数值映射；无舵机、无绑定。
阶段 2.5：blendshape / mapping / gaze（iris→sharedRadar）调试输出；眨眼仍用 blendshape，与视线分离。
jaw：`invert` 为语义强度取负写入 signed `jaw.val`；微笑见嘴角映射；机械方向以 Binding 为准。
"""

from __future__ import annotations

import math
import statistics
import time
from typing import Any, Iterable

from gaze_iris_only import (
    IRIS_ONLY_MODE,
    apply_mediapipe_iris_only_gaze,
    extract_iris_signal,
)
from mediapipe_mapping_config import (
    apply_deadzone,
    apply_soft_deadzone,
    apply_gain,
    apply_invert_signed,
    apply_invert_unipolar,
    clamp,
    create_default_mapping_config,
    normalize_mapping_config,
)


def _safe_float(v: Any, fallback: float = 0.0) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return fallback
    if math.isnan(x) or math.isinf(x):
        return fallback
    return x


def _clamp_pct(v: float) -> float:
    return max(0.0, min(100.0, _safe_float(v, 0.0)))


def _clamp_signed100(v: float) -> float:
    """与前端 `clampSigned100ish` 一致：jaw.val ∈ [-100, 100]。"""
    return max(-100.0, min(100.0, _safe_float(v, 0.0)))


def create_neutral_rig() -> dict[str, Any]:
    """等价于前端 createInitialEliteRig() 的中性姿态。"""
    return {
        "browL": {"tip": 0.0, "mid": 0.0, "tail": 0.0},
        "browR": {"tip": 0.0, "mid": 0.0, "tail": 0.0},
        "eyeL": {"up": 0.0, "lo": 0.0},
        "eyeR": {"up": 0.0, "lo": 0.0},
        "sharedRadar": {"x": 50.0, "y": 50.0},
        "mouth": {
            "UL": 0.0,
            "UR": 0.0,
            "LL": 0.0,
            "LR": 0.0,
            "sideL": {"x": 50.0, "y": 50.0},
            "sideR": {"x": 50.0, "y": 50.0},
        },
        "tongue": {"val": 0.0},
        "jaw": {"val": 0.0},
    }


def _normalized_blend_key(name: str) -> str:
    return "".join(ch for ch in str(name).lower() if ch.isalnum())


def _iter_classification_entries(classification_list: Any) -> Iterable[tuple[str, float]]:
    """
    mediapipe ClassificationList：通常为 repeated Classification，
    字段名在不同版本可能是 category / classifications / classification。
    """
    if classification_list is None:
        return
    blob = (
        getattr(classification_list, "categories", None)
        or getattr(classification_list, "classifications", None)
        or getattr(classification_list, "classification", None)
        or getattr(classification_list, "category", None)
    )
    if blob is not None:
        for c in blob:
            nm = (
                getattr(c, "category_name", None)
                or getattr(c, "display_name", None)
                or getattr(c, "label", None)
                or ""
            )
            sc = getattr(c, "score", None)
            if nm:
                yield str(nm), _safe_float(sc, 0.0)
        return
    try:
        for c in classification_list:
            nm = (
                getattr(c, "category_name", None)
                or getattr(c, "display_name", None)
                or getattr(c, "label", None)
                or ""
            )
            sc = getattr(c, "score", None)
            if nm:
                yield str(nm), _safe_float(sc, 0.0)
    except TypeError:
        return


def _build_blendshape_lookup(result: Any) -> dict[str, float]:
    """首个人脸 blendshape → 归一化小写键与原始键均可查。"""
    scores: dict[str, float] = {}
    fbs = getattr(result, "face_blendshapes", None)
    if not fbs:
        return scores
    try:
        first_face_bs = list(fbs)[0]
    except (TypeError, IndexError):
        return scores

    for name, sc in _iter_classification_entries(first_face_bs):
        scores[name] = sc
        scores[_normalized_blend_key(name)] = sc
    return scores


def blendshape_entry_count(result: Any) -> int:
    fbs = getattr(result, "face_blendshapes", None)
    if not fbs:
        return 0
    try:
        first_face_bs = list(fbs)[0]
    except (TypeError, IndexError):
        return 0
    return sum(1 for _ in _iter_classification_entries(first_face_bs))


def get_blendshape_score(result: Any, name: str, default: float = 0.0) -> float:
    """
    从 FaceLandmarkerResult 读取指定 blendshape 分数；不存在则 default。
    兼容 category_name 大小写 / 下划线变体。
    """
    lut = _build_blendshape_lookup(result)
    if name in lut:
        return _safe_float(lut[name], default)
    nk = _normalized_blend_key(name)
    if nk in lut:
        return _safe_float(lut[nk], default)
    for alt in (name.replace("_", ""), name.lower(), name.upper()):
        if alt in lut:
            return _safe_float(lut[alt], default)
        a2 = _normalized_blend_key(alt)
        if a2 in lut:
            return _safe_float(lut[a2], default)
    return _safe_float(default, 0.0)


def landmarks_to_jaw_open(_landmarks: Any) -> float:
    return 0.0


def landmarks_to_mouth_corners(landmarks: Any, get_xy=None) -> tuple[float, float, float, float]:
    """薄包装：原始嘴角 landmark；见 mouth_corner_geometry.landmarks_to_mouth_corners。"""
    from mouth_corner_geometry import landmarks_to_mouth_corners as _lm_corners

    return _lm_corners(landmarks, get_landmark_xy if get_xy is None else get_xy)


def landmarks_to_blink(_landmarks: Any) -> tuple[float, float]:
    return 0.0, 0.0


def extract_landmarks(result: Any) -> list[Any] | None:
    """首张脸的 landmark 列表；失败或不存在返回 None。"""
    try:
        lm = getattr(result, "face_landmarks", None)
        if lm is None:
            return None
        faces = list(lm)
        if not faces:
            return None
        first = faces[0]
        pts = list(first)
        return pts
    except Exception:
        return None


def get_landmark_xy(landmarks: Any, index: int) -> tuple[float, float] | None:
    """读取单个归一化 landmark 的 (x,y)；索引越界或无效返回 None。"""
    try:
        if landmarks is None or index < 0:
            return None
        seq = list(landmarks)
        if index >= len(seq):
            return None
        p = seq[index]
        x = getattr(p, "x", None)
        y = getattr(p, "y", None)
        if x is None and isinstance(p, dict):
            x = p.get("x")
            y = p.get("y")
        if x is None and isinstance(p, (list, tuple)) and len(p) >= 2:
            x, y = p[0], p[1]
        xf = float(x)
        yf = float(y)
        if math.isnan(xf) or math.isnan(yf) or math.isinf(xf) or math.isinf(yf):
            return None
        return xf, yf
    except Exception:
        return None


def create_neutral_gaze() -> dict[str, Any]:
    """gaze 不可用时 debug.gaze 的占位结构。"""
    return {
        "available": False,
        "stable": False,
        "frozenByBlink": False,
        "heldLastValid": False,
        "limitedByMaxStep": False,
        "irisReliable": False,
        "reliabilityScore": 0.0,
        "freezeReason": "",
        "blinkGazeWeight": 1.0,
        "candidateSharedRadarX": None,
        "candidateSharedRadarY": None,
        "emittedSharedRadarX": 50.0,
        "emittedSharedRadarY": 50.0,
        "lastValidSharedRadarX": None,
        "lastValidSharedRadarY": None,
        "leftEyeHalfWidth": 0.0,
        "leftEyeHalfHeight": 0.0,
        "rightEyeHalfWidth": 0.0,
        "rightEyeHalfHeight": 0.0,
        "eyeBlinkLeftRaw": 0.0,
        "eyeBlinkRightRaw": 0.0,
        "blinkLeftMapping": 0.0,
        "blinkRightMapping": 0.0,
        "eyeLookX": 0.0,
        "eyeLookY": 0.0,
        "rawPrimaryX": 0.0,
        "rawPrimaryY": 0.0,
        "rawLidAsymmetryY": 0.0,
        "autoNeutralX": 0.0,
        "autoNeutralY": 0.0,
        "logicalEyeXRightPositive": 0.0,
        "logicalEyeYUpPositive": 0.0,
        "upRange": 30.0,
        "downRange": 28.0,
        "leftRange": 30.0,
        "rightRange": 30.0,
        "sharedRadarXBeforeClamp": 50.0,
        "sharedRadarYBeforeClamp": 50.0,
        "leftEyeX": 0.0,
        "leftEyeY": 0.0,
        "rightEyeX": 0.0,
        "rightEyeY": 0.0,
        "sharedRadarX": 50.0,
        "sharedRadarY": 50.0,
    }


def _one_eye_gaze_local(
    lm: Any,
    idx: dict[str, int],
    iris_cx: float,
    iris_cy: float,
    get_xy: Any,
    gaze_cfg: dict[str, Any] | None = None,
) -> tuple[float, float, float, float, float] | None:
    """inner/outer 建水平轴；Y 用法向 + 眼宽尺度（不用动态眼睑 half_h 作主尺度）。"""
    inner = get_xy(lm, idx["inner"])
    outer = get_xy(lm, idx["outer"])
    upper = get_xy(lm, idx["upper"])
    lower = get_xy(lm, idx["lower"])
    if not inner or not outer or not upper or not lower:
        return None

    cx = (inner[0] + outer[0]) * 0.5
    cy = (inner[1] + outer[1]) * 0.5
    half_w = math.hypot(outer[0] - inner[0], outer[1] - inner[1]) * 0.5
    half_h = math.hypot(lower[0] - upper[0], lower[1] - upper[1]) * 0.5
    if half_w < 1e-6 or half_h < 1e-6:
        return None

    hx = outer[0] - inner[0]
    hy = outer[1] - inner[1]
    h_len = math.hypot(hx, hy)
    if h_len < 1e-6:
        return None
    ux, uy = hx / h_len, hy / h_len

    pvx1, pvy1 = -uy, ux
    pvx2, pvy2 = uy, -ux
    ucx = upper[0] - cx
    ucy = upper[1] - cy
    if ucx * pvx1 + ucy * pvy1 > ucx * pvx2 + ucy * pvy2:
        vx, vy = pvx1, pvy1
    else:
        vx, vy = pvx2, pvy2

    gz = gaze_cfg if isinstance(gaze_cfg, dict) else {}
    vert_scale_factor = max(1e-6, _safe_float(gz.get("gazeVerticalScaleFromEyeWidth"), 0.32))
    vertical_scale = half_w * vert_scale_factor

    dx = iris_cx - cx
    dy = iris_cy - cy
    local_x = (dx * ux + dy * uy) / half_w
    primary_y = ((dx * vx + dy * vy) / vertical_scale)

    dist_u = math.hypot(iris_cx - upper[0], iris_cy - upper[1])
    dist_l = math.hypot(iris_cx - lower[0], iris_cy - lower[1])
    aux_y = (dist_l - dist_u) / (dist_l + dist_u + 1e-6)

    local_x = max(-1.5, min(1.5, local_x))
    aux_y = max(-1.0, min(1.0, aux_y))
    return float(local_x), float(primary_y), float(aux_y), float(half_w), float(half_h)


def _gaze_is_neutral_init_geometry_mode(gz: dict[str, Any]) -> bool:
    return str(gz.get("gazeEstimatorMode", "")) == "neutral_init_geometry_v1"


def _gaze_is_iris_only_mode(gz: dict[str, Any]) -> bool:
    return str(gz.get("gazeEstimatorMode", "")) == IRIS_ONLY_MODE


def _gaze_is_legacy_iris_mode(gz: dict[str, Any]) -> bool:
    return False


def _gaze_is_safe_center_mode(gz: dict[str, Any]) -> bool:
    """仅显式 safe_center_v1 模式；neutral_init 失败时走 fallback 分支。"""
    return str(gz.get("gazeEstimatorMode", "")) == "safe_center_v1"


def _gaze_should_run_geometry_production(gaze_cfg: dict[str, Any]) -> bool:
    if _gaze_is_safe_center_mode(gaze_cfg):
        return False
    if _gaze_is_iris_only_mode(gaze_cfg):
        return False
    if _gaze_is_legacy_iris_mode(gaze_cfg):
        return False
    if bool(gaze_cfg.get("neutralInitGeometryProductionEnabled", False)) and _gaze_is_neutral_init_geometry_mode(
        gaze_cfg
    ):
        return bool(gaze_cfg.get("gazeXProductionEnabled", True)) or bool(
            gaze_cfg.get("gazeYProductionEnabled", True)
        )
    if _gaze_is_neutral_init_geometry_mode(gaze_cfg):
        return False
    if bool(gaze_cfg.get("eyeCornerV3ProductionEnabled", False)):
        return True
    return bool(gaze_cfg.get("gazeYProductionEnabled", True))


def _gaze_neutral_init_state(gaze_state: dict[str, Any] | None) -> dict[str, Any]:
    st = gaze_state if isinstance(gaze_state, dict) else {}
    ni = st.get("neutral_init")
    return ni if isinstance(ni, dict) else {}


def _gaze_legacy_neutral_init_state(gaze_state: dict[str, Any] | None) -> dict[str, Any]:
    st = gaze_state if isinstance(gaze_state, dict) else {}
    leg = st.get("legacy_neutral_init")
    return leg if isinstance(leg, dict) else {}


def _patch_gaze_legacy_iris_debug(
    gaze_dbg: dict[str, Any],
    leg: dict[str, Any],
    gz: dict[str, Any],
) -> None:
    gaze_dbg["gazeEstimatorMode"] = str(gz.get("gazeEstimatorMode", "legacy_iris_offset_v1"))
    gaze_dbg["eyeCornerV3ProductionEnabled"] = False
    gaze_dbg["eyeCornerV3DebugOnly"] = True
    for k in (
        "legacyNeutralInitState",
        "legacyNeutralInitReady",
        "legacyNeutralInitFailed",
        "legacyNeutralInitReason",
        "legacyNeutralInitSampleCount",
        "legacyNeutralInitRequiredSamples",
        "legacyNeutralInitRemainingMs",
        "sessionNeutralLegacyX",
        "sessionNeutralLegacyY",
        "legacyRawX",
        "legacyRawY",
        "legacyDx",
        "legacyDy",
        "legacyXNorm",
        "legacyYNorm",
        "legacyIrisReliable",
        "blinkGazeWeight",
    ):
        if k in leg:
            gaze_dbg[k] = leg[k]
        elif k in gaze_dbg:
            leg.setdefault(k, gaze_dbg[k])
    gaze_dbg["safeCenterActive"] = False
    gaze_dbg["safeCenterReason"] = ""


def _gaze_neutral_init_should_fallback(
    gz: dict[str, Any],
    init: dict[str, Any],
    *,
    face_detected: bool,
    gaze_dbg: dict[str, Any],
) -> bool:
    if not bool(gz.get("safeCenterFallbackEnabled", True)):
        return False
    if not face_detected:
        return True
    state = str(init.get("neutralInitState") or init.get("state") or "")
    if state in ("collecting_neutral", "validating_neutral"):
        return False
    if state == "neutral_failed" or bool(init.get("neutralInitFailed")):
        return True
    if state != "neutral_ready" and not bool(init.get("neutralInitReady")):
        return True
    rel = _safe_float(gaze_dbg.get("reliabilityScore"), 0.0)
    if bool(gaze_dbg.get("available")) and rel < 0.12:
        return True
    return False


def _patch_gaze_neutral_init_debug(
    gaze_dbg: dict[str, Any],
    init: dict[str, Any],
    gz: dict[str, Any],
) -> None:
    mode = str(gz.get("gazeEstimatorMode", "neutral_init_geometry_v1"))
    gaze_dbg["gazeEstimatorMode"] = mode
    for k in (
        "neutralInitState",
        "neutralInitSampleCount",
        "neutralInitRequiredSamples",
        "neutralInitProgress",
        "neutralInitReady",
        "neutralInitFailed",
        "neutralInitReason",
        "neutralInitRemainingMs",
        "sessionNeutralX",
        "sessionNeutralY",
        "sessionNeutralStableY",
        "neutralPostValidated",
        "neutralPostValidationAdjusted",
        "neutralPostValidationDeltaX",
        "neutralPostValidationDeltaY",
    ):
        if k in init:
            gaze_dbg[k] = init[k]
    gaze_dbg["safeCenterActive"] = False
    gaze_dbg["safeCenterReason"] = ""


_EYE_CORNER_V3_DEBUG_KEYS = (
    "rawPrimaryX",
    "rawPrimaryY",
    "rawPrimaryYUnclamped",
    "rawPrimaryYLegacy",
    "rawStableY",
    "rawLidAsymmetryY",
    "verticalRawClipped",
    "leftEyeHalfWidth",
    "leftEyeHalfHeight",
    "rightEyeHalfWidth",
    "rightEyeHalfHeight",
    "leftEyeX",
    "leftEyeY",
    "rightEyeX",
    "rightEyeY",
    "eyeLookX",
    "eyeLookY",
    "reliabilityScore",
    "irisReliable",
)


def _estimate_eye_corner_v3_from_landmarks(result: Any, config: dict[str, Any]) -> dict[str, Any]:
    """
    eye_corner_v3 几何估计（仅 debug / 非 safe_center 生产路径）。
    无 landmarks / 点数不足 / 计算失败时 gazeAvailable=false，不抛异常。
    """
    out = create_neutral_gaze()
    try:
        gaze_cfg = config.get("gaze") if isinstance(config.get("gaze"), dict) else {}
        if not bool(gaze_cfg.get("enabled", True)):
            return out
        if not bool(gaze_cfg.get("preferIrisLandmarks", True)):
            return out

        lm = extract_landmarks(result)
        if not lm or len(lm) < 478:
            return out

        left_iris: list[tuple[float, float]] = []
        for i in range(468, 473):
            xy = get_landmark_xy(lm, i)
            if xy:
                left_iris.append(xy)
        right_iris: list[tuple[float, float]] = []
        for i in range(473, 478):
            xy = get_landmark_xy(lm, i)
            if xy:
                right_iris.append(xy)
        if len(left_iris) < 2 or len(right_iris) < 2:
            return out

        licx = sum(p[0] for p in left_iris) / len(left_iris)
        licy = sum(p[1] for p in left_iris) / len(left_iris)
        ricx = sum(p[0] for p in right_iris) / len(right_iris)
        ricy = sum(p[1] for p in right_iris) / len(right_iris)

        # 左眼 inner/outer/upper/lower（常见 FaceMesh 索引）
        left_idx = {"inner": 133, "outer": 33, "upper": 159, "lower": 145}
        right_idx = {"inner": 362, "outer": 263, "upper": 386, "lower": 374}

        min_extent = max(1e-6, _safe_float(gaze_cfg.get("minIrisEyeHalfExtent"), 0.003))
        primary_w = max(0.0, min(1.0, _safe_float(gaze_cfg.get("primaryYWeight"), 0.85)))
        aux_w = max(0.0, min(1.0, _safe_float(gaze_cfg.get("auxYWeight"), 0.15)))
        w_sum = primary_w + aux_w
        if w_sum < 1e-6:
            primary_w, aux_w, w_sum = 0.85, 0.15, 1.0
        primary_w /= w_sum
        aux_w /= w_sum

        le = _one_eye_gaze_local(lm, left_idx, licx, licy, get_landmark_xy, gaze_cfg)
        re = _one_eye_gaze_local(lm, right_idx, ricx, ricy, get_landmark_xy, gaze_cfg)
        if le is None or re is None:
            return out

        fuse_x = (le[0] + re[0]) * 0.5
        raw_primary_x = float(fuse_x)
        raw_primary_y_unclamped = (le[1] + re[1]) * 0.5
        raw_primary_y = float(clamp(raw_primary_y_unclamped, -1.5, 1.5))
        raw_lid_asymmetry_y = (le[2] + re[2]) * 0.5
        fuse_y = primary_w * raw_primary_y + aux_w * raw_lid_asymmetry_y
        clip_thr = _safe_float(gaze_cfg.get("verticalRawClipThreshold"), 1.25)
        vertical_clipped = abs(float(raw_primary_y_unclamped)) > clip_thr
        min_l = min(le[3], le[4])
        min_r = min(re[3], re[4])
        ref_extent = max(1e-6, min_extent)
        geo_min = float(min(min_l, min_r))
        reliability_score = float(clamp(geo_min / (ref_extent * 2.5), 0.0, 1.0))
        if geo_min >= ref_extent:
            reliability_score = max(reliability_score, 0.55)
        out["available"] = True
        out["reliabilityScore"] = reliability_score
        out["irisReliable"] = bool(reliability_score >= 0.45)
        out["leftEyeHalfWidth"] = float(le[3])
        out["leftEyeHalfHeight"] = float(le[4])
        out["rightEyeHalfWidth"] = float(re[3])
        out["rightEyeHalfHeight"] = float(re[4])
        out["leftEyeX"] = float(le[0])
        out["leftEyeY"] = float(raw_primary_y)
        out["rightEyeX"] = float(re[0])
        out["rightEyeY"] = float(re[1])
        out["eyeLookX"] = float(fuse_x)
        out["eyeLookY"] = float(fuse_y)
        out["rawPrimaryX"] = raw_primary_x
        out["rawPrimaryY"] = raw_primary_y
        out["rawPrimaryYUnclamped"] = float(raw_primary_y_unclamped)
        out["rawPrimaryYLegacy"] = raw_primary_y
        out["rawStableY"] = float(fuse_y)
        out["rawLidAsymmetryY"] = float(raw_lid_asymmetry_y)
        out["verticalRawClipped"] = bool(vertical_clipped)
        return out
    except Exception:
        return create_neutral_gaze()


def estimate_eye_gaze_from_landmarks(result: Any, config: dict[str, Any]) -> dict[str, Any]:
    """gaze debug 预览；生产输出仅在 apply_mediapipe_iris_only_gaze 内完成。"""
    gaze_cfg = config.get("gaze") if isinstance(config.get("gaze"), dict) else {}
    mode = str(gaze_cfg.get("gazeEstimatorMode", IRIS_ONLY_MODE))
    out: dict[str, Any] = {
        "gazeEstimatorMode": mode,
        "irisOnlyActive": _gaze_is_iris_only_mode(gaze_cfg),
        "available": False,
    }
    if not bool(gaze_cfg.get("enabled", True)):
        return out
    if not _gaze_is_iris_only_mode(gaze_cfg):
        return out
    lm = extract_landmarks(result)
    iris = extract_iris_signal(lm, get_xy=get_landmark_xy, gaze_cfg=gaze_cfg)
    out.update(iris)
    out["available"] = bool(iris.get("valid"))
    return out


_DEBUG_BLEND_KEYS = (
    "jawOpen",
    "eyeBlinkLeft",
    "eyeBlinkRight",
    "eyeWideLeft",
    "eyeWideRight",
    "mouthSmileLeft",
    "mouthSmileRight",
    "mouthUpperUpLeft",
    "mouthUpperUpRight",
    "mouthLowerDownLeft",
    "mouthLowerDownRight",
    "mouthPucker",
    "mouthFunnel",
    "mouthClose",
    "browInnerUp",
    "browOuterUpLeft",
    "browOuterUpRight",
)


def extract_debug_blendshapes(result: Any) -> dict[str, float]:
    """原始 blendshape 0~1 附近；缺失为 0；无 NaN。"""
    out: dict[str, float] = {}
    for key in _DEBUG_BLEND_KEYS:
        if key == "jawOpen":
            jaw_open = max(
                get_blendshape_score(result, "jawOpen"),
                get_blendshape_score(result, "jaw_open"),
            )
            out["jawOpen"] = _safe_float(jaw_open, 0.0)
        else:
            out[key] = _safe_float(get_blendshape_score(result, key, 0.0), 0.0)
    return out


def _semantic_strength_base(
    centered: float,
    *,
    
    deadzone_thr: float,
    gain: float,
    lim_lo: float,
    lim_hi: float,
) -> float:
    """减 neutral 后的量 → deadzone / gain / ×100 → clamp 到 [lim_lo, lim_hi]，不含 invert。"""
    x = apply_deadzone(centered, deadzone_thr)
    x = apply_gain(x, gain)
    x = x * 100.0
    return clamp(x, lim_lo, lim_hi)


def _pipe_unipolar_strength(
    centered: float,
    *,
    deadzone_thr: float,
    gain: float,
    invert: bool,
    lim_lo: float,
    lim_hi: float,
) -> float:
    """
    语义强度落在 [lim_lo, lim_hi]（常为 0~100）后，invert 在**同一单极区间**内做反射：min+max−v。
    用于 blink / smile / brow 等仍须以非负强度喂给后续公式的通道；**jaw 勿用本函数**，见下。
    """
    x = _semantic_strength_base(
        centered,
        deadzone_thr=deadzone_thr,
        gain=gain,
        lim_lo=lim_lo,
        lim_hi=lim_hi,
    )
    return apply_invert_unipolar(x, invert, lim_lo, lim_hi)


def _norm_brow_slot(name: Any, fallback: str) -> str:
    s = str(name or fallback).strip().lower()
    return s if s in ("tip", "tail") else fallback


def _gaze_blink_update_weight(raw_l: float, raw_r: float, gz: dict[str, Any]) -> tuple[float, str]:
    """blink 分级：<softMid 全速；softMid~hold soft follow；>=hold 由 emit 分支处理。"""
    blink = max(float(raw_l), float(raw_r))
    hold_thr = _safe_float(gz.get("blinkHoldThreshold"), 0.90)
    soft_mid = _safe_float(gz.get("blinkSoftMidThreshold"), 0.70)
    if blink >= hold_thr:
        return 0.0, "blink_hold"
    if blink >= soft_mid:
        follow_alpha = _safe_float(gz.get("candidateFollowAlphaWhenBlinkHigh"), 0.25)
        return float(follow_alpha), "blink_soft"
    return 1.0, ""


def _gaze_state_init(st: dict[str, Any]) -> None:
    if "range_window" not in st:
        legacy = st.get("adaptive")
        if isinstance(legacy, dict):
            st["range_window"] = {
                "right": list(legacy.get("right") or []),
                "left": list(legacy.get("left") or []),
                "up": list(legacy.get("up") or []),
                "down": list(legacy.get("down") or []),
            }
        else:
            st["range_window"] = {"right": [], "left": [], "up": [], "down": []}
    if "drift_x" not in st:
        st["drift_x"] = 0.0
        st["drift_y"] = 0.0
    if "emit_x_hist" not in st:
        st["emit_x_hist"] = []
    if "emit_y_hist" not in st:
        st["emit_y_hist"] = []
    if "raw_gx0_hist" not in st:
        st["raw_gx0_hist"] = []
    if "logical_raw_x_hist" not in st:
        st["logical_raw_x_hist"] = []
    if "last_good_y_norm" not in st:
        st["last_good_y_norm"] = None
    if "held_y_norm" not in st:
        st["held_y_norm"] = None
    if "last_good_logical_y" not in st:
        st["last_good_logical_y"] = None


def _gaze_clamp_drift(st: dict[str, Any], gz: dict[str, Any]) -> None:
    max_d = max(1e-6, _safe_float(gz.get("neutralDriftMax"), 0.04))
    st["drift_x"] = float(clamp(_safe_float(st.get("drift_x"), 0.0), -max_d, max_d))
    st["drift_y"] = float(clamp(_safe_float(st.get("drift_y"), 0.0), -max_d, max_d))


def _gaze_soft_saturate_norm(n: float, limit: float) -> float:
    """tanh 软饱和：保留符号，压缩极端 norm，避免大面积贴 30/70。"""
    lim = max(1e-6, float(limit))
    return lim * math.tanh(float(n) / lim)


def _gaze_is_vertical_raw_clipped(raw_y_unclamped: float, gz: dict[str, Any]) -> bool:
    thr = _safe_float(gz.get("verticalRawClipThreshold"), 1.25)
    return abs(float(raw_y_unclamped)) > thr


def _gaze_detect_x_neutral_invalid(
    *,
    emit_x_hist: list[float],
    logical_raw_x_hist: list[float],
    gz: dict[str, Any],
    candidate_emit_x: float,
) -> bool:
    """基于输出分布与 logical_raw_x 分布判定 X neutral 失效。"""
    hist_len = max(20, int(_safe_float(gz.get("oneSideHistFrames"), 45)))
    emit_window = list(emit_x_hist) + [float(candidate_emit_x)]
    if len(emit_window) >= hist_len:
        window = emit_window[-hist_len:]
        med = float(statistics.median(window))
        below = sum(1 for x in window if x < 50.0)
        above = sum(1 for x in window if x > 50.0)
        if med > 62.0 and below <= 2:
            return True
        if med < 38.0 and above <= 2:
            return True

    if len(logical_raw_x_hist) >= hist_len:
        window = logical_raw_x_hist[-hist_len:]
        med = float(statistics.median(window))
        n = len(window)
        pos_ratio = sum(1 for x in window if x > 0.0) / n
        neg_ratio = sum(1 for x in window if x < 0.0) / n
        if med > 0.035 and pos_ratio > 0.85:
            return True
        if med < -0.035 and neg_ratio > 0.85:
            return True
    return False


def _gaze_apply_y_range_bounds(
    up_range: float, down_range: float, gz: dict[str, Any]
) -> tuple[float, float]:
    min_up = max(1e-6, _safe_float(gz.get("minRawRangeYUp"), 0.18))
    min_down = max(1e-6, _safe_float(gz.get("minRawRangeYDown"), 0.18))
    up = max(min_up, float(up_range))
    down = max(min_down, float(down_range))
    ratio_min = _safe_float(gz.get("yRangeRatioMin"), 0.5)
    ratio_max = _safe_float(gz.get("yRangeRatioMax"), 2.0)
    if up > 1e-9:
        ratio = down / up
        if ratio < ratio_min:
            down = up * ratio_min
        elif ratio > ratio_max:
            down = up * ratio_max
    if down > 1e-9:
        ratio_up = up / down
        if ratio_up < ratio_min:
            up = down * ratio_min
        elif ratio_up > ratio_max:
            up = down * ratio_max
    return float(up), float(down)


def _gaze_y_range_sample_ok(
    *,
    vertical_raw_clipped: bool,
    x_norm: float,
    logical_x: float,
    gz: dict[str, Any],
) -> bool:
    if vertical_raw_clipped:
        return False
    x_norm_max = _safe_float(gz.get("yRangeHorizontalXNormMax"), 0.35)
    logical_x_max = _safe_float(gz.get("yRangeHorizontalLogicalXMax"), 0.04)
    return abs(float(x_norm)) < x_norm_max and abs(float(logical_x)) < logical_x_max


def _gaze_window_append(buf: list[float], val: float, max_len: int) -> None:
    buf.append(float(val))
    while len(buf) > max_len:
        buf.pop(0)


def _gaze_percentile(values: list[float], p: float) -> float | None:
    if not values:
        return None
    s = sorted(float(v) for v in values)
    idx = int(clamp(float(p), 0.0, 1.0) * (len(s) - 1))
    return float(s[idx])


def _gaze_compute_raw_range(
    deltas: list[float],
    *,
    min_range: float,
    default_range: float,
    min_samples: int,
    percentile: float,
) -> float:
    if len(deltas) >= min_samples:
        pv = _gaze_percentile(deltas, percentile)
        if pv is not None and pv > 1e-9:
            return max(min_range, float(pv))
    return max(min_range, default_range)


def _gaze_lerp(a: float, b: float, t: float) -> float:
    return float(a) + float(t) * (float(b) - float(a))


def _gaze_norm_or_zero(val: float, scale: float) -> float:
    if scale <= 0.0:
        return 0.0
    return float(clamp(abs(val) / scale, 0.0, 1.0))


def _gaze_init_frame_motion(gaze_state: dict[str, Any] | None) -> dict[str, float]:
    if not isinstance(gaze_state, dict):
        return {}
    fm = gaze_state.get("init_frame_motion")
    if not isinstance(fm, dict):
        return {}
    return {
        "noseDeltaPx": _safe_float(fm.get("noseDeltaPx"), 0.0),
        "eyeCenterDeltaPx": _safe_float(fm.get("eyeCenterDeltaPx"), 0.0),
        "faceBoxCenterDeltaPx": _safe_float(fm.get("faceBoxCenterDeltaPx"), 0.0),
    }


def gaze_trace_keys() -> tuple[str, ...]:
    """WebSocket compact / 前端 diagnostic 需保留的 gaze 字段。"""
    return (
        "available",
        "reliabilityScore",
        "irisReliable",
        "rawPrimaryX",
        "rawPrimaryY",
        "rawPrimaryYUnclamped",
        "rawPrimaryYLegacy",
        "rawStableY",
        "rawLidAsymmetryY",
        "rawRightDelta",
        "rawLeftDelta",
        "rawUpDelta",
        "rawDownDelta",
        "autoNeutralX",
        "autoNeutralY",
        "logicalEyeXRightPositive",
        "logicalEyeYUpPositive",
        "verticalRawClipped",
        "verticalReliability",
        "xNormBeforeOutput",
        "yNormBeforeOutput",
        "rightRawRange",
        "leftRawRange",
        "upRawRange",
        "downRawRange",
        "autoRightRange",
        "autoLeftRange",
        "autoUpRange",
        "autoDownRange",
        "rangeSampleCountRight",
        "rangeSampleCountLeft",
        "rangeSampleCountUp",
        "rangeSampleCountDown",
        "upRange",
        "downRange",
        "leftRange",
        "rightRange",
        "sharedRadarXBeforeClamp",
        "sharedRadarYBeforeClamp",
        "candidateSharedRadarX",
        "candidateSharedRadarY",
        "emittedSharedRadarX",
        "emittedSharedRadarY",
        "blinkGazeWeight",
        "outputMode",
        "neutralDriftApplied",
        "neutralDriftDeltaX",
        "neutralDriftDeltaY",
        "xNeutralInvalid",
        "neutralCacheVersion",
        "neutralCacheInvalidated",
        "eyeXyCenterReady",
        "eyeXyCenterCollecting",
        "eyeXyCenterSampleCount",
        "eyeXyCenterEstimatorVersion",
        "eyeXyCenterSessionLocked",
        "freezeReason",
        "eyeLookX",
        "eyeLookY",
        "gazeEstimatorMode",
        "eyeCornerV3ProductionEnabled",
        "eyeCornerV3DebugEnabled",
        "safeCenterActive",
        "safeCenterReason",
        "neutralInitState",
        "neutralInitSampleCount",
        "neutralInitRequiredSamples",
        "neutralInitProgress",
        "neutralInitReady",
        "neutralInitFailed",
        "neutralInitReason",
        "neutralInitRemainingMs",
        "sessionNeutralX",
        "sessionNeutralY",
        "sessionNeutralStableY",
        "neutralPostValidated",
        "neutralPostValidationAdjusted",
        "neutralPostValidationDeltaX",
        "neutralPostValidationDeltaY",
        "gazeConfidence",
        "motionWeight",
        "motionScore",
        "neutralInitYCenterCorrected",
        "legacyRawX",
        "legacyRawY",
        "legacyDx",
        "legacyDy",
        "legacyXNorm",
        "legacyYNorm",
        "legacyIrisReliable",
        "sessionNeutralLegacyX",
        "sessionNeutralLegacyY",
        "legacyNeutralInitState",
        "legacyNeutralInitReady",
        "legacyNeutralInitSampleCount",
        "eyeCornerV3DebugOnly",
        "irisOnlyActive",
        "irisLocalMode",
        "landmarkCount",
        "irisLocalX",
        "irisLocalY",
        "irisLocalDx",
        "irisLocalDy",
        "leftIrisLocalX",
        "leftIrisLocalY",
        "rightIrisLocalX",
        "rightIrisLocalY",
        "irisLocalFusion",
        "irisBaselineLocalX",
        "irisBaselineLocalY",
        "irisXNorm",
        "irisYNorm",
        "irisHeadMotionPx",
        "irisHeadMotionScale",
        "irisWarmupSampleCount",
        "irisWarmupRequiredSamples",
        "irisWarmupFrameIndex",
        "irisInitState",
        "irisInitShowPrompt",
        "irisGazeArmed",
        "frozenByBlink",
        "freezeReason",
        "irisBlinkFreezeActive",
        "irisBlinkLevel",
        "irisBlinkReleaseCount",
        "irisBlinkFreezeFrames",
        "irisBlinkReleaseBlendLeft",
        "eyeBlinkLeftRaw",
        "eyeBlinkRightRaw",
    )


def _apply_gaze_safe_center(
    *,
    rig: dict[str, Any],
    mapping: dict[str, float],
    gaze_dbg: dict[str, Any],
    blend: dict[str, float],
    blink_l: float,
    blink_r: float,
    cfg: dict[str, Any],
    gaze_state: dict[str, Any] | None,
    neutral: dict[str, Any],
    gains: dict[str, Any],
    invert: dict[str, Any],
    deadzone: dict[str, Any],
    limits: dict[str, Any],
    nose_motion: dict[str, Any] | None = None,
    face_detected: bool = True,
    output_mode: str = "safe_center",
    safe_center_reason: str = "eye_corner_v3_disabled",
) -> None:
    """safe_center_v1 / fallback：输出固定中心。"""
    del neutral, gains, invert, deadzone, limits, nose_motion, face_detected
    gz = cfg.get("gaze") if isinstance(cfg.get("gaze"), dict) else {}
    st = gaze_state if gaze_state is not None else {}
    if "last_emit" not in st:
        st["last_emit"] = {"x": 50.0, "y": 50.0}
    lemit = st["last_emit"]

    mode = str(gz.get("gazeEstimatorMode", "safe_center_v1"))
    prod_v3 = bool(gz.get("eyeCornerV3ProductionEnabled", False))
    debug_v3 = bool(gz.get("eyeCornerV3DebugEnabled", False))
    center = 50.0

    raw_l = _safe_float(blend.get("eyeBlinkLeft"), 0.0)
    raw_r = _safe_float(blend.get("eyeBlinkRight"), 0.0)
    gaze_dbg["eyeBlinkLeftRaw"] = float(raw_l)
    gaze_dbg["eyeBlinkRightRaw"] = float(raw_r)
    gaze_dbg["blinkLeftMapping"] = float(blink_l)
    gaze_dbg["blinkRightMapping"] = float(blink_r)

    blink_weight, _blink_reason = _gaze_blink_update_weight(raw_l, raw_r, gz)
    gaze_avail = bool(gaze_dbg.get("available"))
    reliability = _safe_float(gaze_dbg.get("reliabilityScore"), 0.0) if gaze_avail else 0.0
    rel_hold_thr = _safe_float(gz.get("reliabilityHoldThreshold"), 0.12)
    rel_weight = (
        1.0 if reliability >= rel_hold_thr else max(0.35, reliability / max(rel_hold_thr, 1e-6))
    )
    update_weight = float(blink_weight * rel_weight)

    emit_x = center
    emit_y = center

    rig["sharedRadar"]["x"] = float(emit_x)
    rig["sharedRadar"]["y"] = float(emit_y)
    mapping["sharedRadarX"] = float(emit_x)
    mapping["sharedRadarY"] = float(emit_y)
    mapping["eyeLookX"] = 0.0
    mapping["eyeLookY"] = 0.0
    lemit["x"] = float(emit_x)
    lemit["y"] = float(emit_y)

    out_up = max(1.0, _safe_float(gz.get("upRange"), 30.0))
    out_down = max(1.0, _safe_float(gz.get("downRange"), 28.0))
    out_left = max(1.0, _safe_float(gz.get("leftRange"), out_up))
    out_right = max(1.0, _safe_float(gz.get("rightRange"), out_up))

    gaze_dbg["gazeEstimatorMode"] = mode
    gaze_dbg["eyeCornerV3ProductionEnabled"] = prod_v3
    gaze_dbg["eyeCornerV3DebugEnabled"] = debug_v3
    gaze_dbg["safeCenterActive"] = True
    gaze_dbg["safeCenterReason"] = str(safe_center_reason or "eye_corner_v3_disabled")
    gaze_dbg["autoNeutralX"] = 0.0
    gaze_dbg["autoNeutralY"] = 0.0
    gaze_dbg["effectiveNeutralXUsed"] = 0.0
    gaze_dbg["logicalEyeXRightPositive"] = 0.0
    gaze_dbg["logicalEyeYUpPositive"] = 0.0
    gaze_dbg["xNormBeforeOutput"] = 0.0
    gaze_dbg["yNormBeforeOutput"] = 0.0
    gaze_dbg["verticalRawClipped"] = False
    gaze_dbg["verticalReliability"] = 0.0
    gaze_dbg["sharedRadarXBeforeClamp"] = center
    gaze_dbg["sharedRadarYBeforeClamp"] = center
    gaze_dbg["candidateSharedRadarX"] = center
    gaze_dbg["candidateSharedRadarY"] = center
    gaze_dbg["emittedSharedRadarX"] = float(emit_x)
    gaze_dbg["emittedSharedRadarY"] = float(emit_y)
    gaze_dbg["sharedRadarX"] = float(emit_x)
    gaze_dbg["sharedRadarY"] = float(emit_y)
    gaze_dbg["upRange"] = float(out_up)
    gaze_dbg["downRange"] = float(out_down)
    gaze_dbg["leftRange"] = float(out_left)
    gaze_dbg["rightRange"] = float(out_right)
    gaze_dbg["blinkGazeWeight"] = float(blink_weight)
    gaze_dbg["outputMode"] = str(output_mode or "safe_center")
    del debug_v3


def _apply_gaze_neutral_init_collecting(
    *,
    rig: dict[str, Any],
    mapping: dict[str, float],
    gaze_dbg: dict[str, Any],
    blend: dict[str, float],
    blink_l: float,
    blink_r: float,
    cfg: dict[str, Any],
    gaze_state: dict[str, Any] | None,
    init: dict[str, Any],
    output_mode: str = "neutral_init_collecting",
) -> None:
    """neutral init 采集中 / 验证中：临时固定中心 50。"""
    st = gaze_state if gaze_state is not None else {}
    if "last_emit" not in st:
        st["last_emit"] = {"x": 50.0, "y": 50.0}
    lemit = st["last_emit"]
    center = 50.0

    raw_l = _safe_float(blend.get("eyeBlinkLeft"), 0.0)
    raw_r = _safe_float(blend.get("eyeBlinkRight"), 0.0)
    gaze_dbg["eyeBlinkLeftRaw"] = float(raw_l)
    gaze_dbg["eyeBlinkRightRaw"] = float(raw_r)

    blink_weight, _ = _gaze_blink_update_weight(raw_l, raw_r, cfg.get("gaze") or {})
    gaze_dbg["blinkGazeWeight"] = float(blink_weight)

    rig["sharedRadar"]["x"] = center
    rig["sharedRadar"]["y"] = center
    mapping["sharedRadarX"] = center
    mapping["sharedRadarY"] = center
    mapping["eyeLookX"] = 0.0
    mapping["eyeLookY"] = 0.0
    lemit["x"] = center
    lemit["y"] = center

    gaze_dbg["candidateSharedRadarX"] = center
    gaze_dbg["candidateSharedRadarY"] = center
    gaze_dbg["emittedSharedRadarX"] = center
    gaze_dbg["emittedSharedRadarY"] = center
    gaze_dbg["sharedRadarX"] = center
    gaze_dbg["sharedRadarY"] = center
    gaze_dbg["xNormBeforeOutput"] = 0.0
    gaze_dbg["yNormBeforeOutput"] = 0.0
    gaze_dbg["logicalEyeXRightPositive"] = 0.0
    gaze_dbg["logicalEyeYUpPositive"] = 0.0
    gaze_dbg["outputMode"] = str(output_mode or "neutral_init_collecting")
    gaze_dbg["autoNeutralX"] = float(init.get("sessionNeutralX", 0.0))
    gaze_dbg["autoNeutralY"] = float(init.get("sessionNeutralStableY", 0.0))
    _patch_gaze_neutral_init_debug(gaze_dbg, init, cfg.get("gaze") or {})


def _apply_gaze_neutral_init_tracking(
    *,
    rig: dict[str, Any],
    mapping: dict[str, float],
    gaze_dbg: dict[str, Any],
    blend: dict[str, float],
    blink_l: float,
    blink_r: float,
    cfg: dict[str, Any],
    gaze_state: dict[str, Any] | None,
    gains: dict[str, Any],
    deadzone: dict[str, Any],
    limits: dict[str, Any],
    init: dict[str, Any],
    face_detected: bool = True,
) -> None:
    """neutral ready 后：session neutral + confidence gate + Y 限幅输出。"""
    del face_detected
    gz = cfg.get("gaze") if isinstance(cfg.get("gaze"), dict) else {}
    st = gaze_state if gaze_state is not None else {}
    if "last_emit" not in st:
        st["last_emit"] = {"x": 50.0, "y": 50.0}
    if "last_y_norm" not in st:
        st["last_y_norm"] = 0.0
    if "last_x_norm" not in st:
        st["last_x_norm"] = 0.0
    if "low_conf_streak" not in st:
        st["low_conf_streak"] = 0
    lemit = st["last_emit"]

    lim_x = limits.get("eyeLookX", [30.0, 70.0])
    lim_y = limits.get("eyeLookY", [30.0, 70.0])
    lo_x, hi_x = _safe_float(lim_x[0], 30.0), _safe_float(lim_x[1], 70.0)
    lo_y, hi_y = _safe_float(lim_y[0], 30.0), _safe_float(lim_y[1], 70.0)

    raw_l = _safe_float(blend.get("eyeBlinkLeft"), 0.0)
    raw_r = _safe_float(blend.get("eyeBlinkRight"), 0.0)
    gaze_dbg["eyeBlinkLeftRaw"] = float(raw_l)
    gaze_dbg["eyeBlinkRightRaw"] = float(raw_r)

    blink_weight, _blink_reason = _gaze_blink_update_weight(raw_l, raw_r, gz)
    gaze_avail = bool(gaze_dbg.get("available"))
    reliability = _safe_float(gaze_dbg.get("reliabilityScore"), 0.0) if gaze_avail else 0.0
    gaze_dbg["blinkGazeWeight"] = float(blink_weight)

    fm = _gaze_init_frame_motion(st)
    nose_d = fm.get("noseDeltaPx", 0.0)
    eye_d = fm.get("eyeCenterDeltaPx", 0.0)
    face_d = fm.get("faceBoxCenterDeltaPx", 0.0)

    motion_score = max(
        _gaze_norm_or_zero(nose_d, 1.5),
        _gaze_norm_or_zero(eye_d, 1.5),
        _gaze_norm_or_zero(face_d, 2.0),
    )
    motion_weight = float(clamp(1.0 - motion_score, 0.0, 1.0))
    gaze_confidence = float(min(reliability, blink_weight, motion_weight))
    gaze_dbg["motionScore"] = float(motion_score)
    gaze_dbg["motionWeight"] = float(motion_weight)
    gaze_dbg["gazeConfidence"] = float(gaze_confidence)

    neutral_x = _safe_float(init.get("sessionNeutralX"), 0.0)
    neutral_y = _safe_float(init.get("sessionNeutralStableY"), init.get("sessionNeutralY", 0.0))

    raw_x = _safe_float(gaze_dbg.get("rawPrimaryX"), _safe_float(gaze_dbg.get("eyeLookX"), 0.0))
    raw_y = _safe_float(
        gaze_dbg.get("rawStableY"),
        _safe_float(gaze_dbg.get("eyeLookY"), _safe_float(gaze_dbg.get("rawPrimaryY"), 0.0)),
    )

    gx0 = -(raw_x - neutral_x)
    gy0 = raw_y - neutral_y

    dz_x = _safe_float(gz.get("softDeadzoneX"), _safe_float(deadzone.get("eyeLookX"), 0.008))
    dz_y = _safe_float(gz.get("softDeadzoneY"), _safe_float(deadzone.get("eyeLookY"), 0.032))
    knee_x = _safe_float(gz.get("softDeadzoneKneeX"), 0.006)
    knee_y = _safe_float(gz.get("softDeadzoneKneeY"), 0.018)

    gx_soft = apply_soft_deadzone(gx0, dz_x, knee_x)
    gy_soft = apply_soft_deadzone(gy0, dz_y, knee_y)
    logical_x = apply_gain(gx_soft, _safe_float(gains.get("eyeLookX"), 1.0))
    logical_y = apply_gain(gy_soft, _safe_float(gains.get("eyeLookY"), 1.0))

    fix_x = max(1e-6, _safe_float(gz.get("fixedRawRangeX"), 0.10))
    fix_y_up = max(1e-6, _safe_float(gz.get("fixedRawRangeYUp"), 0.28))
    fix_y_down = max(1e-6, _safe_float(gz.get("fixedRawRangeYDown"), 0.28))

    x_norm = float(clamp(logical_x / fix_x, -1.0, 1.0))
    if logical_y >= 0.0:
        y_norm = float(clamp(logical_y / fix_y_up, -1.0, 1.0))
    else:
        y_norm = float(clamp(logical_y / fix_y_down, -1.0, 1.0))

    output_mode = "neutral_init_tracking"
    y_center_corrected = False

    if blink_weight < 0.45:
        y_norm *= 0.25
        x_norm *= 0.5
    if blink_weight < 0.25:
        last_y = _safe_float(st.get("last_y_norm"), 0.0)
        y_norm = _gaze_lerp(last_y, 0.0, 0.2)

    x_xtalk = _safe_float(gz.get("yCrossTalkXNormThreshold"), 0.65)
    y_xtalk = _safe_float(gz.get("yCrossTalkYNormThreshold"), 0.45)
    y_xtalk_scale = _safe_float(gz.get("yCrossTalkAttenuation"), 0.35)
    if abs(x_norm) > x_xtalk and abs(y_norm) < y_xtalk:
        y_norm *= y_xtalk_scale

    if abs(raw_y - neutral_y) > 0.9:
        last_y = _safe_float(st.get("last_y_norm"), 0.0)
        y_norm = _gaze_lerp(last_y, 0.0, 0.15)
        output_mode = "neutral_init_y_outlier_hold"

    if (
        abs(x_norm) < 0.15
        and reliability >= 0.85
        and blink_weight >= 0.85
        and nose_d < 0.8
        and eye_d < 0.8
        and face_d < 1.0
        and abs(y_norm) > 0.25
    ):
        corrected_y = _gaze_lerp(neutral_y, raw_y, 0.05)
        init["sessionNeutralStableY"] = float(corrected_y)
        init["sessionNeutralY"] = float(corrected_y)
        neutral_y = float(corrected_y)
        y_norm *= 0.35
        y_center_corrected = True
        output_mode = "neutral_init_y_center_correction"

    max_y_norm = _safe_float(gz.get("neutralInitMaxYNorm"), 0.55)
    y_norm = float(clamp(y_norm, -max_y_norm, max_y_norm))

    last_x_norm = _safe_float(st.get("last_x_norm"), 0.0)
    last_y_norm = _safe_float(st.get("last_y_norm"), 0.0)

    if gaze_confidence < 0.35:
        x_norm = _gaze_lerp(last_x_norm, 0.0, 0.25)
        y_norm = _gaze_lerp(last_y_norm, 0.0, 0.25)
        output_mode = "neutral_init_low_confidence_hold"
        st["low_conf_streak"] = int(st.get("low_conf_streak", 0)) + 1
    elif gaze_confidence < 0.65:
        amp = float(clamp((gaze_confidence - 0.35) / 0.30, 0.0, 1.0))
        x_norm *= amp
        y_norm *= amp
        output_mode = "neutral_init_low_confidence_soft"
        st["low_conf_streak"] = int(st.get("low_conf_streak", 0)) + 1
    else:
        st["low_conf_streak"] = 0

    if reliability < 0.55:
        x_norm *= 0.25
    if eye_d > 2.0 or nose_d > 2.0:
        x_norm *= 0.35

    if int(st.get("low_conf_streak", 0)) >= 3:
        x_norm = _gaze_lerp(last_x_norm, 0.0, 0.25)

    st["last_x_norm"] = float(x_norm)
    st["last_y_norm"] = float(y_norm)

    out_x_span = max(1.0, _safe_float(gz.get("leftRange"), 30.0))
    out_y_span = max(1.0, _safe_float(gz.get("neutralInitYOutputSpan"), 24.0))

    cand_x = 50.0 + x_norm * out_x_span
    cand_y = 50.0 + y_norm * out_y_span
    cand_x = float(clamp(cand_x, lo_x, hi_x))
    cand_y = float(clamp(cand_y, lo_y, hi_y))

    max_step = max(0.0, _safe_float(gz.get("maxStepPerFrame"), 12.0))
    last_x = _safe_float(lemit.get("x"), 50.0)
    last_y_emit = _safe_float(lemit.get("y"), 50.0)
    emit_x = float(clamp(cand_x, last_x - max_step, last_x + max_step))
    emit_y = float(clamp(cand_y, last_y_emit - max_step, last_y_emit + max_step))

    rig["sharedRadar"]["x"] = emit_x
    rig["sharedRadar"]["y"] = emit_y
    mapping["sharedRadarX"] = emit_x
    mapping["sharedRadarY"] = emit_y
    mapping["eyeLookX"] = float(logical_x)
    mapping["eyeLookY"] = float(logical_y)
    lemit["x"] = emit_x
    lemit["y"] = emit_y

    gaze_dbg["autoNeutralX"] = float(neutral_x)
    gaze_dbg["autoNeutralY"] = float(neutral_y)
    gaze_dbg["effectiveNeutralXUsed"] = float(neutral_x)
    gaze_dbg["logicalEyeXRightPositive"] = float(logical_x)
    gaze_dbg["logicalEyeYUpPositive"] = float(logical_y)
    gaze_dbg["xNormBeforeOutput"] = float(x_norm)
    gaze_dbg["yNormBeforeOutput"] = float(y_norm)
    gaze_dbg["candidateSharedRadarX"] = float(cand_x)
    gaze_dbg["candidateSharedRadarY"] = float(cand_y)
    gaze_dbg["emittedSharedRadarX"] = float(emit_x)
    gaze_dbg["emittedSharedRadarY"] = float(emit_y)
    gaze_dbg["sharedRadarX"] = float(emit_x)
    gaze_dbg["sharedRadarY"] = float(emit_y)
    gaze_dbg["outputMode"] = output_mode
    gaze_dbg["reliabilityScore"] = float(reliability)
    gaze_dbg["neutralInitYCenterCorrected"] = bool(y_center_corrected)
    _patch_gaze_neutral_init_debug(gaze_dbg, init, gz)


def _apply_gaze_legacy_iris_output(
    *,
    rig: dict[str, Any],
    mapping: dict[str, float],
    gaze_dbg: dict[str, Any],
    blend: dict[str, float],
    cfg: dict[str, Any],
    gaze_state: dict[str, Any] | None,
    leg: dict[str, Any],
    limits: dict[str, Any],
    face_detected: bool = True,
) -> None:
    """legacy_iris_offset_v1 生产输出；仅 streak 级 failure 才 safe_center。"""
    gz = cfg.get("gaze") if isinstance(cfg.get("gaze"), dict) else {}
    st = gaze_state if gaze_state is not None else {}
    session = st.get("_legacy_neutral_init_session")
    if session is not None and hasattr(session, "maybe_collect"):
        motion = _gaze_init_frame_motion(st)
        session.maybe_collect(
            gaze_cfg=gz,
            face_detected=bool(face_detected),
            gaze=gaze_dbg,
            blend=blend,
            motion=motion,
        )
        session.sync_to_gaze_state(st)
        leg = _gaze_legacy_neutral_init_state(st)
    if "last_emit" not in st:
        st["last_emit"] = {"x": 50.0, "y": 50.0}
    if "legacy_x_norm" not in st:
        st["legacy_x_norm"] = 0.0
    if "legacy_y_norm" not in st:
        st["legacy_y_norm"] = 0.0
    if "legacy_last_valid_x_norm" not in st:
        st["legacy_last_valid_x_norm"] = 0.0
    if "legacy_last_valid_y_norm" not in st:
        st["legacy_last_valid_y_norm"] = 0.0
    if "legacy_low_conf_streak" not in st:
        st["legacy_low_conf_streak"] = 0
    if "legacy_face_lost_streak" not in st:
        st["legacy_face_lost_streak"] = 0
    if "legacy_iris_lost_streak" not in st:
        st["legacy_iris_lost_streak"] = 0
    lemit = st["last_emit"]

    lim_x = limits.get("eyeLookX", [30.0, 70.0])
    lim_y = limits.get("eyeLookY", [30.0, 70.0])
    lo_x, hi_x = _safe_float(lim_x[0], 30.0), _safe_float(lim_x[1], 70.0)
    lo_y, hi_y = _safe_float(lim_y[0], 30.0), _safe_float(lim_y[1], 70.0)

    streak_thr = max(1, int(_safe_float(gz.get("legacySafeCenterFaceLostFrames"), 10)))
    decay_thr = max(1, int(_safe_float(gz.get("legacyLowConfDecayFrames"), 8)))

    if face_detected:
        st["legacy_face_lost_streak"] = 0
    else:
        st["legacy_face_lost_streak"] = int(st.get("legacy_face_lost_streak", 0)) + 1

    iris_ok = bool(gaze_dbg.get("legacyIrisReliable", gaze_dbg.get("irisReliable")))
    if iris_ok and face_detected:
        st["legacy_iris_lost_streak"] = 0
    else:
        st["legacy_iris_lost_streak"] = int(st.get("legacy_iris_lost_streak", 0)) + 1

    init_state = str(leg.get("legacyNeutralInitState") or "")
    init_ready = legacy_neutral_is_ready(leg)
    init_failed = bool(leg.get("legacyNeutralInitFailed"))

    def _legacy_safe(reason: str, mode: str = "legacy_safe_center") -> None:
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
        gaze_dbg["safeCenterActive"] = True
        gaze_dbg["safeCenterReason"] = reason
        _patch_gaze_legacy_iris_debug(gaze_dbg, leg, gz)

    if int(st.get("legacy_face_lost_streak", 0)) >= streak_thr:
        _legacy_safe("face_lost_streak")
        return
    if int(st.get("legacy_iris_lost_streak", 0)) >= streak_thr:
        _legacy_safe("iris_unavailable_streak")
        return
    if init_failed:
        _legacy_safe(str(leg.get("legacyNeutralInitReason") or "legacy_neutral_failed"))
        return

    if init_state == "collecting_neutral" or not init_ready:
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
        gaze_dbg["outputMode"] = "legacy_init_collecting"
        _patch_gaze_legacy_iris_debug(gaze_dbg, leg, gz)
        return

    neutral_x = leg.get("sessionNeutralLegacyX")
    neutral_y = leg.get("sessionNeutralLegacyY")
    if not isinstance(neutral_x, (int, float)) or not isinstance(neutral_y, (int, float)):
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
        gaze_dbg["outputMode"] = "legacy_init_collecting"
        _patch_gaze_legacy_iris_debug(gaze_dbg, leg, gz)
        return

    raw_x = _safe_float(gaze_dbg.get("legacyRawX"), _safe_float(gaze_dbg.get("eyeLookX"), 0.0))
    raw_y = _safe_float(gaze_dbg.get("legacyRawY"), _safe_float(gaze_dbg.get("eyeLookY"), 0.0))
    dx = raw_x - float(neutral_x)
    dy = raw_y - float(neutral_y)

    fix_x = max(1e-6, _safe_float(gz.get("legacyFixedRangeX"), 0.18))
    fix_y = max(1e-6, _safe_float(gz.get("legacyFixedRangeY"), 0.65))
    x_norm = float(clamp(dx / fix_x, -1.0, 1.0))
    y_norm = float(clamp(-dy / fix_y, -1.0, 1.0))

    if abs(x_norm) < 0.08:
        x_norm = 0.0
    if abs(y_norm) < 0.10:
        y_norm = 0.0

    blink_l = _safe_float(blend.get("eyeBlinkLeft"), 0.0)
    blink_r = _safe_float(blend.get("eyeBlinkRight"), 0.0)
    blink_gaze_weight = compute_legacy_blink_gaze_weight(blink_l, blink_r)
    gaze_dbg["blinkGazeWeight"] = float(blink_gaze_weight)

    last_x = _safe_float(st.get("legacy_x_norm"), 0.0)
    last_y = _safe_float(st.get("legacy_y_norm"), 0.0)
    last_valid_x = _safe_float(st.get("legacy_last_valid_x_norm"), last_x)
    last_valid_y = _safe_float(st.get("legacy_last_valid_y_norm"), last_y)
    output_mode = "legacy_tracking"

    if blink_gaze_weight < 0.35:
        x_norm = last_valid_x
        y_norm = last_valid_y
        output_mode = "legacy_hold_last"
        st["legacy_low_conf_streak"] = int(st.get("legacy_low_conf_streak", 0)) + 1
    else:
        st["legacy_last_valid_x_norm"] = float(x_norm)
        st["legacy_last_valid_y_norm"] = float(y_norm)
        st["legacy_low_conf_streak"] = 0

    if int(st.get("legacy_low_conf_streak", 0)) >= decay_thr:
        x_norm = _gaze_lerp(last_x, 0.0, 0.08)
        y_norm = _gaze_lerp(last_y, 0.0, 0.08)
        output_mode = "legacy_decay_center"

    ema_alpha = _safe_float(gz.get("legacyEmaAlpha"), 0.45)
    x_norm = _gaze_lerp(last_x, x_norm, ema_alpha)
    y_norm = _gaze_lerp(last_y, y_norm, ema_alpha)

    max_delta = _safe_float(gz.get("legacyMaxDeltaNormPerFrame"), 0.16)
    x_norm = float(clamp(x_norm, last_x - max_delta, last_x + max_delta))
    y_norm = float(clamp(y_norm, last_y - max_delta, last_y + max_delta))
    st["legacy_x_norm"] = float(x_norm)
    st["legacy_y_norm"] = float(y_norm)

    out_span_x = max(1.0, _safe_float(gz.get("legacyOutputSpanX"), 22.0))
    out_span_y = max(1.0, _safe_float(gz.get("legacyOutputSpanY"), 12.0))
    cand_x = 50.0 + x_norm * out_span_x
    cand_y = 50.0 + y_norm * out_span_y
    cand_x = float(clamp(cand_x, lo_x, hi_x))
    cand_y = float(clamp(cand_y, lo_y, hi_y))

    max_step = min(8.0, max(1.0, _safe_float(gz.get("legacyMaxStepSharedRadar"), 8.0)))
    last_emit_x = _safe_float(lemit.get("x"), 50.0)
    last_emit_y = _safe_float(lemit.get("y"), 50.0)
    emit_x = float(clamp(cand_x, last_emit_x - max_step, last_emit_x + max_step))
    emit_y = float(clamp(cand_y, last_emit_y - max_step, last_emit_y + max_step))

    rig["sharedRadar"]["x"] = emit_x
    rig["sharedRadar"]["y"] = emit_y
    mapping["sharedRadarX"] = emit_x
    mapping["sharedRadarY"] = emit_y
    mapping["eyeLookX"] = float(x_norm)
    mapping["eyeLookY"] = float(y_norm)
    lemit["x"] = emit_x
    lemit["y"] = emit_y

    leg_out = {
        **leg,
        "legacyDx": float(dx),
        "legacyDy": float(dy),
        "legacyXNorm": float(x_norm),
        "legacyYNorm": float(y_norm),
        "legacyRawX": float(raw_x),
        "legacyRawY": float(raw_y),
        "legacyIrisReliable": bool(iris_ok),
    }
    gaze_dbg["legacyDx"] = float(dx)
    gaze_dbg["legacyDy"] = float(dy)
    gaze_dbg["legacyXNorm"] = float(x_norm)
    gaze_dbg["legacyYNorm"] = float(y_norm)
    gaze_dbg["blinkGazeWeight"] = float(blink_gaze_weight)
    gaze_dbg["xNormBeforeOutput"] = float(x_norm)
    gaze_dbg["yNormBeforeOutput"] = float(y_norm)
    gaze_dbg["candidateSharedRadarX"] = float(cand_x)
    gaze_dbg["candidateSharedRadarY"] = float(cand_y)
    gaze_dbg["emittedSharedRadarX"] = float(emit_x)
    gaze_dbg["emittedSharedRadarY"] = float(emit_y)
    gaze_dbg["sharedRadarX"] = float(emit_x)
    gaze_dbg["sharedRadarY"] = float(emit_y)
    gaze_dbg["outputMode"] = output_mode
    gaze_dbg["safeCenterActive"] = False
    _patch_gaze_legacy_iris_debug(gaze_dbg, leg_out, gz)


def _apply_gaze_shared_radar(
    *,
    rig: dict[str, Any],
    mapping: dict[str, float],
    gaze_dbg: dict[str, Any],
    blend: dict[str, float],
    blink_l: float,
    blink_r: float,
    cfg: dict[str, Any],
    gaze_state: dict[str, Any] | None,
    neutral: dict[str, Any],
    gains: dict[str, Any],
    invert: dict[str, Any],
    deadzone: dict[str, Any],
    limits: dict[str, Any],
    nose_motion: dict[str, Any] | None = None,
    face_detected: bool = True,
) -> None:
    """
    候选 gaze → 四向自适应 range / soft deadzone / neutral drift / blink 分级 → emitted。
    """
    gz = cfg.get("gaze") if isinstance(cfg.get("gaze"), dict) else {}
    init = _gaze_neutral_init_state(gaze_state)
    leg = _gaze_legacy_neutral_init_state(gaze_state)

    if _gaze_is_iris_only_mode(gz):
        return

    if _gaze_is_neutral_init_geometry_mode(gz):
        if _gaze_neutral_init_should_fallback(
            gz, init, face_detected=face_detected, gaze_dbg=gaze_dbg
        ):
            reason = str(init.get("neutralInitReason") or "neutral_init_fallback")
            if not face_detected:
                reason = "face_lost"
            _apply_gaze_safe_center(
                rig=rig,
                mapping=mapping,
                gaze_dbg=gaze_dbg,
                blend=blend,
                blink_l=blink_l,
                blink_r=blink_r,
                cfg=cfg,
                gaze_state=gaze_state,
                neutral=neutral,
                gains=gains,
                invert=invert,
                deadzone=deadzone,
                limits=limits,
                nose_motion=nose_motion,
                face_detected=face_detected,
                output_mode="safe_center",
                safe_center_reason=reason,
            )
            _patch_gaze_neutral_init_debug(gaze_dbg, init, gz)
            return
        init_state = str(init.get("neutralInitState") or "")
        if init_state in ("collecting_neutral", "validating_neutral"):
            collect_mode = (
                "neutral_init_collecting"
                if init_state == "collecting_neutral"
                else "neutral_init_validating"
            )
            _apply_gaze_neutral_init_collecting(
                rig=rig,
                mapping=mapping,
                gaze_dbg=gaze_dbg,
                blend=blend,
                blink_l=blink_l,
                blink_r=blink_r,
                cfg=cfg,
                gaze_state=gaze_state,
                init=init,
                output_mode=collect_mode,
            )
            return
        if bool(init.get("neutralInitReady")) or init_state == "neutral_ready":
            _apply_gaze_neutral_init_tracking(
                rig=rig,
                mapping=mapping,
                gaze_dbg=gaze_dbg,
                blend=blend,
                blink_l=blink_l,
                blink_r=blink_r,
                cfg=cfg,
                gaze_state=gaze_state,
                gains=gains,
                deadzone=deadzone,
                limits=limits,
                init=init,
                face_detected=face_detected,
            )
            return
        _apply_gaze_neutral_init_collecting(
            rig=rig,
            mapping=mapping,
            gaze_dbg=gaze_dbg,
            blend=blend,
            blink_l=blink_l,
            blink_r=blink_r,
            cfg=cfg,
            gaze_state=gaze_state,
            init=init,
            output_mode="neutral_init_collecting",
        )
        return

    if _gaze_is_safe_center_mode(gz):
        _apply_gaze_safe_center(
            rig=rig,
            mapping=mapping,
            gaze_dbg=gaze_dbg,
            blend=blend,
            blink_l=blink_l,
            blink_r=blink_r,
            cfg=cfg,
            gaze_state=gaze_state,
            neutral=neutral,
            gains=gains,
            invert=invert,
            deadzone=deadzone,
            limits=limits,
            nose_motion=nose_motion,
            face_detected=face_detected,
        )
        return

    lim_x = limits.get("eyeLookX", [30.0, 70.0])
    lim_y = limits.get("eyeLookY", [30.0, 70.0])
    lo_x, hi_x = _safe_float(lim_x[0], 30.0), _safe_float(lim_x[1], 70.0)
    lo_y, hi_y = _safe_float(lim_y[0], 30.0), _safe_float(lim_y[1], 70.0)

    st = gaze_state if gaze_state is not None else {}
    _gaze_state_init(st)
    if "last_emit" not in st:
        st["last_emit"] = {"x": 50.0, "y": 50.0}
    lemit = st["last_emit"]
    lx0 = _clamp_pct(_safe_float(lemit.get("x"), 50.0))
    ly0 = _clamp_pct(_safe_float(lemit.get("y"), 50.0))
    adapt = st["range_window"]
    rw = adapt

    guard_off = bool(gz.get("disableGuardForDebug", False))
    max_step = max(0.0, _safe_float(gz.get("maxStepPerFrame"), 12.0))
    rel_hold_thr = _safe_float(gz.get("reliabilityHoldThreshold"), 0.12)
    soft_thr = _safe_float(gz.get("blinkSoftThreshold"), 0.35)

    raw_l = _safe_float(blend.get("eyeBlinkLeft"), 0.0)
    raw_r = _safe_float(blend.get("eyeBlinkRight"), 0.0)
    gaze_dbg["eyeBlinkLeftRaw"] = float(raw_l)
    gaze_dbg["eyeBlinkRightRaw"] = float(raw_r)
    gaze_dbg["blinkLeftMapping"] = float(blink_l)
    gaze_dbg["blinkRightMapping"] = float(blink_r)

    blink_weight, blink_reason = _gaze_blink_update_weight(raw_l, raw_r, gz)

    gaze_avail = bool(gaze_dbg.get("available"))
    reliability = (
        _safe_float(gaze_dbg.get("reliabilityScore"), 0.0) if gaze_avail else 0.0
    )
    gaze_dbg["reliabilityScore"] = float(reliability)
    gaze_dbg["irisReliable"] = bool(reliability >= 0.45)

    config_nx = _safe_float(neutral.get("eyeLookX"), 0.0)
    config_ny = _safe_float(neutral.get("eyeLookY"), 0.0)
    drift_x = _safe_float(st.get("drift_x"), 0.0)
    drift_y = _safe_float(st.get("drift_y"), 0.0)

    out_up = max(1.0, _safe_float(gz.get("upRange"), 30.0))
    out_down = max(1.0, _safe_float(gz.get("downRange"), 28.0))
    out_left = max(1.0, _safe_float(gz.get("leftRange"), out_up))
    out_right = max(1.0, _safe_float(gz.get("rightRange"), out_up))

    gaze_dbg["upRange"] = float(out_up)
    gaze_dbg["downRange"] = float(out_down)
    gaze_dbg["leftRange"] = float(out_left)
    gaze_dbg["rightRange"] = float(out_right)

    min_rx = max(1e-6, _safe_float(gz.get("minRawRangeX"), 0.035))
    min_ry_up = max(1e-6, _safe_float(gz.get("minRawRangeYUp"), 0.18))
    min_ry_down = max(1e-6, _safe_float(gz.get("minRawRangeYDown"), 0.18))
    def_rx = max(min_rx, _safe_float(gz.get("defaultRawRangeX"), 0.055))
    def_ry_up = max(min_ry_up, _safe_float(gz.get("defaultRawRangeYUp"), 0.18))
    def_ry_down = max(min_ry_down, _safe_float(gz.get("defaultRawRangeYDown"), 0.18))
    range_min_samples = max(3, int(_safe_float(gz.get("rangeMinSamples"), 5)))
    range_pct = _safe_float(gz.get("rangePercentile"), 0.88)
    range_window = max(20, int(_safe_float(gz.get("rangeWindowFrames"), _safe_float(gz.get("adaptiveWindowFrames"), 90))))
    soft_lim_x = max(0.3, _safe_float(gz.get("softLimitNormX"), 0.95))
    soft_lim_y = max(0.3, _safe_float(gz.get("softLimitNormY"), 0.68))

    right_raw_range = _gaze_compute_raw_range(
        rw["right"],
        min_range=min_rx,
        default_range=def_rx,
        min_samples=range_min_samples,
        percentile=range_pct,
    )
    left_raw_range = _gaze_compute_raw_range(
        rw["left"],
        min_range=min_rx,
        default_range=def_rx,
        min_samples=range_min_samples,
        percentile=range_pct,
    )
    up_raw_range, down_raw_range = _gaze_apply_y_range_bounds(
        _gaze_compute_raw_range(
            rw["up"],
            min_range=min_ry_up,
            default_range=def_ry_up,
            min_samples=range_min_samples,
            percentile=range_pct,
        ),
        _gaze_compute_raw_range(
            rw["down"],
            min_range=min_ry_down,
            default_range=def_ry_down,
            min_samples=range_min_samples,
            percentile=range_pct,
        ),
        gz,
    )
    if not bool(gz.get("adaptiveRangeEnabled", False)):
        fix_x = max(1e-6, _safe_float(gz.get("fixedRawRangeX"), 0.10))
        fix_up = max(1e-6, _safe_float(gz.get("fixedRawRangeYUp"), 0.22))
        fix_down = max(1e-6, _safe_float(gz.get("fixedRawRangeYDown"), 0.22))
        right_raw_range = left_raw_range = fix_x
        up_raw_range = fix_up
        down_raw_range = fix_down

    gaze_dbg["rightRawRange"] = float(right_raw_range)
    gaze_dbg["leftRawRange"] = float(left_raw_range)
    gaze_dbg["upRawRange"] = float(up_raw_range)
    gaze_dbg["downRawRange"] = float(down_raw_range)
    gaze_dbg["autoRightRange"] = float(right_raw_range)
    gaze_dbg["autoLeftRange"] = float(left_raw_range)
    gaze_dbg["autoUpRange"] = float(up_raw_range)
    gaze_dbg["autoDownRange"] = float(down_raw_range)
    gaze_dbg["rangeSampleCountRight"] = len(rw["right"])
    gaze_dbg["rangeSampleCountLeft"] = len(rw["left"])
    gaze_dbg["rangeSampleCountUp"] = len(rw["up"])
    gaze_dbg["rangeSampleCountDown"] = len(rw["down"])

    x_neutral_invalid = False

    effective_nx = config_nx + drift_x
    effective_ny = config_ny + drift_y
    gaze_dbg["autoNeutralX"] = float(effective_nx)
    gaze_dbg["autoNeutralY"] = float(effective_ny)
    gaze_dbg["effectiveNeutralXUsed"] = float(effective_nx)

    cand_x: float | None = None
    cand_y: float | None = None
    gx1 = 0.0
    logical_y = 0.0
    x_norm = 0.0
    y_norm = 0.0
    y_norm_raw = 0.0
    gx0 = 0.0
    gy0 = 0.0
    logical_raw_x = 0.0
    vertical_raw_clipped = False
    vertical_reliability = 0.0
    raw_stable_y_val = 0.0
    raw_y_unclamped_val = 0.0
    motion_low = True
    vertical_hold_mode = False

    if gaze_avail:
        dz_x = _safe_float(
            gz.get("softDeadzoneX"),
            _safe_float(deadzone.get("eyeLookX"), _safe_float(deadzone.get("eyeLook"), 0.02)),
        )
        dz_y = _safe_float(
            gz.get("softDeadzoneY"),
            _safe_float(deadzone.get("eyeLookY"), _safe_float(deadzone.get("eyeLook"), 0.032)),
        )
        knee_x = _safe_float(gz.get("softDeadzoneKneeX"), 0.012)
        knee_y = _safe_float(gz.get("softDeadzoneKneeY"), 0.018)

        raw_primary_x = _safe_float(
            gaze_dbg.get("rawPrimaryX"),
            _safe_float(gaze_dbg.get("eyeLookX"), 0.0),
        )
        raw_y_unclamped_val = _safe_float(
            gaze_dbg.get("rawPrimaryYUnclamped"),
            _safe_float(gaze_dbg.get("rawPrimaryY"), 0.0),
        )
        raw_stable_y_val = _safe_float(
            gaze_dbg.get("rawStableY"),
            _safe_float(gaze_dbg.get("eyeLookY"), raw_y_unclamped_val),
        )
        raw_primary_y_legacy = _safe_float(
            gaze_dbg.get("rawPrimaryYLegacy"),
            _safe_float(gaze_dbg.get("rawPrimaryY"), raw_y_unclamped_val),
        )
        gaze_dbg["rawPrimaryYLegacy"] = float(raw_primary_y_legacy)
        gaze_dbg["rawStableY"] = float(raw_stable_y_val)
        gaze_dbg["rawPrimaryYUnclamped"] = float(raw_y_unclamped_val)

        vertical_raw_clipped = _gaze_is_vertical_raw_clipped(raw_y_unclamped_val, gz)
        clip_scale = _safe_float(gz.get("verticalReliabilityClipScale"), 0.25)
        vertical_reliability = float(reliability)
        if vertical_raw_clipped:
            vertical_reliability *= clip_scale
        gaze_dbg["verticalRawClipped"] = bool(vertical_raw_clipped)
        gaze_dbg["verticalReliability"] = float(vertical_reliability)

        motion_active = bool(nose_motion.get("motionActive")) if isinstance(nose_motion, dict) else False
        motion_score = _safe_float(nose_motion.get("motionScore"), 0.0) if isinstance(nose_motion, dict) else 0.0
        max_nose_motion = _safe_float(gz.get("autoEyeCenterMaxNoseMotion"), 0.012)
        motion_low = (not motion_active) and motion_score < max_nose_motion

        gx0 = raw_primary_x - effective_nx
        logical_raw_x = -gx0
        gaze_dbg["rawRightDelta"] = float(max(0.0, logical_raw_x))
        gaze_dbg["rawLeftDelta"] = float(max(0.0, -logical_raw_x))

        gx_soft = apply_soft_deadzone(logical_raw_x, dz_x, knee_x)
        gx1 = apply_gain(gx_soft, _safe_float(gains.get("eyeLookX"), 1.0))
        gaze_dbg["logicalEyeXRightPositive"] = float(gx1)

        if vertical_raw_clipped:
            last_logical = st.get("last_good_logical_y")
            logical_y = float(last_logical) if isinstance(last_logical, (int, float)) else 0.0
            gaze_dbg["rawUpDelta"] = 0.0
            gaze_dbg["rawDownDelta"] = 0.0
            gaze_dbg["logicalEyeYUpPositive"] = float(logical_y)
            hold_alpha = _safe_float(gz.get("verticalClippedHoldAlpha"), 0.10)
            held = st.get("held_y_norm")
            if isinstance(held, (int, float)):
                last_hold = float(held)
            else:
                last_good = st.get("last_good_y_norm")
                last_hold = float(last_good) if isinstance(last_good, (int, float)) else 0.0
            y_norm_raw = _gaze_lerp(last_hold, 0.0, hold_alpha)
            st["held_y_norm"] = float(y_norm_raw)
            vertical_hold_mode = True
            gy0 = 0.0
        else:
            gy0 = raw_stable_y_val - effective_ny
            gaze_dbg["rawUpDelta"] = float(max(0.0, gy0))
            gaze_dbg["rawDownDelta"] = float(max(0.0, -gy0))
            gy_soft = apply_soft_deadzone(gy0, dz_y, knee_y)
            logical_y = apply_gain(gy_soft, _safe_float(gains.get("eyeLookY"), 1.0))
            gaze_dbg["logicalEyeYUpPositive"] = float(logical_y)
            st["last_good_logical_y"] = float(logical_y)
            if logical_y >= 0.0:
                y_norm_raw = float(logical_y) / max(1e-6, up_raw_range)
            else:
                y_norm_raw = float(logical_y) / max(1e-6, down_raw_range)

        if gx1 >= 0.0:
            x_norm_raw = float(gx1) / max(1e-6, right_raw_range)
        else:
            x_norm_raw = float(gx1) / max(1e-6, left_raw_range)
        x_norm = _gaze_soft_saturate_norm(x_norm_raw, soft_lim_x)
        y_norm = _gaze_soft_saturate_norm(y_norm_raw, soft_lim_y)
        if not vertical_raw_clipped:
            st["last_good_y_norm"] = float(y_norm)
            st["held_y_norm"] = None
        y_strong_x_thr = _safe_float(gz.get("yStrongMotionXNormThreshold"), 0.45)
        y_strong_x_scale = _safe_float(gz.get("yStrongMotionXAttenuation"), 0.25)
        if vertical_raw_clipped or abs(y_norm) > y_strong_x_thr:
            x_norm *= y_strong_x_scale
        xnorm_thr = _safe_float(gz.get("yCrossTalkXNormThreshold"), 0.7)
        yn_norm_thr = _safe_float(gz.get("yCrossTalkYNormThreshold"), 0.35)
        y_xtalk_scale = _safe_float(gz.get("yCrossTalkAttenuation"), 0.35)
        if abs(x_norm) > xnorm_thr and abs(y_norm) < yn_norm_thr:
            y_norm *= y_xtalk_scale
        rel_weight_pre = (
            1.0
            if reliability >= rel_hold_thr
            else max(0.35, reliability / max(rel_hold_thr, 1e-6))
        )
        if vertical_raw_clipped:
            rel_weight_pre *= _safe_float(gz.get("verticalReliabilityClipScale"), 0.25)
        pre_blink_gaze_weight = float(blink_weight * rel_weight_pre)
        if blink_reason == "blink_soft" or pre_blink_gaze_weight < 0.35:
            confidence_amp = 0.25 + 0.75 * pre_blink_gaze_weight
            x_norm *= confidence_amp
            y_norm *= confidence_amp
        gaze_dbg["xNormBeforeOutput"] = float(x_norm)
        gaze_dbg["yNormBeforeOutput"] = float(y_norm)

        cand_x_before = 50.0 + (x_norm * out_right if x_norm >= 0.0 else x_norm * out_left)
        cand_y_before = 50.0 + (y_norm * out_up if y_norm >= 0.0 else y_norm * out_down)
        x_invalid_emit_lo = _safe_float(gz.get("xNeutralInvalidEmitLo"), 42.0)
        x_invalid_emit_hi = _safe_float(gz.get("xNeutralInvalidEmitHi"), 58.0)
        if bool(gz.get("xNeutralInvalidCandidateClamp", False)) and bool(
            gz.get("xNeutralInvalidEnabled", False)
        ):
            x_neutral_invalid_dbg = _gaze_detect_x_neutral_invalid(
                emit_x_hist=list(st.get("emit_x_hist") or []),
                logical_raw_x_hist=list(st.get("logical_raw_x_hist") or []),
                gz=gz,
                candidate_emit_x=float(cand_x_before),
            )
            if x_neutral_invalid_dbg:
                cand_x_before = float(clamp(cand_x_before, x_invalid_emit_lo, x_invalid_emit_hi))
        gaze_dbg["sharedRadarXBeforeClamp"] = float(cand_x_before)
        gaze_dbg["sharedRadarYBeforeClamp"] = float(cand_y_before)
        cand_x = float(clamp(cand_x_before, lo_x, hi_x))
        cand_y = float(clamp(cand_y_before, lo_y, hi_y))

        range_track_delta = _safe_float(gz.get("rangeMinTrackDelta"), 0.002)
        range_rel_min = _safe_float(gz.get("rangeReliabilityMin"), 0.55)
        range_blink_min = _safe_float(gz.get("rangeBlinkWeightMin"), 0.45)
        y_sample_ok = _gaze_y_range_sample_ok(
            vertical_raw_clipped=vertical_raw_clipped,
            x_norm=x_norm,
            logical_x=gx1,
            gz=gz,
        )
        if (
            bool(gz.get("adaptiveRangeEnabled", False))
            and bool(face_detected)
            and reliability > range_rel_min
            and blink_weight > range_blink_min
            and blink_reason != "blink_hold"
        ):
            if logical_raw_x > range_track_delta:
                _gaze_window_append(rw["right"], logical_raw_x, range_window)
            if logical_raw_x < -range_track_delta:
                _gaze_window_append(rw["left"], -logical_raw_x, range_window)
            if y_sample_ok:
                if gy0 > range_track_delta:
                    _gaze_window_append(rw["up"], gy0, range_window)
                if gy0 < -range_track_delta:
                    _gaze_window_append(rw["down"], -gy0, range_window)

        lrx_hist: list[float] = list(st.get("logical_raw_x_hist") or [])
        lrx_hist.append(float(logical_raw_x))
        while len(lrx_hist) > range_window:
            lrx_hist.pop(0)
        st["logical_raw_x_hist"] = lrx_hist
    else:
        gaze_dbg["rawRightDelta"] = 0.0
        gaze_dbg["rawLeftDelta"] = 0.0
        gaze_dbg["rawUpDelta"] = 0.0
        gaze_dbg["rawDownDelta"] = 0.0
        gaze_dbg["xNormBeforeOutput"] = 0.0
        gaze_dbg["yNormBeforeOutput"] = 0.0
        gaze_dbg["verticalRawClipped"] = False
        gaze_dbg["verticalReliability"] = 0.0
        gaze_dbg["xNeutralInvalid"] = bool(x_neutral_invalid)
        gaze_dbg["neutralDriftApplied"] = False
        gaze_dbg["neutralDriftDeltaX"] = 0.0
        gaze_dbg["neutralDriftDeltaY"] = 0.0
        gaze_dbg["rangeSampleCountRight"] = len(rw["right"])
        gaze_dbg["rangeSampleCountLeft"] = len(rw["left"])
        gaze_dbg["rangeSampleCountUp"] = len(rw["up"])
        gaze_dbg["rangeSampleCountDown"] = len(rw["down"])

    gaze_dbg["candidateSharedRadarX"] = cand_x
    gaze_dbg["candidateSharedRadarY"] = cand_y

    rel_weight = 1.0 if reliability >= rel_hold_thr else max(0.35, reliability / max(rel_hold_thr, 1e-6))
    if gaze_avail and vertical_raw_clipped:
        rel_weight *= _safe_float(gz.get("verticalReliabilityClipScale"), 0.25)
    update_weight = float(blink_weight * rel_weight)
    gaze_dbg["blinkGazeWeight"] = float(update_weight)
    if bool(gz.get("xNeutralInvalidEnabled", False)):
        x_hist_pre = list(st.get("emit_x_hist") or [])
        x_neutral_invalid = _gaze_detect_x_neutral_invalid(
            emit_x_hist=x_hist_pre,
            logical_raw_x_hist=list(st.get("logical_raw_x_hist") or []),
            gz=gz,
            candidate_emit_x=float(cand_x if cand_x is not None else 50.0),
        )
    else:
        x_neutral_invalid = False
    gaze_dbg["xNeutralInvalid"] = bool(x_neutral_invalid)

    last_valid: dict[str, Any] | None = st.get("last_valid")

    freeze_reason = ""
    frozen_by_blink = False
    held_last = False
    limited_by_step = False
    output_mode = "normal"
    emit_x = 50.0
    emit_y = 50.0
    map_ex = None
    map_ey = None

    def _emit(rx: float, ry: float, mex: float | None, mey: float | None) -> None:
        nonlocal emit_x, emit_y, map_ex, map_ey
        emit_x = _clamp_pct(rx)
        emit_y = _clamp_pct(ry)
        map_ex = mex
        map_ey = mey

    target_x = cand_x
    target_y = cand_y
    last_emit_x = _safe_float(lemit.get("x"), 50.0)
    last_emit_y = _safe_float(lemit.get("y"), 50.0)

    if guard_off:
        freeze_reason = ""
        frozen_by_blink = False
        held_last = False
        limited_by_step = False
        output_mode = "normal"
        if gaze_avail and target_x is not None and target_y is not None:
            _emit(target_x, target_y, float(gx1), float(logical_y))
            st["last_valid"] = {
                "x": float(emit_x),
                "y": float(emit_y),
                "eyeLookX": float(gx1),
                "eyeLookY": float(logical_y),
                "updatedAt": float(time.time()),
            }
        elif last_valid is not None:
            held_last = True
            _emit(last_emit_x, last_emit_y, None, None)
        else:
            _emit(50.0, 50.0, None, None)
    elif not gaze_avail:
        freeze_reason = "gaze_unavailable"
        output_mode = "normal"
        if last_valid is not None:
            held_last = True
            _emit(last_emit_x, last_emit_y, None, None)
        else:
            _emit(50.0, 50.0, None, None)
    else:
        assert target_x is not None and target_y is not None
        tcx = float(target_x)
        tcy = float(target_y)
        blink_value = max(raw_l, raw_r)
        hold_thr = _safe_float(gz.get("blinkHoldThreshold"), 0.90)
        soft_mid = _safe_float(gz.get("blinkSoftMidThreshold"), 0.70)
        cand_clear_thr = _safe_float(gz.get("candidateClearThreshold"), 10.0)
        cand_follow_alpha = _safe_float(gz.get("candidateFollowAlphaWhenBlinkHigh"), 0.25)
        hold_return_alpha = _safe_float(gz.get("blinkHoldReturnAlpha"), 0.15)
        candidate_clear = abs(tcx - 50.0) > cand_clear_thr or abs(tcy - 50.0) > cand_clear_thr

        if blink_value >= hold_thr:
            frozen_by_blink = True
            if candidate_clear:
                freeze_reason = "blink_high_candidate_follow"
                output_mode = "blink_high_candidate_follow"
                _emit(
                    _gaze_lerp(last_emit_x, tcx, cand_follow_alpha),
                    _gaze_lerp(last_emit_y, tcy, cand_follow_alpha),
                    float(gx1),
                    float(logical_y),
                )
            else:
                freeze_reason = "blink_hold"
                output_mode = "blink_hold_return_center"
                _emit(
                    _gaze_lerp(last_emit_x, 50.0, hold_return_alpha),
                    _gaze_lerp(last_emit_y, 50.0, hold_return_alpha),
                    None,
                    None,
                )
        elif blink_value >= soft_mid:
            freeze_reason = "blink_soft"
            output_mode = "blink_soft"
            _emit(
                _gaze_lerp(last_emit_x, tcx, cand_follow_alpha),
                _gaze_lerp(last_emit_y, tcy, cand_follow_alpha),
                float(gx1),
                float(logical_y),
            )
        else:
            if reliability < rel_hold_thr:
                freeze_reason = "reliability_soft"
                output_mode = "normal"
            elif abs(x_norm) < 0.03 and abs(y_norm) < 0.03:
                output_mode = "deadzone_center"
            if last_valid is not None and update_weight < 0.999:
                target_x = last_emit_x + update_weight * (tcx - last_emit_x)
                target_y = last_emit_y + update_weight * (tcy - last_emit_y)
            else:
                target_x = tcx
                target_y = tcy
            if last_valid is None:
                _emit(target_x, target_y, float(gx1), float(logical_y))
                limited_by_step = False
            else:
                nx = float(clamp(float(target_x), lx0 - max_step, lx0 + max_step))
                ny = float(clamp(float(target_y), ly0 - max_step, ly0 + max_step))
                limited_by_step = abs(nx - target_x) > 1e-6 or abs(ny - target_y) > 1e-6
                _emit(nx, ny, float(gx1), float(logical_y))
        st["last_valid"] = {
            "x": float(emit_x),
            "y": float(emit_y),
            "eyeLookX": float(gx1),
            "eyeLookY": float(logical_y),
            "updatedAt": float(time.time()),
        }

    emit_hist_len = max(20, int(_safe_float(gz.get("oneSideHistFrames"), 45)))
    x_hist: list[float] = list(st.get("emit_x_hist") or [])
    x_hist.append(float(emit_x))
    while len(x_hist) > emit_hist_len:
        x_hist.pop(0)
    st["emit_x_hist"] = x_hist

    blink_output_modes = (
        "blink_hold_return_center",
        "blink_high_candidate_follow",
        "blink_soft",
    )
    if (
        vertical_raw_clipped
        and vertical_hold_mode
        and output_mode not in blink_output_modes
    ):
        output_mode = "vertical_clipped_hold_last_good"

    rig["sharedRadar"]["x"] = float(emit_x)
    rig["sharedRadar"]["y"] = float(emit_y)
    mapping["sharedRadarX"] = float(emit_x)
    mapping["sharedRadarY"] = float(emit_y)
    if map_ex is not None:
        mapping["eyeLookX"] = float(map_ex)
    if map_ey is not None:
        mapping["eyeLookY"] = float(map_ey)
    lemit["x"] = float(emit_x)
    lemit["y"] = float(emit_y)

    drift_x_before = _safe_float(st.get("drift_x"), 0.0)
    drift_y_before = _safe_float(st.get("drift_y"), 0.0)
    enable_y_drift = bool(gz.get("enableYNeutralDrift", False))

    if (
        gaze_avail
        and bool(gz.get("neutralDriftEnabled", False))
        and not x_neutral_invalid
    ):
        rel_drift_min = _safe_float(gz.get("neutralDriftReliabilityMin"), 0.45)
        drift_blink_min = _safe_float(gz.get("neutralDriftBlinkWeightMin"), 0.45)
        emit_thr = _safe_float(gz.get("neutralDriftEmitThreshold"), 8.0)
        look_away_thr = _safe_float(gz.get("neutralDriftLookAwayThreshold"), 0.012)
        alpha = _safe_float(gz.get("neutralDriftAlpha"), 0.004)

        if (
            reliability >= rel_drift_min
            and blink_weight > drift_blink_min
            and blink_reason != "blink_hold"
            and abs(float(emit_x) - 50.0) < emit_thr
            and abs(float(emit_y) - 50.0) < emit_thr
            and abs(gx0) < look_away_thr
            and abs(gy0) < look_away_thr
        ):
            gx0_hist = list(st.get("raw_gx0_hist") or [])
            mean_gx0 = sum(gx0_hist) / len(gx0_hist) if gx0_hist else gx0
            if abs(mean_gx0) < look_away_thr:
                st["drift_x"] = drift_x_before + alpha * gx0

        if enable_y_drift:
            y_rel_min = _safe_float(gz.get("neutralDriftYReliabilityMin"), 0.85)
            y_blink_min = _safe_float(gz.get("neutralDriftYBlinkWeightMin"), 0.85)
            y_alpha = _safe_float(gz.get("neutralDriftYAlpha"), 0.003)
            y_emit_thr = _safe_float(gz.get("neutralDriftYEmitThreshold"), 5.0)
            y_raw_max = _safe_float(gz.get("neutralDriftYRawPrimaryMax"), 0.75)
            if not motion_low and isinstance(nose_motion, dict):
                motion_active = bool(nose_motion.get("motionActive"))
                motion_score = _safe_float(nose_motion.get("motionScore"), 0.0)
                max_nose_motion = _safe_float(gz.get("autoEyeCenterMaxNoseMotion"), 0.012)
                motion_low = (not motion_active) and motion_score < max_nose_motion

            if (
                reliability >= y_rel_min
                and update_weight >= y_blink_min
                and blink_reason != "blink_hold"
                and not vertical_raw_clipped
                and abs(raw_stable_y_val) < y_raw_max
                and motion_low
                and abs(float(emit_x) - 50.0) < y_emit_thr
                and abs(float(emit_y) - 50.0) < y_emit_thr
                and abs(gy0) < look_away_thr
            ):
                st["drift_y"] = drift_y_before + y_alpha * gy0

        if bool(gz.get("oneSideDriftEnabled", False)) and len(x_hist) >= emit_hist_len:
            has_right = any(x > 50.5 for x in x_hist)
            has_left = any(x < 49.5 for x in x_hist)
            side_step = _safe_float(gz.get("oneSideDriftStep"), 0.0025)
            lrx_hist = list(st.get("logical_raw_x_hist") or [])
            mean_lrx = sum(lrx_hist) / len(lrx_hist) if lrx_hist else logical_raw_x
            cur_drift_x = _safe_float(st.get("drift_x"), drift_x_before)
            if not has_right and has_left:
                st["drift_x"] = cur_drift_x - side_step
            elif has_right and not has_left:
                st["drift_x"] = cur_drift_x + side_step
            elif not has_right and not has_left and len(lrx_hist) >= 20:
                if mean_lrx < -0.004:
                    st["drift_x"] = cur_drift_x - side_step
                elif mean_lrx > 0.004:
                    st["drift_x"] = cur_drift_x + side_step

        _gaze_clamp_drift(st, gz)

    drift_x_after = _safe_float(st.get("drift_x"), 0.0)
    drift_y_after = _safe_float(st.get("drift_y"), 0.0)
    drift_delta_x = drift_x_after - drift_x_before
    drift_delta_y = drift_y_after - drift_y_before
    neutral_drift_applied = abs(drift_delta_x) > 1e-9 or abs(drift_delta_y) > 1e-9

    gaze_dbg["neutralDriftApplied"] = bool(neutral_drift_applied)
    gaze_dbg["neutralDriftDeltaX"] = float(drift_delta_x)
    gaze_dbg["neutralDriftDeltaY"] = float(drift_delta_y)
    gaze_dbg["autoNeutralX"] = float(effective_nx)
    gaze_dbg["autoNeutralY"] = float(effective_ny)
    gaze_dbg["effectiveNeutralXUsed"] = float(effective_nx)
    gaze_dbg["rangeSampleCountRight"] = len(rw["right"])
    gaze_dbg["rangeSampleCountLeft"] = len(rw["left"])
    gaze_dbg["rangeSampleCountUp"] = len(rw["up"])
    gaze_dbg["rangeSampleCountDown"] = len(rw["down"])

    gaze_dbg["freezeReason"] = freeze_reason
    gaze_dbg["frozenByBlink"] = bool(frozen_by_blink)
    gaze_dbg["heldLastValid"] = bool(held_last)
    gaze_dbg["limitedByMaxStep"] = bool(limited_by_step)
    gaze_dbg["outputMode"] = output_mode
    gaze_dbg["emittedSharedRadarX"] = float(emit_x)
    gaze_dbg["emittedSharedRadarY"] = float(emit_y)
    gaze_dbg["lastValidSharedRadarX"] = float(st["last_valid"]["x"]) if st.get("last_valid") else None
    gaze_dbg["lastValidSharedRadarY"] = float(st["last_valid"]["y"]) if st.get("last_valid") else None

    gaze_dbg["stable"] = bool(
        (guard_off and gaze_avail)
        or (
            not guard_off
            and gaze_avail
            and reliability >= 0.45
            and not frozen_by_blink
            and not held_last
            and freeze_reason == ""
        )
    )

    gaze_dbg["sharedRadarX"] = float(emit_x)
    gaze_dbg["sharedRadarY"] = float(emit_y)
    if "eyeLookX" in mapping:
        gaze_dbg["eyeLookX"] = float(mapping["eyeLookX"])
    if "eyeLookY" in mapping:
        gaze_dbg["eyeLookY"] = float(mapping["eyeLookY"])


def mediapipe_result_to_rig(
    result: Any,
    config: dict[str, Any] | None = None,
    gaze_state: dict[str, Any] | None = None,
    lip_state: dict[str, Any] | None = None,
    jaw_state: dict[str, Any] | None = None,
    nose_state: dict[str, Any] | None = None,
    mouth_scenario_state: dict[str, Any] | None = None,
    brow_state: dict[str, Any] | None = None,
    mouth_corner_state: dict[str, Any] | None = None,
    *,
    timestamp_ms: float | None = None,
) -> dict[str, Any]:
    """
    将带 blendshapes 的 FaceLandmarkerResult 转为 Elite Rig，并附带 debug。

    返回: { "rig": dict, "debug": { "blendshapes": {...}, "mapping": {...} } }
    """
    cfg = normalize_mapping_config(config) if config is not None else create_default_mapping_config()
    neutral = cfg["neutral"]
    gains = cfg["gains"]
    invert = cfg["invert"]
    deadzone = cfg["deadzone"]
    limits = cfg["limits"]

    blend = extract_debug_blendshapes(result)
    rig = create_neutral_rig()
    mapping: dict[str, float] = {}

    lim_bl = limits.get("blink", [0.0, 100.0])
    lo_b, hi_b = _safe_float(lim_bl[0], 0.0), _safe_float(lim_bl[1], 100.0)

    ebl = blend["eyeBlinkLeft"]
    ebl_cent = ebl - _safe_float(neutral.get("eyeBlinkLeft"), 0.0)
    blink_l = _pipe_unipolar_strength(
        ebl_cent,
        deadzone_thr=_safe_float(deadzone.get("blink"), 0.03),
        gain=_safe_float(gains.get("blinkLeft"), 1.0),
        invert=bool(invert.get("blinkLeft")),
        lim_lo=lo_b,
        lim_hi=hi_b,
    )

    ebr = blend["eyeBlinkRight"]
    ebr_cent = ebr - _safe_float(neutral.get("eyeBlinkRight"), 0.0)
    blink_r = _pipe_unipolar_strength(
        ebr_cent,
        deadzone_thr=_safe_float(deadzone.get("blink"), 0.03),
        gain=_safe_float(gains.get("blinkRight"), 1.0),
        invert=bool(invert.get("blinkRight")),
        lim_lo=lo_b,
        lim_hi=hi_b,
    )

    eye_cfg = cfg.get("eye") if isinstance(cfg.get("eye"), dict) else {}
    bias_l = _safe_float(eye_cfg.get("openBiasLeft"), 20.0)
    bias_r = _safe_float(eye_cfg.get("openBiasRight"), 20.0)
    ratio_open = _safe_float(eye_cfg.get("lowerLidOpenRatio"), 0.25)
    ratio_close = _safe_float(eye_cfg.get("lowerLidCloseRatio"), 0.5)
    use_wide = bool(eye_cfg.get("useEyeWide"))
    wide_scale = _safe_float(eye_cfg.get("eyeWideScale"), 30.0)
    mapping["eyeOpenBiasLeft"] = float(bias_l)
    mapping["eyeOpenBiasRight"] = float(bias_r)

    wide_l = 0.0
    wide_r = 0.0
    if use_wide:
        wide_l = max(
            0.0,
            blend["eyeWideLeft"] - _safe_float(neutral.get("eyeWideLeft"), 0.0),
        )
        wide_r = max(
            0.0,
            blend["eyeWideRight"] - _safe_float(neutral.get("eyeWideRight"), 0.0),
        )
    boost_l = wide_l * wide_scale if use_wide else 0.0
    boost_r = wide_r * wide_scale if use_wide else 0.0

    rig["eyeL"]["up"] = _clamp_signed100(bias_l - blink_l + boost_l)
    rig["eyeL"]["lo"] = _clamp_signed100(blink_l * ratio_close - bias_l * ratio_open)
    mapping["blinkLeft"] = blink_l
    mapping["eyeLUp"] = float(rig["eyeL"]["up"])
    mapping["eyeLLo"] = float(rig["eyeL"]["lo"])

    rig["eyeR"]["up"] = _clamp_signed100(bias_r - blink_r + boost_r)
    rig["eyeR"]["lo"] = _clamp_signed100(blink_r * ratio_close - bias_r * ratio_open)
    mapping["blinkRight"] = blink_r
    mapping["eyeRUp"] = float(rig["eyeR"]["up"])
    mapping["eyeRLo"] = float(rig["eyeR"]["lo"])

    lim_sm = limits.get("smile", [0.0, 100.0])
    lo_s, hi_s = _safe_float(lim_sm[0], 0.0), _safe_float(lim_sm[1], 100.0)

    smile_l_raw = blend["mouthSmileLeft"]
    smile_l_cent = smile_l_raw - _safe_float(neutral.get("mouthSmileLeft"), 0.0)
    smile_l_val = _pipe_unipolar_strength(
        smile_l_cent,
        deadzone_thr=_safe_float(deadzone.get("smile"), 0.03),
        gain=_safe_float(gains.get("smileLeft"), 1.0),
        invert=bool(invert.get("smileLeft")),
        lim_lo=lo_s,
        lim_hi=hi_s,
    )
    mapping["smileLeft"] = smile_l_val

    smile_r_raw = blend["mouthSmileRight"]
    smile_r_cent = smile_r_raw - _safe_float(neutral.get("mouthSmileRight"), 0.0)
    smile_r_val = _pipe_unipolar_strength(
        smile_r_cent,
        deadzone_thr=_safe_float(deadzone.get("smile"), 0.03),
        gain=_safe_float(gains.get("smileRight"), 1.0),
        invert=bool(invert.get("smileRight")),
        lim_lo=lo_s,
        lim_hi=hi_s,
    )
    mapping["smileRight"] = smile_r_val
    # 嘴角 pad 写入推迟到 Nose / Scenario 之后（mouth_corner_geometry）；
    # Scenario 使用 legacy smile evidence，避免 landmark-2d-v2 改变 Jaw/Lip gate。

    from jaw_geometry import apply_jaw_geometry_drive, compute_jaw_raw_evidence
    from lip_geometry import apply_lip_geometry_drive, compute_lip_raw_evidence
    from nose_anchor_frame import process_nose_anchor
    from mouth_scenario import (
        classify_mouth_scenario,
        compute_head_motion_evidence,
        compute_raw_mouth_evidence,
    )
    from mouth_corner_geometry import apply_mouth_corner_to_rig

    lip_quality = estimate_tracking_quality(result, True)
    lip_neutral_ready = bool(lip_state.get("neutral_ready")) if isinstance(lip_state, dict) else False
    jaw_neutral_ready = bool(jaw_state.get("neutral_ready")) if isinstance(jaw_state, dict) else False

    # Nose Anchor Gate V1：每帧只计算一次，供 head motion 证据使用（不再单独决定 closedHeadTurnLock）。
    nose_lm = extract_landmarks(result)
    nose_motion = process_nose_anchor(
        nose_state,
        nose_lm,
        cfg,
        get_landmark_xy,
        face_detected=True,
    )

    # ---- Mouth Scenario Classifier V2（Evidence First）：每帧只判定一次，jaw / lip 共用 ----
    lip_ev = compute_lip_raw_evidence(result, cfg, lip_state)
    jaw_ev = compute_jaw_raw_evidence(result, cfg, jaw_state, blend, neutral, gains, deadzone)
    mouth_open_avail = "mouthOpen" in blend
    blend_mouth_open = (
        abs((_safe_float(blend.get("mouthOpen"), 0.0) - _safe_float(neutral.get("mouthOpen"), 0.0)) * 100.0)
        if mouth_open_avail
        else 0.0
    )
    blend_jaw_open = abs((_safe_float(blend.get("jawOpen"), 0.0) - _safe_float(neutral.get("jawOpen"), 0.0)) * 100.0)
    jaw_open_norm = abs(_safe_float(blend.get("jawOpen"), 0.0) - _safe_float(neutral.get("jawOpen"), 0.0))
    mouth_funnel_norm = max(0.0, _safe_float(blend.get("mouthFunnel"), 0.0) - _safe_float(neutral.get("mouthFunnel"), 0.0))
    # Scenario 兼容证据：旧 smile→对角线水平分量，不读取 side* pad（避免 v2 改变 gate）
    legacy_smile_corner_evidence = max(float(smile_l_val) * 0.35, float(smile_r_val) * 0.35)
    corner_offset_abs = float(legacy_smile_corner_evidence)
    corner_available = True
    raw_mouth_evidence = compute_raw_mouth_evidence(
        lip_abs_max=float(lip_ev.get("lipAbsMax", 0.0)),
        aperture_abs=float(jaw_ev.get("apertureAbs", 0.0)),
        jaw_input_abs=float(jaw_ev.get("jawInputAbs", 0.0)),
        jaw_score=float(jaw_ev.get("jawScore", 0.0)),
        blend_mouth_open=float(blend_mouth_open),
        blend_jaw_open=float(blend_jaw_open),
        corner_offset_abs=float(corner_offset_abs),
        jaw_open_norm=float(jaw_open_norm),
        mouth_funnel_norm=float(mouth_funnel_norm),
        available={
            "lip": bool(lip_ev.get("available", {}).get("lip")),
            "aperture": bool(jaw_ev.get("available", {}).get("aperture")),
            "jaw": bool(jaw_ev.get("available", {}).get("jaw")),
            "blendshape": bool(mouth_open_avail or ("jawOpen" in blend)),
            "corner": bool(corner_available),
        },
        cfg=cfg,
    )
    head_motion_evidence = compute_head_motion_evidence(
        nose_anchor_motion=bool(nose_motion.get("motionActive")),
        nose_motion_score=float(nose_motion.get("motionScore", 0.0)),
        mouth_pose_motion_score=float(lip_ev.get("mouthPoseMotionScore", 0.0)),
        cfg=cfg,
    )
    scenario_classifier = classify_mouth_scenario(
        mouth_scenario_state,
        raw_mouth_evidence,
        head_motion_evidence,
        cfg,
        neutral_ready=bool(lip_neutral_ready and jaw_neutral_ready),
        now_ms=float(timestamp_ms) if timestamp_ms is not None else 0.0,
    )

    # ---- Mouth Corner Geometry：Neutral / Canonical delta / Project → sideL/R ----
    mc_cfg = cfg.get("mouthCorner") if isinstance(cfg.get("mouthCorner"), dict) else {}
    mouth_corner_out = apply_mouth_corner_to_rig(
        landmarks=nose_lm,
        get_landmark_xy=get_landmark_xy,
        cfg=mc_cfg,
        state=mouth_corner_state,
        smile_left=float(smile_l_val),
        smile_right=float(smile_r_val),
        head_motion_active=bool(nose_motion.get("motionActive")),
        tracking_quality=float(lip_quality),
        face_detected=True,
        lip_neutral_ready=lip_neutral_ready,
        jaw_neutral_ready=jaw_neutral_ready,
        mouth_motion_score=float(raw_mouth_evidence.get("score", 0.0)),
    )
    rig["mouth"]["sideL"] = {
        "x": float(mouth_corner_out["sideL"]["x"]),
        "y": float(mouth_corner_out["sideL"]["y"]),
    }
    rig["mouth"]["sideR"] = {
        "x": float(mouth_corner_out["sideR"]["x"]),
        "y": float(mouth_corner_out["sideR"]["y"]),
    }
    mouth_corner_dbg = mouth_corner_out.get("debug") or {}
    mapping["mouthCornerModel"] = str(mouth_corner_dbg.get("model") or mc_cfg.get("model") or "")
    if isinstance(scenario_classifier, dict):
        scenario_classifier["cornerEvidence"] = {
            "legacySmileCornerEvidence": float(
                mouth_corner_out.get("legacySmileCornerEvidence", legacy_smile_corner_evidence)
            ),
            "canonicalCornerMotionEvidence": mouth_corner_out.get("canonicalCornerMotionEvidence"),
            "scenarioCornerEvidenceSource": mouth_corner_out.get(
                "scenarioCornerEvidenceSource", "legacy-smile-v1"
            ),
        }

    final_scenario = str(scenario_classifier.get("finalScenario", "neutral_still"))
    strong_active = bool((scenario_classifier.get("strongMouthEvidence") or {}).get("active"))
    reliable_mouth = bool((scenario_classifier.get("reliableMouthEvidence") or {}).get("reliable"))

    # ---- 补丁 A：Immediate Artifact Lock（强嘴部证据时不锁零）----
    from mouth_scenario import compute_immediate_artifact_lock

    _oc_guard = scenario_classifier.get("openCloseGuard") or {}
    open_close_guard_active = bool(_oc_guard.get("active"))
    ms_cfg = cfg.get("mouthScenario") if isinstance(cfg.get("mouthScenario"), dict) else {}
    lip_output_scale = None
    jaw_output_scale = None

    immediate_artifact_lock = compute_immediate_artifact_lock(scenario_classifier, cfg)
    scenario_classifier["immediateArtifactLock"] = immediate_artifact_lock
    immediate_lock_active = bool(immediate_artifact_lock.get("active"))
    raw_mouth_score = float(raw_mouth_evidence.get("score", 0.0))
    artifact_soft_thr = _safe_float(ms_cfg.get("artifactLockSoftMouthThreshold"), 30.0)
    artifact_soft_lip_scale = _safe_float(ms_cfg.get("artifactLockSoftLipScale"), 0.75)
    artifact_soft_jaw_scale = _safe_float(ms_cfg.get("artifactLockSoftJawScale"), 0.65)
    artifact_lock_softened = False

    drive_scenario = final_scenario
    if immediate_lock_active:
        if final_scenario == "frontal_mouth_motion" and raw_mouth_score >= artifact_soft_thr:
            artifact_lock_softened = True
            drive_scenario = final_scenario
            lip_output_scale = artifact_soft_lip_scale
            jaw_output_scale = artifact_soft_jaw_scale
            scenario_classifier["immediateArtifactLock"] = {
                **immediate_artifact_lock,
                "active": True,
                "softened": True,
                "reason": "artifact-lock-softened-by-strong-mouth",
                "appliedTo": {
                    "lip": True,
                    "jaw": True,
                    "brow": bool((immediate_artifact_lock.get("appliedTo") or {}).get("brow")),
                },
            }
        elif not (strong_active and reliable_mouth):
            drive_scenario = "closed_head_turn"
    scenario_classifier["artifactLockSoftened"] = bool(artifact_lock_softened)
    if drive_scenario == "head_motion_mouth_motion" and not immediate_lock_active:
        lip_output_scale = float(
            _oc_guard.get("lipOutputScale")
            or ms_cfg.get("openCloseLipScale")
            or ms_cfg.get("headMotionMouthLipScale")
            or ms_cfg.get("headMotionLipSuppressScale")
            or 0.95
        )
        jaw_output_scale = float(
            _oc_guard.get("jawOutputScale")
            or ms_cfg.get("openCloseJawScale")
            or ms_cfg.get("headMotionMouthJawScale")
            or ms_cfg.get("headMotionJawSuppressScale")
            or 0.85
        )
    elif open_close_guard_active and not immediate_lock_active:
        lip_output_scale = float(
            _oc_guard.get("lipOutputScale") or ms_cfg.get("openCloseLipScale") or 0.85
        )
        jaw_output_scale = float(
            _oc_guard.get("jawOutputScale") or ms_cfg.get("openCloseJawScale") or 0.75
        )

    jaw_geometry_dbg = apply_jaw_geometry_drive(
        result=result,
        cfg=cfg,
        jaw_state=jaw_state,
        rig=rig,
        mapping=mapping,
        blend=blend,
        neutral_bs=neutral,
        gains=gains,
        invert_jaw=bool(invert.get("jaw")),
        deadzone=deadzone,
        limits=limits,
        quality=float(lip_quality),
        face_detected=True,
        timestamp_ms=timestamp_ms,
        lip_neutral_ready=lip_neutral_ready,
        nose_motion=nose_motion,
        final_scenario=drive_scenario,
        head_motion_output_scale=jaw_output_scale,
    )
    lip_geometry_dbg = apply_lip_geometry_drive(
        result=result,
        rig=rig,
        mapping=mapping,
        cfg=cfg,
        lip_state=lip_state,
        blend=blend,
        neutral=neutral,
        gains=gains,
        invert=invert,
        deadzone=deadzone,
        limits=limits,
        quality=float(lip_quality),
        face_detected=True,
        timestamp_ms=timestamp_ms,
        nose_motion=nose_motion,
        final_scenario=drive_scenario,
        head_motion_output_scale=lip_output_scale,
        open_close_guard_active=open_close_guard_active,
        raw_mouth_score=raw_mouth_score,
    )

    puck_dbg = max(0.0, blend["mouthPucker"] - _safe_float(neutral.get("mouthPucker"), 0.0))
    funnel_dbg = max(0.0, blend["mouthFunnel"] - _safe_float(neutral.get("mouthFunnel"), 0.0))
    mapping["mouthPucker"] = float(_clamp_pct(puck_dbg * 100.0))
    mapping["mouthFunnel"] = float(_clamp_pct(funnel_dbg * 100.0))

    brow_cfg = cfg.get("brow") if isinstance(cfg.get("brow"), dict) else {}
    lim_bp = limits.get("browPoint", [0.0, 100.0])
    lo_bp, hi_bp = _safe_float(lim_bp[0], 0.0), _safe_float(lim_bp[1], 100.0)
    dzb = _safe_float(deadzone.get("brow"), 0.03)

    bi_s = max(0.0, blend["browInnerUp"] - _safe_float(neutral.get("browInnerUp"), 0.0))
    bi_v = _pipe_unipolar_strength(
        bi_s,
        deadzone_thr=dzb,
        gain=_safe_float(gains.get("browInner"), 1.0),
        invert=bool(invert.get("browInner")),
        lim_lo=lo_bp,
        lim_hi=hi_bp,
    )
    bol_s = max(
        0.0,
        blend["browOuterUpLeft"] - _safe_float(neutral.get("browOuterUpLeft"), 0.0),
    )
    bol_v = _pipe_unipolar_strength(
        bol_s,
        deadzone_thr=dzb,
        gain=_safe_float(gains.get("browOuterLeft"), 1.0),
        invert=bool(invert.get("browOuterLeft")),
        lim_lo=lo_bp,
        lim_hi=hi_bp,
    )
    bor_s = max(
        0.0,
        blend["browOuterUpRight"] - _safe_float(neutral.get("browOuterUpRight"), 0.0),
    )
    bor_v = _pipe_unipolar_strength(
        bor_s,
        deadzone_thr=dzb,
        gain=_safe_float(gains.get("browOuterRight"), 1.0),
        invert=bool(invert.get("browOuterRight")),
        lim_lo=lo_bp,
        lim_hi=hi_bp,
    )

    w_in = _safe_float(brow_cfg.get("midInnerWeight"), 0.4)
    w_out = _safe_float(brow_cfg.get("midOuterWeight"), 0.6)

    tip_l_raw = bi_v * _safe_float(gains.get("browTipLeft"), 1.0)
    tail_l_raw = bol_v * _safe_float(gains.get("browTailLeft"), 1.0)
    tip_l = _clamp_pct(
        apply_invert_unipolar(_clamp_pct(tip_l_raw), bool(invert.get("browTipLeft")), 0.0, 100.0)
    )
    tail_l = _clamp_pct(
        apply_invert_unipolar(_clamp_pct(tail_l_raw), bool(invert.get("browTailLeft")), 0.0, 100.0)
    )
    mid_l = _clamp_pct(bi_v * w_in + bol_v * w_out)

    tip_r_raw = bi_v * _safe_float(gains.get("browTipRight"), 1.0)
    tail_r_raw = bor_v * _safe_float(gains.get("browTailRight"), 1.0)
    tip_r = _clamp_pct(
        apply_invert_unipolar(_clamp_pct(tip_r_raw), bool(invert.get("browTipRight")), 0.0, 100.0)
    )
    tail_r = _clamp_pct(
        apply_invert_unipolar(_clamp_pct(tail_r_raw), bool(invert.get("browTailRight")), 0.0, 100.0)
    )
    mid_r = _clamp_pct(bi_v * w_in + bor_v * w_out)

    lt_tip = _norm_brow_slot(brow_cfg.get("leftTipChannel"), "tip")
    lt_tail = _norm_brow_slot(brow_cfg.get("leftTailChannel"), "tail")
    if lt_tip == lt_tail:
        lt_tail = "tail" if lt_tip == "tip" else "tip"
    rig["browL"][lt_tip] = tip_l
    rig["browL"][lt_tail] = tail_l
    rig["browL"]["mid"] = mid_l

    rt_tip = _norm_brow_slot(brow_cfg.get("rightTipChannel"), "tip")
    rt_tail = _norm_brow_slot(brow_cfg.get("rightTailChannel"), "tail")
    if rt_tip == rt_tail:
        rt_tail = "tail" if rt_tip == "tip" else "tip"
    rig["browR"][rt_tip] = tip_r
    rig["browR"][rt_tail] = tail_r
    rig["browR"]["mid"] = mid_r

    mapping["browInner"] = float(bi_v)
    mapping["browOuterLeft"] = float(bol_v)
    mapping["browOuterRight"] = float(bor_v)
    mapping["browLeftTip"] = float(rig["browL"]["tip"])
    mapping["browLeftMid"] = float(rig["browL"]["mid"])
    mapping["browLeftTail"] = float(rig["browL"]["tail"])
    mapping["browRightTip"] = float(rig["browR"]["tip"])
    mapping["browRightMid"] = float(rig["browR"]["mid"])
    mapping["browRightTail"] = float(rig["browR"]["tail"])
    mapping["browLeft"] = float(mid_l)
    mapping["browRight"] = float(mid_r)

    # ---- Brow Scenario Gate（独立 artifact gate）：head motion 锁零、mouth motion 抑制 ----
    from brow_gate import apply_brow_gate, build_brow_debug_payload

    brow_decision_reason = str(
        (scenario_classifier.get("decision") or {}).get("reason", "")
    ) if isinstance(scenario_classifier, dict) else ""
    strong_mouth_active = bool(
        ((scenario_classifier.get("strongMouthEvidence") or {}) if isinstance(scenario_classifier, dict) else {}).get("active")
    )
    old_mouth_pose_head = bool(jaw_geometry_dbg.get("oldMouthPoseHeadMotionActive")) or bool(
        lip_geometry_dbg.get("oldMouthPoseHeadMotionActive")
    )
    pose_gate_active = bool((jaw_geometry_dbg.get("poseGate") or {}).get("active")) or bool(
        (lip_geometry_dbg.get("poseGate") or {}).get("active")
    )
    brow_evidence = {
        "noseAnchorMotion": bool(nose_motion.get("motionActive")),
        "headMotionScore": float(head_motion_evidence.get("score", 0.0)),
        "oldMouthPoseHeadMotionActive": old_mouth_pose_head,
        "poseGateActive": pose_gate_active,
        "rawMouthScore": float(raw_mouth_evidence.get("score", 0.0)),
        "strongMouthActive": strong_mouth_active,
        "jawAbs": abs(float(rig.get("jaw", {}).get("val", 0.0))),
        "jawInputAbs": float(jaw_ev.get("jawInputAbs", 0.0)),
        "lipAbsMax": float(lip_ev.get("lipAbsMax", 0.0)),
        "faceDetected": True,
        "quality": float(lip_quality),
        "noseNeutralReady": bool(nose_motion.get("neutralReady")),
        "lipNeutralReady": bool(lip_neutral_ready),
        "jawNeutralReady": bool(jaw_neutral_ready),
        "timestampMs": float(timestamp_ms),
        "immediateArtifactLock": immediate_artifact_lock,
    }
    brow_raw_values = {
        "browInner": float(mapping.get("browInner", 0.0)),
        "browOuterLeft": float(mapping.get("browOuterLeft", 0.0)),
        "browOuterRight": float(mapping.get("browOuterRight", 0.0)),
        "browLeftTip": float(mapping.get("browLeftTip", 0.0)),
        "browLeftMid": float(mapping.get("browLeftMid", 0.0)),
        "browLeftTail": float(mapping.get("browLeftTail", 0.0)),
        "browRightTip": float(mapping.get("browRightTip", 0.0)),
        "browRightMid": float(mapping.get("browRightMid", 0.0)),
        "browRightTail": float(mapping.get("browRightTail", 0.0)),
        "browLeft": float(mapping.get("browLeft", 0.0)),
        "browRight": float(mapping.get("browRight", 0.0)),
    }
    brow_gate_result = apply_brow_gate(
        brow_raw_values,
        final_scenario,
        brow_decision_reason,
        brow_evidence,
        cfg,
        brow_state,
        immediate_artifact_lock=immediate_artifact_lock,
    )
    brow_gated = brow_gate_result["values"]
    brow_gate_dbg = brow_gate_result["debug"]
    for _bk, _bv in brow_gated.items():
        mapping[_bk] = float(_bv)
    rig["browL"]["tip"] = float(brow_gated["browLeftTip"])
    rig["browL"]["mid"] = float(brow_gated["browLeftMid"])
    rig["browL"]["tail"] = float(brow_gated["browLeftTail"])
    rig["browR"]["tip"] = float(brow_gated["browRightTip"])
    rig["browR"]["mid"] = float(brow_gated["browRightMid"])
    rig["browR"]["tail"] = float(brow_gated["browRightTail"])

    gz = cfg.get("gaze") if isinstance(cfg.get("gaze"), dict) else {}
    if _gaze_is_iris_only_mode(gz) and bool(gz.get("enabled", True)):
        lm = extract_landmarks(result)
        iris = extract_iris_signal(lm, get_xy=get_landmark_xy, gaze_cfg=gz)
        gaze_dbg = apply_mediapipe_iris_only_gaze(
            rig=rig,
            mapping=mapping,
            gaze_state=gaze_state,
            iris=iris,
            gaze_cfg=gz,
            limits=limits,
            face_detected=True,
            blend=blend,
        )
    else:
        gaze_dbg = estimate_eye_gaze_from_landmarks(result, cfg)
        center = 50.0
        rig["sharedRadar"]["x"] = center
        rig["sharedRadar"]["y"] = center
        mapping["sharedRadarX"] = center
        mapping["sharedRadarY"] = center
        gaze_dbg["outputMode"] = "gaze_disabled"
        gaze_dbg["emittedSharedRadarX"] = center
        gaze_dbg["emittedSharedRadarY"] = center

    rig["tongue"]["val"] = 0.0

    brow_debug = build_brow_debug_payload(
        brow_raw_values,
        brow_gate_dbg,
        rig.get("browL") or {},
        rig.get("browR") or {},
    )

    return {
        "rig": rig,
        "debug": {
            "blendshapes": blend,
            "mapping": mapping,
            "gaze": gaze_dbg,
            "jawGeometry": jaw_geometry_dbg,
            "lipGeometry": lip_geometry_dbg,
            "mouthDebug": lip_geometry_dbg.get("mouthDebug") if isinstance(lip_geometry_dbg, dict) else None,
            "noseAnchor": nose_motion,
            "mouthScenarioClassifier": scenario_classifier,
            "mouthCornerGeometry": mouth_corner_dbg,
            "browGate": brow_gate_dbg,
            "brow": brow_debug,
        },
    }


def estimate_tracking_quality(result: Any, face_detected: bool) -> float:
    """有人脸时 0.8~1.0；blendshape 齐全时略调高。"""
    if not face_detected:
        return 0.0
    n = blendshape_entry_count(result)
    if n >= 48:
        return 0.96
    if n >= 35:
        return 0.93
    if n >= 12:
        return 0.88
    if n > 0:
        return 0.82
    return 0.8
