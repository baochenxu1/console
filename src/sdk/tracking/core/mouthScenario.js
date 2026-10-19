/**
 * Mouth Scenario Classifier V2 — Evidence First.
 * Faithful port of tools/tracking_service/mouth_scenario.py
 */

import { safeFloat } from "./trackingMath.js"
import { cloneDeepPlain } from "./geomMath.js"

const SCENARIOS = [
  "neutral_still",
  "closed_head_turn",
  "frontal_mouth_motion",
  "head_motion_mouth_motion",
  "unknown",
]

const DEFAULT_MOUTH_SCENARIO = Object.freeze({
  frontalMouthMotionThreshold: 4.0,
  neutralThreshold: 2.0,
  mouthOnThreshold: 3.5,
  mouthOffThreshold: 1.5,
  headOnThreshold: 0.12,
  headOffThreshold: 0.08,
  closedTurnRequireMouthBelow: 2.2,
  frontalConfirmFrames: 2,
  closedTurnConfirmFrames: 3,
  neutralConfirmFrames: 5,
  preferMouthMotionOverHeadMotion: true,
  apertureScoreScale: 300.0,
  reliableApertureThreshold: 12.0,
  reliableJawInputThreshold: 12.0,
  reliableJawScoreThreshold: 12.0,
  reliableBlendOpenThreshold: 8.0,
  reliableCornerOffsetThreshold: 10.0,
  reliableMinSourceCount: 2,
  headMotionMouthSuppressScale: 0.95,
  headMotionLipSuppressScale: 0.95,
  headMotionJawSuppressScale: 0.85,
  headMotionMouthLipScale: 0.95,
  headMotionMouthJawScale: 0.85,
  artifactLockSoftMouthThreshold: 30.0,
  artifactLockSoftLipScale: 0.75,
  artifactLockSoftJawScale: 0.65,
  headScoreVelocityThreshold: 0.08,
  stableHeadStrongMouthThreshold: 18.0,
  stableHeadRawMouthThreshold: 12.0,
  closedHeadTurnMouthMax: 8.0,
  strongMouthOverrideEnabled: true,
  strongMouthScoreMin: 70,
  strongMouthFunnelNormMin: 0.06,
  strongJawOpenNormMin: 0.02,
  strongMouthVetoJawOpenNorm: 0.01,
  strongMouthConfirmFrames: 3,
  strongMouthScoreThreshold: 12.0,
  strongJawScoreThreshold: 45.0,
  strongJawInputThreshold: 45.0,
  strongApertureThreshold: 35.0,
  strongBlendOpenThreshold: 18.0,
  strongReliableSourceCount: 3,
  strongOverrideScenario: "frontal_mouth_motion",
  openCloseGuardEnabled: true,
  openCloseJawInputThreshold: 8.0,
  openCloseJawScoreThreshold: 8.0,
  openCloseApertureThreshold: 8.0,
  openCloseBlendOpenThreshold: 6.0,
  openCloseMinReliableSources: 1,
  openCloseConfirmFrames: 2,
  openCloseHoldFrames: 8,
  openCloseBlockImmediateArtifactLock: true,
  openCloseScenario: "frontal_mouth_motion",
  openCloseOutputScale: 0.75,
  openCloseLipScale: 0.85,
  openCloseJawScale: 0.75,
})

const BOOL_KEYS = new Set([
  "preferMouthMotionOverHeadMotion",
  "strongMouthOverrideEnabled",
  "openCloseGuardEnabled",
  "openCloseBlockImmediateArtifactLock",
])
const STR_KEYS = new Set(["strongOverrideScenario", "openCloseScenario"])

export function createMouthScenarioState() {
  return {
    current: "neutral_still",
    candidate: null,
    candidate_count: 0,
    last_changed_at: 0,
    open_close_count: 0,
    open_close_hold: 0,
    prev_head_score: 0,
    mouth_evidence_hold: 0,
    strong_mouth_stable_count: 0,
    last_debug: {},
  }
}

export function resetMouthScenarioState(state) {
  const fresh = createMouthScenarioState()
  if (state && typeof state === "object") {
    for (const k of Object.keys(state)) delete state[k]
    Object.assign(state, fresh)
    return state
  }
  return fresh
}

function cloneScenarioState(state) {
  const src = state && typeof state === "object" ? state : createMouthScenarioState()
  return cloneDeepPlain(src)
}

