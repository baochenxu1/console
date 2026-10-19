/** 四路眼皮绑定诊断通道（controlId + 典型 sourceChannel） */
export const EYE_BINDING_CHANNELS = [
  { key: "eye_r_up", controlId: "eye_r_up", channel: "value", label: "右眼上睑" },
  { key: "eye_r_lo", controlId: "eye_r_lo", channel: "value", label: "右眼下睑" },
  { key: "eye_l_up", controlId: "eye_l_up", channel: "value", label: "左眼上睑" },
  { key: "eye_l_lo", controlId: "eye_l_lo", channel: "value", label: "左眼下睑" },
]

function sourceChannelFor(spec) {
  return `${spec.controlId}.${spec.channel}`
}

const STANDARD_CENTER_PWM = 1500
const NEUTRAL_PWM_WARN_DELTA = 80
const NEUTRAL_CONTROL_THRESH = 8

export function isEyeBindingNeutralOffset(controlValue, pwmValue, neutralPwm = STANDARD_CENTER_PWM) {
  const cv = Number(controlValue)
  const pwm = Number(pwmValue)
  const neutral = Number(neutralPwm)
  if (!Number.isFinite(cv) || !Number.isFinite(pwm) || !Number.isFinite(neutral)) {
    return false
  }
  if (Math.abs(cv) > NEUTRAL_CONTROL_THRESH) {
    return false
  }
  return Math.abs(pwm - neutral) > NEUTRAL_PWM_WARN_DELTA
}

function findOutput(outputs, spec) {
  const sc = sourceChannelFor(spec)
  return (
    (outputs || []).find((o) => o.sourceChannel === sc) ||
    (outputs || []).find((o) => o.bindingId && o.sourceChannel?.startsWith(spec.controlId)) ||
    null
  )
}

function findBinding(bindings, controlId) {
  return (bindings || []).find((b) => b.controlId === controlId && b.enabled !== false) || null
}

function findBusCommand(busCommands, actuatorKey) {
  return (busCommands || []).find((c) => c.actuatorKey === actuatorKey) || null
}

function readControlValue(rigValues, controlId) {
  const node = rigValues?.[controlId]
  if (!node || typeof node !== "object") {
    return null
  }
  const v = node.value
  return Number.isFinite(Number(v)) ? Number(v) : null
}

/**
 * 构建四路眼皮绑定诊断行（绑定页 / Mapping Diagnostics 共用）。
 */
export function buildEyeBindingDebugRows({
  finalServoOutputs = [],
  bindings = [],
  busCommands = [],
  rigValues = null,
} = {}) {
  return EYE_BINDING_CHANNELS.map((spec) => {
    const binding = findBinding(bindings, spec.controlId)
    const out = findOutput(finalServoOutputs, spec)
    const bus = out ? findBusCommand(busCommands, out.actuatorKey) : null
    const rawControlValue =
      out?.rawControlValue ?? readControlValue(rigValues, spec.controlId) ?? null
    const appliedControlValue =
      out?.appliedControlValue ?? out?.controlValue ?? rawControlValue

    const neutralPwm = out?.neutralPwm ?? binding?.neutralPwm ?? STANDARD_CENTER_PWM
    const pwmValue = out?.pwmValue ?? null
    const warning = isEyeBindingNeutralOffset(appliedControlValue, pwmValue, neutralPwm)
      ? "eye-binding-neutral-offset"
      : null

    return {
      key: spec.key,
      label: spec.label,
      sourceChannel: sourceChannelFor(spec),
      actuatorKey: out?.actuatorKey ?? binding?.actuatorKey ?? null,
      bindingId: out?.bindingId ?? binding?.bindingId ?? null,
      rawControlValue,
      appliedControlValue,
      filteredControlValue: out?.filteredControlValue ?? appliedControlValue,
      /** @deprecated */ controlValue: appliedControlValue,
      neutralPwm,
      positiveTargetPwm: out?.positiveTargetPwm ?? binding?.positiveTargetPwm ?? null,
      negativeTargetPwm: out?.negativeTargetPwm ?? binding?.negativeTargetPwm ?? null,
      pwmValue,
      logicalValue: out?.logicalValue ?? null,
      busServoId: bus?.busServoId ?? null,
      targetPosition: bus?.targetPosition ?? null,
      centerMode: bus?.centerMode ?? null,
      warning,
      warningHint: warning
        ? "控件接近中位，但 PWM 输出远离 1500，可能仍使用旧机械 neutral。"
        : null,
    }
  })
}
