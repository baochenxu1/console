/**
 * Phase 2.12 — AI-Review diagnostic export（保留帧级原始标量，剔除 landmark / overlay 大字段）。
 */

export const TRACKING_DIAGNOSTIC_AI_REVIEW_SCHEMA = "tracking-diagnostic-ai-review-v1"

export const DIAGNOSTIC_EXPORT_MODES = /** @type {const} */ ({
  FULL: "full",
  AI_REVIEW: "ai-review",
})

/** frameSeries 列定义（顺序即 rows 中每行值的顺序） */
export const AI_REVIEW_FRAME_COLUMNS = [
  "frameIndex",
  "sourceSeq",
  "inputFrameIndex",
  "timestampMs",
  "videoTimeMs",
  "sourceType",
  "seekEpoch",
  "faceDetected",

  "summaryChannels.eyeAbsMax",
  "summaryChannels.browAbsMax",
  "summaryChannels.mouthAbsMax",
  "summaryChannels.jawAbsMax",
  "brow.faceRigAbsMax",
  "brow.mappingAbsMax",
  "brow.bindingComparisonSkipped",
  "brow.bindingComparisonSkipReason",

  "rawTrackingSignals.blendshapes.browInnerUp",
  "rawTrackingSignals.blendshapes.eyeBlinkLeft",
  "rawTrackingSignals.blendshapes.eyeBlinkRight",
  "rawTrackingSignals.blendshapes.eyeWideLeft",
  "rawTrackingSignals.blendshapes.eyeWideRight",
  "rawTrackingSignals.blendshapes.jawOpen",
  "rawTrackingSignals.mouth.rawMouthScore",
  "rawTrackingSignals.mouth.scenario",
  "rawTrackingSignals.mouth.mouthWidthPx",
  "rawTrackingSignals.brow.rawBrowLeft",
  "rawTrackingSignals.brow.rawBrowRight",
  "rawTrackingSignals.brow.gateAction",
  "rawTrackingSignals.jaw.blendshapeJawOpen",
  "rawTrackingSignals.jaw.neutralizedJawOpen",
  "rawTrackingSignals.jaw.geometryJawSignal",
  "rawTrackingSignals.jaw.jawSignalBeforeTuning",
  "rawTrackingSignals.jaw.finalBeforeTuning",
  "rawTrackingSignals.jaw.finalAfterTuning",
  "rawTrackingSignals.jaw.jawOutputSource",

  "videoSourceTuning.enabled",
  "videoSourceTuning.applied",
  "videoSourceTuning.sourceType",
  "videoSourceTuning.brow.inputBefore",
  "videoSourceTuning.brow.inputAfter",
  "videoSourceTuning.brow.outputBeforeAbsMax",
  "videoSourceTuning.brow.outputAfterAbsMax",
  "videoSourceTuning.brow.softLimitApplied",
  "videoSourceTuning.brow.hardClampApplied",
  "videoSourceTuning.eye.outputBeforeAbsMax",
  "videoSourceTuning.eye.outputAfterAbsMax",
  "videoSourceTuning.eye.softLimitApplied",
  "videoSourceTuning.eye.clampApplied",
  "videoSourceTuning.jaw.blendshapeJawOpen",
  "videoSourceTuning.jaw.rawJawOpen",
  "videoSourceTuning.jaw.jawOutputSource",
  "videoSourceTuning.jaw.jawOutputBeforeAbsMax",
  "videoSourceTuning.jaw.jawOutputAfterAbsMax",
  "videoSourceTuning.jaw.blockedBecauseRawJawZero",
  "videoSourceTuning.jaw.geometryGateApplied",
  "videoSourceTuning.jaw.geometryGateReason",
  "videoSourceTuning.mouth.rawMouthScoreBefore",
  "videoSourceTuning.mouth.rawMouthScoreAfter",
  "videoSourceTuning.mouth.outputBeforeAbsMax",
  "videoSourceTuning.mouth.outputAfterAbsMax",

  "videoSourceTuningShadow.enabled",
  "videoSourceTuningShadow.outputMode",
  "videoSourceTuningShadow.appliedToPreviewRig",
  "videoSourceTuningShadow.untuned.browAbsMax",
  "videoSourceTuningShadow.untuned.eyeAbsMax",
  "videoSourceTuningShadow.untuned.jawAbsMax",
  "videoSourceTuningShadow.untuned.mouthAbsMax",
  "videoSourceTuningShadow.tuned.browAbsMax",
  "videoSourceTuningShadow.tuned.eyeAbsMax",
  "videoSourceTuningShadow.tuned.jawAbsMax",
  "videoSourceTuningShadow.tuned.mouthAbsMax",
  "videoSourceTuningShadow.jawOutputSource",
  "videoSourceTuningShadow.jawBlockedRawZero",
  "videoSourceTuningShadow.geometryGateApplied",
  "videoSourceTuningShadow.browHardClampApplied",
  "videoSourceTuningShadow.browSoftLimitApplied",

  "videoNeutral.enabled",
  "videoNeutral.applied",
  "videoNeutral.skipReason",
  "videoNeutral.rawSignals.browAbsMax",
  "videoNeutral.rawSignals.jawAbsMax",
  "videoNeutral.rawSignals.mouthAbsMax",
  "videoNeutral.rawSignals.eyeAbsMax",
  "videoNeutral.neutralizedSignals.browAbsMax",
  "videoNeutral.neutralizedSignals.jawAbsMax",
  "videoNeutral.neutralizedSignals.mouthAbsMax",
  "videoNeutral.neutralizedSignals.eyeAbsMax",

  "trackingDebug.landmarkMotion.noseDeltaPx",
  "trackingDebug.landmarkMotion.mouthCenterDeltaPx",
  "trackingDebug.landmarkMotion.eyeCenterDeltaPx",
  "trackingDebug.landmarkMotion.faceBoxCenterDeltaPx",
  "trackingDebug.motionContext.deltaSourceSeq",
  "trackingDebug.motionContext.deltaFrameIndex",
  "trackingDebug.motionContext.deltaVideoTimeMs",
  "trackingDebug.motionContext.skippedFrameLikely",
  "trackingDebug.faceSize.fullFaceBoxAreaRatio",
  "trackingDebug.faceScale.faceCoverageRatio",
  "trackingDebug.faceScale.inferenceInputFaceCoverageRatio",
  "trackingDebug.faceScale.roiEnabled",
  "trackingDebug.faceScale.roiWidthPx",
  "trackingDebug.faceScale.roiHeightPx",

  "debug.gaze.gazeEstimatorMode",
  "debug.gaze.irisOnlyActive",
  "debug.gaze.irisLocalMode",
  "debug.gaze.irisInitState",
  "debug.gaze.irisInitReady",
  "debug.gaze.irisInitSampleCount",
  "debug.gaze.irisInitRequiredSamples",
  "debug.gaze.irisInitRemainingMs",
  "debug.gaze.irisLocalX",
  "debug.gaze.irisLocalY",
  "debug.gaze.irisLocalScale",
  "debug.gaze.leftIrisLocalX",
  "debug.gaze.leftIrisLocalY",
  "debug.gaze.rightIrisLocalX",
  "debug.gaze.rightIrisLocalY",
  "debug.gaze.neutralIrisLocalX",
  "debug.gaze.neutralIrisLocalY",
  "debug.gaze.neutralIrisLocalScale",
  "debug.gaze.irisLocalDx",
  "debug.gaze.irisLocalDy",
  "debug.gaze.irisLocalFusion",
  "debug.gaze.irisWarmupSampleCount",
  "debug.gaze.irisHeadMotionPx",
  "debug.gaze.irisGlobalDx",
  "debug.gaze.irisGlobalDy",
  "debug.gaze.irisLeftCx",
  "debug.gaze.irisLeftCy",
  "debug.gaze.irisRightCx",
  "debug.gaze.irisRightCy",
  "debug.gaze.irisCx",
  "debug.gaze.irisCy",
  "debug.gaze.irisScale",
  "debug.gaze.neutralIrisCx",
  "debug.gaze.neutralIrisCy",
  "debug.gaze.neutralIrisScale",
  "debug.gaze.irisXNorm",
  "debug.gaze.irisYNorm",
  "debug.gaze.candidateSharedRadarX",
  "debug.gaze.candidateSharedRadarY",
  "debug.gaze.emittedSharedRadarX",
  "debug.gaze.emittedSharedRadarY",
  "debug.gaze.outputMode",
  "rig.sharedRadar.x",
  "rig.sharedRadar.y",
  "eye_xy.x",
  "eye_xy.y",
  "eyeXYStabilizer.outputX",
  "eyeXYStabilizer.outputY",
  "eyeXYStabilizer.inputX",
  "eyeXYStabilizer.inputY",
  "eyeXYStabilizer.stateX",
  "eyeXYStabilizer.stateY",
  "eyeXYStabilizer.actionX",
  "eyeXYStabilizer.actionY",
  "eyeXYStabilizer.activationThresholdX",
  "eyeXYStabilizer.activationThresholdY",
  "eyeXYStabilizer.releaseThresholdX",
  "eyeXYStabilizer.releaseThresholdY",
  "faceRigUi.eyeXYDotXNorm",
  "faceRigUi.eyeXYDotYNorm",

  // Gaze Diagnostic Phase 1 — Browser intermediates + head pose (additive; missing → null)
  "trackingRuntime",
  "gazeRawX",
  "gazeRawY",
  "gazeNeutralX",
  "gazeNeutralY",
  "gazeNeutralReady",
  "gazeNeutralSampleCount",
  "gazeEyeLookX",
  "gazeEyeLookY",
  "gazeCandidateSharedRadarX",
  "gazeCandidateSharedRadarY",
  "gazeEmittedSharedRadarX",
  "gazeEmittedSharedRadarY",
  "headPoseAvailable",
  "headYawProxy",
  "headPitchProxy",
  "headRollDeg",

  // Gaze Shadow Compare Phase 1 — iris-only shadow (additive; missing → null)
  "gazeShadowAvailable",
  "gazeShadowRawX",
  "gazeShadowRawY",
  "gazeShadowNormalizedX",
  "gazeShadowNormalizedY",
  "gazeShadowNeutralX",
  "gazeShadowNeutralY",
  "gazeShadowNeutralReady",
  "gazeShadowCandidateSharedRadarX",
  "gazeShadowCandidateSharedRadarY",
  "gazeShadowEmittedSharedRadarX",
  "gazeShadowEmittedSharedRadarY",
  "gazeShadowOutputMode",

  // Gaze V2 — eye-local algorithm diagnostics
  "gazeAlgorithm",
  "gazeV2GeometryMode",
  "gazeV2BinocularDisagreement",
  "gazeV2DisagreementX",
  "gazeV2DisagreementY",
  "gazeV2LeftWeight",
  "gazeV2RightWeight",
  "gazeV2LeftReliability",
  "gazeV2RightReliability",
  "gazeV2LeftNormalizedX",
  "gazeV2LeftNormalizedY",
  "gazeV2RightNormalizedX",
  "gazeV2RightNormalizedY",
  "gazeV2FusedBeforeDisagreementX",
  "gazeV2FusedBeforeDisagreementY",
  "gazeV2FusedAfterDisagreementX",
  "gazeV2FusedAfterDisagreementY",
  "gazeV2ArbitrationModeX",
  "gazeV2ArbitrationModeY",
  "gazeV2VerticalReferenceSource",
  "gazeV2HoldReason",
  "gazeV2BothEyesUnreliable",
  "gazeV2LeftEyeOpenness",
  "gazeV2RightEyeOpenness",
  "gazeV2NeutralEyeOpennessLeft",
  "gazeV2NeutralEyeOpennessRight",
  "gazeV2LeftOpennessRatio",
  "gazeV2RightOpennessRatio",
  "gazeV2LeftTrackingValid",
  "gazeV2RightTrackingValid",
  "gazeV2LeftIrisValid",
  "gazeV2RightIrisValid",
  "gazeV2LeftClosureCandidate",
  "gazeV2RightClosureCandidate",
  "gazeV2TrueClosureActive",
  "gazeV2ClosureEnterCount",
  "gazeV2ClosureReleaseCount",
  "gazeV2VerticalPolarity",
  "gazeV2VerticalSignalPrePolarity",
  "gazeV2VerticalSignalPostPolarity",
  "gazeV2VerticalFilteredSignal",
  "gazeV2VerticalDirection",
  "gazeV2VerticalFullScaleUsed",
  "gazeV2VerticalResponseNormalized",
  "gazeV2VerticalMappedY",
  "gazeV2LeftGeometryValid",
  "gazeV2RightGeometryValid",
  "gazeV2ClosureDecisionReasonLeft",
  "gazeV2ClosureDecisionReasonRight",
  "gazeV2LeftCanonicalX",
  "gazeV2LeftCanonicalY",
  "gazeV2RightCanonicalX",
  "gazeV2RightCanonicalY",
  "gazeV2LeftPreHeadCompensationX",
  "gazeV2LeftPreHeadCompensationY",
  "gazeV2RightPreHeadCompensationX",
  "gazeV2RightPreHeadCompensationY",
  "gazeV2LeftPostHeadCompensationX",
  "gazeV2LeftPostHeadCompensationY",
  "gazeV2RightPostHeadCompensationX",
  "gazeV2RightPostHeadCompensationY",
  "gazeV2HeadCompensationMode",
  "gazeV2HeadYawUsed",
  "gazeV2HeadPitchUsed",
  "gazeV2HeadRollUsed",
  "gazeV2HeadRotationValid",
  "gazeV2RigidMotionResidualX",
  "gazeV2RigidMotionResidualY",
  "gazeV2NeutralUpdateAllowed",
  "gazeV2NeutralUpdateBlockedReason",
  "gazeV2HeadCanonicalAvailable",
  "gazeV2HeadYaw",
  "gazeV2HeadPitch",
  "gazeV2HeadRoll",
  "gazeV2CanonicalLeftX",
  "gazeV2CanonicalLeftY",
  "gazeV2CanonicalRightX",
  "gazeV2CanonicalRightY",
  "gazeV2CanonicalFusedX",
  "gazeV2CanonicalFusedY",
  "gazeV2LegacyLocalFusedX",
  "gazeV2LegacyLocalFusedY",
  "eyeClosureEvidenceLeft",
  "eyeClosureEvidenceRight",
  "eyeClosureDecision",
  "eyeClosureReason",

  "drive.sent",
  "drive.mode",
  "drive.dryRun",
  "drive.blockedReason",
  "binding.finalServoOutputCount",
  "device.deviceDriveMode",
  "device.videoDeviceDryRunEnabled",
  "device.videoRealSendSmokeTestEnabled",
  "device.smokeTestProfile",
  "device.dryRunFrameCount",
  "device.realSendBlockedReason",
]

