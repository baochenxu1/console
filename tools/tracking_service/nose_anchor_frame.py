"""Nose Anchor Gate V1.

只使用鼻部局部锚点（鼻尖 + 鼻梁）作为头部稳定参考，用于判断 head motion。
不使用眼角 / 脸颊 / 嘴角 / 嘴唇 / 下巴，避免真实嘴部运动牵连面部肌肉造成误判。
"""

from __future__ import annotations

import math
from typing import Any

from mediapipe_mapping_config import _safe_float

_EPS = 1e-6


def default_nose_anchor_config() -> dict[str, Any]:
    return {
        "enabled": True,
        "noseTipIndex": 1,
        "noseBridgeIndices": [4, 5, 6, 195, 197],
        "useNoseClusterCenter": True,
        "useNoseBridgeVector": True,
        "minNoseScale": 0.005,
        "use3d": True,
        # neutral 采集
        "neutralWarmupFrames": 8,
        "neutralFrames": 30,
        # motion 阈值
        "motionThreshold": 0.12,
        "positionThreshold": 0.10,
        "scaleThreshold": 0.08,
        "vectorThreshold": 0.12,
    }


_NOSE_BOOL_KEYS = frozenset({"enabled", "useNoseClusterCenter", "useNoseBridgeVector", "use3d"})


def normalize_nose_anchor_config(raw: Any) -> dict[str, Any]:
    base = default_nose_anchor_config()
    if not isinstance(raw, dict):
        return base
    for k, v in default_nose_anchor_config().items():
        if k == "noseBridgeIndices":
            arr = raw.get(k, v)
            base[k] = [int(x) for x in arr] if isinstance(arr, (list, tuple)) else list(v)
        elif k == "noseTipIndex":
            base[k] = int(_safe_float(raw.get(k), float(v)))
        elif k in _NOSE_BOOL_KEYS:
            base[k] = bool(raw.get(k, v))
        elif isinstance(v, (int, float)):
            base[k] = _safe_float(raw.get(k), float(v))
        else:
            base[k] = raw.get(k, v)
    return base


# ---------------------------------------------------------------------------
# 状态管理
# ---------------------------------------------------------------------------
def create_nose_anchor_state() -> dict[str, Any]:
    z = {"centerX": 0.0, "centerY": 0.0, "centerZ": 0.0, "scale": 0.0, "vectorX": 0.0, "vectorY": 0.0, "vectorZ": 0.0}
    return {
        "neutral_ready": False,
        "neutral_mode": "idle",
        "neutral_count": 0,
        "neutral_warmup_count": 0,
        "neutral_sum": dict(z),
        "neutral": dict(z),
        "last_debug": {},
    }


def reset_nose_anchor_state(state: dict[str, Any] | None) -> dict[str, Any]:
    fresh = create_nose_anchor_state()
    if state is not None:
        state.clear()
        state.update(fresh)
    return fresh


def start_nose_neutral_calibration(state: dict[str, Any] | None, reason: str = "manual") -> None:
    if state is None:
        return
    reset_nose_anchor_state(state)
    auto_reasons = ("startCameraTracking", "autoLipNeutralOnStart", "auto_start", "mouthNeutral")
    state["neutral_mode"] = "auto_start" if str(reason) in auto_reasons else "manual"
    state["neutral_ready"] = False


# ---------------------------------------------------------------------------
# 几何
# ---------------------------------------------------------------------------
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


def _avg_points(points: list[tuple[float, float, float]]) -> tuple[float, float, float]:
    n = max(1, len(points))
    return (
        sum(p[0] for p in points) / n,
        sum(p[1] for p in points) / n,
        sum(p[2] for p in points) / n,
    )


