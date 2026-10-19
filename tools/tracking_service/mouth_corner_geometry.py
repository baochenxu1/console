"""
Mouth Corner Geometry V2：Landmark → Canonical 2D → Neutral delta → Rig pad。

与 lip/jaw 共用稳定锚点约定（鼻尖原点、眼外眦定 X、颏向定 Y、眼距尺度），
**不得**用嘴角 61/291 自身定义坐标系（否则投影恒定无位移）。

model:
  - diagonal-v1：smile 标量对角线（旧公式逐位兼容）
  - landmark-2d-v2：真独立 XY
"""

from __future__ import annotations

import math
from typing import Any

from mediapipe_mapping_config import _safe_float

MODEL_DIAGONAL_V1 = "diagonal-v1"
MODEL_LANDMARK_2D_V2 = "landmark-2d-v2"
MODEL_VERSION = "mouth-corner-geometry-v2"

# conversation_ff mediapipe-raw_20260720_101926 离线 canonical 统计（见交付报告）：
# abs(delta) P90≈0.05 / P95≈0.06；neutral noise P90≈0.02~0.045；取保守输入幅值 0.08。
# outputSpan 对齐旧 v1 最大水平摆幅 smile*0.35≈35。
_DEFAULT_MOUTH_CORNER: dict[str, Any] = {
    "model": MODEL_LANDMARK_2D_V2,
    "landmarkIndices": {"left": 61, "right": 291},
    "stableAnchorIndices": {
        "noseTip": 1,
        "chin": 152,
        "leftEyeOuter": 33,
        "rightEyeOuter": 263,
    },
    "use3d": True,
    "minFaceScale": 0.02,
    "sourceMirror": False,
    "neutralSampleCount": 30,
    "neutralWarmupFrames": 8,
    "minQuality": 0.5,
    "inputRangeX": 0.08,
    "inputRangeY": 0.08,
    "outputSpanX": 35.0,
    "outputSpanY": 35.0,
    "deadzoneX": 0.012,
    "deadzoneY": 0.012,
    "holdLastValidFrames": 4,
    "decayToCenterFrames": 12,
    "requireLipJawNeutral": False,
    # conversation 视频上 nose.motionActive 可达 ~90%+；默认不硬拒，避免 Neutral 永不 ready、side* 锁死 50。
    "rejectOnHeadMotion": False,
    # None/负数：不按 scenario rawMouthScore 拦截 Neutral（该分数在说话时长期 >8）。
    "maxMouthMotionForNeutral": None,
    "diagonalSmileScaleX": 0.35,
    "diagonalSmileScaleY": 0.25,
}

_MOUTH_CORNER_BOOL_KEYS = (
    "use3d",
    "sourceMirror",
    "requireLipJawNeutral",
    "rejectOnHeadMotion",
)


def default_mouth_corner_config() -> dict[str, Any]:
    return {
        **dict(_DEFAULT_MOUTH_CORNER),
        "landmarkIndices": dict(_DEFAULT_MOUTH_CORNER["landmarkIndices"]),
        "stableAnchorIndices": dict(_DEFAULT_MOUTH_CORNER["stableAnchorIndices"]),
    }


def normalize_mouth_corner_config(raw: Any, *, section_present: bool = True) -> dict[str, Any]:
    """section_present=False：整段 mouthCorner 缺失 → diagonal-v1 兼容。"""
    base = default_mouth_corner_config()
    if not section_present or not isinstance(raw, dict):
        base["model"] = MODEL_DIAGONAL_V1
        return base
    for k, v in _DEFAULT_MOUTH_CORNER.items():
        if k == "landmarkIndices":
            arr = raw.get(k, v)
            if isinstance(arr, dict):
                base[k] = {
                    "left": int(_safe_float(arr.get("left"), v["left"])),
                    "right": int(_safe_float(arr.get("right"), v["right"])),
                }
            elif isinstance(arr, (list, tuple)) and len(arr) >= 2:
                base[k] = {"left": int(arr[0]), "right": int(arr[1])}
            else:
                base[k] = dict(v)
        elif k == "stableAnchorIndices":
            arr = raw.get(k, v)
            if isinstance(arr, dict):
                out = dict(v)
                for ak, av in v.items():
                    out[ak] = int(_safe_float(arr.get(ak), av))
                base[k] = out
            else:
                base[k] = dict(v)
        elif k == "model":
            m = str(raw.get(k, v) or v).strip()
            base[k] = m if m in (MODEL_DIAGONAL_V1, MODEL_LANDMARK_2D_V2) else MODEL_DIAGONAL_V1
        elif k == "maxMouthMotionForNeutral":
            if k not in raw or raw.get(k) is None:
                base[k] = None
            else:
                base[k] = _safe_float(raw.get(k), 0.0)
        elif k in _MOUTH_CORNER_BOOL_KEYS:
            base[k] = bool(raw.get(k, v))
        elif isinstance(v, (int, float)):
            base[k] = _safe_float(raw.get(k), float(v))
        else:
            base[k] = raw.get(k, v)
    if "model" not in raw:
        base["model"] = MODEL_DIAGONAL_V1
    return base