/** 验收脚本用：必须存在的列前缀/列名 */
export const AI_REVIEW_REQUIRED_COLUMNS = [
  "sourceSeq",
  "videoTimeMs",
  "summaryChannels.browAbsMax",
  "rawTrackingSignals.mouth.rawMouthScore",
  "rawTrackingSignals.jaw.jawOutputSource",
  "videoSourceTuning.applied",
  "videoSourceTuningShadow.tuned.browAbsMax",
  "videoSourceTuningShadow.untuned.browAbsMax",
  "videoNeutral.skipReason",
  "trackingDebug.motionContext.deltaSourceSeq",
]

const JAW_SUSPICIOUS_BLEND_MAX = 0.04
const JAW_SUSPICIOUS_TUNED_MIN = 4.8
const EVENT_SAMPLE_LIMIT = 15

function roundScalar(v, digits = 4) {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  if (Number.isInteger(n) && Math.abs(n) < 1e6) return n
  const f = 10 ** digits
  return Math.round(n * f) / f
}

function pickPath(obj, path) {
  if (!obj || !path) return null
  if (!path.includes(".")) {
    const v = obj[path]
    if (v === undefined || v === null) return null
    if (typeof v === "boolean" || typeof v === "string") return v
    // Preserve evidence objects (e.g. eyeClosureEvidenceLeft) for JSON ai-review.
    if (typeof v === "object") return v
    return roundScalar(v)
  }
  const parts = path.split(".")
  let cur = obj
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return null
    cur = cur[p]
  }
  if (cur === undefined || cur === null) return null
  if (typeof cur === "boolean" || typeof cur === "string") return cur
  if (typeof cur === "object") return cur
  return roundScalar(cur)
}

