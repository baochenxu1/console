/**
 * MediaPipe FaceLandmarker Worker（@mediapipe/tasks-vision 1.x module Worker 路线）。
 *
 * 对照 Google mediapipe-samples-web：
 *   - import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision"
 *   - FilesetResolver.forVisionTasks(wasmPath, true)  // useModule → vision_wasm_module_internal
 *   - modelAssetBuffer（fetch .task）而非仅依赖 modelAssetPath
 *   - GPU 失败回退 CPU
 *
 * 消息协议：
 *   main → worker: { type: "init", wasmBase, modelUrl, options }
 *                 { type: "detect", requestId, bitmap, timestampMs }
 *                 { type: "dispose" }
 *   worker → main: { type: "ready", delegate } | { type: "result", ... }
 *                 | { type: "error", code, name, message, stack }
 */

import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision"
import {
  BROWSER_FACE_LANDMARKER_OPTIONS,
  BROWSER_FACE_LANDMARKER_MODEL_URL,
  BROWSER_MEDIAPIPE_WASM_BASE,
} from "./browserTrackingConfig.js"

let landmarker = null
let lastTimestamp = -1
let initPromise = null
let activeDelegate = "GPU"

function originBase() {
  try {
    return self.location?.origin || ""
  } catch {
    return ""
  }
}

function toAbsoluteUrl(pathOrUrl) {
  const raw = String(pathOrUrl || "").trim()
  if (!raw) return raw
  if (/^https?:\/\//i.test(raw) || raw.startsWith("blob:")) return raw
  const origin = originBase()
  if (origin) {
    return new URL(raw.startsWith("/") ? raw : `/${raw}`, origin).href
  }
  return raw
}

function normalizeWasmBase(base) {
  const abs = toAbsoluteUrl(base || BROWSER_MEDIAPIPE_WASM_BASE)
  return abs.replace(/\/$/, "")
}

function classifyError(error, phase = "init") {
  const message = String(error?.message || error || "")
  if (/importScripts/i.test(message)) {
    return "WORKER_INIT_ERROR"
  }
  if (phase === "detect" || /detectForVideo|detect\(/i.test(message)) {
    return "INFERENCE_ERROR"
  }
  if (/model|face_landmarker|\.task|MODEL_LOAD/i.test(message)) {
    return "MODEL_LOAD_ERROR"
  }
  if (/wasm|WebAssembly|FilesetResolver|forVisionTasks|Failed to fetch/i.test(message)) {
    return "WASM_LOAD_ERROR"
  }
  return phase === "detect" ? "INFERENCE_ERROR" : "WORKER_INIT_ERROR"
}

function serializeError(error, phase = "init") {
  const name = error?.name != null ? String(error.name) : "Error"
  const message = error?.message != null ? String(error.message) : String(error)
  const stack = error?.stack != null ? String(error.stack) : ""
  return {
    type: "error",
    code: classifyError(error, phase),
    name,
    message,
    stack,
    phase,
  }
}

async function loadModelBuffer(modelUrl) {
  const url = toAbsoluteUrl(modelUrl || BROWSER_FACE_LANDMARKER_MODEL_URL)
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`MODEL_LOAD_ERROR: Failed to load model (${res.status} ${res.statusText}): ${url}`)
  }
  const buf = await res.arrayBuffer()
  if (!buf || buf.byteLength < 1024) {
    throw new Error(`MODEL_LOAD_ERROR: model buffer too small (${buf?.byteLength ?? 0}): ${url}`)
  }
  return new Uint8Array(buf)
}

async function createLandmarker(vision, modelBuffer, opts, delegate) {
  return FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetBuffer: modelBuffer,
      delegate,
    },
    runningMode: "VIDEO",
    numFaces: opts.numFaces ?? 1,
    outputFaceBlendshapes: opts.outputFaceBlendshapes !== false,
    outputFacialTransformationMatrixes: opts.outputFacialTransformationMatrixes !== false,
    minFaceDetectionConfidence: opts.minFaceDetectionConfidence ?? 0.5,
    minFacePresenceConfidence: opts.minFacePresenceConfidence ?? 0.5,
    minTrackingConfidence: opts.minTrackingConfidence ?? 0.5,
  })
}

