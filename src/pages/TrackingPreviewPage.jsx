import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  BUS_TRANSPORT_FAMILY_STORAGE_KEY,
  normalizeBusTransportFamily,
  resolveBusBaudConfig,
  resolveBusTransportByFamily,
} from "../sdk/servoAdapters/busServo/resolveBusTransport.js"
import {
  PHYSICAL_MOTION_OWNERS,
  acquirePhysicalMotionOwner,
  releasePhysicalMotionOwner,
} from "../sdk/expression/physicalMotionOwner.js"
import {
  DRIVE_MODES,
  DEVICE_DRIVE_ARM_CONFIRM_MESSAGE,
  DEVICE_DRIVE_DEFAULTS,
  DIAGNOSTIC_MODES,
  OUTPUT_MODES,
  normalizeTrackingOutputMode,
  TRACKING_BUS_TX_MODE_STORAGE_KEY,
  TRACKING_DEVICE_DRIVE_STOP_DEFAULTS,
  TRACKING_DIAGNOSTIC_MODE_STORAGE_KEY,
  TRACKING_OUTPUT_MODE_STORAGE_KEY,
  TRACKING_PREVIEW_TABS,
  TRACKING_VIDEO_SOURCE_TUNING_STORAGE_KEY,
} from "../sdk/trackingPreview/trackingPreviewConstants.js"
import { resolveDefaultVideoSelectId } from "../sdk/trackingPreview/resolveVideoPlaybackWindow.js"
import { readJsonStorage, writeJsonStorage } from "../utils/storage.js"
import TrackingPreviewHeader from "../sdk/react/trackingPreview/TrackingPreviewHeader.jsx"
import LeftSourceColumn from "../sdk/react/trackingPreview/LeftSourceColumn.jsx"
import CameraPreviewPanel from "../sdk/react/trackingPreview/CameraPreviewPanel.jsx"
import CameraSelectModal from "../sdk/react/trackingPreview/CameraSelectModal.jsx"
import VideoPreviewPanel from "../sdk/react/trackingPreview/VideoPreviewPanel.jsx"
import MotionTrackPanel from "../sdk/react/trackingPreview/MotionTrackPanel.jsx"
import FaceRigPreviewCard from "../sdk/react/trackingPreview/FaceRigPreviewCard.jsx"
import TrackingPreviewDeveloperDebug from "../sdk/react/trackingPreview/TrackingPreviewDeveloperDebug.jsx"
import TrackingDatasetExportPanel from "../sdk/react/trackingPreview/TrackingDatasetExportPanel.jsx"
import UploadedVideoSourcePanel from "../sdk/react/trackingPreview/UploadedVideoSourcePanel.jsx"
import { useTrackingPreviewCamera } from "../sdk/react/trackingPreview/useTrackingPreviewCamera.js"
import { useTrackingSourceManager } from "../sdk/react/trackingPreview/useTrackingSourceManager.js"
import { useBrowserSourceRuntime } from "../sdk/react/trackingPreview/useBrowserSourceRuntime.js"
import {
  resolveEffectiveTrackingSource,
  resolveSourceSegmentAvailability,
} from "../sdk/trackingPreview/resolveEffectiveTrackingSource.js"
import {
  TRACKING_SOURCE_SEGMENT_IDS,
} from "../sdk/trackingPreview/trackingPreviewConstants.js"
import { useTrackingPreviewDeviceDrive } from "../sdk/react/trackingPreview/useTrackingPreviewDeviceDrive.js"
import { useTrackingDiagnosticRecorder } from "../sdk/react/trackingPreview/useTrackingDiagnosticRecorder.js"
import { useTrackingDatasetRecorder } from "../sdk/react/trackingPreview/useTrackingDatasetRecorder.js"
import { getTrackingDiagnosticRecorderStatus } from "../sdk/tracking/diagnostics/trackingDiagnosticRecorder.js"
import { getTrackingDatasetRecorderStatus } from "../sdk/tracking/dataset/trackingDatasetRecorder.js"
import { fetchTrackingSourceState, buildTrackingApiBaseUrl } from "../sdk/trackingPreview/trackingSourceApi.js"
import { sendTrackingPreviewCenterServos } from "../sdk/trackingPreview/sendTrackingPreviewCenterServos.js"
import { buildTrackingDryRunResult } from "../sdk/trackingPreview/buildTrackingDryRunResult.js"
import { EMPTY_DRY_RUN_RESULT } from "../sdk/trackingPreview/trackingPreviewNeutral.js"
import { loadActuatorProfiles } from "../sdk/output/loadActuatorProfiles.js"
import { createTrackingBusPipelineState } from "../sdk/output/trackingBusPipelineState.js"
import { isDeveloperDebugEnabled } from "../utils/developerDebug.js"
import { VIDEO_OVERLAY_MODES } from "../sdk/trackingPreview/videoOverlayConstants.js"
import "../styles/face-rig.css"
import "../styles/tracking-preview.css"

/**
 * Tracking Preview — Camera + Device Drive V1（全通道）。
 */
