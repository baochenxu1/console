import { useCallback, useEffect, useRef, useState } from "react"
import { buildTrackingDatasetFrame } from "../../tracking/dataset/buildTrackingDatasetFrame.js"
import {
  beginTrackingDatasetSession,
  endTrackingDatasetSession,
  getTrackingDatasetRecorderStatus,
  incrementTrackingDatasetFrameCount,
  setTrackingDatasetRecorderError,
  subscribeTrackingDatasetRecorder,
} from "../../tracking/dataset/trackingDatasetRecorder.js"
import { resolveDatasetSourceLabels } from "../../tracking/dataset/datasetSourceLabels.js"
import { resolveTrackingSourceContext } from "../../tracking/input/trackingSourceContext.js"
import {
  appendTrackingDatasetFrame,
  buildTrackingDatasetApiBaseUrl,
  buildTrackingDatasetDownloadUrl,
  fetchTrackingDatasetFiles,
  fetchTrackingDatasetStatus,
  startTrackingDatasetRecording,
  stopTrackingDatasetRecording,
} from "../../trackingPreview/trackingDatasetApi.js"
import {
  appendBrowserDatasetFrame,
  buildBrowserDatasetDownloadUrl,
  finalizeBrowserDatasetSession,
  newBrowserDatasetSessionId,
  startBrowserDatasetSession,
} from "../../tracking/dataset/browserTrackingDatasetSession.js"

const CAPTURE_POLL_MS = 16
const VIDEO_RECORDING_FRAME_TOLERANCE_MS = 1000 / 30 + 2

const DEFAULT_OPTIONS = {
  datasetType: "teacher-video-tracking",
  sourceType: "current",
  durationMs: 5000,
  includeLandmarks: false,
  includeBlendshapes: true,
  includeRawTrackingSignals: true,
  includeTunedRig: true,
  includePreviewCommand: true,
  format: "jsonl",
  exportCompression: "gzip",
}

function resolveCaptureSourceSeq(frame) {
  const src = frame?.debug?.inputSource
  if (src?.sourceSeq != null) return Number(src.sourceSeq)
  if (frame?.frameSeq != null) return Number(frame.frameSeq)
  return null
}

function isVideoInputFrame(frame) {
  return resolveTrackingSourceContext(frame, {}, { isVideoTab: false }).isVideoSource
}

function isWithinRecordingWindow(frame, options) {
  if (!frame || !options) return true
  const windowStartMs = options.recordingWindowStartMs ?? options.videoStartMs
  if (windowStartMs == null) return true
  const src = frame.debug?.inputSource ?? frame.inputSource ?? {}
  const videoTimeMs = src.videoTimeMs != null ? Number(src.videoTimeMs) : null
  if (videoTimeMs == null || !Number.isFinite(videoTimeMs)) return true
  const startMs = Number(windowStartMs)
  const durationMs = Number(options.durationMs) || 0
  if (videoTimeMs < startMs - VIDEO_RECORDING_FRAME_TOLERANCE_MS) return false
  if (durationMs > 0 && videoTimeMs > startMs + durationMs + VIDEO_RECORDING_FRAME_TOLERANCE_MS * 2) {
    return false
  }
  return true
}

function resolveRecordingWindowStartMs(sourceState, lastFrame, fallbackMs) {
  const fromState = sourceState?.videoTimeMs
  if (fromState != null && Number.isFinite(Number(fromState))) {
    return Number(fromState)
  }
  const fromFrame = lastFrame?.debug?.inputSource?.videoTimeMs ?? lastFrame?.inputSource?.videoTimeMs
  if (fromFrame != null && Number.isFinite(Number(fromFrame))) {
    return Number(fromFrame)
  }
  if (fallbackMs != null && Number.isFinite(Number(fallbackMs))) {
    return Number(fallbackMs)
  }
  return 0
}

