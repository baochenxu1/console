/**
 * Phase 2.6 — Video-specific raw normalization + mapping gain (browser only).
 * 仅作用于 video source；camera 路径不调用。
 */

import { latencyStats, percentile } from "../trackingPreview/deviceDriveDiagnostics.js"
import { resolveTrackingSourceContext } from "./input/trackingSourceContext.js"

export const DEFAULT_VIDEO_SOURCE_TUNING = {
  enabled: true,

  brow: {
    enabled: true,
    browInnerUpBaseline: 0.75,
    browInnerUpDeadband: 0.08,
    browInnerUpScale: 0.45,
    browOutputScale: 0.55,
    clampAbsMax: 45,
    softKneeRatio: 0.72,
  },

  eye: {
    enabled: true,
    blinkInputScale: 0.45,
    eyelidOutputScale: 1.0,
    softLimitEnabled: true,
    softKneeAbs: 18,
    softLimitAbsMax: 32,
    eyeWideScale: 0.5,
    clampAbsMax: 35,
  },

  jaw: {
    enabled: true,
    requireRawJawOpenForJawOutput: true,
    rawJawOpenDeadband: 0.04,
    /** 判定 geometry 证据（是否跳过 raw-zero block） */
    geometryEvidenceMin: 0.08,
    semanticOpenMin: 0.05,
    jawOutputScale: 1.25,
    clampAbsMax: 52,
    /** geometry-mouth-open 专用 gate */
    geometryGateEnabled: true,
    geometryMouthOpenScale: 0.6,
    geometryJawClampAbsMax: 12,
    geometryJawSoftLimit: true,
    blendshapeJawOpenForGeometryMin: 0.06,
    rawMouthScoreForGeometryMin: 3.0,
  },

  mouth: {
    enabled: true,
    rawMouthScoreScale: 0.1,
    rawMouthScoreSaturationThreshold: 8.0,
    rawMouthScoreUnitScaleThreshold: 2.0,
    mouthOutputScale: 0.82,
    clampAbsMax: 30,
  },
}

/** rawMouthScore max/P95 > 此值视为 score 量纲，否则视为 0~1 */
export const MOUTH_SCORE_UNIT_THRESHOLD = 2.0
export const MOUTH_SATURATION_THRESHOLD_UNIT = 8.0
export const MOUTH_SATURATION_THRESHOLD_NORMALIZED = 0.85

const RAW_JAW_SUSPICIOUS = 0.04
const TUNED_JAW_SUSPICIOUS = 4.8

function num(v, fallback = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function roundNum(v, digits = 4) {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  const f = 10 ** digits
  return Math.round(n * f) / f
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n))
}

function cloneRig(rig) {
  if (!rig || typeof rig !== "object") return null
  return JSON.parse(JSON.stringify(rig))
}

function browAbsMax(rig) {
  const l = rig?.browL
  const r = rig?.browR
  const side = (s) =>
    Math.max(Math.abs(num(s?.tip)), Math.abs(num(s?.mid)), Math.abs(num(s?.tail)))
  return Math.max(side(l), side(r))
}

function eyeAbsMax(rig) {
  return Math.max(
    Math.abs(num(rig?.eyeL?.up)),
    Math.abs(num(rig?.eyeL?.lo)),
    Math.abs(num(rig?.eyeR?.up)),
    Math.abs(num(rig?.eyeR?.lo))
  )
}

function mouthAbsMax(rig) {
  const m = rig?.mouth
  if (!m) return 0
  return Math.max(
    Math.abs(num(m.UL)),
    Math.abs(num(m.UR)),
    Math.abs(num(m.LL)),
    Math.abs(num(m.LR))
  )
}

function scaleBrowSide(side, factor) {
  if (!side) return side
  const f = num(factor, 1)
  return {
    tip: roundNum(num(side.tip) * f, 3),
    mid: roundNum(num(side.mid) * f, 3),
    tail: roundNum(num(side.tail) * f, 3),
  }
}

/** Video-only eye output soft limit（替代固定 scale 乘法） */
export function softLimitEyeOutput(value, knee = 18, limit = 32) {
  const n = num(value)
  const sign = n < 0 ? -1 : 1
  const abs = Math.abs(n)
  const k = num(knee, 18)
  const lim = num(limit, 32)
  if (abs <= k) return roundNum(n, 3)
  const excess = abs - k
  const range = Math.max(1e-6, lim - k)
  const compressed = k + range * Math.tanh(excess / range)
  return roundNum(sign * Math.min(lim, compressed), 3)
}

function applyEyeSoftLimitSide(side, eyeCfg) {
  if (!side) return side
  const scale = num(eyeCfg.eyelidOutputScale, 1)
  const knee = num(eyeCfg.softKneeAbs, 18)
  const softMax = num(eyeCfg.softLimitAbsMax, 32)
  const useSoft = eyeCfg.softLimitEnabled !== false
  const mapVal = (v) => {
    let out = num(v) * scale
    if (useSoft) {
      out = softLimitEyeOutput(out, knee, softMax)
    }
    return roundNum(out, 3)
  }
  return { up: mapVal(side.up), lo: mapVal(side.lo) }
}

function applyEyeSoftLimitToRig(rig, eyeCfg) {
  const before = eyeAbsMax(rig)
  const next = {
    ...rig,
    eyeL: applyEyeSoftLimitSide(rig.eyeL, eyeCfg),
    eyeR: applyEyeSoftLimitSide(rig.eyeR, eyeCfg),
  }
  const after = eyeAbsMax(next)
  return { rig: next, softLimitApplied: Math.abs(before - after) > 0.05 }
}

/** Soft knee before hard clamp — reduces frames pinned at clampAbsMax. */
export function softLimitSigned(value, limit, kneeRatio = 0.72) {
  const n = num(value)
  const sign = n < 0 ? -1 : 1
  const abs = Math.abs(n)
  const lim = num(limit, 45)
  const knee = lim * num(kneeRatio, 0.72)
  if (abs <= knee) return roundNum(n, 3)
  const excess = abs - knee
  const range = Math.max(1e-6, lim - knee)
  const compressed = knee + range * Math.tanh(excess / range)
  return roundNum(sign * Math.min(lim, compressed), 3)
}