def create_mouth_corner_state(session_id: str | None = None) -> dict[str, Any]:
    return {
        "sessionId": session_id,
        "neutralReady": False,
        "neutralSampleCount": 0,
        "neutralWarmupCount": 0,
        "neutralLeftX": None,
        "neutralLeftY": None,
        "neutralRightX": None,
        "neutralRightY": None,
        "_samplesLeftX": [],
        "_samplesLeftY": [],
        "_samplesRightX": [],
        "_samplesRightY": [],
        "lastValid": None,
        "invalidFrameCount": 0,
        "holdFrameCount": 0,
        "modelVersion": MODEL_VERSION,
    }


def reset_mouth_corner_state(state: dict[str, Any] | None, session_id: str | None = None) -> dict[str, Any]:
    fresh = create_mouth_corner_state(session_id)
    if state is not None:
        state.clear()
        state.update(fresh)
        return state
    return fresh


def start_mouth_corner_neutral_calibration(state: dict[str, Any] | None, reason: str = "manual") -> None:
    if state is None:
        return
    sid = state.get("sessionId")
    reset_mouth_corner_state(state, sid)
    state["calibrateReason"] = str(reason)


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, float(v)))


def _clamp_pct(v: float) -> float:
    return _clamp(v, 0.0, 100.0)


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


def _read_point3(landmarks: Any, idx: int, get_landmark_xy) -> tuple[float, float, float] | None:
    try:
        p = landmarks[int(idx)]
    except Exception:
        p = None
    if p is not None and hasattr(p, "x") and hasattr(p, "y"):
        return (float(p.x), float(p.y), float(getattr(p, "z", 0.0)))
    if isinstance(p, dict) and "x" in p and "y" in p:
        return (float(p["x"]), float(p["y"]), float(p.get("z", 0.0)))
    if isinstance(p, (list, tuple)) and len(p) >= 2:
        return (float(p[0]), float(p[1]), float(p[2]) if len(p) >= 3 else 0.0)
    xy = get_landmark_xy(landmarks, int(idx)) if get_landmark_xy else None
    if xy is None:
        return None
    return (float(xy[0]), float(xy[1]), 0.0)


def _median(vals: list[float]) -> float | None:
    if not vals:
        return None
    s = sorted(float(v) for v in vals)
    n = len(s)
    mid = n // 2
    if n % 2:
        return s[mid]
    return 0.5 * (s[mid - 1] + s[mid])


def extract_raw_mouth_corner_observation(
    landmarks: Any,
    cfg: dict[str, Any] | None,
    get_landmark_xy,
) -> dict[str, Any]:
    """原始提取：仅 landmark 坐标，不含 Neutral / Rig。"""
    if isinstance(cfg, dict) and ("landmarkIndices" in cfg or "model" in cfg):
        mc = normalize_mouth_corner_config(cfg, section_present=True)
    else:
        mc = default_mouth_corner_config()

    li = int(mc["landmarkIndices"]["left"])
    ri = int(mc["landmarkIndices"]["right"])
    left = _read_point3(landmarks, li, get_landmark_xy) if landmarks is not None else None
    right = _read_point3(landmarks, ri, get_landmark_xy) if landmarks is not None else None
    if left is None or right is None:
        return {
            "available": False,
            "left": {"x": None, "y": None},
            "right": {"x": None, "y": None},
            "landmarkIndices": {"left": li, "right": ri},
            "landmarkCount": 0,
            "rejectReason": "landmarks-missing",
        }

    lx, ly = float(left[0]), float(left[1])
    rx, ry = float(right[0]), float(right[1])
    if bool(mc.get("sourceMirror")):
        lx, ly, rx, ry = rx, ry, lx, ly

    return {
        "available": True,
        "left": {"x": lx, "y": ly},
        "right": {"x": rx, "y": ry},
        "landmarkIndices": {
            "left": int(mc["landmarkIndices"]["left"]),
            "right": int(mc["landmarkIndices"]["right"]),
        },
        "landmarkCount": 2,
        "rejectReason": None,
    }


