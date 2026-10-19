/**
 * Phase 3.1 — Stable tracking-dataset-v1 frame builder (independent from diagnostic export).
 */

import { normalizeFrameSeq } from "../../trackingPreview/trackingFrameEnvelope.js"
import { resolveTrackingSourceContext } from "../input/trackingSourceContext.js"
import { resolveInputSourceFromRigFrame } from "../input/trackingInputFrame.js"
import { resolveTrackingDebugForFrame } from "../diagnostics/trackingDiagnosticLite.js"
import { buildRawTrackingSignals, buildVideoNeutralFrameDiagnostic } from "../videoNeutralCalibration.js"
import { enrichRawTrackingSignalsJawTrace } from "../videoSourceTuning.js"

const DATASET_BLENDSHAPE_KEYS = [
  "browInnerUp",
  "browOuterUpLeft",
  "browOuterUpRight",
  "eyeBlinkLeft",
  "eyeBlinkRight",
  "eyeWideLeft",
  "eyeWideRight",
  "jawOpen",
  "mouthClose",
]

function roundNum(v, digits = 3) {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  const f = 10 ** digits
  return Math.round(n * f) / f
}

function num(v, fallback = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function pickBlendshapes(blend, enabled) {
  if (!enabled || !blend || typeof blend !== "object") return null
  const out = {}
  for (const k of DATASET_BLENDSHAPE_KEYS) {
    if (blend[k] != null) out[k] = roundNum(blend[k], 4)
  }
  return Object.keys(out).length ? out : null
}

function lmDistPx(a, b) {
  if (!a || !b) return null
  const ax = num(a.px ?? a.x)
  const ay = num(a.py ?? a.y)
  const bx = num(b.px ?? b.x)
  const by = num(b.py ?? b.y)
  return roundNum(Math.hypot(ax - bx, ay - by), 2)
}

function lmCenter(points) {
  const valid = (points || []).filter((p) => p && (p.px != null || p.x != null))
  if (!valid.length) return null
  let sx = 0
  let sy = 0
  for (const p of valid) {
    sx += num(p.px ?? p.x)
    sy += num(p.py ?? p.y)
  }
  return { px: sx / valid.length, py: sy / valid.length }
}

function lmBoxCenterDist(boxA, boxB) {
  if (!boxA || !boxB) return null
  const a = { px: num(boxA.centerXPx), py: num(boxA.centerYPx) }
  const b = { px: num(boxB.centerXPx), py: num(boxB.centerYPx) }
  return lmDistPx(a, b)
}

function resolveFeatureBox(td) {
  return td?.selectedFeatureBox ?? td?.faceBox ?? td?.fullFaceBox ?? null
}

function browAbsMax(rig) {
  const sideMax = (side) =>
    Math.max(
      Math.abs(num(side?.tip)),
      Math.abs(num(side?.mid)),
      Math.abs(num(side?.tail))
    )
  return roundNum(Math.max(sideMax(rig?.browL), sideMax(rig?.browR)), 3)
}

function eyeAbsMax(rig) {
  const sideMax = (side) =>
    Math.max(Math.abs(num(side?.upper)), Math.abs(num(side?.lower)))
  return roundNum(Math.max(sideMax(rig?.eyeL), sideMax(rig?.eyeR)), 3)
}

function mouthAbsMax(rig) {
  const vals = [
    rig?.mouth?.upperL,
    rig?.mouth?.upperR,
    rig?.mouth?.lowerL,
    rig?.mouth?.lowerR,
  ].map((v) => Math.abs(num(v)))
  return roundNum(Math.max(...vals, 0), 3)
}

function packRigAbs(rig) {
  if (!rig) return null
  return {
    browAbsMax: browAbsMax(rig),
    eyeAbsMax: eyeAbsMax(rig),
    jawAbsMax: roundNum(Math.abs(num(rig?.jaw?.val)), 3),
    mouthAbsMax: mouthAbsMax(rig),
  }
}

function buildQuality(trackingDebug, prevTrackingDebug, roiEnabled) {
  const sel = trackingDebug?.selectedLandmarks
  const prevSel = prevTrackingDebug?.selectedLandmarks
  const mouthCenter = lmCenter([sel?.leftMouthCorner, sel?.rightMouthCorner])
  const prevMouthCenter = prevSel
    ? lmCenter([prevSel.leftMouthCorner, prevSel.rightMouthCorner])
    : null
  const eyeCenter = lmCenter([
    sel?.leftEyeOuter,
    sel?.leftEyeInner,
    sel?.rightEyeOuter,
    sel?.rightEyeInner,
  ])
  const prevEyeCenter = prevSel
    ? lmCenter([
        prevSel.leftEyeOuter,
        prevSel.leftEyeInner,
        prevSel.rightEyeOuter,
        prevSel.rightEyeInner,
      ])
    : null
  const faceCoverageRatio =
    trackingDebug?.faceScale?.faceCoverageRatio ??
    trackingDebug?.faceCoverageRatio ??
    null
  return {
    noseDeltaPx: lmDistPx(sel?.noseTip, prevSel?.noseTip),
    mouthCenterDeltaPx: lmDistPx(mouthCenter, prevMouthCenter),
    eyeCenterDeltaPx: lmDistPx(eyeCenter, prevEyeCenter),
    faceBoxCenterDeltaPx: lmBoxCenterDist(
      resolveFeatureBox(trackingDebug),
      resolveFeatureBox(prevTrackingDebug)
    ),
    faceCoverageRatio: faceCoverageRatio != null ? roundNum(faceCoverageRatio, 4) : null,
    inferenceInputFaceCoverageRatio:
      trackingDebug?.faceScale?.inferenceInputFaceCoverageRatio != null
        ? roundNum(trackingDebug.faceScale.inferenceInputFaceCoverageRatio, 4)
        : faceCoverageRatio != null
          ? roundNum(faceCoverageRatio, 4)
          : null,
    roiEnabled: Boolean(roiEnabled),
  }
}

function monotonicNowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now()
}