function resolveDatasetType(sourceType, requestType) {
  const req = String(requestType || "").trim()
  if (req === "teacher-uploaded-video-tracking") return req
  if (req === "camera-tracking-reference" || req === "teacher-video-tracking") {
    return req
  }
  if (sourceType === "uploaded-video") return "teacher-uploaded-video-tracking"
  if (sourceType === "camera") return "camera-tracking-reference"
  return "teacher-video-tracking"
}

/**
 * Tracking Preview dataset export — streams frames to Python JSONL writer.
 */
export function useTrackingDatasetRecorder({
  enabled = false,
  browserLocalMode = false,
  wsUrl,
  apiPort,
  lastFrame,
  calibratedFrame,
  previewRig,
  dryRunResult,
  trackingStatus,
  driveMode,
  outputMode,
  deviceDriveDebug,
  videoInputActive = false,
  videoNeutralSnapshot = null,
  videoNeutralEnabled = true,
  videoNeutralApplyResult = null,
  videoNeutralDiagnostic = null,
  getRawTrackingSignals = null,
  videoSourceTuningDiagnostic = null,
  videoSourceTuningJawTrace = null,
  videoSourceTuningShadow = null,
  videoSourceTuningEnabled = true,
  videoNeutralEnabledForConfig = true,
  roiEnabled = false,
  sourceEpoch = null,
  fetchSourceState,
  defaultVideos = [],
  videoStartMs = null,
} = {}) {
  const [status, setStatus] = useState(() => getTrackingDatasetRecorderStatus())
  const [files, setFiles] = useState([])
  const [actionError, setActionError] = useState("")
  const optionsRef = useRef({ ...DEFAULT_OPTIONS })
  const lastCapturedSourceSeqRef = useRef(null)
  const prevCaptureCtxRef = useRef(null)
  const recordStartMonotonicRef = useRef(null)
  const recordFrameIndexRef = useRef(0)
  const safetyRef = useRef({
    realSentFrameCount: 0,
    realTxCount: 0,
    realBusPacketCount: 0,
  })
  const durationTimerRef = useRef(null)
  const stopRecordingRef = useRef(async () => {})

  const apiBaseUrl = buildTrackingDatasetApiBaseUrl(wsUrl, apiPort)

  const buildCaptureCtx = useCallback(
    (frameOverride = null) => {
      const recStatus = getTrackingDatasetRecorderStatus()
      const lf = frameOverride ?? lastFrame
      const inputSource = lf?.debug?.inputSource
      const sourceSeq = inputSource?.sourceSeq ?? lf?.frameSeq ?? null
      return {
        lastFrame: lf,
        calibratedFrame,
        previewRig,
        dryRunResult,
        trackingStatus,
        driveMode,
        outputMode,
        deviceDriveDebug,
        videoNeutralSnapshot: videoNeutralSnapshot ?? null,
        videoNeutralEnabled: videoNeutralEnabled !== false,
        videoNeutralApplyResult: videoNeutralApplyResult ?? null,
        videoNeutralDiagnostic: videoNeutralDiagnostic ?? null,
        getRawTrackingSignals: getRawTrackingSignals ?? null,
        videoSourceTuningDiagnostic: videoSourceTuningDiagnostic ?? null,
        videoSourceTuningJawTrace: videoSourceTuningJawTrace ?? null,
        videoSourceTuningShadow: videoSourceTuningShadow ?? null,
        roiEnabled,
        sourceEpoch: inputSource?.sourceEpoch ?? sourceEpoch,
        sourceSeq,
        inputSource,
        sessionId: recStatus.sessionId,
        recordFrameIndex: recordFrameIndexRef.current,
        recordStartMonotonicMs: recordStartMonotonicRef.current,
        options: {
          ...optionsRef.current,
          videoSourceTuningEnabled,
          videoNeutralEnabled: videoNeutralEnabledForConfig !== false,
          ...(videoStartMs != null ? { videoStartMs } : {}),
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
      videoNeutralSnapshot,
      videoNeutralEnabled,
      videoNeutralApplyResult,
      videoNeutralDiagnostic,
      getRawTrackingSignals,
      videoSourceTuningDiagnostic,
      videoSourceTuningJawTrace,
      videoSourceTuningShadow,
      videoSourceTuningEnabled,
      videoNeutralEnabledForConfig,
      roiEnabled,
      sourceEpoch,
      videoStartMs,
    ]
  )

  useEffect(() => subscribeTrackingDatasetRecorder(setStatus), [])

  const refreshFiles = useCallback(async () => {
    try {
      const list = await fetchTrackingDatasetFiles(apiBaseUrl)
      setFiles(list)
    } catch {
      /* optional */
    }
  }, [apiBaseUrl])

  const appendFrameFromCtx = useCallback(
    async (captureCtx) => {
      const recStatus = getTrackingDatasetRecorderStatus()
      if (!recStatus.recording || !recStatus.sessionId) {
        return false
      }
      const frame = buildTrackingDatasetFrame(
        {
          ...captureCtx,
          appendSendTimeMs:
            typeof performance !== "undefined" ? performance.now() : Date.now(),
          frontendReceiveTimeMs: captureCtx.lastFrame?._frontendReceiveTimeMs ?? null,
        },
        prevCaptureCtxRef.current
      )
      if (!frame) {
        return false
      }
      const sendSnap = deviceDriveDebug?.getRealSendSnapshotForSeq?.(captureCtx.sourceSeq) ?? null
      if (sendSnap?.sent) {
        safetyRef.current.realSentFrameCount += 1
        safetyRef.current.realTxCount +=
          Number(sendSnap.commandCount) || Number(sendSnap.packetCount) || 0
        safetyRef.current.realBusPacketCount += Number(sendSnap.packetCount) || 0
      }
      try {
        if (browserLocalMode) {
          const res = appendBrowserDatasetFrame(frame)
          if (!res.ok) {
            throw new Error(String(res.error || "browser-dataset-append-failed"))
          }
        } else {
          await appendTrackingDatasetFrame(apiBaseUrl, frame)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setTrackingDatasetRecorderError(msg)
        setActionError(msg)
        return false
      }
      prevCaptureCtxRef.current = captureCtx
      recordFrameIndexRef.current += 1
      incrementTrackingDatasetFrameCount(1)
      return true
    },
    [apiBaseUrl, browserLocalMode, deviceDriveDebug]
  )

  const captureIfRecording = useCallback(async () => {
    const recStatus = getTrackingDatasetRecorderStatus()
    if (!recStatus.recording) return
    const ctx = buildCaptureCtx()
    if (!enabled || !ctx.lastFrame?.timestampMs) return
    if (isVideoInputFrame(ctx.lastFrame)) return
    const sourceSeq = resolveCaptureSourceSeq(ctx.lastFrame)
    if (sourceSeq == null || sourceSeq === lastCapturedSourceSeqRef.current) return
    lastCapturedSourceSeqRef.current = sourceSeq
    await appendFrameFromCtx(ctx)
  }, [enabled, buildCaptureCtx, appendFrameFromCtx])

  useEffect(() => {
    if (!enabled || !lastFrame?.timestampMs) return
    const recStatus = getTrackingDatasetRecorderStatus()
    if (!recStatus.recording) return
    if (!isVideoInputFrame(lastFrame)) return
    if (!isWithinRecordingWindow(lastFrame, optionsRef.current)) {
      const seq = resolveCaptureSourceSeq(lastFrame)
      if (seq != null) lastCapturedSourceSeqRef.current = seq
      return
    }
    const sourceSeq = resolveCaptureSourceSeq(lastFrame)
    if (sourceSeq == null || sourceSeq === lastCapturedSourceSeqRef.current) return
    lastCapturedSourceSeqRef.current = sourceSeq
    appendFrameFromCtx(buildCaptureCtx(lastFrame))
  }, [lastFrame, enabled, appendFrameFromCtx, buildCaptureCtx])

  useEffect(() => {
    if (!status.recording) return undefined
    const id = window.setInterval(() => {
      captureIfRecording()
    }, CAPTURE_POLL_MS)
    return () => window.clearInterval(id)
  }, [status.recording, captureIfRecording])

  const stopRecording = useCallback(async () => {
    if (durationTimerRef.current) {
      window.clearTimeout(durationTimerRef.current)
      durationTimerRef.current = null
    }
    const recStatus = getTrackingDatasetRecorderStatus()
    if (!recStatus.recording) {
      return recStatus.lastResult ?? null
    }
    setActionError("")
    try {
      const safety = {
        previewOnlyForced: true,
        realDeviceSendAllowed: false,
        ...safetyRef.current,
      }
      const result = browserLocalMode
        ? await finalizeBrowserDatasetSession(safety)
        : await stopTrackingDatasetRecording(apiBaseUrl, { safety })
      endTrackingDatasetSession(result)
      if (!browserLocalMode) {
        await refreshFiles()
      }
      if (result?.frameCount === 0) {
        setActionError("dataset-zero-frames — 未采集到帧；请先 Start Tracking 并保持 Model READY")
      }
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setTrackingDatasetRecorderError(msg)
      setActionError(msg)
      endTrackingDatasetSession(null)
      throw err
    }
  }, [apiBaseUrl, browserLocalMode, refreshFiles])

  stopRecordingRef.current = stopRecording

  const startRecording = useCallback(
    async (overrides = {}) => {
      setActionError("")
      if (!enabled) {
        const err = "dataset-tracking-not-running"
        const msg = "请先 Start Tracking（Model READY）后再录制 Dataset"
        setActionError(msg)
        throw new Error(err)
      }
      lastCapturedSourceSeqRef.current = null
      prevCaptureCtxRef.current = null
      recordStartMonotonicRef.current =
        typeof performance !== "undefined" ? performance.now() : Date.now()
      recordFrameIndexRef.current = 0
      safetyRef.current = {
        realSentFrameCount: 0,
        realTxCount: 0,
        realBusPacketCount: 0,
      }
      const merged = { ...DEFAULT_OPTIONS, ...optionsRef.current, ...overrides }
      if (videoStartMs != null && merged.videoStartMs == null) {
        merged.videoStartMs = videoStartMs
      }
      optionsRef.current = merged

      let sourceState = null
      if (typeof fetchSourceState === "function") {
        try {
          sourceState = await fetchSourceState()
        } catch (err) {
          const msg =
            browserLocalMode
              ? "无法读取 Browser Source 状态"
              : `Tracking Service 不可达（需 Python 8766）：${err instanceof Error ? err.message : String(err)}`
          setActionError(msg)
          throw err
        }
      }
      const sourceType = sourceState?.sourceType ?? "idle"
      if (sourceType === "idle") {
        const err = "dataset-source-idle"
        setActionError("Source idle — 请先选择 Camera 并 Start Tracking")
        throw new Error(err)
      }
      if (browserLocalMode && sourceType !== "camera") {
        const err = "dataset-browser-camera-only"
        setActionError("Browser Runtime 仅支持 Camera Dataset 导出")
        throw new Error(err)
      }

      const datasetType = resolveDatasetType(sourceType, merged.datasetType)
      const sourceLabels = resolveDatasetSourceLabels(sourceState, defaultVideos)
      const isVideoLike = sourceType === "video" || sourceType === "uploaded-video"
      const recordingWindowStartMs = isVideoLike
        ? resolveRecordingWindowStartMs(sourceState, lastFrame, merged.videoStartMs ?? videoStartMs)
        : null
      if (recordingWindowStartMs != null) {
        merged.recordingWindowStartMs = recordingWindowStartMs
        optionsRef.current = merged
      }
      const request = {
        datasetType,
        sourceType: merged.sourceType || "current",
        durationMs: merged.durationMs ?? 0,
        includeLandmarks: Boolean(merged.includeLandmarks),
        includeBlendshapes: merged.includeBlendshapes !== false,
        includeRawTrackingSignals: merged.includeRawTrackingSignals !== false,
        includeTunedRig: merged.includeTunedRig !== false,
        includePreviewCommand: merged.includePreviewCommand !== false,
        format: merged.format || "jsonl",
        exportCompression: merged.exportCompression || "gzip",
        samplingMode: "source-fps",
        targetFps: 30,
        frameDropStrategy: "none",
        videoStartMs: merged.videoStartMs ?? videoStartMs ?? 0,
        ...(recordingWindowStartMs != null
          ? { recordingWindowStartMs, recordingWindowEndMs: recordingWindowStartMs + (Number(merged.durationMs) || 0) }
          : {}),
        playbackRate: sourceState?.playbackRate ?? 1,
        videoSourceTuningEnabled:
          sourceType === "video" || sourceType === "uploaded-video"
            ? Boolean(videoSourceTuningEnabled)
            : false,
        videoNeutralEnabled: videoNeutralEnabledForConfig !== false,
        roiEnabled: Boolean(roiEnabled),
        ...sourceLabels,
      }

      let result
      try {
        if (browserLocalMode) {
          const sessionId = newBrowserDatasetSessionId()
          result = startBrowserDatasetSession({
            sessionId,
            request: { ...request, datasetType },
            sourceState,
          })
        } else {
          result = await startTrackingDatasetRecording(apiBaseUrl, request)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setActionError(msg)
        throw err
      }

      beginTrackingDatasetSession({
        sessionId: result.sessionId,
        sourceType: result.sourceType ?? sourceType,
        sourceEpoch: result.sourceEpoch ?? sourceState?.sourceEpoch ?? null,
        datasetType: result.datasetType ?? datasetType,
        options: merged,
      })

      const durationMs = Number(merged.durationMs) || 0
      if (durationMs > 0) {
        durationTimerRef.current = window.setTimeout(() => {
          stopRecordingRef.current?.()
        }, durationMs)
      }
      return result
    },
    [
      apiBaseUrl,
      browserLocalMode,
      enabled,
      fetchSourceState,
      videoSourceTuningEnabled,
      videoNeutralEnabledForConfig,
      roiEnabled,
      videoStartMs,
      defaultVideos,
      lastFrame,
    ]
  )

  const syncRemoteStatus = useCallback(async () => {
    try {
      const remote = await fetchTrackingDatasetStatus(apiBaseUrl)
      if (remote?.recording && remote.sessionId) {
        beginTrackingDatasetSession({
          sessionId: remote.sessionId,
          sourceType: remote.sourceType,
          sourceEpoch: remote.sourceEpoch,
          datasetType: remote.datasetType,
          options: optionsRef.current,
        })
        if (remote.frameCount != null) {
          const local = getTrackingDatasetRecorderStatus()
          if (remote.frameCount > local.frameCount) {
            incrementTrackingDatasetFrameCount(remote.frameCount - local.frameCount)
          }
        }
      }
    } catch {
      /* server may be offline */
    }
  }, [apiBaseUrl])

  useEffect(() => {
    if (browserLocalMode) return
    syncRemoteStatus()
    refreshFiles()
  }, [browserLocalMode, syncRemoteStatus, refreshFiles])

  const buildDownloadUrl = useCallback(
    (sessionId, fileKind) => {
      if (browserLocalMode) {
        const url = buildBrowserDatasetDownloadUrl(sessionId, fileKind)
        return url || "#"
      }
      return buildTrackingDatasetDownloadUrl(apiBaseUrl, sessionId, fileKind)
    },
    [apiBaseUrl, browserLocalMode]
  )

  return {
    status,
    files,
    actionError,
    options: optionsRef.current,
    browserLocalMode,
    startRecording,
    stopRecording,
    refreshFiles,
    buildDownloadUrl,
    setOptions: (patch) => {
      optionsRef.current = { ...optionsRef.current, ...patch }
    },
  }
}