def _fallback_get_landmark_xy(landmarks: Any, index: int) -> tuple[float, float] | None:
    try:
        p = landmarks[int(index)]
    except Exception:
        return None
    if p is not None and hasattr(p, "x") and hasattr(p, "y"):
        return float(p.x), float(p.y)
    if isinstance(p, dict) and "x" in p and "y" in p:
        return float(p["x"]), float(p["y"])
    if isinstance(p, (list, tuple)) and len(p) >= 2:
        return float(p[0]), float(p[1])
    return None


def landmarks_to_mouth_corners(landmarks: Any, get_landmark_xy=None) -> tuple[float, float, float, float]:
    """
    薄包装：返回 (leftX, leftY, rightX, rightY)；不可用时返回 nan。
    不含 Neutral / 状态 / Rig 映射。
    """
    getter = get_landmark_xy or _fallback_get_landmark_xy
    obs = extract_raw_mouth_corner_observation(landmarks, default_mouth_corner_config(), getter)
    if not obs.get("available"):
        return (float("nan"), float("nan"), float("nan"), float("nan"))
    return (
        float(obs["left"]["x"]),
        float(obs["left"]["y"]),
        float(obs["right"]["x"]),
        float(obs["right"]["y"]),
    )


def build_face_local_corner_frame(
    landmarks: Any,
    cfg: dict[str, Any],
    get_landmark_xy,
) -> dict[str, Any]:
    """
    Face-local 2D 基（嘴角专用）：
    origin = nose tip；X = leftEyeOuter → rightEyeOuter；Y = Gram–Schmidt(chin−nose)；
    scale = inter-ocular distance。
    """
    anchors = cfg.get("stableAnchorIndices") or _DEFAULT_MOUTH_CORNER["stableAnchorIndices"]
    ni = int(anchors.get("noseTip", 1))
    ci = int(anchors.get("chin", 152))
    lei = int(anchors.get("leftEyeOuter", 33))
    rei = int(anchors.get("rightEyeOuter", 263))
    if bool(cfg.get("sourceMirror")):
        lei, rei = rei, lei

    nose = _read_point3(landmarks, ni, get_landmark_xy)
    chin = _read_point3(landmarks, ci, get_landmark_xy)
    le = _read_point3(landmarks, lei, get_landmark_xy)
    re = _read_point3(landmarks, rei, get_landmark_xy)
    if nose is None or chin is None or le is None or re is None:
        return {"ok": False, "error": "stable-anchors-missing", "faceFrame": None}

    use_3d = bool(cfg.get("use3d", True))
    if not use_3d:
        nose = (nose[0], nose[1], 0.0)
        chin = (chin[0], chin[1], 0.0)
        le = (le[0], le[1], 0.0)
        re = (re[0], re[1], 0.0)

    x_axis = _normalize(_sub(re, le))
    if x_axis is None:
        return {"ok": False, "error": "x-axis-invalid", "faceFrame": None}
    face_down = _normalize(_sub(chin, nose))
    if face_down is None:
        return {"ok": False, "error": "face-down-invalid", "faceFrame": None}
    proj = _dot(face_down, x_axis)
    y_raw = (
        face_down[0] - proj * x_axis[0],
        face_down[1] - proj * x_axis[1],
        face_down[2] - proj * x_axis[2],
    )
    y_axis = _normalize(y_raw)
    if y_axis is None:
        return {"ok": False, "error": "y-axis-invalid", "faceFrame": None}
    if _dot(y_axis, _sub(chin, nose)) < 0:
        y_axis = (-y_axis[0], -y_axis[1], -y_axis[2])

    scale = _norm(_sub(re, le))
    min_s = max(1e-6, _safe_float(cfg.get("minFaceScale"), 0.02))
    if scale < min_s:
        return {"ok": False, "error": "face-scale-too-small", "faceFrame": None, "scale": float(scale)}

    face_frame = {
        "originX": float(nose[0]),
        "originY": float(nose[1]),
        "axisXX": float(x_axis[0]),
        "axisXY": float(x_axis[1]),
        "axisYX": float(y_axis[0]),
        "axisYY": float(y_axis[1]),
        "scale": float(scale),
    }

    def project_xy(point: tuple[float, float, float]) -> tuple[float, float]:
        d = _sub(point, nose)
        return _dot(d, x_axis) / scale, _dot(d, y_axis) / scale

    return {
        "ok": True,
        "error": "",
        "faceFrame": face_frame,
        "project": project_xy,
        "origin3": nose,
        "xAxis": x_axis,
        "yAxis": y_axis,
        "scale": float(scale),
    }


