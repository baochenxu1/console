import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { loadActuatorProfiles } from "../../output/loadActuatorProfiles.js"
import { createTrackingBusPipelineState } from "../../output/trackingBusPipelineState.js"
import { createRightMouthCornerFivebarState } from "../../kinematics/mouthCornerFivebar.js"
import { buildMapFaceRigToPoseOptionsFromMouthRuntimes } from "../../kinematics/mouthFiveBarRuntimeOptions.js"
import { buildVideoDeviceDryRunEnvelope } from "../../trackingPreview/buildVideoDeviceDryRunEnvelope.js"
import { OUTPUT_MODES } from "../../trackingPreview/trackingPreviewConstants.js"
import {
  MAX_DEVICE_ENVELOPES,
  pruneSeqMap,
  summarizeSafetyFromCommands,
  summarizeTwitchFromDebug,
} from "../../trackingPreview/deviceDriveDiagnostics.js"
import { VIDEO_DEVICE_DRIVE_MODES } from "../../trackingPreview/videoDeviceDryRunConstants.js"

const EMPTY_DRY_RUN = {
  logicalPose: {},
  actualPose: {},
  commandPreview: "",
  warnings: [],
  diagnostics: null,
  finalServoOutputs: [],
}

function createVideoDryRunLoopDebug() {
  return {
    dryRunFrameCount: 0,
    dryRunCommandCount: 0,
    inputUniqueFrameCount: 0,
    realSentFrameCount: 0,
    realTxCount: 0,
    realBusPacketCount: 0,
    sendCommandCount: 0,
    sendFrameCount: 0,
  }
}

/**
 * Video / Upload：binding + safety + command snapshot，禁止真实总线写入。
 */