async function ensureLandmarker(payload = {}) {
  if (landmarker) {
    return landmarker
  }
  if (initPromise) {
    return initPromise
  }
  initPromise = (async () => {
    const wasmBase = normalizeWasmBase(payload.wasmBase || BROWSER_MEDIAPIPE_WASM_BASE)
    const modelUrl = String(payload.modelUrl || BROWSER_FACE_LANDMARKER_MODEL_URL)
    const opts = { ...BROWSER_FACE_LANDMARKER_OPTIONS, ...(payload.options || {}) }

    // useModule=true → vision_wasm_module_internal.*（module Worker 必需，避免 importScripts）
    const vision = await FilesetResolver.forVisionTasks(wasmBase, true)
    const modelBuffer = await loadModelBuffer(modelUrl)

    let delegate = "GPU"
    try {
      landmarker = await createLandmarker(vision, modelBuffer, opts, delegate)
    } catch (gpuError) {
      console.warn("[browserFaceLandmarkerWorker] GPU init failed, falling back to CPU:", gpuError)
      delegate = "CPU"
      landmarker = await createLandmarker(vision, modelBuffer, opts, delegate)
    }
    activeDelegate = delegate
    return landmarker
  })()
  try {
    return await initPromise
  } catch (error) {
    initPromise = null
    landmarker = null
    throw error
  }
}

function serializeResult(result) {
  if (!result) {
    return {
      faceLandmarks: [],
      faceBlendshapes: [],
      facialTransformationMatrixes: [],
    }
  }

  const faceLandmarks = (result.faceLandmarks || []).map((face) =>
    (face || []).map((p) => ({
      x: p.x,
      y: p.y,
      z: p.z,
    }))
  )

  const faceBlendshapes = (result.faceBlendshapes || []).map((set) => ({
    categories: (set.categories || []).map((c) => ({
      categoryName: c.categoryName,
      displayName: c.displayName,
      score: c.score,
      index: c.index,
    })),
  }))

  const facialTransformationMatrixes = (result.facialTransformationMatrixes || []).map((m) => {
    const data = m?.data ?? m
    if (data instanceof Float32Array) {
      return { data: Array.from(data) }
    }
    if (Array.isArray(data)) {
      return { data: data.slice(0, 16) }
    }
    return { data: [] }
  })

  return {
    faceLandmarks,
    faceBlendshapes,
    facialTransformationMatrixes,
  }
}

self.onmessage = async (event) => {
  const msg = event.data || {}
  try {
    if (msg.type === "init") {
      await ensureLandmarker(msg)
      self.postMessage({
        type: "ready",
        delegate: activeDelegate,
        tasksVisionRoute: "module-worker-1.x",
      })
      return
    }

    if (msg.type === "dispose") {
      try {
        landmarker?.close?.()
      } catch {
        //
      }
      landmarker = null
      initPromise = null
      lastTimestamp = -1
      self.postMessage({ type: "disposed" })
      return
    }

    if (msg.type === "detect") {
      const lm = await ensureLandmarker()
      let timestampMs = Number(msg.timestampMs)
      if (!Number.isFinite(timestampMs)) {
        timestampMs = lastTimestamp + 1
      }
      if (timestampMs <= lastTimestamp) {
        timestampMs = lastTimestamp + 1
      }
      lastTimestamp = timestampMs

      const inferenceStart = performance.now()
      const result = lm.detectForVideo(msg.bitmap, timestampMs)
      const inferenceEnd = performance.now()

      try {
        msg.bitmap?.close?.()
      } catch {
        //
      }

      self.postMessage({
        type: "result",
        requestId: msg.requestId,
        captureTimestamp: msg.captureTimestamp ?? timestampMs,
        timestampMs,
        inferenceStart,
        inferenceEnd,
        result: serializeResult(result),
      })
      return
    }
  } catch (error) {
    try {
      msg.bitmap?.close?.()
    } catch {
      //
    }
    const phase = msg.type === "detect" ? "detect" : "init"
    const payload = serializeError(error, phase)
    payload.requestId = msg.requestId
    // 开发态定位：完整 name / message / stack
    console.error("[browserFaceLandmarkerWorker]", payload.code, payload.name, payload.message, payload.stack)
    self.postMessage(payload)
  }
}