def build_canonical_mouth_corner_observation(
    landmarks: Any,
    cfg: dict[str, Any] | None,
    get_landmark_xy,
    *,
    raw_obs: dict[str, Any] | None = None,
    head_motion_active: bool = False,
    tracking_quality: float | None = None,
) -> dict[str, Any]:
    if isinstance(cfg, dict) and ("model" in cfg or "landmarkIndices" in cfg):
        mc = normalize_mouth_corner_config(cfg, section_present=True)
    else:
        mc = default_mouth_corner_config()

    raw = raw_obs or extract_raw_mouth_corner_observation(landmarks, mc, get_landmark_xy)
    empty = {
        "available": False,
        "faceFrame": None,
        "left": {"canonicalX": None, "canonicalY": None},
        "right": {"canonicalX": None, "canonicalY": None},
        "quality": {
            "faceScaleValid": False,
            "poseValid": False,
            "headMotionActive": bool(head_motion_active),
            "confidence": 0.0,
            "rejectReason": "unavailable",
        },
    }
    if not raw.get("available"):
        empty["quality"]["rejectReason"] = raw.get("rejectReason") or "landmarks-missing"
        return empty

    frame = build_face_local_corner_frame(landmarks, mc, get_landmark_xy)
    if not frame.get("ok"):
        empty["quality"]["rejectReason"] = frame.get("error") or "frame-invalid"
        return empty

    li = int(mc["landmarkIndices"]["left"])
    ri = int(mc["landmarkIndices"]["right"])
    if bool(mc.get("sourceMirror")):
        li, ri = ri, li
    left_p = _read_point3(landmarks, li, get_landmark_xy)
    right_p = _read_point3(landmarks, ri, get_landmark_xy)
    if left_p is None or right_p is None:
        empty["quality"]["rejectReason"] = "landmarks-missing"
        return empty

    project = frame["project"]
    lcx, lcy = project(left_p)
    rcx, rcy = project(right_p)

    q = _safe_float(tracking_quality, 1.0)
    min_q = _safe_float(mc.get("minQuality"), 0.5)
    reject = None
    pose_valid = True
    if q < min_q:
        reject = "low-quality"
        pose_valid = False
    if bool(mc.get("rejectOnHeadMotion")) and head_motion_active:
        reject = "head-motion"
        pose_valid = False

    available = reject is None
    return {
        "available": available,
        "faceFrame": frame.get("faceFrame"),
        "left": {"canonicalX": float(lcx), "canonicalY": float(lcy)},
        "right": {"canonicalX": float(rcx), "canonicalY": float(rcy)},
        "quality": {
            "faceScaleValid": True,
            "poseValid": pose_valid,
            "headMotionActive": bool(head_motion_active),
            "confidence": float(q) if available else 0.0,
            "rejectReason": reject,
        },
    }


def _neutral_collect_ok(
    *,
    canonical: dict[str, Any],
    face_detected: bool,
    lip_neutral_ready: bool,
    jaw_neutral_ready: bool,
    head_motion_active: bool,
    mouth_motion_score: float,
    cfg: dict[str, Any],
) -> tuple[bool, str | None]:
    if not face_detected:
        return False, "no-face"
    # Neutral 只需几何可读；drive 侧的 head-motion reject 不应阻断采样
    left = canonical.get("left") or {}
    right = canonical.get("right") or {}
    has_geom = left.get("canonicalX") is not None and right.get("canonicalX") is not None
    if not has_geom:
        return False, (canonical.get("quality") or {}).get("rejectReason") or "canonical-unavailable"
    if bool(cfg.get("rejectOnHeadMotion")) and head_motion_active:
        return False, "head-motion"
    if bool(cfg.get("requireLipJawNeutral")) and not (lip_neutral_ready and jaw_neutral_ready):
        return False, "lip-jaw-neutral-pending"
    max_mouth = cfg.get("maxMouthMotionForNeutral")
    if max_mouth is not None and float(max_mouth) >= 0 and mouth_motion_score > float(max_mouth):
        return False, "mouth-motion"
    return True, None