export function useVideoDeviceDryRun({
  enabled = false,
  previewSourceRunning = false,
  isVideoSource = false,
  previewRig,
  profile,
  configs = [],
  outputMode = OUTPUT_MODES.BUS_SERVO,
  trackingFrameSeq = null,
  trackingTimestampMs = null,
  eyeReleaseDebug = null,
  actuatorProfiles: actuatorProfilesProp = null,
}) {
  const rightFiveBarRef = useRef(createRightMouthCornerFivebarState())
  const leftFiveBarRef = useRef(createRightMouthCornerFivebarState())
  const mapOptsRef = useRef(
    buildMapFaceRigToPoseOptionsFromMouthRuntimes({
      rightState: rightFiveBarRef.current,
      leftState: leftFiveBarRef.current,
    })
  )
  const pipelineRef = useRef(
    createTrackingBusPipelineState({
      ownerId: "video-device-dry-run",
      consumerType: "preview-video-dry-run",
    })
  )
  const twitchGuardStateRef = useRef(pipelineRef.current.twitchGuardState)
  const envelopeBySeqRef = useRef(new Map())
  const loopDebugRef = useRef(createVideoDryRunLoopDebug())
  const lastProcessedSeqRef = useRef(null)

  const [dryRunResult, setDryRunResult] = useState(EMPTY_DRY_RUN)
  const [lastEnvelope, setLastEnvelope] = useState(null)

  const actuatorProfiles = useMemo(() => {
    if (Array.isArray(actuatorProfilesProp) && actuatorProfilesProp.length) {
      return actuatorProfilesProp
    }
    return loadActuatorProfiles().actuatorProfiles
  }, [actuatorProfilesProp])

  const active = Boolean(enabled && previewSourceRunning && isVideoSource)

  const resetState = useCallback(() => {
    pipelineRef.current = createTrackingBusPipelineState({
      ownerId: "video-device-dry-run",
      consumerType: "preview-video-dry-run",
    })
    twitchGuardStateRef.current = pipelineRef.current.twitchGuardState
    envelopeBySeqRef.current.clear()
    loopDebugRef.current = createVideoDryRunLoopDebug()
    lastProcessedSeqRef.current = null
    setDryRunResult(EMPTY_DRY_RUN)
    setLastEnvelope(null)
  }, [])

  useEffect(() => {
    if (!active) {
      resetState()
    }
  }, [active, resetState])

  useEffect(() => {
    if (!active || !previewRig || typeof previewRig !== "object") {
      return
    }
    const seq = Number.isFinite(Number(trackingFrameSeq)) ? Number(trackingFrameSeq) : null
    if (seq != null && seq === lastProcessedSeqRef.current) {
      return
    }
    lastProcessedSeqRef.current = seq

    const eyeReleasing = Boolean(
      eyeReleaseDebug?.leftReleasing || eyeReleaseDebug?.rightReleasing
    )
    const envelope = buildVideoDeviceDryRunEnvelope({
      profile,
      rig: previewRig,
      configs,
      outputMode,
      actuatorProfiles,
      pipelineState: pipelineRef.current,
      frameSeq: seq,
      timestampMs: trackingTimestampMs ?? Date.now(),
      eyeReleasing,
      mapFaceRigToPoseOptions: mapOptsRef.current,
      twitchGuardState: twitchGuardStateRef.current,
    })

    const loop = loopDebugRef.current
    loop.dryRunFrameCount += 1
    loop.inputUniqueFrameCount = seq != null ? envelopeBySeqRef.current.size + 1 : loop.dryRunFrameCount
    loop.dryRunCommandCount += envelope.device?.commandCount || 0
    loop.realSentFrameCount = 0
    loop.realTxCount = 0
    loop.realBusPacketCount = 0
    loop.sendCommandCount = 0
    loop.sendFrameCount = 0

    if (seq != null) {
      envelopeBySeqRef.current.set(seq, envelope)
      pruneSeqMap(envelopeBySeqRef.current, MAX_DEVICE_ENVELOPES)
    }

    setDryRunResult(envelope.dryRunResult || EMPTY_DRY_RUN)
    setLastEnvelope(envelope)
  }, [
    active,
    previewRig,
    profile,
    configs,
    outputMode,
    actuatorProfiles,
    trackingFrameSeq,
    trackingTimestampMs,
    eyeReleaseDebug,
  ])

  const getDryRunSnapshotForSeq = useCallback((seq) => {
    const n = Number(seq)
    if (!Number.isFinite(n)) return null
    const env = envelopeBySeqRef.current.get(n)
    if (!env) return null
    return {
      frameSeq: n,
      sent: false,
      reason: "video-dry-run-no-hardware",
      dryRun: true,
      busCommands: env.busCommands || [],
      commandCount: env.device?.commandCount || 0,
      packetCount: 0,
      commandPreview: env.commandPreview || "",
      safetyStats: summarizeSafetyFromCommands(env.busCommands || []),
      twitchStats: env.actuatorDiagnostics
        ? {
            twitchGuardActionCountByRole: env.actuatorDiagnostics.twitchGuardActionCountByRole,
            limitedActuators: env.actuatorDiagnostics.limitedActuatorRank,
          }
        : summarizeTwitchFromDebug([], null),
    }
  }, [])

  const deviceDriveDebug = useMemo(
    () => ({
      armed: false,
      canSend: false,
      note: active ? "video-device-dry-run" : "video-dry-run-off",
      deviceDriveMode: active ? VIDEO_DEVICE_DRIVE_MODES.DRY_RUN : VIDEO_DEVICE_DRIVE_MODES.OFF,
      videoDeviceDryRunEnabled: enabled,
      realSendSnapshots: null,
      getRealSendSnapshotForSeq: getDryRunSnapshotForSeq,
      deviceDriveLoopDebug: loopDebugRef.current,
      deviceDriveLoopDebugSession: { ...loopDebugRef.current },
      busOutputDebug: lastEnvelope?.busOutputDebug ?? null,
      lastEnvelope,
      outputMode,
    }),
    [active, enabled, getDryRunSnapshotForSeq, lastEnvelope, outputMode]
  )

  return {
    active,
    dryRunResult,
    deviceDriveDebug,
    lastEnvelope,
    loopDebug: loopDebugRef.current,
    resetState,
  }
}