function softLimitBrowSide(side, limit, kneeRatio) {
  if (!side) return side
  return {
    tip: softLimitSigned(side.tip, limit, kneeRatio),
    mid: softLimitSigned(side.mid, limit, kneeRatio),
    tail: softLimitSigned(side.tail, limit, kneeRatio),
  }
}

function applyBrowSoftLimitToRig(rig, limit, kneeRatio = 0.72) {
  const before = browAbsMax(rig)
  const next = {
    ...rig,
    browL: softLimitBrowSide(rig.browL, limit, kneeRatio),
    browR: softLimitBrowSide(rig.browR, limit, kneeRatio),
  }
  const after = browAbsMax(next)
  return { rig: next, softLimitApplied: Math.abs(before - after) > 0.05 }
}

function clampBrowRig(rig, maxAbs) {
  const max = num(maxAbs, 100)
  const cur = browAbsMax(rig)
  if (cur <= max || cur <= 1e-6) return { rig, clampApplied: false }
  const factor = max / cur
  return {
    rig: {
      ...rig,
      browL: scaleBrowSide(rig.browL, factor),
      browR: scaleBrowSide(rig.browR, factor),
    },
    clampApplied: true,
  }
}

function clampEyeRig(rig, maxAbs) {
  const max = num(maxAbs, 100)
  const scaleSide = (side) => {
    const up = num(side?.up)
    const lo = num(side?.lo)
    const peak = Math.max(Math.abs(up), Math.abs(lo))
    if (peak <= max) return { up: roundNum(up, 3), lo: roundNum(lo, 3) }
    const f = max / peak
    return { up: roundNum(up * f, 3), lo: roundNum(lo * f, 3) }
  }
  const next = {
    ...rig,
    eyeL: scaleSide(rig.eyeL),
    eyeR: scaleSide(rig.eyeR),
  }
  return { rig: next, clampApplied: eyeAbsMax(next) < eyeAbsMax(rig) - 0.01 }
}

function clampMouthRig(rig, maxAbs) {
  const max = num(maxAbs, 100)
  const cur = mouthAbsMax(rig)
  if (cur <= max || cur <= 1e-6) return { rig, clampApplied: false }
  const f = max / cur
  const m = rig.mouth || {}
  return {
    rig: {
      ...rig,
      mouth: {
        ...m,
        UL: roundNum(num(m.UL) * f, 3),
        UR: roundNum(num(m.UR) * f, 3),
        LL: roundNum(num(m.LL) * f, 3),
        LR: roundNum(num(m.LR) * f, 3),
        sideL: m.sideL
          ? { x: roundNum(num(m.sideL.x) * f, 3), y: roundNum(num(m.sideL.y) * f, 3) }
          : m.sideL,
        sideR: m.sideR
          ? { x: roundNum(num(m.sideR.x) * f, 3), y: roundNum(num(m.sideR.y) * f, 3) }
          : m.sideR,
      },
    },
    clampApplied: true,
  }
}

function clampJawRig(rig, maxAbs) {
  const max = num(maxAbs, 100)
  const cur = Math.abs(num(rig?.jaw?.val))
  if (cur <= max) return { rig, clampApplied: false }
  const sign = num(rig.jaw.val) >= 0 ? 1 : -1
  return {
    rig: { ...rig, jaw: { val: roundNum(sign * max, 3) } },
    clampApplied: true,
  }
}

export function isVideoSourceFrame(frame, options = {}, uiState = {}) {
  return resolveTrackingSourceContext(frame, options, uiState).isVideoSource
}

export function resolveVideoSourceType(frame, options = {}, uiState = {}) {
  return resolveTrackingSourceContext(frame, options, uiState).sourceType
}

/** browInnerUp baseline subtraction（0~1 blendshape） */
export function normalizeVideoBrowInnerUp(raw, browTuning = DEFAULT_VIDEO_SOURCE_TUNING.brow) {
  const baseline = num(browTuning.browInnerUpBaseline, 0.75)
  const deadband = num(browTuning.browInnerUpDeadband, 0.08)
  const scale = num(browTuning.browInnerUpScale, 0.45)
  const centered = num(raw) - baseline
  if (Math.abs(centered) < deadband) return 0
  return clamp(centered * scale, -1, 1)
}

export function resolveMouthScoreSaturationThreshold(
  rawMouthScoreSamples = [],
  mouthTuning = DEFAULT_VIDEO_SOURCE_TUNING.mouth
) {
  const unitThr = num(mouthTuning.rawMouthScoreUnitScaleThreshold, MOUTH_SCORE_UNIT_THRESHOLD)
  const scoreThreshold = num(mouthTuning.rawMouthScoreSaturationThreshold, MOUTH_SATURATION_THRESHOLD_UNIT)
  const values = rawMouthScoreSamples.filter((v) => Number.isFinite(Number(v))).map(Number)
  const stats = values.length ? latencyStats(values) : { p90: null, max: null, count: 0 }
  const p95 = values.length ? percentile(values, 95) : null
  const max = stats.max
  const useScoreScale =
    (max != null && max > unitThr) || (p95 != null && p95 > unitThr)
  return {
    threshold: useScoreScale ? scoreThreshold : MOUTH_SATURATION_THRESHOLD_NORMALIZED,
    unitScale: useScoreScale ? "score" : "0-1",
    p90Hint: stats.p90,
    p95Hint: p95,
    maxHint: max,
  }
}

