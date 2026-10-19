import { clampNumber } from "../../../utils/clamp.js"

export const JAW_TRACK_PX = 192

export const FACE_RIG_SCRUB_TRACK_HEIGHT = {
  brow: 72,
  lid: 80,
  mouth: 72,
  tongue: 64,
  nose: 56,
  jaw: JAW_TRACK_PX,
}

/** Jaw 横向 scrub 轨道宽度（视觉尺寸，与数值范围无关） */
export const FACE_RIG_JAW_LATERAL_TRACK_WIDTH = 72
export const FACE_RIG_SCRUB_THUMB_PX = 10
export const FACE_RIG_JAW_THUMB_PX = 14
export const FACE_RIG_PAD_INSET_PX = 10

/**
 * 单击选定阈值（px）：位移小于此值只选中、不改数值，避免误触跳变。
 */
export const SCRUB_CLICK_SLOP_PX = 6

/**
 * 相对拖动增益：1 = 指针走满轨道 ≈ 满量程；越小越钝、越不易拖过头。
 */
export const SCRUB_DRAG_GAIN = 0.48

/** 嘴角 Pad 相对拖动增益（与 scrub 同量级） */
export const PAD_DRAG_GAIN = 0.48

/** 眼球雷达相对拖动增益：略高于 Pad，阻尼更小、跟手一些 */
export const EYE_RADAR_DRAG_GAIN = 0.72

export const SCRUB_RANGE = {
  signed: { min: -100, max: 100 },
  /** 下颌左右：±50 足够，满行程对应 binding driver ±1 */
  signed50: { min: -50, max: 50 },
  percent: { min: 0, max: 100 },
  /** 鼻子等：仅向上，0=中位，100=最大上抬 */
  upward: { min: 0, max: 100 },
}

/** @param {number} v @param {"signed"|"signed50"|"percent"|"upward"} [rangeMode] */
export function clampScrubValue(v, rangeMode = "signed") {
  const r = SCRUB_RANGE[rangeMode] || SCRUB_RANGE.signed
  return clampNumber(Number(v), r.min, r.max)
}

/** 0 = 最小值（轨道底），1 = 最大值（轨道顶） */
export function valueToTrackFraction(value, rangeMode = "signed") {
  const r = SCRUB_RANGE[rangeMode] || SCRUB_RANGE.signed
  const span = r.max - r.min
  if (span <= 0) {
    return 0.5
  }
  return clampNumber((Number(value) - r.min) / span, 0, 1)
}

/** @param {number} fraction @param {"signed"|"percent"} [rangeMode] */
export function fractionToValue(fraction, rangeMode = "signed") {
  const r = SCRUB_RANGE[rangeMode] || SCRUB_RANGE.signed
  const t = clampNumber(Number(fraction), 0, 1)
  return Math.round(r.min + t * (r.max - r.min))
}

/**
 * 指针 Y → 轨道绝对值（顶=最大，底=最小）。
 * @param {number} clientY
 * @param {DOMRect} trackRect
 * @param {number} thumbPx
 * @param {"signed"|"percent"} [rangeMode]
 */
export function valueFromTrackClientY(clientY, trackRect, thumbPx, rangeMode = "signed") {
  const half = thumbPx / 2
  const yTop = trackRect.top + half
  const yBottom = trackRect.bottom - half
  const span = Math.max(1, yBottom - yTop)
  const fraction = clampNumber((yBottom - clientY) / span, 0, 1)
  return fractionToValue(fraction, rangeMode)
}

/**
 * 指针 X → 轨道绝对值（左=最小，右=最大）。
 */
export function valueFromTrackClientX(clientX, trackRect, thumbPx, rangeMode = "signed") {
  const half = thumbPx / 2
  const xLeft = trackRect.left + half
  const xRight = trackRect.right - half
  const span = Math.max(1, xRight - xLeft)
  const fraction = clampNumber((clientX - xLeft) / span, 0, 1)
  return fractionToValue(fraction, rangeMode)
}

