import { normalizeFrameSeq } from "../../trackingPreview/trackingFrameEnvelope.js"
import { summarizeRigChannels, summarizeSafetyFromCommands } from "../../trackingPreview/deviceDriveDiagnostics.js"
import { enrichRawTrackingSignalsJawTrace } from "../videoSourceTuning.js"
import {
  buildVideoFrameDebugFromTrackingDebug,
  isVideoFrameDebugComplete,
} from "../../trackingPreview/videoFrameDebug.js"
import {
  logCompactFrameBuilt,
  peekWireTrackingDebugForSeq,
  resolveWireTrackingDebug,
} from "../../trackingPreview/videoDiagnosticExportDebug.js"
import { buildBrowPipelineConsistency, resolveRuntimeBrowSource } from "../browDebugNormalize.js"
import { resolveInputSourceFromRigFrame } from "../input/trackingInputFrame.js"
import { resolveTrackingSourceContext } from "../input/trackingSourceContext.js"
import { buildRawTrackingSignals, buildVideoNeutralFrameDiagnostic } from "../videoNeutralCalibration.js"
import { VIDEO_DEVICE_DRY_RUN_BLOCKED_REASON } from "../../trackingPreview/videoDeviceDryRunConstants.js"
import { rigValuesFromEliteRig } from "../../../core/faceDofMapper.js"
import { eyeRadarDotXNorm, eyeRadarDotYNorm } from "../../../hooks/useFaceRigInteraction.js"

function roundScalar(v, digits = 4) {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  const f = 10 ** digits
  return Math.round(n * f) / f
}

function mergeGazeDebug(...sources) {
  const out = {}
  for (const src of sources) {
    if (!src || typeof src !== "object") continue
    for (const [k, v] of Object.entries(src)) {
      if (v != null && v !== "") {
        out[k] = v
      }
    }
  }
  return out
}

/** true/false as-is; missing → null (never coerce missing to false/0). */
function boolOrNull(v) {
  if (v === true) return true
  if (v === false) return false
  return null
}