function buildSync(ctx, inputSource, sourceSeq, sourceContext) {
  const sourceId = inputSource?.sourceId ?? "unknown"
  const epoch = inputSource?.sourceEpoch ?? ctx.sourceEpoch
  const videoTimeMs =
    inputSource?.videoTimeMs != null ? roundNum(inputSource.videoTimeMs, 3) : null
  const frontendReceive =
    ctx.frontendReceiveTimeMs ??
    ctx.lastFrame?._frontendReceiveTimeMs ??
    inputSource?.frontendReceiveTimeMs
  return {
    timebase: "monotonic-ms",
    syncGroupId: epoch != null ? `sourceEpoch-${epoch}` : null,
    pairingKey: `${sourceId}:sourceSeq:${sourceSeq}`,
    mediaTimeMs: sourceContext.isVideoSource ? videoTimeMs : null,
    sourceMonotonicTimeMs: roundNum(inputSource?.sourceMonotonicTimeMs, 3),
    trackingCompleteTimeMs: roundNum(inputSource?.trackingCompleteTimeMs, 3),
    frontendReceiveTimeMs: roundNum(frontendReceive, 3),
    appendSendTimeMs: roundNum(ctx.appendSendTimeMs, 3),
    appendServerReceiveTimeMs: null,
  }
}