export function normalizeMouthScenarioConfig(raw) {
  const base = { ...DEFAULT_MOUTH_SCENARIO }
  if (!raw || typeof raw !== "object") return base
  for (const [k, v] of Object.entries(DEFAULT_MOUTH_SCENARIO)) {
    if (BOOL_KEYS.has(k)) base[k] = raw[k] == null ? Boolean(v) : Boolean(raw[k])
    else if (STR_KEYS.has(k)) {
      const cand = raw[k]
      base[k] = cand == null || cand === "" ? String(v) : String(cand)
    } else base[k] = safeFloat(raw[k], v)
  }
  return base
}

function msCfg(cfg) {
  if (cfg && typeof cfg === "object" && cfg.mouthScenario && typeof cfg.mouthScenario === "object") {
    return normalizeMouthScenarioConfig(cfg.mouthScenario)
  }
  if (cfg && typeof cfg === "object" && ("mouthOnThreshold" in cfg || "headOnThreshold" in cfg)) {
    return normalizeMouthScenarioConfig(cfg)
  }
  return normalizeMouthScenarioConfig(null)
}

function requiredConfirmFrames(scenario, ms) {
  if (scenario === "frontal_mouth_motion" || scenario === "head_motion_mouth_motion") {
    return Math.max(1, Math.trunc(safeFloat(ms.frontalConfirmFrames, 2)))
  }
  if (scenario === "closed_head_turn") {
    return Math.max(1, Math.trunc(safeFloat(ms.closedTurnConfirmFrames, 3)))
  }
  if (scenario === "neutral_still") {
    return Math.max(1, Math.trunc(safeFloat(ms.neutralConfirmFrames, 5)))
  }
  return 2
}

export function computeReliableMouthEvidence(rawEvidence, cfg) {
  const ms = msCfg(cfg)
  const apThr = safeFloat(ms.reliableApertureThreshold, 12)
  const jawInThr = safeFloat(ms.reliableJawInputThreshold, 12)
  const jawScThr = safeFloat(ms.reliableJawScoreThreshold, 12)
  const blendThr = safeFloat(ms.reliableBlendOpenThreshold, 8)
  const cornerThr = safeFloat(ms.reliableCornerOffsetThreshold, 10)
  const minSources = Math.max(1, Math.trunc(safeFloat(ms.reliableMinSourceCount, 2)))

  const apertureScaled = Number(rawEvidence.apertureAbsScaled || 0)
  const jawInputAbs = Number(rawEvidence.jawInputAbs || 0)
  const jawScore = Number(rawEvidence.jawScore || 0)
  const blendOpen = Math.max(Number(rawEvidence.blendMouthOpen || 0), Number(rawEvidence.blendJawOpen || 0))
  const cornerOffset = Number(rawEvidence.cornerOffsetAbs || 0)

  const sources = []
  if (apertureScaled >= apThr) sources.push("aperture")
  if (jawInputAbs >= jawInThr) sources.push("jawInput")
  if (jawScore >= jawScThr) sources.push("jawScore")
  if (blendOpen >= blendThr) sources.push("blendOpen")
  if (cornerOffset >= cornerThr) sources.push("corner")

  return {
    apertureActive: apertureScaled >= apThr,
    jawInputActive: jawInputAbs >= jawInThr,
    jawScoreActive: jawScore >= jawScThr,
    blendOpenActive: blendOpen >= blendThr,
    cornerActive: cornerOffset >= cornerThr,
    activeSourceCount: sources.length,
    score: Math.max(apertureScaled, jawInputAbs, jawScore, Number(rawEvidence.blendMouthOpen || 0), Number(rawEvidence.blendJawOpen || 0), cornerOffset),
    sources,
    reliable: sources.length >= minSources,
    thresholds: {
      reliableApertureThreshold: apThr,
      reliableJawInputThreshold: jawInThr,
      reliableJawScoreThreshold: jawScThr,
      reliableBlendOpenThreshold: blendThr,
      reliableCornerOffsetThreshold: cornerThr,
      reliableMinSourceCount: minSources,
    },
  }
}

