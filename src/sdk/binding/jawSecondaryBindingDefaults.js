import { CHANNEL_VALUE, normalizeBinding } from "../../core/faceRigProfile.js"

/**
 * v4：仅重新启用 servo_15，不再改写正/负目标。
 * 合嘴差速请用绑定检视器「反向」（与其它舵机相同）；勿在迁移里强制镜像。
 */
export const JAW_SECONDARY_BINDING_VERSION = "4"
export const JAW_SECONDARY_LEGACY_SERVO_ID = 15
export const JAW_PRIMARY_LEGACY_SERVO_IDS = [8, 9]

/** @deprecated v1 自动禁用原因；迁移时会清除 */
export const JAW_SECONDARY_DISABLED_REASON = "jaw-secondary-profile-missing"

function isJawPrimaryBinding(binding) {
  if (!binding || binding.controlId !== "jaw" || binding.channel !== CHANNEL_VALUE) {
    return false
  }
  const sid = Number(binding.servoId)
  if (JAW_PRIMARY_LEGACY_SERVO_IDS.includes(sid)) {
    return true
  }
  const key = String(binding.actuatorKey || "")
  return key === "servo_8" || key === "servo_9"
}

export function isJawSecondaryBinding(binding) {
  if (!binding || binding.controlId !== "jaw" || binding.channel !== CHANNEL_VALUE) {
    return false
  }
  if (isJawPrimaryBinding(binding)) {
    return false
  }
  const sid = Number(binding.servoId)
  if (sid === JAW_SECONDARY_LEGACY_SERVO_ID) {
    return true
  }
  const key = String(binding.actuatorKey || "")
  return key === "servo_15"
}

/**
 * v4：只解除禁用，保留用户/检视器已设的正负目标（含「反向」）。
 * @param {object[]} bindings
 */
export function patchJawSecondaryBindings(bindings) {
  return (bindings || []).map((b) => {
    if (!isJawSecondaryBinding(b)) {
      return b
    }
    const { disabledReason: _omit, ...rest } = b
    return normalizeBinding({
      ...rest,
      enabled: true,
    })
  })
}

export function profileNeedsJawSecondaryBindingPatch(profile) {
  if (!profile || profile.jawSecondaryBindingVersion === JAW_SECONDARY_BINDING_VERSION) {
    return false
  }
  return (profile.bindings || []).some(isJawSecondaryBinding)
}