/** Prefer first finite number; otherwise null (no zero-fill). */
function firstFinite(...vals) {
  for (const v of vals) {
    if (v === null || v === undefined || v === "") continue
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

/**
 * Resolve trackingRuntime for diagnostic export.
 * Reuses frame.source / canonicalObservation.source — does not invent.
 * @returns {"browser"|"python"|null}
 */
export function resolveTrackingRuntimeForDiagnostic(lastFrame) {
  const src = lastFrame?.source
  if (src === "mediapipe-web" || src === "browser") return "browser"
  if (src === "python-mediapipe" || src === "python" || src === "python-websocket") return "python"
  const cos = lastFrame?.debug?.canonicalObservation?.source
  if (cos === "browser") return "browser"
  if (cos === "python") return "python"
  if (typeof src === "string" && src.includes("python")) return "python"
  if (typeof src === "string" && (src.includes("web") || src.includes("browser"))) return "browser"
  return null
}

/** ai-review：眼球 X/Y 符号链诊断（Python gaze → 校准 rig → UI dot）+ Browser 中间量 */
export function buildEyeGazeAiReviewFields(lastFrame, previewRig, calibratedFrame) {
  const gaze = mergeGazeDebug(
    calibratedFrame?.debug?.gaze,
    lastFrame?.debug?.gaze
  )
  const headPoseSrc =
    calibratedFrame?.debug?.headPose || lastFrame?.debug?.headPose || null
  const mapv = lastFrame?.debug?.mapping || {}
  const gateRig = lastFrame?.rig || {}
  const finalRig = previewRig || calibratedFrame?.rig || gateRig
  const vals = rigValuesFromEliteRig(finalRig)
  const eyeXYDbg =
    calibratedFrame?.debug?.eyeXYStabilizer ||
    lastFrame?.debug?.eyeXYStabilizer ||
    null
  const sharedRadarX = num(finalRig?.sharedRadar?.x, 50)
  const sharedRadarY = num(finalRig?.sharedRadar?.y, 50)

  // Legacy emitted columns: keep prior fallback chain (rig) for Python/older frames.
  const emittedXLegacy = roundScalar(
    gaze.emittedSharedRadarX ??
      gaze.candidateSharedRadarX ??
      mapv.sharedRadarX ??
      gateRig?.sharedRadar?.x ??
      finalRig?.sharedRadar?.x,
    2
  )
  const emittedYLegacy = roundScalar(
    gaze.emittedSharedRadarY ??
      gaze.candidateSharedRadarY ??
      mapv.sharedRadarY ??
      gateRig?.sharedRadar?.y ??
      finalRig?.sharedRadar?.y,
    2
  )

  // Browser intermediate fields: only real values; never invent 0 / iris*.
  const rawX = roundScalar(firstFinite(gaze.rawX), 5)
  const rawY = roundScalar(firstFinite(gaze.rawY), 5)
  const neutralX = roundScalar(firstFinite(gaze.neutralX), 5)
  const neutralY = roundScalar(firstFinite(gaze.neutralY), 5)
  const neutralReady = boolOrNull(gaze.neutralReady)
  const neutralSampleCount = Number.isFinite(Number(gaze.neutralSampleCount))
    ? Math.trunc(Number(gaze.neutralSampleCount))
    : null
  const eyeLookX = roundScalar(firstFinite(gaze.eyeLookX), 5)
  const eyeLookY = roundScalar(firstFinite(gaze.eyeLookY), 5)
  const candidateX = roundScalar(firstFinite(gaze.candidateSharedRadarX), 2)
  const candidateY = roundScalar(firstFinite(gaze.candidateSharedRadarY), 2)
  // New emitted columns: gaze-only (sharedRadarX alias OK); no rig fallback.
  const emittedXDiag = roundScalar(
    firstFinite(gaze.emittedSharedRadarX, gaze.sharedRadarX),
    2
  )
  const emittedYDiag = roundScalar(
    firstFinite(gaze.emittedSharedRadarY, gaze.sharedRadarY),
    2
  )
  const outputMode =
    gaze.outputMode != null && String(gaze.outputMode) !== ""
      ? String(gaze.outputMode)
      : ""

  const headAvailable = boolOrNull(headPoseSrc?.available)
  const headYaw = roundScalar(firstFinite(headPoseSrc?.yawProxy), 4)
  const headPitch = roundScalar(firstFinite(headPoseSrc?.pitchProxy), 4)
  const headRoll = roundScalar(firstFinite(headPoseSrc?.rollDeg), 4)

  const trackingRuntime = resolveTrackingRuntimeForDiagnostic(lastFrame)

  const shadowSrc = gaze.shadow && typeof gaze.shadow === "object" ? gaze.shadow : null
  const shadowAvailable = boolOrNull(shadowSrc?.available)
  const gazeShadowRawX = roundScalar(firstFinite(shadowSrc?.rawX), 5)
  const gazeShadowRawY = roundScalar(firstFinite(shadowSrc?.rawY), 5)
  const gazeShadowNormalizedX = roundScalar(firstFinite(shadowSrc?.normalizedX), 5)
  const gazeShadowNormalizedY = roundScalar(firstFinite(shadowSrc?.normalizedY), 5)
  const gazeShadowNeutralX = roundScalar(firstFinite(shadowSrc?.neutralX), 5)
  const gazeShadowNeutralY = roundScalar(firstFinite(shadowSrc?.neutralY), 5)
  const gazeShadowNeutralReady = boolOrNull(shadowSrc?.neutralReady)
  const gazeShadowCandidateSharedRadarX = roundScalar(
    firstFinite(shadowSrc?.candidateSharedRadarX),
    2
  )
  const gazeShadowCandidateSharedRadarY = roundScalar(
    firstFinite(shadowSrc?.candidateSharedRadarY),
    2
  )
  const gazeShadowEmittedSharedRadarX = roundScalar(
    firstFinite(shadowSrc?.emittedSharedRadarX),
    2
  )
  const gazeShadowEmittedSharedRadarY = roundScalar(
    firstFinite(shadowSrc?.emittedSharedRadarY),
    2
  )
  const gazeShadowOutputMode =
    shadowSrc?.outputMode != null && String(shadowSrc.outputMode) !== ""
      ? String(shadowSrc.outputMode)
      : null

  return {
    debug: {
      gaze: {
        gazeEstimatorMode: gaze.gazeEstimatorMode != null ? String(gaze.gazeEstimatorMode) : "",
        irisOnlyActive: Boolean(gaze.irisOnlyActive),
        irisLocalMode: Boolean(gaze.irisLocalMode),
        irisInitState: gaze.irisInitState != null ? String(gaze.irisInitState) : "",
        irisInitReady: Boolean(gaze.irisInitReady),
        irisInitSampleCount: Number.isFinite(Number(gaze.irisInitSampleCount))
          ? Number(gaze.irisInitSampleCount)
          : null,
        irisInitRequiredSamples: Number.isFinite(Number(gaze.irisInitRequiredSamples))
          ? Number(gaze.irisInitRequiredSamples)
          : null,
        irisInitRemainingMs: roundScalar(gaze.irisInitRemainingMs, 1),
        irisLocalX: roundScalar(gaze.irisLocalX, 5),
        irisLocalY: roundScalar(gaze.irisLocalY, 5),
        irisLocalScale: roundScalar(gaze.irisLocalScale, 5),
        leftIrisLocalX: roundScalar(gaze.leftIrisLocalX, 5),
        leftIrisLocalY: roundScalar(gaze.leftIrisLocalY, 5),
        rightIrisLocalX: roundScalar(gaze.rightIrisLocalX, 5),
        rightIrisLocalY: roundScalar(gaze.rightIrisLocalY, 5),
        neutralIrisLocalX: roundScalar(gaze.neutralIrisLocalX, 5),
        neutralIrisLocalY: roundScalar(gaze.neutralIrisLocalY, 5),
        neutralIrisLocalScale: roundScalar(gaze.neutralIrisLocalScale, 5),
        irisLocalDx: roundScalar(gaze.irisLocalDx, 5),
        irisLocalDy: roundScalar(gaze.irisLocalDy, 5),
        irisLocalFusion: gaze.irisLocalFusion != null ? gaze.irisLocalFusion : null,
        irisWarmupSampleCount: Number.isFinite(Number(gaze.irisWarmupSampleCount))
          ? Number(gaze.irisWarmupSampleCount)
          : null,
        irisHeadMotionPx: roundScalar(gaze.irisHeadMotionPx, 4),
        irisGlobalDx: roundScalar(gaze.irisGlobalDx, 5),
        irisGlobalDy: roundScalar(gaze.irisGlobalDy, 5),
        irisLeftCx: roundScalar(gaze.irisLeftCx, 5),
        irisLeftCy: roundScalar(gaze.irisLeftCy, 5),
        irisRightCx: roundScalar(gaze.irisRightCx, 5),
        irisRightCy: roundScalar(gaze.irisRightCy, 5),
        irisCx: roundScalar(gaze.irisCx, 5),
        irisCy: roundScalar(gaze.irisCy, 5),
        irisScale: roundScalar(gaze.irisScale, 5),
        neutralIrisCx: roundScalar(gaze.neutralIrisCx, 5),
        neutralIrisCy: roundScalar(gaze.neutralIrisCy, 5),
        neutralIrisScale: roundScalar(gaze.neutralIrisScale, 5),
        irisXNorm: roundScalar(gaze.irisXNorm, 4),
        irisYNorm: roundScalar(gaze.irisYNorm, 4),
        // Prefer explicit candidate; else null (do not invent).
        candidateSharedRadarX: candidateX,
        candidateSharedRadarY: candidateY,
        // Legacy emitted path keeps rig fallback for old columns via emittedXLegacy below.
        emittedSharedRadarX: emittedXLegacy,
        emittedSharedRadarY: emittedYLegacy,
        outputMode,
        // Browser Shared Semantic Core intermediates (real only)
        rawX,
        rawY,
        neutralX,
        neutralY,
        neutralReady,
        neutralSampleCount,
        eyeLookX,
        eyeLookY,
        available: boolOrNull(gaze.available),
        warmingUp: boolOrNull(gaze.warmingUp),
        frozenByBlink: boolOrNull(gaze.frozenByBlink),
        heldLastValid: boolOrNull(gaze.heldLastValid),
        sharedRadarX: roundScalar(firstFinite(gaze.sharedRadarX), 2),
        sharedRadarY: roundScalar(firstFinite(gaze.sharedRadarY), 2),
        currentGazeComputeMs: roundScalar(firstFinite(gaze.currentGazeComputeMs), 3),
        shadowGazeComputeMs: roundScalar(firstFinite(gaze.shadowGazeComputeMs), 3),
        gazeAlgorithm:
          gaze.gazeAlgorithm != null
            ? String(gaze.gazeAlgorithm)
            : gaze.gazeEstimatorMode != null
              ? String(gaze.gazeEstimatorMode)
              : null,
        v2: gaze.v2 && typeof gaze.v2 === "object" ? gaze.v2 : null,
        shadow: shadowSrc
          ? {
              available: shadowAvailable,
              algorithm: shadowSrc.algorithm != null ? String(shadowSrc.algorithm) : "iris-only",
              rawX: gazeShadowRawX,
              rawY: gazeShadowRawY,
              normalizedX: gazeShadowNormalizedX,
              normalizedY: gazeShadowNormalizedY,
              neutralX: gazeShadowNeutralX,
              neutralY: gazeShadowNeutralY,
              neutralReady: gazeShadowNeutralReady,
              candidateSharedRadarX: gazeShadowCandidateSharedRadarX,
              candidateSharedRadarY: gazeShadowCandidateSharedRadarY,
              emittedSharedRadarX: gazeShadowEmittedSharedRadarX,
              emittedSharedRadarY: gazeShadowEmittedSharedRadarY,
              outputMode: gazeShadowOutputMode,
            }
          : null,
      },
      headPose: {
        available: headAvailable,
        yawProxy: headYaw,
        pitchProxy: headPitch,
        rollDeg: headRoll,
        source: headPoseSrc?.source != null ? String(headPoseSrc.source) : null,
      },
    },
    rig: {
      sharedRadar: {
        x: roundScalar(finalRig?.sharedRadar?.x, 2),
        y: roundScalar(finalRig?.sharedRadar?.y, 2),
      },
    },
    eye_xy: {
      x: roundScalar(vals.eye_xy?.x, 2),
      y: roundScalar(vals.eye_xy?.y, 2),
    },
    eyeXYStabilizer: {
      outputX: roundScalar(finalRig?.sharedRadar?.x ?? eyeXYDbg?.outputX ?? eyeXYDbg?.output?.x, 2),
      outputY: roundScalar(finalRig?.sharedRadar?.y ?? eyeXYDbg?.outputY ?? eyeXYDbg?.output?.y, 2),
      rawX: roundScalar(eyeXYDbg?.raw?.x ?? eyeXYDbg?.inputX ?? eyeXYDbg?.input?.x, 2),
      rawY: roundScalar(eyeXYDbg?.raw?.y ?? eyeXYDbg?.inputY ?? eyeXYDbg?.input?.y, 2),
      inputX: roundScalar(eyeXYDbg?.inputX ?? eyeXYDbg?.input?.x ?? eyeXYDbg?.raw?.x, 2),
      inputY: roundScalar(eyeXYDbg?.inputY ?? eyeXYDbg?.input?.y ?? eyeXYDbg?.raw?.y, 2),
      stateX: eyeXYDbg?.stateX ?? eyeXYDbg?.state?.x ?? null,
      stateY: eyeXYDbg?.stateY ?? eyeXYDbg?.state?.y ?? null,
      actionX: eyeXYDbg?.actionX ?? eyeXYDbg?.action?.x ?? null,
      actionY: eyeXYDbg?.actionY ?? eyeXYDbg?.action?.y ?? null,
      activationThresholdX: roundScalar(
        firstFinite(eyeXYDbg?.activationThresholdX ?? eyeXYDbg?.activationThreshold?.x),
        4
      ),
      activationThresholdY: roundScalar(
        firstFinite(eyeXYDbg?.activationThresholdY ?? eyeXYDbg?.activationThreshold?.y),
        4
      ),
      releaseThresholdX: roundScalar(
        firstFinite(eyeXYDbg?.releaseThresholdX ?? eyeXYDbg?.releaseThreshold?.x),
        4
      ),
      releaseThresholdY: roundScalar(
        firstFinite(eyeXYDbg?.releaseThresholdY ?? eyeXYDbg?.releaseThreshold?.y),
        4
      ),
      limitedX: Boolean(eyeXYDbg?.limited?.x),
      limitedY: Boolean(eyeXYDbg?.limited?.y),
      centerLatchX: Boolean(eyeXYDbg?.centerLatch?.x),
      centerLatchY: Boolean(eyeXYDbg?.centerLatch?.y),
    },
    faceRigUi: {
      eyeXYDotXNorm: roundScalar(eyeRadarDotXNorm(sharedRadarX), 4),
      eyeXYDotYNorm: roundScalar(eyeRadarDotYNorm(sharedRadarY), 4),
    },
    /** Top-level aliases for additive AI_REVIEW_FRAME_COLUMNS (null-safe). */
    exportFields: {
      trackingRuntime,
      gazeRawX: rawX,
      gazeRawY: rawY,
      gazeNeutralX: neutralX,
      gazeNeutralY: neutralY,
      gazeNeutralReady: neutralReady,
      gazeNeutralSampleCount: neutralSampleCount,
      gazeEyeLookX: eyeLookX,
      gazeEyeLookY: eyeLookY,
      gazeCandidateSharedRadarX: candidateX,
      gazeCandidateSharedRadarY: candidateY,
      gazeEmittedSharedRadarX: emittedXDiag,
      gazeEmittedSharedRadarY: emittedYDiag,
      headPoseAvailable: headAvailable,
      headYawProxy: headYaw,
      headPitchProxy: headPitch,
      headRollDeg: headRoll,
      gazeShadowAvailable: shadowAvailable,
      gazeShadowRawX,
      gazeShadowRawY,
      gazeShadowNormalizedX,
      gazeShadowNormalizedY,
      gazeShadowNeutralX,
      gazeShadowNeutralY,
      gazeShadowNeutralReady,
      gazeShadowCandidateSharedRadarX,
      gazeShadowCandidateSharedRadarY,
      gazeShadowEmittedSharedRadarX,
      gazeShadowEmittedSharedRadarY,
      gazeShadowOutputMode,
      gazeAlgorithm:
        gaze.gazeAlgorithm != null
          ? String(gaze.gazeAlgorithm)
          : gaze.gazeEstimatorMode != null
            ? String(gaze.gazeEstimatorMode)
            : null,
      gazeV2GeometryMode:
        gaze.v2?.geometryMode != null ? String(gaze.v2.geometryMode) : null,
      gazeV2BinocularDisagreement: boolOrNull(gaze.v2?.binocularDisagreement),
      gazeV2DisagreementX: boolOrNull(gaze.v2?.disagreementX ?? gaze.v2?.fusion?.disagreementX),
      gazeV2DisagreementY: boolOrNull(gaze.v2?.disagreementY ?? gaze.v2?.fusion?.disagreementY),
      gazeV2LeftWeight: roundScalar(firstFinite(gaze.v2?.fusion?.leftWeight ?? gaze.v2?.leftWeight), 4),
      gazeV2RightWeight: roundScalar(firstFinite(gaze.v2?.fusion?.rightWeight ?? gaze.v2?.rightWeight), 4),
      gazeV2LeftReliability: roundScalar(firstFinite(gaze.v2?.left?.reliability), 4),
      gazeV2RightReliability: roundScalar(firstFinite(gaze.v2?.right?.reliability), 4),
      gazeV2LeftNormalizedX: roundScalar(firstFinite(gaze.v2?.left?.normalizedX), 4),
      gazeV2LeftNormalizedY: roundScalar(firstFinite(gaze.v2?.left?.normalizedY), 4),
      gazeV2RightNormalizedX: roundScalar(firstFinite(gaze.v2?.right?.normalizedX), 4),
      gazeV2RightNormalizedY: roundScalar(firstFinite(gaze.v2?.right?.normalizedY), 4),
      gazeV2FusedBeforeDisagreementX: roundScalar(
        firstFinite(gaze.v2?.fusion?.fusedBeforeDisagreementX),
        4
      ),
      gazeV2FusedBeforeDisagreementY: roundScalar(
        firstFinite(gaze.v2?.fusion?.fusedBeforeDisagreementY),
        4
      ),
      gazeV2FusedAfterDisagreementX: roundScalar(
        firstFinite(gaze.v2?.fusion?.fusedAfterDisagreementX),
        4
      ),
      gazeV2FusedAfterDisagreementY: roundScalar(
        firstFinite(gaze.v2?.fusion?.fusedAfterDisagreementY),
        4
      ),
      gazeV2ArbitrationModeX:
        gaze.v2?.fusion?.arbitrationModeX != null ? String(gaze.v2.fusion.arbitrationModeX) : null,
      gazeV2ArbitrationModeY:
        gaze.v2?.fusion?.arbitrationModeY != null ? String(gaze.v2.fusion.arbitrationModeY) : null,
      gazeV2VerticalReferenceSource:
        gaze.v2?.frame?.verticalReferenceSource != null
          ? String(gaze.v2.frame.verticalReferenceSource)
          : null,
      gazeV2HoldReason:
        gaze.v2?.output?.holdReason != null ? String(gaze.v2.output.holdReason) : null,
      gazeV2BothEyesUnreliable: boolOrNull(gaze.v2?.fusion?.bothEyesUnreliable),
      gazeV2LeftEyeOpenness: roundScalar(firstFinite(gaze.v2?.left?.eyeOpenness), 4),
      gazeV2RightEyeOpenness: roundScalar(firstFinite(gaze.v2?.right?.eyeOpenness), 4),
      gazeV2NeutralEyeOpennessLeft: roundScalar(
        firstFinite(gaze.v2?.neutral?.eyeOpennessLeft),
        4
      ),
      gazeV2NeutralEyeOpennessRight: roundScalar(
        firstFinite(gaze.v2?.neutral?.eyeOpennessRight),
        4
      ),
      gazeV2LeftOpennessRatio: roundScalar(firstFinite(gaze.v2?.left?.opennessRatio), 4),
      gazeV2RightOpennessRatio: roundScalar(firstFinite(gaze.v2?.right?.opennessRatio), 4),
      gazeV2LeftTrackingValid: boolOrNull(gaze.v2?.left?.trackingValid),
      gazeV2RightTrackingValid: boolOrNull(gaze.v2?.right?.trackingValid),
      gazeV2LeftIrisValid: boolOrNull(gaze.v2?.left?.irisValid),
      gazeV2RightIrisValid: boolOrNull(gaze.v2?.right?.irisValid),
      gazeV2LeftClosureCandidate: boolOrNull(gaze.v2?.left?.closureCandidate),
      gazeV2RightClosureCandidate: boolOrNull(gaze.v2?.right?.closureCandidate),
      gazeV2TrueClosureActive: boolOrNull(
        gaze.v2?.trueClosureActive ?? gaze.v2?.closure?.trueClosureActive
      ),
      gazeV2ClosureEnterCount: roundScalar(
        firstFinite(gaze.v2?.closure?.enterCount),
        0
      ),
      gazeV2ClosureReleaseCount: roundScalar(
        firstFinite(gaze.v2?.closure?.releaseCount),
        0
      ),
      gazeV2VerticalPolarity:
        gaze.v2?.vertical?.polarity != null ? String(gaze.v2.vertical.polarity) : "plus_y_look_up",
      gazeV2VerticalSignalPrePolarity: roundScalar(
        firstFinite(gaze.v2?.vertical?.signalPrePolarity),
        4
      ),
      gazeV2VerticalSignalPostPolarity: roundScalar(
        firstFinite(gaze.v2?.vertical?.signalPostPolarity ?? gaze.v2?.signal?.preDeadzoneY),
        4
      ),
      gazeV2VerticalFilteredSignal: roundScalar(
        firstFinite(gaze.v2?.vertical?.filteredSignal ?? gaze.v2?.filter?.outputY),
        4
      ),
      gazeV2VerticalDirection:
        gaze.v2?.vertical?.direction != null ? String(gaze.v2.vertical.direction) : null,
      gazeV2VerticalFullScaleUsed: roundScalar(
        firstFinite(gaze.v2?.vertical?.fullScaleUsed),
        4
      ),
      gazeV2VerticalResponseNormalized: roundScalar(
        firstFinite(gaze.v2?.vertical?.responseNormalized),
        4
      ),
      gazeV2VerticalMappedY: roundScalar(firstFinite(gaze.v2?.vertical?.mappedY), 4),
      gazeV2LeftGeometryValid: boolOrNull(gaze.v2?.left?.geometryValid),
      gazeV2RightGeometryValid: boolOrNull(gaze.v2?.right?.geometryValid),
      gazeV2ClosureDecisionReasonLeft:
        gaze.v2?.left?.closureReason != null ? String(gaze.v2.left.closureReason) : null,
      gazeV2ClosureDecisionReasonRight:
        gaze.v2?.right?.closureReason != null ? String(gaze.v2.right.closureReason) : null,
      gazeV2LeftCanonicalX: roundScalar(firstFinite(gaze.v2?.left?.canonicalX), 4),
      gazeV2LeftCanonicalY: roundScalar(firstFinite(gaze.v2?.left?.canonicalY), 4),
      gazeV2RightCanonicalX: roundScalar(firstFinite(gaze.v2?.right?.canonicalX), 4),
      gazeV2RightCanonicalY: roundScalar(firstFinite(gaze.v2?.right?.canonicalY), 4),
      gazeV2LeftPreHeadCompensationX: roundScalar(
        firstFinite(gaze.v2?.left?.preHeadCompensationX),
        4
      ),
      gazeV2LeftPreHeadCompensationY: roundScalar(
        firstFinite(gaze.v2?.left?.preHeadCompensationY),
        4
      ),
      gazeV2RightPreHeadCompensationX: roundScalar(
        firstFinite(gaze.v2?.right?.preHeadCompensationX),
        4
      ),
      gazeV2RightPreHeadCompensationY: roundScalar(
        firstFinite(gaze.v2?.right?.preHeadCompensationY),
        4
      ),
      gazeV2LeftPostHeadCompensationX: roundScalar(
        firstFinite(gaze.v2?.left?.postHeadCompensationX),
        4
      ),
      gazeV2LeftPostHeadCompensationY: roundScalar(
        firstFinite(gaze.v2?.left?.postHeadCompensationY),
        4
      ),
      gazeV2RightPostHeadCompensationX: roundScalar(
        firstFinite(gaze.v2?.right?.postHeadCompensationX),
        4
      ),
      gazeV2RightPostHeadCompensationY: roundScalar(
        firstFinite(gaze.v2?.right?.postHeadCompensationY),
        4
      ),
      gazeV2HeadCompensationMode:
        gaze.v2?.headCompensation?.mode != null
          ? String(gaze.v2.headCompensation.mode)
          : gaze.v2?.frame?.headCompensationMode != null
            ? String(gaze.v2.frame.headCompensationMode)
            : null,
      gazeV2HeadYawUsed: roundScalar(firstFinite(gaze.v2?.headCompensation?.yawUsed), 4),
      gazeV2HeadPitchUsed: roundScalar(firstFinite(gaze.v2?.headCompensation?.pitchUsed), 4),
      gazeV2HeadRollUsed: roundScalar(firstFinite(gaze.v2?.headCompensation?.rollUsed), 4),
      gazeV2HeadRotationValid: boolOrNull(
        gaze.v2?.headCompensation?.rotationValid ?? gaze.v2?.frame?.headRotationValid
      ),
      gazeV2RigidMotionResidualX: roundScalar(
        firstFinite(gaze.v2?.headCompensation?.rigidMotionResidualX),
        4
      ),
      gazeV2RigidMotionResidualY: roundScalar(
        firstFinite(gaze.v2?.headCompensation?.rigidMotionResidualY),
        4
      ),
      gazeV2NeutralUpdateAllowed: boolOrNull(gaze.v2?.neutral?.updateAllowed),
      gazeV2NeutralUpdateBlockedReason:
        gaze.v2?.neutral?.updateBlockedReason != null
          ? String(gaze.v2.neutral.updateBlockedReason)
          : null,
      gazeV2HeadCanonicalAvailable: boolOrNull(gaze.v2?.headCanonical?.available),
      gazeV2HeadYaw: roundScalar(firstFinite(gaze.v2?.headCompensation?.yawUsed ?? gaze.v2?.frame?.headYawUsed), 4),
      gazeV2HeadPitch: roundScalar(firstFinite(gaze.v2?.headCompensation?.pitchUsed ?? gaze.v2?.frame?.headPitchUsed), 4),
      gazeV2HeadRoll: roundScalar(firstFinite(gaze.v2?.headCompensation?.rollUsed ?? gaze.v2?.frame?.headRollUsed), 4),
      gazeV2CanonicalLeftX: roundScalar(firstFinite(gaze.v2?.headCanonical?.left?.normalizedX ?? gaze.v2?.left?.canonicalX), 4),
      gazeV2CanonicalLeftY: roundScalar(firstFinite(gaze.v2?.headCanonical?.left?.normalizedY ?? gaze.v2?.left?.canonicalY), 4),
      gazeV2CanonicalRightX: roundScalar(firstFinite(gaze.v2?.headCanonical?.right?.normalizedX ?? gaze.v2?.right?.canonicalX), 4),
      gazeV2CanonicalRightY: roundScalar(firstFinite(gaze.v2?.headCanonical?.right?.normalizedY ?? gaze.v2?.right?.canonicalY), 4),
      gazeV2CanonicalFusedX: roundScalar(firstFinite(gaze.v2?.headCompensation?.canonicalFusedX ?? gaze.v2?.fused?.normalizedX), 4),
      gazeV2CanonicalFusedY: roundScalar(firstFinite(gaze.v2?.headCompensation?.canonicalFusedY ?? gaze.v2?.fused?.normalizedY), 4),
      gazeV2LegacyLocalFusedX: roundScalar(firstFinite(gaze.v2?.headCompensation?.legacyLocalFusedX), 4),
      gazeV2LegacyLocalFusedY: roundScalar(firstFinite(gaze.v2?.headCompensation?.legacyLocalFusedY), 4),
      eyeClosureEvidenceLeft: gaze.v2?.closure?.evidenceLeft ?? null,
      eyeClosureEvidenceRight: gaze.v2?.closure?.evidenceRight ?? null,
      eyeClosureDecision:
        gaze.v2?.closure?.decision != null ? String(gaze.v2.closure.decision) : null,
      eyeClosureReason:
        gaze.v2?.closure?.reason != null ? String(gaze.v2.closure.reason) : null,
    },
  }
}

function num(v, fallback = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function pickBrowBindingRaw(outputs) {
  const pick = (ch) => {
    const o = (outputs || []).find((x) => x.sourceChannel === ch)
    const v = o?.rawControlValue ?? o?.appliedControlValue ?? o?.controlValue
    return Number.isFinite(Number(v)) ? Number(v) : null
  }
  return {
    lTipA: pick("brow_l_tip_a.value") ?? pick("brow_l_tip.value"),
    lTipB: pick("brow_l_tip_b.value"),
    lTip: pick("brow_l_tip_a.value") ?? pick("brow_l_tip.value"),
    lTail: pick("brow_l_tail.value"),
    rTipA: pick("brow_r_tip_a.value") ?? pick("brow_r_tip.value"),
    rTipB: pick("brow_r_tip_b.value"),
    rTip: pick("brow_r_tip_a.value") ?? pick("brow_r_tip.value"),
    rTail: pick("brow_r_tail.value"),
  }
}

function browAbsFromSide(side) {
  if (!side) return 0
  return Math.max(
    Math.abs(num(side.tipA ?? side.tip)),
    Math.abs(num(side.tipB)),
    Math.abs(num(side.mid)),
    Math.abs(num(side.tail))
  )
}

function slimDryRunServoOutput(o) {
  if (!o) return null
  return {
    actuatorKey: o.actuatorKey,
    sourceChannel: o.sourceChannel || null,
    logicalValue: roundScalar(o.logicalValue, 2),
    pwmValue: roundScalar(o.pwmValue, 1),
    rawControlValue: roundScalar(o.rawControlValue ?? o.appliedControlValue, 3),
  }
}

function slimDryRunBusCommand(cmd) {
  if (!cmd) return null
  return {
    actuatorKey: cmd.actuatorKey,
    busServoId: cmd.busServoId,
    targetPosition: roundScalar(cmd.targetPosition, 1),
    limited: Boolean(cmd.safety?.limited),
    twitchGuardAction: cmd.twitchGuard?.action ?? null,
  }
}

function compactBrowSummary(frameDebug, rig, outputs, options = {}) {
  const mappingFinal = resolveRuntimeBrowSource(frameDebug)
  const mappingAbsMax = Math.max(
    browAbsFromSide(mappingFinal?.browL),
    browAbsFromSide(mappingFinal?.browR)
  )
  const faceRigAbsMax = Math.max(
    browAbsFromSide(rig?.browL),
    browAbsFromSide(rig?.browR)
  )
  if (options.skipBindingComparison) {
    return {
      mappingAbsMax,
      faceRigAbsMax,
      bindingAbsMax: 0,
      consistent: true,
      mismatchReason: "",
      bindingComparisonSkipped: true,
      bindingComparisonSkipReason: options.bindingComparisonSkipReason || "preview-only-no-binding-output",
    }
  }
  const binding = pickBrowBindingRaw(outputs)
  const bindingAbsMax = Math.max(
    Math.abs(num(binding.lTip)),
    Math.abs(num(binding.lTail)),
    Math.abs(num(binding.rTip)),
    Math.abs(num(binding.rTail))
  )
  const consistency = buildBrowPipelineConsistency({
    mappingFinal,
    faceRigChannel: { browL: rig?.browL, browR: rig?.browR },
    bindingRawControl: binding,
  })
  return {
    mappingAbsMax,
    faceRigAbsMax,
    bindingAbsMax,
    consistent: consistency.consistent,
    mismatchReason: consistency.mismatchReason || "",
  }
}

function resolveMeasuredVideoFrameDebug(ctx) {
  if (typeof ctx.getVideoFrameDebug === "function") {
    const fromGetter = ctx.getVideoFrameDebug()
    if (fromGetter && typeof fromGetter === "object") {
      return fromGetter
    }
  }
  if (ctx.videoFrameDebug && typeof ctx.videoFrameDebug === "object") {
    return ctx.videoFrameDebug
  }
  return null
}

function shouldIncludeVideoDiagnosticFields(options = {}, inputSource = null, frame = null) {
  const sourceContext = resolveTrackingSourceContext(
    { inputSource, source: frame?.source, debug: frame?.debug },
    options
  )
  const isVideo = sourceContext.isVideoSource || Boolean(options.forceVideoDiagnosticFields)
  return {
    isVideo,
    sourceContext,
    wantTracking:
      Boolean(options.includeSelectedLandmarks) ||
      Boolean(options.includeAllLandmarks) ||
      Boolean(options.captureVideoFrameDebug) ||
      isVideo,
    wantVideoFrame: Boolean(options.captureVideoFrameDebug) || isVideo,
  }
}

/** 从 lastFrame / wire 缓存 / ctx 快照解析 trackingDebug。 */
export function resolveTrackingDebugForFrame(lastFrame, ctx = {}) {
  const sourceSeq =
    ctx?.wireSourceSeq ??
    lastFrame?.debug?.inputSource?.sourceSeq ??
    lastFrame?.frameSeq ??
    null

  const fromWire = resolveWireTrackingDebug(lastFrame, sourceSeq)
  if (fromWire && typeof fromWire === "object") {
    return fromWire
  }

  const fromSeq = peekWireTrackingDebugForSeq(sourceSeq)
  if (fromSeq && typeof fromSeq === "object") {
    return fromSeq
  }

  const fromSnapshot = ctx?.wireSnapshot?.wireTrackingDebug
  if (fromSnapshot && typeof fromSnapshot === "object") {
    return fromSnapshot
  }

  const td = lastFrame?.debug?.trackingDebug ?? lastFrame?.trackingDebug ?? null
  if (td && typeof td === "object") {
    return td
  }

  return null
}

/** compact-lite 落盘：保留 selectedLandmarks / faceBox；allLandmarks 按选项。 */
export function cloneTrackingDebugLite(trackingDebug, options = {}) {
  if (!trackingDebug || typeof trackingDebug !== "object") {
    return null
  }
  const out = {
    faceDetected: Boolean(trackingDebug.faceDetected),
    frameWidth: Number(trackingDebug.frameWidth) || undefined,
    frameHeight: Number(trackingDebug.frameHeight) || undefined,
  }
  if (trackingDebug.facePresenceConfidence != null) {
    out.facePresenceConfidence = Number(trackingDebug.facePresenceConfidence)
  }
  if (trackingDebug.selectedLandmarks && typeof trackingDebug.selectedLandmarks === "object") {
    out.selectedLandmarks = { ...trackingDebug.selectedLandmarks }
  }
  if (trackingDebug.selectedFeatureBox && typeof trackingDebug.selectedFeatureBox === "object") {
    out.selectedFeatureBox = { ...trackingDebug.selectedFeatureBox }
  }
  if (trackingDebug.faceBox && typeof trackingDebug.faceBox === "object") {
    out.faceBox = { ...trackingDebug.faceBox }
  }
  if (trackingDebug.fullFaceBox && typeof trackingDebug.fullFaceBox === "object") {
    out.fullFaceBox = { ...trackingDebug.fullFaceBox }
  }
  if (trackingDebug.faceSize && typeof trackingDebug.faceSize === "object") {
    out.faceSize = { ...trackingDebug.faceSize }
  }
  if (trackingDebug.faceScale && typeof trackingDebug.faceScale === "object") {
    out.faceScale = { ...trackingDebug.faceScale }
  }
  if (trackingDebug.previewOverlay && typeof trackingDebug.previewOverlay === "object") {
    out.previewOverlay = { ...trackingDebug.previewOverlay }
  }
  if (trackingDebug.headMotion && typeof trackingDebug.headMotion === "object") {
    out.headMotion = { ...trackingDebug.headMotion }
  }
  if (options.includeAllLandmarks && Array.isArray(trackingDebug.allLandmarks)) {
    out.allLandmarks = trackingDebug.allLandmarks
  }
  if (trackingDebug.landmarkMotion && typeof trackingDebug.landmarkMotion === "object") {
    out.landmarkMotion = { ...trackingDebug.landmarkMotion }
  }
  if (trackingDebug.motionContext && typeof trackingDebug.motionContext === "object") {
    out.motionContext = { ...trackingDebug.motionContext }
  }
  return out
}

export function cloneVideoFrameDebugLite(videoFrameDebug) {
  if (!videoFrameDebug || typeof videoFrameDebug !== "object") {
    return null
  }
  return { ...videoFrameDebug }
}

export function resolveVideoFrameDebugForFrame(ctx, inputSource, options = {}) {
  const measured = resolveMeasuredVideoFrameDebug(ctx)
  if (isVideoFrameDebugComplete(measured)) {
    return cloneVideoFrameDebugLite(measured)
  }

  const { wantVideoFrame } = shouldIncludeVideoDiagnosticFields(options, inputSource)
  if (!wantVideoFrame) {
    return isVideoFrameDebugComplete(measured) ? cloneVideoFrameDebugLite(measured) : null
  }

  const trackingDebug = resolveTrackingDebugForFrame(ctx.lastFrame, ctx)
  const fallback = buildVideoFrameDebugFromTrackingDebug(trackingDebug, measured)
  if (isVideoFrameDebugComplete(fallback)) {
    return cloneVideoFrameDebugLite(fallback)
  }

  if (measured && typeof measured === "object") {
    return cloneVideoFrameDebugLite(measured)
  }
  return null
}

/**
 * 录制落盘前强制写入顶层 frames[].trackingDebug / frames[].videoFrameDebug。
 */
export function attachVideoDiagnosticFields(frame, ctx, options = {}) {
  if (!frame) {
    return frame
  }
  const inputSource =
    resolveInputSourceFromRigFrame(ctx?.lastFrame) ||
    frame.inputSource ||
    null
  const { wantTracking, wantVideoFrame } = shouldIncludeVideoDiagnosticFields(
    options,
    inputSource,
    ctx?.lastFrame
  )

  if (wantTracking) {
    const seq =
      ctx?.wireSourceSeq ??
      ctx?.lastFrame?.debug?.inputSource?.sourceSeq ??
      frame?.sourceSeq ??
      null
    const raw =
      resolveTrackingDebugForFrame(ctx?.lastFrame, { ...ctx, wireSourceSeq: seq }) ??
      peekWireTrackingDebugForSeq(seq)
    const cloned = cloneTrackingDebugLite(raw, options)
    if (cloned) {
      frame.trackingDebug = cloned
    }
  }

  if (wantVideoFrame) {
    const vfd = resolveVideoFrameDebugForFrame(ctx, inputSource, options)
    if (vfd) {
      frame.videoFrameDebug = vfd
    }
  }

  return frame
}

/**
 * Compact 模式单帧（极小体积，无 deviceMatch / 全量 binding / packetHex）。
 */
export function buildCompactDiagnosticFrame(ctx) {
  const {
    lastFrame,
    previewRig,
    trackingStatus,
    driveMode,
    outputMode,
    deviceDriveDebug,
    dryRunResult,
    frameIndex = 0,
    options = {},
  } = ctx

  if (!lastFrame) return null

  const inputSource = resolveInputSourceFromRigFrame(lastFrame)
  const sourceSeq = normalizeFrameSeq(inputSource?.sourceSeq ?? lastFrame.frameSeq)
  const timestampMs = num(inputSource?.timestampMs ?? lastFrame.timestampMs, Date.now())
  const videoPlayback =
    lastFrame.debug?.videoPlayback && typeof lastFrame.debug.videoPlayback === "object"
      ? lastFrame.debug.videoPlayback
      : null
  const wireDiagnostic =
    lastFrame.diagnostic && typeof lastFrame.diagnostic === "object"
      ? lastFrame.diagnostic
      : null
  const isStatusFrame = Boolean(
    wireDiagnostic?.isStatusFrame ||
      wireDiagnostic?.excludeFromSummary ||
      videoPlayback?.ended ||
      videoPlayback?.excludeFromSummary
  )
  const rig = previewRig || lastFrame.rig || {}
  const sendSnap = deviceDriveDebug?.getRealSendSnapshotForSeq?.(sourceSeq) ?? null
  const realSent = Boolean(sendSnap?.sent)
  const sentFrameSeq = realSent ? normalizeFrameSeq(sendSnap?.frameSeq ?? sourceSeq) : null
  const seqLag =
    realSent && sourceSeq != null && sentFrameSeq != null ? sourceSeq - sentFrameSeq : null
  const outputs = dryRunResult?.finalServoOutputs || []
  const sourceContext = resolveTrackingSourceContext(
    { inputSource, source: { sourceType: inputSource?.sourceType ?? "camera" } },
    options
  )
  const videoDryRunEnabled = Boolean(options.videoDeviceDryRunEnabled)
  const smokeTestEnabled = Boolean(options.videoRealSendSmokeTestEnabled)
  const isVideoPreviewOnly =
    sourceContext.isVideoSource &&
    !videoDryRunEnabled &&
    !smokeTestEnabled &&
    (driveMode === "preview-only" || outputs.length === 0)
  const brow = compactBrowSummary(lastFrame.debug, rig, outputs, {
    skipBindingComparison: isVideoPreviewOnly,
    bindingComparisonSkipReason: isVideoPreviewOnly
      ? "preview-only-no-binding-output"
      : "",
  })
  const summaryChannels = summarizeRigChannels(rig)

  const frameCtx = {
    ...ctx,
    wireSourceSeq: sourceSeq,
    wireSnapshot: {
      wireTrackingDebug: resolveTrackingDebugForFrame(lastFrame, {
        ...ctx,
        wireSourceSeq: sourceSeq,
      }),
      wireInputSource: inputSource,
    },
  }

  const frame = {
    frameIndex,
    sourceSeq,
    timestampMs,
    inputSource: inputSource || null,
    source: {
      fd: Boolean(lastFrame.faceDetected ?? trackingStatus?.faceDetected),
      q: num(lastFrame.quality ?? trackingStatus?.quality),
      sourceType: inputSource?.sourceType ?? "camera",
      sourceId: inputSource?.sourceId ?? null,
      sourceSeq,
      timestampMs,
    },
    ...(videoPlayback ? { videoPlayback } : {}),
    diagnostic: {
      isStatusFrame,
      excludeFromSummary: isStatusFrame,
      statusReason: isStatusFrame
        ? String(wireDiagnostic?.statusReason || (videoPlayback?.ended ? "video-ended" : "status"))
        : null,
    },
    drive: {
      sent: realSent,
      reason: realSent
        ? "sent"
        : videoDryRunEnabled && outputs.length
          ? VIDEO_DEVICE_DRY_RUN_BLOCKED_REASON
          : sendSnap?.reason || "not-sent-this-frame",
      mode: videoDryRunEnabled
        ? "dry-run"
        : smokeTestEnabled
          ? "real_smoke_test"
          : driveMode,
      dryRun: Boolean(videoDryRunEnabled && outputs.length),
      blockedReason: videoDryRunEnabled ? VIDEO_DEVICE_DRY_RUN_BLOCKED_REASON : null,
      outputMode,
      txMode: sendSnap?.txMode ?? deviceDriveDebug?.busServoTxMode ?? null,
      packetCount: realSent ? sendSnap?.packetCount ?? null : 0,
      commandCount: videoDryRunEnabled
        ? outputs.length
        : realSent
          ? sendSnap?.commandCount ?? null
          : null,
      writeDurationMs: sendSnap?.writeDurationMs ?? null,
      sentFrameSeq,
      seqLag,
      timing: sendSnap?.timing ?? null,
      totalLatencyMs: sendSnap?.timing?.totalLatencyMs ?? null,
    },
    brow,
    summaryChannels,
  }

  if (videoDryRunEnabled && outputs.length) {
    const busCommands = dryRunResult?.busDryRun?.busCommands || []
    const slimOutputs = outputs.map(slimDryRunServoOutput).filter(Boolean)
    frame.binding = { outputs: slimOutputs, finalServoOutputCount: slimOutputs.length }
    frame.device = {
      mode: outputMode,
      drive: "dry-run",
      deviceDriveMode: "dry_run",
      videoDeviceDryRunEnabled: true,
      dryRun: {
        frameSeq: sourceSeq,
        pwm: "",
        bus: busCommands.map(slimDryRunBusCommand).filter(Boolean),
      },
      real: { sent: false, blockedReason: VIDEO_DEVICE_DRY_RUN_BLOCKED_REASON },
      deviceDriveLoopDebugSession: deviceDriveDebug?.deviceDriveLoopDebugSession ?? null,
    }
    const videoEnv = deviceDriveDebug?.lastEnvelope
    if (videoEnv?.actuatorDiagnostics) {
      frame.actuatorDiagnostics = videoEnv.actuatorDiagnostics
    } else if (busCommands.length) {
      const safety = summarizeSafetyFromCommands(busCommands)
      frame.actuatorDiagnostics = {
        safetyLimitedCountByRole: safety.safetyLimitedCountByRole,
        twitchGuardActionCountByRole: null,
        limitedActuatorRank: safety.limitedActuators.slice(0, 12),
      }
    }
  } else if (smokeTestEnabled && outputs.length) {
    const busCommands = dryRunResult?.busDryRun?.busCommands || []
    const slimOutputs = outputs.map(slimDryRunServoOutput).filter(Boolean)
    frame.binding = { outputs: slimOutputs, finalServoOutputCount: slimOutputs.length }
    frame.device = {
      ...(frame.device || {}),
      mode: outputMode,
      deviceDriveMode: "real_smoke_test",
      videoRealSendSmokeTestEnabled: true,
      smokeTestProfile: options.videoSmokeTestProfile ?? null,
      deviceDriveLoopDebugSession: deviceDriveDebug?.deviceDriveLoopDebugSession ?? null,
    }
    if (deviceDriveDebug?.deviceDriveLoopDebug) {
      frame.device.deviceDriveLoopDebug = deviceDriveDebug.deviceDriveLoopDebug
    }
    const videoEnv = deviceDriveDebug?.lastEnvelope ?? deviceDriveDebug?.frameEnvelope
    if (videoEnv?.actuatorDiagnostics) {
      frame.actuatorDiagnostics = videoEnv.actuatorDiagnostics
    } else if (busCommands.length) {
      const safety = summarizeSafetyFromCommands(busCommands)
      frame.actuatorDiagnostics = {
        safetyLimitedCountByRole: safety.safetyLimitedCountByRole,
        twitchGuardActionCountByRole: null,
        limitedActuatorRank: safety.limitedActuators.slice(0, 12),
      }
    }
  }

  const videoNeutralDiag =
    ctx.videoNeutralDiagnostic ??
    buildVideoNeutralFrameDiagnostic(
      lastFrame,
      ctx.videoNeutralSnapshot ?? null,
      ctx.videoNeutralEnabled !== false,
      ctx.videoNeutralApplyResult
    )
  frame.videoNeutral = videoNeutralDiag ?? { enabled: false, applied: false }

  const rawTrackingSignals =
    (typeof ctx.getRawTrackingSignals === "function" ? ctx.getRawTrackingSignals() : null) ??
    buildRawTrackingSignals(lastFrame, videoNeutralDiag)
  if (rawTrackingSignals) {
    frame.rawTrackingSignals = enrichRawTrackingSignalsJawTrace(
      rawTrackingSignals,
      ctx.videoSourceTuningJawTrace
    )
  }

  if (ctx.videoSourceTuningDiagnostic) {
    frame.videoSourceTuning = ctx.videoSourceTuningDiagnostic
  }
  if (ctx.videoSourceTuningShadow) {
    frame.videoSourceTuningShadow = ctx.videoSourceTuningShadow
  }

  const eyeGazeAiReview = buildEyeGazeAiReviewFields(
    lastFrame,
    previewRig,
    ctx.calibratedFrame ?? null
  )
  frame.debug = { ...(frame.debug || {}), ...eyeGazeAiReview.debug }
  frame.rig = { ...(frame.rig || {}), ...eyeGazeAiReview.rig }
  frame.eye_xy = eyeGazeAiReview.eye_xy
  frame.eyeXYStabilizer = eyeGazeAiReview.eyeXYStabilizer
  frame.faceRigUi = eyeGazeAiReview.faceRigUi
  if (eyeGazeAiReview.exportFields) {
    Object.assign(frame, eyeGazeAiReview.exportFields)
  }

  const out = attachVideoDiagnosticFields(frame, frameCtx, options)
  logCompactFrameBuilt(out)
  return out
}

/**
 * 每 COMPACT_DIAGNOSTIC_SAMPLE_MS 一次的详细 sample（非每帧）。
 */
export function buildCompactDiagnosticSample(ctx) {
  const frame = buildCompactDiagnosticFrame(ctx)
  if (!frame) return null
  const rig = ctx.previewRig || ctx.lastFrame?.rig || {}
  const outputs = (ctx.dryRunResult?.finalServoOutputs || []).slice(0, 8)
  const busCommands = (ctx.deviceDriveDebug?.getRealSendSnapshotForSeq?.(frame.sourceSeq)?.busCommands || []).slice(
    0,
    8
  )
  const packetHexFirst = ctx.deviceDriveDebug?.lastPacketHexRing?.latest?.() ?? null

  return {
    seq: frame.sourceSeq,
    ts: frame.timestampMs,
    faceRigChannels: summarizeRigChannels(rig),
    bindingOutputsTopN: outputs.map((o) => ({
      actuatorKey: o.actuatorKey,
      sourceChannel: o.sourceChannel,
      logicalValue: o.logicalValue,
      rawControlValue: o.rawControlValue ?? o.appliedControlValue,
    })),
    busCommandsTopN: busCommands,
    packetHexFirstOnly: packetHexFirst,
  }
}