def update_mouth_corner_neutral(
    state: dict[str, Any] | None,
    canonical: dict[str, Any],
    cfg: dict[str, Any],
    *,
    face_detected: bool = True,
    lip_neutral_ready: bool = True,
    jaw_neutral_ready: bool = True,
    head_motion_active: bool = False,
    mouth_motion_score: float = 0.0,
) -> dict[str, Any]:
    if state is None:
        state = create_mouth_corner_state()
    mc = cfg
    ok, reason = _neutral_collect_ok(
        canonical=canonical,
        face_detected=face_detected,
        lip_neutral_ready=lip_neutral_ready,
        jaw_neutral_ready=jaw_neutral_ready,
        head_motion_active=head_motion_active,
        mouth_motion_score=mouth_motion_score,
        cfg=mc,
    )
    warmup = int(_safe_float(mc.get("neutralWarmupFrames"), 8))
    need = int(_safe_float(mc.get("neutralSampleCount"), 30))

    if state.get("neutralReady"):
        return {
            "ready": True,
            "sampleCount": int(state.get("neutralSampleCount") or 0),
            "skipReason": None,
            "leftX": state.get("neutralLeftX"),
            "leftY": state.get("neutralLeftY"),
            "rightX": state.get("neutralRightX"),
            "rightY": state.get("neutralRightY"),
        }

    if not ok:
        return {
            "ready": False,
            "sampleCount": int(state.get("neutralSampleCount") or 0),
            "skipReason": reason,
            "leftX": None,
            "leftY": None,
            "rightX": None,
            "rightY": None,
        }

    wu = int(state.get("neutralWarmupCount") or 0)
    if wu < warmup:
        state["neutralWarmupCount"] = wu + 1
        return {
            "ready": False,
            "sampleCount": int(state.get("neutralSampleCount") or 0),
            "skipReason": "warmup",
            "leftX": None,
            "leftY": None,
            "rightX": None,
            "rightY": None,
        }

    left = canonical.get("left") or {}
    right = canonical.get("right") or {}
    state.setdefault("_samplesLeftX", []).append(float(left["canonicalX"]))
    state.setdefault("_samplesLeftY", []).append(float(left["canonicalY"]))
    state.setdefault("_samplesRightX", []).append(float(right["canonicalX"]))
    state.setdefault("_samplesRightY", []).append(float(right["canonicalY"]))
    for key in ("_samplesLeftX", "_samplesLeftY", "_samplesRightX", "_samplesRightY"):
        buf = state[key]
        if len(buf) > need * 2:
            state[key] = buf[-need:]

    n = min(
        len(state["_samplesLeftX"]),
        len(state["_samplesLeftY"]),
        len(state["_samplesRightX"]),
        len(state["_samplesRightY"]),
    )
    state["neutralSampleCount"] = n
    if n >= need:
        state["neutralLeftX"] = _median(state["_samplesLeftX"][-need:])
        state["neutralLeftY"] = _median(state["_samplesLeftY"][-need:])
        state["neutralRightX"] = _median(state["_samplesRightX"][-need:])
        state["neutralRightY"] = _median(state["_samplesRightY"][-need:])
        state["neutralReady"] = True
        for key in ("_samplesLeftX", "_samplesLeftY", "_samplesRightX", "_samplesRightY"):
            state[key] = []

    return {
        "ready": bool(state.get("neutralReady")),
        "sampleCount": int(state.get("neutralSampleCount") or 0),
        "skipReason": None if state.get("neutralReady") else "collecting",
        "leftX": state.get("neutralLeftX"),
        "leftY": state.get("neutralLeftY"),
        "rightX": state.get("neutralRightX"),
        "rightY": state.get("neutralRightY"),
    }


def compute_neutral_relative_delta(
    canonical: dict[str, Any],
    state: dict[str, Any] | None,
) -> dict[str, Any]:
    if not state or not state.get("neutralReady") or not canonical.get("available"):
        return {
            "leftDx": None,
            "leftDy": None,
            "rightDx": None,
            "rightDy": None,
            "ready": False,
        }
    left = canonical.get("left") or {}
    right = canonical.get("right") or {}
    return {
        "leftDx": float(left["canonicalX"]) - float(state["neutralLeftX"]),
        "leftDy": float(left["canonicalY"]) - float(state["neutralLeftY"]),
        "rightDx": float(right["canonicalX"]) - float(state["neutralRightX"]),
        "rightDy": float(right["canonicalY"]) - float(state["neutralRightY"]),
        "ready": True,
    }


def _normalize_axis(value: float, input_range: float, deadzone: float) -> float:
    r = max(1e-9, abs(float(input_range)))
    dz = max(0.0, float(deadzone))
    v = float(value)
    if abs(v) <= dz:
        return 0.0
    sign = 1.0 if v > 0 else -1.0
    mag = (abs(v) - dz) / r
    return _clamp(sign * mag, -1.0, 1.0)


