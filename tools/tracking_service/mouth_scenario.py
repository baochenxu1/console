"""Mouth Scenario Classifier V2 — Evidence First.

判定顺序改为：先判断有没有真实嘴部动作，再判断是否闭嘴转头。

- rawMouthEvidence 高 → 优先 frontal_mouth_motion，不被 noseAnchorMotion 压制。
- rawMouthEvidence 低 + headMotionEvidence 高 → closed_head_turn。
- 带迟滞状态机，避免逐帧抖动。

lip 与 jaw 共用同一个 finalScenario（本模块产出），保证两者不矛盾。
"""

from __future__ import annotations

from typing import Any

from mediapipe_mapping_config import _safe_float


_SCENARIOS = (
    "neutral_still",
    "closed_head_turn",
    "frontal_mouth_motion",
    "head_motion_mouth_motion",
    "unknown",
)


def create_mouth_scenario_state() -> dict[str, Any]:
    return {
        "current": "neutral_still",
        "candidate": None,
        "candidate_count": 0,
        "last_changed_at": 0.0,
        "open_close_count": 0,
        "open_close_hold": 0,
        "prev_head_score": 0.0,
        "mouth_evidence_hold": 0,
        "last_debug": {},
    }


def reset_mouth_scenario_state(state: dict[str, Any] | None) -> dict[str, Any]:
    fresh = create_mouth_scenario_state()
    if state is not None:
        state.clear()
        state.update(fresh)
    return fresh


def _ms_cfg(cfg: dict[str, Any]) -> dict[str, Any]:
    ms = cfg.get("mouthScenario") if isinstance(cfg, dict) else None
    return ms if isinstance(ms, dict) else {}


def _required_confirm_frames(scenario: str, ms: dict[str, Any]) -> int:
    if scenario == "frontal_mouth_motion":
        return max(1, int(_safe_float(ms.get("frontalConfirmFrames"), 2)))
    if scenario == "head_motion_mouth_motion":
        return max(1, int(_safe_float(ms.get("frontalConfirmFrames"), 2)))
    if scenario == "closed_head_turn":
        return max(1, int(_safe_float(ms.get("closedTurnConfirmFrames"), 3)))
    if scenario == "neutral_still":
        return max(1, int(_safe_float(ms.get("neutralConfirmFrames"), 5)))
    return 2  # unknown 保守


def compute_reliable_mouth_evidence(
    raw_evidence: dict[str, Any],
    cfg: dict[str, Any],
) -> dict[str, Any]:
    """head motion 时用于判断是否真有嘴部动作。

    关键：不包含 lipAbsMax（pose-sensitive），避免转头时 lip 伪位移被当成嘴动。
    """
    ms = _ms_cfg(cfg)
    ap_thr = _safe_float(ms.get("reliableApertureThreshold"), 12.0)
    jaw_in_thr = _safe_float(ms.get("reliableJawInputThreshold"), 12.0)
    jaw_sc_thr = _safe_float(ms.get("reliableJawScoreThreshold"), 12.0)
    blend_thr = _safe_float(ms.get("reliableBlendOpenThreshold"), 8.0)
    corner_thr = _safe_float(ms.get("reliableCornerOffsetThreshold"), 10.0)
    min_sources = max(1, int(_safe_float(ms.get("reliableMinSourceCount"), 2)))

    aperture_scaled = float(raw_evidence.get("apertureAbsScaled", 0.0))
    jaw_input_abs = float(raw_evidence.get("jawInputAbs", 0.0))
    jaw_score = float(raw_evidence.get("jawScore", 0.0))
    blend_mouth_open = float(raw_evidence.get("blendMouthOpen", 0.0))
    blend_jaw_open = float(raw_evidence.get("blendJawOpen", 0.0))
    blend_open = max(blend_mouth_open, blend_jaw_open)
    corner_offset = float(raw_evidence.get("cornerOffsetAbs", 0.0))

    aperture_active = aperture_scaled >= ap_thr
    jaw_input_active = jaw_input_abs >= jaw_in_thr
    jaw_score_active = jaw_score >= jaw_sc_thr
    blend_open_active = blend_open >= blend_thr
    corner_active = corner_offset >= corner_thr

    sources: list[str] = []
    if aperture_active:
        sources.append("aperture")
    if jaw_input_active:
        sources.append("jawInput")
    if jaw_score_active:
        sources.append("jawScore")
    if blend_open_active:
        sources.append("blendOpen")
    if corner_active:
        sources.append("corner")
    active_source_count = len(sources)
    score = max(aperture_scaled, jaw_input_abs, jaw_score, blend_mouth_open, blend_jaw_open, corner_offset)
    return {
        "apertureActive": bool(aperture_active),
        "jawInputActive": bool(jaw_input_active),
        "jawScoreActive": bool(jaw_score_active),
        "blendOpenActive": bool(blend_open_active),
        "cornerActive": bool(corner_active),
        "activeSourceCount": int(active_source_count),
        "score": float(score),
        "sources": sources,
        "reliable": bool(active_source_count >= min_sources),
        "thresholds": {
            "reliableApertureThreshold": float(ap_thr),
            "reliableJawInputThreshold": float(jaw_in_thr),
            "reliableJawScoreThreshold": float(jaw_sc_thr),
            "reliableBlendOpenThreshold": float(blend_thr),
            "reliableCornerOffsetThreshold": float(corner_thr),
            "reliableMinSourceCount": int(min_sources),
        },
    }


