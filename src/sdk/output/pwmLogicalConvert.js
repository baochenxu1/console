import { LOGICAL_MIN, LOGICAL_MAX, LOGICAL_CENTER, PWM_MIN, PWM_MAX, PWM_CENTER } from "./finalServoOutputTypes.js"

export function clampLogical(n) {
  return Math.round(Math.max(LOGICAL_MIN, Math.min(LOGICAL_MAX, Number(n) || 0)))
}

export function clampPwm(n) {
  return Math.round(Math.max(PWM_MIN, Math.min(PWM_MAX, Number(n) || PWM_CENTER)))
}

/** PWM 500~2500 → logical 0~1000（Bus 层与绑定 evaluate 结果一致，检视器「反向目标」通过 PWM 生效） */
export function pwmToLogical(pwmValue) {
  const v = Number(pwmValue)
  if (!Number.isFinite(v)) {
    return LOGICAL_CENTER
  }
  return clampLogical((v - PWM_MIN) / 2)
}

/** logical 0~1000 → PWM 500~2500 */
export function logicalToPwm(logicalValue) {
  const v = Number(logicalValue)
  if (!Number.isFinite(v)) {
    return PWM_CENTER
  }
  return clampPwm(PWM_MIN + clampLogical(v) * 2)
}
