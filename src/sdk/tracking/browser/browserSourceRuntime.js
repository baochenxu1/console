/**
 * Browser Tracking Source Runtime — 纯前端 Source 状态（不依赖 Python REST）。
 * Browser 正式支持：idle | camera
 */

/** @typedef {'idle' | 'camera'} BrowserSourceType */

/**
 * @typedef {object} BrowserSourceState
 * @property {BrowserSourceType} sourceType
 * @property {'idle'|'ready'|'running'|'error'} status
 * @property {boolean} cameraReady
 * @property {boolean} trackingEnabled
 * @property {number} sourceGeneration
 * @property {string|null} error
 * @property {{ camera: true, video: false, upload: false, motionTrack: true }} capabilities
 */

export const BROWSER_SOURCE_CAPABILITIES = Object.freeze({
  camera: true,
  video: false,
  upload: false,
  motionTrack: true,
})

export const BROWSER_VIDEO_UNSUPPORTED_HINT =
  "浏览器运行模式暂未支持视频源，请切换 Python Runtime。"

export const BROWSER_UPLOAD_UNSUPPORTED_HINT =
  "浏览器运行模式暂未支持上传视频，请切换 Python Runtime。"

/**
 * @param {Partial<BrowserSourceState>} [overrides]
 * @returns {BrowserSourceState}
 */
export function createBrowserSourceState(overrides = {}) {
  return {
    sourceType: "idle",
    status: "idle",
    cameraReady: false,
    trackingEnabled: false,
    sourceGeneration: 1,
    error: null,
    capabilities: { ...BROWSER_SOURCE_CAPABILITIES },
    ...overrides,
  }
}

/**
 * @param {BrowserSourceState} state
 * @returns {BrowserSourceState}
 */
export function bumpBrowserSourceGeneration(state) {
  return {
    ...state,
    sourceGeneration: Math.max(1, Number(state.sourceGeneration) || 1) + 1,
  }
}

/**
 * @param {BrowserSourceState} state
 * @returns {BrowserSourceState}
 */
export function selectBrowserIdle(state) {
  const next = bumpBrowserSourceGeneration(state)
  return {
    ...next,
    sourceType: "idle",
    status: "idle",
    cameraReady: false,
    trackingEnabled: false,
    error: null,
  }
}

/**
 * @param {BrowserSourceState} state
 * @returns {BrowserSourceState}
 */
export function selectBrowserCamera(state) {
  return {
    ...state,
    sourceType: "camera",
    status: state.trackingEnabled ? "running" : "ready",
    cameraReady: true,
    error: null,
  }
}

/**
 * @param {BrowserSourceState} state
 * @returns {BrowserSourceState}
 */
export function markBrowserTrackingStarted(state) {
  return {
    ...state,
    sourceType: "camera",
    status: "running",
    cameraReady: true,
    trackingEnabled: true,
    error: null,
  }
}

/**
 * @param {BrowserSourceState} state
 * @param {{ keepCameraSource?: boolean }} [options]
 * @returns {BrowserSourceState}
 */
export function markBrowserTrackingStopped(state, options = {}) {
  const keepCamera = options.keepCameraSource !== false
  const next = bumpBrowserSourceGeneration(state)
  if (!keepCamera) {
    return selectBrowserIdle(state)
  }
  return {
    ...next,
    sourceType: "camera",
    status: "ready",
    cameraReady: true,
    trackingEnabled: false,
    error: null,
  }
}

/**
 * @param {BrowserSourceState} state
 * @param {string} message
 * @returns {BrowserSourceState}
 */
export function markBrowserSourceError(state, message) {
  return {
    ...state,
    status: "error",
    trackingEnabled: false,
    error: String(message || "browser-source-error"),
  }
}

/**
 * @param {string} segmentId
 * @returns {{ allowed: boolean, hint?: string }}
 */
export function resolveBrowserSourceCapability(segmentId) {
  const id = String(segmentId || "")
  if (id === "idle" || id === "camera" || id === "motion-track") {
    return { allowed: true }
  }
  if (id === "video") {
    return { allowed: false, hint: BROWSER_VIDEO_UNSUPPORTED_HINT }
  }
  if (id === "upload") {
    return { allowed: false, hint: BROWSER_UPLOAD_UNSUPPORTED_HINT }
  }
  return { allowed: false, hint: "浏览器运行模式不支持该输入源。" }
}

/**
 * Browser-local generation check（映射到 inputSource.sourceGeneration / sourceEpoch）。
 * @param {number} expectedGeneration
 * @param {import('../trackingTypes.js').RigFrame | null | undefined} frame
 */
export function isBrowserFrameGenerationValid(expectedGeneration, frame) {
  const expected = Number(expectedGeneration)
  if (!Number.isFinite(expected) || expected <= 0) return true
  const src = frame?.debug?.inputSource
  const gen =
    Number(src?.sourceGeneration) ||
    Number(src?.sourceEpoch) ||
    0
  if (!Number.isFinite(gen) || gen <= 0) return true
  return gen === expected
}
