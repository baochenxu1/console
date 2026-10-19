import { isVideoTrackingSourceContext, resolveTrackingSourceContext } from "./trackingSourceContext.js"

/** @typedef {'camera' | 'video' | 'replay' | 'idle'} TrackingInputSource */

/** @typedef {HTMLVideoElement | HTMLCanvasElement | ImageBitmap} TrackingFrameImage */

/**
 * @typedef {Object} TrackingInputFrame
 * @property {TrackingInputSource} sourceType
 * @property {string} sourceId
 * @property {number} sourceSeq
 * @property {number} frameIndex
 * @property {number} timestampMs
 * @property {number} [videoTimeMs]
 * @property {number} [playbackRate]
 * @property {boolean} [paused]
 * @property {boolean} [seeking]
 * @property {number} [seekEpoch]
 * @property {TrackingFrameImage} [image] — 浏览器本地 pipeline 使用；WebSocket 路径通常无 image
 */

/**
 * @typedef {Object} TrackingInputSourceDebug
 * @property {TrackingInputSource} sourceType
 * @property {string} sourceId
 * @property {number} sourceSeq
 * @property {number} frameIndex
 * @property {number} timestampMs
 * @property {number | null} [videoTimeMs]
 * @property {number | null} [playbackRate]
 * @property {boolean} [paused]
 * @property {boolean} [seeking]
 * @property {number} [seekEpoch]
 * @property {number} [sourceEpoch]
 */

/**
 * @param {unknown} v
 * @returns {number | null}
 */
function safeNum(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * @param {unknown} raw
 * @returns {TrackingInputSourceDebug | undefined}
 */
export function normalizeInputSource(raw) {
  if (!raw || typeof raw !== "object") {
    return undefined
  }
  const o = /** @type {Record<string, unknown>} */ (raw)
  const sourceType = o.sourceType
  const type =
    sourceType === "camera" ||
    sourceType === "video" ||
    sourceType === "replay" ||
    sourceType === "idle"
      ? sourceType
      : "camera"
  const sourceSeq = safeNum(o.sourceSeq)
  if (sourceSeq == null && type !== "idle") {
    return undefined
  }
  return {
    sourceType: type,
    sourceId: String(o.sourceId || "camera-default"),
    sourceSeq: sourceSeq ?? 0,
    frameIndex: safeNum(o.frameIndex) ?? sourceSeq ?? 0,
    timestampMs: safeNum(o.timestampMs) ?? 0,
    videoTimeMs: o.videoTimeMs != null ? safeNum(o.videoTimeMs) : null,
    playbackRate: o.playbackRate != null ? safeNum(o.playbackRate) : null,
    paused: Boolean(o.paused),
    seeking: Boolean(o.seeking),
    seekEpoch: safeNum(o.seekEpoch) ?? 0,
    sourceEpoch: safeNum(o.sourceEpoch) ?? 0,
    cameraId: o.cameraId != null ? String(o.cameraId) : undefined,
    cameraIndex: o.cameraIndex != null ? safeNum(o.cameraIndex) : undefined,
    cameraLabel: o.cameraLabel != null ? String(o.cameraLabel) : undefined,
    cameraWidth: o.cameraWidth != null ? safeNum(o.cameraWidth) : undefined,
    cameraHeight: o.cameraHeight != null ? safeNum(o.cameraHeight) : undefined,
    cameraFps: o.cameraFps != null ? safeNum(o.cameraFps) : undefined,
  }
}

/**
 * 从 RigFrame debug 或 transport 字段推导 inputSource（兼容 Phase 0 前旧帧）。
 * @param {import("../trackingTypes.js").RigFrame | null | undefined} rigFrame
 * @returns {TrackingInputSourceDebug | undefined}
 */
export function resolveInputSourceFromRigFrame(rigFrame) {
  if (!rigFrame || typeof rigFrame !== "object") {
    return undefined
  }
  const fromDebug = normalizeInputSource(rigFrame.debug?.inputSource)
  if (fromDebug) {
    return fromDebug
  }
  const seq = safeNum(rigFrame.frameSeq)
  if (seq == null) {
    return undefined
  }
  const src = String(rigFrame.source || "")
  const sourceType =
    src.includes("video") ? "video" : src.includes("replay") ? "replay" : "camera"
  return {
    sourceType,
    sourceId: sourceType === "camera" ? "camera-default" : src || "unknown",
    sourceSeq: seq,
    frameIndex: seq,
    timestampMs: safeNum(rigFrame.timestampMs) ?? 0,
    videoTimeMs: null,
    playbackRate: null,
    paused: false,
    seeking: false,
    seekEpoch: 0,
    sourceEpoch: 0,
  }
}

/**
 * @param {import("../trackingTypes.js").RigFrame | null | undefined} rigFrame
 * @returns {boolean}
 */
export function isVideoTrackingInput(rigFrame) {
  return isVideoTrackingSourceContext(rigFrame)
}

export { resolveTrackingSourceContext, isVideoTrackingSourceContext } from "./trackingSourceContext.js"