export function buildJawOutputSourcesTrace(
  sourceFrame,
  rigBeforeTuning,
  tuning = DEFAULT_VIDEO_SOURCE_TUNING
) {
  const dbg = sourceFrame?.debug
  const blend = dbg?.blendshapes
  const mapping = dbg?.mapping
  const jawGeo = dbg?.jawGeometry
  const lip = dbg?.lipGeometry
  const mouthDbg = dbg?.mouthDebug || lip?.mouthDebug
  const scenario = dbg?.mouthScenarioClassifier

  const fromBlendshapeJawOpen =
    blend?.jawOpen != null ? roundNum(blend.jawOpen, 4) : undefined
  const fromMappingJaw = mapping?.jaw != null ? roundNum(mapping.jaw, 4) : undefined
  const fromGeometryMouthOpen =
    lip?.mouthOpenRatio != null
      ? roundNum(lip.mouthOpenRatio, 4)
      : jawGeo?.semanticOpen != null
        ? roundNum(jawGeo.semanticOpen, 4)
        : undefined
  const fromMouthScenario =
    jawGeo?.rigWrite != null
      ? roundNum(jawGeo.rigWrite, 3)
      : scenario?.jawWrite != null
        ? roundNum(scenario.jawWrite, 3)
        : undefined
  const mappingJaw = num(mapping?.jaw)
  const calibratedJaw = num(rigBeforeTuning?.jaw?.val)
  const fromSmoothingResidual =
    mappingJaw !== 0 || calibratedJaw !== 0
      ? roundNum(calibratedJaw - mappingJaw, 3)
      : roundNum(calibratedJaw, 3)

  const rawJawOpen =
    fromMappingJaw ?? fromBlendshapeJawOpen ?? jawGeo?.raw ?? jawGeo?.curved ?? 0

  let jawOutputSource = "unknown"
  const mouthOpenRatio = num(lip?.mouthOpenRatio ?? mouthDbg?.mouthOpenRatio)
  const semanticOpen = num(jawGeo?.semanticOpen)
  const hasGeometryEvidence =
    mouthOpenRatio >= num(tuning.jaw.geometryEvidenceMin, 0.08) ||
    semanticOpen >= num(tuning.jaw.semanticOpenMin, 0.05)

  if (num(rawJawOpen) < DEFAULT_VIDEO_SOURCE_TUNING.jaw.rawJawOpenDeadband) {
    if (hasGeometryEvidence) {
      jawOutputSource = "geometry-mouth-open"
    } else if (fromMouthScenario != null && Math.abs(num(fromMouthScenario)) > 0.5) {
      jawOutputSource = "mouth-scenario"
    } else if (Math.abs(num(fromSmoothingResidual)) > 1) {
      jawOutputSource = "smoothing-residual"
    } else if (jawGeo?.rigWrite != null) {
      jawOutputSource = "jaw-geometry-rigWrite"
    } else {
      jawOutputSource = "unknown"
    }
  } else if (fromBlendshapeJawOpen != null) {
    jawOutputSource = "blendshape-jawOpen"
  } else if (fromMappingJaw != null) {
    jawOutputSource = "mapping-jaw"
  }

  return {
    rawJawOpen: roundNum(rawJawOpen, 4),
    jawOutputSource,
    jawOutputSources: {
      ...(fromBlendshapeJawOpen != null ? { fromBlendshapeJawOpen } : {}),
      ...(fromMouthScenario != null ? { fromMouthScenario } : {}),
      ...(fromGeometryMouthOpen != null ? { fromGeometryMouthOpen } : {}),
      ...(fromSmoothingResidual != null ? { fromSmoothingResidual } : {}),
      ...(jawGeo?.rigWrite != null ? { fromFallback: roundNum(jawGeo.rigWrite, 3) } : {}),
      finalBeforeTuning: roundNum(calibratedJaw, 3),
    },
  }
}

function resolveBrowSuppressFactor(browInnerUp, browTuning) {
  const inner = num(browInnerUp)
  const baseline = num(browTuning.browInnerUpBaseline)
  const deadband = num(browTuning.browInnerUpDeadband)
  const scale = num(browTuning.browInnerUpScale)
  const excess = Math.max(0, inner - baseline - deadband)
  const suppress = 1 - excess * scale
  return clamp(suppress, 0.12, 1)
}

function resolveBlendshapeJawOpen(jawTrace, blendshapes) {
  const fromTrace = jawTrace?.jawOutputSources?.fromBlendshapeJawOpen
  if (fromTrace != null && Number.isFinite(Number(fromTrace))) {
    return num(fromTrace)
  }
  if (blendshapes?.jawOpen != null && Number.isFinite(Number(blendshapes.jawOpen))) {
    return num(blendshapes.jawOpen)
  }
  return null
}

/**
 * Video-only jaw geometry-mouth-open gate（需 blendshape 或 mouthScore 证据）。
 */
function applyJawGeometryMouthOpenGate(jawVal, jawTrace, tuning, dbg, blend) {
  const jawCfg = tuning.jaw
  if (jawCfg.geometryGateEnabled === false) {
    return { val: jawVal, applied: false, reason: null }
  }

  const lip = dbg?.lipGeometry
  const mouthDbg = dbg?.mouthDebug || lip?.mouthDebug
  const blendshapeJawOpen = resolveBlendshapeJawOpen(jawTrace, blend)
  const rawMouthScore = num(
    mouthDbg?.rawMouthScore ?? lip?.rawMouthScore ?? dbg?.mapping?.mouthPucker
  )

  const hasBlendshapeEvidence =
    blendshapeJawOpen != null &&
    Math.abs(blendshapeJawOpen) >= num(jawCfg.blendshapeJawOpenForGeometryMin, 0.06)
  const hasMouthScoreEvidence =
    rawMouthScore >= num(jawCfg.rawMouthScoreForGeometryMin, 3.0)

  if (!hasBlendshapeEvidence && !hasMouthScoreEvidence) {
    return {
      val: 0,
      applied: true,
      reason: "insufficient-blendshape-and-mouth-score-evidence",
    }
  }

  const scale = num(jawCfg.geometryMouthOpenScale, 0.35)
  const clampMax = num(jawCfg.geometryJawClampAbsMax, 4.8)
  let output = num(jawVal) * scale
  if (jawCfg.geometryJawSoftLimit !== false) {
    output = softLimitSigned(output, clampMax, 0.72)
  } else {
    output =
      num(jawVal) >= 0
        ? Math.min(Math.abs(output), clampMax)
        : -Math.min(Math.abs(output), clampMax)
  }
  return { val: roundNum(output, 3), applied: true, reason: "geometry-mouth-open-soft-limited" }
}

