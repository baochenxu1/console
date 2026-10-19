/**
 * Browser Face Landmarker Provider — TrackingAdapter 兼容实现。
 * Camera/Video → Worker detectForVideo → normalizer → tracking.rigFrame
 */

import {
  BROWSER_FACE_LANDMARKER_MODEL_URL,
  BROWSER_FACE_LANDMARKER_OPTIONS,
  BROWSER_MEDIAPIPE_WASM_BASE,
} from "./browserTrackingConfig.js"
import { normalizeBrowserFaceLandmarkerResult } from "./browserTrackingNormalizer.js"
import { createTrackingSemanticRuntime } from "../core/trackingSemanticCore.js"
import {
  createLatestFrameGate,
  createMonotonicTimestampGuard,
} from "./latestFrameGate.js"
import {
  CAMERA_COORDINATE_CONVENTION,
  createBrowserInferenceImageBitmap,
} from "./browserCameraCoordinateConvention.js"
import BrowserFaceLandmarkerWorker from "./browserFaceLandmarkerWorker.js?worker"

const LIFECYCLE = Object.freeze({
  IDLE: "IDLE",
  LOADING_RUNTIME: "LOADING_RUNTIME",
  LOADING_MODEL: "LOADING_MODEL",
  READY: "READY",
  RUNNING: "RUNNING",
  ERROR: "ERROR",
  STOPPED: "STOPPED",
})

function nowPerf() {
  return typeof performance !== "undefined" ? performance.now() : Date.now()
}

/**
 * @param {object} [options]
 * @returns {import("../trackingTypes.js").TrackingAdapter & {
 *   setVideoElement: Function,
 *   getMetrics: Function,
 *   getLifecycle: Function,
 *   attachLocalStream: Function,
 *   stopLocalStream: Function,
 * }}
 */
