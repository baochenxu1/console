import { normalizeToBusLogicalValue } from "./normalizeToBusLogicalValue.js"

/**
 * Face Rig / PWM 输出（500~2500）→ 总线 logical（0~1000）。
 * busLogical = (pwm - 500) / 2
 * @param {number} pwmLogical
 */
export function pwmLogicalToBusLogical(pwmLogical) {
  return normalizeToBusLogicalValue(pwmLogical).busLogical
}