function mouthMotionAllowedForOverride(rawEvidence, cfg, requireFunnel = false) {
  const ms = msCfg(cfg)
  const veto = safeFloat(ms.strongMouthVetoJawOpenNorm, 0.01)
  const minJaw = safeFloat(ms.strongJawOpenNormMin, 0.02)
  const jaw = Number(rawEvidence.jawOpenNorm || 0)
  if (jaw < veto) return false
  if (jaw < minJaw) return false
  if (requireFunnel) {
    const funnelThr = safeFloat(ms.strongMouthFunnelNormMin, 0.06)
    if (Number(rawEvidence.mouthFunnelNorm || 0) <= funnelThr) return false
  }
  return true
}

export function computeStrongMouthEvidence(rawEvidence, reliableEvidence, cfg, state) {
  const ms = msCfg(cfg)
  const enabled = ms.strongMouthOverrideEnabled !== false
  const scoreThr = safeFloat(ms.strongMouthScoreMin, 70)
  const funnelThr = safeFloat(ms.strongMouthFunnelNormMin, 0.06)
  const jawNormThr = safeFloat(ms.strongJawOpenNormMin, 0.02)
  const vetoJawNorm = safeFloat(ms.strongMouthVetoJawOpenNorm, 0.01)
  const confirmFrames = Math.max(1, Math.trunc(safeFloat(ms.strongMouthConfirmFrames, 3)))
  const overrideScenario = String(ms.strongOverrideScenario || "frontal_mouth_motion")

  const mouthScore = Number(rawEvidence.score || 0)
  const jawOpenNorm = Number(rawEvidence.jawOpenNorm || 0)
  const mouthFunnelNorm = Number(rawEvidence.mouthFunnelNorm || 0)
  const reliable = Boolean(reliableEvidence.reliable)

  const empty = (vetoReason, stableCount) => ({
    enabled,
    active: false,
    jawOpenNorm,
    mouthFunnelNorm,
    mouthScore,
    stableCount,
    confirmFrames,
    overrideScenario,
    vetoReason,
    thresholds: {
      strongMouthScoreMin: scoreThr,
      strongMouthFunnelNormMin: funnelThr,
      strongJawOpenNormMin: jawNormThr,
      strongMouthConfirmFrames: confirmFrames,
    },
  })

  if (jawOpenNorm < vetoJawNorm) {
    if (state) state.strong_mouth_stable_count = 0
    return empty("jaw-open-too-small", 0)
  }

  const candidate = Boolean(
    mouthScore > scoreThr && mouthFunnelNorm > funnelThr && jawOpenNorm > jawNormThr && reliable,
  )
  let stableCount = 0
  if (state) {
    if (candidate) {
      stableCount = Math.trunc(state.strong_mouth_stable_count || 0) + 1
      state.strong_mouth_stable_count = stableCount
    } else {
      state.strong_mouth_stable_count = 0
      stableCount = 0
    }
  } else {
    stableCount = candidate ? 1 : 0
  }

  return {
    enabled,
    active: Boolean(enabled && candidate && stableCount >= confirmFrames),
    jawOpenNorm,
    mouthFunnelNorm,
    mouthScore,
    stableCount,
    confirmFrames,
    overrideScenario,
    thresholds: {
      strongMouthScoreMin: scoreThr,
      strongMouthFunnelNormMin: funnelThr,
      strongJawOpenNormMin: jawNormThr,
      strongMouthConfirmFrames: confirmFrames,
    },
  }
}

export function computeRawMouthEvidence({
  lipAbsMax,
  apertureAbs,
  jawInputAbs,
  jawScore,
  blendMouthOpen,
  blendJawOpen,
  cornerOffsetAbs,
  jawOpenNorm = 0,
  mouthFunnelNorm = 0,
  available = {},
  config,
} = {}) {
  const ms = msCfg(config)
  const apertureScale = safeFloat(ms.apertureScoreScale, 300)
  const apertureAbsScaled = Number(apertureAbs || 0) * apertureScale
  const components = {
    lipAbsMax: Number(lipAbsMax || 0),
    apertureAbsScaled,
    jawScore: Number(jawScore || 0),
    blendMouthOpen: Number(blendMouthOpen || 0),
    blendJawOpen: Number(blendJawOpen || 0),
    cornerOffsetAbs: Number(cornerOffsetAbs || 0),
  }
  let source = "lipAbsMax"
  let score = 0
  for (const [k, v] of Object.entries(components)) {
    if (v >= score) {
      score = v
      source = k
    }
  }
  return {
    lipAbsMax: components.lipAbsMax,
    apertureAbs: Number(apertureAbs || 0),
    apertureAbsScaled,
    jawInputAbs: Number(jawInputAbs || 0),
    jawScore: components.jawScore,
    blendMouthOpen: components.blendMouthOpen,
    blendJawOpen: components.blendJawOpen,
    cornerOffsetAbs: components.cornerOffsetAbs,
    jawOpenNorm: Number(jawOpenNorm || 0),
    mouthFunnelNorm: Number(mouthFunnelNorm || 0),
    score,
    source,
    available: { ...available },
  }
}

