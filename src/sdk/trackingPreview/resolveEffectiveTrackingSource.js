/**
 * 按 Tracking Runtime 选择当前有效 Source（UI / Start gate / Header 高亮）。
 * Browser → browserSourceState；Python → python sourceManager state。
 */

import {
  TRACKING_BACKEND_BROWSER,
  TRACKING_BACKEND_PYTHON,
  normalizeTrackingBackend,
} from "../tracking/browser/browserTrackingConfig.js"
import {
  BROWSER_SOURCE_CAPABILITIES,
  resolveBrowserSourceCapability,
} from "../tracking/browser/browserSourceRuntime.js"
import {
  TRACKING_PREVIEW_TABS,
  TRACKING_SOURCE_SEGMENT_IDS,
} from "./trackingPreviewConstants.js"

/**
 * @typedef {object} EffectiveTrackingSource
 * @property {'browser'|'python'} runtime
 * @property {string} sourceType
 * @property {string} status
 * @property {number} sourceGeneration
 * @property {boolean} previewOnlyForced
 * @property {boolean} videoSourceTuningEnabled
 * @property {boolean} switching
 * @property {string|null} error
 * @property {object} capabilities
 * @property {Record<string, unknown>} raw
 */

/**
 * @param {object} params
 * @param {string} [params.trackingBackend]
 * @param {object|null|undefined} [params.browserSource]
 * @param {object|null|undefined} [params.pythonSource]
 * @returns {EffectiveTrackingSource}
 */
export function resolveEffectiveTrackingSource({
  trackingBackend,
  browserSource = null,
  pythonSource = null,
} = {}) {
  const runtime = normalizeTrackingBackend(trackingBackend)

  if (runtime === TRACKING_BACKEND_BROWSER) {
    const src = browserSource && typeof browserSource === "object" ? browserSource : {}
    return {
      runtime: TRACKING_BACKEND_BROWSER,
      sourceType: src.sourceType === "camera" ? "camera" : "idle",
      status: String(src.status || "idle"),
      sourceGeneration: Number(src.sourceGeneration) || 1,
      previewOnlyForced: false,
      videoSourceTuningEnabled: false,
      switching: false,
      error: src.error != null ? String(src.error) : null,
      capabilities: { ...(src.capabilities || BROWSER_SOURCE_CAPABILITIES) },
      raw: src,
    }
  }

  const py = pythonSource && typeof pythonSource === "object" ? pythonSource : {}
  return {
    runtime: TRACKING_BACKEND_PYTHON,
    sourceType: String(py.sourceType || "idle"),
    status: String(py.status || "idle"),
    sourceGeneration: Number(py.sourceEpoch) || 0,
    previewOnlyForced: Boolean(py.previewOnlyForced),
    videoSourceTuningEnabled: Boolean(py.videoSourceTuningEnabled),
    switching: Boolean(py.switching),
    error: py.error != null ? String(py.error) : null,
    capabilities: {
      camera: true,
      video: true,
      upload: true,
      motionTrack: true,
    },
    raw: py,
  }
}

/**
 * Header Source 分段是否高亮。
 * @param {string} segmentId
 * @param {EffectiveTrackingSource} effective
 * @param {string} activeTab
 */
export function isEffectiveSourceSegmentActive(segmentId, effective, activeTab) {
  if (segmentId === TRACKING_SOURCE_SEGMENT_IDS.MOTION_TRACK) {
    return activeTab === TRACKING_PREVIEW_TABS.MOTION_TRACK
  }
  if (segmentId === TRACKING_SOURCE_SEGMENT_IDS.UPLOAD) {
    return (
      activeTab === TRACKING_PREVIEW_TABS.UPLOAD ||
      effective?.sourceType === "uploaded-video"
    )
  }
  return effective?.sourceType === segmentId
}

/**
 * @param {string} trackingBackend
 * @param {string} segmentId
 */
export function resolveSourceSegmentAvailability(trackingBackend, segmentId) {
  const runtime = normalizeTrackingBackend(trackingBackend)
  if (runtime === TRACKING_BACKEND_BROWSER) {
    return resolveBrowserSourceCapability(segmentId)
  }
  return { allowed: true }
}

/**
 * Browser Camera Start 是否允许（不依赖 Python source / REST）。
 * @param {EffectiveTrackingSource} effective
 * @param {{ trackingEnabled?: boolean }} [opts]
 */
export function canStartBrowserCameraTracking(effective, opts = {}) {
  if (effective?.runtime !== TRACKING_BACKEND_BROWSER) return false
  if (effective.sourceType !== "camera") return false
  if (opts.trackingEnabled) return false
  return true
}
