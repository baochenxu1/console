import { useCallback, useEffect, useRef, useState } from "react"
import { COMPACT_DIAGNOSTIC_SAMPLE_MS } from "../../trackingPreview/deviceDriveDiagnostics.js"
import { DIAGNOSTIC_MODES } from "../../trackingPreview/trackingPreviewConstants.js"
import { buildCompactDiagnosticSample } from "../../tracking/diagnostics/trackingDiagnosticLite.js"
import {
  logCaptureInput,
  resolveWireTrackingDebug,
} from "../../trackingPreview/videoDiagnosticExportDebug.js"
import {
  appendDiagnosticSample,
  appendTrackingDiagnosticEvents,
  appendTrackingDiagnosticFrame,
  buildTrackingDiagnosticFrame,
  updateTrackingDiagnosticRecordingOptions,
  downloadTrackingDiagnosticRecording,
  exportTrackingDiagnosticRecording,
  getTrackingDiagnosticRecorderStatus,
  refreshTrackingDiagnosticSnapshots,
  startTrackingDiagnosticRecording,
  stopTrackingDiagnosticRecording,
  tickTrackingDiagnosticRecordingDurationLimit,
  subscribeTrackingDiagnosticRecorder,
} from "../../tracking/diagnostics/trackingDiagnosticRecorder.js"
import { resolveTrackingSourceContext } from "../../tracking/input/trackingSourceContext.js"

const CAPTURE_POLL_MS = 16
const VIDEO_RECORDING_FRAME_TOLERANCE_MS = 1000 / 30 + 2

function resolveCaptureSourceSeq(frame) {
  const src = frame?.debug?.inputSource
  if (src?.sourceSeq != null) return Number(src.sourceSeq)
  if (frame?.frameSeq != null) return Number(frame.frameSeq)
  return null
}

function hasCaptureTimestamp(frame) {
  if (!frame) return false
  const ts = frame.timestampMs ?? frame.debug?.inputSource?.timestampMs
  return ts != null && Number.isFinite(Number(ts))
}

function isVideoInputFrame(frame, options = {}) {
  return resolveTrackingSourceContext(frame, options, { isVideoTab: false }).isVideoSource
}

function isWithinVideoRecordingWindow(frame, options) {
  if (!frame || !options) return true
  const videoStartMs = options.videoStartMs
  if (videoStartMs == null) return true
  const src = frame.debug?.inputSource ?? frame.inputSource ?? {}
  const videoTimeMs = src.videoTimeMs != null ? Number(src.videoTimeMs) : null
  if (videoTimeMs == null || !Number.isFinite(videoTimeMs)) return true
  const startMs = Number(videoStartMs)
  const durationMs = Number(options.durationMs) || 0
  if (videoTimeMs < startMs - VIDEO_RECORDING_FRAME_TOLERANCE_MS) return false
  if (durationMs > 0 && videoTimeMs > startMs + durationMs + VIDEO_RECORDING_FRAME_TOLERANCE_MS * 2) {
    return false
  }
  return true
}

/**
 * Tracking Preview 诊断录制：video 按 sourceSeq 逐帧捕获；camera 轮询兜底。
 */