def build_nose_anchor_frame(
    landmarks: Any,
    cfg: dict[str, Any],
    get_landmark_xy,
) -> dict[str, Any]:
    """根据鼻尖 + 鼻梁锚点簇构建鼻部局部参考帧。"""
    ncfg = cfg if "noseTipIndex" in cfg else normalize_nose_anchor_config(cfg)
    tip_idx = int(ncfg.get("noseTipIndex", 1))
    bridge_idx = [int(i) for i in (ncfg.get("noseBridgeIndices") or [4, 5, 6, 195, 197])]

    tip = _read_point3(landmarks, tip_idx, get_landmark_xy)
    if tip is None:
        return {"ok": False, "error": "nose-tip-missing", "coordinateMode": "invalid"}

    bridge_pts: list[tuple[float, float, float]] = []
    for i in bridge_idx:
        p = _read_point3(landmarks, i, get_landmark_xy)
        if p is not None:
            bridge_pts.append(p)
    if not bridge_pts:
        return {"ok": False, "error": "nose-bridge-missing", "coordinateMode": "invalid"}

    use_3d = bool(ncfg.get("use3d", True))
    has_z = abs(tip[2]) > 1e-6 or any(abs(p[2]) > 1e-6 for p in bridge_pts)
    coordinate_mode = "3d" if (use_3d and has_z) else "2d_fallback"
    if coordinate_mode == "2d_fallback":
        tip = (tip[0], tip[1], 0.0)
        bridge_pts = [(p[0], p[1], 0.0) for p in bridge_pts]

    bridge_center = _avg_points(bridge_pts)

    if bool(ncfg.get("useNoseClusterCenter", True)):
        center = _avg_points([tip] + bridge_pts)
    else:
        center = tip

    # scale：鼻部锚点簇内部尺度（鼻尖到鼻梁中心距离 + 鼻梁簇散布的平均）
    tip_to_bridge = math.sqrt(
        (tip[0] - bridge_center[0]) ** 2
        + (tip[1] - bridge_center[1]) ** 2
        + (tip[2] - bridge_center[2]) ** 2
    )
    spread = 0.0
    if len(bridge_pts) > 1:
        spread = sum(
            math.sqrt(
                (p[0] - bridge_center[0]) ** 2
                + (p[1] - bridge_center[1]) ** 2
                + (p[2] - bridge_center[2]) ** 2
            )
            for p in bridge_pts
        ) / len(bridge_pts)
    scale = max(tip_to_bridge, spread)
    min_scale = max(_EPS, _safe_float(ncfg.get("minNoseScale"), 0.005))
    if scale < min_scale:
        return {
            "ok": False,
            "error": "nose-scale-too-small",
            "coordinateMode": coordinate_mode,
            "center": {"x": float(center[0]), "y": float(center[1]), "z": float(center[2])},
            "scale": float(scale),
        }

    # vector：鼻尖 -> 鼻梁中心（鼻部朝向），归一化
    if bool(ncfg.get("useNoseBridgeVector", True)):
        vx, vy, vz = (bridge_center[0] - tip[0], bridge_center[1] - tip[1], bridge_center[2] - tip[2])
    else:
        vx, vy, vz = (tip[0] - center[0], tip[1] - center[1], tip[2] - center[2])
    vnorm = math.sqrt(vx * vx + vy * vy + vz * vz)
    if vnorm < _EPS:
        vector = (0.0, 0.0, 0.0)
    else:
        vector = (vx / vnorm, vy / vnorm, vz / vnorm)

    return {
        "ok": True,
        "coordinateMode": coordinate_mode,
        "center": {"x": float(center[0]), "y": float(center[1]), "z": float(center[2])},
        "scale": float(scale),
        "vector": {"x": float(vector[0]), "y": float(vector[1]), "z": float(vector[2])},
        "error": "",
    }


