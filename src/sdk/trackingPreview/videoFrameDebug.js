/**
 * Video Preview 坐标变换诊断（Phase 2.0）。
 * 将源视频像素坐标映射到 canvas / 显示区域。
 */

/**
 * @param {object} params
 * @param {number} params.frameWidth
 * @param {number} params.frameHeight
 * @param {number} [params.displayWidth]
 * @param {number} [params.displayHeight]
 * @param {number} [params.canvasWidth]
 * @param {number} [params.canvasHeight]
 * @param {'contain'|'cover'|'fill'|'unknown'} [params.objectFit]
 * @param {boolean} [params.mirrored]
 */
export function computeVideoFrameTransform({
  frameWidth,
  frameHeight,
  displayWidth,
  displayHeight,
  canvasWidth,
  canvasHeight,
  objectFit = "cover",
  mirrored = false,
} = {}) {
  const fw = Math.max(1, Number(frameWidth) || 1)
  const fh = Math.max(1, Number(frameHeight) || 1)
  const cw = Math.max(1, Number(canvasWidth ?? displayWidth) || 1)
  const ch = Math.max(1, Number(canvasHeight ?? displayHeight) || 1)
  const dw = Number(displayWidth) || cw
  const dh = Number(displayHeight) || ch

  let scale = 1
  let offsetX = 0
  let offsetY = 0
  const fit = objectFit === "contain" || objectFit === "cover" || objectFit === "fill" ? objectFit : "unknown"

  if (fit === "fill") {
    scale = 1
    offsetX = 0
    offsetY = 0
  } else if (fit === "contain") {
    scale = Math.min(cw / fw, ch / fh)
    const drawW = fw * scale
    const drawH = fh * scale
    offsetX = (cw - drawW) / 2
    offsetY = (ch - drawH) / 2
  } else {
    scale = Math.max(cw / fw, ch / fh)
    const drawW = fw * scale
    const drawH = fh * scale
    offsetX = (cw - drawW) / 2
    offsetY = (ch - drawH) / 2
  }

  return {
    frameWidth: fw,
    frameHeight: fh,
    displayWidth: dw,
    displayHeight: dh,
    canvasWidth: cw,
    canvasHeight: ch,
    objectFit: fit,
    scaleX: scale,
    scaleY: scale,
    offsetX,
    offsetY,
    mirrored: Boolean(mirrored),
    coordinateSpace: "source-pixel",
  }
}

/**
 * @param {{ px?: number, py?: number, x?: number, y?: number }} point
 * @param {ReturnType<typeof computeVideoFrameTransform>} transform
 */
export function mapSourcePointToCanvas(point, transform) {
  if (!point || !transform) {
    return null
  }
  const fw = transform.frameWidth || 1
  const fh = transform.frameHeight || 1
  const px = Number.isFinite(Number(point.px)) ? Number(point.px) : Number(point.x) * fw
  const py = Number.isFinite(Number(point.py)) ? Number(point.py) : Number(point.y) * fh
  if (!Number.isFinite(px) || !Number.isFinite(py)) {
    return null
  }
  let x = px * transform.scaleX + transform.offsetX
  const y = py * transform.scaleY + transform.offsetY
  if (transform.mirrored) {
    x = transform.canvasWidth - x
  }
  return { x, y }
}

/**
 * 从 <img> 元素与 trackingDebug 帧尺寸构建 videoFrameDebug。
 * @param {HTMLImageElement | null} img
 * @param {object | null} trackingDebug
 * @param {HTMLElement | null} [container]
 */
/**
 * 无 DOM 或 viewport 未布局时，用 trackingDebug 帧尺寸生成可落盘的 fallback transform。
 * @param {object | null | undefined} trackingDebug
 * @param {object | null | undefined} [partial]
 */
export function buildVideoFrameDebugFromTrackingDebug(trackingDebug, partial = null) {
  const frameWidth = Number(trackingDebug?.frameWidth) || Number(partial?.frameWidth) || 0
  const frameHeight = Number(trackingDebug?.frameHeight) || Number(partial?.frameHeight) || 0
  if (!frameWidth || !frameHeight) {
    return isVideoFrameDebugComplete(partial) ? partial : null
  }
  const canvasWidth =
    Number(partial?.canvasWidth) ||
    Number(partial?.displayWidth) ||
    frameWidth
  const canvasHeight =
    Number(partial?.canvasHeight) ||
    Number(partial?.displayHeight) ||
    frameHeight
  const objectFit =
    partial?.objectFit === "contain" ||
    partial?.objectFit === "cover" ||
    partial?.objectFit === "fill"
      ? partial.objectFit
      : "cover"
  return computeVideoFrameTransform({
    frameWidth,
    frameHeight,
    displayWidth: Number(partial?.displayWidth) || canvasWidth,
    displayHeight: Number(partial?.displayHeight) || canvasHeight,
    canvasWidth,
    canvasHeight,
    objectFit,
    mirrored: Boolean(partial?.mirrored),
  })
}

export function measureVideoFrameDebugFromElement(img, trackingDebug, container = null) {
  const frameWidth =
    Number(trackingDebug?.frameWidth) || Number(img?.naturalWidth) || 0
  const frameHeight =
    Number(trackingDebug?.frameHeight) || Number(img?.naturalHeight) || 0
  if (!frameWidth || !frameHeight) {
    return null
  }
  const host = container || img?.parentElement || null
  const canvasWidth = host?.clientWidth || img?.clientWidth || 0
  const canvasHeight = host?.clientHeight || img?.clientHeight || 0
  if (!canvasWidth || !canvasHeight) {
    return buildVideoFrameDebugFromTrackingDebug(trackingDebug)
  }
  const style = img ? window.getComputedStyle(img) : null
  const objectFit =
    style?.objectFit === "contain" || style?.objectFit === "cover" || style?.objectFit === "fill"
      ? style.objectFit
      : "cover"
  const scaleX = style ? Number(style.scaleX) : 1
  const mirrored = Number.isFinite(scaleX) && scaleX < 0

  return computeVideoFrameTransform({
    frameWidth,
    frameHeight,
    displayWidth: img?.clientWidth || canvasWidth,
    displayHeight: img?.clientHeight || canvasHeight,
    canvasWidth,
    canvasHeight,
    objectFit,
    mirrored,
  })
}

/** diagnostic / summary 用：transform 字段是否完整 */
export function isVideoFrameDebugComplete(vfd) {
  if (!vfd || typeof vfd !== "object") {
    return false
  }
  const numericKeys = [
    "frameWidth",
    "frameHeight",
    "canvasWidth",
    "canvasHeight",
    "displayWidth",
    "displayHeight",
    "scaleX",
    "scaleY",
    "offsetX",
    "offsetY",
  ]
  if (!numericKeys.every((k) => Number.isFinite(Number(vfd[k])))) {
    return false
  }
  return Boolean(vfd.objectFit) && Boolean(vfd.coordinateSpace)
}
