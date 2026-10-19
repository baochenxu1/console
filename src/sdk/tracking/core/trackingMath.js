/**
 * Shared tracking math — no DOM, pure functions.
 * Ports mediapipe_mapping_config / mediapipe_to_rig / gaze_iris_only helpers.
 */

export function safeFloat(v, fallback = 0) {
  if (v == null || v === "") return fallback
  const n = typeof v === "number" ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return n
}

export function clamp(value, minValue, maxValue) {
  let lo = safeFloat(minValue, 0)
  let hi = safeFloat(maxValue, 100)
  if (hi < lo) {
    const tmp = lo
    lo = hi
    hi = tmp
  }
  return Math.max(lo, Math.min(hi, safeFloat(value, 0)))
}

export function clampPct(v) {
  return Math.max(0, Math.min(100, safeFloat(v, 0)))
}

export function clampSigned100(v) {
  return Math.max(-100, Math.min(100, safeFloat(v, 0)))
}

export function applyDeadzone(value, threshold) {
  const t = Math.max(0, safeFloat(threshold, 0))
  const v = safeFloat(value, 0)
  if (Math.abs(v) < t) return 0
  return v
}

export function applyGain(value, gain) {
  return safeFloat(value, 0) * safeFloat(gain, 1)
}

/**
 * Unipolar invert: inverted = min + max - clamp(value) on the same [min, max] interval.
 */
export function applyInvertUnipolar(value, enabled, minValue, maxValue) {
  let lo = safeFloat(minValue, 0)
  let hi = safeFloat(maxValue, 100)
  if (hi < lo) {
    const tmp = lo
    lo = hi
    hi = tmp
  }
  const v = clamp(value, lo, hi)
  if (!enabled) return v
  return lo + hi - v
}

/**
 * centered → deadzone / gain / ×100 → clamp → unipolar invert.
 * Matches mediapipe_to_rig._pipe_unipolar_strength.
 */
/**
 * 减 neutral 后的量 → deadzone / gain / ×100 → clamp。不含 invert。
 * Matches mediapipe_to_rig._semantic_strength_base.
 */
export function semanticStrengthBase(centered, opts = {}) {
  let x = applyDeadzone(centered, opts.deadzoneThr)
  x = applyGain(x, opts.gain)
  x = x * 100
  return clamp(x, opts.limLo, opts.limHi)
}

export function pipeUnipolarStrength(cent, opts = {}) {
  const x = semanticStrengthBase(cent, opts)
  return applyInvertUnipolar(x, opts.invert, opts.limLo, opts.limHi)
}

/**
 * tanh soft limiter. Matches gaze_iris_only._soft_norm.
 */
export function softNorm(v, opts = {}) {
  const gain = safeFloat(opts.gain, 1)
  const k = Math.max(1e-6, safeFloat(opts.knee, 1e-6))
  return Math.tanh((safeFloat(v, 0) * gain) / k)
}

export function lerp(a, b, t) {
  return safeFloat(a, 0) + (safeFloat(b, 0) - safeFloat(a, 0)) * safeFloat(t, 0)
}