export function resolveJawFrameSignals(frame) {
  const jawTrace = frame?.rawTrackingSignals?.jaw
  const blendshapeJawOpen = resolveBlendshapeJawOpen(jawTrace, frame?.rawTrackingSignals?.blendshapes)
  const neutralizedJawOpen =
    jawTrace?.neutralizedJawOpen != null ? roundNum(jawTrace.neutralizedJawOpen, 4) : null
  const jawSignalBeforeTuning =
    jawTrace?.jawOutputSources?.finalBeforeTuning != null
      ? roundNum(jawTrace.jawOutputSources.finalBeforeTuning, 4)
      : frame?.videoSourceTuning?.jaw?.jawOutputBeforeAbsMax != null
        ? roundNum(frame.videoSourceTuning.jaw.jawOutputBeforeAbsMax, 4)
        : null
  return { blendshapeJawOpen, neutralizedJawOpen, jawSignalBeforeTuning }
}

function isBlendshapeJawNearZero(frame, threshold = RAW_JAW_SUSPICIOUS) {
  const { blendshapeJawOpen } = resolveJawFrameSignals(frame)
  if (blendshapeJawOpen != null) {
    return Math.abs(blendshapeJawOpen) < threshold
  }
  const fallback = num(
    frame?.videoSourceTuningShadow?.blendshapeJawOpen ??
      frame?.rawTrackingSignals?.jaw?.blendshapeJawOpen ??
      frame?.rawTrackingSignals?.blendshapes?.jawOpen
  )
  return Math.abs(fallback) < threshold
}

/**
 * Core tuning transform (always applies when called — used by shadow compare).
 */
function applyTuningCore({ frame, sourceFrame, tuning = DEFAULT_VIDEO_SOURCE_TUNING }) {
  const srcFrame = sourceFrame || frame
  const dbg = srcFrame?.debug
  const blend = dbg?.blendshapes || {}
  const lip = dbg?.lipGeometry
  const mouthDbg = dbg?.mouthDebug || lip?.mouthDebug

  let rig = cloneRig(frame.rig)

  const browInnerUpRaw = blend.browInnerUp
  const browInnerUpNorm =
    browInnerUpRaw != null ? normalizeVideoBrowInnerUp(browInnerUpRaw, tuning.brow) : null
  const browSuppress = resolveBrowSuppressFactor(browInnerUpRaw, tuning.brow)
  const browScale = tuning.brow.enabled
    ? num(tuning.brow.browOutputScale) * browSuppress
    : 1

  const browBefore = browAbsMax(rig)
  let browSoftLimitApplied = false
  let browHardClampApplied = false
  if (tuning.brow.enabled) {
    rig = {
      ...rig,
      browL: scaleBrowSide(rig.browL, browScale),
      browR: scaleBrowSide(rig.browR, browScale),
    }
    const soft = applyBrowSoftLimitToRig(
      rig,
      tuning.brow.clampAbsMax,
      tuning.brow.softKneeRatio ?? 0.72
    )
    rig = soft.rig
    browSoftLimitApplied = soft.softLimitApplied
    const browClamp = clampBrowRig(rig, tuning.brow.clampAbsMax)
    rig = browClamp.rig
    browHardClampApplied = browClamp.clampApplied
  }
  const browAfter = browAbsMax(rig)

  const blinkL = num(blend.eyeBlinkLeft)
  const eyeBefore = eyeAbsMax(rig)
  let eyeSoftLimitApplied = false
  let eyeClampApplied = false
  if (tuning.eye.enabled) {
    const eyeSoft = applyEyeSoftLimitToRig(rig, tuning.eye)
    rig = eyeSoft.rig
    eyeSoftLimitApplied = eyeSoft.softLimitApplied
    const eyeClamp = clampEyeRig(rig, tuning.eye.clampAbsMax)
    rig = eyeClamp.rig
    eyeClampApplied = eyeClamp.clampApplied
  }
  const eyeAfter = eyeAbsMax(rig)

  const jawTrace = buildJawOutputSourcesTrace(srcFrame, frame.rig, tuning)
  const mouthOpenRatio = num(lip?.mouthOpenRatio ?? mouthDbg?.mouthOpenRatio)
  const semanticOpen = num(dbg?.jawGeometry?.semanticOpen)
  const hasGeometryEvidence =
    mouthOpenRatio >= num(tuning.jaw.geometryEvidenceMin, 0.08) ||
    semanticOpen >= num(tuning.jaw.semanticOpenMin, 0.05)

  let blockedBecauseRawJawZero = false
  let geometryGateApplied = false
  let geometryGateReason = null
  const jawBefore = Math.abs(num(rig.jaw?.val))
  let jawClampApplied = false
  if (tuning.jaw.enabled) {
    const blendshapeJaw = resolveBlendshapeJawOpen(jawTrace, blend)
    const rawJaw = blendshapeJaw != null ? blendshapeJaw : num(jawTrace.rawJawOpen)
    if (
      tuning.jaw.requireRawJawOpenForJawOutput &&
      Math.abs(rawJaw) < num(tuning.jaw.rawJawOpenDeadband) &&
      !hasGeometryEvidence
    ) {
      rig = { ...rig, jaw: { val: 0 } }
      blockedBecauseRawJawZero = true
    } else {
      rig = { ...rig, jaw: { val: roundNum(num(rig.jaw?.val) * num(tuning.jaw.jawOutputScale), 3) } }
    }

    if (!blockedBecauseRawJawZero && jawTrace.jawOutputSource === "geometry-mouth-open") {
      const gate = applyJawGeometryMouthOpenGate(rig.jaw?.val, jawTrace, tuning, dbg, blend)
      rig = { ...rig, jaw: { val: gate.val } }
      geometryGateApplied = gate.applied
      geometryGateReason = gate.reason
    }

    const jawClamp = clampJawRig(rig, tuning.jaw.clampAbsMax)
    rig = jawClamp.rig
    jawClampApplied = jawClamp.clampApplied
  }
  const jawAfter = Math.abs(num(rig.jaw?.val))
  jawTrace.jawOutputSources.finalAfterTuning = roundNum(rig.jaw?.val, 3)
  const blendshapeJawOpenVal = resolveBlendshapeJawOpen(jawTrace, blend)

  const rawMouthBefore =
    mouthDbg?.rawMouthScore ?? lip?.rawMouthScore ?? dbg?.mapping?.mouthPucker ?? null
  const mouthScale = tuning.mouth.enabled ? num(tuning.mouth.mouthOutputScale) : 1
  const mouthBefore = mouthAbsMax(rig)
  let mouthClampApplied = false
  if (tuning.mouth.enabled) {
    const m = rig.mouth || {}
    rig = {
      ...rig,
      mouth: {
        ...m,
        UL: roundNum(num(m.UL) * mouthScale, 3),
        UR: roundNum(num(m.UR) * mouthScale, 3),
        LL: roundNum(num(m.LL) * mouthScale, 3),
        LR: roundNum(num(m.LR) * mouthScale, 3),
      },
    }
    const mouthClamp = clampMouthRig(rig, tuning.mouth.clampAbsMax)
    rig = mouthClamp.rig
    mouthClampApplied = mouthClamp.clampApplied
  }
  const mouthAfter = mouthAbsMax(rig)

  const rawMouthAfter =
    rawMouthBefore != null
      ? roundNum(num(rawMouthBefore) * num(tuning.mouth.rawMouthScoreScale), 4)
      : null

  const diagnostic = {
    enabled: true,
    applied: true,
    sourceType: "video",
    brow: {
      enabled: tuning.brow.enabled,
      inputBaseline: tuning.brow.browInnerUpBaseline,
      inputBefore: browInnerUpRaw != null ? roundNum(browInnerUpRaw, 4) : null,
      inputAfter: browInnerUpNorm,
      outputBeforeAbsMax: roundNum(browBefore, 3),
      outputAfterAbsMax: roundNum(browAfter, 3),
      scale: roundNum(browScale, 4),
      suppressFactor: roundNum(browSuppress, 4),
      softLimitApplied: browSoftLimitApplied,
      clampApplied: browHardClampApplied,
      hardClampApplied: browHardClampApplied,
    },
    eye: {
      enabled: tuning.eye.enabled,
      blinkInputBefore: roundNum(Math.max(blinkL, num(blend.eyeBlinkRight)), 4),
      blinkInputAfter: roundNum(
        Math.max(blinkL, num(blend.eyeBlinkRight)) * num(tuning.eye.blinkInputScale),
        4
      ),
      outputBeforeAbsMax: roundNum(eyeBefore, 3),
      outputAfterAbsMax: roundNum(eyeAfter, 3),
      softLimitApplied: eyeSoftLimitApplied,
      clampApplied: eyeClampApplied,
    },
    jaw: {
      enabled: tuning.jaw.enabled,
      rawJawOpen: jawTrace.rawJawOpen,
      blendshapeJawOpen:
        blendshapeJawOpenVal != null ? roundNum(blendshapeJawOpenVal, 4) : null,
      jawOutputSource: jawTrace.jawOutputSource,
      jawOutputBeforeAbsMax: roundNum(jawBefore, 3),
      jawOutputAfterAbsMax: roundNum(jawAfter, 3),
      blockedBecauseRawJawZero,
      geometryGateApplied,
      geometryGateReason,
      scale: tuning.jaw.jawOutputScale,
      clampApplied: jawClampApplied,
    },
    mouth: {
      enabled: tuning.mouth.enabled,
      rawMouthScoreBefore: rawMouthBefore != null ? roundNum(rawMouthBefore, 4) : null,
      rawMouthScoreAfter: rawMouthAfter,
      outputBeforeAbsMax: roundNum(mouthBefore, 3),
      outputAfterAbsMax: roundNum(mouthAfter, 3),
      scale: mouthScale,
      rawMouthScoreScale: tuning.mouth.rawMouthScoreScale,
      clampApplied: mouthClampApplied,
    },
  }

  return {
    rig,
    diagnostic,
    jawTrace,
    blockedBecauseRawJawZero,
    browHardClampApplied,
    browSoftLimitApplied,
    geometryGateApplied,
    geometryGateReason,
  }
}