export default function TrackingPreviewPage({ configs = [] }) {
  const [activeTab, setActiveTab] = useState(
    /** @type {import("../sdk/trackingPreview/trackingPreviewConstants.js").TrackingPreviewTabId} */ (
      TRACKING_PREVIEW_TABS.CAMERA
    )
  )
  const [driveMode, setDriveMode] = useState(
    /** @type {import("../sdk/trackingPreview/trackingPreviewConstants.js").TrackingPreviewDriveMode} */ (
      DRIVE_MODES.PREVIEW_ONLY
    )
  )
  const [outputMode, setOutputMode] = useState(
    /** @type {import("../sdk/trackingPreview/trackingPreviewConstants.js").TrackingPreviewOutputMode} */ (() => {
      const saved = readJsonStorage(TRACKING_OUTPUT_MODE_STORAGE_KEY, null)
      const mode = normalizeTrackingOutputMode(saved)
      writeJsonStorage(TRACKING_OUTPUT_MODE_STORAGE_KEY, mode)
      return mode
    })
  )
  const [busServoTxMode, setBusServoTxMode] = useState(
    /** @type {'single-write' | 'hybrid' | 'sync-write'} */ (() => {
      const saved = readJsonStorage(TRACKING_BUS_TX_MODE_STORAGE_KEY, null)
      if (saved === "sync-write" || saved === "hybrid" || saved === "single-write") {
        return saved
      }
      return DEVICE_DRIVE_DEFAULTS.busServoTxMode
    })
  )
  const [diagnosticMode, setDiagnosticMode] = useState(
    /** @type {import("../sdk/trackingPreview/trackingPreviewConstants.js").DiagnosticMode} */ (() => {
      const saved = readJsonStorage(TRACKING_DIAGNOSTIC_MODE_STORAGE_KEY, null)
      if (
        saved === DIAGNOSTIC_MODES.OFF ||
        saved === DIAGNOSTIC_MODES.COMPACT ||
        saved === DIAGNOSTIC_MODES.FULL
      ) {
        return saved
      }
      return DEVICE_DRIVE_DEFAULTS.diagnosticMode
    })
  )
  const [deviceDriveArmed, setDeviceDriveArmed] = useState(false)
  const [showDeveloperDebug] = useState(() => isDeveloperDebugEnabled())
  const [bypassBrowGate, setBypassBrowGate] = useState(false)
  const [bypassEyeRelease, setBypassEyeRelease] = useState(true)
  const [transportFamily, setTransportFamily] = useState(() =>
    normalizeBusTransportFamily(
      readJsonStorage(BUS_TRANSPORT_FAMILY_STORAGE_KEY, "feetech")
    )
  )
  const baudRate = resolveBusBaudConfig(transportFamily).defaultBaud
  const [lastCommand, setLastCommand] = useState("")

  useEffect(() => {
    const active = deviceDriveArmed && driveMode === DRIVE_MODES.DEVICE_DRIVE
    if (active) {
      acquirePhysicalMotionOwner(PHYSICAL_MOTION_OWNERS.TRACKING_DEVICE_DRIVE)
    } else {
      releasePhysicalMotionOwner(PHYSICAL_MOTION_OWNERS.TRACKING_DEVICE_DRIVE)
    }
    return () => releasePhysicalMotionOwner(PHYSICAL_MOTION_OWNERS.TRACKING_DEVICE_DRIVE)
  }, [deviceDriveArmed, driveMode])
  const [lastSerialError, setLastSerialError] = useState("")
  const [stopBusy, setStopBusy] = useState(false)
  const [videoFrameDebug, setVideoFrameDebug] = useState(null)
  const videoFrameDebugRef = useRef(null)
  const diagnosticStopRef = useRef(() => {})
  const datasetStopRef = useRef(async () => {})
  const switchBackendToIdleRef = useRef(async () => {})
  const handleVideoFrameDebugChange = useCallback((dbg) => {
    videoFrameDebugRef.current = dbg
    setVideoFrameDebug(dbg)
  }, [])

  const [videoSourceTuningEnabled, setVideoSourceTuningEnabled] = useState(() => {
    const saved = readJsonStorage(TRACKING_VIDEO_SOURCE_TUNING_STORAGE_KEY, null)
    return saved !== false
  })
  const [sourceCapabilityMessage, setSourceCapabilityMessage] = useState("")

  const camera = useTrackingPreviewCamera({
    configs,
    activeTab,
    driveMode,
    outputMode,
    bypassBrowGate,
    bypassEyeRelease,
    videoSourceTuningEnabled,
  })

  const browserSource = useBrowserSourceRuntime()
  const isBrowserBackend = Boolean(camera.isBrowserBackend)

  const videoDiagnosticStartMs = camera.videoDiagnostic?.startMs ?? 3000

  const sourceManager = useTrackingSourceManager({
    wsUrl: camera.ctrl.wsUrlDraft,
    enabled: !isBrowserBackend,
    onBeforeSwitch: useCallback(() => {
      diagnosticStopRef.current()
      if (getTrackingDatasetRecorderStatus().recording) {
        datasetStopRef.current?.().catch(() => {})
      }
      if (camera.previewSourceRunning) {
        camera.stopPreviewTracking()
      } else {
        camera.resetPreviewToNeutral()
      }
    }, [camera]),
    onAfterSwitch: useCallback((result) => {
      if (result?.sourceType === TRACKING_PREVIEW_TABS.VIDEO) {
        setActiveTab(TRACKING_PREVIEW_TABS.VIDEO)
      } else if (result?.sourceType === TRACKING_PREVIEW_TABS.CAMERA) {
        setActiveTab(TRACKING_PREVIEW_TABS.CAMERA)
      } else if (result?.sourceType === "uploaded-video") {
        setActiveTab(TRACKING_PREVIEW_TABS.UPLOAD)
      }
    }, []),
  })

  const effectiveSource = useMemo(
    () =>
      resolveEffectiveTrackingSource({
        trackingBackend: camera.trackingBackend,
        browserSource: browserSource.browserSourceState,
        pythonSource: sourceManager.trackingSourceState,
      }),
    [
      camera.trackingBackend,
      browserSource.browserSourceState,
      sourceManager.trackingSourceState,
    ]
  )

  useEffect(() => {
    if (activeTab === TRACKING_PREVIEW_TABS.VIDEO && !isBrowserBackend) {
      void sourceManager.loadDefaultVideos()
    }
  }, [activeTab, isBrowserBackend, sourceManager.loadDefaultVideos])

  const disarmDeviceDrive = useCallback(() => {
    setDeviceDriveArmed(false)
    setDriveMode((m) => (m === DRIVE_MODES.DEVICE_DRIVE ? DRIVE_MODES.PREVIEW_ONLY : m))
  }, [])

  const deviceDrive = useTrackingPreviewDeviceDrive({
    driveMode,
    deviceDriveArmed,
    outputMode,
    busServoTxMode,
    diagnosticMode,
    baudRate,
    transportFamily,
    previewRig: camera.previewRig,
    profile: camera.profile,
    configs,
    trackingStatus: camera.trackingStatus,
    cameraRunning: camera.cameraRunning,
    trackingRunning: camera.previewSourceRunning,
    trackingInputSourceType: camera.inputSourceType || "camera",
    trackingFrameSeq: camera.ctrl.lastFrame?.frameSeq ?? null,
    eyeReleaseDebug: camera.calibratedFrame?.debug?.eyeTrack?.eyeReleaseDebug ?? null,
    onCommandSent: setLastCommand,
    onSerialError: setLastSerialError,
  })

  const centerHardwareToNeutral = useCallback(
    async ({ waitAfterLastMs = 0 } = {}) => {
      try {
        const stop = TRACKING_DEVICE_DRIVE_STOP_DEFAULTS
        const result = await sendTrackingPreviewCenterServos({
          profile: camera.profile,
          configs,
          baudRate,
          transportFamily,
          outputMode,
          timeMs: stop.stopReturnNeutralTimeMs,
          busMoveTimeMs: stop.stopReturnNeutralBusMoveTimeMs,
          busTxMode: stop.stopReturnNeutralBusTxMode,
          repeatCount: stop.stopReturnNeutralRepeatCount,
          repeatIntervalMs: stop.stopReturnNeutralRepeatIntervalMs,
          waitAfterLastMs,
        })
        if (result.ok) {
          setLastCommand(result.command)
          setLastSerialError("")
        } else if (result.reason === "not-connected") {
          setLastSerialError("串口未连接，舵机未能回中")
        } else if (result.reason === "empty-command") {
          setLastSerialError("无有效回中命令（检查绑定）")
        }
        return result
      } catch (e) {
        setLastSerialError(e?.message || String(e))
        return { ok: false, reason: "error" }
      }
    },
    [camera.profile, configs, baudRate, transportFamily, outputMode]
  )

  const handleStopCameraTracking = useCallback(async () => {
    if (stopBusy) {
      return
    }
    setStopBusy(true)
    const wasDeviceDrive =
      deviceDriveArmed && driveMode === DRIVE_MODES.DEVICE_DRIVE
    deviceDrive.beginStopSequence?.()
    disarmDeviceDrive()
    setLastCommand("Stopping... Returning device to neutral...")
    try {
      if (wasDeviceDrive && TRACKING_DEVICE_DRIVE_STOP_DEFAULTS.stopReturnNeutralEnabled) {
        const mode = TRACKING_DEVICE_DRIVE_STOP_DEFAULTS.stopReturnNeutralMode
        if (mode === "face-neutral" || mode === "both") {
          const stop = TRACKING_DEVICE_DRIVE_STOP_DEFAULTS
          const result = await sendTrackingPreviewCenterServos({
            profile: camera.profile,
            configs,
            baudRate,
            transportFamily,
            outputMode,
            timeMs: stop.stopReturnNeutralTimeMs,
            busMoveTimeMs: stop.stopReturnNeutralBusMoveTimeMs,
            busTxMode: stop.stopReturnNeutralBusTxMode,
            repeatCount: stop.stopReturnNeutralRepeatCount,
            repeatIntervalMs: stop.stopReturnNeutralRepeatIntervalMs,
            waitAfterLastMs: stop.stopNeutralHoldMs,
          })
          if (result.ok) {
            setLastCommand("Camera stopped · Device neutral command sent")
            setLastSerialError("")
          } else if (result.reason === "not-connected") {
            setLastCommand("Camera stopped · Serial offline, neutral skipped")
          } else {
            setLastSerialError(`Neutral command failed: ${result.reason || "unknown"}`)
          }
        }
      }
    } finally {
      diagnosticStopRef.current()
      camera.stopCameraTracking()
      void switchBackendToIdleRef.current()
      deviceDrive.endStopSequence?.()
      setStopBusy(false)
    }
  }, [
    stopBusy,
    deviceDrive,
    deviceDriveArmed,
    driveMode,
    camera,
    disarmDeviceDrive,
    configs,
    baudRate,
    transportFamily,
    outputMode,
  ])

  const handleOutputModeChange = useCallback(
    (nextMode) => {
      const mode = normalizeTrackingOutputMode(nextMode ?? OUTPUT_MODES.BUS_SERVO)
      setOutputMode((prev) => {
        if (prev === mode) {
          return prev
        }
        writeJsonStorage(TRACKING_OUTPUT_MODE_STORAGE_KEY, mode)
        return mode
      })
      // 输出模式未真正变化时不得 disarm（串口胶囊曾用 unstable 回调误触发本函数）
    },
    []
  )

  const handleDriveModeChange = useCallback((mode) => {
    if (mode === DRIVE_MODES.DEVICE_DRIVE) {
      if (driveMode === DRIVE_MODES.DEVICE_DRIVE && deviceDriveArmed) {
        return
      }
      const ok = window.confirm(DEVICE_DRIVE_ARM_CONFIRM_MESSAGE)
      if (!ok) {
        return
      }
      setDriveMode(DRIVE_MODES.DEVICE_DRIVE)
      setDeviceDriveArmed(true)
      return
    }
    setDeviceDriveArmed(false)
    setDriveMode(mode)
  }, [driveMode, deviceDriveArmed])

  const handleStopAllServo = useCallback(async () => {
    deviceDrive.beginStopSequence?.()
    disarmDeviceDrive()
    camera.stopCameraTracking()
    void switchBackendToIdleRef.current()
    try {
      await centerHardwareToNeutral()
      setLastCommand("Bus neutral sent")
      setLastSerialError("")
    } catch (e) {
      setLastSerialError(e?.message || String(e))
    } finally {
      deviceDrive.endStopSequence?.()
    }
  }, [camera, disarmDeviceDrive, centerHardwareToNeutral, deviceDrive])

  useEffect(() => {
    const transport = resolveBusTransportByFamily(transportFamily)
    let wasConnected = Boolean(transport.getStatus()?.connected)
    const busTick = window.setInterval(() => {
      const connected = Boolean(transport.getStatus()?.connected)
      // 仅在「曾经连上又掉线」时 Disarm；未开串口就 Arm 时保持 Device Drive，由门控阻止下发
      if (deviceDriveArmed && wasConnected && !connected) {
        disarmDeviceDrive()
        setLastSerialError("总线串口已断开，已退出 Device Drive")
      }
      wasConnected = connected
    }, 500)
    return () => {
      window.clearInterval(busTick)
    }
  }, [deviceDriveArmed, disarmDeviceDrive, transportFamily])

  const deviceDriveNote = useMemo(() => {
    if (driveMode !== DRIVE_MODES.DEVICE_DRIVE) {
      return ""
    }
    const parts = []
    parts.push(`Bus Servo · ${busServoTxMode} · profiles=${deviceDrive.busProfileCount} (${deviceDrive.busProfileSource})`)
    if (deviceDriveArmed) {
      parts.push("ARMED")
    }
    if (deviceDrive.realSendFps != null) {
      parts.push(`sendFrame ${deviceDrive.realSendFps} fps`)
    }
    const loopDbg = deviceDrive.deviceDriveLoopDebug
    if (loopDbg?.inputUniqueFps != null) {
      parts.push(`input ${loopDbg.inputUniqueFps} fps`)
    }
    const packetCount = deviceDrive.busOutputDebug?.tx?.packetCount
    if (packetCount != null) {
      parts.push(`pkt ${packetCount}`)
    }
    if (deviceDrive.sendFps != null) {
      parts.push(`loop ${deviceDrive.sendFps} fps`)
    }
    const busCmdCount = deviceDrive.busOutputDebug?.busBuild?.commandCount
    if (busCmdCount != null) {
      parts.push(`cmd ${busCmdCount}`)
    }
    if (!deviceDrive.gates.canSend && deviceDrive.gates.note) {
      parts.push(deviceDrive.gates.note)
    } else if (deviceDrive.lastSkipReason) {
      parts.push(deviceDrive.lastSkipReason)
    }
    const sourceSeq = camera.ctrl.lastFrame?.frameSeq ?? null
    const env = deviceDrive.getDeviceEnvelopeForSeq?.(sourceSeq)
    if (
      sourceSeq != null &&
      env?.frameSeq != null &&
      env.frameSeq !== sourceSeq
    ) {
      parts.push("⚠ Tracking frame mismatch: device timing does not match source frame")
    }
    return parts.join(" · ")
  }, [driveMode, deviceDriveArmed, deviceDrive, outputMode, busServoTxMode, camera.ctrl.lastFrame])

  // bindingDryRun 专用 pipeline 状态：不与诊断单例 / device state 共享，
  // 避免多个 dry-run 消费方交叉 commit 污染 previousSafeTarget（导致大跳显示 pass）
  const bindingDryRunPipelineRef = useRef(/** @type {{ safetyState: object } | null} */ (null))

  const [actuatorProfileEpoch, setActuatorProfileEpoch] = useState(0)
  useEffect(() => {
    const onChanged = () => setActuatorProfileEpoch((n) => n + 1)
    window.addEventListener("facedev:busServoProfilesChanged", onChanged)
    return () => window.removeEventListener("facedev:busServoProfilesChanged", onChanged)
  }, [])

  const actuatorProfilesForDiag = useMemo(
    () => loadActuatorProfiles().actuatorProfiles,
    [outputMode, deviceDrive.busProfileCount, actuatorProfileEpoch]
  )

  const bindingDryRunEligible =
    camera.cameraRunning || camera.previewSourceRunning

  const bindingDryRunResult = useMemo(() => {
    if (!bindingDryRunEligible) {
      bindingDryRunPipelineRef.current = null
      return { ...EMPTY_DRY_RUN_RESULT, finalServoOutputs: [] }
    }
    if (!bindingDryRunPipelineRef.current) {
      bindingDryRunPipelineRef.current = createTrackingBusPipelineState({
        ownerId: "binding-dry-run",
        consumerType: "preview-page",
      })
    }
    const lf = camera.ctrl.lastFrame
    const eyeDbg = camera.calibratedFrame?.debug?.eyeTrack?.eyeReleaseDebug
    return buildTrackingDryRunResult({
      profile: camera.profile,
      rig: camera.previewRig,
      configs,
      outputMode,
      sourceFrameIndex: lf?.frameSeq ?? null,
      sourceTimestampMs: lf?.timestampMs ?? null,
      busPipelineState: bindingDryRunPipelineRef.current,
      eyeReleasing: Boolean(eyeDbg?.leftReleasing || eyeDbg?.rightReleasing),
    })
  }, [
    bindingDryRunEligible,
    camera.cameraRunning,
    camera.previewSourceRunning,
    camera.profile,
    camera.previewRig,
    camera.ctrl.lastFrame,
    camera.calibratedFrame,
    configs,
    outputMode,
  ])

  const mappingDryRunResult = useMemo(() => {
    if (driveMode === DRIVE_MODES.DRY_RUN && camera.dryRunResult?.finalServoOutputs?.length) {
      return camera.dryRunResult
    }
    if (driveMode === DRIVE_MODES.DEVICE_DRIVE && deviceDrive.uiDryRunResult?.finalServoOutputs?.length) {
      return deviceDrive.uiDryRunResult
    }
    return bindingDryRunResult
  }, [driveMode, camera.dryRunResult, deviceDrive.uiDryRunResult, bindingDryRunResult])

  const deviceDriveDebugSnapshot = useMemo(() => {
    const sourceSeq = camera.ctrl.lastFrame?.frameSeq ?? null
    const realSendSnapshot = deviceDrive.getRealSendSnapshotForSeq?.(sourceSeq) ?? null
    const envelope =
      deviceDrive.getDeviceEnvelopeForSeq?.(sourceSeq) ?? deviceDrive.lastDeviceEnvelope
    const dev = envelope?.device || {}
    const lastSentEnv = deviceDrive.lastDeviceEnvelope
    return {
      frameSeq: sourceSeq,
      realSendSnapshots: deviceDrive.realSendSnapshots,
      envelopeSent: Boolean(dev.sent || realSendSnapshot?.sent),
      lastRealSentFrameSeq: realSendSnapshot?.frameSeq ?? (lastSentEnv?.device?.sent ? lastSentEnv.frameSeq : null),
      armed: deviceDrive.armed,
      canSend: deviceDrive.gates?.canSend ?? false,
      note: deviceDrive.gates?.note || "",
      sendFps: deviceDrive.sendFps,
      realSendFps: deviceDrive.realSendFps,
      lastSkipReason: deviceDrive.lastSkipReason || "",
      commandPreview: dev.commandPreview || deviceDrive.commandPreview || "",
      lipRigDeadbandApplied: Boolean(deviceDrive.lipRigDeadbandApplied),
      busOutputDebug: dev.busOutputDebug ?? deviceDrive.busOutputDebug,
      busProfileCount: deviceDrive.busProfileCount,
      busProfileSource: deviceDrive.busProfileSource,
      droppedByFpsLimit: deviceDrive.droppedByFpsLimit,
      deviceDriveTiming: dev.deviceDriveTiming ?? deviceDrive.deviceDriveTiming,
      pipelineStateDebug: envelope?.pipelineStateDebug ?? null,
      deviceDriveLoopDebug: deviceDrive.deviceDriveLoopDebug ?? null,
      serialWriteDebug: deviceDrive.serialWriteDebug ?? null,
      busServoTxMode: deviceDrive.busServoTxMode ?? busServoTxMode,
      diagnosticMode: deviceDrive.diagnosticMode ?? diagnosticMode,
      sendPumpTiming: deviceDrive.sendPumpTiming ?? null,
      lastPacketHexRing: deviceDrive.lastPacketHexRing ?? null,
      getRealSendSnapshotForSeq: deviceDrive.getRealSendSnapshotForSeq,
      getSendPumpTiming: deviceDrive.getSendPumpTiming,
      frameEnvelope: envelope,
      outputMode,
      lastTxOk: Boolean(lastCommand && !lastSerialError),
    }
  }, [
    deviceDrive,
    deviceDrive.lastDeviceEnvelope,
    camera.ctrl.lastFrame,
    outputMode,
    busServoTxMode,
    diagnosticMode,
    driveMode,
    lastCommand,
    lastSerialError,
  ])

  const diagnosticRecorder = useTrackingDiagnosticRecorder({
    enabled: camera.previewSourceRunning,
    diagnosticMode,
    lastFrame: camera.ctrl.lastFrame,
    calibratedFrame: camera.calibratedFrame,
    previewRig: camera.previewRig,
    dryRunResult: mappingDryRunResult,
    trackingStatus: camera.trackingStatus,
    driveMode,
    outputMode,
    deviceDriveDebug: deviceDriveDebugSnapshot,
    browDebug: camera.browDebug,
    profile: camera.profile,
    actuatorProfiles: actuatorProfilesForDiag,
    configs,
    videoFrameDebug,
    getVideoFrameDebug: () => videoFrameDebugRef.current,
    videoInputActive:
      activeTab === TRACKING_PREVIEW_TABS.VIDEO || activeTab === TRACKING_PREVIEW_TABS.UPLOAD,
    frontendOverlayMode: VIDEO_OVERLAY_MODES.OFF,
    videoNeutralSnapshot: camera.videoNeutral?.snapshot ?? null,
    videoNeutralEnabled: camera.videoNeutral?.enabled !== false,
    videoNeutralApplyResult: camera.videoNeutral?.neutralApplyResult ?? null,
    videoNeutralDiagnostic: camera.videoNeutral?.frameDiagnostic ?? null,
    getRawTrackingSignals: camera.videoNeutral?.getRawTrackingSignals ?? null,
    getVideoNeutralEvents: camera.videoNeutral?.drainEvents ?? null,
    prepareVideoDiagnostic: camera.videoDiagnostic?.prepare ?? null,
    videoSourceTuningDiagnostic: camera.videoSourceTuning?.frameDiagnostic ?? null,
    videoSourceTuningJawTrace: camera.videoSourceTuning?.jawTrace ?? null,
    videoSourceTuningShadow: camera.videoSourceTuning?.shadowDiagnostic ?? null,
    videoSourceTuningEnabled,
  })

  const datasetRecorder = useTrackingDatasetRecorder({
    enabled: camera.previewSourceRunning,
    browserLocalMode: isBrowserBackend,
    wsUrl: camera.ctrl.wsUrlDraft,
    lastFrame: camera.ctrl.lastFrame,
    calibratedFrame: camera.calibratedFrame,
    previewRig: camera.previewRig,
    dryRunResult: mappingDryRunResult,
    trackingStatus: camera.trackingStatus,
    driveMode,
    outputMode,
    deviceDriveDebug: deviceDriveDebugSnapshot,
    videoInputActive:
      activeTab === TRACKING_PREVIEW_TABS.VIDEO || activeTab === TRACKING_PREVIEW_TABS.UPLOAD,
    videoNeutralSnapshot: camera.videoNeutral?.snapshot ?? null,
    videoNeutralEnabled: camera.videoNeutral?.enabled !== false,
    videoNeutralApplyResult: camera.videoNeutral?.neutralApplyResult ?? null,
    videoNeutralDiagnostic: camera.videoNeutral?.frameDiagnostic ?? null,
    getRawTrackingSignals: camera.videoNeutral?.getRawTrackingSignals ?? null,
    videoSourceTuningDiagnostic: camera.videoSourceTuning?.frameDiagnostic ?? null,
    videoSourceTuningJawTrace: camera.videoSourceTuning?.jawTrace ?? null,
    videoSourceTuningShadow: camera.videoSourceTuning?.shadowDiagnostic ?? null,
    videoSourceTuningEnabled,
    videoNeutralEnabledForConfig: camera.videoNeutral?.enabled !== false,
    roiEnabled: Boolean(camera.roiTracking?.enabled),
    sourceEpoch: isBrowserBackend
      ? browserSource.browserSourceState.sourceGeneration
      : sourceManager.trackingSourceState.sourceEpoch,
    fetchSourceState: useCallback(async () => {
      if (isBrowserBackend) {
        const bs = browserSource.browserSourceState
        return {
          sourceType: bs.sourceType,
          status: bs.status,
          sourceEpoch: bs.sourceGeneration,
          sourceId: bs.sourceType === "camera" ? "browser-mediapipe" : null,
          previewOnlyForced: true,
          cameraId: "browser-mediapipe",
          cameraLabel: "Browser Camera",
        }
      }
      const baseUrl = buildTrackingApiBaseUrl(camera.ctrl.wsUrlDraft)
      return fetchTrackingSourceState(baseUrl)
    }, [isBrowserBackend, browserSource.browserSourceState, camera.ctrl.wsUrlDraft]),
    videoStartMs: camera.videoDiagnostic?.startMs ?? 3000,
    defaultVideos: sourceManager.trackingSourceState.defaultVideos,
  })

  datasetStopRef.current = datasetRecorder.stopRecording

  useEffect(() => {
    if (isBrowserBackend) {
      camera.setFrameValidator?.(null)
      camera.setOnSourceChanged?.(null)
      return
    }
    camera.setFrameValidator?.(sourceManager.isFrameEpochValid)
    camera.setOnSourceChanged?.(sourceManager.applySourceChangedEvent)
  }, [camera, sourceManager, isBrowserBackend])

  const [cameraSelectModalOpen, setCameraSelectModalOpen] = useState(false)

  const openCameraSelectModal = useCallback(() => {
    if (isBrowserBackend) {
      return
    }
    setCameraSelectModalOpen(true)
  }, [isBrowserBackend])

  const handleCameraSelectConfirm = useCallback(
    async (cameraId) => {
      if (isBrowserBackend) {
        setCameraSelectModalOpen(false)
        return
      }
      await sourceManager.switchToCamera(cameraId)
      setCameraSelectModalOpen(false)
    },
    [sourceManager, isBrowserBackend]
  )

  switchBackendToIdleRef.current = async () => {
    if (isBrowserBackend) {
      diagnosticStopRef.current?.()
      if (camera.previewSourceRunning) {
        camera.stopPreviewTracking()
      } else {
        camera.stopBrowserCamera?.()
        camera.resetPreviewToNeutral()
      }
      browserSource.resetToIdle()
      return
    }
    try {
      await sourceManager.switchToIdle()
    } catch {
      /* surfaced in sourceManager state */
    }
  }

  const stopDiagnosticRecordingIfActive = useCallback(() => {
    if (getTrackingDiagnosticRecorderStatus().recording) {
      diagnosticRecorder.stopRecording()
    }
  }, [diagnosticRecorder])

  diagnosticStopRef.current = stopDiagnosticRecordingIfActive

  const trackingSourceState = sourceManager.trackingSourceState
  const activeDefaultVideoId = useMemo(
    () => resolveDefaultVideoSelectId(trackingSourceState),
    [
      trackingSourceState.sourceType,
      trackingSourceState.sourceId,
      trackingSourceState.selectedVideoId,
      trackingSourceState.defaultVideos,
    ]
  )

  const handleDefaultVideoSelect = useCallback(
    async (videoId) => {
      const nextId = String(videoId || "").trim()
      if (!nextId || trackingSourceState.switching) {
        return
      }
      if (nextId === activeDefaultVideoId) {
        return
      }
      sourceManager.setSelectedVideoId(nextId)
      try {
        await sourceManager.switchToDefaultVideo(nextId, videoDiagnosticStartMs)
      } catch {
        /* error surfaced in sourceManager state */
      }
    },
    [
      trackingSourceState.switching,
      activeDefaultVideoId,
      sourceManager,
      videoDiagnosticStartMs,
    ]
  )

  const handleSourceSelect = useCallback(
    async (kind) => {
      setSourceCapabilityMessage("")

      const availability = resolveSourceSegmentAvailability(camera.trackingBackend, kind)
      if (!availability.allowed) {
        setSourceCapabilityMessage(availability.hint || "当前 Runtime 不支持该输入源")
        return
      }

      const wasDeviceDrive =
        deviceDriveArmed && driveMode === DRIVE_MODES.DEVICE_DRIVE
      if (wasDeviceDrive) {
        disarmDeviceDrive()
        await centerHardwareToNeutral()
      }

      // —— Browser Runtime：纯前端 Source，零 Python REST ——
      if (isBrowserBackend) {
        if (kind === TRACKING_SOURCE_SEGMENT_IDS.IDLE) {
          setCameraSelectModalOpen(false)
          if (camera.previewSourceRunning) {
            stopDiagnosticRecordingIfActive()
            camera.stopPreviewTracking()
          } else {
            camera.stopBrowserCamera?.()
            camera.resetPreviewToNeutral()
          }
          browserSource.resetToIdle()
          return
        }
        if (kind === TRACKING_SOURCE_SEGMENT_IDS.CAMERA) {
          setCameraSelectModalOpen(false)
          setActiveTab(TRACKING_PREVIEW_TABS.CAMERA)
          browserSource.selectCamera()
          return
        }
        if (kind === TRACKING_SOURCE_SEGMENT_IDS.MOTION_TRACK) {
          if (camera.previewSourceRunning) {
            stopDiagnosticRecordingIfActive()
            camera.stopPreviewTracking()
          } else {
            camera.stopBrowserCamera?.()
          }
          browserSource.resetToIdle()
          setActiveTab(TRACKING_PREVIEW_TABS.MOTION_TRACK)
          return
        }
        return
      }

      // —— Python Runtime：保持原 Source Manager 行为 ——
      if (kind === TRACKING_SOURCE_SEGMENT_IDS.UPLOAD) {
        setActiveTab(TRACKING_PREVIEW_TABS.UPLOAD)
        return
      }
      if (sourceManager.trackingSourceState.switching) {
        return
      }
      try {
        if (kind === TRACKING_SOURCE_SEGMENT_IDS.IDLE) {
          setCameraSelectModalOpen(false)
          if (camera.previewSourceRunning) {
            stopDiagnosticRecordingIfActive()
            camera.stopPreviewTracking()
          }
          await sourceManager.switchToIdle()
          return
        }
        if (kind === TRACKING_SOURCE_SEGMENT_IDS.CAMERA) {
          setActiveTab(TRACKING_PREVIEW_TABS.CAMERA)
          openCameraSelectModal()
          return
        }
        if (kind === TRACKING_SOURCE_SEGMENT_IDS.VIDEO) {
          setActiveTab(TRACKING_PREVIEW_TABS.VIDEO)
          await sourceManager.switchToDefaultVideo(
            sourceManager.trackingSourceState.selectedVideoId
          )
          return
        }
        if (kind === TRACKING_SOURCE_SEGMENT_IDS.MOTION_TRACK) {
          if (camera.previewSourceRunning) {
            stopDiagnosticRecordingIfActive()
            camera.stopPreviewTracking()
          }
          setActiveTab(TRACKING_PREVIEW_TABS.MOTION_TRACK)
          await sourceManager.switchToIdle()
        }
      } catch {
        /* error in sourceManager state */
      }
    },
    [
      camera,
      isBrowserBackend,
      browserSource,
      deviceDriveArmed,
      driveMode,
      disarmDeviceDrive,
      centerHardwareToNeutral,
      stopDiagnosticRecordingIfActive,
      openCameraSelectModal,
      sourceManager,
    ]
  )

  const startDiagnosticRecordingWithTracking = useCallback(() => {
    if (diagnosticMode === DIAGNOSTIC_MODES.OFF) {
      return
    }
    if (getTrackingDiagnosticRecorderStatus().recording) {
      return
    }
    const isVideoRecordingTab =
      activeTab === TRACKING_PREVIEW_TABS.VIDEO ||
      activeTab === TRACKING_PREVIEW_TABS.UPLOAD
    void diagnosticRecorder.startRecording({
      durationMs: isVideoRecordingTab ? 0 : 5000,
      diagnosticMode,
      videoSourceTuningEnabled,
      baselineSourceEpoch: isBrowserBackend
        ? browserSource.browserSourceState.sourceGeneration
        : sourceManager.trackingSourceState.sourceEpoch,
      ...(isVideoRecordingTab ? { videoStartMs: videoDiagnosticStartMs } : {}),
    })
  }, [
    diagnosticMode,
    diagnosticRecorder,
    activeTab,
    videoDiagnosticStartMs,
    videoSourceTuningEnabled,
    isBrowserBackend,
    browserSource.browserSourceState.sourceGeneration,
    sourceManager.trackingSourceState.sourceEpoch,
  ])

  const handleStartPreviewTracking = useCallback(async () => {
    if (isBrowserBackend) {
      if (effectiveSource.sourceType !== "camera") {
        browserSource.selectCamera()
        setActiveTab(TRACKING_PREVIEW_TABS.CAMERA)
      }
      try {
        await camera.startPreviewTracking()
        browserSource.markStarted()
        startDiagnosticRecordingWithTracking()
      } catch (error) {
        browserSource.markError(error?.message || String(error))
      }
      return
    }
    camera.startPreviewTracking()
    startDiagnosticRecordingWithTracking()
  }, [
    isBrowserBackend,
    effectiveSource.sourceType,
    browserSource,
    camera,
    startDiagnosticRecordingWithTracking,
  ])

  const handleStartCameraTracking = useCallback(async () => {
    if (isBrowserBackend) {
      if (effectiveSource.sourceType !== "camera") {
        browserSource.selectCamera()
        setActiveTab(TRACKING_PREVIEW_TABS.CAMERA)
      }
      try {
        await camera.startCameraTracking()
        browserSource.markStarted()
      } catch (error) {
        browserSource.markError(error?.message || String(error))
      }
      return
    }
    camera.startCameraTracking()
  }, [
    isBrowserBackend,
    effectiveSource.sourceType,
    browserSource,
    camera,
  ])

  const handleStopPreviewTracking = useCallback(
    async (reason = "stop-button") => {
      if (stopBusy) {
        return
      }
      setStopBusy(true)
      const wasDeviceDrive =
        deviceDriveArmed && driveMode === DRIVE_MODES.DEVICE_DRIVE
      deviceDrive.beginStopSequence?.()
      disarmDeviceDrive()
      setLastCommand("Stopping... Returning device to neutral...")
      try {
        if (
          wasDeviceDrive &&
          TRACKING_DEVICE_DRIVE_STOP_DEFAULTS.stopReturnNeutralEnabled
        ) {
          const mode = TRACKING_DEVICE_DRIVE_STOP_DEFAULTS.stopReturnNeutralMode
          if (mode === "face-neutral" || mode === "both") {
            const result = await centerHardwareToNeutral({
              waitAfterLastMs: TRACKING_DEVICE_DRIVE_STOP_DEFAULTS.stopNeutralHoldMs,
            })
            if (result?.ok) {
              setLastCommand(
                reason === "video-ended"
                  ? "Video ended · Device neutral command sent"
                  : "Video stopped · Device neutral command sent"
              )
              setLastSerialError("")
            } else if (result?.reason === "not-connected") {
              setLastCommand("Video stopped · Serial offline, neutral skipped")
            } else if (result?.reason !== "empty-command") {
              setLastSerialError(`Neutral command failed: ${result?.reason || "unknown"}`)
            }
          }
        }
      } finally {
        stopDiagnosticRecordingIfActive()
        camera.stopPreviewTracking()
        await switchBackendToIdleRef.current()
        deviceDrive.endStopSequence?.()
        setStopBusy(false)
      }
    },
    [
      stopBusy,
      deviceDriveArmed,
      driveMode,
      deviceDrive,
      disarmDeviceDrive,
      centerHardwareToNeutral,
      stopDiagnosticRecordingIfActive,
      camera,
    ]
  )

  const stopPreviewTrackingRef = useRef(handleStopPreviewTracking)
  stopPreviewTrackingRef.current = handleStopPreviewTracking

  useEffect(() => {
    if (!camera.trackingStatus?.videoEnded) {
      return
    }
    if (!camera.previewSourceRunning) {
      return
    }
    if (stopBusy) {
      return
    }
    void stopPreviewTrackingRef.current("video-ended")
  }, [camera.trackingStatus?.videoEnded, camera.previewSourceRunning, stopBusy])

  const diagnosticRecording = Boolean(diagnosticRecorder.status?.recording)

  const renderIdleSourcePanel = () => (
    <CameraPreviewPanel
      trackingEnabled={false}
      trackingStatus={camera.trackingStatus}
      cameraSourceState={
        isBrowserBackend
          ? { sourceType: "idle", status: "idle" }
          : sourceManager.trackingSourceState
      }
      gazeDebug={null}
      onStart={handleStartCameraTracking}
      onStop={handleStopCameraTracking}
      onPickCamera={isBrowserBackend ? undefined : openCameraSelectModal}
      diagnosticRecording={diagnosticRecording}
      autoRecordOnStart={false}
      showWsUrl={showDeveloperDebug && !isBrowserBackend}
      wsUrlDraft={camera.ctrl.wsUrlDraft}
      onWsUrlChange={camera.ctrl.setWsUrlDraft}
      onApplyWs={camera.ctrl.replaceWithWebSocket}
      wsUrl={camera.ctrl.wsUrlDraft}
      previewBackend={isBrowserBackend ? "browser" : "python"}
      onBrowserVideoElement={camera.bindBrowserVideoElement}
      browserLifecycle={camera.trackingStatus?.lifecycle}
      browserMetrics={camera.browserMetrics}
    />
  )

  const sourcePanel = (() => {
    if (activeTab === TRACKING_PREVIEW_TABS.MOTION_TRACK) {
      return <MotionTrackPanel />
    }

    // Browser Runtime：effective source 权威，不读 Python sourceType
    if (isBrowserBackend) {
      if (effectiveSource.sourceType === "camera") {
        return (
          <CameraPreviewPanel
            trackingEnabled={Boolean(camera.previewSourceRunning)}
            trackingStatus={camera.trackingStatus}
            cameraSourceState={{
              sourceType: "camera",
              status: camera.previewSourceRunning ? "running" : "ready",
            }}
            gazeDebug={camera.ctrl.lastFrame?.debug?.gaze ?? null}
            onStart={handleStartCameraTracking}
            onStop={handleStopCameraTracking}
            diagnosticRecording={diagnosticRecording}
            autoRecordOnStart={false}
            showWsUrl={false}
            previewBackend="browser"
            onBrowserVideoElement={camera.bindBrowserVideoElement}
            browserLifecycle={camera.trackingStatus?.lifecycle}
            browserMetrics={camera.browserMetrics}
          />
        )
      }
      return renderIdleSourcePanel()
    }

    if ((effectiveSource.sourceType ?? "idle") === "idle") {
      return renderIdleSourcePanel()
    }

    if (activeTab === TRACKING_PREVIEW_TABS.CAMERA) {
      return (
        <CameraPreviewPanel
          trackingEnabled={camera.cameraRunning}
          trackingStatus={camera.trackingStatus}
          cameraSourceState={sourceManager.trackingSourceState}
          gazeDebug={camera.ctrl.lastFrame?.debug?.gaze ?? null}
          onStart={handleStartCameraTracking}
          onStop={handleStopCameraTracking}
          onPickCamera={openCameraSelectModal}
          diagnosticRecording={diagnosticRecording}
          autoRecordOnStart={false}
          showWsUrl={showDeveloperDebug}
          wsUrlDraft={camera.ctrl.wsUrlDraft}
          onWsUrlChange={camera.ctrl.setWsUrlDraft}
          onApplyWs={camera.ctrl.replaceWithWebSocket}
          wsUrl={camera.ctrl.wsUrlDraft}
          previewBackend="python"
          onBrowserVideoElement={camera.bindBrowserVideoElement}
          browserLifecycle={camera.trackingStatus?.lifecycle}
          browserMetrics={camera.browserMetrics}
        />
      )
    }
    if (activeTab === TRACKING_PREVIEW_TABS.UPLOAD) {
      return (
        <>
          <UploadedVideoSourcePanel
            sourceManager={sourceManager}
            previewOnlyForced={Boolean(sourceManager.trackingSourceState.previewOnlyForced)}
            onPlayUploadedVideo={() => {
              if (!camera.previewSourceRunning) {
                handleStartPreviewTracking()
              }
            }}
          />
          {sourceManager.trackingSourceState.sourceType === "uploaded-video" ? (
            <VideoPreviewPanel
              trackingEnabled={camera.previewSourceRunning}
              trackingStatus={camera.trackingStatus}
              lastFrame={camera.ctrl.lastFrame}
              onVideoFrameDebugChange={handleVideoFrameDebugChange}
              onStart={handleStartPreviewTracking}
              onStop={handleStopPreviewTracking}
              stopBusy={stopBusy}
              sourceState={trackingSourceState}
              uploadedVideos={trackingSourceState.uploadedVideos ?? []}
              sendTrackingControl={camera.ctrl.sendTrackingControl}
              diagnosticRecording={diagnosticRecording}
              autoRecordOnStart={diagnosticMode !== DIAGNOSTIC_MODES.OFF}
              showWsUrl={showDeveloperDebug}
              wsUrlDraft={camera.ctrl.wsUrlDraft}
              onWsUrlChange={camera.ctrl.setWsUrlDraft}
              onApplyWs={camera.ctrl.replaceWithWebSocket}
              wsUrl={camera.ctrl.wsUrlDraft}
            />
          ) : null}
        </>
      )
    }
    if (activeTab === TRACKING_PREVIEW_TABS.VIDEO) {
      return (
        <VideoPreviewPanel
          trackingEnabled={camera.previewSourceRunning}
          trackingStatus={camera.trackingStatus}
          lastFrame={camera.ctrl.lastFrame}
          onVideoFrameDebugChange={handleVideoFrameDebugChange}
          onStart={handleStartPreviewTracking}
          onStop={handleStopPreviewTracking}
          defaultVideos={trackingSourceState.defaultVideos ?? []}
          selectedVideoId={activeDefaultVideoId}
          onVideoSelect={handleDefaultVideoSelect}
          videoSwitchBusy={Boolean(trackingSourceState.switching)}
          stopBusy={stopBusy}
          sourceState={trackingSourceState}
          uploadedVideos={trackingSourceState.uploadedVideos ?? []}
          sendTrackingControl={camera.ctrl.sendTrackingControl}
          diagnosticRecording={diagnosticRecording}
          autoRecordOnStart={diagnosticMode !== DIAGNOSTIC_MODES.OFF}
          showWsUrl={showDeveloperDebug}
          wsUrlDraft={camera.ctrl.wsUrlDraft}
          onWsUrlChange={camera.ctrl.setWsUrlDraft}
          onApplyWs={camera.ctrl.replaceWithWebSocket}
          wsUrl={camera.ctrl.wsUrlDraft}
        />
      )
    }
    return renderIdleSourcePanel()
  })()

  const deviceDriveActive = driveMode === DRIVE_MODES.DEVICE_DRIVE && deviceDriveArmed

  const eyeCenterStatus = useMemo(() => {
    const dbg = camera.ctrl.lastFrame?.debug
    if (!dbg || typeof dbg !== "object") return null
    return dbg.eyeXyCenter ?? dbg.gaze?.eyeXyCenter ?? null
  }, [camera.ctrl.lastFrame])

  return (
    <section
      className={`tp-monitor${deviceDriveActive ? " tp-monitor--device-drive" : ""}${
        showDeveloperDebug ? " tp-monitor--dev" : ""
      }`}
    >
      <TrackingPreviewHeader
        activeTab={activeTab}
        effectiveSource={effectiveSource}
        trackingBackend={camera.trackingBackend || "python"}
        sourceCapabilityMessage={sourceCapabilityMessage}
        onSourceSelect={handleSourceSelect}
        driveMode={driveMode}
        onDriveModeChange={handleDriveModeChange}
        outputMode={outputMode}
        onOutputModeChange={handleOutputModeChange}
        deviceDriveArmed={deviceDriveArmed}
        deviceDriveNote={deviceDriveNote}
        eyeCenterStatus={eyeCenterStatus}
        transportFamily={transportFamily}
        onTransportFamilyChange={(family) => {
          const next = normalizeBusTransportFamily(family)
          writeJsonStorage(BUS_TRANSPORT_FAMILY_STORAGE_KEY, next)
          setTransportFamily(next)
        }}
      />

      {!isBrowserBackend ? (
        <CameraSelectModal
          open={cameraSelectModalOpen}
          sourceManager={sourceManager}
          onConfirm={handleCameraSelectConfirm}
          onCancel={() => setCameraSelectModalOpen(false)}
        />
      ) : null}

      <div className="tp-tracking-backend-bar" aria-label="Tracking runtime">
        <label className="tp-tracking-backend-label">
          Tracking Runtime
          <select
            className="tp-tracking-backend-select"
            value={camera.trackingBackend || "python"}
            disabled={camera.previewSourceRunning}
            onChange={(e) => {
              const next = e.target.value
              void (async () => {
                setSourceCapabilityMessage("")
                setCameraSelectModalOpen(false)
                stopDiagnosticRecordingIfActive()
                if (camera.previewSourceRunning) {
                  camera.stopPreviewTracking()
                } else if (isBrowserBackend) {
                  camera.stopBrowserCamera?.()
                }
                browserSource.resetToIdle()
                await camera.switchTrackingBackend?.(next)
                if (next === "browser") {
                  browserSource.resetToIdle()
                }
              })()
            }}
          >
            <option value="browser">Browser MediaPipe</option>
            <option value="python">Python Service</option>
          </select>
        </label>
        <span className="tp-tracking-backend-meta">
          {isBrowserBackend
            ? (() => {
                const life = camera.trackingStatus?.lifecycle || "IDLE"
                const errCode = camera.trackingStatus?.modelErrorCode
                const errMsg =
                  camera.trackingStatus?.modelErrorMessage ||
                  camera.trackingStatus?.error ||
                  ""
                if (life === "ERROR" && errMsg) {
                  return `Model: ERROR${errCode ? ` [${errCode}]` : ""} · Reason: ${errMsg} · Source: ${effectiveSource.sourceType} · no 8766/8767`
                }
                return `Model: ${life} · Source: ${effectiveSource.sourceType} · no 8766/8767`
              })()
            : "WS 8766 · MJPEG 8767"}
        </span>
      </div>

      <div className="tracking-preview-grid">
        <div className="grid-column grid-column--left">
          <LeftSourceColumn
            activeTab={activeTab}
            sourcePanel={sourcePanel}
            previewRig={camera.previewRig}
            mapping={camera.mapping}
            lipGeometry={camera.lipGeometry}
            jawGeometry={camera.jawGeometry}
            mouthScenarioClassifier={camera.mouthScenarioClassifier}
            browGate={camera.browGate}
            browDebug={camera.browDebug}
            bypassBrowGate={bypassBrowGate}
            showDeveloperDebug={showDeveloperDebug}
            cameraRunning={camera.previewSourceRunning}
            onSetLipNeutral={camera.requestLipNeutral}
            driveMode={driveMode}
            dryRunResult={mappingDryRunResult}
            bindings={camera.profile?.bindings}
          />
        </div>

        <div className="grid-column grid-column--rig">
          <FaceRigPreviewCard rig={camera.previewRig} deviceDriveActive={deviceDriveActive} />
        </div>
      </div>

      <TrackingDatasetExportPanel
        datasetRecorder={datasetRecorder}
        sourceType={effectiveSource.sourceType}
        previewOnlyForced={Boolean(effectiveSource.previewOnlyForced)}
        trackingLive={Boolean(camera.previewSourceRunning)}
        browserLocalMode={isBrowserBackend}
        videoSourceTuningEnabled={videoSourceTuningEnabled}
      />

      {showDeveloperDebug ? (
        <TrackingPreviewDeveloperDebug
          className="tp-monitor-dev-overlay"
          lastFrame={camera.ctrl.lastFrame}
          calibratedFrame={camera.calibratedFrame}
          wsUrlDraft={camera.ctrl.wsUrlDraft}
          status={camera.ctrl.status}
          trackingStatus={camera.trackingStatus}
          driveMode={driveMode}
          deviceDriveDebug={deviceDriveDebugSnapshot}
          outputMode={outputMode}
          cameraRunning={camera.previewSourceRunning}
          onSetLipNeutral={camera.requestLipNeutral}
          browDebug={camera.browDebug}
          bypassBrowGate={bypassBrowGate}
          onBypassBrowGateChange={setBypassBrowGate}
          bypassEyeRelease={bypassEyeRelease}
          onBypassEyeReleaseChange={setBypassEyeRelease}
          diagnosticRecorder={diagnosticRecorder}
          diagnosticMode={diagnosticMode}
          onDiagnosticModeChange={(mode) => {
            setDiagnosticMode(mode)
            writeJsonStorage(TRACKING_DIAGNOSTIC_MODE_STORAGE_KEY, mode)
          }}
          dryRunResult={mappingDryRunResult}
          frontendOverlayMode={VIDEO_OVERLAY_MODES.OFF}
          roiFaceScale={camera.roiTracking?.faceScale ?? null}
          videoDiagnosticStartMs={videoDiagnosticStartMs}
          videoSourceTuningEnabled={videoSourceTuningEnabled}
          onVideoSourceTuningEnabledChange={(enabled) => {
            setVideoSourceTuningEnabled(enabled)
            writeJsonStorage(TRACKING_VIDEO_SOURCE_TUNING_STORAGE_KEY, enabled)
          }}
          busServoTxMode={busServoTxMode}
          onBusServoTxModeChange={(mode) => {
            setBusServoTxMode(mode)
            writeJsonStorage(TRACKING_BUS_TX_MODE_STORAGE_KEY, mode)
          }}
        />
      ) : null}
    </section>
  )
}