function buildPreviewCommand(ctx, options) {
  if (!options.includePreviewCommand) {
    return {
      previewOnly: true,
      finalServoOutputCount: 0,
      servoTargets: null,
      driveSent: false,
    }
  }
  const outputs = ctx.dryRunResult?.finalServoOutputs || []
  const sendSnap = ctx.deviceDriveDebug?.getRealSendSnapshotForSeq?.(ctx.sourceSeq) ?? null
  const realSent = Boolean(sendSnap?.sent)
  const sourceContext = resolveTrackingSourceContext(
    { inputSource: ctx.inputSource },
    ctx.options || {}
  )
  const previewOnly =
    sourceContext.isVideoSource ||
    ctx.driveMode === "preview-only" ||
    outputs.length === 0
  const servoTargets = outputs.length
    ? outputs.slice(0, 16).map((o) => ({
        actuatorKey: o.actuatorKey ?? null,
        sourceChannel: o.sourceChannel ?? null,
        logicalValue: roundNum(o.logicalValue, 3),
        rawControlValue: roundNum(o.rawControlValue ?? o.appliedControlValue, 3),
      }))
    : null
  return {
    previewOnly,
    finalServoOutputCount: outputs.length,
    servoTargets,
    driveSent: realSent,
  }
}

/**
 * @param {object} ctx
 * @param {object} [prevCtx]
 */
