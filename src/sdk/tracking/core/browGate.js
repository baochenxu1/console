/**
 * Brow Scenario Gate — independent artifact gate.
 * Faithful port of tools/tracking_service/brow_gate.py (no DOM).
 */

import { clamp, safeFloat } from "./trackingMath.js"
import { normalizeMappingConfig } from "./mappingConfig.js"

export const BROW_KEYS = Object.freeze([
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
])

const LIP_ONLY_IMMEDIATE_REASONS = new Set([
  "decision-lip-only-artifact",
  "head-motion-lip-only",
])

function zeroAxis() {
  const out = {}
  for (const k of BROW_KEYS) out[k] = 0
  return out
}

function lockedFalse() {
  const out = {}
  for (const k of BROW_KEYS) out[k] = false
  return out
}

export function createBrowState() {
  return {
    prev: zeroAxis(),
    locked_to_zero: lockedFalse(),
    explicit_brow_count: 0,
    explicit_brow_active: false,
    neutral_wait_start_ms: null,
    neutral_fallback: false,
    last_debug: {},
  }
}

export function resetBrowState(state) {
  const fresh = createBrowState()
  if (state && typeof state === "object") {
    for (const k of Object.keys(state)) delete state[k]
    Object.assign(state, fresh)
    return state
  }
  return fresh
}

function cloneBrowState(state) {
  const src = state && typeof state === "object" ? state : createBrowState()
  const prev = src.prev && typeof src.prev === "object" ? src.prev : {}
  const locked = src.locked_to_zero && typeof src.locked_to_zero === "object" ? src.locked_to_zero : {}
  const nextPrev = zeroAxis()
  const nextLocked = lockedFalse()
  for (const k of BROW_KEYS) {
    nextPrev[k] = safeFloat(prev[k], 0)
    nextLocked[k] = Boolean(locked[k])
  }
  return {
    prev: nextPrev,
    locked_to_zero: nextLocked,
    explicit_brow_count: Math.trunc(src.explicit_brow_count || 0),
    explicit_brow_active: Boolean(src.explicit_brow_active),
    neutral_wait_start_ms: src.neutral_wait_start_ms == null ? null : src.neutral_wait_start_ms,
    neutral_fallback: Boolean(src.neutral_fallback),
    last_debug: {},
  }
}

function resolveBrowGateCfg(config) {
  if (config && typeof config === "object" && config.browGate && typeof config.browGate === "object") {
    return normalizeMappingConfig(config).browGate
  }
  if (config && typeof config === "object") {
    return normalizeMappingConfig({ browGate: config }).browGate
  }
  return normalizeMappingConfig(null).browGate
}

function abs3(a, b, c) {
  return Math.max(Math.abs(a), Math.abs(b), Math.abs(c))
}

function browSideFromMapping(rawIn) {
  const bl = {
    tip: Number(rawIn.browLeftTip || 0),
    mid: Number(rawIn.browLeftMid || 0),
    tail: Number(rawIn.browLeftTail || 0),
    inner: Number(rawIn.browInner || 0),
    outer: Number(rawIn.browOuterLeft || 0),
  }
  bl.absMax = abs3(bl.tip, bl.mid, bl.tail)
  const br = {
    tip: Number(rawIn.browRightTip || 0),
    mid: Number(rawIn.browRightMid || 0),
    tail: Number(rawIn.browRightTail || 0),
    inner: Number(rawIn.browInner || 0),
    outer: Number(rawIn.browOuterRight || 0),
  }
  br.absMax = abs3(br.tip, br.mid, br.tail)
  return { browL: bl, browR: br }
}

function normalizeImmediateLock(immediateArtifactLock, evidence) {
  if (immediateArtifactLock && typeof immediateArtifactLock === "object" && !Array.isArray(immediateArtifactLock)) {
    return immediateArtifactLock
  }
  if (evidence.immediateArtifactLock && typeof evidence.immediateArtifactLock === "object") {
    return evidence.immediateArtifactLock
  }
  if (immediateArtifactLock) {
    return { active: true, reason: "legacy-bool", appliedTo: { brow: true } }
  }
  return { active: false, reason: "", appliedTo: { brow: false } }
}

function isLipOnlyImmediate(immediateInfo, classifierReason) {
  const immReason = String(immediateInfo.reason || "")
  if (LIP_ONLY_IMMEDIATE_REASONS.has(immReason)) return true
  if (classifierReason === "head-motion-lip-only-artifact") return true
  return false
}

function immediateAppliesToBrow(immediateInfo) {
  if (!immediateInfo.active) return false
  const applied = immediateInfo.appliedTo
  if (applied && typeof applied === "object" && "brow" in applied) {
    return Boolean(applied.brow)
  }
  return false
}