function enrichFrameForExtract(frame) {
  const inputSource = frame.inputSource || {}
  const bindingCount =
    frame.binding?.finalServoOutputCount ?? frame.binding?.outputs?.length ?? null
  return {
    ...frame,
    inputFrameIndex: inputSource.frameIndex ?? null,
    sourceType: inputSource.sourceType ?? frame.source?.sourceType ?? null,
    seekEpoch: inputSource.seekEpoch ?? null,
    videoTimeMs: inputSource.videoTimeMs ?? frame.timestampMs ?? null,
    faceDetected: Boolean(frame.source?.fd ?? frame.source?.faceDetected),
    binding: {
      ...(frame.binding || {}),
      finalServoOutputCount: bindingCount,
    },
    device: {
      ...(frame.device || {}),
      deviceDriveMode: frame.device?.deviceDriveMode ?? frame.drive?.mode ?? null,
      videoDeviceDryRunEnabled: frame.device?.videoDeviceDryRunEnabled ?? null,
      videoRealSendSmokeTestEnabled: frame.device?.videoRealSendSmokeTestEnabled ?? null,
      smokeTestProfile: frame.device?.smokeTestProfile ?? null,
      realSendBlockedReason: frame.device?.real?.blockedReason ?? frame.drive?.blockedReason ?? null,
    },
  }
}