function packRigChannelAbs(rig) {
  return {
    browAbsMax: roundNum(browAbsMax(rig), 3),
    eyeAbsMax: roundNum(eyeAbsMax(rig), 3),
    jawAbsMax: roundNum(Math.abs(num(rig?.jaw?.val)), 3),
    mouthAbsMax: roundNum(mouthAbsMax(rig), 3),
  }
}

/**
 * Same-frame shadow compare: always compute untuned + tuned on video source.
 */
export function buildVideoSourceTuningShadow({
  calibratedFrame,
  sourceFrame = null,
  tuning = DEFAULT_VIDEO_SOURCE_TUNING,
  previewUsesTuned = true,
}) {
  const srcFrame = sourceFrame || calibratedFrame
  if (!calibratedFrame?.rig || !isVideoSourceFrame(srcFrame)) {
    return null
  }

  const untunedRig = cloneRig(calibratedFrame.rig)
  const tunedResult = applyTuningCore({
    frame: calibratedFrame,
    sourceFrame: srcFrame,
    tuning,
  })

  const untuned = packRigChannelAbs(untunedRig)
  const tuned = packRigChannelAbs(tunedResult.rig)

  const shadow = {
    enabled: true,
    sourceType: "video",
    outputMode: previewUsesTuned ? "tuned" : "untuned",
    untuned,
    tuned,
    delta: {
      browReductionAbs: roundNum(num(untuned.browAbsMax) - num(tuned.browAbsMax), 3),
      eyeReductionAbs: roundNum(num(untuned.eyeAbsMax) - num(tuned.eyeAbsMax), 3),
      jawReductionAbs: roundNum(num(untuned.jawAbsMax) - num(tuned.jawAbsMax), 3),
      mouthReductionAbs: roundNum(num(untuned.mouthAbsMax) - num(tuned.mouthAbsMax), 3),
    },
    appliedToPreviewRig: Boolean(previewUsesTuned),
    browHardClampApplied: tunedResult.browHardClampApplied,
    browSoftLimitApplied: tunedResult.browSoftLimitApplied,
    jawOutputSource: tunedResult.jawTrace?.jawOutputSource ?? null,
    blendshapeJawOpen:
      resolveBlendshapeJawOpen(tunedResult.jawTrace, srcFrame?.debug?.blendshapes) != null
        ? roundNum(
            resolveBlendshapeJawOpen(tunedResult.jawTrace, srcFrame?.debug?.blendshapes),
            4
          )
        : null,
    rawJawOpen: tunedResult.jawTrace?.rawJawOpen ?? null,
    jawBlockedRawZero: tunedResult.blockedBecauseRawJawZero,
    geometryGateApplied: tunedResult.geometryGateApplied ?? false,
  }

  return {
    shadow,
    untunedRig,
    tunedRig: tunedResult.rig,
    tunedResult,
  }
}