export function computeHeadMotionEvidence({
  noseAnchorMotion = false,
  noseMotionScore = 0,
  mouthPoseMotionScore = 0,
} = {}) {
  const score = Math.max(Number(noseMotionScore || 0), 0.5 * Number(mouthPoseMotionScore || 0))
  const reasons = []
  if (noseAnchorMotion) reasons.push("noseAnchorMotion")
  return {
    noseAnchorMotion: Boolean(noseAnchorMotion),
    noseMotionScore: Number(noseMotionScore || 0),
    mouthPoseMotionScore: Number(mouthPoseMotionScore || 0),
    score,
    reasons,
  }
}

export function computeOpenCloseEvidence(rawEvidence, reliableEvidence, cfg) {
  const ms = msCfg(cfg)
  const enabled = ms.openCloseGuardEnabled !== false
  const jawInputThr = safeFloat(ms.openCloseJawInputThreshold, 8)
  const jawScoreThr = safeFloat(ms.openCloseJawScoreThreshold, 8)
  const apertureThr = safeFloat(ms.openCloseApertureThreshold, 8)
  const blendThr = safeFloat(ms.openCloseBlendOpenThreshold, 6)
  const minSources = Math.max(0, Math.trunc(safeFloat(ms.openCloseMinReliableSources, 1)))

  const jawInputAbs = Number(rawEvidence.jawInputAbs || 0)
  const jawScore = Number(rawEvidence.jawScore || 0)
  const apertureScaled = Number(rawEvidence.apertureAbsScaled || 0)
  const blendOpen = Math.max(Number(rawEvidence.blendMouthOpen || 0), Number(rawEvidence.blendJawOpen || 0))
  const reliableSourceCount = Math.trunc(reliableEvidence.activeSourceCount || 0)

  const sources = []
  if (jawInputAbs >= jawInputThr) sources.push("jawInput")
  if (jawScore >= jawScoreThr) sources.push("jawScore")
  if (apertureScaled >= apertureThr) sources.push("aperture")
  if (blendOpen >= blendThr) sources.push("blendOpen")
  if (minSources >= 1 && reliableSourceCount >= minSources) sources.push("reliableSources")

  return {
    enabled,
    active: Boolean(enabled && sources.length),
    jawInputAbs,
    jawScore,
    apertureAbsScaled: apertureScaled,
    blendOpen,
    reliableSourceCount,
    sources,
    thresholds: {
      openCloseJawInputThreshold: jawInputThr,
      openCloseJawScoreThreshold: jawScoreThr,
      openCloseApertureThreshold: apertureThr,
      openCloseBlendOpenThreshold: blendThr,
      openCloseMinReliableSources: minSources,
    },
  }
}