/** @param {Record<string, unknown>} frame */
export function extractAiReviewRow(frame) {
  const enriched = enrichFrameForExtract(frame)
  return AI_REVIEW_FRAME_COLUMNS.map((col) => pickPath(enriched, col))
}

/** @param {Record<string, unknown>[]} frames @param {Record<string, unknown>} [summary] */
export function buildAiReviewFrameSeries(frames, summary = {}) {
  const previewOnlySkip = isPreviewOnlyBindingSkip(summary)
  const skipReason = previewOnlySkip ? "preview-only-no-binding-output" : null
  const rows = frames
    .filter((f) => !f?.diagnostic?.excludeFromSummary && !f?.diagnostic?.isStatusFrame)
    .map((f) => {
      const row = extractAiReviewRow(f)
      if (previewOnlySkip) {
        const skipIdx = AI_REVIEW_FRAME_COLUMNS.indexOf("brow.bindingComparisonSkipped")
        const reasonIdx = AI_REVIEW_FRAME_COLUMNS.indexOf("brow.bindingComparisonSkipReason")
        if (skipIdx >= 0) row[skipIdx] = true
        if (reasonIdx >= 0) row[reasonIdx] = skipReason
      }
      return row
    })
  return {
    columns: [...AI_REVIEW_FRAME_COLUMNS],
    rowCount: rows.length,
    rows,
  }
}

