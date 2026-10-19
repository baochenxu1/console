"""Brow Scenario Gate（强化版：独立 Artifact Gate）。

闭嘴转头时抑制伪信号；真实挑眉时允许 pass_explicit。
不再因 poseGate / 轻度 headMotion 永久锁零。
"""

from __future__ import annotations

import time
from typing import Any

from mediapipe_mapping_config import _safe_float


_BROW_KEYS = (
    "browInner",
    "browOuterLeft",
    "browOuterRight",
    "browLeftTip",
    "browLeftMid",
    "browLeftTail",
    "browRightTip",
    "browRightMid",
    "browRightTail",
    "browLeft",
    "browRight",
)


def _zero_axis() -> dict[str, float]:
    return {k: 0.0 for k in _BROW_KEYS}


def create_brow_state() -> dict[str, Any]:
    return {
        "prev": _zero_axis(),
        "locked_to_zero": {k: False for k in _BROW_KEYS},
        "explicit_brow_count": 0,
        "explicit_brow_active": False,
        "neutral_wait_start_ms": None,
        "neutral_fallback": False,
        "last_debug": {},
    }


def reset_brow_state(state: dict[str, Any] | None) -> dict[str, Any]:
    fresh = create_brow_state()
    if state is not None:
        state.clear()
        state.update(fresh)
    return fresh


def _bg_cfg(cfg: dict[str, Any]) -> dict[str, Any]:
    bg = cfg.get("browGate") if isinstance(cfg, dict) else None
    return bg if isinstance(bg, dict) else {}


def _clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else hi if v > hi else v


def _brow_side_from_mapping(raw_in: dict[str, float]) -> dict[str, Any]:
    def _abs3(a: float, b: float, c: float) -> float:
        return max(abs(a), abs(b), abs(c))

    bl = {
        "tip": float(raw_in.get("browLeftTip", 0.0)),
        "mid": float(raw_in.get("browLeftMid", 0.0)),
        "tail": float(raw_in.get("browLeftTail", 0.0)),
        "inner": float(raw_in.get("browInner", 0.0)),
        "outer": float(raw_in.get("browOuterLeft", 0.0)),
    }
    bl["absMax"] = _abs3(bl["tip"], bl["mid"], bl["tail"])
    br = {
        "tip": float(raw_in.get("browRightTip", 0.0)),
        "mid": float(raw_in.get("browRightMid", 0.0)),
        "tail": float(raw_in.get("browRightTail", 0.0)),
        "inner": float(raw_in.get("browInner", 0.0)),
        "outer": float(raw_in.get("browOuterRight", 0.0)),
    }
    br["absMax"] = _abs3(br["tip"], br["mid"], br["tail"])
    return {"browL": bl, "browR": br}


_LIP_ONLY_IMMEDIATE_REASONS = frozenset(
    {
        "decision-lip-only-artifact",
        "head-motion-lip-only",
    }
)


def _normalize_immediate_lock(immediate_artifact_lock: Any, evidence: dict[str, Any]) -> dict[str, Any]:
    if isinstance(immediate_artifact_lock, dict):
        return immediate_artifact_lock
    if isinstance(evidence.get("immediateArtifactLock"), dict):
        return evidence["immediateArtifactLock"]
    if immediate_artifact_lock:
        return {"active": True, "reason": "legacy-bool", "appliedTo": {"brow": True}}
    return {"active": False, "reason": "", "appliedTo": {"brow": False}}


def _is_lip_only_immediate(immediate_info: dict[str, Any], classifier_reason: str) -> bool:
    imm_reason = str(immediate_info.get("reason", ""))
    if imm_reason in _LIP_ONLY_IMMEDIATE_REASONS:
        return True
    if classifier_reason == "head-motion-lip-only-artifact":
        return True
    return False


def _immediate_applies_to_brow(immediate_info: dict[str, Any]) -> bool:
    if not immediate_info.get("active"):
        return False
    applied = immediate_info.get("appliedTo")
    if isinstance(applied, dict) and "brow" in applied:
        return bool(applied.get("brow"))
    return False


