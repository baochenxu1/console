/**
 * Phase 2.5 — Mapping Gain Analyzer
 * 从 compact diagnostic frames 统计 rawTrackingSignals → FaceRig 增益链路。
 */

import { latencyStats, percentile } from "../../trackingPreview/deviceDriveDiagnostics.js"
import {
  MOUTH_SATURATION_THRESHOLD_NORMALIZED,
  resolveMouthScoreSaturationThreshold,
} from "../videoSourceTuning.js"

const RAW_MOUTH_HIGH = 0.35
const FACE_RIG_MOUTH_HIGH = 15
const RAW_JAW_NEAR_ZERO = 0.05
const FACE_RIG_JAW_HIGH = 10
const BROW_INNER_UP_HIGH = 0.25
const RAW_BROW_HIGH = 0.25
const FACE_RIG_BROW_HIGH = 12
const FACE_RIG_EYE_TUNING_HIGH = 35
const FACE_RIG_EYE_TUNING_NORMALIZED_MIN = 15
const FACE_RIG_EYE_TUNING_TOO_LOW = 12
const EYE_BLINK_HIGH = 0.35
const NEUTRAL_REDUCTION_THRESHOLD = 0.4
const LANDMARK_JITTER_HIGH_PX = 3

function roundNum(v, digits = 4) {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  const f = 10 ** digits
  return Math.round(n * f) / f
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** @param {Record<string, unknown>[]} frames @param {(f: Record<string, unknown>) => unknown} getter */
function collectNumeric(frames, getter) {
  const values = []
  let unavailableCount = 0
  for (const f of frames) {
    const raw = getter(f)
    if (raw === undefined || raw === null || !Number.isFinite(Number(raw))) {
      unavailableCount++
      continue
    }
    values.push(Number(raw))
  }
  return { values, sampleCount: values.length, unavailableCount }
}

function p50p90(values) {
  const stats = latencyStats(values)
  if (!stats.count) {
    return { p50: null, p90: null, sampleCount: 0 }
  }
  return { p50: stats.p50, p90: stats.p90, sampleCount: stats.count }
}

function metricP50P90(collected) {
  const { values, sampleCount, unavailableCount } = collected
  const { p50, p90 } = p50p90(values)
  if (!sampleCount) {
    return { p50: null, p90: null, sampleCount: 0, unavailableCount, unavailable: true }
  }
  return {
    p50: roundNum(p50, 4),
    p90: roundNum(p90, 4),
    sampleCount,
    unavailableCount,
    unavailable: false,
  }
}

function metricMouthScoreDistribution(collected) {
  const { values, sampleCount, unavailableCount } = collected
  if (!sampleCount) {
    return {
      p50: null,
      p90: null,
      p95: null,
      p99: null,
      max: null,
      sampleCount: 0,
      unavailableCount,
      unavailable: true,
    }
  }
  const stats = latencyStats(values)
  return {
    p50: roundNum(stats.p50, 4),
    p90: roundNum(stats.p90, 4),
    p95: roundNum(percentile(values, 95), 4),
    p99: roundNum(percentile(values, 99), 4),
    max: roundNum(stats.max, 4),
    sampleCount,
    unavailableCount,
    unavailable: false,
  }
}

function estimatedGain(outputP90, rawP90) {
  if (outputP90 == null || rawP90 == null || rawP90 <= 1e-6) {
    return { value: null, unavailable: true }
  }
  return { value: roundNum(outputP90 / rawP90, 2), unavailable: false }
}

function faceRigMouthAbs(f) {
  return f.summaryChannels?.mouthAbsMax ?? null
}

function faceRigJawAbs(f) {
  return f.summaryChannels?.jawAbsMax ?? null
}

function faceRigBrowAbs(f) {
  return f.brow?.faceRigAbsMax ?? f.summaryChannels?.browAbsMax ?? null
}

function mappingBrowFinalAbs(f) {
  return f.brow?.mappingAbsMax ?? null
}

function faceRigEyeAbs(f) {
  return f.summaryChannels?.eyeAbsMax ?? null
}

function rawBlend(f, key) {
  return f.rawTrackingSignals?.blendshapes?.[key] ?? null
}

function countByGateAction(frames) {
  const counts = {}
  let unavailableCount = 0
  for (const f of frames) {
    const action =
      f.rawTrackingSignals?.brow?.gateAction ??
      f.mapping?.brows?.gate?.gateAction ??
      f.mapping?.browGate?.gateAction ??
      null
    if (!action) {
      unavailableCount++
      continue
    }
    const key = String(action)
    counts[key] = (counts[key] || 0) + 1
  }
  return { counts, unavailableCount, sampleCount: frames.length - unavailableCount }
}

function gateActionRatio(frames, predicate) {
  const gate = countByGateAction(frames)
  const matched = Object.entries(gate.counts).reduce(
    (sum, [action, n]) => (predicate(action) ? sum + n : sum),
    0
  )
  const denom = frames.length
  return denom ? roundNum(matched / denom, 4) : null
}

function countScenario(frames) {
  const counts = {}
  let unavailableCount = 0
  for (const f of frames) {
    const scenario = f.rawTrackingSignals?.mouth?.scenario ?? null
    if (!scenario) {
      unavailableCount++
      continue
    }
    const key = String(scenario)
    counts[key] = (counts[key] || 0) + 1
  }
  return { counts, unavailableCount }
}

/**
 * @param {Record<string, unknown>[]} summaryFrames
 */
export function buildMappingGainAnalysis(summaryFrames = []) {
  const frames = summaryFrames.filter((f) => !f.diagnostic?.excludeFromSummary)
  const frameCount = frames.length

  const rawMouthScore = collectNumeric(frames, (f) => f.rawTrackingSignals?.mouth?.rawMouthScore)
  const mouthOpenRatio = collectNumeric(frames, (f) => f.rawTrackingSignals?.mouth?.mouthOpenRatio)
  const faceRigMouth = collectNumeric(frames, faceRigMouthAbs)
  const blendshapeJawOpen = collectNumeric(frames, (f) =>
    f.rawTrackingSignals?.jaw?.blendshapeJawOpen ?? f.rawTrackingSignals?.blendshapes?.jawOpen
  )
  const geometryJawSignal = collectNumeric(frames, (f) => f.rawTrackingSignals?.jaw?.geometryJawSignal)
  const finalJawBeforeTuning = collectNumeric(frames, (f) =>
    f.rawTrackingSignals?.jaw?.finalBeforeTuning ??
    f.rawTrackingSignals?.jaw?.jawSignalBeforeTuning
  )
  const faceRigJaw = collectNumeric(frames, faceRigJawAbs)
  const rawBrowLeft = collectNumeric(frames, (f) => f.rawTrackingSignals?.brow?.rawBrowLeft)
  const rawBrowRight = collectNumeric(frames, (f) => f.rawTrackingSignals?.brow?.rawBrowRight)
  const browInnerUp = collectNumeric(frames, (f) => rawBlend(f, "browInnerUp"))
  const faceRigBrow = collectNumeric(frames, faceRigBrowAbs)
  const mappingBrowFinal = collectNumeric(frames, mappingBrowFinalAbs)
  const eyeBlinkLeft = collectNumeric(frames, (f) => rawBlend(f, "eyeBlinkLeft"))
  const eyeBlinkRight = collectNumeric(frames, (f) => rawBlend(f, "eyeBlinkRight"))
  const eyeWideLeft = collectNumeric(frames, (f) => rawBlend(f, "eyeWideLeft"))
  const eyeWideRight = collectNumeric(frames, (f) => rawBlend(f, "eyeWideRight"))
  const faceRigEye = collectNumeric(frames, faceRigEyeAbs)

  const rawMouthStats = metricMouthScoreDistribution(rawMouthScore)
  const mouthOpenStats = metricP50P90(mouthOpenRatio)
  const faceRigMouthStats = metricP50P90(faceRigMouth)
  const blendshapeJawStats = metricP50P90(blendshapeJawOpen)
  const geometryJawSignalStats = metricP50P90(geometryJawSignal)
  const finalJawBeforeTuningStats = metricP50P90(finalJawBeforeTuning)
  const faceRigJawStats = metricP50P90(faceRigJaw)
  const rawBrowLeftStats = metricP50P90(rawBrowLeft)
  const rawBrowRightStats = metricP50P90(rawBrowRight)
  const browInnerUpStats = metricP50P90(browInnerUp)
  const faceRigBrowStats = metricP50P90(faceRigBrow)
  const mappingBrowFinalStats = metricP50P90(mappingBrowFinal)
  const eyeBlinkLeftStats = metricP50P90(eyeBlinkLeft)
  const eyeBlinkRightStats = metricP50P90(eyeBlinkRight)
  const eyeWideLeftStats = metricP50P90(eyeWideLeft)
  const eyeWideRightStats = metricP50P90(eyeWideRight)
  const faceRigEyeStats = metricP50P90(faceRigEye)

  const mouthSaturation = resolveMouthScoreSaturationThreshold(rawMouthScore.values)
  const mouthSatThreshold = mouthSaturation.threshold
  const mouthSaturatedFrames = rawMouthScore.values.filter((v) => v >= mouthSatThreshold).length
  const mouthSaturatedLegacyFrames = rawMouthScore.values.filter(
    (v) => v >= MOUTH_SATURATION_THRESHOLD_NORMALIZED
  ).length

  const zeroBlendshapeJawButOutput = frames.filter((f) => {
    const blend =
      f.rawTrackingSignals?.jaw?.blendshapeJawOpen ?? f.rawTrackingSignals?.blendshapes?.jawOpen
    const out = faceRigJawAbs(f)
    if (blend == null || out == null) return false
    return Number(blend) < RAW_JAW_NEAR_ZERO && num(out) > FACE_RIG_JAW_HIGH
  }).length

  const zeroBlendshapeJawButTunedOutput = frames.filter((f) => {
    const blend =
      f.rawTrackingSignals?.jaw?.blendshapeJawOpen ?? f.rawTrackingSignals?.blendshapes?.jawOpen
    const tunedOut =
      f.videoSourceTuningShadow?.tuned?.jawAbsMax ?? faceRigJawAbs(f)
    if (blend == null || tunedOut == null) return false
    return Number(blend) < RAW_JAW_NEAR_ZERO && num(tunedOut) > FACE_RIG_JAW_HIGH
  }).length

  const gate = countByGateAction(frames)
  const scenarios = countScenario(frames)

  const rawTrackingSignalsFrameCount = frames.filter((f) => f.rawTrackingSignals).length
  const compactFallbackMasksRaw =
    rawTrackingSignalsFrameCount === 0 && frameCount > 0

  return {
    frameCount,
    rawTrackingSignalsFrameCount,
    compactFallbackMasksRaw,
    mouth: {
      rawMouthScoreP50: rawMouthStats.p50,
      rawMouthScoreP90: rawMouthStats.p90,
      rawMouthScoreP95: rawMouthStats.p95,
      rawMouthScoreP99: rawMouthStats.p99,
      rawMouthScoreMax: rawMouthStats.max,
      rawMouthScoreSampleCount: rawMouthStats.sampleCount,
      rawMouthScoreUnavailableCount: rawMouthStats.unavailableCount,
      rawMouthScoreUnavailable: rawMouthStats.unavailable,
      mouthOpenRatioP50: mouthOpenStats.p50,
      mouthOpenRatioP90: mouthOpenStats.p90,
      mouthOpenRatioUnavailable: mouthOpenStats.unavailable,
      faceRigMouthAbsMaxP50: faceRigMouthStats.p50,
      faceRigMouthAbsMaxP90: faceRigMouthStats.p90,
      estimatedGainRawScoreToOutput: estimatedGain(
        faceRigMouthStats.p90,
        rawMouthStats.p90
      ).value,
      estimatedGainUnavailable: estimatedGain(faceRigMouthStats.p90, rawMouthStats.p90).unavailable,
      saturationThreshold: mouthSatThreshold,
      saturationUnitScale: mouthSaturation.unitScale,
      saturatedFrameRatio: rawMouthScore.sampleCount
        ? roundNum(mouthSaturatedFrames / rawMouthScore.sampleCount, 4)
        : null,
      saturatedFrameRatioLegacy: rawMouthScore.sampleCount
        ? roundNum(mouthSaturatedLegacyFrames / rawMouthScore.sampleCount, 4)
        : null,
      scenarioCounts: scenarios.counts,
      scenarioUnavailableCount: scenarios.unavailableCount,
    },
    jaw: {
      blendshapeJawOpenP50: blendshapeJawStats.p50,
      blendshapeJawOpenP90: blendshapeJawStats.p90,
      blendshapeJawOpenSampleCount: blendshapeJawStats.sampleCount,
      blendshapeJawOpenUnavailableCount: blendshapeJawStats.unavailableCount,
      blendshapeJawOpenUnavailable: blendshapeJawStats.unavailable,
      geometryJawSignalP50: geometryJawSignalStats.p50,
      geometryJawSignalP90: geometryJawSignalStats.p90,
      geometryJawSignalUnavailable: geometryJawSignalStats.unavailable,
      finalJawBeforeTuningP50: finalJawBeforeTuningStats.p50,
      finalJawBeforeTuningP90: finalJawBeforeTuningStats.p90,
      finalJawBeforeTuningUnavailable: finalJawBeforeTuningStats.unavailable,
      faceRigJawAbsMaxP50: faceRigJawStats.p50,
      faceRigJawAbsMaxP90: faceRigJawStats.p90,
      estimatedGainBlendshapeToOutput: estimatedGain(
        faceRigJawStats.p90,
        blendshapeJawStats.p90
      ).value,
      estimatedGainUnavailable: estimatedGain(faceRigJawStats.p90, blendshapeJawStats.p90)
        .unavailable,
      zeroBlendshapeJawButOutputFrameCount: zeroBlendshapeJawButOutput,
      zeroBlendshapeJawButTunedOutputFrameCount: zeroBlendshapeJawButTunedOutput,
    },
    brow: {
      rawBrowLeftP90: rawBrowLeftStats.p90,
      rawBrowRightP90: rawBrowRightStats.p90,
      rawBrowUnavailable:
        rawBrowLeftStats.unavailable && rawBrowRightStats.unavailable,
      browInnerUpP90: browInnerUpStats.p90,
      browInnerUpUnavailable: browInnerUpStats.unavailable,
      faceRigBrowAbsMaxP90: faceRigBrowStats.p90,
      mappingBrowFinalAbsMaxP90: mappingBrowFinalStats.p90,
      estimatedGainRawToOutput: estimatedGain(faceRigBrowStats.p90, Math.max(
        num(rawBrowLeftStats.p90),
        num(rawBrowRightStats.p90)
      )).value,
      estimatedGainUnavailable: estimatedGain(
        faceRigBrowStats.p90,
        Math.max(num(rawBrowLeftStats.p90), num(rawBrowRightStats.p90))
      ).unavailable,
      gateActionCounts: gate.counts,
      gateActionUnavailableCount: gate.unavailableCount,
      lockZeroFrameRatio: gateActionRatio(frames, (a) => a === "lock_zero" || a.startsWith("lock_zero")),
      passExplicitFrameRatio: gateActionRatio(
        frames,
        (a) => a === "pass_explicit" || a.includes("pass_explicit")
      ),
    },
    eye: {
      eyeBlinkLeftP90: eyeBlinkLeftStats.p90,
      eyeBlinkRightP90: eyeBlinkRightStats.p90,
      eyeWideLeftP90: eyeWideLeftStats.p90,
      eyeWideRightP90: eyeWideRightStats.p90,
      eyeBlinkUnavailable:
        eyeBlinkLeftStats.unavailable && eyeBlinkRightStats.unavailable,
      faceRigEyeAbsMaxP90: faceRigEyeStats.p90,
      estimatedGainBlinkToOutput: estimatedGain(
        faceRigEyeStats.p90,
        Math.max(num(eyeBlinkLeftStats.p90), num(eyeBlinkRightStats.p90))
      ).value,
      estimatedGainUnavailable: estimatedGain(
        faceRigEyeStats.p90,
        Math.max(num(eyeBlinkLeftStats.p90), num(eyeBlinkRightStats.p90))
      ).unavailable,
    },
  }
}

function reductionRatioP90(rawP90, neutralP90) {
  if (rawP90 == null || neutralP90 == null || rawP90 <= 0) return null
  return roundNum(1 - neutralP90 / rawP90, 4)
}

/**
 * @param {Record<string, unknown>[]} frameDiagnostics videoNeutral per-frame diags
 * @param {boolean} enabled calibration configured + enabled
 */
export function buildVideoNeutralEffectP90(frameDiagnostics = [], enabled = false) {
  const applied = frameDiagnostics.filter((d) => d?.applied)
  if (!enabled || !applied.length) {
    return { enabled: false, appliedFrameCount: 0 }
  }

  const channel = (pickRaw, pickNeu) => {
    const rawVals = applied
      .map(pickRaw)
      .filter((v) => v != null && Number.isFinite(Number(v)))
      .map(Number)
    const neuVals = applied
      .map(pickNeu)
      .filter((v) => v != null && Number.isFinite(Number(v)))
      .map(Number)
    const rawStats = p50p90(rawVals)
    const neuStats = p50p90(neuVals)
    return {
      rawP90: rawStats.p90 != null ? roundNum(rawStats.p90, 3) : null,
      neutralizedP90: neuStats.p90 != null ? roundNum(neuStats.p90, 3) : null,
      reductionRatioP90: reductionRatioP90(rawStats.p90, neuStats.p90),
      unavailable: !rawStats.sampleCount,
    }
  }

  const brow = channel((d) => d.rawSignals?.browAbsMax, (d) => d.neutralizedSignals?.browAbsMax)
  const jaw = channel((d) => d.rawSignals?.jawAbsMax, (d) => d.neutralizedSignals?.jawAbsMax)
  const mouth = channel((d) => d.rawSignals?.mouthAbsMax, (d) => d.neutralizedSignals?.mouthAbsMax)
  const eye = channel((d) => d.rawSignals?.eyeAbsMax, (d) => d.neutralizedSignals?.eyeAbsMax)

  return {
    enabled: true,
    appliedFrameCount: applied.length,
    browRawP90: brow.rawP90,
    browNeutralizedP90: brow.neutralizedP90,
    browReductionRatioP90: brow.reductionRatioP90,
    jawRawP90: jaw.rawP90,
    jawNeutralizedP90: jaw.neutralizedP90,
    jawReductionRatioP90: jaw.reductionRatioP90,
    mouthRawP90: mouth.rawP90,
    mouthNeutralizedP90: mouth.neutralizedP90,
    mouthReductionRatioP90: mouth.reductionRatioP90,
    eyeRawP90: eye.rawP90,
    eyeNeutralizedP90: eye.neutralizedP90,
    eyeReductionRatioP90: eye.reductionRatioP90,
  }
}

/**
 * @param {ReturnType<typeof buildMappingGainAnalysis>} mappingGainAnalysis
 * @param {ReturnType<typeof buildVideoNeutralEffectP90>} videoNeutralEffectP90
 * @param {Record<string, unknown> | null} faceScaleStability
 * @param {Record<string, unknown> | null} videoTrackingQuality
 * @param {Record<string, unknown> | null} [videoSourceTuningEffect]
 * @param {Record<string, unknown> | null} [videoSourceTuningShadowCompare]
 */
export function buildVideoTrackingDiagnosis(
  mappingGainAnalysis,
  videoNeutralEffectP90,
  faceScaleStability,
  videoTrackingQuality,
  videoSourceTuningEffect = null,
  videoSourceTuningShadowCompare = null
) {
  const likelyCauses = []
  const notes = []

  const mouth = mappingGainAnalysis?.mouth ?? {}
  const jaw = mappingGainAnalysis?.jaw ?? {}
  const brow = mappingGainAnalysis?.brow ?? {}
  const eye = mappingGainAnalysis?.eye ?? {}

  if (!mouth.rawMouthScoreUnavailable) {
    const rawHigh = num(mouth.rawMouthScoreP90) >= RAW_MOUTH_HIGH
    const outHigh = num(mouth.faceRigMouthAbsMaxP90) >= FACE_RIG_MOUTH_HIGH
    if (rawHigh && outHigh) {
      likelyCauses.push("raw-mouth-input-high")
    } else if (!rawHigh && outHigh) {
      likelyCauses.push("mouth-mapping-gain-high")
    }
  }

  if (!jaw.blendshapeJawOpenUnavailable) {
    if (
      num(jaw.blendshapeJawOpenP90) < RAW_JAW_NEAR_ZERO &&
      num(jaw.faceRigJawAbsMaxP90) >= FACE_RIG_JAW_HIGH
    ) {
      likelyCauses.push("jaw-output-with-zero-blendshape")
    }
  } else if (jaw.zeroBlendshapeJawButOutputFrameCount > 0) {
    likelyCauses.push("jaw-output-with-zero-blendshape")
  }

  const browRawMax = Math.max(num(brow.rawBrowLeftP90), num(brow.rawBrowRightP90))
  const browOutHigh = num(brow.faceRigBrowAbsMaxP90) >= FACE_RIG_BROW_HIGH
  if (!brow.browInnerUpUnavailable && num(brow.browInnerUpP90) >= BROW_INNER_UP_HIGH && browOutHigh) {
    likelyCauses.push("raw-brow-blendshape-high")
  }
  if (!brow.rawBrowUnavailable && browRawMax < RAW_BROW_HIGH && browOutHigh) {
    likelyCauses.push("brow-mapping-gain-high")
  }

  if (videoNeutralEffectP90?.enabled) {
    const reductions = [
      videoNeutralEffectP90.browReductionRatioP90,
      videoNeutralEffectP90.jawReductionRatioP90,
      videoNeutralEffectP90.mouthReductionRatioP90,
      videoNeutralEffectP90.eyeReductionRatioP90,
    ].filter((r) => r != null && Number.isFinite(Number(r)))
    if (reductions.some((r) => num(r) >= NEUTRAL_REDUCTION_THRESHOLD)) {
      likelyCauses.push("neutral-baseline-offset")
    }
  }

  const roiMode = String(faceScaleStability?.trackingMode ?? "")
  const roiEnabled =
    roiMode.includes("roi") ||
    num(faceScaleStability?.roiEnabledFrameCount) > 0
  if (roiEnabled) {
    const noseP90 = num(videoTrackingQuality?.noseDeltaPxP90)
    const mouthP90 = num(videoTrackingQuality?.mouthCenterDeltaPxP90)
    const eyeP90 = num(videoTrackingQuality?.eyeCenterDeltaPxP90)
    const landmarkStillHigh =
      noseP90 >= LANDMARK_JITTER_HIGH_PX ||
      mouthP90 >= LANDMARK_JITTER_HIGH_PX ||
      eyeP90 >= LANDMARK_JITTER_HIGH_PX
    if (landmarkStillHigh) {
      notes.push("roi-improves-input-scale-but-not-landmark-stability")
    }
  }

  if (mappingGainAnalysis?.compactFallbackMasksRaw) {
    notes.push("raw-tracking-signals-unavailable-compact-fallback")
  }

  const tuningOn = videoSourceTuningEffect?.enabled === true
  const eyeOutputP90 = tuningOn
    ? num(
        videoSourceTuningShadowCompare?.eye?.tunedP90 ??
          videoSourceTuningEffect?.eye?.afterP90 ??
          eye.faceRigEyeAbsMaxP90
      )
    : num(eye.faceRigEyeAbsMaxP90)

  if (tuningOn) {
    if (eyeOutputP90 > FACE_RIG_EYE_TUNING_HIGH) {
      likelyCauses.push("eye-mapping-gain-high")
    } else if (
      eyeOutputP90 >= FACE_RIG_EYE_TUNING_TOO_LOW &&
      eyeOutputP90 <= FACE_RIG_EYE_TUNING_HIGH
    ) {
      notes.push("video-eye-output-normalized")
    } else if (eyeOutputP90 < FACE_RIG_EYE_TUNING_TOO_LOW) {
      notes.push("video-eye-output-possibly-too-low")
    }
  } else if (
    !eye.eyeBlinkUnavailable &&
    Math.max(num(eye.eyeBlinkLeftP90), num(eye.eyeBlinkRightP90)) >= EYE_BLINK_HIGH &&
    eyeOutputP90 >= 8
  ) {
    likelyCauses.push("raw-eye-blink-high")
  } else if (
    !eye.eyeBlinkUnavailable &&
    Math.max(num(eye.eyeBlinkLeftP90), num(eye.eyeBlinkRightP90)) < EYE_BLINK_HIGH &&
    eyeOutputP90 >= 8
  ) {
    likelyCauses.push("eye-mapping-gain-high")
  }

  const uniqueCauses = [...new Set(likelyCauses)]
  let confidence = "low"
  if (uniqueCauses.length >= 2) {
    confidence = "high"
  } else if (uniqueCauses.length === 1) {
    confidence = "medium"
  }

  return {
    likelyCauses: uniqueCauses,
    confidence,
    notes,
  }
}