function isPreviewOnlyBindingSkip(summary = {}) {
  const dps = summary.devicePreviewSafety ?? {}
  if (dps.videoDeviceDryRunEnabled || dps.videoRealSendSmokeTestEnabled) {
    return false
  }
  const binding = summary.binding ?? {}
  const maxOut = binding.finalServoOutputCountMinMaxAvg?.max
  const outputMax =
    maxOut != null && Number.isFinite(Number(maxOut))
      ? Number(maxOut)
      : binding.finalServoOutputCountMinMaxAvg?.avg != null
        ? Number(binding.finalServoOutputCountMinMaxAvg.avg)
        : 0
  return (
    dps.inputSourceType === "video" &&
    dps.previewOnlyForced === true &&
    outputMax === 0 &&
    (dps.realSentFrameCount ?? 0) === 0
  )
}

function frameIdentity(frame, rowIndex) {
  const inputSource = frame.inputSource || {}
  return {
    rowIndex,
    frameIndex: frame.frameIndex ?? rowIndex,
    sourceSeq: inputSource.sourceSeq ?? frame.sourceSeq ?? null,
    videoTimeMs: inputSource.videoTimeMs ?? frame.timestampMs ?? null,
  }
}

function eventRef(frame, rowIndex, reason, metric, value) {
  return {
    ...frameIdentity(frame, rowIndex),
    reason,
    metric,
    value: roundScalar(value),
  }
}

