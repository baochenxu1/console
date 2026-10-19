/**
 * Browser MediaPipe Runtime 配置（Phase 1）。
 * Production 默认 browser；研发可切 python 对照。
 */

export const TRACKING_BACKEND_BROWSER = "browser"
export const TRACKING_BACKEND_PYTHON = "python"

export const TRACKING_BACKEND_STORAGE_KEY = "facedev.trackingBackend.v1"

/** 与 Python FaceLandmarker 对齐的置信度（未在 Python 侧改写阈值时使用 MediaPipe 默认） */
export const BROWSER_FACE_LANDMARKER_OPTIONS = Object.freeze({
  numFaces: 1,
  runningMode: "VIDEO",
  outputFaceBlendshapes: true,
  outputFacialTransformationMatrixes: true,
  minFaceDetectionConfidence: 0.5,
  minFacePresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
})

/** same-origin 静态资源路径（Production / Dev 均可用） */
export const BROWSER_MEDIAPIPE_WASM_BASE = "/assets/mediapipe/wasm"
export const BROWSER_FACE_LANDMARKER_MODEL_URL = "/models/face_landmarker.task"

export function normalizeTrackingBackend(value) {
  const v = String(value || "").trim().toLowerCase()
  if (v === TRACKING_BACKEND_BROWSER || v === "mediapipe-web" || v === "web") {
    return TRACKING_BACKEND_BROWSER
  }
  return TRACKING_BACKEND_PYTHON
}

/**
 * 解析当前 Tracking Backend。
 * 优先级：显式 options → localStorage → import.meta.env → Production 默认 browser / Dev 默认 python
 */
export function resolveTrackingBackend(options = {}) {
  if (options.backend != null) {
    return normalizeTrackingBackend(options.backend)
  }
  try {
    const stored = localStorage.getItem(TRACKING_BACKEND_STORAGE_KEY)
    if (stored) {
      return normalizeTrackingBackend(stored)
    }
  } catch {
    //
  }
  try {
    const env = import.meta?.env?.VITE_TRACKING_BACKEND
    if (env) {
      return normalizeTrackingBackend(env)
    }
  } catch {
    //
  }
  try {
    if (import.meta?.env?.PROD) {
      return TRACKING_BACKEND_BROWSER
    }
  } catch {
    //
  }
  return TRACKING_BACKEND_PYTHON
}

export function persistTrackingBackend(backend) {
  const next = normalizeTrackingBackend(backend)
  try {
    localStorage.setItem(TRACKING_BACKEND_STORAGE_KEY, next)
  } catch {
    //
  }
  return next
}