def project_mouth_corners_diagonal_v1(
    smile_left: float,
    smile_right: float,
    cfg: dict[str, Any] | None = None,
) -> dict[str, Any]:
    mc = cfg or _DEFAULT_MOUTH_CORNER
    sx = _safe_float(mc.get("diagonalSmileScaleX"), 0.35)
    sy = _safe_float(mc.get("diagonalSmileScaleY"), 0.25)
    s_l = float(smile_left)
    s_r = float(smile_right)
    return {
        "sideL": {
            "x": _clamp_pct(50.0 - s_l * sx),
            "y": _clamp_pct(50.0 - s_l * sy),
        },
        "sideR": {
            "x": _clamp_pct(50.0 + s_r * sx),
            "y": _clamp_pct(50.0 - s_r * sy),
        },
        "normalized": {
            "leftX": None,
            "leftY": None,
            "rightX": None,
            "rightY": None,
        },
    }


def project_mouth_corners_landmark_2d_v2(
    delta: dict[str, Any],
    cfg: dict[str, Any],
) -> dict[str, Any]:
    rx = _safe_float(cfg.get("inputRangeX"), 0.08)
    ry = _safe_float(cfg.get("inputRangeY"), 0.08)
    ox = _safe_float(cfg.get("outputSpanX"), 35.0)
    oy = _safe_float(cfg.get("outputSpanY"), 35.0)
    dzx = _safe_float(cfg.get("deadzoneX"), 0.012)
    dzy = _safe_float(cfg.get("deadzoneY"), 0.012)

    ldx = delta.get("leftDx")
    ldy = delta.get("leftDy")
    rdx = delta.get("rightDx")
    rdy = delta.get("rightDy")
    if ldx is None or ldy is None or rdx is None or rdy is None:
        return {
            "sideL": {"x": 50.0, "y": 50.0},
            "sideR": {"x": 50.0, "y": 50.0},
            "normalized": {
                "leftX": None,
                "leftY": None,
                "rightX": None,
                "rightY": None,
            },
            "neutralNotReady": True,
        }

    n_lx = _normalize_axis(float(ldx), rx, dzx)
    n_ly = _normalize_axis(float(ldy), ry, dzy)
    n_rx = _normalize_axis(float(rdx), rx, dzx)
    n_ry = _normalize_axis(float(rdy), ry, dzy)

    return {
        "sideL": {
            "x": _clamp_pct(50.0 + n_lx * ox),
            "y": _clamp_pct(50.0 + n_ly * oy),
        },
        "sideR": {
            "x": _clamp_pct(50.0 + n_rx * ox),
            "y": _clamp_pct(50.0 + n_ry * oy),
        },
        "normalized": {
            "leftX": float(n_lx),
            "leftY": float(n_ly),
            "rightX": float(n_rx),
            "rightY": float(n_ry),
        },
        "neutralNotReady": False,
    }


def project_mouth_corners_to_rig(
    *,
    model: str,
    smile_left: float = 0.0,
    smile_right: float = 0.0,
    delta: dict[str, Any] | None = None,
    cfg: dict[str, Any] | None = None,
) -> dict[str, Any]:
    mc = normalize_mouth_corner_config(cfg if isinstance(cfg, dict) else {}, section_present=True)
    m = str(model or mc.get("model") or MODEL_DIAGONAL_V1)
    if m == MODEL_DIAGONAL_V1:
        out = project_mouth_corners_diagonal_v1(smile_left, smile_right, mc)
        out["model"] = MODEL_DIAGONAL_V1
        return out
    out = project_mouth_corners_landmark_2d_v2(delta or {}, mc)
    out["model"] = MODEL_LANDMARK_2D_V2
    return out


def _center_pad() -> dict[str, dict[str, float]]:
    return {"sideL": {"x": 50.0, "y": 50.0}, "sideR": {"x": 50.0, "y": 50.0}}


def _lerp_pad(a: dict[str, Any], t: float) -> dict[str, dict[str, float]]:
    def lerp(v: float) -> float:
        return _clamp_pct(50.0 + (float(v) - 50.0) * t)

    return {
        "sideL": {"x": lerp(a["sideL"]["x"]), "y": lerp(a["sideL"]["y"])},
        "sideR": {"x": lerp(a["sideR"]["x"]), "y": lerp(a["sideR"]["y"])},
    }