function topNIndexed(contentFrames, scorer, limit = EVENT_SAMPLE_LIMIT) {
  return contentFrames
    .map((frame, rowIndex) => ({ frame, rowIndex, score: scorer(frame) }))
    .filter((x) => x.score != null && Number.isFinite(Number(x.score)))
    .sort((a, b) => Number(b.score) - Number(a.score))
    .slice(0, limit)
}

/** @param {Record<string, unknown>[]} frames @param {Record<string, unknown>} summary */
export function buildAiReviewEventSamples(frames, summary = {}) {
  const contentFrames = frames.filter(
    (f) => !f?.diagnostic?.excludeFromSummary && !f?.diagnostic?.isStatusFrame
  )
  const mouthThr =
    summary?.mappingGainAnalysis?.mouth?.saturationThreshold ??
    summary?.videoSourceTuningShadowCompare?.mouth?.saturationThreshold ??
    8

  const jawSuspicious = contentFrames
    .map((frame, rowIndex) => ({ frame, rowIndex }))
    .filter(({ frame }) => {
      const blend =
        frame.rawTrackingSignals?.jaw?.blendshapeJawOpen ??
        frame.rawTrackingSignals?.blendshapes?.jawOpen
      const tunedJaw = frame.videoSourceTuningShadow?.tuned?.jawAbsMax
      if (blend == null || tunedJaw == null) return false
      return (
        Math.abs(Number(blend)) < JAW_SUSPICIOUS_BLEND_MAX &&
        Number(tunedJaw) > JAW_SUSPICIOUS_TUNED_MIN
      )
    })
    .slice(0, EVENT_SAMPLE_LIMIT)
    .map(({ frame, rowIndex }) => {
      const blend =
        frame.rawTrackingSignals?.jaw?.blendshapeJawOpen ??
        frame.rawTrackingSignals?.blendshapes?.jawOpen
      const tunedJaw = frame.videoSourceTuningShadow?.tuned?.jawAbsMax
      return eventRef(
        frame,
        rowIndex,
        "zero-blendshape-but-tuned-jaw-output",
        "videoSourceTuningShadow.tuned.jawAbsMax",
        tunedJaw ?? null
      )
    })

  const highMouth = topNIndexed(contentFrames, (f) => {
    const raw = f.rawTrackingSignals?.mouth?.rawMouthScore
    if (raw == null) return null
    return Number(raw) >= mouthThr ? Number(raw) : null
  }).map(({ frame, rowIndex, score }) =>
    eventRef(frame, rowIndex, "high-raw-mouth-score", "rawTrackingSignals.mouth.rawMouthScore", score)
  )

  const highBrow = topNIndexed(contentFrames, (f) => {
    const tuned = f.videoSourceTuningShadow?.tuned?.browAbsMax ?? f.summaryChannels?.browAbsMax
    const hardClamp =
      f.videoSourceTuningShadow?.browHardClampApplied || f.videoSourceTuning?.brow?.hardClampApplied
    if (hardClamp) return Number(tuned) || 999
    return tuned != null ? Number(tuned) : null
  }).map(({ frame, rowIndex, score }) =>
    eventRef(
      frame,
      rowIndex,
      frame.videoSourceTuningShadow?.browHardClampApplied ||
        frame.videoSourceTuning?.brow?.hardClampApplied
        ? "brow-hard-clamp-applied"
        : "high-tuned-brow-abs-max",
      "videoSourceTuningShadow.tuned.browAbsMax",
      score
    )
  )

  const highEye = topNIndexed(contentFrames, (f) => {
    const tuned = f.videoSourceTuningShadow?.tuned?.eyeAbsMax ?? f.summaryChannels?.eyeAbsMax
    const limited =
      f.videoSourceTuning?.eye?.softLimitApplied || f.videoSourceTuning?.eye?.clampApplied
    if (limited) return Number(tuned) || 999
    return tuned != null ? Number(tuned) : null
  }).map(({ frame, rowIndex, score }) =>
    eventRef(
      frame,
      rowIndex,
      frame.videoSourceTuning?.eye?.clampApplied
        ? "eye-clamp-applied"
        : frame.videoSourceTuning?.eye?.softLimitApplied
          ? "eye-soft-limit-applied"
          : "high-tuned-eye-abs-max",
      "videoSourceTuningShadow.tuned.eyeAbsMax",
      score
    )
  )

  const highTrackingDelta = topNIndexed(contentFrames, (f) => {
    const lm = f.trackingDebug?.landmarkMotion
    if (!lm) return null
    const metrics = [
      ["noseDeltaPx", lm.noseDeltaPx],
      ["mouthCenterDeltaPx", lm.mouthCenterDeltaPx],
      ["eyeCenterDeltaPx", lm.eyeCenterDeltaPx],
      ["faceBoxCenterDeltaPx", lm.faceBoxCenterDeltaPx],
    ].filter(([, v]) => v != null && Number.isFinite(Number(v)))
    if (!metrics.length) return null
    const [name, val] = metrics.reduce((best, cur) =>
      Number(cur[1]) > Number(best[1]) ? cur : best
    )
    f._aiReviewPeakMotionMetric = name
    return Number(val)
  }).map(({ frame, rowIndex, score }) =>
    eventRef(
      frame,
      rowIndex,
      "high-tracking-delta",
      `trackingDebug.landmarkMotion.${frame._aiReviewPeakMotionMetric || "noseDeltaPx"}`,
      score
    )
  )

  return {
    jawSuspiciousFrames: jawSuspicious,
    highMouthScoreFrames: highMouth,
    highBrowFrames: highBrow,
    highEyeFrames: highEye,
    highTrackingDeltaFrames: highTrackingDelta,
  }
}