export function computeImmediateArtifactLock(classifier, cfg) {
  const ms = msCfg(cfg)
  const headOn = safeFloat(ms.headOnThreshold, 0.12)
  const reason = String(classifier?.decision?.reason || "")
  const candidate = String(classifier?.candidateScenario || "")
  const final = String(classifier?.finalScenario || "")
  const headScore = Number(classifier?.headMotionEvidence?.score || 0)
  const rawSource = String(classifier?.rawMouthEvidence?.source || "")
  const reliable = Boolean(classifier?.reliableMouthEvidence?.reliable)
  const strongActive = Boolean(classifier?.strongMouthEvidence?.active)
  const lipOnlyArtifact = Boolean(classifier?.lipOnlyArtifact)
  const artifactLock = Boolean(classifier?.immediateArtifactLock?.active)
  const rawMouthScore = Number(classifier?.rawMouthEvidence?.score || 0)
  const softMouthThr = safeFloat(ms.artifactLockSoftMouthThreshold, 30)

  const none = (lockReason, extra = {}) => ({
    active: false,
    reason: lockReason,
    vetoedByOpenCloseGuard: false,
    candidateScenario: candidate,
    finalScenario: final,
    headMotionScore: headScore,
    rawMouthSource: rawSource,
    reliable,
    appliedTo: { lip: false, jaw: false, brow: false },
    ...extra,
  })

  if (strongActive && reliable && !lipOnlyArtifact && !artifactLock) {
    return none("vetoed-by-strong-mouth", { vetoedByStrongMouth: true })
  }
  if (final === "frontal_mouth_motion" && rawMouthScore >= softMouthThr && !lipOnlyArtifact) {
    return none("vetoed-by-frontal-strong-mouth", { vetoedByStrongMouth: false })
  }

  let lockReason = ""
  if (reason === "head-motion-lip-only-artifact") lockReason = "decision-lip-only-artifact"
  else if (headScore >= headOn && rawSource === "lipAbsMax" && !reliable) lockReason = "head-motion-lip-only"
  else if (candidate === "closed_head_turn" && final !== "closed_head_turn" && headScore >= headOn && !reliable) {
    lockReason = "candidate-closed-not-final"
  }
  let active = Boolean(lockReason)

  const ocGuard = classifier?.openCloseGuard || {}
  const vetoed = Boolean(active && ocGuard.active && ocGuard.blockImmediateArtifactLock !== false)
  if (vetoed) {
    active = false
    lockReason = "vetoed-by-open-close-guard"
  }
  const lipOnlyLockReasons = new Set([
    "decision-lip-only-artifact",
    "head-motion-lip-only",
    "candidate-closed-not-final",
  ])
  const applyBrow = Boolean(active && !lipOnlyLockReasons.has(lockReason))
  return {
    active,
    reason: lockReason,
    vetoedByOpenCloseGuard: Boolean(vetoed),
    candidateScenario: candidate,
    finalScenario: final,
    headMotionScore: headScore,
    rawMouthSource: rawSource,
    reliable,
    appliedTo: { lip: active, jaw: active, brow: applyBrow },
  }
}

/**
 * @returns {{ classifier: object, nextState: object }}
 */