def _jaw_open_norm_from_raw(raw_evidence: dict[str, Any]) -> float:
    return float(raw_evidence.get("jawOpenNorm", 0.0))


def _mouth_motion_allowed_for_override(
    raw_evidence: dict[str, Any],
    cfg: dict[str, Any],
    *,
    require_funnel: bool = False,
) -> bool:
    """小 jawOpen / 无 funnel 时不允许任何 mouth override。"""
    ms = _ms_cfg(cfg)
    veto = _safe_float(ms.get("strongMouthVetoJawOpenNorm"), 0.01)
    min_jaw = _safe_float(ms.get("strongJawOpenNormMin"), 0.02)
    jaw = _jaw_open_norm_from_raw(raw_evidence)
    if jaw < veto:
        return False
    if jaw < min_jaw:
        return False
    if require_funnel:
        funnel_thr = _safe_float(ms.get("strongMouthFunnelNormMin"), 0.06)
        if float(raw_evidence.get("mouthFunnelNorm", 0.0)) <= funnel_thr:
            return False
    return True


def compute_strong_mouth_evidence(
    raw_evidence: dict[str, Any],
    reliable_evidence: dict[str, Any],
    cfg: dict[str, Any],
    state: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """强嘴部动作证据：须 score + funnel + jawOpen 同时满足且连续确认，避免误触发 override。"""
    ms = _ms_cfg(cfg)
    enabled = bool(ms.get("strongMouthOverrideEnabled", True))
    score_thr = _safe_float(ms.get("strongMouthScoreMin"), 70.0)
    funnel_thr = _safe_float(ms.get("strongMouthFunnelNormMin"), 0.06)
    jaw_norm_thr = _safe_float(ms.get("strongJawOpenNormMin"), 0.02)
    veto_jaw_norm = _safe_float(ms.get("strongMouthVetoJawOpenNorm"), 0.01)
    confirm_frames = max(1, int(_safe_float(ms.get("strongMouthConfirmFrames"), 3)))
    override_scenario = str(ms.get("strongOverrideScenario") or "frontal_mouth_motion")

    mouth_score = float(raw_evidence.get("score", 0.0))
    jaw_open_norm = float(raw_evidence.get("jawOpenNorm", 0.0))
    mouth_funnel_norm = float(raw_evidence.get("mouthFunnelNorm", 0.0))
    reliable = bool(reliable_evidence.get("reliable"))

    if jaw_open_norm < veto_jaw_norm:
        if state is not None:
            state["strong_mouth_stable_count"] = 0
        return {
            "enabled": bool(enabled),
            "active": False,
            "jawOpenNorm": float(jaw_open_norm),
            "mouthFunnelNorm": float(mouth_funnel_norm),
            "mouthScore": float(mouth_score),
            "stableCount": 0,
            "confirmFrames": int(confirm_frames),
            "overrideScenario": override_scenario,
            "vetoReason": "jaw-open-too-small",
            "thresholds": {
                "strongMouthScoreMin": float(score_thr),
                "strongMouthFunnelNormMin": float(funnel_thr),
                "strongJawOpenNormMin": float(jaw_norm_thr),
                "strongMouthConfirmFrames": int(confirm_frames),
            },
        }

    candidate = bool(
        mouth_score > score_thr
        and mouth_funnel_norm > funnel_thr
        and jaw_open_norm > jaw_norm_thr
        and reliable
    )

    stable_count = 0
    if state is not None:
        if candidate:
            stable_count = int(state.get("strong_mouth_stable_count", 0)) + 1
            state["strong_mouth_stable_count"] = stable_count
        else:
            state["strong_mouth_stable_count"] = 0
            stable_count = 0
    else:
        stable_count = 1 if candidate else 0

    active = bool(enabled and candidate and stable_count >= confirm_frames)
    return {
        "enabled": bool(enabled),
        "active": active,
        "jawOpenNorm": float(jaw_open_norm),
        "mouthFunnelNorm": float(mouth_funnel_norm),
        "mouthScore": float(mouth_score),
        "stableCount": int(stable_count),
        "confirmFrames": int(confirm_frames),
        "overrideScenario": override_scenario,
        "thresholds": {
            "strongMouthScoreMin": float(score_thr),
            "strongMouthFunnelNormMin": float(funnel_thr),
            "strongJawOpenNormMin": float(jaw_norm_thr),
            "strongMouthConfirmFrames": int(confirm_frames),
        },
    }


def compute_raw_mouth_evidence(
    *,
    lip_abs_max: float,
    aperture_abs: float,
    jaw_input_abs: float,
    jaw_score: float,
    blend_mouth_open: float,
    blend_jaw_open: float,
    corner_offset_abs: float,
    jaw_open_norm: float = 0.0,
    mouth_funnel_norm: float = 0.0,
    available: dict[str, bool],
    cfg: dict[str, Any],
) -> dict[str, Any]:
    ms = _ms_cfg(cfg)
    aperture_scale = _safe_float(ms.get("apertureScoreScale"), 300.0)
    aperture_scaled = float(aperture_abs) * aperture_scale
    components = {
        "lipAbsMax": float(lip_abs_max),
        "apertureAbsScaled": float(aperture_scaled),
        "jawScore": float(jaw_score),
        "blendMouthOpen": float(blend_mouth_open),
        "blendJawOpen": float(blend_jaw_open),
        "cornerOffsetAbs": float(corner_offset_abs),
    }
    source = max(components, key=lambda k: components[k]) if components else "lipAbsMax"
    score = float(components.get(source, 0.0))
    return {
        "lipAbsMax": float(lip_abs_max),
        "apertureAbs": float(aperture_abs),
        "apertureAbsScaled": float(aperture_scaled),
        "jawInputAbs": float(jaw_input_abs),
        "jawScore": float(jaw_score),
        "blendMouthOpen": float(blend_mouth_open),
        "blendJawOpen": float(blend_jaw_open),
        "cornerOffsetAbs": float(corner_offset_abs),
        "jawOpenNorm": float(jaw_open_norm),
        "mouthFunnelNorm": float(mouth_funnel_norm),
        "score": float(score),
        "source": str(source),
        "available": dict(available),
    }


def compute_head_motion_evidence(
    *,
    nose_anchor_motion: bool,
    nose_motion_score: float,
    mouth_pose_motion_score: float,
    cfg: dict[str, Any],
) -> dict[str, Any]:
    # nose 为主，mouthPose 仅 0.5 权重辅助，不允许其单独主导。
    score = max(float(nose_motion_score), 0.5 * float(mouth_pose_motion_score))
    reasons: list[str] = []
    if nose_anchor_motion:
        reasons.append("noseAnchorMotion")
    return {
        "noseAnchorMotion": bool(nose_anchor_motion),
        "noseMotionScore": float(nose_motion_score),
        "mouthPoseMotionScore": float(mouth_pose_motion_score),
        "score": float(score),
        "reasons": reasons,
    }


def compute_open_close_evidence(
    raw_evidence: dict[str, Any],
    reliable_evidence: dict[str, Any],
    cfg: dict[str, Any],
) -> dict[str, Any]:
    """连续张闭嘴证据：仅用 raw / pre-gate 信号，且 lipAbsMax 不能单独触发。

    用于在 noseAnchorMotion=true 但确属真实张闭嘴时，否决 Immediate Artifact Lock。
    """
    ms = _ms_cfg(cfg)
    enabled = bool(ms.get("openCloseGuardEnabled", True))
    jaw_input_thr = _safe_float(ms.get("openCloseJawInputThreshold"), 8.0)
    jaw_score_thr = _safe_float(ms.get("openCloseJawScoreThreshold"), 8.0)
    aperture_thr = _safe_float(ms.get("openCloseApertureThreshold"), 8.0)
    blend_thr = _safe_float(ms.get("openCloseBlendOpenThreshold"), 6.0)
    min_sources = max(0, int(_safe_float(ms.get("openCloseMinReliableSources"), 1)))

    jaw_input_abs = float(raw_evidence.get("jawInputAbs", 0.0))
    jaw_score = float(raw_evidence.get("jawScore", 0.0))
    aperture_scaled = float(raw_evidence.get("apertureAbsScaled", 0.0))
    blend_open = max(float(raw_evidence.get("blendMouthOpen", 0.0)), float(raw_evidence.get("blendJawOpen", 0.0)))
    reliable_source_count = int(reliable_evidence.get("activeSourceCount", 0))

    sources: list[str] = []
    if jaw_input_abs >= jaw_input_thr:
        sources.append("jawInput")
    if jaw_score >= jaw_score_thr:
        sources.append("jawScore")
    if aperture_scaled >= aperture_thr:
        sources.append("aperture")
    if blend_open >= blend_thr:
        sources.append("blendOpen")
    if min_sources >= 1 and reliable_source_count >= min_sources:
        sources.append("reliableSources")
    # lipAbsMax 不参与：必须有 jaw / aperture / blend / reliable 之一。
    active = bool(enabled and sources)
    return {
        "enabled": bool(enabled),
        "active": active,
        "jawInputAbs": float(jaw_input_abs),
        "jawScore": float(jaw_score),
        "apertureAbsScaled": float(aperture_scaled),
        "blendOpen": float(blend_open),
        "reliableSourceCount": int(reliable_source_count),
        "sources": sources,
        "thresholds": {
            "openCloseJawInputThreshold": float(jaw_input_thr),
            "openCloseJawScoreThreshold": float(jaw_score_thr),
            "openCloseApertureThreshold": float(aperture_thr),
            "openCloseBlendOpenThreshold": float(blend_thr),
            "openCloseMinReliableSources": int(min_sources),
        },
    }


def compute_immediate_artifact_lock(
    classifier: dict[str, Any],
    cfg: dict[str, Any],
) -> dict[str, Any]:
    """Immediate Artifact Lock：绕过状态机确认延迟，立刻锁住危险帧。

    闭嘴转头时部分帧 candidate 已是 closed_head_turn / reason 已是 lip-only-artifact，
    但 finalScenario 因迟滞仍是 neutral_still，导致 lip 漏出。此函数在 finalScenario gate
    之前判定是否需要立即锁零。
    """
    ms = _ms_cfg(cfg)
    head_on = _safe_float(ms.get("headOnThreshold"), 0.12)
    reason = str((classifier.get("decision") or {}).get("reason", ""))
    candidate = str(classifier.get("candidateScenario", ""))
    final = str(classifier.get("finalScenario", ""))
    head_score = float((classifier.get("headMotionEvidence") or {}).get("score", 0.0))
    raw_source = str((classifier.get("rawMouthEvidence") or {}).get("source", ""))
    reliable = bool((classifier.get("reliableMouthEvidence") or {}).get("reliable"))
    strong_active = bool((classifier.get("strongMouthEvidence") or {}).get("active"))
    lip_only_artifact = bool(classifier.get("lipOnlyArtifact"))
    artifact_lock = bool((classifier.get("immediateArtifactLock") or {}).get("active"))

    raw_mouth_score = float((classifier.get("rawMouthEvidence") or {}).get("score", 0.0))
    soft_mouth_thr = _safe_float(ms.get("artifactLockSoftMouthThreshold"), 30.0)

    lock_reason = ""
    if strong_active and reliable and not lip_only_artifact and not artifact_lock:
        return {
            "active": False,
            "reason": "vetoed-by-strong-mouth",
            "vetoedByOpenCloseGuard": False,
            "vetoedByStrongMouth": True,
            "candidateScenario": candidate,
            "finalScenario": final,
            "headMotionScore": float(head_score),
            "rawMouthSource": raw_source,
            "reliable": bool(reliable),
            "appliedTo": {"lip": False, "jaw": False, "brow": False},
        }
    if (
        final == "frontal_mouth_motion"
        and raw_mouth_score >= soft_mouth_thr
        and not lip_only_artifact
    ):
        return {
            "active": False,
            "reason": "vetoed-by-frontal-strong-mouth",
            "vetoedByOpenCloseGuard": False,
            "vetoedByStrongMouth": False,
            "candidateScenario": candidate,
            "finalScenario": final,
            "headMotionScore": float(head_score),
            "rawMouthSource": raw_source,
            "reliable": bool(reliable),
            "appliedTo": {"lip": False, "jaw": False, "brow": False},
        }
    if reason == "head-motion-lip-only-artifact":
        lock_reason = "decision-lip-only-artifact"
    elif head_score >= head_on and raw_source == "lipAbsMax" and not reliable:
        lock_reason = "head-motion-lip-only"
    elif candidate == "closed_head_turn" and final != "closed_head_turn" and head_score >= head_on and not reliable:
        lock_reason = "candidate-closed-not-final"
    active = bool(lock_reason)

    # Open-Close Guard 优先级高于 Immediate Artifact Lock：连续真实张闭嘴时否决锁定。
    oc_guard = classifier.get("openCloseGuard") or {}
    vetoed = bool(active and oc_guard.get("active") and oc_guard.get("blockImmediateArtifactLock", True))
    if vetoed:
        active = False
        lock_reason = "vetoed-by-open-close-guard"
    # lip-only / head-turn candidate 锁只约束 lip/jaw；眉毛由 brow_gate 独立判断。
    _lip_only_lock_reasons = frozenset(
        {
            "decision-lip-only-artifact",
            "head-motion-lip-only",
            "candidate-closed-not-final",
        }
    )
    apply_brow = bool(active and lock_reason not in _lip_only_lock_reasons)

    return {
        "active": active,
        "reason": lock_reason,
        "vetoedByOpenCloseGuard": bool(vetoed),
        "candidateScenario": candidate,
        "finalScenario": final,
        "headMotionScore": float(head_score),
        "rawMouthSource": raw_source,
        "reliable": bool(reliable),
        "appliedTo": {
            "lip": active,
            "jaw": active,
            "brow": apply_brow,
        },
    }


def classify_mouth_scenario(
    state: dict[str, Any] | None,
    raw_evidence: dict[str, Any],
    head_evidence: dict[str, Any],
    cfg: dict[str, Any],
    *,
    neutral_ready: bool,
    now_ms: float = 0.0,
) -> dict[str, Any]:
    st = state if state is not None else create_mouth_scenario_state()
    ms = _ms_cfg(cfg)

    mouth_on = _safe_float(ms.get("mouthOnThreshold"), 3.5)
    mouth_off = _safe_float(ms.get("mouthOffThreshold"), 1.5)
    head_on = _safe_float(ms.get("headOnThreshold"), 0.12)
    head_off = _safe_float(ms.get("headOffThreshold"), 0.08)
    closed_turn_require_below = _safe_float(ms.get("closedTurnRequireMouthBelow"), 2.2)
    prefer_mouth = bool(ms.get("preferMouthMotionOverHeadMotion", True))

    mouth_score = float(raw_evidence.get("score", 0.0))
    head_score = float(head_evidence.get("score", 0.0))
    nose_motion = bool(head_evidence.get("noseAnchorMotion"))
    raw_source = str(raw_evidence.get("source", ""))

    raw_mouth_active = mouth_score >= mouth_on
    raw_mouth_inactive = mouth_score <= mouth_off
    head_motion_active = (head_score >= head_on) or nose_motion

    prev_head = float(st.get("prev_head_score", head_score))
    head_score_velocity = abs(head_score - prev_head)
    head_vel_thr = _safe_float(ms.get("headScoreVelocityThreshold"), 0.08)
    head_score_stable = bool(head_score_velocity < head_vel_thr)
    st["prev_head_score"] = float(head_score)

    stable_strong_thr = _safe_float(ms.get("stableHeadStrongMouthThreshold"), 18.0)
    stable_raw_thr = _safe_float(ms.get("stableHeadRawMouthThreshold"), 12.0)
    closed_head_turn_mouth_max = _safe_float(ms.get("closedHeadTurnMouthMax"), 8.0)

    reliable_evidence = compute_reliable_mouth_evidence(raw_evidence, cfg)
    reliable = bool(reliable_evidence.get("reliable"))
    if mouth_score >= stable_raw_thr and reliable:
        st["mouth_evidence_hold"] = int(st.get("mouth_evidence_hold", 0)) + 1
    else:
        st["mouth_evidence_hold"] = 0
    mouth_evidence_hold_frames = int(st.get("mouth_evidence_hold", 0))

    strong_evidence = compute_strong_mouth_evidence(raw_evidence, reliable_evidence, cfg, state=st)
    strong_active = bool(strong_evidence.get("active"))

    # ----- Open-Close Guard 状态机（连续张闭嘴保护）-----
    open_close_evidence = compute_open_close_evidence(raw_evidence, reliable_evidence, cfg)
    oc_confirm = max(1, int(_safe_float(ms.get("openCloseConfirmFrames"), 2)))
    oc_hold_frames = max(0, int(_safe_float(ms.get("openCloseHoldFrames"), 8)))
    oc_scenario = str(ms.get("openCloseScenario") or "head_motion_mouth_motion")
    oc_output_scale = _safe_float(ms.get("openCloseOutputScale"), 0.75)
    oc_block_lock = bool(ms.get("openCloseBlockImmediateArtifactLock", True))
    if bool(open_close_evidence.get("active")):
        st["open_close_count"] = int(st.get("open_close_count", 0)) + 1
    else:
        st["open_close_count"] = 0
    if int(st["open_close_count"]) >= oc_confirm:
        st["open_close_hold"] = oc_hold_frames
    open_close_hold = int(st.get("open_close_hold", 0))
    open_close_guard_active = bool(open_close_hold > 0)
    if open_close_hold > 0:
        st["open_close_hold"] = open_close_hold - 1

    current_scenario = str(st.get("current", "neutral_still")) if state is not None else "neutral_still"

    # ----- 候选场景：Strong Mouth Override > Open-Close Guard > head motion -----
    if strong_active:
        candidate = str(strong_evidence.get("overrideScenario") or "frontal_mouth_motion")
        reason = "strong-mouth-override"
    elif open_close_guard_active:
        candidate = oc_scenario
        reason = "open-close-guard-active"
    elif not head_motion_active:
        # 无明显 head motion：lipAbsMax 可作为真实嘴动证据。
        if raw_mouth_active:
            candidate = "frontal_mouth_motion"
            reason = "no-head-motion-mouth-evidence"
        elif raw_mouth_inactive:
            candidate = "neutral_still"
            reason = "neutral-quiet"
        else:
            candidate = current_scenario if current_scenario in _SCENARIOS else "unknown"
            reason = "ambiguous"
    else:
        # 有明显 head motion：稳定 headScore + 嘴部证据 → 正脸嘴动；弱嘴部才 closed_head_turn。
        if head_score_stable and reliable and mouth_score >= stable_strong_thr:
            candidate = "frontal_mouth_motion"
            reason = "stable-head-strong-mouth"
        elif (
            head_score_stable
            and mouth_score >= stable_raw_thr
            and mouth_evidence_hold_frames >= 2
        ):
            candidate = "frontal_mouth_motion"
            reason = "stable-head-mouth-evidence"
        elif reliable and not head_score_stable:
            candidate = "head_motion_mouth_motion"
            reason = "head-motion-reliable-mouth-evidence"
        elif mouth_score < closed_head_turn_mouth_max and mouth_score <= closed_turn_require_below:
            candidate = "closed_head_turn"
            reason = "head-motion-mouth-quiet"
        elif mouth_score >= stable_raw_thr and reliable:
            candidate = "frontal_mouth_motion"
            reason = "stable-head-reliable-mouth"
        else:
            candidate = "closed_head_turn"
            reason = "head-motion-lip-only-artifact" if raw_source == "lipAbsMax" else "head-motion-mouth-quiet"

    # ----- 状态机 + 迟滞 -----
    if not neutral_ready:
        st["current"] = "neutral_still"
        st["candidate"] = None
        st["candidate_count"] = 0
        final_scenario = "neutral_still"
        required = _required_confirm_frames("neutral_still", ms)
    else:
        current = str(st.get("current", "neutral_still"))
        required = _required_confirm_frames(candidate, ms)
        if candidate == current:
            st["candidate"] = None
            st["candidate_count"] = 0
        elif candidate == st.get("candidate"):
            st["candidate_count"] = int(st.get("candidate_count", 0)) + 1
            if int(st["candidate_count"]) >= required:
                st["current"] = candidate
                st["candidate"] = None
                st["candidate_count"] = 0
                st["last_changed_at"] = float(now_ms)
        else:
            st["candidate"] = candidate
            st["candidate_count"] = 1
            if required <= 1:
                st["current"] = candidate
                st["candidate"] = None
                st["candidate_count"] = 0
                st["last_changed_at"] = float(now_ms)
        final_scenario = str(st.get("current", "neutral_still"))

    before_scenario = str(final_scenario)
    lip_only_artifact = bool(reason == "head-motion-lip-only-artifact")
    strong_mouth_override_applied = False
    stable_head_mouth_override = False
    override_reason = None
    strong_score_thr = _safe_float(ms.get("strongMouthScoreThreshold"), mouth_on)

    # Strong mouth + reliable 必须覆盖状态机迟滞留下的 closed_head_turn
    motion_ok = _mouth_motion_allowed_for_override(raw_evidence, cfg, require_funnel=True)
    if strong_active and reliable and not lip_only_artifact and motion_ok:
        strong_mouth_override_applied = True
        if head_motion_active and not head_score_stable:
            final_scenario = "head_motion_mouth_motion"
            override_reason = "strong-mouth-with-head-motion"
            reason = override_reason
        else:
            final_scenario = str(strong_evidence.get("overrideScenario") or "frontal_mouth_motion")
            override_reason = "strong-mouth-override"
            reason = override_reason
        st["current"] = final_scenario
        st["candidate"] = None
        st["candidate_count"] = 0
    elif (
        reliable
        and mouth_score >= strong_score_thr
        and not lip_only_artifact
        and _mouth_motion_allowed_for_override(raw_evidence, cfg)
    ):
        # 保留 closed_head_turn 解除，但不标记 strongMouthOverride
        if final_scenario == "closed_head_turn" and not strong_active:
            if head_motion_active and not head_score_stable:
                final_scenario = "head_motion_mouth_motion"
            else:
                final_scenario = "frontal_mouth_motion"
            override_reason = "reliable-mouth-blocks-closed-turn"
            reason = override_reason
            st["current"] = final_scenario
            st["candidate"] = None
            st["candidate_count"] = 0

    # 稳定 headScore + 连续嘴部证据 → 正脸嘴动（覆盖迟滞留下的 head_motion_mouth_motion）
    if (
        not lip_only_artifact
        and head_motion_active
        and head_score_stable
        and final_scenario in ("head_motion_mouth_motion", "closed_head_turn", "unknown")
        and _mouth_motion_allowed_for_override(raw_evidence, cfg)
    ):
        if reliable and mouth_score >= stable_strong_thr:
            stable_head_mouth_override = True
            final_scenario = "frontal_mouth_motion"
            override_reason = "stable-head-strong-mouth"
            reason = override_reason
            st["current"] = final_scenario
            st["candidate"] = None
            st["candidate_count"] = 0
        elif mouth_score >= stable_raw_thr and mouth_evidence_hold_frames >= 2:
            stable_head_mouth_override = True
            final_scenario = "frontal_mouth_motion"
            override_reason = "stable-head-mouth-evidence"
            reason = override_reason
            st["current"] = final_scenario
            st["candidate"] = None
            st["candidate_count"] = 0

    lip_only_artifact = bool(reason == "head-motion-lip-only-artifact")
    classifier = {
        "rawMouthEvidence": dict(raw_evidence),
        "headMotionEvidence": dict(head_evidence),
        "reliableMouthEvidence": dict(reliable_evidence),
        "strongMouthEvidence": dict(strong_evidence),
        "openCloseEvidence": dict(open_close_evidence),
        "openCloseGuard": {
            "active": bool(open_close_guard_active),
            "count": int(st.get("open_close_count", 0)),
            "hold": int(st.get("open_close_hold", 0)),
            "confirmFrames": int(oc_confirm),
            "holdFrames": int(oc_hold_frames),
            "outputScale": float(oc_output_scale),
            "lipOutputScale": float(_safe_float(ms.get("openCloseLipScale"), 0.85)),
            "jawOutputScale": float(_safe_float(ms.get("openCloseJawScale"), 0.75)),
            "scenario": str(oc_scenario),
            "blockImmediateArtifactLock": bool(oc_block_lock),
        },
        "rawMouthActive": bool(raw_mouth_active),
        "rawMouthInactive": bool(raw_mouth_inactive),
        "headMotionActive": bool(head_motion_active),
        "reliable": bool(reliable),
        "lipOnlyArtifact": lip_only_artifact,
        "candidateScenario": str(candidate),
        "beforeScenario": str(before_scenario),
        "finalScenario": str(final_scenario),
        "strongMouthOverrideApplied": bool(strong_mouth_override_applied),
        "strongMouthOverride": bool(strong_mouth_override_applied),
        "stableHeadMouthOverride": bool(stable_head_mouth_override),
        "openCloseGuardActive": bool(open_close_guard_active),
        "headScoreVelocity": float(head_score_velocity),
        "headScoreStable": bool(head_score_stable),
        "mouthEvidenceHoldFrames": int(mouth_evidence_hold_frames),
        "overrideReason": override_reason,
        "candidateCount": int(st.get("candidate_count", 0)),
        "requiredConfirmFrames": int(required),
        "thresholds": {
            "mouthOnThreshold": float(mouth_on),
            "mouthOffThreshold": float(mouth_off),
            "headOnThreshold": float(head_on),
            "headOffThreshold": float(head_off),
            "closedTurnRequireMouthBelow": float(closed_turn_require_below),
            "closedHeadTurnMouthMax": float(closed_head_turn_mouth_max),
            "headScoreVelocityThreshold": float(head_vel_thr),
            "stableHeadStrongMouthThreshold": float(stable_strong_thr),
            "stableHeadRawMouthThreshold": float(stable_raw_thr),
        },
        "decision": {
            "preferMouthMotionOverHeadMotion": bool(prefer_mouth),
            "reason": str(reason),
        },
        "neutralReady": bool(neutral_ready),
    }
    st["last_debug"] = classifier
    return classifier