def apply_mouth_corner_to_rig(
    *,
    landmarks: Any,
    get_landmark_xy,
    cfg: dict[str, Any],
    state: dict[str, Any] | None,
    smile_left: float,
    smile_right: float,
    head_motion_active: bool = False,
    tracking_quality: float | None = None,
    face_detected: bool = True,
    lip_neutral_ready: bool = True,
    jaw_neutral_ready: bool = True,
    mouth_motion_score: float = 0.0,
) -> dict[str, Any]:
    """完整一帧嘴角 pad + debug.mouthCornerGeometry 载荷。"""
    if isinstance(cfg, dict) and "model" in cfg:
        mc = normalize_mouth_corner_config(cfg, section_present=True)
    else:
        mc = normalize_mouth_corner_config(cfg if isinstance(cfg, dict) else {}, section_present=bool(cfg))
    model = str(mc.get("model") or MODEL_DIAGONAL_V1)

    legacy_ev = max(float(smile_left) * 0.35, float(smile_right) * 0.35)
    debug_base: dict[str, Any] = {
        "model": model,
        "raw": {"leftX": None, "leftY": None, "rightX": None, "rightY": None},
        "canonical": {"leftX": None, "leftY": None, "rightX": None, "rightY": None},
        "neutral": {
            "ready": False,
            "sampleCount": 0,
            "leftX": None,
            "leftY": None,
            "rightX": None,
            "rightY": None,
        },
        "delta": {"leftDx": None, "leftDy": None, "rightDx": None, "rightDy": None},
        "normalized": {"leftX": None, "leftY": None, "rightX": None, "rightY": None},
        "output": _center_pad(),
        "quality": {
            "available": False,
            "confidence": None,
            "poseValid": False,
            "faceScaleValid": False,
            "headMotionActive": bool(head_motion_active),
            "heldLastValid": False,
            "rejectReason": None,
        },
        "evidence": {
            "legacySmileCornerEvidence": float(legacy_ev),
            "canonicalCornerMotionEvidence": None,
            "scenarioCornerEvidenceSource": "legacy-smile-v1",
        },
    }

    if model == MODEL_DIAGONAL_V1:
        proj = project_mouth_corners_diagonal_v1(smile_left, smile_right, mc)
        debug_base["output"] = {"sideL": proj["sideL"], "sideR": proj["sideR"]}
        debug_base["quality"]["available"] = True
        debug_base["quality"]["poseValid"] = True
        debug_base["quality"]["confidence"] = 1.0
        return {
            "sideL": proj["sideL"],
            "sideR": proj["sideR"],
            "legacySmileCornerEvidence": float(legacy_ev),
            "canonicalCornerMotionEvidence": 0.0,
            "scenarioCornerEvidenceSource": "legacy-smile-v1",
            "debug": debug_base,
        }

    if state is None:
        state = create_mouth_corner_state()

    raw = extract_raw_mouth_corner_observation(landmarks, mc, get_landmark_xy)
    if raw.get("available"):
        debug_base["raw"] = {
            "leftX": raw["left"]["x"],
            "leftY": raw["left"]["y"],
            "rightX": raw["right"]["x"],
            "rightY": raw["right"]["y"],
        }

    canonical = build_canonical_mouth_corner_observation(
        landmarks,
        mc,
        get_landmark_xy,
        raw_obs=raw,
        head_motion_active=head_motion_active,
        tracking_quality=tracking_quality,
    )
    q = canonical.get("quality") or {}
    debug_base["quality"].update(
        {
            "available": bool(canonical.get("available")),
            "confidence": q.get("confidence"),
            "poseValid": q.get("poseValid"),
            "faceScaleValid": q.get("faceScaleValid"),
            "headMotionActive": q.get("headMotionActive"),
            "rejectReason": q.get("rejectReason"),
        }
    )
    if canonical.get("left", {}).get("canonicalX") is not None:
        debug_base["canonical"] = {
            "leftX": canonical["left"]["canonicalX"],
            "leftY": canonical["left"]["canonicalY"],
            "rightX": canonical["right"]["canonicalX"],
            "rightY": canonical["right"]["canonicalY"],
        }

    neut_info = update_mouth_corner_neutral(
        state,
        canonical,
        mc,
        face_detected=face_detected,
        lip_neutral_ready=lip_neutral_ready,
        jaw_neutral_ready=jaw_neutral_ready,
        head_motion_active=head_motion_active,
        mouth_motion_score=mouth_motion_score,
    )
    debug_base["neutral"] = {
        "ready": bool(neut_info.get("ready")),
        "sampleCount": int(neut_info.get("sampleCount") or 0),
        "leftX": neut_info.get("leftX"),
        "leftY": neut_info.get("leftY"),
        "rightX": neut_info.get("rightX"),
        "rightY": neut_info.get("rightY"),
    }

    delta = compute_neutral_relative_delta(canonical, state)
    debug_base["delta"] = {
        "leftDx": delta.get("leftDx"),
        "leftDy": delta.get("leftDy"),
        "rightDx": delta.get("rightDx"),
        "rightDy": delta.get("rightDy"),
    }

    canon_ev = 0.0
    if delta.get("ready"):
        canon_ev = (
            max(
                abs(float(delta["leftDx"] or 0.0)),
                abs(float(delta["leftDy"] or 0.0)),
                abs(float(delta["rightDx"] or 0.0)),
                abs(float(delta["rightDy"] or 0.0)),
            )
            * 100.0
        )
    debug_base["evidence"]["canonicalCornerMotionEvidence"] = float(canon_ev)

    hold_n = int(_safe_float(mc.get("holdLastValidFrames"), 4))
    decay_n = int(_safe_float(mc.get("decayToCenterFrames"), 12))

    use_fresh = bool(canonical.get("available")) and bool(state.get("neutralReady")) and bool(delta.get("ready"))
    if use_fresh:
        proj = project_mouth_corners_landmark_2d_v2(delta, mc)
        pad = {"sideL": proj["sideL"], "sideR": proj["sideR"]}
        debug_base["normalized"] = proj.get("normalized") or debug_base["normalized"]
        state["lastValid"] = {
            "sideL": dict(pad["sideL"]),
            "sideR": dict(pad["sideR"]),
        }
        state["invalidFrameCount"] = 0
        state["holdFrameCount"] = 0
        debug_base["output"] = pad
        debug_base["quality"]["heldLastValid"] = False
        return {
            "sideL": pad["sideL"],
            "sideR": pad["sideR"],
            "legacySmileCornerEvidence": float(legacy_ev),
            "canonicalCornerMotionEvidence": float(canon_ev),
            "scenarioCornerEvidenceSource": "legacy-smile-v1",
            "debug": debug_base,
        }

    if not state.get("neutralReady"):
        debug_base["quality"]["rejectReason"] = debug_base["quality"].get("rejectReason") or "neutral-not-ready"
        debug_base["output"] = _center_pad()
        return {
            "sideL": {"x": 50.0, "y": 50.0},
            "sideR": {"x": 50.0, "y": 50.0},
            "legacySmileCornerEvidence": float(legacy_ev),
            "canonicalCornerMotionEvidence": float(canon_ev),
            "scenarioCornerEvidenceSource": "legacy-smile-v1",
            "debug": debug_base,
        }

    inv = int(state.get("invalidFrameCount") or 0) + 1
    state["invalidFrameCount"] = inv
    last = state.get("lastValid")
    if last and inv <= hold_n:
        debug_base["quality"]["heldLastValid"] = True
        debug_base["output"] = {"sideL": dict(last["sideL"]), "sideR": dict(last["sideR"])}
        return {
            "sideL": dict(last["sideL"]),
            "sideR": dict(last["sideR"]),
            "legacySmileCornerEvidence": float(legacy_ev),
            "canonicalCornerMotionEvidence": float(canon_ev),
            "scenarioCornerEvidenceSource": "legacy-smile-v1",
            "debug": debug_base,
        }
    if last and inv <= hold_n + decay_n:
        t = 1.0 - (inv - hold_n) / max(1, decay_n)
        pad = _lerp_pad(last, t)
        debug_base["quality"]["heldLastValid"] = True
        debug_base["output"] = pad
        return {
            "sideL": pad["sideL"],
            "sideR": pad["sideR"],
            "legacySmileCornerEvidence": float(legacy_ev),
            "canonicalCornerMotionEvidence": float(canon_ev),
            "scenarioCornerEvidenceSource": "legacy-smile-v1",
            "debug": debug_base,
        }

    debug_base["output"] = _center_pad()
    return {
        "sideL": {"x": 50.0, "y": 50.0},
        "sideR": {"x": 50.0, "y": 50.0},
        "legacySmileCornerEvidence": float(legacy_ev),
        "canonicalCornerMotionEvidence": float(canon_ev),
        "scenarioCornerEvidenceSource": "legacy-smile-v1",
        "debug": debug_base,
    }