export function createBrowserTrackingAdapter(options = {}) {
  /** @type {Set<(frame: import("../trackingTypes.js").RigFrame) => void>} */
  const listeners = new Set()

  let disposed = false
  let running = false
  let lifecycle = LIFECYCLE.IDLE
  /** @type {string | null} */
  let statusError = null
  /** @type {string | null} */
  let modelErrorCode = null
  /** @type {string | null} */
  let modelErrorName = null
  /** @type {string | null} */
  let modelErrorMessage = null
  /** @type {string | null} */
  let modelErrorStack = null
  /** @type {Worker | null} */
  let worker = null
  /** Worker 已完成 init（ready）；Stop 后仍为 true，仅 dispose 时清除 */
  let workerReady = false
  /** @type {HTMLVideoElement | null} */
  let videoEl = null
  /** @type {MediaStream | null} */
  let ownedStream = null
  let rafId = 0
  let frameSeq = 0
  let requestId = 0
  let lastFrameAt = 0
  let lastEmittedFaceDetected = false
  let lastEmittedQuality = 0
  /** Browser-local source generation；切 Idle / Start / Stop / Runtime 时递增，丢弃过期 Worker 回调 */
  let sourceGeneration = 1

  const gate = createLatestFrameGate()
  const tsGuard = createMonotonicTimestampGuard(0)
  const semanticRuntime = createTrackingSemanticRuntime({
    config: options.semanticConfig,
    calibration: options.calibration,
  })

  /** @type {object} */
  const metrics = {
    cameraFps: 0,
    inferenceFps: 0,
    inferenceMsLatest: 0,
    inferenceMsAvg: 0,
    captureToResultMs: 0,
    semanticComputeMs: 0,
    captureToRigMs: 0,
    droppedFrames: 0,
    capturedFrames: 0,
    inferredFrames: 0,
    resultCount: 0,
    workerEnabled: true,
    mainThreadFallback: false,
    inferenceFlipHorizontal: CAMERA_COORDINATE_CONVENTION.browserInferenceFlipHorizontal,
    previewCssMirror: CAMERA_COORDINATE_CONVENTION.browserPreviewCssMirror,
    cameraCoordinateConvention: CAMERA_COORDINATE_CONVENTION.id,
    lastTimestampDeltaMs: null,
  }

  /** @type {object | null} */
  let lastLiveSample = null
  let liveSampleLogCount = 0
  let lastSemanticTimestampMs = 0

  let inferenceMsSum = 0
  let inferenceMsN = 0
  let camWindowStart = nowPerf()
  let camWindowCount = 0
  let infWindowStart = nowPerf()
  let infWindowCount = 0

  const wasmBase = options.wasmBase || BROWSER_MEDIAPIPE_WASM_BASE
  const modelUrl = options.modelUrl || BROWSER_FACE_LANDMARKER_MODEL_URL
  const landmarkerOptions = { ...BROWSER_FACE_LANDMARKER_OPTIONS, ...(options.landmarkerOptions || {}) }

  function bumpSourceGeneration(reason = "bump") {
    sourceGeneration += 1
    gate.reset()
    tsGuard.reset(0)
    void reason
    return sourceGeneration
  }

  function clearModelError() {
    modelErrorCode = null
    modelErrorName = null
    modelErrorMessage = null
    modelErrorStack = null
    statusError = null
  }

  function setModelError(payload = {}) {
    modelErrorCode = payload.code != null ? String(payload.code) : "WORKER_INIT_ERROR"
    modelErrorName = payload.name != null ? String(payload.name) : "Error"
    modelErrorMessage =
      payload.message != null
        ? String(payload.message)
        : payload.error != null
          ? String(payload.error)
          : "Browser FaceLandmarker error"
    modelErrorStack = payload.stack != null ? String(payload.stack) : null
    statusError = modelErrorMessage
  }

  function setLifecycle(next, errorPayload = null) {
    lifecycle = next
    if (errorPayload) {
      if (typeof errorPayload === "string") {
        setModelError({ message: errorPayload })
      } else {
        setModelError(errorPayload)
      }
    } else if (next !== LIFECYCLE.ERROR) {
      clearModelError()
    }
  }

  function emitFrame(frame) {
    const frameGen =
      Number(frame?.debug?.inputSource?.sourceGeneration) ||
      Number(frame?.debug?.inputSource?.sourceEpoch) ||
      0
    if (Number.isFinite(frameGen) && frameGen > 0 && frameGen !== sourceGeneration) {
      metrics.droppedFrames += 1
      return
    }
    lastFrameAt = nowPerf()
    lastEmittedFaceDetected = Boolean(frame?.faceDetected)
    lastEmittedQuality = Number(frame?.quality) || 0
    metrics.resultCount += 1
    for (const cb of listeners) {
      try {
        cb(frame)
      } catch {
        //
      }
    }
  }

  function refreshWindowFps() {
    const now = nowPerf()
    const camDt = now - camWindowStart
    if (camDt >= 500) {
      metrics.cameraFps = Math.round((camWindowCount / camDt) * 1000)
      camWindowCount = 0
      camWindowStart = now
    }
    const infDt = now - infWindowStart
    if (infDt >= 500) {
      metrics.inferenceFps = Math.round((infWindowCount / infDt) * 1000)
      infWindowCount = 0
      infWindowStart = now
    }
    const stats = gate.getStats()
    metrics.droppedFrames = stats.droppedFrames
    metrics.capturedFrames = stats.capturedFrames
    metrics.inferredFrames = stats.inferredFrames
  }

  function ensureWorker() {
    if (worker) return worker
    setLifecycle(LIFECYCLE.LOADING_RUNTIME)
    worker = new BrowserFaceLandmarkerWorker()
    worker.onmessage = (event) => {
      const msg = event.data || {}
      if (msg.type === "ready") {
        workerReady = true
        setLifecycle(running ? LIFECYCLE.RUNNING : LIFECYCLE.READY)
        return
      }
      if (msg.type === "error") {
        setLifecycle(LIFECYCLE.ERROR, {
          code: msg.code || "WORKER_INIT_ERROR",
          name: msg.name || "Error",
          message: msg.message || "Browser FaceLandmarker error",
          stack: msg.stack || null,
        })
        console.error(
          "[browserFaceLandmarkerProvider] model error",
          modelErrorCode,
          modelErrorName,
          modelErrorMessage,
          modelErrorStack
        )
        gate.endInference()
        return
      }
      if (msg.type === "result") {
        const inferenceMs = Math.max(0, Number(msg.inferenceEnd) - Number(msg.inferenceStart))
        metrics.inferenceMsLatest = inferenceMs
        inferenceMsSum += inferenceMs
        inferenceMsN += 1
        metrics.inferenceMsAvg = inferenceMsN > 0 ? inferenceMsSum / inferenceMsN : 0
        infWindowCount += 1

        const resultTimestamp = nowPerf()
        metrics.captureToResultMs = Math.max(
          0,
          resultTimestamp - (Number(msg.captureTimestamp) || resultTimestamp)
        )

        const frame = normalizeBrowserFaceLandmarkerResult(msg.result, {
          captureTimestamp: msg.captureTimestamp,
          inferenceStart: msg.inferenceStart,
          inferenceEnd: msg.inferenceEnd,
          resultTimestamp,
          frameSeq: (frameSeq += 1),
          videoWidth: videoEl?.videoWidth ?? null,
          videoHeight: videoEl?.videoHeight ?? null,
          previewCssMirror: CAMERA_COORDINATE_CONVENTION.browserPreviewCssMirror,
          inferenceFlipHorizontal: CAMERA_COORDINATE_CONVENTION.browserInferenceFlipHorizontal,
          inputSource: {
            sourceType: "camera",
            sourceId: "browser-mediapipe",
            runtime: "browser",
            sourceGeneration,
            sourceEpoch: sourceGeneration,
            sourceSeq: frameSeq + 1,
            frameIndex: frameSeq + 1,
            timestampMs: Number(msg.captureTimestamp) || resultTimestamp,
            cameraCoordinateConvention: CAMERA_COORDINATE_CONVENTION.id,
            inferenceFlipHorizontal: CAMERA_COORDINATE_CONVENTION.browserInferenceFlipHorizontal,
            previewCssMirror: CAMERA_COORDINATE_CONVENTION.browserPreviewCssMirror,
          },
          semanticRuntime,
        })
        metrics.semanticComputeMs = Number(frame?.debug?.performance?.semanticComputeMs) || 0
        metrics.captureToRigMs = Number(frame?.debug?.performance?.captureToRigMs) || 0
        lastLiveSample = frame?.debug?.browserLiveSample || null
        const ts = Number(frame?.timestampMs) || 0
        if (ts > 0) {
          metrics.lastTimestampDeltaMs =
            lastSemanticTimestampMs > 0 ? Math.max(0, ts - lastSemanticTimestampMs) : null
          lastSemanticTimestampMs = ts
        }
        liveSampleLogCount += 1
        if (liveSampleLogCount === 1 || liveSampleLogCount % 60 === 0) {
          try {
            console.debug("[browserLiveObservation]", lastLiveSample, frame?.debug?.browserSemanticPeek)
          } catch {
            //
          }
        }
        emitFrame(frame)

        const pending = gate.endInference()
        refreshWindowFps()
        if (pending && running && !disposed) {
          void processPending(pending)
        }
      }
    }
    worker.onerror = (err) => {
      setLifecycle(LIFECYCLE.ERROR, {
        code: "WORKER_INIT_ERROR",
        name: "WorkerError",
        message: err?.message || "Worker error",
        stack: err?.filename
          ? `${err.filename}:${err.lineno || 0}:${err.colno || 0}`
          : null,
      })
      console.error(
        "[browserFaceLandmarkerProvider] worker.onerror",
        modelErrorCode,
        modelErrorMessage,
        modelErrorStack
      )
    }
    setLifecycle(LIFECYCLE.LOADING_MODEL)
    worker.postMessage({
      type: "init",
      wasmBase,
      modelUrl,
      options: landmarkerOptions,
    })
    return worker
  }

  async function processPending(pending) {
    if (!pending || !running || disposed) return
    const offer = gate.offer(pending)
    if (gate.isBusy()) {
      return
    }
    if (offer === "accepted" || !gate.isBusy()) {
      await inferBitmap(pending)
    }
  }

  async function inferBitmap(payload) {
    if (!worker || disposed || !running) return
    gate.beginInference()
    const captureTimestamp = Number(payload.captureTimestamp) || nowPerf()
    const timestampMs = tsGuard.next(payload.timestampMs ?? captureTimestamp)
    requestId += 1
    try {
      worker.postMessage(
        {
          type: "detect",
          requestId,
          bitmap: payload.bitmap,
          timestampMs,
          captureTimestamp,
        },
        [payload.bitmap]
      )
    } catch (error) {
      gate.endInference()
      try {
        payload.bitmap?.close?.()
      } catch {
        //
      }
      setLifecycle(LIFECYCLE.ERROR, {
        code: "INFERENCE_ERROR",
        name: error?.name || "Error",
        message: error?.message || String(error),
        stack: error?.stack || null,
      })
    }
  }

  async function captureLoop() {
    if (!running || disposed) return
    rafId = requestAnimationFrame(captureLoop)
    refreshWindowFps()

    const video = videoEl
    if (!video || video.readyState < 2) {
      return
    }

    camWindowCount += 1
    const captureTimestamp = nowPerf()

    let bitmap
    try {
      // 对齐 Python Camera：推理前水平翻转（CSS preview mirror 不改变像素）
      bitmap = await createBrowserInferenceImageBitmap(video, {
        flipHorizontal: CAMERA_COORDINATE_CONVENTION.browserInferenceFlipHorizontal,
      })
    } catch {
      return
    }

    const payload = {
      bitmap,
      captureTimestamp,
      timestampMs: captureTimestamp,
      videoWidth: video.videoWidth || null,
      videoHeight: video.videoHeight || null,
    }

    if (gate.isBusy()) {
      const prev = gate.peekPending()
      gate.offer(payload)
      // close superseded pending bitmap
      if (prev?.bitmap && prev.bitmap !== payload.bitmap) {
        try {
          prev.bitmap.close()
        } catch {
          //
        }
      }
      return
    }

    gate.offer(payload)
    await inferBitmap(payload)
  }

  function stopCaptureLoop() {
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
  }

  function stopLocalStream() {
    if (ownedStream) {
      for (const track of ownedStream.getTracks()) {
        try {
          track.stop()
        } catch {
          //
        }
      }
      ownedStream = null
    }
    if (videoEl && videoEl.srcObject) {
      videoEl.srcObject = null
    }
  }

  async function attachLocalStream(constraints = { video: true, audio: false }) {
    stopLocalStream()
    bumpSourceGeneration("attachLocalStream")
    if (!navigator?.mediaDevices?.getUserMedia) {
      throw new Error("browser unsupported: mediaDevices.getUserMedia missing")
    }
    ownedStream = await navigator.mediaDevices.getUserMedia(constraints)
    if (videoEl) {
      videoEl.srcObject = ownedStream
      await videoEl.play?.().catch(() => {})
    }
    return ownedStream
  }

  const adapter = {
    start() {
      if (disposed) return
      ensureWorker()
      running = true
      if (lifecycle === LIFECYCLE.ERROR) {
        // 保留 ERROR，等待用户重试或切换 backend
      } else if (workerReady) {
        setLifecycle(LIFECYCLE.RUNNING)
      } else if (lifecycle !== LIFECYCLE.LOADING_RUNTIME && lifecycle !== LIFECYCLE.LOADING_MODEL) {
        setLifecycle(LIFECYCLE.LOADING_MODEL)
      }
      stopCaptureLoop()
      rafId = requestAnimationFrame(captureLoop)
    },

    stop() {
      running = false
      stopCaptureLoop()
      bumpSourceGeneration("stop")
      gate.reset()
      setLifecycle(LIFECYCLE.STOPPED)
    },

    dispose() {
      disposed = true
      running = false
      stopCaptureLoop()
      stopLocalStream()
      bumpSourceGeneration("dispose")
      listeners.clear()
      gate.reset()
      if (worker) {
        try {
          worker.postMessage({ type: "dispose" })
        } catch {
          //
        }
        try {
          worker.terminate()
        } catch {
          //
        }
        worker = null
      }
      workerReady = false
      setLifecycle(LIFECYCLE.IDLE)
    },

    isRunning() {
      return running
    },

    onFrame(cb) {
      if (typeof cb === "function") listeners.add(cb)
    },

    offFrame(cb) {
      listeners.delete(cb)
    },

    getStatus() {
      refreshWindowFps()
      return {
        running,
        source: "mediapipe-web",
        faceDetected: lastEmittedFaceDetected,
        fps: metrics.inferenceFps,
        rxFps: metrics.inferenceFps,
        quality: lastEmittedQuality,
        lastFrameAt,
        error: statusError,
        modelErrorCode,
        modelErrorName,
        modelErrorMessage,
        modelErrorStack,
        wsOpen: false,
        wsConnecting: false,
        lifecycle,
        sourceGeneration,
        browserMetrics: { ...metrics },
        lastLiveSample,
        cameraCoordinateConvention: CAMERA_COORDINATE_CONVENTION.id,
      }
    },

    clearState() {
      lastEmittedFaceDetected = false
      lastEmittedQuality = 0
      frameSeq = 0
      lastLiveSample = null
      liveSampleLogCount = 0
      lastSemanticTimestampMs = 0
      bumpSourceGeneration("clearState")
      gate.reset()
      tsGuard.reset(0)
      semanticRuntime.reset()
    },

    bumpSourceGeneration,
    getSourceGeneration() {
      return sourceGeneration
    },

    setVideoElement(el) {
      videoEl = el || null
      if (videoEl && ownedStream) {
        videoEl.srcObject = ownedStream
      }
    },

    attachLocalStream,
    stopLocalStream,

    getMetrics() {
      refreshWindowFps()
      return {
        ...metrics,
        lifecycle,
        error: statusError,
        modelErrorCode,
        modelErrorName,
        modelErrorMessage,
        modelErrorStack,
        sourceGeneration,
        lastLiveSample,
        cameraCoordinateConvention: CAMERA_COORDINATE_CONVENTION,
      }
    },

    getLifecycle() {
      return lifecycle
    },

    /** 预加载 WASM/Model（不开始 capture） */
    async preload() {
      ensureWorker()
      return new Promise((resolve, reject) => {
        const start = nowPerf()
        const timer = setInterval(() => {
          if (lifecycle === LIFECYCLE.READY || lifecycle === LIFECYCLE.RUNNING) {
            clearInterval(timer)
            resolve(true)
          } else if (lifecycle === LIFECYCLE.ERROR) {
            clearInterval(timer)
            reject(new Error(statusError || "preload failed"))
          } else if (nowPerf() - start > 60000) {
            clearInterval(timer)
            reject(new Error("preload timeout"))
          }
        }, 50)
      })
    },
  }

  return adapter
}

export { LIFECYCLE as BROWSER_TRACKING_LIFECYCLE }