/**
 * @param {{ frame: object, sourceFrame?: object, tuning?: typeof DEFAULT_VIDEO_SOURCE_TUNING, enabled?: boolean }} params
 */
export function applyVideoSourceTuningToFrame({
  frame,
  sourceFrame = null,
  tuning = DEFAULT_VIDEO_SOURCE_TUNING,
  enabled = true,
}) {
  const srcFrame = sourceFrame || frame
  const sourceType = resolveVideoSourceType(srcFrame)
  const isVideo = sourceType === "video" || sourceType === "uploaded-video"
  const tuningEnabled = Boolean(enabled && tuning?.enabled && isVideo)

  if (!frame?.rig || !tuningEnabled) {
    return {
      frame,
      rig: frame?.rig,
      applied: false,
      diagnostic: {
        enabled: tuningEnabled,
        applied: false,
        sourceType,
      },
    }
  }

  const core = applyTuningCore({ frame, sourceFrame: srcFrame, tuning })
  const rig = core.rig

  const tunedFrame = {
    ...frame,
    rig,
    debug: {
      ...(frame.debug || {}),
      videoSourceTuningApply: { basis: "rig-output-scale", applied: true },
    },
  }

  return {
    frame: tunedFrame,
    rig,
    applied: true,
    diagnostic: core.diagnostic,
    jawTrace: core.jawTrace,
    browHardClampApplied: core.browHardClampApplied,
    browSoftLimitApplied: core.browSoftLimitApplied,
  }
}

function reductionRatio(before, after) {
  if (before == null || after == null || before <= 0) return null
  return roundNum(1 - after / before, 4)
}

function channelP90(values) {
  const stats = latencyStats(values.filter((v) => Number.isFinite(Number(v))).map(Number))
  return stats.count ? roundNum(stats.p90, 3) : null
}

/** @param {Record<string, unknown>[]} summaryFrames */
export function buildVideoSourceTuningEffectSummary(summaryFrames = []) {
  const frames = summaryFrames.filter((f) => !f.diagnostic?.excludeFromSummary)
  const applied = frames.filter((f) => f.videoSourceTuning?.applied)
  if (!applied.length) {
    return { enabled: false, appliedFrameCount: 0 }
  }

  const browBefore = applied.map((f) => f.videoSourceTuning?.brow?.outputBeforeAbsMax)
  const browAfter = applied.map((f) => f.videoSourceTuning?.brow?.outputAfterAbsMax)
  const eyeBefore = applied.map((f) => f.videoSourceTuning?.eye?.outputBeforeAbsMax)
  const eyeAfter = applied.map((f) => f.videoSourceTuning?.eye?.outputAfterAbsMax)
  const jawBefore = applied.map((f) => f.videoSourceTuning?.jaw?.jawOutputBeforeAbsMax)
  const jawAfter = applied.map((f) => f.videoSourceTuning?.jaw?.jawOutputAfterAbsMax)
  const mouthRawBefore = applied.map((f) => f.videoSourceTuning?.mouth?.rawMouthScoreBefore)
  const mouthRawAfter = applied.map((f) => f.videoSourceTuning?.mouth?.rawMouthScoreAfter)
  const mouthOutBefore = applied.map((f) => f.videoSourceTuning?.mouth?.outputBeforeAbsMax)
  const mouthOutAfter = applied.map((f) => f.videoSourceTuning?.mouth?.outputAfterAbsMax)

  const browBeforeP90 = channelP90(browBefore)
  const browAfterP90 = channelP90(browAfter)
  const eyeBeforeP90 = channelP90(eyeBefore)
  const eyeAfterP90 = channelP90(eyeAfter)
  const jawBeforeP90 = channelP90(jawBefore)
  const jawAfterP90 = channelP90(jawAfter)

  const mouthThr = resolveMouthScoreSaturationThreshold(mouthRawBefore)
  const satThreshold = mouthThr.threshold
  const satBefore = mouthRawBefore.filter((v) => v != null).map(Number)
  const satAfter = mouthRawAfter.filter((v) => v != null).map(Number)
  const saturatedBefore = satBefore.filter((v) => v >= MOUTH_SATURATION_THRESHOLD_NORMALIZED).length
  const saturatedAfter = satAfter.filter((v) => v >= satThreshold).length
  const denom = applied.length || 1

  return {
    enabled: true,
    appliedFrameCount: applied.length,
    brow: {
      beforeP90: browBeforeP90,
      afterP90: browAfterP90,
      reductionRatioP90: reductionRatio(browBeforeP90, browAfterP90),
      clampFrameCount: applied.filter((f) => f.videoSourceTuning?.brow?.hardClampApplied).length,
      hardClampFrameCount: applied.filter(
        (f) =>
          f.videoSourceTuning?.brow?.hardClampApplied ||
          f.videoSourceTuningShadow?.browHardClampApplied
      ).length,
    },
    eye: {
      beforeP90: eyeBeforeP90,
      afterP90: eyeAfterP90,
      reductionRatioP90: reductionRatio(eyeBeforeP90, eyeAfterP90),
      clampFrameCount: applied.filter((f) => f.videoSourceTuning?.eye?.clampApplied).length,
    },
    jaw: {
      beforeP90: jawBeforeP90,
      afterP90: jawAfterP90,
      reductionRatioP90: reductionRatio(jawBeforeP90, jawAfterP90),
      blockedRawZeroFrameCount: applied.filter(
        (f) => f.videoSourceTuning?.jaw?.blockedBecauseRawJawZero
      ).length,
    },
    mouth: {
      rawMouthScoreBeforeP90: channelP90(mouthRawBefore),
      rawMouthScoreAfterP90: channelP90(mouthRawAfter),
      outputBeforeP90: channelP90(mouthOutBefore),
      outputAfterP90: channelP90(mouthOutAfter),
      saturationThreshold: satThreshold,
      saturationUnitScale: mouthThr.unitScale,
      saturatedFrameRatioBefore: roundNum(saturatedBefore / denom, 4),
      saturatedFrameRatioAfter: roundNum(saturatedAfter / denom, 4),
    },
  }
}

