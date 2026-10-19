/** FaceRig 嘴唇四通道最终输出限制（进入 binding 前） */

export const LIP_FINAL_ABS_LIMIT = 38

/** 全局增益：mapping → FaceRig 后、binding 前（Python lip_geometry 已做 scale，此处不再重复） */
export const LIP_GLOBAL_SCALE = 1.0

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

/**
 * @param {object | null | undefined} rig
 * @param {{ globalScale?: number, absLimit?: number }} [opts]
 */
export function applyLipOutputLimits(rig, opts = {}) {
  if (!rig?.mouth) {
    return { rig, applied: false }
  }
  const scale = Number(opts.globalScale ?? LIP_GLOBAL_SCALE)
  const limit = Number(opts.absLimit ?? LIP_FINAL_ABS_LIMIT)
  const mouth = { ...rig.mouth }
  const keys = ["UL", "UR", "LL", "LR"]
  for (const k of keys) {
    const scaled = num(mouth[k]) * scale
    mouth[k] = clamp(scaled, -limit, limit)
  }
  return {
    rig: { ...rig, mouth },
    applied: true,
    globalScale: scale,
    absLimit: limit,
  }
}