export function buildTrackingDatasetFrame(ctx, prevCtx = null) {
  const { lastFrame, sessionId, options = {} } = ctx
  if (!lastFrame || !sessionId) return null

  const inputSource = resolveInputSourceFromRigFrame(lastFrame)
  const sourceSeq = normalizeFrameSeq(inputSource?.sourceSeq ?? lastFrame.frameSeq)
  const sourceContext = resolveTrackingSourceContext(
    { inputSource, source: lastFrame.source, debug: lastFrame.debug },
    options
  )
  const trackingDebug = resolveTrackingDebugForFrame(lastFrame, {
    ...ctx,
    wireSourceSeq: sourceSeq,
  })
  const prevTrackingDebug = prevCtx?.lastFrame
    ? resolveTrackingDebugForFrame(prevCtx.lastFrame, {
        ...prevCtx,
        wireSourceSeq: prevCtx.sourceSeq,
      })
    : null

  const wireDiagnostic =
    lastFrame.diagnostic && typeof lastFrame.diagnostic === "object"
      ? lastFrame.diagnostic
      : null
  const videoPlayback =
    lastFrame.debug?.videoPlayback && typeof lastFrame.debug.videoPlayback === "object"
      ? lastFrame.debug.videoPlayback
      : null
  const isStatusFrame = Boolean(
    wireDiagnostic?.isStatusFrame ||
      wireDiagnostic?.excludeFromSummary ||
      videoPlayback?.ended ||
      videoPlayback?.excludeFromSummary
  )
  if (isStatusFrame) return null

  const timestampMs = num(inputSource?.timestampMs ?? lastFrame.timestampMs, Date.now())
  const recordFrameIndex = ctx.recordFrameIndex ?? 0
  const recordSeq = recordFrameIndex + 1
  const recordTimeMs =
    ctx.recordStartMonotonicMs != null
      ? roundNum(monotonicNowMs() - ctx.recordStartMonotonicMs, 3)
      : roundNum(recordFrameIndex * (1000 / 30), 3)
  const sourceFrameIndex =
    inputSource?.frameIndex != null && Number.isFinite(Number(inputSource.frameIndex))
      ? Number(inputSource.frameIndex)
      : null
  const shadow = ctx.videoSourceTuningShadow
  const calibratedRig = ctx.calibratedFrame?.rig
  const previewRig = ctx.previewRig || lastFrame.rig || {}
  const untunedRig = shadow?.untuned
    ? {
        browAbsMax: shadow.untuned.browAbsMax,
        eyeAbsMax: shadow.untuned.eyeAbsMax,
        jawAbsMax: shadow.untuned.jawAbsMax,
        mouthAbsMax: shadow.untuned.mouthAbsMax,
      }
    : packRigAbs(calibratedRig || previewRig)
  const tunedRig = shadow?.tuned
    ? {
        browAbsMax: shadow.tuned.browAbsMax,
        eyeAbsMax: shadow.tuned.eyeAbsMax,
        jawAbsMax: shadow.tuned.jawAbsMax,
        mouthAbsMax: shadow.tuned.mouthAbsMax,
      }
    : packRigAbs(previewRig)

  const videoNeutralDiag =
    ctx.videoNeutralDiagnostic ??
    buildVideoNeutralFrameDiagnostic(
      lastFrame,
      ctx.videoNeutralSnapshot ?? null,
      ctx.videoNeutralEnabled !== false,
      ctx.videoNeutralApplyResult
    )
  let rawTrackingSignals =
    (typeof ctx.getRawTrackingSignals === "function" ? ctx.getRawTrackingSignals() : null) ??
    buildRawTrackingSignals(lastFrame, videoNeutralDiag)
  if (rawTrackingSignals && options.includeRawTrackingSignals !== false) {
    rawTrackingSignals = enrichRawTrackingSignalsJawTrace(
      rawTrackingSignals,
      ctx.videoSourceTuningJawTrace
    )
  } else {
    rawTrackingSignals = null
  }

  const blendFromDebug = lastFrame.debug?.blendshapes ?? trackingDebug?.blendshapes
  const blendshapes = pickBlendshapes(blendFromDebug, options.includeBlendshapes !== false)

  let videoSourceTuning = ctx.videoSourceTuningDiagnostic ?? null
  if (!sourceContext.isVideoSource) {
    videoSourceTuning = {
      enabled: false,
      applied: false,
      sourceType: inputSource?.sourceType ?? "camera",
    }
  } else if (videoSourceTuning && options.includeTunedRig === false) {
    videoSourceTuning = {
      enabled: Boolean(videoSourceTuning.enabled),
      applied: Boolean(videoSourceTuning.applied),
      sourceType: inputSource?.sourceType ?? "video",
    }
  }

  const frameCtx = {
    ...ctx,
    inputSource,
    sourceSeq,
  }

  const tracking = {
    faceDetected: Boolean(
      trackingDebug?.faceDetected ?? lastFrame.faceDetected ?? ctx.trackingStatus?.faceDetected
    ),
  }
  if (blendshapes) tracking.blendshapes = blendshapes
  if (rawTrackingSignals) tracking.rawTrackingSignals = rawTrackingSignals
  if (options.includeLandmarks && trackingDebug?.selectedLandmarks) {
    tracking.landmarks = trackingDebug.selectedLandmarks
  }

  const frame = {
    sessionId,
    record: {
      recordFrameIndex,
      recordSeq,
      recordTimeMs,
    },
    source: {
      sourceType: inputSource?.sourceType ?? "camera",
      sourceId: inputSource?.sourceId ?? null,
      sourceEpoch: inputSource?.sourceEpoch ?? ctx.sourceEpoch ?? null,
      sourceSeq,
      sourceFrameIndex,
      frameIndex: sourceFrameIndex,
      timestampMs: roundNum(timestampMs, 3),
      videoTimeMs:
        inputSource?.videoTimeMs != null ? roundNum(inputSource.videoTimeMs, 3) : null,
      seekEpoch: inputSource?.seekEpoch ?? null,
      ...(inputSource?.uploadedVideoId
        ? { uploadedVideoId: inputSource.uploadedVideoId }
        : {}),
      ...(inputSource?.cameraId
        ? {
            cameraId: inputSource.cameraId,
            cameraIndex: inputSource.cameraIndex ?? null,
            cameraLabel: inputSource.cameraLabel ?? null,
            cameraWidth: inputSource.cameraWidth ?? null,
            cameraHeight: inputSource.cameraHeight ?? null,
            cameraFps: inputSource.cameraFps ?? null,
          }
        : {}),
    },
    tracking,
    rig: {
      untuned: options.includeTunedRig !== false ? untunedRig : null,
      tuned: options.includeTunedRig !== false ? tunedRig : null,
    },
    videoSourceTuning: videoSourceTuning ?? {
      enabled: false,
      applied: false,
      sourceType: inputSource?.sourceType ?? "camera",
    },
    previewCommand: buildPreviewCommand(frameCtx, options),
    quality: buildQuality(trackingDebug, prevTrackingDebug, ctx.roiEnabled),
    sync: buildSync(ctx, inputSource, sourceSeq, sourceContext),
  }

  return frame
}