export function enrichRawTrackingSignalsJawTrace(rawSignals, jawTrace) {
  if (!rawSignals || !jawTrace) return rawSignals

  const blendshapeJawOpen =
    jawTrace.jawOutputSources?.fromBlendshapeJawOpen ??
    rawSignals.blendshapes?.jawOpen ??
    null
  const geometryJawSignal =
    jawTrace.jawOutputSources?.fromGeometryMouthOpen ??
    (jawTrace.jawOutputSource === "geometry-mouth-open"
      ? jawTrace.jawOutputSources?.finalBeforeTuning
      : null)
  const finalBeforeTuning = jawTrace.jawOutputSources?.finalBeforeTuning ?? null
  const finalAfterTuning = jawTrace.jawOutputSources?.finalAfterTuning ?? null

  const jaw = {
    ...(blendshapeJawOpen != null ? { blendshapeJawOpen: roundNum(blendshapeJawOpen, 4) } : {}),
    ...(rawSignals.jaw?.neutralizedJawOpen != null
      ? { neutralizedJawOpen: rawSignals.jaw.neutralizedJawOpen }
      : {}),
    jawOutputSource: jawTrace.jawOutputSource ?? null,
    ...(geometryJawSignal != null ? { geometryJawSignal: roundNum(geometryJawSignal, 4) } : {}),
    ...(finalBeforeTuning != null
      ? {
          jawSignalBeforeTuning: roundNum(finalBeforeTuning, 4),
          finalBeforeTuning: roundNum(finalBeforeTuning, 4),
        }
      : {}),
    ...(finalAfterTuning != null ? { finalAfterTuning: roundNum(finalAfterTuning, 4) } : {}),
    jawOutputSources: jawTrace.jawOutputSources ?? null,
  }

  return { ...rawSignals, jaw }
}

export function buildVideoSourceTuningDiagnosisNotes(tuningEffect) {
  const notes = []
  if (!tuningEffect?.enabled) return notes
  notes.push("video-source-tuning-applied")
  if (tuningEffect.brow?.reductionRatioP90 > 0.05) {
    notes.push("video-brow-baseline-subtracted")
  }
  if (tuningEffect.eye?.reductionRatioP90 > 0.05) {
    notes.push("video-eye-output-scaled")
  }
  if (tuningEffect.jaw?.blockedRawZeroFrameCount > 0) {
    notes.push("video-jaw-raw-zero-blocked")
  }
  if (tuningEffect.mouth?.saturationThreshold >= MOUTH_SATURATION_THRESHOLD_UNIT) {
    notes.push("video-mouth-score-threshold-adjusted")
  }
  return notes
}

function normalizeJawSourceBucket(jawOutputSource) {
  const s = String(jawOutputSource || "unknown")
  if (s.includes("blendshape") || s === "mapping-jaw") return "blendshapeJawOpen"
  if (s.includes("mouth-scenario")) return "mouthScenario"
  if (s.includes("geometry")) return "geometryMouthOpen"
  if (s.includes("smoothing")) return "smoothingResidual"
  if (s.includes("fallback") || s.includes("rigWrite")) return "fallback"
  return "unknown"
}

function incrementCount(map, key) {
  map[key] = (map[key] || 0) + 1
}