/**
 * 相对拖动：从按下时的值出发，按像素位移换算（带增益）。
 * @param {number} startValue
 * @param {number} deltaAlongIncreasingAxisPx 沿数值增大方向的像素位移
 * @param {number} usableTrackPx 轨道有效长度
 * @param {"signed"|"signed50"|"percent"|"upward"} [rangeMode]
 * @param {number} [gain]
 */
export function applyRelativeScrubDelta(
  startValue,
  deltaAlongIncreasingAxisPx,
  usableTrackPx,
  rangeMode = "signed",
  gain = SCRUB_DRAG_GAIN
) {
  const r = SCRUB_RANGE[rangeMode] || SCRUB_RANGE.signed
  const valueSpan = r.max - r.min
  const track = Math.max(1, Number(usableTrackPx) || 1)
  const g = Number.isFinite(Number(gain)) ? Number(gain) : SCRUB_DRAG_GAIN
  const delta = (Number(deltaAlongIncreasingAxisPx) / track) * valueSpan * g
  return clampScrubValue(Math.round(Number(startValue) + delta), rangeMode)
}

export function scrubTrackUsableSpanPx(trackRect, thumbPx, axis = "y") {
  const half = (Number(thumbPx) || 0) / 2
  if (axis === "x") {
    return Math.max(1, trackRect.width - half * 2)
  }
  return Math.max(1, trackRect.height - half * 2)
}

/**
 * @param {number} clientX
 * @param {number} clientY
 * @param {DOMRect} padRect
 * @param {number} [insetPx]
 */
export function padXYFromClient(clientX, clientY, padRect, insetPx = FACE_RIG_PAD_INSET_PX) {
  const innerW = Math.max(1, padRect.width - insetPx * 2)
  const innerH = Math.max(1, padRect.height - insetPx * 2)
  const lx = clampNumber(((clientX - padRect.left - insetPx) / innerW) * 100, 0, 100)
  const ly = clampNumber(((clientY - padRect.top - insetPx) / innerH) * 100, 0, 100)
  return { x: Math.round(lx * 10) / 10, y: Math.round(ly * 10) / 10 }
}

/**
 * 嘴角 Pad 相对拖动：从按下时的 xy 出发，按像素位移换算（带增益）。
 */
export function applyRelativePadDelta(
  startXY,
  deltaXPx,
  deltaYPx,
  usableW,
  usableH,
  gain = PAD_DRAG_GAIN
) {
  const g = Number.isFinite(Number(gain)) ? Number(gain) : PAD_DRAG_GAIN
  const w = Math.max(1, Number(usableW) || 1)
  const h = Math.max(1, Number(usableH) || 1)
  const x0 = Number(startXY?.x)
  const y0 = Number(startXY?.y)
  const x = clampNumber((Number.isFinite(x0) ? x0 : 50) + (Number(deltaXPx) / w) * 100 * g, 0, 100)
  const y = clampNumber((Number.isFinite(y0) ? y0 : 50) + (Number(deltaYPx) / h) * 100 * g, 0, 100)
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }
}

/**
 * @param {number} value
 * @param {number} deltaY
 * @param {WheelEvent | { shiftKey?: boolean, altKey?: boolean }} event
 * @param {"signed"|"percent"} [rangeMode]
 */
export function applyWheelStep(value, deltaY, event, rangeMode = "signed") {
  let step = 1
  if (event.shiftKey) {
    step = 1
  }
  if (event.altKey) {
    step = 5
  }
  const direction = deltaY > 0 ? -1 : 1
  return clampScrubValue(Math.round(Number(value) + direction * step), rangeMode)
}

/**
 * @param {number} axisValue
 * @param {number} deltaY
 * @param {WheelEvent | { shiftKey?: boolean, altKey?: boolean }} event
 */
export function applyPadWheelStep(axisValue, deltaY, event) {
  let step = 1
  if (event.altKey) {
    step = 5
  }
  const direction = deltaY > 0 ? 1 : -1
  return clampNumber(Math.round(Number(axisValue) + direction * step), 0, 100)
}