def evaluate_nose_anchor_motion(
    anchor: dict[str, Any],
    neutral: dict[str, Any],
    cfg: dict[str, Any],
) -> dict[str, Any]:
    """比较当前鼻部锚点与 neutral，返回 motion 判定。"""
    ncfg = cfg if "noseTipIndex" in cfg else normalize_nose_anchor_config(cfg)
    pos_thr = max(0.0, _safe_float(ncfg.get("positionThreshold"), 0.10))
    scale_thr = max(0.0, _safe_float(ncfg.get("scaleThreshold"), 0.08))
    vec_thr = max(0.0, _safe_float(ncfg.get("vectorThreshold"), 0.12))
    motion_thr = max(0.0, _safe_float(ncfg.get("motionThreshold"), 0.12))

    thresholds = {
        "positionThreshold": float(pos_thr),
        "scaleThreshold": float(scale_thr),
        "vectorThreshold": float(vec_thr),
        "motionThreshold": float(motion_thr),
    }

    c = anchor.get("center") if isinstance(anchor.get("center"), dict) else {}
    v = anchor.get("vector") if isinstance(anchor.get("vector"), dict) else {}
    nc = neutral.get("center") if isinstance(neutral.get("center"), dict) else {}
    nv = neutral.get("vector") if isinstance(neutral.get("vector"), dict) else {}
    neutral_scale = max(_EPS, _safe_float(neutral.get("scale"), 0.0))

    dx = _safe_float(c.get("x"), 0.0) - _safe_float(nc.get("x"), 0.0)
    dy = _safe_float(c.get("y"), 0.0) - _safe_float(nc.get("y"), 0.0)
    dz = _safe_float(c.get("z"), 0.0) - _safe_float(nc.get("z"), 0.0)
    ndx = abs(dx) / neutral_scale
    ndy = abs(dy) / neutral_scale
    ndz = abs(dz) / neutral_scale

    scale_delta = abs(_safe_float(anchor.get("scale"), 0.0) - neutral_scale) / neutral_scale

    # vector delta：单位向量间的欧氏距离（小角度近似弧度）
    vdx = _safe_float(v.get("x"), 0.0) - _safe_float(nv.get("x"), 0.0)
    vdy = _safe_float(v.get("y"), 0.0) - _safe_float(nv.get("y"), 0.0)
    vdz = _safe_float(v.get("z"), 0.0) - _safe_float(nv.get("z"), 0.0)
    vector_delta = math.sqrt(vdx * vdx + vdy * vdy + vdz * vdz)

    motion_score = max(ndx, ndy, ndz, scale_delta, vector_delta)
    motion_active = (
        ndx > pos_thr
        or ndy > pos_thr
        or ndz > pos_thr
        or scale_delta > scale_thr
        or vector_delta > vec_thr
    )

    return {
        "delta": {
            "dx": float(dx),
            "dy": float(dy),
            "dz": float(dz),
            "normDx": float(ndx),
            "normDy": float(ndy),
            "normDz": float(ndz),
            "scaleDelta": float(scale_delta),
            "vectorDelta": float(vector_delta),
        },
        "motionScore": float(motion_score),
        "motionActive": bool(motion_active),
        "thresholds": thresholds,
    }


def _update_nose_neutral(
    state: dict[str, Any],
    anchor: dict[str, Any],
    ncfg: dict[str, Any],
    *,
    face_detected: bool,
) -> tuple[bool, bool, str]:
    """返回 (still_calibrating, just_completed, hint)。"""
    if state.get("neutral_ready"):
        return False, False, "ready"
    if not (face_detected and bool(anchor.get("ok"))):
        return True, False, "waiting-nose"

    warmup_need = max(0, int(_safe_float(ncfg.get("neutralWarmupFrames"), 8)))
    n_frames = max(1, int(_safe_float(ncfg.get("neutralFrames"), 30)))

    wc = int(state.get("neutral_warmup_count", 0))
    if wc < warmup_need:
        state["neutral_warmup_count"] = wc + 1
        return True, False, "warmup"

    c = anchor.get("center") or {}
    v = anchor.get("vector") or {}
    ns = state["neutral_sum"]
    ns["centerX"] += _safe_float(c.get("x"), 0.0)
    ns["centerY"] += _safe_float(c.get("y"), 0.0)
    ns["centerZ"] += _safe_float(c.get("z"), 0.0)
    ns["scale"] += _safe_float(anchor.get("scale"), 0.0)
    ns["vectorX"] += _safe_float(v.get("x"), 0.0)
    ns["vectorY"] += _safe_float(v.get("y"), 0.0)
    ns["vectorZ"] += _safe_float(v.get("z"), 0.0)
    nc = int(state.get("neutral_count", 0)) + 1
    state["neutral_count"] = nc
    if nc < n_frames:
        return True, False, "calibrating"

    state["neutral"] = {
        "centerX": ns["centerX"] / nc,
        "centerY": ns["centerY"] / nc,
        "centerZ": ns["centerZ"] / nc,
        "scale": (ns["scale"] / nc) if (ns["scale"] / nc) > _EPS else max(_EPS, _safe_float(ncfg.get("minNoseScale"), 0.005)),
        "vectorX": ns["vectorX"] / nc,
        "vectorY": ns["vectorY"] / nc,
        "vectorZ": ns["vectorZ"] / nc,
    }
    state["neutral_ready"] = True
    state["neutral_mode"] = "ready"
    return False, True, "just-completed"


