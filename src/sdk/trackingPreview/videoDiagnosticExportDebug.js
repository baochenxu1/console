/**
 * Phase 2.0 — video diagnostic export 链路调试（首帧/导出各打一次，不刷屏）。
 * 浏览器内默认 DEV 开启；可手动设 window.__DEBUG_VIDEO_DIAGNOSTIC_EXPORT = true
 */
export const DEBUG_VIDEO_DIAGNOSTIC_EXPORT =
  typeof import.meta !== "undefined" && import.meta.env?.DEV
    ? true
    : typeof globalThis !== "undefined" &&
        Boolean(globalThis.__DEBUG_VIDEO_DIAGNOSTIC_EXPORT)

const flags = {
  python: false,
  wsReceived: false,
  mapped: false,
  capture: false,
  compactBuilt: false,
  export: false,
}

/** @type {Map<number, object>} */
const wireTrackingDebugBySourceSeq = new Map()

/** @type {object | null} */
let latestWireTrackingDebug = null

export function isVideoDiagnosticExportDebugEnabled() {
  if (typeof globalThis !== "undefined" && globalThis.__DEBUG_VIDEO_DIAGNOSTIC_EXPORT != null) {
    return Boolean(globalThis.__DEBUG_VIDEO_DIAGNOSTIC_EXPORT)
  }
  return DEBUG_VIDEO_DIAGNOSTIC_EXPORT
}

function logOnce(tag, key, message, extra) {
  if (!isVideoDiagnosticExportDebugEnabled()) return
  if (flags[key]) return
  flags[key] = true
  const suffix = extra != null ? ` ${JSON.stringify(extra)}` : ""
  console.info(`[video-debug] ${tag} ${message}${suffix}`)
}

/** WebSocket / mapper 收到帧后登记 wire trackingDebug（按 sourceSeq 缓存）。 */
export function registerWireTrackingDebug(trackingDebug, sourceSeq = null) {
  if (!trackingDebug || typeof trackingDebug !== "object") {
    return
  }
  latestWireTrackingDebug = trackingDebug
  if (sourceSeq != null && Number.isFinite(Number(sourceSeq))) {
    wireTrackingDebugBySourceSeq.set(Number(sourceSeq), trackingDebug)
  }
}

/** 原始 WS JSON（normalize 前）登记 trackingDebug。 */
export function registerWireTrackingDebugFromPayload(data) {
  if (!data || typeof data !== "object") {
    return
  }
  const td = data.debug?.trackingDebug
  if (!td || typeof td !== "object") {
    return
  }
  const src = data.debug?.inputSource
  const seq = src?.sourceSeq ?? data.frameSeq ?? null
  registerWireTrackingDebug(td, seq)
}

export function noteWireTrackingFrame(rigFrame) {
  if (!rigFrame || typeof rigFrame !== "object") return
  const td = rigFrame.debug?.trackingDebug
  if (!td || typeof td !== "object") return
  const src = rigFrame.debug?.inputSource
  const seq = src?.sourceSeq ?? rigFrame.frameSeq
  registerWireTrackingDebug(td, seq)
}

export function peekWireTrackingDebugForSeq(sourceSeq = null) {
  if (sourceSeq != null && wireTrackingDebugBySourceSeq.has(Number(sourceSeq))) {
    return wireTrackingDebugBySourceSeq.get(Number(sourceSeq))
  }
  return latestWireTrackingDebug
}

export function resolveWireTrackingDebug(lastFrame, sourceSeq = null) {
  const fromFrame = lastFrame?.debug?.trackingDebug ?? lastFrame?.trackingDebug ?? null
  if (fromFrame && typeof fromFrame === "object") {
    return fromFrame
  }
  const seq =
    sourceSeq ??
    lastFrame?.debug?.inputSource?.sourceSeq ??
    lastFrame?.frameSeq ??
    null
  if (seq != null && wireTrackingDebugBySourceSeq.has(Number(seq))) {
    return wireTrackingDebugBySourceSeq.get(Number(seq))
  }
  return peekWireTrackingDebugForSeq(seq)
}

