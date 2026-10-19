import { LOGICAL_MIN, LOGICAL_MAX, LOGICAL_CENTER } from "../core/servoProfileMath.js"

const PWM_MIN = 500
const PWM_MAX = 2500

/**
 * 将各类舵机输出统一为 bus logical 0~1000。
 * 优先级：actualPwm / pwm（旧 PWM 最终输出）> logicalValue 0~1000 > percent > signed。
 *
 * @param {number | object} output
 * @returns {{ busLogical: number, sourceType: string, rawValue: number | null }}
 */
export function normalizeToBusLogicalValue(output) {
  if (output == null) {
    return { busLogical: LOGICAL_CENTER, sourceType: "unknown", rawValue: null }
  }

  if (typeof output === "object") {
    const raw =
      output.actualPwm ??
      output.pwm ??
      output.logicalPwm ??
      output.logicalValue ??
      output.value ??
      output.busLogical

    if (raw != null && Number.isFinite(Number(raw))) {
      return normalizeScalar(Number(raw), output)
    }
    return { busLogical: LOGICAL_CENTER, sourceType: "unknown", rawValue: null }
  }

  return normalizeScalar(Number(output), null)
}

function clampBusLogical(n) {
  return Math.round(Math.max(LOGICAL_MIN, Math.min(LOGICAL_MAX, n)))
}

function normalizeScalar(n, source) {
  if (!Number.isFinite(n)) {
    return { busLogical: LOGICAL_CENTER, sourceType: "invalid", rawValue: n }
  }

  if (source?.busLogical != null && source?.sourceType === "bus-logical") {
    return { busLogical: clampBusLogical(n), sourceType: "bus-logical", rawValue: n }
  }

  // 旧 PWM 最终输出 actualPwm / pwm（500~2500，中点 1500）
  if (n >= PWM_MIN - 50 && n <= PWM_MAX + 50) {
    const busLogical = clampBusLogical((n - PWM_MIN) / 2)
    let sourceType = "pwm-logical"
    if (source?.actualPwm != null) {
      sourceType = "actual-pwm"
    } else if (source?.pwm != null) {
      sourceType = "pwm"
    } else if (source?.logicalPwm != null) {
      sourceType = "logical-pwm"
    }
    return { busLogical, sourceType, rawValue: n }
  }

  // 已是 bus logical 0~1000
  if (n >= LOGICAL_MIN && n <= LOGICAL_MAX) {
    return { busLogical: clampBusLogical(n), sourceType: "bus-logical", rawValue: n }
  }

  // percent 0~100
  if (n >= 0 && n <= 100) {
    return { busLogical: clampBusLogical(n * 10), sourceType: "percent", rawValue: n }
  }

  // signed -100~100
  if (n >= -100 && n <= 100) {
    return { busLogical: clampBusLogical(LOGICAL_CENTER + n * 5), sourceType: "signed", rawValue: n }
  }

  return { busLogical: LOGICAL_CENTER, sourceType: "unknown", rawValue: n }
}