def _neutral_to_anchor(neutral: dict[str, Any]) -> dict[str, Any]:
    return {
        "center": {
            "x": float(neutral.get("centerX", 0.0)),
            "y": float(neutral.get("centerY", 0.0)),
            "z": float(neutral.get("centerZ", 0.0)),
        },
        "scale": float(neutral.get("scale", 0.0)),
        "vector": {
            "x": float(neutral.get("vectorX", 0.0)),
            "y": float(neutral.get("vectorY", 0.0)),
            "z": float(neutral.get("vectorZ", 0.0)),
        },
    }


def process_nose_anchor(
    nose_state: dict[str, Any] | None,
    landmarks: Any,
    cfg: dict[str, Any],
    get_landmark_xy,
    *,
    face_detected: bool = True,
) -> dict[str, Any]:
    """每帧入口：构建鼻部锚点、推进 neutral 采集、评估 motion。

    返回的 dict 同时作为 debug.noseAnchor，并含 motionActive / neutralReady 供 gate 使用。
    """
    ncfg = normalize_nose_anchor_config(cfg.get("noseAnchor") if isinstance(cfg, dict) else None)
    st = nose_state if nose_state is not None else create_nose_anchor_state()

    enabled = bool(ncfg.get("enabled", True))
    if landmarks is None:
        anchor = {"ok": False, "error": "no-landmarks", "coordinateMode": "invalid"}
    else:
        anchor = build_nose_anchor_frame(landmarks, ncfg, get_landmark_xy)

    still_cal, just_done, hint = _update_nose_neutral(st, anchor, ncfg, face_detected=face_detected)

    neutral_anchor = _neutral_to_anchor(st.get("neutral") or {})
    neutral_ready = bool(st.get("neutral_ready"))

    if enabled and neutral_ready and bool(anchor.get("ok")):
        motion = evaluate_nose_anchor_motion(anchor, neutral_anchor, ncfg)
    else:
        motion = {
            "delta": {
                "dx": 0.0, "dy": 0.0, "dz": 0.0,
                "normDx": 0.0, "normDy": 0.0, "normDz": 0.0,
                "scaleDelta": 0.0, "vectorDelta": 0.0,
            },
            "motionScore": 0.0,
            "motionActive": False,
            "thresholds": {
                "positionThreshold": float(_safe_float(ncfg.get("positionThreshold"), 0.10)),
                "scaleThreshold": float(_safe_float(ncfg.get("scaleThreshold"), 0.08)),
                "vectorThreshold": float(_safe_float(ncfg.get("vectorThreshold"), 0.12)),
                "motionThreshold": float(_safe_float(ncfg.get("motionThreshold"), 0.12)),
            },
        }

    dbg = {
        "enabled": enabled,
        "ok": bool(anchor.get("ok")),
        "coordinateMode": str(anchor.get("coordinateMode", "invalid")),
        "center": anchor.get("center") if isinstance(anchor.get("center"), dict) else {"x": 0.0, "y": 0.0, "z": 0.0},
        "scale": float(_safe_float(anchor.get("scale"), 0.0)),
        "vector": anchor.get("vector") if isinstance(anchor.get("vector"), dict) else {"x": 0.0, "y": 0.0, "z": 0.0},
        "error": str(anchor.get("error", "")),
        "neutral": neutral_anchor,
        "neutralReady": neutral_ready,
        "neutralState": {
            "mode": str(st.get("neutral_mode", "idle")),
            "neutralReady": neutral_ready,
            "neutralCount": int(st.get("neutral_count", 0)),
            "neutralWarmupCount": int(st.get("neutral_warmup_count", 0)),
            "hint": hint,
        },
        "calibrating": bool(still_cal or just_done),
        "delta": motion["delta"],
        "motionScore": float(motion["motionScore"]),
        "motionActive": bool(motion["motionActive"] and enabled and neutral_ready),
        "thresholds": motion["thresholds"],
    }
    st["last_debug"] = dbg
    return dbg
