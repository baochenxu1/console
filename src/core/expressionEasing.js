/**
 * 表情时间轴缓动（仅实现当前工程契约；未知值 fallback linear）。
 * UI / createKeyframe 当前仅持久化 `linear`。
 */

export const EXPRESSION_EASING_LINEAR = "linear"

/** 当前工程实际可保存 / 展示的 easing（只读契约） */
export const EXPRESSION_SUPPORTED_EASINGS = Object.freeze([EXPRESSION_EASING_LINEAR])

function clamp01(t) {
  const n = Number(t)
  if (!Number.isFinite(n)) return 0
  if (n <= 0) return 0
  if (n >= 1) return 1
  return n
}

/**
 * @param {number} rawProgress 0..1
 * @param {string} [easing]
 * @returns {number} eased 0..1
 */
export function applyEasing(rawProgress, easing = EXPRESSION_EASING_LINEAR) {
  const t = clamp01(rawProgress)
  const id = String(easing || EXPRESSION_EASING_LINEAR).trim().toLowerCase()

  if (id === EXPRESSION_EASING_LINEAR || id === "none" || id === "") {
    return t
  }

  // 历史/别名：不扩展 UI，仅保证旧工程不 crash；行为接近常见二次缓动
  if (id === "ease-in" || id === "easein" || id === "ease_in") {
    return t * t
  }
  if (id === "ease-out" || id === "easeout" || id === "ease_out") {
    return 1 - (1 - t) * (1 - t)
  }
  if (id === "ease-in-out" || id === "easeinout" || id === "ease_in_out") {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
  }

  // 未知 → linear
  return t
}
