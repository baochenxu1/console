#!/usr/bin/env node
/**
 * Phase 2.7–2.11 — Same-frame video tuning shadow compare 验收脚本
 *
 * Usage:
 *   node scripts/check-video-tuning-shadow-compare.js <diagnostic.json>
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { DEFAULT_VIDEO_SOURCE_TUNING } from "../src/sdk/tracking/videoSourceTuning.js"

function loadJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"))
}

function main() {
  const path = process.argv[2]
  if (!path) {
    console.error("Usage: node scripts/check-video-tuning-shadow-compare.js <diagnostic.json>")
    process.exit(2)
  }

  const diagnostic = loadJson(path)
  const summary = diagnostic.summary ?? {}
  const iss = summary.inputSourceSummary ?? {}
  const vtq = summary.videoTrackingQuality ?? {}
  const shadow = summary.videoSourceTuningShadowCompare ?? {}
  const tuningEffect = summary.videoSourceTuningEffect ?? {}
  const resolvedCtx = summary.resolvedSourceContext ?? {}
  const jawAnalysis = summary.jawOutputSourceAnalysis ?? {}
  const jawGain = summary.mappingGainAnalysis?.jaw ?? {}
  const mouthGain = summary.mappingGainAnalysis?.mouth ?? {}
  const mouth = shadow.mouth ?? {}
  const device = summary.device ?? {}
  const devicePreviewSafety = summary.devicePreviewSafety ?? {}
  const options = summary.options ?? diagnostic.options ?? {}
  const diagnosis = summary.videoTrackingDiagnosis ?? {}

  const geometryRatio = jawAnalysis.jawGeometryMouthOpenSourceRatio ?? null
  const rawZeroTunedP90 = jawAnalysis.rawZeroButTunedOutputP90 ?? null
  const rawZeroTunedCount =
    jawAnalysis.rawZeroButTunedOutputFrameCount ??
    shadow.jaw?.zeroRawButTunedOutputFrameCount ??
    null

  const eyeTunedP90 = shadow.eye?.tunedP90 ?? null
  const eyePossiblyTooLow =
    eyeTunedP90 != null && eyeTunedP90 < 12
      ? true
      : diagnosis.notes?.includes("video-eye-output-possibly-too-low") ?? false

  const blendshapeJawOpenP90 = jawGain.blendshapeJawOpenP90 ?? null
  const geometryJawSignalP90 = jawGain.geometryJawSignalP90 ?? null
  const jawRawNamingOk =
    jawGain.rawJawOpenP50 == null &&
    jawGain.rawJawOpenP90 == null &&
    blendshapeJawOpenP90 != null &&
    (blendshapeJawOpenP90 >= 0 || blendshapeJawOpenP90 == null)

  let jawRecommendedAction = "ok"
  if (rawZeroTunedCount > 5 || (rawZeroTunedP90 != null && rawZeroTunedP90 > 4.8)) {
    jawRecommendedAction = "tighten-geometry-mouth-open-gate"
  } else if (geometryRatio != null && geometryRatio > 0.8) {
    jawRecommendedAction = "monitor-geometry-mouth-open"
  }

  const recordingFrameOrderOk = iss.recordingFrameOrderOk ?? null
  const sourceSeqMonotonic = iss.sourceSeqMonotonic ?? null
  const frameIndexMonotonic = iss.frameIndexMonotonic ?? null
  const videoTimeMsMonotonic = iss.videoTimeMsMonotonic ?? null
  const processedFpsFromVideoTime = vtq.processedFpsFromVideoTime ?? null

  const videoFrameCount = iss.sourceTypeCounts?.video ?? summary.frameCount ?? 0
  const resolvedSourceType =
    resolvedCtx.sourceType ??
    (videoFrameCount > 0 ? "video" : options.inputSourceType ?? null)
  const sourceResolvedFrom = resolvedCtx.sourceResolvedFrom ?? null

  const videoNeutralSkipReason = summary.videoNeutralSkipReason ?? null
  const bindingComparisonSkippedCount = summary.bindingComparisonSkippedCount ?? null

  const recordingOrderWarning =
    sourceSeqMonotonic === false ||
    videoTimeMsMonotonic === false ||
    processedFpsFromVideoTime == null
      ? "recording contains stale or out-of-order video frames"
      : null

  const tuningNotAppliedWarning =
    resolvedSourceType === "video" &&
    options.videoSourceTuningEnabled !== false &&
    !tuningEffect.enabled
      ? "video frames detected but video source tuning was not applied"
      : null

  const neutralMisclassifiedWarning =
    resolvedSourceType === "video" && videoNeutralSkipReason === "not-video-tab"
      ? "video neutral misclassified video frame as not-video-tab"
      : null

  const out = {
    file: path,
    frameCount: diagnostic.frameCount ?? summary.frameCount ?? null,
    videoSourceTuningEnabled: options.videoSourceTuningEnabled ?? null,

    resolvedSourceType,
    sourceResolvedFrom,
    videoSourceTuningEnabledOption: options.videoSourceTuningEnabled ?? null,
    videoSourceTuningEffectEnabled: tuningEffect.enabled ?? false,
    videoSourceTuningAppliedFrameCount: tuningEffect.appliedFrameCount ?? 0,
    shadowCompareEnabled: Boolean(shadow.enabled),
    videoNeutralSkipReason,
    bindingComparisonSkippedCount,
    previewOnlyForced: devicePreviewSafety.previewOnlyForced ?? null,

    shadowComparePresent: Boolean(shadow.enabled),
    recordingFrameOrderOk,
    sourceSeqMonotonic,
    frameIndexMonotonic,
    videoTimeMsMonotonic,
    processedFpsFromVideoTime,
    staleFrameDroppedCount: iss.staleFrameDroppedCount ?? null,
    negativeDeltaFrameCount: iss.negativeDeltaFrameCount ?? null,
    recordingOrderWarning,
    tuningNotAppliedWarning,
    neutralMisclassifiedWarning,

    browUntunedP90: shadow.brow?.untunedP90 ?? null,
    browTunedP90: shadow.brow?.tunedP90 ?? null,
    browReductionRatioP90: shadow.brow?.reductionRatioP90 ?? null,
    browHardClampRatio: shadow.brow?.hardClampRatio ?? null,

    eyeSoftLimitEnabled: DEFAULT_VIDEO_SOURCE_TUNING.eye.softLimitEnabled ?? false,
    eyeUntunedP90: shadow.eye?.untunedP90 ?? null,
    eyeTunedP90,
    eyeReductionRatioP90: shadow.eye?.reductionRatioP90 ?? null,
    eyePossiblyTooLow,

    jawGeometryGateEnabled: DEFAULT_VIDEO_SOURCE_TUNING.jaw.geometryGateEnabled ?? false,
    jawUntunedP90: shadow.jaw?.untunedP90 ?? null,
    jawTunedP90: shadow.jaw?.tunedP90 ?? null,
    zeroRawButTunedOutputFrameCount: rawZeroTunedCount,
    rawZeroButTunedOutputP90: rawZeroTunedP90,
    jawOutputSourceCounts: jawAnalysis.sourceCounts ?? {},
    jawGeometryMouthOpenSourceRatio: geometryRatio,
    jawRecommendedAction,

    jawRawNamingOk,
    blendshapeJawOpenP90,
    geometryJawSignalP90,

    mouthUntunedP90: mouth.untunedP90 ?? null,
    mouthTunedP90: mouth.tunedP90 ?? null,
    saturatedFrameRatioLegacy: mouth.saturatedFrameRatioLegacy ?? null,
    saturatedFrameRatioFixed: mouth.saturatedFrameRatioFixed ?? null,

    rawMouthScoreP90: mouthGain.rawMouthScoreP90 ?? null,
    rawMouthScoreP95: mouthGain.rawMouthScoreP95 ?? null,
    rawMouthScoreMax: mouthGain.rawMouthScoreMax ?? null,
    mouthScoreUnitScale: mouthGain.saturationUnitScale ?? null,
    mouthSaturationThreshold: mouthGain.saturationThreshold ?? null,

    suspiciousJawFrames: (jawAnalysis.suspiciousFrames ?? []).slice(0, 5),
    videoQualityWarnings: summary.videoQualityWarnings ?? [],
    videoTrackingDiagnosisNotes: diagnosis.notes ?? [],

    previewOnly: {
      realSentFrameCount: device.realSentFrameCount ?? device.sendFrameCount ?? null,
      realTxCount: device.realTxCount ?? null,
      realBusPacketCount: device.realBusPacketCountGlobal ?? null,
    },
  }

  console.log(JSON.stringify(out, null, 2))

  if (resolvedSourceType === "video" && !out.shadowComparePresent) {
    console.error("FAIL: summary.videoSourceTuningShadowCompare missing or disabled")
    process.exit(1)
  }

  if (recordingOrderWarning) {
    console.error(`WARN: ${recordingOrderWarning}`)
  }
  if (tuningNotAppliedWarning) {
    console.error(`WARN: ${tuningNotAppliedWarning}`)
  }
  if (neutralMisclassifiedWarning) {
    console.error(`WARN: ${neutralMisclassifiedWarning}`)
  }
}

main()
