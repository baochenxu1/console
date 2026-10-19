import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { buildFinalServoOutputsFromBindings } from "../../output/buildFinalServoOutputsFromBindings.js"
import { loadActuatorProfiles } from "../../output/loadActuatorProfiles.js"
import { pwmToLogical } from "../../output/pwmLogicalConvert.js"
import {
  buildBusCommandsFromFinalOutputs,
  buildBusOutputDebug,
  formatBusCommandsPreview,
} from "../../output/adapters/busServoOutputAdapter.js"
import {
  commitActuatorSafetyStates,
  DEFAULT_TRACKING_ACTUATOR_SAFETY,
} from "../../output/actuatorOutputSafety.js"
import {
  applyUpperFaceTwitchGuardToCommands,
  commitUpperFaceTwitchGuardState,
  DEFAULT_TRACKING_UPPER_FACE_TWITCH_GUARD,
} from "../../output/upperFaceTwitchGuard.js"
import {
  createTrackingBusPipelineState,
  resetDeviceBusPipelineState,
} from "../../output/trackingBusPipelineState.js"
import {
  createTrackingFrameEnvelope,
} from "../../trackingPreview/trackingFrameEnvelope.js"
import { buildBusCommandSendKey } from "../../servoAdapters/busServo/buildBusCommandSendKey.js"
import { sendBusServoCommands } from "../../servoAdapters/busServo/sendBusServoCommands.js"
import { DEFAULT_SC_BAUDRATE } from "../../servoAdapters/scservo/scProtocolConstants.js"
import {
  getActiveBusTransportLabel,
  normalizeBusTransportFamily,
  resolveBusBaudConfig,
  resolveBusTransportByFamily,
} from "../../servoAdapters/busServo/resolveBusTransport.js"
import { buildTrackingDryRunResult } from "../../trackingPreview/buildTrackingDryRunResult.js"
import { createRightMouthCornerFivebarState } from "../../kinematics/mouthCornerFivebar.js"
import { buildMapFaceRigToPoseOptionsFromMouthRuntimes } from "../../kinematics/mouthFiveBarRuntimeOptions.js"
import { evaluateDeviceDriveGates } from "../../trackingPreview/evaluateDeviceDriveGates.js"
import { mapTrackingPreviewPose } from "../../trackingPreview/mapTrackingPreviewPose.js"
import { resolveLatestFrameSendDecision } from "../../trackingPreview/resolveLatestFrameSendDecision.js"
import {
  DRIVE_MODES,
  DEVICE_DRIVE_DEFAULTS,
  OUTPUT_MODES,
  DIAGNOSTIC_MODES,
  TRACKING_DEVICE_DRIVE_ARM_DEFAULTS,
} from "../../trackingPreview/trackingPreviewConstants.js"
import { sendTrackingPreviewArmWarmup, blendFinalOutputsToward } from "../../trackingPreview/sendTrackingPreviewArmWarmup.js"
import {
  buildMinimalRealSendSnapshot,
  createRingBuffer,
  createSendPumpTiming,
  MAX_DEVICE_ENVELOPES,
  MAX_REAL_SEND_SNAPSHOTS,
  pruneSeqMap,
  recordPhaseMs,
  recordPumpTick,
  shouldBuildUiDebug,
  exportSendPumpTiming,
  summarizeSafetyFromCommands,
  summarizeTwitchFromDebug,
} from "../../trackingPreview/deviceDriveDiagnostics.js"

const FPS_WINDOW_MS = 500
const UI_DIAGNOSTICS_MS = 250
const SEND_INTERVAL_SLOW_MS = 80

function enrichSentBusCommands(commands, writeResult) {
  const sentSet = new Set(writeResult?.sentServoIds ?? [])
  return (commands || []).map((c) => ({
    ...c,
    sent: sentSet.has(c.busServoId),
    sendMode: writeResult?.sendModeByBusServoId?.[c.busServoId] ?? null,
    realSentTargetPosition: sentSet.has(c.busServoId) ? c.targetPosition ?? null : null,
    twitchGuardTargetPosition:
      c.twitchGuardTargetPosition ?? c.twitchGuard?.outputTarget ?? c.targetPosition ?? null,
  }))
}

function createDeviceDriveLoopDebug(txMode = DEVICE_DRIVE_DEFAULTS.busServoTxMode) {
  return {
    pushAttemptCount: 0,
    sendAttemptCount: 0,
    sendSuccessCount: 0,
    sendFrameCount: 0,
    sendPacketCount: 0,
    sendCommandCount: 0,
    realBusPacketCount: 0,
    skippedByFpsLimit: 0,
    skippedNoNewFrame: 0,
    skippedSeqRegression: 0,
    skippedByStaleFrame: 0,
    notArmedCount: 0,
    notConnectedCount: 0,
    inputUniqueFrameCount: 0,
    inputUniqueFps: null,
    sendFrameFps: null,
    writeDurationMsMin: null,
    writeDurationMsAvg: null,
    writeDurationMsMax: 0,
    sendIntervalMsAvg: null,
    sendIntervalMsP90: null,
    sendIntervalMsMax: null,
    sendIntervalOver80msCount: 0,
    sameSeqResendCount: 0,
    droppedStalePendingFrames: 0,
    writeInFlightCount: 0,
    realSendUniqueFrameCount: 0,
    realSendUniqueFrameFps: null,
    sentFrameSeqList: /** @type {number[]} */ ([]),
    sourceSeqMinusSentSeqLagAvg: null,
    sourceSeqMinusSentSeqLagMax: 0,
    duplicateRealSnapshotAttachCount: 0,
    txMode,
  }
}

/**
 * @param {number} servoId
 * @param {import("../../core/faceRigProfile.js").FaceRigProfile | object | null | undefined} profile
 */
function bindingRoleForServo(servoId, profile) {
  const bindings = profile?.bindings
  if (!Array.isArray(bindings)) {
    return "other"
  }
  const sid = Number(servoId)
  const b = bindings.find((x) => x.enabled !== false && Number(x.servoId) === sid)
  if (!b) {
    return "other"
  }
  if (b.controlId === "jaw") {
    return "jaw"
  }
  if (b.controlId === "mouth" && ["UL", "UR", "LL", "LR"].includes(String(b.channel || ""))) {
    return "lip"
  }
  return "other"
}

function applyPwmDeadbandToFinalOutputs(outputs, lastPwmMap, profile, defs) {
  return (outputs || []).map((out) => {
    const sid = out.legacyServoIndex
    const prev = lastPwmMap.get(sid)
    const pwm = out.pwmValue
    if (pwm == null || !Number.isFinite(sid)) {
      return out
    }
    const role = bindingRoleForServo(sid, profile)
    let thr = defs.minPwmDeltaUs
    if (role === "jaw") {
      thr = defs.jawMinPwmDeltaUs
    } else if (role === "lip") {
      thr = defs.lipMinPwmDeltaUs
    }
    if (prev !== undefined && thr > 0 && Math.abs(pwm - prev) < thr) {
      return {
        ...out,
        pwmValue: prev,
        logicalValue: pwmToLogical(prev),
      }
    }
    return out
  })
}