export function logPythonWsPayload(d) {
  if (!isVideoDiagnosticExportDebugEnabled()) return
  const dbg = d?.debug
  const td = dbg?.trackingDebug
  const isVideo = dbg?.inputSource?.sourceType === "video"
  if (!isVideo) return
  logOnce("python", "python", "ws payload debug.trackingDebug exists:", Boolean(td))
  if (!td) return
  logOnce("python", "pythonKeys", "selectedLandmarks keys:", Object.keys(td.selectedLandmarks || {}))
  logOnce("python", "pythonFaceBox", "faceBox exists:", Boolean(td.faceBox))
  logOnce(
    "python",
    "pythonMesh",
    "allLandmarks count:",
    Array.isArray(td.allLandmarks) ? td.allLandmarks.length : 0
  )
}

export function logWsReceivedFrame(rigFrame) {
  if (!isVideoDiagnosticExportDebugEnabled()) return
  const td = rigFrame?.debug?.trackingDebug
  const isVideo = rigFrame?.debug?.inputSource?.sourceType === "video"
  if (!isVideo && !td) return
  logOnce("receive", "wsReceived", "received debug.trackingDebug exists:", Boolean(td))
  if (td?.selectedLandmarks?.noseTip) {
    logOnce(
      "receive",
      "wsNose",
      "received selectedLandmarks.noseTip.px:",
      td.selectedLandmarks.noseTip.px
    )
  }
  if (td?.faceBox) {
    logOnce("receive", "wsFaceBox", "received faceBox.centerXPx:", td.faceBox.centerXPx)
  }
}

export function logMappedFrame(rigFrame) {
  if (!isVideoDiagnosticExportDebugEnabled()) return
  const td = rigFrame?.debug?.trackingDebug
  const isVideo = rigFrame?.debug?.inputSource?.sourceType === "video"
  if (!isVideo && !td) return
  logOnce("mapper", "mapped", "mappedFrame.debug.trackingDebug exists:", Boolean(td))
  logOnce("mapper", "mappedTop", "mappedFrame.trackingDebug exists:", Boolean(rigFrame?.trackingDebug))
}

export function logCaptureInput(ctx) {
  if (!isVideoDiagnosticExportDebugEnabled()) return
  const td = resolveWireTrackingDebug(ctx?.lastFrame)
  const vfd = ctx?.getVideoFrameDebug?.() ?? ctx?.videoFrameDebug ?? null
  logOnce("capture", "capture", "capture input trackingDebug exists:", Boolean(td))
  logOnce("capture", "captureVfd", "capture videoFrameDebug exists:", Boolean(vfd))
  logOnce(
    "capture",
    "captureVfdComplete",
    "capture videoFrameDebug complete:",
    vfd ? Boolean(vfd.frameWidth && vfd.canvasWidth && vfd.scaleX != null) : false
  )
}

export function logCompactFrameBuilt(frame) {
  if (!isVideoDiagnosticExportDebugEnabled()) return
  logOnce("compact", "compactBuilt", "compactFrame.trackingDebug exists:", Boolean(frame?.trackingDebug))
  logOnce("compact", "compactVfd", "compactFrame.videoFrameDebug exists:", Boolean(frame?.videoFrameDebug))
}

export function logExportFrameAudit(frames) {
  if (!isVideoDiagnosticExportDebugEnabled()) return
  if (flags.export) return
  flags.export = true
  const list = Array.isArray(frames) ? frames : []
  const count = (pred) => list.filter(pred).length
  const isCompleteVfd = (f) => {
    const v = f?.videoFrameDebug
    if (!v) return false
    return ["frameWidth", "frameHeight", "canvasWidth", "canvasHeight", "scaleX", "offsetX"].every(
      (k) => Number.isFinite(Number(v[k]))
    )
  }
  console.info(
    `[video-debug] export frames count: ${list.length}; ` +
      `trackingDebug: ${count((f) => f.trackingDebug)}; ` +
      `selectedLandmarks: ${count((f) => f.trackingDebug?.selectedLandmarks)}; ` +
      `faceBox: ${count((f) => f.trackingDebug?.faceBox)}; ` +
      `videoFrameDebug: ${count((f) => f.videoFrameDebug)}; ` +
      `videoFrameDebugComplete: ${count(isCompleteVfd)}`
  )
}

export function resetVideoDiagnosticExportDebugFlags() {
  for (const k of Object.keys(flags)) {
    flags[k] = false
  }
}