/**
 * @param {object} params
 * @param {Record<string, unknown>[]} params.frames
 * @param {Record<string, unknown>} params.summary
 * @param {Record<string, unknown>} params.options
 * @param {number} params.durationMs
 * @param {string} params.createdAt
 * @param {number} params.frameCount
 */
export function buildAiReviewExportPayload({
  frames = [],
  summary = {},
  options = {},
  durationMs = 0,
  createdAt,
  frameCount,
  diagnosticMode,
}) {
  const contentFrames = frames.filter(
    (f) => !f?.diagnostic?.excludeFromSummary && !f?.diagnostic?.isStatusFrame
  )
  const frameSeries = buildAiReviewFrameSeries(frames, summary)
  const eventSamples = buildAiReviewEventSamples(frames, summary)

  const slimOptions = { ...options }
  delete slimOptions._bindingProfileSnapshot
  delete slimOptions._actuatorProfileSnapshot
  delete slimOptions.includeAllLandmarks

  const payload = {
    schemaVersion: TRACKING_DIAGNOSTIC_AI_REVIEW_SCHEMA,
    diagnosticExportMode: DIAGNOSTIC_EXPORT_MODES.AI_REVIEW,
    createdAt: createdAt ?? new Date().toISOString(),
    durationMs,
    frameCount: frameCount ?? contentFrames.length,
    diagnosticMode: diagnosticMode ?? options.diagnosticMode ?? null,
    encoding: "ai-review-frame-series",
    options: slimOptions,
    summary,
    frameSeries,
    eventSamples,
  }

  if (options.includeBindingProfileInAiReview) {
    payload.bindingProfileSnapshot = options._bindingProfileSnapshot ?? null
    payload.actuatorProfileSnapshot = options._actuatorProfileSnapshot ?? null
  }

  return payload
}