/** @param {Record<string, unknown>[]} summaryFrames */
export function buildVideoSourceTuningShadowCompareSummary(summaryFrames = []) {
  const frames = summaryFrames.filter((f) => !f.diagnostic?.excludeFromSummary)
  const shadowFrames = frames.filter((f) => f.videoSourceTuningShadow?.enabled)
  if (!shadowFrames.length) {
    return { enabled: false, frameCount: 0 }
  }

  const browUntuned = shadowFrames.map((f) => f.videoSourceTuningShadow?.untuned?.browAbsMax)
  const browTuned = shadowFrames.map((f) => f.videoSourceTuningShadow?.tuned?.browAbsMax)
  const eyeUntuned = shadowFrames.map((f) => f.videoSourceTuningShadow?.untuned?.eyeAbsMax)
  const eyeTuned = shadowFrames.map((f) => f.videoSourceTuningShadow?.tuned?.eyeAbsMax)
  const jawUntuned = shadowFrames.map((f) => f.videoSourceTuningShadow?.untuned?.jawAbsMax)
  const jawTuned = shadowFrames.map((f) => f.videoSourceTuningShadow?.tuned?.jawAbsMax)
  const mouthUntuned = shadowFrames.map((f) => f.videoSourceTuningShadow?.untuned?.mouthAbsMax)
  const mouthTuned = shadowFrames.map((f) => f.videoSourceTuningShadow?.tuned?.mouthAbsMax)
  const rawMouthScores = shadowFrames
    .map((f) => f.rawTrackingSignals?.mouth?.rawMouthScore ?? f.videoSourceTuning?.mouth?.rawMouthScoreBefore)
    .filter((v) => v != null)

  const browUntunedP90 = channelP90(browUntuned)
  const browTunedP90 = channelP90(browTuned)
  const eyeUntunedP90 = channelP90(eyeUntuned)
  const eyeTunedP90 = channelP90(eyeTuned)
  const jawUntunedP90 = channelP90(jawUntuned)
  const jawTunedP90 = channelP90(jawTuned)
  const mouthUntunedP90 = channelP90(mouthUntuned)
  const mouthTunedP90 = channelP90(mouthTuned)

  const mouthThr = resolveMouthScoreSaturationThreshold(rawMouthScores)
  const satThreshold = mouthThr.threshold
  const denom = shadowFrames.length || 1
  const saturatedLegacy = rawMouthScores.filter((v) => num(v) >= MOUTH_SATURATION_THRESHOLD_NORMALIZED).length
  const saturatedFixed = rawMouthScores.filter((v) => num(v) >= satThreshold).length

  const hardClampCount = shadowFrames.filter(
    (f) => f.videoSourceTuningShadow?.browHardClampApplied
  ).length

  const zeroRawUntuned = shadowFrames.filter((f) => {
    return isBlendshapeJawNearZero(f) && num(f.videoSourceTuningShadow?.untuned?.jawAbsMax) > TUNED_JAW_SUSPICIOUS
  }).length

  const zeroRawTuned = shadowFrames.filter((f) => {
    return isBlendshapeJawNearZero(f) && num(f.videoSourceTuningShadow?.tuned?.jawAbsMax) > TUNED_JAW_SUSPICIOUS
  }).length

  const blockedRawZero = shadowFrames.filter((f) => f.videoSourceTuningShadow?.jawBlockedRawZero).length

  return {
    enabled: true,
    frameCount: shadowFrames.length,
    brow: {
      untunedP90: browUntunedP90,
      tunedP90: browTunedP90,
      reductionRatioP90: reductionRatio(browUntunedP90, browTunedP90),
      clampFrameCount: hardClampCount,
      hardClampRatio: roundNum(hardClampCount / denom, 4),
    },
    eye: {
      untunedP90: eyeUntunedP90,
      tunedP90: eyeTunedP90,
      reductionRatioP90: reductionRatio(eyeUntunedP90, eyeTunedP90),
    },
    jaw: {
      untunedP90: jawUntunedP90,
      tunedP90: jawTunedP90,
      reductionRatioP90: reductionRatio(jawUntunedP90, jawTunedP90),
      zeroRawButUntunedOutputFrameCount: zeroRawUntuned,
      zeroRawButTunedOutputFrameCount: zeroRawTuned,
      blockedRawZeroFrameCount: blockedRawZero,
    },
    mouth: {
      untunedP90: mouthUntunedP90,
      tunedP90: mouthTunedP90,
      reductionRatioP90: reductionRatio(mouthUntunedP90, mouthTunedP90),
      rawMouthScoreP90: channelP90(rawMouthScores),
      saturationThreshold: satThreshold,
      saturatedFrameRatioLegacy: roundNum(saturatedLegacy / denom, 4),
      saturatedFrameRatioFixed: roundNum(saturatedFixed / denom, 4),
    },
  }
}

/** @param {Record<string, unknown>[]} summaryFrames */
export function buildJawOutputSourceAnalysis(summaryFrames = []) {
  const frames = summaryFrames.filter((f) => !f.diagnostic?.excludeFromSummary)
  const shadowFrames = frames.filter((f) => f.videoSourceTuningShadow?.enabled)
  if (!shadowFrames.length) {
    return { enabled: false, frameCount: 0 }
  }

  const sourceCounts = {
    blendshapeJawOpen: 0,
    mouthScenario: 0,
    geometryMouthOpen: 0,
    smoothingResidual: 0,
    fallback: 0,
    unknown: 0,
  }
  const zeroRawUntunedOutputSourceCounts = {}
  const zeroRawTunedOutputSourceCounts = {}

  const suspicious = []
  const tunedJawOutliers = []

  for (const f of shadowFrames) {
    const src =
      f.videoSourceTuningShadow?.jawOutputSource ??
      f.rawTrackingSignals?.jaw?.jawOutputSource ??
      "unknown"
    const bucket = normalizeJawSourceBucket(src)
    incrementCount(sourceCounts, bucket)

    const jawSignals = resolveJawFrameSignals(f)
    const untunedJaw = num(f.videoSourceTuningShadow?.untuned?.jawAbsMax)
    const tunedJaw = num(f.videoSourceTuningShadow?.tuned?.jawAbsMax)
    const zeroRaw = isBlendshapeJawNearZero(f)

    if (zeroRaw && untunedJaw > TUNED_JAW_SUSPICIOUS) {
      incrementCount(zeroRawUntunedOutputSourceCounts, bucket)
    }
    if (zeroRaw && tunedJaw > TUNED_JAW_SUSPICIOUS) {
      incrementCount(zeroRawTunedOutputSourceCounts, bucket)
      tunedJawOutliers.push(tunedJaw)
      if (suspicious.length < 20) {
        suspicious.push({
          frameIndex: f.frameIndex ?? null,
          videoTimeMs:
            f.inputSource?.videoTimeMs ??
            f.source?.videoTimeMs ??
            f.timestampMs ??
            null,
          blendshapeJawOpen: jawSignals.blendshapeJawOpen,
          neutralizedJawOpen: jawSignals.neutralizedJawOpen,
          jawOutputSource: src,
          jawSignalBeforeTuning: jawSignals.jawSignalBeforeTuning,
          untunedJawAbsMax: roundNum(untunedJaw, 3),
          tunedJawAbsMax: roundNum(tunedJaw, 3),
        })
      }
    }
  }

  const tunedP90 = tunedJawOutliers.length ? channelP90(tunedJawOutliers) : null

  const zeroRawTunedCount = shadowFrames.filter((f) => {
    return (
      isBlendshapeJawNearZero(f) &&
      num(f.videoSourceTuningShadow?.tuned?.jawAbsMax) > TUNED_JAW_SUSPICIOUS
    )
  }).length

  const geometrySourceCount = sourceCounts.geometryMouthOpen ?? 0
  const totalSources = Object.values(sourceCounts).reduce((a, b) => a + b, 0)

  return {
    enabled: true,
    frameCount: shadowFrames.length,
    sourceCounts,
    zeroRawUntunedOutputSourceCounts,
    zeroRawTunedOutputSourceCounts,
    rawZeroButTunedOutputFrameCount: zeroRawTunedCount,
    rawZeroButTunedOutputP90: tunedP90,
    jawGeometryMouthOpenSourceRatio:
      totalSources > 0 ? roundNum(geometrySourceCount / totalSources, 4) : null,
    suspiciousFrames: suspicious,
  }
}