function applyLipRigDeadbandToRig(rig, defs) {
  if (!rig || typeof rig !== "object") return { rig, applied: false }
  const thr = Number(defs?.lipRigDeadband) || 0
  if (thr <= 0) return { rig, applied: false }
  const mouth = rig.mouth
  if (!mouth || typeof mouth !== "object") return { rig, applied: false }
  const out = { ...rig, mouth: { ...mouth } }
  let applied = false
  for (const k of ["UL", "UR", "LL", "LR"]) {
    const v = Number(out.mouth[k]) || 0
    if (Math.abs(v) < thr) {
      out.mouth[k] = 0
      applied = true
    }
  }
  return { rig: out, applied }
}

/** Device Drive：当前舵机类型对应串口是否已连接（不做混搭）。 */
function isActiveFamilyPortConnected(transportFamily) {
  const transport = resolveBusTransportByFamily(transportFamily)
  return Boolean(transport.getStatus()?.connected)
}

/**
 * Phase 4.1-F：Camera Tracking → mapFaceRigToPose → WebSerial（全通道）。
 * 热路径仅轻量 mapFaceRigToPose；诊断/UI 预览降频，避免 interval 被 React 重建。
 */
export function useTrackingPreviewDeviceDrive({
  driveMode,
  deviceDriveArmed,
  outputMode = OUTPUT_MODES.BUS_SERVO,
  busServoTxMode = DEVICE_DRIVE_DEFAULTS.busServoTxMode,
  diagnosticMode = DEVICE_DRIVE_DEFAULTS.diagnosticMode,
  baudRate = DEFAULT_SC_BAUDRATE,
  transportFamily = "feetech",
  previewRig,
  profile,
  configs = [],
  trackingStatus,
  cameraRunning,
  trackingRunning = false,
  trackingInputSourceType = "camera",
  trackingFrameSeq = null,
  eyeReleaseDebug = null,
  onCommandSent,
  onSerialError,
}) {
  const rightFiveBarRef = useRef(createRightMouthCornerFivebarState())
  const leftFiveBarRef = useRef(createRightMouthCornerFivebarState())
  const mapOptsRef = useRef(
    buildMapFaceRigToPoseOptionsFromMouthRuntimes({
      rightState: rightFiveBarRef.current,
      leftState: leftFiveBarRef.current,
    })
  )

  const logicalPoseRef = useRef(/** @type {Record<string, number>} */ ({}))
  const previewRigRef = useRef(previewRig)
  const profileRef = useRef(profile)
  const configsRef = useRef(configs)
  const trackingStatusRef = useRef(trackingStatus)
  const cameraRunningRef = useRef(cameraRunning)
  const trackingRunningRef = useRef(trackingRunning)
  const trackingInputSourceTypeRef = useRef(trackingInputSourceType)
  const deviceDriveArmedRef = useRef(deviceDriveArmed)
  const driveModeRef = useRef(driveMode)
  const outputModeRef = useRef(outputMode)
  const busServoTxModeRef = useRef(busServoTxMode)
  const diagnosticModeRef = useRef(diagnosticMode)
  const baudRateRef = useRef(baudRate)
  const transportFamilyRef = useRef(normalizeBusTransportFamily(transportFamily))
  const sendPumpTimingRef = useRef(createSendPumpTiming())
  const lastPumpTickAtRef = useRef(0)
  const lastEnvelopeUiAtRef = useRef(0)
  const lastDeviceEnvelopeRef = useRef(/** @type {object | null} */ (null))
  const packetHexRingRef = useRef(createRingBuffer())

  const [actuatorProfileEpoch, setActuatorProfileEpoch] = useState(0)
  const actuatorBundle = useMemo(() => loadActuatorProfiles(), [actuatorProfileEpoch])
  const actuatorProfilesRef = useRef(actuatorBundle.actuatorProfiles)
  actuatorProfilesRef.current = actuatorBundle.actuatorProfiles

  useEffect(() => {
    const onChanged = () => setActuatorProfileEpoch((n) => n + 1)
    window.addEventListener("facedev:busServoProfilesChanged", onChanged)
    return () => window.removeEventListener("facedev:busServoProfilesChanged", onChanged)
  }, [])

  const serialBusyRef = useRef(false)
  const stopInProgressRef = useRef(false)
  const stopTokenRef = useRef(0)
  const lastSentPwmRef = useRef(new Map())
  const lastSentBusPosRef = useRef(new Map())
  const actuatorSafetyStateRef = useRef(null)
  const busPipelineStateRef = useRef(null)
  const lastCommandRef = useRef("")
  const lastSentAtRef = useRef(0)
  /** previewRig 最近一次更新时刻（每个 tracking 帧触发）；trackingStatus.lastAt 是 120ms 轮询快照，不能用作帧节拍 */
  const rigUpdatedAtRef = useRef(0)
  const lastFrameTimestampRef = useRef(0)
  /** tracking payload 的 frameSeq：stale 判断首选依据 */
  const trackingFrameSeqRef = useRef(/** @type {number | null} */ (null))
  const lastAcceptedSourceSeqRef = useRef(/** @type {number | null} */ (null))
  const lastSentFrameSeqRef = useRef(/** @type {number | null} */ (null))
  const sentFrameSeqListRef = useRef(/** @type {number[]} */ ([]))
  const seqLagSamplesRef = useRef(/** @type {number[]} */ ([]))
  /** rig + frameSeq 原子快照（同一 effect 更新，禁止跨 ref 拼帧） */
  const frameSnapshotRef = useRef(
    /** @type {{ frameSeq: number | null, rig: object | null, updatedAt: number } | null} */ (null)
  )
  const eyeReleaseDebugRef = useRef(eyeReleaseDebug)
  const envelopeBySeqRef = useRef(/** @type {Map<number, object>} */ (new Map()))
  const realSendSnapshotBySeqRef = useRef(/** @type {Map<number, object>} */ (new Map()))
  const busOutputDebugRef = useRef(/** @type {object | null} */ (null))
  const lastBusDebugUiAtRef = useRef(0)
  /** uiDryRun 专用 pipeline 状态：与实机 device state、共享诊断单例隔离，避免互相污染 prev target */
  const uiDryRunPipelineRef = useRef(/** @type {import("../../output/trackingBusPipelineState.js").TrackingBusPipelineState | null} */ (null))
  const sendCountRef = useRef(0)
  const realSendCountRef = useRef(0)
  const inputUniqueSeqRef = useRef(/** @type {Set<number>} */ (new Set()))
  const realSendUniqueSeqRef = useRef(/** @type {Set<number>} */ (new Set()))
  const writeDurationSamplesRef = useRef(/** @type {number[]} */ ([]))
  const sendIntervalSamplesRef = useRef(/** @type {number[]} */ ([]))
  const lastSuccessfulSendAtRef = useRef(0)
  const droppedByFpsLimitRef = useRef(0)
  const lastRealSendAtRef = useRef(0)
  const onCommandSentRef = useRef(onCommandSent)
  const onSerialErrorRef = useRef(onSerialError)
  const lipRigDeadbandAppliedRef = useRef(false)
  const latestPendingSendRef = useRef(false)
  /** 新 tracking 帧到达时已 schedule 的 wake，避免同一 seq 重复 queueMicrotask */
  const frameWakeScheduledSeqRef = useRef(/** @type {number | null} */ (null))
  const armWarmupInProgressRef = useRef(false)
  const armWarmupTokenRef = useRef(0)
  const prevDeviceDriveArmedRef = useRef(false)
  const serialWriteDebugRef = useRef({
    writeInFlight: false,
    latestPendingFrameSeq: null,
    droppedStalePendingFrames: 0,
    writeDurationMs: 0,
    maxWriteDurationMs: 0,
    queueDepth: 0,
  })
  const deviceDriveLoopDebugRef = useRef(
    createDeviceDriveLoopDebug(busServoTxMode)
  )

  const [sendFps, setSendFps] = useState(/** @type {number | null} */ (null))
  const [realSendFps, setRealSendFps] = useState(/** @type {number | null} */ (null))
  const [lastSkipReason, setLastSkipReason] = useState("")
  const [busOutputDebug, setBusOutputDebug] = useState(/** @type {object | null} */ (null))
  const [uiDryRunResult, setUiDryRunResult] = useState(
    /** @type {ReturnType<typeof buildTrackingDryRunResult> | null} */ (null)
  )
  const [lastDeviceEnvelope, setLastDeviceEnvelope] = useState(
    /** @type {ReturnType<typeof createTrackingFrameEnvelope> | null} */ (null)
  )
  const [armWarmupInProgress, setArmWarmupInProgress] = useState(false)

  previewRigRef.current = previewRig
  profileRef.current = profile
  configsRef.current = configs
  trackingStatusRef.current = trackingStatus
  trackingFrameSeqRef.current = Number.isFinite(Number(trackingFrameSeq))
    ? Number(trackingFrameSeq)
    : null
  cameraRunningRef.current = cameraRunning
  trackingRunningRef.current = trackingRunning
  trackingInputSourceTypeRef.current = trackingInputSourceType || "camera"
  deviceDriveArmedRef.current = deviceDriveArmed
  driveModeRef.current = driveMode
  outputModeRef.current = outputMode
  busServoTxModeRef.current = busServoTxMode
  diagnosticModeRef.current = diagnosticMode
  baudRateRef.current = baudRate
  transportFamilyRef.current = normalizeBusTransportFamily(transportFamily)
  deviceDriveLoopDebugRef.current.txMode = busServoTxMode
  onCommandSentRef.current = onCommandSent
  onSerialErrorRef.current = onSerialError
  eyeReleaseDebugRef.current = eyeReleaseDebug

  const deviceDriveMode = driveMode === DRIVE_MODES.DEVICE_DRIVE
  const realSendActive = deviceDriveMode && deviceDriveArmed
  const isBusOutput = true
  const serialConnected = isActiveFamilyPortConnected(transportFamily)
  const busSerialConnected = serialConnected
  const profilesReady = actuatorBundle.allowRealSend

  // rig + frameSeq 原子快照：禁止 pushToDevice 从多个异步 ref 拼帧
  useEffect(() => {
    if (!previewRig || typeof previewRig !== "object") {
      return
    }
    const seq = Number.isFinite(Number(trackingFrameSeq)) ? Number(trackingFrameSeq) : null
    const updatedAt = Date.now()
    frameSnapshotRef.current = {
      frameSeq: seq,
      timestampMs: updatedAt,
      rig: previewRig,
      quality: Number(trackingStatusRef.current?.quality) || 0,
      faceDetected: Boolean(trackingStatusRef.current?.faceDetected),
      updatedAt,
    }
    rigUpdatedAtRef.current = updatedAt
    trackingFrameSeqRef.current = seq
    if (seq != null && realSendActive) {
      inputUniqueSeqRef.current.add(seq)
      // 新帧到达立即唤醒发送泵（仅新 frameSeq；勿按 updatedAt，calibration 每帧刷新会饿死主线程）
      if (
        seq !== lastSentFrameSeqRef.current &&
        seq !== frameWakeScheduledSeqRef.current &&
        !trackingStatusRef.current?.videoPaused
      ) {
        frameWakeScheduledSeqRef.current = seq
        queueMicrotask(() => {
          frameWakeScheduledSeqRef.current = null
          void pushToDeviceRef.current?.()
        })
      }
    }
  }, [previewRig, trackingFrameSeq, realSendActive, trackingStatus])

  // 随 tracking 帧更新姿态（轻量）；不触发 pushToDevice / interval 重建
  useEffect(() => {
    if (!deviceDriveMode) {
      return
    }
    const snap = frameSnapshotRef.current
    const rigForMap = snap?.rig ?? previewRigRef.current
    const deadbandRigResult = applyLipRigDeadbandToRig(rigForMap, DEVICE_DRIVE_DEFAULTS)
    lipRigDeadbandAppliedRef.current = Boolean(deadbandRigResult.applied)
    const mapped = mapTrackingPreviewPose({
      profile: profileRef.current,
      rig: deadbandRigResult.rig,
      configs: configsRef.current,
      mapFaceRigToPoseOptions: mapOptsRef.current,
    })
    logicalPoseRef.current = mapped.logicalPose || {}
  }, [deviceDriveMode, previewRig, trackingFrameSeq])

  // Mapping 面板用 Dry Run 诊断（降频，避免卡主线程）
  useEffect(() => {
    if (!deviceDriveMode) {
      setUiDryRunResult(null)
      uiDryRunPipelineRef.current = null
      return undefined
    }
    const tick = () => {
      if (!uiDryRunPipelineRef.current) {
        uiDryRunPipelineRef.current = createTrackingBusPipelineState({
          ownerId: "ui-dry-run",
          consumerType: "device-drive-ui",
        })
      }
      const snap = frameSnapshotRef.current
      const rigForDry = snap?.rig ?? previewRigRef.current
      const deadbandRigResult = applyLipRigDeadbandToRig(rigForDry, DEVICE_DRIVE_DEFAULTS)
      lipRigDeadbandAppliedRef.current = Boolean(deadbandRigResult.applied)
      const eyeDbg = eyeReleaseDebugRef.current
      const eyeReleasing = Boolean(eyeDbg?.leftReleasing || eyeDbg?.rightReleasing)
      setUiDryRunResult(
        buildTrackingDryRunResult({
          profile: profileRef.current,
          rig: deadbandRigResult.rig,
          configs: configsRef.current,
          outputMode: outputModeRef.current,
          actuatorProfiles: actuatorProfilesRef.current,
          mapFaceRigToPoseOptions: mapOptsRef.current,
          busPipelineState: uiDryRunPipelineRef.current,
          sourceFrameIndex: snap?.frameSeq ?? null,
          sourceTimestampMs: snap?.updatedAt ?? null,
          eyeReleasing,
        })
      )
    }
    tick()
    const id = window.setInterval(tick, UI_DIAGNOSTICS_MS)
    return () => window.clearInterval(id)
  }, [deviceDriveMode, previewRig, profile, configs, outputMode])

  const gates = useMemo(
    () =>
      evaluateDeviceDriveGates({
        armed: deviceDriveArmed,
        cameraRunning,
        serialConnected,
        busSerialConnected,
        busFamilyLabel: getActiveBusTransportLabel(transportFamily),
        outputMode,
        profilesReady,
        faceDetected: Boolean(trackingStatus?.faceDetected),
        quality: Number(trackingStatus?.quality) || 0,
        trackingRunning,
      }),
    [
      deviceDriveArmed,
      cameraRunning,
      trackingRunning,
      serialConnected,
      busSerialConnected,
      transportFamily,
      outputMode,
      profilesReady,
      trackingStatus,
      trackingRunning,
    ]
  )

  const pushToDeviceRef = useRef(
    /** @type {null | (() => Promise<void>)} */ (null)
  )

  const commitDeviceEnvelope = useCallback((envelope) => {
    if (!envelope) {
      return
    }
    lastDeviceEnvelopeRef.current = envelope
    const seq = envelope.frameSeq
    if (seq != null) {
      envelopeBySeqRef.current.set(seq, envelope)
      pruneSeqMap(envelopeBySeqRef.current, MAX_DEVICE_ENVELOPES)
    }
    const now = Date.now()
    if (shouldBuildUiDebug(now, lastEnvelopeUiAtRef.current, UI_DIAGNOSTICS_MS)) {
      setLastDeviceEnvelope(envelope)
      lastEnvelopeUiAtRef.current = now
    }
  }, [])

  const pushToDevice = useCallback(async () => {
    if (stopInProgressRef.current) {
      return
    }
    const tokenAtStart = stopTokenRef.current
    const finish = () => {
      serialBusyRef.current = false
      serialWriteDebugRef.current.writeInFlight = false
      if (!latestPendingSendRef.current) {
        return
      }
      latestPendingSendRef.current = false
      serialWriteDebugRef.current.queueDepth = 0
      queueMicrotask(() => {
        void pushToDeviceRef.current?.()
      })
    }

    if (armWarmupInProgressRef.current) {
      setLastSkipReason("arm-warmup")
      finish()
      return
    }

    if (driveModeRef.current !== DRIVE_MODES.DEVICE_DRIVE) {
      deviceDriveLoopDebugRef.current.notArmedCount += 1
      return
    }
    if (driveModeRef.current === DRIVE_MODES.DEVICE_DRIVE && !deviceDriveArmedRef.current) {
      deviceDriveLoopDebugRef.current.notArmedCount += 1
      return
    }

    deviceDriveLoopDebugRef.current.pushAttemptCount += 1

    const pumpNow = Date.now()
    if (lastPumpTickAtRef.current > 0) {
      recordPumpTick(sendPumpTimingRef.current, pumpNow - lastPumpTickAtRef.current)
    }
    lastPumpTickAtRef.current = pumpNow

    const portsConnected = isActiveFamilyPortConnected(transportFamilyRef.current)
    const gate = evaluateDeviceDriveGates({
      armed: deviceDriveArmedRef.current,
      cameraRunning: cameraRunningRef.current,
      serialConnected: portsConnected,
      busSerialConnected: portsConnected,
      busFamilyLabel: getActiveBusTransportLabel(transportFamilyRef.current),
      outputMode: OUTPUT_MODES.BUS_SERVO,
      profilesReady: actuatorProfilesRef.current.length > 0,
      faceDetected: Boolean(trackingStatusRef.current?.faceDetected),
      quality: Number(trackingStatusRef.current?.quality) || 0,
      trackingRunning: Boolean(trackingRunningRef.current),
      videoPaused: Boolean(trackingStatusRef.current?.videoPaused),
    })

    if (!gate.canSend) {
      if (!portsConnected) {
        deviceDriveLoopDebugRef.current.notConnectedCount += 1
      }
      setLastSkipReason(gate.note)
      return
    }

    if (serialBusyRef.current) {
      latestPendingSendRef.current = true
      serialWriteDebugRef.current.droppedStalePendingFrames += 1
      deviceDriveLoopDebugRef.current.droppedStalePendingFrames += 1
      serialWriteDebugRef.current.latestPendingFrameSeq =
        frameSnapshotRef.current?.frameSeq ?? null
      serialWriteDebugRef.current.queueDepth = 1
      return
    }

    serialBusyRef.current = true
    serialWriteDebugRef.current.writeInFlight = true
    deviceDriveLoopDebugRef.current.writeInFlightCount += 1
    setLastSkipReason("")

    try {
      const snap = frameSnapshotRef.current
      const rig = snap?.rig
      const frameSeq = snap?.frameSeq ?? null
      const frameTimestampMs = snap?.updatedAt ?? rigUpdatedAtRef.current ?? null
      const eyeDbg = eyeReleaseDebugRef.current
      const eyeReleasing = Boolean(eyeDbg?.leftReleasing || eyeDbg?.rightReleasing)

      if (!rig || typeof rig !== "object") {
        setLastSkipReason("无预览 Rig")
        finish()
        return
      }

      const now = Date.now()
      const sourceTimestampMs = snap?.timestampMs ?? frameTimestampMs ?? now
      const enqueueAtMs = now
      const defs = DEVICE_DRIVE_DEFAULTS
      const minIntervalMs = Math.max(10, Math.round(1000 / Math.max(1, Number(defs.maxSendFps) || 25)))
      const decision = resolveLatestFrameSendDecision({
        frameSeq,
        lastSentFrameSeq: lastSentFrameSeqRef.current,
        minResendIntervalMs: minIntervalMs,
        lastSentAtMs: lastSentAtRef.current,
        nowMs: now,
      })
      const deviceDriveTiming = {
        frameSeq,
        maxSendFps: defs.maxSendFps,
        minIntervalMs,
        lastSendAtMs: lastSentAtRef.current,
        nowMs: now,
        shouldSend: decision.shouldSend,
        reason: decision.reason,
        lastSentFrameSeq: lastSentFrameSeqRef.current,
        hasJaw: null,
        hasLip: null,
        cooldownDisabled: true,
        jawMaxSendFpsDisabled: true,
        lipMaxSendFpsDisabled: true,
        frameOrderDebug: {
          sourceSeq: frameSeq,
          lastSentFrameSeq: lastSentFrameSeqRef.current,
          lastAcceptedSourceSeq: lastAcceptedSourceSeqRef.current,
          frameIndex: frameSeq,
          accepted: decision.shouldSend,
          droppedReason: decision.shouldSend ? "" : decision.reason,
        },
      }

      if (!decision.shouldSend) {
        if (decision.reason === "no-new-frame") {
          deviceDriveLoopDebugRef.current.skippedNoNewFrame += 1
        } else if (decision.reason === "seq-regression") {
          deviceDriveLoopDebugRef.current.skippedSeqRegression += 1
        }
        setLastSkipReason(decision.reason)
        finish()
        return
      }

      if (decision.reason === "same-seq-resend") {
        deviceDriveLoopDebugRef.current.sameSeqResendCount += 1
      }

      const deadbandRigResult = applyLipRigDeadbandToRig(rig, defs)
      const buildOutStart = Date.now()
      const finalOutputsBuilt = buildFinalServoOutputsFromBindings({
        profile: profileRef.current,
        rig: deadbandRigResult.rig,
        configs: configsRef.current,
        sourceType: "tracking",
        mapFaceRigToPoseOptions: mapOptsRef.current,
        sourceFrameIndex: frameSeq,
        sourceTimestampMs: frameTimestampMs,
      })
      recordPhaseMs(sendPumpTimingRef.current, "buildOutputs", Date.now() - buildOutStart)

      let finalOutputsRaw = finalOutputsBuilt

      if (!finalOutputsRaw.length) {
        setLastSkipReason("无可下发 actuator（绑定输出为空）")
        if (
          shouldBuildUiDebug(now, lastBusDebugUiAtRef.current, UI_DIAGNOSTICS_MS) &&
          diagnosticModeRef.current !== DIAGNOSTIC_MODES.OFF
        ) {
          const busOutputDebug = buildBusOutputDebug({ commands: [], skipped: [], summary: {} }, [], {
            droppedByFpsLimit: droppedByFpsLimitRef.current,
            portConnected: isActiveFamilyPortConnected(transportFamilyRef.current),
            txMode: busServoTxModeRef.current,
          })
          busOutputDebugRef.current = busOutputDebug
          setBusOutputDebug(busOutputDebug)
          lastBusDebugUiAtRef.current = now
        }
        finish()
        return
      }

      deviceDriveLoopDebugRef.current.sendAttemptCount += 1

      const finalOutputs = applyPwmDeadbandToFinalOutputs(
        finalOutputsRaw,
        lastSentPwmRef.current,
        profileRef.current,
        defs
      )

      if (!busPipelineStateRef.current) {
        busPipelineStateRef.current = resetDeviceBusPipelineState()
      }
      let pipeline = busPipelineStateRef.current
      if (!pipeline?.realSafetyState || !pipeline?.twitchGuardState) {
        pipeline = resetDeviceBusPipelineState()
        busPipelineStateRef.current = pipeline
      }

        const cmdStart = Date.now()
        const elapsedSinceLastSend =
          lastSuccessfulSendAtRef.current > 0 ? now - lastSuccessfulSendAtRef.current : null
        const frameBudgetMs = Math.max(
          15,
          Math.round(1000 / Math.max(1, Number(DEVICE_DRIVE_DEFAULTS.maxSendFps) || 25))
        )
        actuatorProfilesRef.current = loadActuatorProfiles().actuatorProfiles
        const built = buildBusCommandsFromFinalOutputs(
          finalOutputs,
          actuatorProfilesRef.current,
          {
            safetyState: pipeline.realSafetyState,
            actuatorSafety: DEFAULT_TRACKING_ACTUATOR_SAFETY,
            eyeReleasing,
            frameSeq,
            elapsedMsSinceLastSend: elapsedSinceLastSend,
            frameBudgetMs,
          }
        )
        recordPhaseMs(sendPumpTimingRef.current, "buildCommands", Date.now() - cmdStart)

        if (!built.commands.length) {
          setLastSkipReason(built.skipped.length ? "profile 跳过全部 actuator" : "无可下发总线命令")
          if (
            shouldBuildUiDebug(now, lastBusDebugUiAtRef.current, UI_DIAGNOSTICS_MS) &&
            diagnosticModeRef.current !== DIAGNOSTIC_MODES.OFF
          ) {
            const busOutputDebug = buildBusOutputDebug(built, finalOutputs)
            busOutputDebugRef.current = busOutputDebug
            setBusOutputDebug(busOutputDebug)
            lastBusDebugUiAtRef.current = now
          }
          finish()
          return
        }

        const commandKey = buildBusCommandSendKey(built.commands)
        const command = formatBusCommandsPreview(built.commands)
        // 角色仅用于 deviceDriveTiming 诊断；不再做 cooldown / 分频
        const roles = new Set(
          built.commands.map((c) => bindingRoleForServo(c.legacyServoIndex, profileRef.current))
        )
        deviceDriveTiming.hasJaw = roles.has("jaw")
        deviceDriveTiming.hasLip = roles.has("lip")

        if (!isActiveFamilyPortConnected(transportFamilyRef.current)) {
          setLastSkipReason(
            `${getActiveBusTransportLabel(transportFamilyRef.current)} 串口未连接`
          )
          finish()
          return
        }

        if (tokenAtStart !== stopTokenRef.current || stopInProgressRef.current) {
          return
        }

        const twitchStart = Date.now()
        const twitch = applyUpperFaceTwitchGuardToCommands(
          built.commands,
          pipeline.twitchGuardState,
          DEFAULT_TRACKING_UPPER_FACE_TWITCH_GUARD
        )
        recordPhaseMs(sendPumpTimingRef.current, "twitch", Date.now() - twitchStart)
        const commandsToSend = twitch.commands
        const txMode = busServoTxModeRef.current

        const writeStart = Date.now()
        const writeResult = await sendBusServoCommands(commandsToSend, {
          transport: resolveBusTransportByFamily(transportFamilyRef.current),
          txMode,
          syncMode: DEVICE_DRIVE_DEFAULTS.scsclSyncMode,
          scSyncMode: DEVICE_DRIVE_DEFAULTS.scsclSyncMode,
          scsclBroadcastId: DEVICE_DRIVE_DEFAULTS.scsclBroadcastId,
        })
        const writeDurationMs = Date.now() - writeStart
        recordPhaseMs(sendPumpTimingRef.current, "serial", writeDurationMs)
        serialWriteDebugRef.current.writeDurationMs = writeDurationMs
        serialWriteDebugRef.current.maxWriteDurationMs = Math.max(
          serialWriteDebugRef.current.maxWriteDurationMs,
          writeDurationMs
        )

        const loopDbg = deviceDriveLoopDebugRef.current
        loopDbg.writeDurationMsMax = Math.max(loopDbg.writeDurationMsMax || 0, writeDurationMs)
        writeDurationSamplesRef.current.push(writeDurationMs)
        if (writeDurationSamplesRef.current.length > 120) {
          writeDurationSamplesRef.current.shift()
        }
        const prevSendAt = lastSuccessfulSendAtRef.current
        if (prevSendAt > 0) {
          const intervalMs = now - prevSendAt
          sendIntervalSamplesRef.current.push(intervalMs)
          if (sendIntervalSamplesRef.current.length > 120) {
            sendIntervalSamplesRef.current.shift()
          }
          if (intervalMs > SEND_INTERVAL_SLOW_MS) {
            loopDbg.sendIntervalOver80msCount += 1
          }
        }

        if (!writeResult.ok) {
          setLastSkipReason(writeResult.error || "总线写入失败")
          if (
            shouldBuildUiDebug(now, lastBusDebugUiAtRef.current, UI_DIAGNOSTICS_MS) &&
            diagnosticModeRef.current !== DIAGNOSTIC_MODES.OFF
          ) {
            const busOutputDebug = buildBusOutputDebug(built, finalOutputs, {
              ...writeResult,
              droppedByFpsLimit: droppedByFpsLimitRef.current,
              txMode,
            })
            busOutputDebugRef.current = busOutputDebug
            setBusOutputDebug(busOutputDebug)
            lastBusDebugUiAtRef.current = now
          }
          finish()
          return
        }

        commitActuatorSafetyStates(pipeline.realSafetyState, commandsToSend, now, {
          sourceSeq: frameSeq,
        })
        commitUpperFaceTwitchGuardState(pipeline.twitchGuardState, commandsToSend, frameSeq)

        lastCommandRef.current = commandKey
        lastSentAtRef.current = now
        lastRealSendAtRef.current = now
        lastSuccessfulSendAtRef.current = now
        if (frameSeq != null) {
          lastAcceptedSourceSeqRef.current = frameSeq
          lastSentFrameSeqRef.current = frameSeq
          realSendUniqueSeqRef.current.add(frameSeq)
          sentFrameSeqListRef.current.push(frameSeq)
          if (sentFrameSeqListRef.current.length > 300) {
            sentFrameSeqListRef.current.shift()
          }
        }
        if (frameTimestampMs) {
          lastFrameTimestampRef.current = frameTimestampMs
        }
        for (const out of finalOutputs) {
          if (out.pwmValue != null && Number.isFinite(out.legacyServoIndex)) {
            lastSentPwmRef.current.set(out.legacyServoIndex, out.pwmValue)
          }
        }
        for (const c of commandsToSend) {
          if (Number.isFinite(c.busServoId) && Number.isFinite(c.targetPosition)) {
            lastSentBusPosRef.current.set(c.busServoId, c.targetPosition)
          }
        }
        sendCountRef.current += 1
        realSendCountRef.current += 1
        const safetyLimited = commandsToSend.some((c) => Boolean(c.safety?.limited))
        if (safetyLimited) {
          window.setTimeout(() => {
            void pushToDeviceRef.current?.()
          }, minIntervalMs)
        }
        const packetCount = Number(writeResult.packetCountTotal ?? writeResult.packetCount) || 0
        const commandCount =
          Number(writeResult.commandCountTotal ?? writeResult.commandCount) || commandsToSend.length
        loopDbg.sendPacketCount += packetCount
        loopDbg.sendCommandCount += commandCount
        loopDbg.realBusPacketCount += packetCount

        const diagMode = diagnosticModeRef.current
        const shouldUiDebug = shouldBuildUiDebug(now, lastBusDebugUiAtRef.current, UI_DIAGNOSTICS_MS)
        const includeFullDebug = diagMode === DIAGNOSTIC_MODES.FULL

        if (writeResult.packetHex || writeResult.lastTxPacketHex) {
          packetHexRingRef.current.push(writeResult.packetHex ?? writeResult.lastTxPacketHex)
        }
        for (const g of writeResult.groups ?? []) {
          if (g.packetHex) packetHexRingRef.current.push(g.packetHex)
        }

        let sentCommands = []
        if (shouldUiDebug && diagMode !== DIAGNOSTIC_MODES.OFF) {
          const debugStart = Date.now()
          sentCommands = enrichSentBusCommands(commandsToSend, writeResult)
          const sentBuilt = { ...built, commands: sentCommands }
          const busOutputDebug = buildBusOutputDebug(sentBuilt, finalOutputs, {
            realTxFps: realSendCountRef.current,
            droppedByFpsLimit: droppedByFpsLimitRef.current,
            ...writeResult,
            portConnected: writeResult.portConnected,
            txMode,
            lastPacketHexList: packetHexRingRef.current.toArray(),
          })
          recordPhaseMs(sendPumpTimingRef.current, "debugBuild", Date.now() - debugStart)
          busOutputDebugRef.current = busOutputDebug
          setBusOutputDebug(busOutputDebug)
          lastBusDebugUiAtRef.current = now
        }

        if (frameSeq != null) {
          const sentAtMs = now
          const writeEndMs = sentAtMs
          const writeStartMs = writeEndMs - writeDurationMs
          const buildEndMs = writeStartMs
          const buildStartMs = buildOutStart
          const sendTiming = {
            sourceTimestampMs,
            enqueueAtMs,
            buildStartMs,
            buildEndMs,
            writeStartMs,
            writeEndMs,
            sentAtMs,
            queueDelayMs: Math.max(0, buildStartMs - sourceTimestampMs),
            buildDurationMs: Math.max(0, buildEndMs - buildStartMs),
            writeDurationMs,
            totalLatencyMs: Math.max(0, sentAtMs - sourceTimestampMs),
            sourceSeqMinusSentSeqLag: 0,
          }
          const safetyStats = summarizeSafetyFromCommands(commandsToSend)
          const twitchStats = summarizeTwitchFromDebug(twitch.twitchDebug, twitch.frameSpikeDebug)
          const snap = buildMinimalRealSendSnapshot({
            frameSeq,
            txMode,
            writeResult,
            writeDurationMs,
            sentAtMs,
            sourceTimestampMs,
            timing: sendTiming,
            safetyStats,
            twitchStats,
            includeBusCommands: includeFullDebug,
            commands: includeFullDebug ? sentCommands : [],
          })
          if (includeFullDebug) {
            snap.packetHex = writeResult.packetHex ?? writeResult.lastTxPacketHex ?? ""
            snap.skippedServoIds = writeResult.skippedServoIds ?? []
          }
          realSendSnapshotBySeqRef.current.set(frameSeq, snap)
          pruneSeqMap(realSendSnapshotBySeqRef.current, MAX_REAL_SEND_SNAPSHOTS)
        }

        const minimalReal = realSendSnapshotBySeqRef.current.get(frameSeq) ?? {
          sent: true,
          frameSeq,
          txMode,
          packetCount,
          commandCount,
          writeDurationMs,
        }

        if (diagMode !== DIAGNOSTIC_MODES.OFF) {
          commitDeviceEnvelope(
            createTrackingFrameEnvelope({
              frameSeq,
              timestampMs: frameTimestampMs,
              faceRig: includeFullDebug ? { frameSeq, rig: deadbandRigResult.rig } : null,
              binding: includeFullDebug ? { frameSeq, finalServoOutputs: finalOutputs } : null,
              safety: includeFullDebug
                ? { frameSeq, commands: commandsToSend.map((c) => c.safety) }
                : null,
              device: {
                frameSeq,
                deviceDriveTiming,
                commandPreview: command,
                sent: true,
                txMode,
                packetCount,
                commandCount,
                writeDurationMs,
                sendPumpTiming: exportSendPumpTiming(sendPumpTimingRef.current),
                real: minimalReal,
                ...(includeFullDebug
                  ? {
                      busOutputDebug: busOutputDebugRef.current,
                      sentServoIds: writeResult.sentServoIds ?? [],
                      skippedServoIds: writeResult.skippedServoIds ?? [],
                      packetHex: writeResult.packetHex ?? writeResult.lastTxPacketHex ?? "",
                      upperFaceTwitchGuard: twitch.twitchDebug,
                      frameSpikeDebug: twitch.frameSpikeDebug,
                      serialWriteDebug: { ...serialWriteDebugRef.current },
                    }
                  : {}),
              },
              pipelineStateDebug: includeFullDebug
                ? {
                    ownerId: pipeline.realSafetyState?.ownerId ?? pipeline.ownerId,
                    consumerType: "real-device-send",
                    frameSeq,
                    stateCommitCount: pipeline.realSafetyState?.stateCommitCount ?? 0,
                  }
                : null,
            })
          )
        }
        deviceDriveLoopDebugRef.current.sendSuccessCount += 1
        deviceDriveLoopDebugRef.current.sendFrameCount += 1
        onCommandSentRef.current?.(command)
        finish()
        return
    } catch (e) {
      const msg = e?.message || String(e)
      setLastSkipReason(msg)
      onSerialErrorRef.current?.(msg)
    } finally {
      finish()
    }
  }, [commitDeviceEnvelope])

  pushToDeviceRef.current = pushToDevice

  useEffect(() => {
    if (!deviceDriveArmed) {
      armWarmupTokenRef.current += 1
      armWarmupInProgressRef.current = false
      setArmWarmupInProgress(false)
      prevDeviceDriveArmedRef.current = false
      return
    }

    const rising = !prevDeviceDriveArmedRef.current
    prevDeviceDriveArmedRef.current = true
    if (!rising || !deviceDriveMode || !TRACKING_DEVICE_DRIVE_ARM_DEFAULTS.armWarmupEnabled) {
      return
    }

    const token = armWarmupTokenRef.current + 1
    armWarmupTokenRef.current = token
    const armCfg = TRACKING_DEVICE_DRIVE_ARM_DEFAULTS

    ;(async () => {
      armWarmupInProgressRef.current = true
      setArmWarmupInProgress(true)
      setLastSkipReason("arm-warmup")

      try {
        const snap = frameSnapshotRef.current
        const rig = snap?.rig ?? previewRigRef.current
        if (!rig || typeof rig !== "object") {
          return
        }

        const deadbandRig = applyLipRigDeadbandToRig(rig, DEVICE_DRIVE_DEFAULTS).rig
        const targetOutputs = buildFinalServoOutputsFromBindings({
          profile: profileRef.current,
          rig: deadbandRig,
          configs: configsRef.current,
          sourceType: "tracking",
          mapFaceRigToPoseOptions: mapOptsRef.current,
          sourceFrameIndex: snap?.frameSeq ?? null,
          sourceTimestampMs: snap?.updatedAt ?? null,
        })

        if (!targetOutputs.length) {
          return
        }

        const result = await sendTrackingPreviewArmWarmup({
          targetFinalOutputs: targetOutputs,
          configs: configsRef.current,
          outputMode: OUTPUT_MODES.BUS_SERVO,
          transportFamily: transportFamilyRef.current,
          baudRate: baudRateRef.current || resolveBusBaudConfig(transportFamilyRef.current).defaultBaud,
          steps: armCfg.armWarmupSteps,
          stepIntervalMs: armCfg.armWarmupStepIntervalMs,
          busMoveTimeMs: armCfg.armWarmupBusMoveTimeMs,
          fromLogical: armCfg.armWarmupFromLogical,
          busTxMode: armCfg.armWarmupBusTxMode,
        })

        if (token !== armWarmupTokenRef.current || !result.ok) {
          return
        }

        const now = Date.now()
        const frameSeq = snap?.frameSeq ?? null

        if (!busPipelineStateRef.current) {
          busPipelineStateRef.current = resetDeviceBusPipelineState()
        }
        const pipeline = busPipelineStateRef.current
        const finalBlended = blendFinalOutputsToward(
          targetOutputs,
          1,
          armCfg.armWarmupFromLogical
        )
        const built = buildBusCommandsFromFinalOutputs(
          finalBlended,
          actuatorProfilesRef.current,
          {
            safetyState: pipeline.realSafetyState,
            actuatorSafety: DEFAULT_TRACKING_ACTUATOR_SAFETY,
            frameSeq,
          }
        )
        const commands = result.lastCommands?.length ? result.lastCommands : built.commands
        commitActuatorSafetyStates(pipeline.realSafetyState, commands, now, {
          sourceSeq: frameSeq,
        })
        commitUpperFaceTwitchGuardState(pipeline.twitchGuardState, commands, frameSeq)
        for (const c of commands) {
          if (Number.isFinite(c.busServoId) && Number.isFinite(c.targetPosition)) {
            lastSentBusPosRef.current.set(c.busServoId, c.targetPosition)
          }
        }
        for (const out of finalBlended) {
          if (out.pwmValue != null && Number.isFinite(out.legacyServoIndex)) {
            lastSentPwmRef.current.set(out.legacyServoIndex, out.pwmValue)
          }
        }

        if (frameSeq != null) {
          lastSentFrameSeqRef.current = frameSeq
          lastAcceptedSourceSeqRef.current = frameSeq
        }
        lastSuccessfulSendAtRef.current = now
        setLastSkipReason("")
      } catch (e) {
        if (token === armWarmupTokenRef.current) {
          setLastSkipReason(e?.message || String(e))
          onSerialErrorRef.current?.(e?.message || String(e))
        }
      } finally {
        if (token === armWarmupTokenRef.current) {
          armWarmupInProgressRef.current = false
          setArmWarmupInProgress(false)
        }
      }
    })()
  }, [deviceDriveArmed, deviceDriveMode])

  useEffect(() => {
    if (!deviceDriveArmed) {
      stopInProgressRef.current = false
      rightFiveBarRef.current = createRightMouthCornerFivebarState()
      leftFiveBarRef.current = createRightMouthCornerFivebarState()
      lastSentPwmRef.current.clear()
      lastSentBusPosRef.current.clear()
      busPipelineStateRef.current = resetDeviceBusPipelineState()
      lastCommandRef.current = ""
      rigUpdatedAtRef.current = 0
      lastFrameTimestampRef.current = 0
      lastAcceptedSourceSeqRef.current = null
      lastSentFrameSeqRef.current = null
      sentFrameSeqListRef.current = []
      realSendUniqueSeqRef.current = new Set()
      seqLagSamplesRef.current = []
      frameSnapshotRef.current = null
      envelopeBySeqRef.current.clear()
      realSendSnapshotBySeqRef.current.clear()
      busOutputDebugRef.current = null
      lastBusDebugUiAtRef.current = 0
      lastEnvelopeUiAtRef.current = 0
      lastPumpTickAtRef.current = 0
      sendPumpTimingRef.current = createSendPumpTiming()
      packetHexRingRef.current = createRingBuffer()
      setLastDeviceEnvelope(null)
      uiDryRunPipelineRef.current = null
      droppedByFpsLimitRef.current = 0
      realSendCountRef.current = 0
      inputUniqueSeqRef.current = new Set()
      writeDurationSamplesRef.current = []
      sendIntervalSamplesRef.current = []
      lastSuccessfulSendAtRef.current = 0
      deviceDriveLoopDebugRef.current = createDeviceDriveLoopDebug(busServoTxModeRef.current)
      serialWriteDebugRef.current = {
        writeInFlight: false,
        latestPendingFrameSeq: null,
        droppedStalePendingFrames: 0,
        writeDurationMs: 0,
        maxWriteDurationMs: 0,
        queueDepth: 0,
      }
      setBusOutputDebug(null)
    }
  }, [deviceDriveArmed])

  useEffect(() => {
    if (!deviceDriveMode) {
      setSendFps(null)
      setLastSkipReason("")
      return undefined
    }
    if (!deviceDriveArmed) {
      setSendFps(null)
      setLastSkipReason("")
      return undefined
    }

    // 兜底心跳：串口写入进行中时 frame-wake 可能被 serialBusy 丢弃，interval 保证最终补发
    const targetFps = Math.max(1, Number(DEVICE_DRIVE_DEFAULTS.maxSendFps) || 25)
    const intervalMs = Math.max(10, Math.round(1000 / targetFps))
    const timer = window.setInterval(() => {
      void pushToDeviceRef.current?.()
    }, intervalMs)

    return () => window.clearInterval(timer)
  }, [deviceDriveMode, deviceDriveArmed])

  useEffect(() => {
    if (!deviceDriveMode) {
      return undefined
    }
    if (!deviceDriveArmed) {
      return undefined
    }
    const id = window.setInterval(() => {
      const n = sendCountRef.current
      sendCountRef.current = 0
      setSendFps(Math.round((n / FPS_WINDOW_MS) * 1000))

      const rn = realSendCountRef.current
      realSendCountRef.current = 0
      const sendFrameFps = Math.round((rn / FPS_WINDOW_MS) * 1000)
      setRealSendFps(sendFrameFps)

      const uniqueCount = inputUniqueSeqRef.current.size
      inputUniqueSeqRef.current = new Set()
      const inputUniqueFps = Math.round((uniqueCount / FPS_WINDOW_MS) * 1000)

      const wd = writeDurationSamplesRef.current
      const wdMin = wd.length ? Math.min(...wd) : null
      const wdMax = wd.length ? Math.max(...wd) : null
      const wdAvg = wd.length ? Math.round(wd.reduce((a, b) => a + b, 0) / wd.length) : null

      const si = sendIntervalSamplesRef.current
      const siSorted = si.length ? [...si].sort((a, b) => a - b) : []
      const siAvg = siSorted.length ? Math.round(siSorted.reduce((a, b) => a + b, 0) / siSorted.length) : null
      const siP90 = siSorted.length
        ? siSorted[Math.min(siSorted.length - 1, Math.ceil(siSorted.length * 0.9) - 1)]
        : null
      const siMax = siSorted.length ? siSorted[siSorted.length - 1] : null

      const uniqueRealCount = realSendUniqueSeqRef.current.size
      realSendUniqueSeqRef.current = new Set()
      const realSendUniqueFps = Math.round((uniqueRealCount / FPS_WINDOW_MS) * 1000)

      const loopDbg = deviceDriveLoopDebugRef.current
      loopDbg.inputUniqueFrameCount += uniqueCount
      loopDbg.inputUniqueFps = inputUniqueFps
      loopDbg.sendFrameFps = sendFrameFps
      loopDbg.realSendUniqueFrameCount += uniqueRealCount
      loopDbg.realSendUniqueFrameFps = realSendUniqueFps
      loopDbg.sentFrameSeqList = sentFrameSeqListRef.current.slice(-20)
      const lagSamples = seqLagSamplesRef.current
      if (lagSamples.length) {
        loopDbg.sourceSeqMinusSentSeqLagAvg = Math.round(
          (lagSamples.reduce((a, b) => a + b, 0) / lagSamples.length) * 100
        ) / 100
        loopDbg.sourceSeqMinusSentSeqLagMax = Math.max(...lagSamples)
      }
      loopDbg.writeDurationMsMin = wdMin
      loopDbg.writeDurationMsAvg = wdAvg
      loopDbg.writeDurationMsMax = wdMax ?? loopDbg.writeDurationMsMax
      loopDbg.sendIntervalMsAvg = siAvg
      loopDbg.sendIntervalMsP90 = siP90
      loopDbg.sendIntervalMsMax = siMax
      loopDbg.droppedStalePendingFrames = serialWriteDebugRef.current.droppedStalePendingFrames
      loopDbg.txMode = busServoTxModeRef.current
      if (busOutputDebugRef.current) {
        setBusOutputDebug(busOutputDebugRef.current)
      }
    }, FPS_WINDOW_MS)
    return () => window.clearInterval(id)
  }, [deviceDriveMode, deviceDriveArmed])

  const bindingDiagnostics = uiDryRunResult?.diagnostics ?? null
  const commandPreview = uiDryRunResult?.commandPreview ?? ""

  const beginStopSequence = useCallback(() => {
    stopInProgressRef.current = true
    stopTokenRef.current += 1
    latestPendingSendRef.current = false
    logicalPoseRef.current = {}
  }, [])

  const endStopSequence = useCallback(() => {
    stopInProgressRef.current = false
  }, [])

  return {
    bindingDiagnostics,
    commandPreview,
    gates,
    sendFps,
    lastSkipReason,
    lipRigDeadbandApplied: lipRigDeadbandAppliedRef.current,
    armed: deviceDriveArmed,
    armWarmupInProgress,
    uiDryRunResult,
    beginStopSequence,
    endStopSequence,
    busProfileSource: actuatorBundle.source,
    busProfileCount: actuatorBundle.actuatorProfiles.length,
    isBusOutput,
    busOutputDebug,
    realSendFps,
    busServoTxMode: busServoTxModeRef.current,
    lastRealSendAt: lastRealSendAtRef.current,
    droppedByFpsLimit: droppedByFpsLimitRef.current,
    lastDeviceEnvelope,
    getRealSendSnapshotForSeq: (seq) => {
      const n = Number(seq)
      if (!Number.isFinite(n)) {
        return null
      }
      const snap = realSendSnapshotBySeqRef.current.get(n)
      if (snap) {
        return snap
      }
      return { sent: false, reason: "not-sent-this-frame", frameSeq: n }
    },
    realSendSnapshots: realSendSnapshotBySeqRef.current,
    getDeviceEnvelopeForSeq: (seq) => {
      const n = Number(seq)
      if (!Number.isFinite(n)) {
        return lastDeviceEnvelope
      }
      return envelopeBySeqRef.current.get(n) ?? lastDeviceEnvelope
    },
    deviceDriveTiming: lastDeviceEnvelope?.device?.deviceDriveTiming ?? null,
    deviceDriveLoopDebug: { ...deviceDriveLoopDebugRef.current },
    serialWriteDebug: { ...serialWriteDebugRef.current },
    diagnosticMode,
    sendPumpTiming: exportSendPumpTiming(sendPumpTimingRef.current),
    lastPacketHexRing: packetHexRingRef.current,
    getSendPumpTiming: () => exportSendPumpTiming(sendPumpTimingRef.current),
  }
}