def apply_brow_gate(
    brow_values: dict[str, float],
    final_scenario: str,
    decision_reason: str,
    evidence: dict[str, Any] | None,
    cfg: dict[str, Any],
    state: dict[str, Any] | None,
    immediate_artifact_lock: Any = False,
) -> dict[str, Any]:
    """对 brow 输出统一应用独立 artifact gate，返回 gated 值与 debug。"""
    st = state if state is not None else create_brow_state()
    bg = _bg_cfg(cfg)
    ev = evidence if isinstance(evidence, dict) else {}
    enabled = bool(bg.get("enabled", True))

    lock_on_head = bool(bg.get("lockOnHeadMotionLikely", True))
    suppress_mouth_flag = bool(bg.get("suppressDuringMouthMotion", True))
    min_quality = _safe_float(bg.get("browMinQuality"), 0.5)
    head_score_thr = _safe_float(bg.get("browHeadMotionScoreThreshold"), 0.08)
    mouth_score_thr = _safe_float(bg.get("browMouthMotionScoreThreshold"), 3.5)
    on_thr = _safe_float(bg.get("browRawOnThreshold"), 14.0)
    strong_thr = _safe_float(bg.get("browRawStrongThreshold"), 24.0)
    off_thr = _safe_float(bg.get("browRawOffThreshold"), 6.0)
    confirm = max(1, int(_safe_float(bg.get("browConfirmFrames"), 4)))
    allow_explicit_lip = bool(bg.get("allowExplicitBrowDuringLipArtifact", True))
    allow_explicit_mild_head = bool(bg.get("allowExplicitBrowDuringMildHeadMotion", True))
    lock_immediate_weak = bool(bg.get("lockBrowOnImmediateArtifactOnlyWhenWeak", True))
    mouth_scale = _clamp(_safe_float(bg.get("mouthMotionSuppressScale"), 0.15), 0.0, 1.0)
    head_scale = _clamp(_safe_float(bg.get("headMotionSuppressScale"), 0.25), 0.0, 1.0)
    snap_zero = max(0.0, _safe_float(bg.get("snapToZero"), 2.5))
    deadband = max(0.0, _safe_float(bg.get("outputDeadband"), 5.0))
    reset_prev_on_lock = bool(bg.get("resetPrevOnLock", True))
    neutral_fallback_ms = max(500.0, _safe_float(bg.get("neutralFallbackMs"), 2000.0))

    scenario = str(final_scenario or "neutral_still")
    reason = str(decision_reason or "")

    raw_in = {k: float(brow_values.get(k, 0.0)) for k in _BROW_KEYS}
    brow_abs_max = 0.0
    for k in _BROW_KEYS:
        brow_abs_max = max(brow_abs_max, abs(raw_in[k]))

    timestamp_ms = _safe_float(ev.get("timestampMs"), 0.0)
    if timestamp_ms <= 0:
        timestamp_ms = time.time() * 1000.0

    nose_motion_active = bool(ev.get("noseAnchorMotion"))
    head_motion_score = _safe_float(ev.get("headMotionScore"), 0.0)
    old_mouth_pose_head = bool(ev.get("oldMouthPoseHeadMotionActive"))
    pose_gate_active = bool(ev.get("poseGateActive"))
    raw_mouth_score = _safe_float(ev.get("rawMouthScore"), 0.0)
    strong_mouth_active = bool(ev.get("strongMouthActive"))
    jaw_abs = _safe_float(ev.get("jawAbs"), 0.0)
    jaw_input_abs = _safe_float(ev.get("jawInputAbs"), 0.0)
    lip_abs_max = _safe_float(ev.get("lipAbsMax"), 0.0)
    face_detected = bool(ev.get("faceDetected", True))
    quality = _safe_float(ev.get("quality"), 1.0)
    nose_neutral_ready = bool(ev.get("noseNeutralReady", True))
    lip_neutral_ready = bool(ev.get("lipNeutralReady", True))
    jaw_neutral_ready = bool(ev.get("jawNeutralReady", True))
    brow_neutral_ready = bool(nose_neutral_ready and lip_neutral_ready and jaw_neutral_ready)

    neutral_ready_details = {
        "nose": bool(nose_neutral_ready),
        "lip": bool(lip_neutral_ready),
        "jaw": bool(jaw_neutral_ready),
    }
    neutral_count = sum(1 for v in neutral_ready_details.values() if v)
    neutral_required = 3

    neutral_fallback = bool(st.get("neutral_fallback"))
    if brow_neutral_ready:
        st["neutral_wait_start_ms"] = None
        st["neutral_fallback"] = False
        neutral_fallback = False
        brow_neutral_effective = True
    else:
        if st.get("neutral_wait_start_ms") is None and face_detected:
            st["neutral_wait_start_ms"] = float(timestamp_ms)
        wait_start = float(st.get("neutral_wait_start_ms") or timestamp_ms)
        elapsed = max(0.0, float(timestamp_ms) - wait_start)
        if face_detected and quality >= min_quality and elapsed >= neutral_fallback_ms:
            neutral_fallback = True
            st["neutral_fallback"] = True
            brow_neutral_effective = True
        else:
            brow_neutral_effective = False

    head_motion_mild = bool(
        nose_motion_active
        or head_motion_score >= head_score_thr
        or old_mouth_pose_head
        or pose_gate_active
        or scenario == "head_motion_mouth_motion"
    )
    head_lock_zero = bool(
        lock_on_head
        and (
            scenario == "closed_head_turn"
            or reason == "head-motion-lip-only-artifact"
        )
    )
    head_motion_likely = bool(head_motion_mild or head_lock_zero)

    mouth_motion_likely = bool(
        scenario == "frontal_mouth_motion"
        or scenario == "head_motion_mouth_motion"
        or raw_mouth_score >= mouth_score_thr
        or strong_mouth_active
        or jaw_abs >= mouth_score_thr
        or jaw_input_abs >= mouth_score_thr
        or lip_abs_max >= mouth_score_thr
    )
    brow_safe_pose = bool(
        brow_neutral_effective
        and (not head_lock_zero)
        and (not mouth_motion_likely)
        and face_detected
        and quality >= min_quality
    )

    count = int(st.get("explicit_brow_count", 0))
    if face_detected and quality >= min_quality and brow_abs_max >= on_thr:
        count += 1
    elif brow_abs_max <= off_thr:
        count = 0
    st["explicit_brow_count"] = count
    explicit_active = count >= confirm
    st["explicit_brow_active"] = bool(explicit_active)

    immediate_info = _normalize_immediate_lock(immediate_artifact_lock, ev)
    immediate_active = bool(immediate_info.get("active"))
    immediate_reason = str(immediate_info.get("reason", ""))
    lip_only_immediate = _is_lip_only_immediate(immediate_info, reason)
    immediate_applies_brow = _immediate_applies_to_brow(immediate_info)

    brow_strong_evidence = bool(
        brow_abs_max >= on_thr and explicit_active and face_detected and quality >= min_quality
    )
    brow_very_strong = bool(brow_abs_max >= strong_thr and count >= max(2, confirm // 2))

    brow_artifact_lock = bool(
        immediate_applies_brow
        and immediate_active
        and lock_immediate_weak
        and not explicit_active
        and brow_abs_max < on_thr
    )

    locked = False
    scale = 1.0
    reset_prev = False

    if not enabled:
        gate_action = "disabled"
        decision = "disabled"
    elif not brow_neutral_effective:
        locked = True
        reset_prev = True
        gate_action = "lock_zero"
        decision = "neutral-not-ready"
        count = 0
        st["explicit_brow_count"] = 0
        explicit_active = False
        st["explicit_brow_active"] = False
    elif (
        lip_only_immediate
        and immediate_active
        and allow_explicit_lip
        and explicit_active
        and brow_abs_max >= on_thr
    ):
        scale = 1.0
        gate_action = "pass_explicit_lip_artifact_override"
        decision = "explicit-brow-overrides-lip-artifact"
    elif lip_only_immediate and immediate_active:
        if brow_abs_max <= off_thr:
            locked = True
            gate_action = "suppress_lip_artifact_weak_brow"
            decision = "lip-artifact-weak-brow-lock"
        else:
            scale = mouth_scale
            gate_action = "suppress_lip_artifact_weak_brow"
            decision = "lip-artifact-weak-brow-suppress"
    elif brow_artifact_lock:
        locked = True
        reset_prev = True
        gate_action = "lock_brow_artifact"
        decision = "brow-artifact-lock"
    elif head_lock_zero and not explicit_active:
        locked = True
        reset_prev = True
        gate_action = "lock_zero"
        decision = "head-motion-weak-brow"
    elif head_lock_zero and explicit_active:
        if allow_explicit_mild_head and brow_very_strong:
            scale = 1.0
            gate_action = "pass_explicit"
            decision = "explicit-brow-during-head-motion"
        elif brow_very_strong or (brow_abs_max >= strong_thr and count >= confirm):
            scale = 1.0
            gate_action = "pass_explicit"
            decision = "explicit-brow-during-head-motion"
        elif brow_abs_max < strong_thr:
            scale = head_scale if head_scale > 0 else mouth_scale
            gate_action = "suppress_head"
            decision = "head-motion-mild-brow"
        else:
            scale = max(head_scale, mouth_scale, 0.55)
            gate_action = "pass_explicit_attenuated"
            decision = "explicit-brow-attenuated-head-motion"
    elif mouth_motion_likely and not explicit_active and suppress_mouth_flag:
        scale = mouth_scale
        gate_action = "suppress_mouth"
        decision = "mouth-motion-suppress"
    elif explicit_active:
        if brow_very_strong or (brow_abs_max >= strong_thr and count >= confirm):
            scale = 1.0
            gate_action = "pass_explicit"
            decision = "pass-explicit"
        else:
            scale = max(mouth_scale, head_scale, 0.55)
            gate_action = "pass_explicit_attenuated"
            decision = "pass-explicit-attenuated"
        if mouth_motion_likely and suppress_mouth_flag and brow_abs_max < strong_thr:
            scale = max(mouth_scale, head_scale)
            decision = "pass-explicit-mouth-attenuated"
    elif head_motion_mild and head_scale < 1.0:
        scale = head_scale
        gate_action = "suppress_head"
        decision = "head-motion-suppress"
    else:
        scale = 1.0
        gate_action = "normal"
        decision = "normal"

    out: dict[str, float] = {}
    if locked:
        for k in _BROW_KEYS:
            out[k] = 0.0
            st["locked_to_zero"][k] = True
        if reset_prev_on_lock and reset_prev:
            st["prev"] = _zero_axis()
    else:
        for k in _BROW_KEYS:
            st["locked_to_zero"][k] = False
            val = raw_in[k] * scale
            if abs(val) < deadband:
                val = 0.0
            if abs(val) < snap_zero and abs(float(st["prev"].get(k, 0.0))) < snap_zero:
                val = 0.0
            st["prev"][k] = val
            out[k] = val

    raw_sides = _brow_side_from_mapping(raw_in)
    final_sides = _brow_side_from_mapping(out)

    debug = {
        "enabled": bool(enabled),
        "finalScenario": scenario,
        "decisionReason": decision,
        "classifierReason": reason,
        "immediateArtifactLock": bool(immediate_active),
        "immediateArtifactReason": immediate_reason,
        "immediateArtifactAppliesToBrow": bool(immediate_applies_brow),
        "lipOnlyImmediateArtifact": bool(lip_only_immediate),
        "browArtifactLock": bool(brow_artifact_lock),
        "browStrongEvidence": bool(brow_strong_evidence),
        "browVeryStrongEvidence": bool(brow_very_strong),
        "neutralReady": bool(brow_neutral_effective),
        "neutralReadyRaw": bool(brow_neutral_ready),
        "neutralFallback": bool(neutral_fallback),
        "neutralWaitMs": float(
            max(0.0, float(timestamp_ms) - float(st.get("neutral_wait_start_ms") or timestamp_ms))
        ),
        "neutralCount": int(neutral_count),
        "neutralRequired": int(neutral_required),
        "neutralReadyDetails": neutral_ready_details,
        "headMotionLikely": bool(head_motion_likely),
        "headMotionMild": bool(head_motion_mild),
        "headLockZero": bool(head_lock_zero),
        "mouthMotionLikely": bool(mouth_motion_likely),
        "browSafePose": bool(brow_safe_pose),
        "browAbsMax": float(brow_abs_max),
        "explicitBrowActive": bool(explicit_active),
        "explicitBrowCount": int(count),
        "gateAction": gate_action,
        "outputScale": float(scale),
        "suppressScale": float(scale),
        "outputDeadband": float(deadband),
        "snapToZero": float(snap_zero),
        "resetPrevOnLock": bool(reset_prev_on_lock),
        "evidence": {
            "noseAnchorMotion": bool(nose_motion_active),
            "headMotionScore": float(head_motion_score),
            "oldMouthPoseHeadMotionActive": bool(old_mouth_pose_head),
            "poseGateActive": bool(pose_gate_active),
            "rawMouthScore": float(raw_mouth_score),
            "strongMouthActive": bool(strong_mouth_active),
            "jawAbs": float(jaw_abs),
            "jawInputAbs": float(jaw_input_abs),
            "lipAbsMax": float(lip_abs_max),
            "quality": float(quality),
            "faceDetected": bool(face_detected),
        },
        "thresholds": {
            "browHeadMotionScoreThreshold": float(head_score_thr),
            "browMouthMotionScoreThreshold": float(mouth_score_thr),
            "browRawOnThreshold": float(on_thr),
            "browRawStrongThreshold": float(strong_thr),
            "browRawOffThreshold": float(off_thr),
            "browConfirmFrames": int(confirm),
            "browMinQuality": float(min_quality),
            "neutralFallbackMs": float(neutral_fallback_ms),
        },
        "before": dict(raw_in),
        "after": dict(out),
        "raw": raw_sides,
        "final": final_sides,
    }
    st["last_debug"] = debug
    return {"values": out, "debug": debug}


def build_brow_debug_payload(
    raw_in: dict[str, float],
    gate_debug: dict[str, Any],
    rig_brow_l: dict[str, float],
    rig_brow_r: dict[str, float],
) -> dict[str, Any]:
    """组装 debug.brow 全链路结构（Python 侧）。"""
    raw_sides = _brow_side_from_mapping(raw_in)
    final_sides = {
        "browL": {
            "tip": float(rig_brow_l.get("tip", 0.0)),
            "mid": float(rig_brow_l.get("mid", 0.0)),
            "tail": float(rig_brow_l.get("tail", 0.0)),
        },
        "browR": {
            "tip": float(rig_brow_r.get("tip", 0.0)),
            "mid": float(rig_brow_r.get("mid", 0.0)),
            "tail": float(rig_brow_r.get("tail", 0.0)),
        },
    }
    gate = gate_debug if isinstance(gate_debug, dict) else {}
    return {
        "raw": raw_sides,
        "afterStabilizer": raw_sides,
        "gate": {
            "action": gate.get("gateAction"),
            "decisionReason": gate.get("decisionReason"),
            "classifierReason": gate.get("classifierReason"),
            "neutralReady": gate.get("neutralReady"),
            "neutralReadyDetails": gate.get("neutralReadyDetails"),
            "neutralFallback": gate.get("neutralFallback"),
            "neutralCount": gate.get("neutralCount"),
            "neutralRequired": gate.get("neutralRequired"),
            "headMotionLikely": gate.get("headMotionLikely"),
            "mouthMotionLikely": gate.get("mouthMotionLikely"),
            "browSafePose": gate.get("browSafePose"),
            "explicitBrowActive": gate.get("explicitBrowActive"),
            "explicitBrowCount": gate.get("explicitBrowCount"),
            "immediateArtifactLock": gate.get("immediateArtifactLock"),
            "immediateArtifactReason": gate.get("immediateArtifactReason"),
            "immediateArtifactAppliesToBrow": gate.get("immediateArtifactAppliesToBrow"),
            "lipOnlyImmediateArtifact": gate.get("lipOnlyImmediateArtifact"),
            "browArtifactLock": gate.get("browArtifactLock"),
            "browStrongEvidence": gate.get("browStrongEvidence"),
            "browVeryStrongEvidence": gate.get("browVeryStrongEvidence"),
            "outputScale": gate.get("outputScale"),
            "browAbsMax": gate.get("browAbsMax"),
        },
        "final": final_sides,
    }
