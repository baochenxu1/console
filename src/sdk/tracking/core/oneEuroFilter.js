/**
 * One Euro Filter — adaptive low-pass for realtime interaction.
 * Casiez et al. Pure JS, no DOM.
 */

import { safeFloat } from "./trackingMath.js"

function smoothingFactor(te, cutoff) {
  const r = 2 * Math.PI * safeFloat(cutoff, 1)
  return 1 / (1 + 1 / (r * Math.max(1e-6, te)))
}

function exponentialSmoothing(a, x, xPrev) {
  return safeFloat(a, 0) * safeFloat(x, 0) + (1 - safeFloat(a, 0)) * safeFloat(xPrev, 0)
}

/**
 * @param {{ minCutoff?: number, beta?: number, dCutoff?: number }} [opts]
 */
export function createOneEuroFilter(opts = {}) {
  let minCutoff = safeFloat(opts.minCutoff, 1.0)
  let beta = safeFloat(opts.beta, 0.007)
  let dCutoff = safeFloat(opts.dCutoff, 1.0)
  let xPrev = null
  let dxPrev = 0
  let tPrev = null

  return {
    reset(value = null) {
      xPrev = value != null && Number.isFinite(Number(value)) ? Number(value) : null
      dxPrev = 0
      tPrev = null
    },
    setParams(next = {}) {
      if (next.minCutoff != null) minCutoff = safeFloat(next.minCutoff, minCutoff)
      if (next.beta != null) beta = safeFloat(next.beta, beta)
      if (next.dCutoff != null) dCutoff = safeFloat(next.dCutoff, dCutoff)
    },
    /**
     * @param {number} x
     * @param {number} timestampMs
     */
    filter(x, timestampMs) {
      const v = safeFloat(x, 0)
      const t = Number(timestampMs)
      if (!Number.isFinite(t)) {
        xPrev = v
        return v
      }
      if (xPrev == null || tPrev == null) {
        xPrev = v
        dxPrev = 0
        tPrev = t
        return v
      }
      let te = (t - tPrev) / 1000
      if (!(te > 0)) te = 1 / 60
      if (te > 1) te = 1 / 30
      const dx = (v - xPrev) / te
      const edx = exponentialSmoothing(smoothingFactor(te, dCutoff), dx, dxPrev)
      const cutoff = minCutoff + beta * Math.abs(edx)
      const xHat = exponentialSmoothing(smoothingFactor(te, cutoff), v, xPrev)
      xPrev = xHat
      dxPrev = edx
      tPrev = t
      return xHat
    },
    get value() {
      return xPrev
    },
  }
}

export function createOneEuroFilter2D(opts = {}) {
  const fx = createOneEuroFilter(opts)
  const fy = createOneEuroFilter(opts)
  return {
    reset(x = null, y = null) {
      fx.reset(x)
      fy.reset(y)
    },
    setParams(next) {
      fx.setParams(next)
      fy.setParams(next)
    },
    filter(x, y, timestampMs) {
      return {
        x: fx.filter(x, timestampMs),
        y: fy.filter(y, timestampMs),
      }
    },
  }
}