/**
 * @param {object} args
 * @param {Record<string, number>} args.browValues
 * @param {string} args.finalScenario
 * @param {string} args.decisionReason
 * @param {object} [args.evidence]
 * @param {object} [args.config] full mapping config or browGate section
 * @param {object} [args.state]
 * @param {object|boolean} [args.immediateArtifactLock]
 * @returns {{ gatedValues: Record<string, number>, debug: object, nextState: object }}
 */
export function applyBrowGate({
  browValues,
  finalScenario,
  decisionReason,
  evidence,
  config,
  state,
  immediateArtifactLock = false,
} = {}) {
  const st = cloneBrowState(state)
  const bg = resolveBrowGateCfg(config)
  const ev = evidence && typeof evidence === "object" ? evidence : {}
  const enabled = bg.enabled !== false

  const lockOnHead = bg.lockOnHeadMotionLikely !== false
  const suppressMouthFlag = bg.suppressDuringMouthMotion !== false
  const minQuality = safeFloat(bg.browMinQuality, 0.5)
  const headScoreThr = safeFloat(bg.browHeadMotionScoreThreshold, 0.08)
  const mouthScoreThr = safeFloat(bg.browMouthMotionScoreThreshold, 3.5)
  const onThr = safeFloat(bg.browRawOnThreshold, 14)
  const strongThr = safeFloat(bg.browRawStrongThreshold, 24)
  const offThr = safeFloat(bg.browRawOffThreshold, 6)
  const confirm = Math.max(1, Math.trunc(safeFloat(bg.browConfirmFrames, 4)))
  const allowExplicitLip = bg.allowExplicitBrowDuringLipArtifact !== false
  const allowExplicitMildHead = bg.allowExplicitBrowDuringMildHeadMotion !== false
  const lockImmediateWeak = bg.lockBrowOnImmediateArtifactOnlyWhenWeak !== false
  const mouthScale = clamp(safeFloat(bg.mouthMotionSuppressScale, 0.15), 0, 1)
  const headScale = clamp(safeFloat(bg.headMotionSuppressScale, 0.25), 0, 1)
  const snapZero = Math.max(0, safeFloat(bg.snapToZero, 2.5))
  const deadband = Math.max(0, safeFloat(bg.outputDeadband, 5))
  const resetPrevOnLock = bg.resetPrevOnLock !== false
  const neutralFallbackMs = Math.max(500, safeFloat(bg.neutralFallbackMs, 2000))

  const scenario = String(finalScenario || "neutral_still")
  const reason = String(decisionReason || "")

  const rawIn = {}
  let browAbsMax = 0
  const srcValues = browValues && typeof browValues === "object" ? browValues : {}
  for (const k of BROW_KEYS) {
    rawIn[k] = Number(srcValues[k] || 0) || 0
    if (!Number.isFinite(rawIn[k])) rawIn[k] = 0
    browAbsMax = Math.max(browAbsMax, Math.abs(rawIn[k]))
  }

  let timestampMs = safeFloat(ev.timestampMs, 0)
  if (timestampMs <= 0) timestampMs = Date.now()

  const noseMotionActive = Boolean(ev.noseAnchorMotion)
  const headMotionScore = safeFloat(ev.headMotionScore, 0)
  const oldMouthPoseHead = Boolean(ev.oldMouthPoseHeadMotionActive)
  const poseGateActive = Boolean(ev.poseGateActive)
  const rawMouthScore = safeFloat(ev.rawMouthScore, 0)
  const strongMouthActive = Boolean(ev.strongMouthActive)
  const jawAbs = safeFloat(ev.jawAbs, 0)
  const jawInputAbs = safeFloat(ev.jawInputAbs, 0)
  const lipAbsMax = safeFloat(ev.lipAbsMax, 0)
  const noseNeutralReady = ev.noseNeutralReady == null ? true : Boolean(ev.noseNeutralReady)
  const lipNeutralReady = ev.lipNeutralReady == null ? true : Boolean(ev.lipNeutralReady)
  const jawNeutralReady = ev.jawNeutralReady == null ? true : Boolean(ev.jawNeutralReady)
  const faceDetected = ev.faceDetected == null ? true : Boolean(ev.faceDetected)
  const quality = safeFloat(ev.quality, 1)
  const browNeutralReady = Boolean(noseNeutralReady && lipNeutralReady && jawNeutralReady)

  const neutralReadyDetails = {
    nose: Boolean(noseNeutralReady),
    lip: Boolean(lipNeutralReady),
    jaw: Boolean(jawNeutralReady),
  }
  const neutralCount = Object.values(neutralReadyDetails).filter(Boolean).length
  const neutralRequired = 3

  let neutralFallback = Boolean(st.neutral_fallback)
  let browNeutralEffective
  if (browNeutralReady) {
    st.neutral_wait_start_ms = null
    st.neutral_fallback = false
    neutralFallback = false
    browNeutralEffective = true
  } else {
    if (st.neutral_wait_start_ms == null && faceDetected) {
      st.neutral_wait_start_ms = timestampMs
    }
    const waitStart = Number(st.neutral_wait_start_ms || timestampMs)
    const elapsed = Math.max(0, timestampMs - waitStart)
    if (faceDetected && quality >= minQuality && elapsed >= neutralFallbackMs) {
      neutralFallback = true
      st.neutral_fallback = true
      browNeutralEffective = true
    } else {
      browNeutralEffective = false
    }
  }

  const headMotionMild = Boolean(
    noseMotionActive ||
      headMotionScore >= headScoreThr ||
      oldMouthPoseHead ||
      poseGateActive ||
      scenario === "head_motion_mouth_motion",
  )
  const headLockZero = Boolean(
    lockOnHead && (scenario === "closed_head_turn" || reason === "head-motion-lip-only-artifact"),
  )
  const headMotionLikely = Boolean(headMotionMild || headLockZero)

  const mouthMotionLikely = Boolean(
    scenario === "frontal_mouth_motion" ||
      scenario === "head_motion_mouth_motion" ||
      rawMouthScore >= mouthScoreThr ||
      strongMouthActive ||
      jawAbs >= mouthScoreThr ||
      jawInputAbs >= mouthScoreThr ||
      lipAbsMax >= mouthScoreThr,
  )
  const browSafePose = Boolean(
    browNeutralEffective && !headLockZero && !mouthMotionLikely && faceDetected && quality >= minQuality,
  )

  let count = Math.trunc(st.explicit_brow_count || 0)
  if (faceDetected && quality >= minQuality && browAbsMax >= onThr) {
    count += 1
  } else if (browAbsMax <= offThr) {
    count = 0
  }
  st.explicit_brow_count = count
  let explicitActive = count >= confirm
  st.explicit_brow_active = Boolean(explicitActive)

  const immediateInfo = normalizeImmediateLock(immediateArtifactLock, ev)
  const immediateActive = Boolean(immediateInfo.active)
  const immediateReason = String(immediateInfo.reason || "")
  const lipOnlyImmediate = isLipOnlyImmediate(immediateInfo, reason)
  const immediateAppliesBrow = immediateAppliesToBrow(immediateInfo)

  const browStrongEvidence = Boolean(
    browAbsMax >= onThr && explicitActive && faceDetected && quality >= minQuality,
  )
  const browVeryStrong = Boolean(browAbsMax >= strongThr && count >= Math.max(2, Math.trunc(confirm / 2)))

  const browArtifactLock = Boolean(
    immediateAppliesBrow &&
      immediateActive &&
      lockImmediateWeak &&
      !explicitActive &&
      browAbsMax < onThr,
  )

  let locked = false
  let scale = 1
  let resetPrev = false
  let gateAction
  let decision

  if (!enabled) {
    gateAction = "disabled"
    decision = "disabled"
  } else if (!browNeutralEffective) {
    locked = true
    resetPrev = true
    gateAction = "lock_zero"
    decision = "neutral-not-ready"
    count = 0
    st.explicit_brow_count = 0
    explicitActive = false
    st.explicit_brow_active = false
  } else if (
    lipOnlyImmediate &&
    immediateActive &&
    allowExplicitLip &&
    explicitActive &&
    browAbsMax >= onThr
  ) {
    scale = 1
    gateAction = "pass_explicit_lip_artifact_override"
    decision = "explicit-brow-overrides-lip-artifact"
  } else if (lipOnlyImmediate && immediateActive) {
    if (browAbsMax <= offThr) {
      locked = true
      gateAction = "suppress_lip_artifact_weak_brow"
      decision = "lip-artifact-weak-brow-lock"
    } else {
      scale = mouthScale
      gateAction = "suppress_lip_artifact_weak_brow"
      decision = "lip-artifact-weak-brow-suppress"
    }
  } else if (browArtifactLock) {
    locked = true
    resetPrev = true
    gateAction = "lock_brow_artifact"
    decision = "brow-artifact-lock"
  } else if (headLockZero && !explicitActive) {
    locked = true
    resetPrev = true
    gateAction = "lock_zero"
    decision = "head-motion-weak-brow"
  } else if (headLockZero && explicitActive) {
    if (allowExplicitMildHead && browVeryStrong) {
      scale = 1
      gateAction = "pass_explicit"
      decision = "explicit-brow-during-head-motion"
    } else if (browVeryStrong || (browAbsMax >= strongThr && count >= confirm)) {
      scale = 1
      gateAction = "pass_explicit"
      decision = "explicit-brow-during-head-motion"
    } else if (browAbsMax < strongThr) {
      scale = headScale > 0 ? headScale : mouthScale
      gateAction = "suppress_head"
      decision = "head-motion-mild-brow"
    } else {
      scale = Math.max(headScale, mouthScale, 0.55)
      gateAction = "pass_explicit_attenuated"
      decision = "explicit-brow-attenuated-head-motion"
    }
  } else if (mouthMotionLikely && !explicitActive && suppressMouthFlag) {
    scale = mouthScale
    gateAction = "suppress_mouth"
    decision = "mouth-motion-suppress"
  } else if (explicitActive) {
    if (browVeryStrong || (browAbsMax >= strongThr && count >= confirm)) {
      scale = 1
      gateAction = "pass_explicit"
      decision = "pass-explicit"
    } else {
      scale = Math.max(mouthScale, headScale, 0.55)
      gateAction = "pass_explicit_attenuated"
      decision = "pass-explicit-attenuated"
    }
    if (mouthMotionLikely && suppressMouthFlag && browAbsMax < strongThr) {
      scale = Math.max(mouthScale, headScale)
      decision = "pass-explicit-mouth-attenuated"
    }
  } else if (headMotionMild && headScale < 1) {
    scale = headScale
    gateAction = "suppress_head"
    decision = "head-motion-suppress"
  } else {
    scale = 1
    gateAction = "normal"
    decision = "normal"
  }

  const out = {}
  if (locked) {
    for (const k of BROW_KEYS) {
      out[k] = 0
      st.locked_to_zero[k] = true
    }
    if (resetPrevOnLock && resetPrev) {
      st.prev = zeroAxis()
    }
  } else {
    for (const k of BROW_KEYS) {
      st.locked_to_zero[k] = false
      let val = rawIn[k] * scale
      if (Math.abs(val) < deadband) val = 0
      if (Math.abs(val) < snapZero && Math.abs(safeFloat(st.prev[k], 0)) < snapZero) val = 0
      st.prev[k] = val
      out[k] = val
    }
  }

  const rawSides = browSideFromMapping(rawIn)
  const finalSides = browSideFromMapping(out)

  const debug = {
    enabled: Boolean(enabled),
    finalScenario: scenario,
    decisionReason: decision,
    classifierReason: reason,
    immediateArtifactLock: Boolean(immediateActive),
    immediateArtifactReason: immediateReason,
    immediateArtifactAppliesToBrow: Boolean(immediateAppliesBrow),
    lipOnlyImmediateArtifact: Boolean(lipOnlyImmediate),
    browArtifactLock: Boolean(browArtifactLock),
    browStrongEvidence: Boolean(browStrongEvidence),
    browVeryStrongEvidence: Boolean(browVeryStrong),
    neutralReady: Boolean(browNeutralEffective),
    neutralReadyRaw: Boolean(browNeutralReady),
    neutralFallback: Boolean(neutralFallback),
    neutralWaitMs: Math.max(0, timestampMs - Number(st.neutral_wait_start_ms || timestampMs)),
    neutralCount,
    neutralRequired,
    neutralReadyDetails,
    headMotionLikely: Boolean(headMotionLikely),
    headMotionMild: Boolean(headMotionMild),
    headLockZero: Boolean(headLockZero),
    mouthMotionLikely: Boolean(mouthMotionLikely),
    browSafePose: Boolean(browSafePose),
    browAbsMax,
    explicitBrowActive: Boolean(explicitActive),
    explicitBrowCount: count,
    gateAction,
    outputScale: scale,
    suppressScale: scale,
    outputDeadband: deadband,
    snapToZero: snapZero,
    resetPrevOnLock: Boolean(resetPrevOnLock),
    evidence: {
      noseAnchorMotion: Boolean(noseMotionActive),
      headMotionScore,
      oldMouthPoseHeadMotionActive: Boolean(oldMouthPoseHead),
      poseGateActive: Boolean(poseGateActive),
      rawMouthScore,
      strongMouthActive: Boolean(strongMouthActive),
      jawAbs,
      jawInputAbs,
      lipAbsMax,
      quality,
      faceDetected: Boolean(faceDetected),
    },
    thresholds: {
      browHeadMotionScoreThreshold: headScoreThr,
      browMouthMotionScoreThreshold: mouthScoreThr,
      browRawOnThreshold: onThr,
      browRawStrongThreshold: strongThr,
      browRawOffThreshold: offThr,
      browConfirmFrames: confirm,
      browMinQuality: minQuality,
      neutralFallbackMs,
    },
    before: { ...rawIn },
    after: { ...out },
    raw: rawSides,
    final: finalSides,
  }
  st.last_debug = debug
  return { gatedValues: out, debug, nextState: st }
}