export function classifyMouthScenario({
  state,
  rawEvidence,
  headEvidence,
  config,
  neutralReady = false,
  nowMs = 0,
} = {}) {
  const st = cloneScenarioState(state)
  const ms = msCfg(config)
  const mouthOn = safeFloat(ms.mouthOnThreshold, 3.5)
  const mouthOff = safeFloat(ms.mouthOffThreshold, 1.5)
  const headOn = safeFloat(ms.headOnThreshold, 0.12)
  const closedTurnRequireBelow = safeFloat(ms.closedTurnRequireMouthBelow, 2.2)
  const preferMouth = ms.preferMouthMotionOverHeadMotion !== false

  const mouthScore = Number(rawEvidence?.score || 0)
  const headScore = Number(headEvidence?.score || 0)
  const noseMotion = Boolean(headEvidence?.noseAnchorMotion)
  const rawSource = String(rawEvidence?.source || "")

  const rawMouthActive = mouthScore >= mouthOn
  const rawMouthInactive = mouthScore <= mouthOff
  const headMotionActive = headScore >= headOn || noseMotion

  const prevHead = Number(st.prev_head_score ?? headScore)
  const headScoreVelocity = Math.abs(headScore - prevHead)
  const headVelThr = safeFloat(ms.headScoreVelocityThreshold, 0.08)
  const headScoreStable = headScoreVelocity < headVelThr
  st.prev_head_score = headScore

  const stableStrongThr = safeFloat(ms.stableHeadStrongMouthThreshold, 18)
  const stableRawThr = safeFloat(ms.stableHeadRawMouthThreshold, 12)
  const closedHeadTurnMouthMax = safeFloat(ms.closedHeadTurnMouthMax, 8)

  const reliableEvidence = computeReliableMouthEvidence(rawEvidence || {}, config)
  const reliable = Boolean(reliableEvidence.reliable)
  if (mouthScore >= stableRawThr && reliable) st.mouth_evidence_hold = Math.trunc(st.mouth_evidence_hold || 0) + 1
  else st.mouth_evidence_hold = 0
  const mouthEvidenceHoldFrames = Math.trunc(st.mouth_evidence_hold || 0)

  const strongEvidence = computeStrongMouthEvidence(rawEvidence || {}, reliableEvidence, config, st)
  const strongActive = Boolean(strongEvidence.active)

  const openCloseEvidence = computeOpenCloseEvidence(rawEvidence || {}, reliableEvidence, config)
  const ocConfirm = Math.max(1, Math.trunc(safeFloat(ms.openCloseConfirmFrames, 2)))
  const ocHoldFrames = Math.max(0, Math.trunc(safeFloat(ms.openCloseHoldFrames, 8)))
  const ocScenario = String(ms.openCloseScenario || "frontal_mouth_motion")
  const ocOutputScale = safeFloat(ms.openCloseOutputScale, 0.75)
  const ocBlockLock = ms.openCloseBlockImmediateArtifactLock !== false
  if (openCloseEvidence.active) st.open_close_count = Math.trunc(st.open_close_count || 0) + 1
  else st.open_close_count = 0
  if (st.open_close_count >= ocConfirm) st.open_close_hold = ocHoldFrames
  let openCloseHold = Math.trunc(st.open_close_hold || 0)
  const openCloseGuardActive = openCloseHold > 0
  if (openCloseHold > 0) st.open_close_hold = openCloseHold - 1

  const currentScenario = String(st.current || "neutral_still")
  let candidate
  let reason
  if (strongActive) {
    candidate = String(strongEvidence.overrideScenario || "frontal_mouth_motion")
    reason = "strong-mouth-override"
  } else if (openCloseGuardActive) {
    candidate = ocScenario
    reason = "open-close-guard-active"
  } else if (!headMotionActive) {
    if (rawMouthActive) {
      candidate = "frontal_mouth_motion"
      reason = "no-head-motion-mouth-evidence"
    } else if (rawMouthInactive) {
      candidate = "neutral_still"
      reason = "neutral-quiet"
    } else {
      candidate = SCENARIOS.includes(currentScenario) ? currentScenario : "unknown"
      reason = "ambiguous"
    }
  } else if (headScoreStable && reliable && mouthScore >= stableStrongThr) {
    candidate = "frontal_mouth_motion"
    reason = "stable-head-strong-mouth"
  } else if (headScoreStable && mouthScore >= stableRawThr && mouthEvidenceHoldFrames >= 2) {
    candidate = "frontal_mouth_motion"
    reason = "stable-head-mouth-evidence"
  } else if (reliable && !headScoreStable) {
    candidate = "head_motion_mouth_motion"
    reason = "head-motion-reliable-mouth-evidence"
  } else if (mouthScore < closedHeadTurnMouthMax && mouthScore <= closedTurnRequireBelow) {
    candidate = "closed_head_turn"
    reason = "head-motion-mouth-quiet"
  } else if (mouthScore >= stableRawThr && reliable) {
    candidate = "frontal_mouth_motion"
    reason = "stable-head-reliable-mouth"
  } else {
    candidate = "closed_head_turn"
    reason = rawSource === "lipAbsMax" ? "head-motion-lip-only-artifact" : "head-motion-mouth-quiet"
  }

  let finalScenario
  let required
  if (!neutralReady) {
    st.current = "neutral_still"
    st.candidate = null
    st.candidate_count = 0
    finalScenario = "neutral_still"
    required = requiredConfirmFrames("neutral_still", ms)
  } else {
    const current = String(st.current || "neutral_still")
    required = requiredConfirmFrames(candidate, ms)
    if (candidate === current) {
      st.candidate = null
      st.candidate_count = 0
    } else if (candidate === st.candidate) {
      st.candidate_count = Math.trunc(st.candidate_count || 0) + 1
      if (st.candidate_count >= required) {
        st.current = candidate
        st.candidate = null
        st.candidate_count = 0
        st.last_changed_at = Number(nowMs) || 0
      }
    } else {
      st.candidate = candidate
      st.candidate_count = 1
      if (required <= 1) {
        st.current = candidate
        st.candidate = null
        st.candidate_count = 0
        st.last_changed_at = Number(nowMs) || 0
      }
    }
    finalScenario = String(st.current || "neutral_still")
  }

  const beforeScenario = String(finalScenario)
  let lipOnlyArtifact = reason === "head-motion-lip-only-artifact"
  let strongMouthOverrideApplied = false
  let stableHeadMouthOverride = false
  let overrideReason = null
  const strongScoreThr = safeFloat(ms.strongMouthScoreThreshold, mouthOn)

  const motionOk = mouthMotionAllowedForOverride(rawEvidence || {}, config, true)
  if (strongActive && reliable && !lipOnlyArtifact && motionOk) {
    strongMouthOverrideApplied = true
    if (headMotionActive && !headScoreStable) {
      finalScenario = "head_motion_mouth_motion"
      overrideReason = "strong-mouth-with-head-motion"
      reason = overrideReason
    } else {
      finalScenario = String(strongEvidence.overrideScenario || "frontal_mouth_motion")
      overrideReason = "strong-mouth-override"
      reason = overrideReason
    }
    st.current = finalScenario
    st.candidate = null
    st.candidate_count = 0
  } else if (
    reliable &&
    mouthScore >= strongScoreThr &&
    !lipOnlyArtifact &&
    mouthMotionAllowedForOverride(rawEvidence || {}, config)
  ) {
    if (finalScenario === "closed_head_turn" && !strongActive) {
      finalScenario = headMotionActive && !headScoreStable ? "head_motion_mouth_motion" : "frontal_mouth_motion"
      overrideReason = "reliable-mouth-blocks-closed-turn"
      reason = overrideReason
      st.current = finalScenario
      st.candidate = null
      st.candidate_count = 0
    }
  }

  if (
    !lipOnlyArtifact &&
    headMotionActive &&
    headScoreStable &&
    ["head_motion_mouth_motion", "closed_head_turn", "unknown"].includes(finalScenario) &&
    mouthMotionAllowedForOverride(rawEvidence || {}, config)
  ) {
    if (reliable && mouthScore >= stableStrongThr) {
      stableHeadMouthOverride = true
      finalScenario = "frontal_mouth_motion"
      overrideReason = "stable-head-strong-mouth"
      reason = overrideReason
      st.current = finalScenario
      st.candidate = null
      st.candidate_count = 0
    } else if (mouthScore >= stableRawThr && mouthEvidenceHoldFrames >= 2) {
      stableHeadMouthOverride = true
      finalScenario = "frontal_mouth_motion"
      overrideReason = "stable-head-mouth-evidence"
      reason = overrideReason
      st.current = finalScenario
      st.candidate = null
      st.candidate_count = 0
    }
  }

  lipOnlyArtifact = reason === "head-motion-lip-only-artifact"
  const classifier = {
    rawMouthEvidence: { ...(rawEvidence || {}) },
    headMotionEvidence: { ...(headEvidence || {}) },
    reliableMouthEvidence: { ...reliableEvidence },
    strongMouthEvidence: { ...strongEvidence },
    openCloseEvidence: { ...openCloseEvidence },
    openCloseGuard: {
      active: openCloseGuardActive,
      count: Math.trunc(st.open_close_count || 0),
      hold: Math.trunc(st.open_close_hold || 0),
      confirmFrames: ocConfirm,
      holdFrames: ocHoldFrames,
      outputScale: ocOutputScale,
      lipOutputScale: safeFloat(ms.openCloseLipScale, 0.85),
      jawOutputScale: safeFloat(ms.openCloseJawScale, 0.75),
      scenario: ocScenario,
      blockImmediateArtifactLock: ocBlockLock,
    },
    rawMouthActive,
    rawMouthInactive,
    headMotionActive,
    reliable,
    lipOnlyArtifact,
    candidateScenario: String(candidate),
    beforeScenario,
    finalScenario: String(finalScenario),
    strongMouthOverrideApplied,
    strongMouthOverride: strongMouthOverrideApplied,
    stableHeadMouthOverride,
    openCloseGuardActive,
    headScoreVelocity,
    headScoreStable,
    mouthEvidenceHoldFrames,
    overrideReason,
    candidateCount: Math.trunc(st.candidate_count || 0),
    requiredConfirmFrames: required,
    thresholds: {
      mouthOnThreshold: mouthOn,
      mouthOffThreshold: mouthOff,
      headOnThreshold: headOn,
      headOffThreshold: safeFloat(ms.headOffThreshold, 0.08),
      closedTurnRequireMouthBelow: closedTurnRequireBelow,
      closedHeadTurnMouthMax,
      headScoreVelocityThreshold: headVelThr,
      stableHeadStrongMouthThreshold: stableStrongThr,
      stableHeadRawMouthThreshold: stableRawThr,
    },
    decision: {
      preferMouthMotionOverHeadMotion: preferMouth,
      reason: String(reason),
    },
    neutralReady: Boolean(neutralReady),
  }
  st.last_debug = classifier
  return { classifier, nextState: st }
}
