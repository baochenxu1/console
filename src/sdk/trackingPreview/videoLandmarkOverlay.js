import { mapSourcePointToCanvas } from "./videoFrameDebug.js"

const SELECTED_KEYS = [
  "noseTip",
  "forehead",
  "leftEyeOuter",
  "leftEyeInner",
  "rightEyeOuter",
  "rightEyeInner",
  "leftBrowMid",
  "rightBrowMid",
  "leftMouthCorner",
  "rightMouthCorner",
  "upperLip",
  "lowerLip",
  "chin",
]

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ px?: number, py?: number, x?: number, y?: number } | null | undefined} point
 * @param {object} transform
 * @param {{ radius?: number, fill?: string, stroke?: string }} [style]
 */
export function drawLandmarkPoint(ctx, point, transform, style = {}) {
  const mapped = mapSourcePointToCanvas(point, transform)
  if (!mapped) return false
  const r = style.radius ?? 2.5
  ctx.fillStyle = style.fill ?? "rgba(34, 211, 238, 0.9)"
  ctx.strokeStyle = style.stroke ?? "rgba(15, 23, 42, 0.45)"
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.arc(mapped.x, mapped.y, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
  return true
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {Record<string, { px?: number, py?: number }> | null | undefined} selected
 * @param {object} transform
 */
export function drawSelectedLandmarks(ctx, selected, transform) {
  if (!selected) return
  for (const key of SELECTED_KEYS) {
    drawLandmarkPoint(ctx, selected[key], transform, {
      radius: 3,
      fill: "rgba(34, 211, 238, 0.95)",
    })
  }
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{ px?: number, py?: number, x?: number, y?: number, i?: number }> | null | undefined} points
 * @param {object} transform
 */
export function drawDenseLandmarks(ctx, points, transform) {
  if (!Array.isArray(points) || !points.length) return
  ctx.fillStyle = "rgba(167, 139, 250, 0.55)"
  for (const pt of points) {
    const mapped = mapSourcePointToCanvas(pt, transform)
    if (!mapped) continue
    ctx.fillRect(mapped.x - 0.75, mapped.y - 0.75, 1.5, 1.5)
  }
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object | null | undefined} faceBox
 * @param {object} transform
 */
export function drawFaceBox(ctx, faceBox, transform) {
  if (!faceBox) return
  const tl = mapSourcePointToCanvas({ px: faceBox.px, py: faceBox.py }, transform)
  const br = mapSourcePointToCanvas(
    {
      px: Number(faceBox.px) + Number(faceBox.widthPx),
      py: Number(faceBox.py) + Number(faceBox.heightPx),
    },
    transform
  )
  if (!tl || !br) return
  ctx.strokeStyle = "rgba(250, 204, 21, 0.85)"
  ctx.lineWidth = 1.5
  ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y)
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object | null | undefined} faceScale trackingDebug.faceScale
 * @param {object} transform videoFrameDebug
 */
export function drawRoiBox(ctx, faceScale, transform) {
  if (!faceScale?.roiEnabled) return
  const x = Number(faceScale.roiX)
  const y = Number(faceScale.roiY)
  const w = Number(faceScale.roiWidthPx)
  const h = Number(faceScale.roiHeightPx)
  if (![x, y, w, h].every((v) => Number.isFinite(v) && v >= 0)) return
  const tl = mapSourcePointToCanvas({ px: x, py: y }, transform)
  const br = mapSourcePointToCanvas({ px: x + w, py: y + h }, transform)
  if (!tl || !br) return
  const rw = br.x - tl.x
  const rh = br.y - tl.y
  if (rw <= 0 || rh <= 0) return
  ctx.save()
  ctx.strokeStyle = "rgba(56, 189, 248, 0.92)"
  ctx.lineWidth = 2
  ctx.setLineDash([7, 5])
  ctx.strokeRect(tl.x, tl.y, rw, rh)
  ctx.setLineDash([])
  ctx.fillStyle = "rgba(56, 189, 248, 0.12)"
  ctx.fillRect(tl.x, tl.y, rw, rh)
  ctx.restore()
}
