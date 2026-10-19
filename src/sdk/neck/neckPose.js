/**
 * Neck 3DOF semantic pose（deg）。不含关节角 / motor / CAN。
 */

export const NECK_AXES = Object.freeze(["pitch", "roll", "yaw"])

/** UI / Character Rig 推荐操作包络（Luvia 仍有最终 reject） */
export const NECK_SEMANTIC_LIMITS_FALLBACK = Object.freeze({
  pitch: Object.freeze({ min: -10, max: 10 }),
  roll: Object.freeze({ min: -15, max: 15 }),
  yaw: Object.freeze({ min: -90, max: 90 }),
})

/**
 * 正方向约定（facedev frozen）：
 * pitch > 0 = NOSE_DOWN / 低头
 * roll  > 0 = HEAD_TILT_RIGHT / 右倾
 * yaw   > 0 = HEAD_TURN_LEFT / 左转
 */
export function createNeutralNeckPose() {
  return { pitch: 0, roll: 0, yaw: 0 }
}

function clampAxis(value, axis, limits = NECK_SEMANTIC_LIMITS_FALLBACK) {
  const n = Number(value)
  const lim = limits?.[axis] || NECK_SEMANTIC_LIMITS_FALLBACK[axis]
  const min = Number(lim?.min)
  const max = Number(lim?.max)
  if (!Number.isFinite(n)) return 0
  if (Number.isFinite(min) && n < min) return min
  if (Number.isFinite(max) && n > max) return max
  return n
}

/**
 * @param {object|null|undefined} raw
 * @param {{ limits?: object, clamp?: boolean }} [opts]
 */
export function normalizeNeckPose(raw, opts = {}) {
  const clamp = opts.clamp !== false
  const limits = opts.limits || NECK_SEMANTIC_LIMITS_FALLBACK
  const src = raw && typeof raw === "object" ? raw : {}
  const out = createNeutralNeckPose()
  for (const axis of NECK_AXES) {
    const v = Number(src[axis])
    const base = Number.isFinite(v) ? v : 0
    out[axis] = clamp ? clampAxis(base, axis, limits) : base
  }
  return out
}

export function cloneNeckPose(pose, opts = {}) {
  return normalizeNeckPose(pose, opts)
}

export function getNeckAxis(pose, axis) {
  const a = String(axis || "")
  if (!NECK_AXES.includes(a)) return null
  const n = Number(pose?.[a])
  return Number.isFinite(n) ? n : 0
}

export function setNeckAxis(pose, axis, value, opts = {}) {
  const next = normalizeNeckPose(pose, opts)
  const a = String(axis || "")
  if (!NECK_AXES.includes(a)) return next
  next[a] = opts.clamp === false ? Number(value) || 0 : clampAxis(value, a, opts.limits)
  return next
}

export function mergeNeckSemanticLimits(capabilitiesLimits) {
  const out = {
    pitch: { ...NECK_SEMANTIC_LIMITS_FALLBACK.pitch },
    roll: { ...NECK_SEMANTIC_LIMITS_FALLBACK.roll },
    yaw: { ...NECK_SEMANTIC_LIMITS_FALLBACK.yaw },
  }
  if (!capabilitiesLimits || typeof capabilitiesLimits !== "object") return out
  for (const axis of NECK_AXES) {
    const src = capabilitiesLimits[axis]
    if (!src || typeof src !== "object") continue
    if (Number.isFinite(Number(src.min))) out[axis].min = Number(src.min)
    if (Number.isFinite(Number(src.max))) out[axis].max = Number(src.max)
  }
  return out
}