const EVENT_SAMPLE_INDEX_KEYS = new Set([
  "rowIndex",
  "frameIndex",
  "sourceSeq",
  "videoTimeMs",
  "reason",
  "metric",
  "value",
])

function isLightweightEventSample(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false
  const keys = Object.keys(entry)
  if (!keys.includes("rowIndex") || !keys.includes("reason")) return false
  return keys.every((k) => EVENT_SAMPLE_INDEX_KEYS.has(k))
}

function validateEventSamplesLightweight(eventSamples = {}) {
  const groups = [
    "jawSuspiciousFrames",
    "highMouthScoreFrames",
    "highBrowFrames",
    "highEyeFrames",
    "highTrackingDeltaFrames",
  ]
  for (const group of groups) {
    const list = eventSamples[group]
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      if (!isLightweightEventSample(entry)) {
        return { ok: false, invalidGroup: group }
      }
    }
  }
  return { ok: true, invalidGroup: null }
}

/** @param {Record<string, unknown>} payload */
export function validateAiReviewExportPayload(payload) {
  const missingRequiredFields = AI_REVIEW_REQUIRED_COLUMNS.filter(
    (col) => !payload?.frameSeries?.columns?.includes(col)
  )
  const jsonStr = JSON.stringify(payload)
  const eventSampleBytes = new TextEncoder().encode(JSON.stringify(payload.eventSamples ?? {})).length
  const frameSeriesBytes = new TextEncoder().encode(JSON.stringify(payload.frameSeries ?? {})).length
  const eventSamplesValidation = validateEventSamplesLightweight(payload.eventSamples)
  const forbiddenPresent = [
    jsonStr.includes('"selectedLandmarks"'),
    jsonStr.includes('"videoFrameDebug"'),
    payload?.frames?.length > 0,
  ].some(Boolean)

  return {
    mode: payload?.diagnosticExportMode ?? DIAGNOSTIC_EXPORT_MODES.AI_REVIEW,
    schemaVersion: payload?.schemaVersion ?? null,
    requiredFieldsPresent: missingRequiredFields.length === 0,
    missingRequiredFields,
    forbiddenLargeFieldsPresent: forbiddenPresent,
    eventSamplesLightweight: eventSamplesValidation.ok,
    eventSamplesInvalidGroup: eventSamplesValidation.invalidGroup,
    frameSeriesRowCount: payload?.frameSeries?.rowCount ?? 0,
    columnCount: payload?.frameSeries?.columns?.length ?? 0,
    outputBytes: new TextEncoder().encode(jsonStr).length,
    frameSeriesBytes,
    eventSamplesBytes: eventSampleBytes,
  }
}
