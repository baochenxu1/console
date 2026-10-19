/**
 * Face Binding Inspector 工作流 UI 纯展示辅助。
 * 不改变 Binding schema / PWM 计算；仅文案与方向极性推断。
 *
 * 真实映射（evaluateBindingLogical）：
 * - 控件驱动 u≥0（signed100 的 +100）→ positiveTargetPwm → 产品文案「上极限」
 * - 控件驱动 u<0（signed100 的 −100）→ negativeTargetPwm → 产品文案「下极限」
 */

export const TRAVEL_LIMIT_UPPER = "upper"
export const TRAVEL_LIMIT_LOWER = "lower"
export const TRAVEL_LIMIT_NEUTRAL = "neutral"

export const BINDING_DIR_FORWARD = "forward"
export const BINDING_DIR_REVERSE = "reverse"

/** 上极限对应的现有 target 字段名 */
export const UPPER_LIMIT_TARGET_FIELD = "positiveTargetPwm"
/** 下极限对应的现有 target 字段名 */
export const LOWER_LIMIT_TARGET_FIELD = "negativeTargetPwm"

/**
 * @param {"upper"|"lower"|"neutral"} limit
 * @returns {"positiveTargetPwm"|"negativeTargetPwm"|"neutralPwm"}
 */
export function travelLimitToTargetField(limit) {
  if (limit === TRAVEL_LIMIT_UPPER) return UPPER_LIMIT_TARGET_FIELD
  if (limit === TRAVEL_LIMIT_LOWER) return LOWER_LIMIT_TARGET_FIELD
  return "neutralPwm"
}

/**
 * 控件正端（+100 / 驱动 ≥0）对应上极限 → positiveTargetPwm。
 * @param {object} binding
 */
export function readUpperLimitPwm(binding) {
  return binding?.positiveTargetPwm
}

/**
 * 控件负端（−100 / 驱动 <0）对应下极限 → negativeTargetPwm。
 * @param {object} binding
 */
export function readLowerLimitPwm(binding) {
  return binding?.negativeTargetPwm
}

/**
 * Binding 映射方向（写入 binding.invert，与行程端点独立）：
 * 正向 = 控件正端走 positiveTargetPwm；反向 = 绕中位镜像。
 * @param {object} binding
 * @returns {"forward"|"reverse"}
 */
export function readBindingMappingDirection(binding) {
  return binding?.invert ? BINDING_DIR_REVERSE : BINDING_DIR_FORWARD
}

/**
 * @param {"forward"|"reverse"} direction
 */
export function bindingMappingDirectionLabel(direction) {
  return direction === BINDING_DIR_REVERSE ? "反向" : "正向"
}

/**
 * @param {object} binding
 * @param {"forward"|"reverse"} nextDirection
 * @returns {boolean} 是否需要写入 invert
 */
export function shouldReverseBindingForDirection(binding, nextDirection) {
  return readBindingMappingDirection(binding) !== nextDirection
}

/**
 * @param {"forward"|"reverse"} nextDirection
 * @returns {{ invert: boolean }}
 */
export function bindingDirectionPatch(nextDirection) {
  return { invert: nextDirection === BINDING_DIR_REVERSE }
}