export function useTrackingDiagnosticRecorder({
  enabled = false,
  diagnosticMode = DIAGNOSTIC_MODES.COMPACT,
  lastFrame,
  calibratedFrame,
  previewRig,
  dryRunResult,
  trackingStatus,
  driveMode,
  outputMode,
  deviceDriveDebug,
  browDebug,
  profile = null,
  actuatorProfiles = null,
  videoFrameDebug = null,
  getVideoFrameDebug = null,
  videoInputActive = false,
  frontendOverlayMode = null,
  videoNeutralSnapshot = null,
  videoNeutralEnabled = true,
  videoNeutralApplyResult = null,
  videoNeutralDiagnostic = null,
  getRawTrackingSignals = null,
  getVideoNeutralEvents = null,
  prepareVideoDiagnostic = null,
  videoSourceTuningDiagnostic = null,
  videoSourceTuningJawTrace = null,
  videoSourceTuningShadow = null,
  videoSourceTuningEnabled = true,
  videoDeviceDryRunEnabled = false,
  videoRealSendSmokeTestEnabled = false,
  videoSmokeTestProfile = null,
  configs = [],
} = {}) {
  const [status, setStatus] = useState(() => getTrackingDiagnosticRecorderStatus())
  const [exportError, setExportError] = useState("")
  /** Record 5s/10s 等限时录制结束后自动下载 */
  const autoExportOnStopRef = useRef(false)
  const exportLastRef = useRef(async () => {})
  const prevRecordingRef = useRef(false)
  const ctxRef = useRef({})
  const lastCapturedSourceSeqRef = useRef(null)
  const lastSampleAtRef = useRef(0)
  const diagnosticModeRef = useRef(diagnosticMode)
  const videoFrameDebugRef = useRef(videoFrameDebug)
  const getVideoFrameDebugRef = useRef(getVideoFrameDebug)
  const frontendOverlayModeRef = useRef(frontendOverlayMode)
  const videoNeutralSnapshotRef = useRef(videoNeutralSnapshot)
  const videoNeutralEnabledRef = useRef(videoNeutralEnabled)
  const videoNeutralApplyResultRef = useRef(videoNeutralApplyResult)
  const videoNeutralDiagnosticRef = useRef(videoNeutralDiagnostic)
  const getRawTrackingSignalsRef = useRef(getRawTrackingSignals)
  const getVideoNeutralEventsRef = useRef(getVideoNeutralEvents)
  const prepareVideoDiagnosticRef = useRef(prepareVideoDiagnostic)
  const videoSourceTuningDiagnosticRef = useRef(videoSourceTuningDiagnostic)
  const videoSourceTuningJawTraceRef = useRef(videoSourceTuningJawTrace)
  const videoSourceTuningShadowRef = useRef(videoSourceTuningShadow)
  const videoSourceTuningEnabledRef = useRef(videoSourceTuningEnabled)
  const videoDeviceDryRunEnabledRef = useRef(videoDeviceDryRunEnabled)
  const videoRealSendSmokeTestEnabledRef = useRef(videoRealSendSmokeTestEnabled)
  const videoSmokeTestProfileRef = useRef(videoSmokeTestProfile)

  diagnosticModeRef.current = diagnosticMode
  videoFrameDebugRef.current = videoFrameDebug
  getVideoFrameDebugRef.current = getVideoFrameDebug
  frontendOverlayModeRef.current = frontendOverlayMode
  videoNeutralSnapshotRef.current = videoNeutralSnapshot
  videoNeutralEnabledRef.current = videoNeutralEnabled
  videoNeutralApplyResultRef.current = videoNeutralApplyResult
  videoNeutralDiagnosticRef.current = videoNeutralDiagnostic
  getRawTrackingSignalsRef.current = getRawTrackingSignals
  getVideoNeutralEventsRef.current = getVideoNeutralEvents
  prepareVideoDiagnosticRef.current = prepareVideoDiagnostic
  videoSourceTuningDiagnosticRef.current = videoSourceTuningDiagnostic
  videoSourceTuningJawTraceRef.current = videoSourceTuningJawTrace
  videoSourceTuningShadowRef.current = videoSourceTuningShadow
  videoSourceTuningEnabledRef.current = videoSourceTuningEnabled
  videoDeviceDryRunEnabledRef.current = videoDeviceDryRunEnabled
  videoRealSendSmokeTestEnabledRef.current = videoRealSendSmokeTestEnabled
  videoSmokeTestProfileRef.current = videoSmokeTestProfile

  const resolveVideoFrameDebug = useCallback(
    () => getVideoFrameDebugRef.current?.() ?? videoFrameDebugRef.current ?? null,
    []
  )

  const buildCaptureCtx = useCallback(
    (frameOverride = null) => {
      const recStatus = getTrackingDiagnosticRecorderStatus()
      const lf = frameOverride ?? lastFrame
      const inputSource = lf?.debug?.inputSource
      const sourceSeq = inputSource?.sourceSeq ?? lf?.frameSeq ?? null
      const wireTrackingDebug = resolveWireTrackingDebug(lf, sourceSeq)
      const sourceContext = resolveTrackingSourceContext(
        { inputSource, source: lf?.source, debug: lf?.debug },
        recStatus.options,
        { isVideoTab: videoInputActive }
      )
      return {
        lastFrame: lf,
        calibratedFrame,
        previewRig,
        dryRunResult,
        trackingStatus,
        driveMode,
        outputMode,
        deviceDriveDebug,
        browDebug,
        profile,
        actuatorProfiles,
        configs,
        videoFrameDebug: resolveVideoFrameDebug(),
        getVideoFrameDebug: resolveVideoFrameDebug,
        wireSourceSeq: sourceSeq,
        wireSnapshot: {
          wireTrackingDebug,
          wireInputSource: inputSource ?? null,
        },
        videoNeutralSnapshot: videoNeutralSnapshotRef.current ?? null,
        videoNeutralEnabled: videoNeutralEnabledRef.current !== false,
        videoNeutralApplyResult: videoNeutralApplyResultRef.current ?? null,
        videoNeutralDiagnostic: videoNeutralDiagnosticRef.current ?? null,
        getRawTrackingSignals: getRawTrackingSignalsRef.current ?? null,
        videoSourceTuningDiagnostic: videoSourceTuningDiagnosticRef.current ?? null,
        videoSourceTuningJawTrace: videoSourceTuningJawTraceRef.current ?? null,
        videoSourceTuningShadow: videoSourceTuningShadowRef.current ?? null,
        options: {
          ...recStatus.options,
          diagnosticMode: diagnosticModeRef.current,
          frontendOverlayMode: frontendOverlayModeRef.current ?? recStatus.options.frontendOverlayMode ?? null,
          videoNeutralSnapshot: videoNeutralSnapshotRef.current ?? null,
          videoNeutralEnabled: videoNeutralEnabledRef.current !== false,
          videoDeviceDryRunEnabled: videoDeviceDryRunEnabledRef.current === true,
          videoRealSendSmokeTestEnabled: videoRealSendSmokeTestEnabledRef.current === true,
          videoSmokeTestProfile: videoSmokeTestProfileRef.current ?? null,
          ...(sourceContext.isVideoSource
            ? {
                inputSourceType: "video",
                forceVideoDiagnosticFields: true,
                includeSelectedLandmarks: recStatus.options.includeSelectedLandmarks !== false,
                captureVideoFrameDebug: recStatus.options.captureVideoFrameDebug !== false,
              }
            : {}),
        },
      }
    },
    [
      lastFrame,
      calibratedFrame,
      previewRig,
      dryRunResult,
      trackingStatus,
      driveMode,
      outputMode,
      deviceDriveDebug,
      browDebug,
      profile,
      actuatorProfiles,
      configs,
      resolveVideoFrameDebug,
      videoInputActive,
      frontendOverlayMode,
    ]
  )

  ctxRef.current = buildCaptureCtx()

  useEffect(() => subscribeTrackingDiagnosticRecorder(setStatus), [])

  useEffect(() => {
    const wasRecording = prevRecordingRef.current
    prevRecordingRef.current = Boolean(status.recording)
    if (!wasRecording || status.recording || !autoExportOnStopRef.current) {
      return
    }
    autoExportOnStopRef.current = false
    window.setTimeout(async () => {
      try {
        // 等待最后一帧 append + stop 收尾，避免 0 帧误导出
        await new Promise((resolve) => window.setTimeout(resolve, 120))
        const st = getTrackingDiagnosticRecorderStatus()
        if (st.frameCount === 0 && st.totalFrameCount === 0) {
          await new Promise((resolve) => window.setTimeout(resolve, 120))
        }
        await exportLastRef.current?.()
      } catch (e) {
        setExportError(e?.message || String(e))
      }
    }, 0)
  }, [status.recording])

  const drainNeutralEvents = useCallback(() => {
    const drain = getVideoNeutralEventsRef.current
    if (typeof drain !== "function") {
      return
    }
    const events = drain()
    if (events?.length) {
      appendTrackingDiagnosticEvents(events)
    }
  }, [])

  const appendFrameFromCtx = useCallback(
    (captureCtx, mode) => {
      const recStatus = getTrackingDiagnosticRecorderStatus()
      if (!recStatus.recording) {
        return false
      }
      drainNeutralEvents()
      const mergedOptions = {
        ...recStatus.options,
        ...captureCtx.options,
        diagnosticMode: mode,
        videoNeutralSnapshot: captureCtx.videoNeutralSnapshot ?? captureCtx.options?.videoNeutralSnapshot ?? null,
        videoNeutralEnabled:
          captureCtx.videoNeutralEnabled ?? captureCtx.options?.videoNeutralEnabled !== false,
      }
      updateTrackingDiagnosticRecordingOptions({
        videoNeutralSnapshot: mergedOptions.videoNeutralSnapshot,
        videoNeutralEnabled: mergedOptions.videoNeutralEnabled,
      })
      logCaptureInput(captureCtx)
      const frame = buildTrackingDiagnosticFrame({
        ...captureCtx,
        getVideoFrameDebug: resolveVideoFrameDebug,
        videoFrameDebug: resolveVideoFrameDebug(),
        frameIndex: recStatus.frameCount,
        options: mergedOptions,
      })
      if (!frame) {
        return false
      }
      appendTrackingDiagnosticFrame(frame)

      const now = Date.now()
      if (
        mode === DIAGNOSTIC_MODES.COMPACT &&
        now - lastSampleAtRef.current >= COMPACT_DIAGNOSTIC_SAMPLE_MS
      ) {
        const sample = buildCompactDiagnosticSample({
          ...captureCtx,
          getVideoFrameDebug: resolveVideoFrameDebug,
          videoFrameDebug: resolveVideoFrameDebug(),
          options: mergedOptions,
        })
        if (sample) {
          appendDiagnosticSample(sample)
        }
        lastSampleAtRef.current = now
      }
      return true
    },
    [resolveVideoFrameDebug, drainNeutralEvents]
  )

  const captureFrameIfRecording = useCallback(
    (frameOverride = null) => {
      const recStatus = getTrackingDiagnosticRecorderStatus()
      if (!recStatus.recording) {
        return false
      }
      const mode = diagnosticModeRef.current
      if (mode === DIAGNOSTIC_MODES.OFF) {
        return false
      }
      const frame = frameOverride ?? lastFrame
      if (!hasCaptureTimestamp(frame)) {
        return false
      }
      const isVideo = isVideoInputFrame(frame, recStatus.options)
      if (isVideo && !isWithinVideoRecordingWindow(frame, recStatus.options)) {
        const seq = resolveCaptureSourceSeq(frame)
        if (seq != null) {
          lastCapturedSourceSeqRef.current = seq
        }
        return false
      }
      const sourceSeq = resolveCaptureSourceSeq(frame)
      if (sourceSeq == null || sourceSeq === lastCapturedSourceSeqRef.current) {
        return false
      }
      lastCapturedSourceSeqRef.current = sourceSeq
      return appendFrameFromCtx(buildCaptureCtx(frame), mode)
    },
    [lastFrame, appendFrameFromCtx, buildCaptureCtx]
  )

  useEffect(() => {
    if (!hasCaptureTimestamp(lastFrame)) {
      return
    }
    captureFrameIfRecording(lastFrame)
  }, [lastFrame, captureFrameIfRecording])

  useEffect(() => {
    if (!status.recording) {
      return undefined
    }
    const id = window.setInterval(() => {
      captureFrameIfRecording()
    }, CAPTURE_POLL_MS)
    return () => window.clearInterval(id)
  }, [status.recording, captureFrameIfRecording])

  useEffect(() => {
    if (!status.recording) {
      return undefined
    }
    const id = window.setInterval(() => {
      tickTrackingDiagnosticRecordingDurationLimit()
      setStatus(getTrackingDiagnosticRecorderStatus())
    }, 250)
    return () => window.clearInterval(id)
  }, [status.recording])

  const startRecording = useCallback(async (options = {}) => {
    lastCapturedSourceSeqRef.current = null
    lastSampleAtRef.current = 0
    setExportError("")
    const ctx = buildCaptureCtx()
    const videoStartMs =
      options.videoStartMs != null ? Math.max(0, Number(options.videoStartMs) || 0) : null
    if (
      videoInputActive &&
      videoStartMs != null &&
      typeof prepareVideoDiagnosticRef.current === "function"
    ) {
      prepareVideoDiagnosticRef.current(videoStartMs)
      await new Promise((resolve) => window.setTimeout(resolve, 280))
    }
    const isVideoInput =
      resolveTrackingSourceContext(ctx.lastFrame, options, { isVideoTab: videoInputActive })
        .isVideoSource ||
      ctx.lastFrame?.debug?.inputSource?.sourceType === "video" ||
      ctx.lastFrame?.debug?.trackingDebug != null
    const mode = options.diagnosticMode ?? diagnosticModeRef.current ?? DIAGNOSTIC_MODES.COMPACT
    const mergedOptions = {
      ...options,
      diagnosticMode: mode,
      inputSourceType: resolveTrackingSourceContext(ctx.lastFrame, options, {
        isVideoTab: videoInputActive,
      }).isVideoSource
        ? "video"
        : ctx.lastFrame?.debug?.inputSource?.sourceType ?? null,
      forceVideoDiagnosticFields:
        resolveTrackingSourceContext(ctx.lastFrame, options, { isVideoTab: videoInputActive })
          .isVideoSource || isVideoInput,
      includeSelectedLandmarks:
        options.includeSelectedLandmarks ?? (isVideoInput || videoInputActive ? true : undefined),
      captureVideoFrameDebug:
        options.captureVideoFrameDebug ?? (isVideoInput || videoInputActive ? true : undefined),
      frontendOverlayMode:
        options.frontendOverlayMode ?? frontendOverlayModeRef.current ?? null,
      videoNeutralSnapshot:
        options.videoNeutralSnapshot ?? ctx.videoNeutralSnapshot ?? videoNeutralSnapshotRef.current ?? null,
      videoNeutralEnabled:
        options.videoNeutralEnabled ?? ctx.videoNeutralEnabled ?? videoNeutralEnabledRef.current !== false,
      videoSourceTuningEnabled:
        options.videoSourceTuningEnabled ?? videoSourceTuningEnabledRef.current !== false,
      videoDeviceDryRunEnabled:
        options.videoDeviceDryRunEnabled ?? videoDeviceDryRunEnabledRef.current === true,
      videoRealSendSmokeTestEnabled:
        options.videoRealSendSmokeTestEnabled ??
        videoRealSendSmokeTestEnabledRef.current === true,
      videoSmokeTestProfile:
        options.videoSmokeTestProfile ?? videoSmokeTestProfileRef.current ?? null,
      ...(videoStartMs != null ? { videoStartMs } : {}),
    }
    autoExportOnStopRef.current = Number(mergedOptions.durationMs) > 0
    return startTrackingDiagnosticRecording(mergedOptions, {
      profile: ctx.profile,
      actuatorProfiles: ctx.actuatorProfiles,
    })
  }, [buildCaptureCtx, videoInputActive, drainNeutralEvents])

  const stopRecording = useCallback(() => {
    drainNeutralEvents()
    return stopTrackingDiagnosticRecording()
  }, [drainNeutralEvents])

  const exportLast = useCallback(async (filename) => {
    setExportError("")
    try {
      if (getTrackingDiagnosticRecorderStatus().recording) {
        stopTrackingDiagnosticRecording()
      }
      drainNeutralEvents()
      const ctx = buildCaptureCtx()
      updateTrackingDiagnosticRecordingOptions({
        videoNeutralSnapshot: ctx.videoNeutralSnapshot ?? null,
        videoNeutralEnabled: ctx.videoNeutralEnabled !== false,
      })
      refreshTrackingDiagnosticSnapshots({
        profile: ctx.profile,
        actuatorProfiles: ctx.actuatorProfiles,
      })
      const data = await downloadTrackingDiagnosticRecording(filename)
      return data
    } catch (e) {
      const msg = e?.message || String(e)
      setExportError(msg)
      throw e
    }
  }, [buildCaptureCtx, drainNeutralEvents])

  exportLastRef.current = exportLast

  const peekExport = useCallback(() => exportTrackingDiagnosticRecording(), [])

  return {
    status,
    exportError,
    startRecording,
    stopRecording,
    exportLast,
    peekExport,
  }
}
