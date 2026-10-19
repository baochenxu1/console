import { normalizeBinding } from "../../core/faceRigProfile.js"

const BINDING_RANGE_CUSTOM = "custom"

export const LEFT_EYE_LID_BINDING_VERSION = "1"

/** Bus Servo + installed_center 语义下左眼眼皮绑定目标 */
export const LEFT_EYE_LID_BINDING_TARGETS = {
  eye_l_lo: {
    neutralPwm: 1500,
    positiveTargetPwm: 500,
    negativeTargetPwm: 2420,
    rangeMode: BINDING_RANGE_CUSTOM,
  },
  eye_l_up: {
    neutralPwm: 1500,
    positiveTargetPwm: 500,
    negativeTargetPwm: 2000,
    rangeMode: BINDING_RANGE_CUSTOM,
  },
}

function needsLeftEyeLidPatch(binding) {
  if (!binding || binding.enabled === false) {
    return false
  }
  const targets = LEFT_EYE_LID_BINDING_TARGETS[binding.controlId]
  if (!targets) {
    return false
  }
  const neutral = Number(binding.neutralPwm)
  const neg = Number(binding.negativeTargetPwm)
  if (binding.controlId === "eye_l_lo") {
    return neutral !== targets.neutralPwm || neg !== targets.negativeTargetPwm
  }
  if (binding.controlId === "eye_l_up") {
    return neutral !== targets.neutralPwm || neg > 2100 || neg !== targets.negativeTargetPwm
  }
  return false
}

/**
 * 修正左眼眼皮 binding：eye_l_lo 中位 1580→1500；eye_l_up 闭眼行程过大。
 * @param {object[]} bindings
 */
export function patchLeftEyeLidBindings(bindings) {
  return (bindings || []).map((b) => {
    const targets = LEFT_EYE_LID_BINDING_TARGETS[b?.controlId]
    if (!targets || !needsLeftEyeLidPatch(b)) {
      return b
    }
    return normalizeBinding({ ...b, ...targets })
  })
}

export function profileNeedsLeftEyeLidBindingPatch(profile) {
  if (!profile || profile.leftEyeLidBindingVersion === LEFT_EYE_LID_BINDING_VERSION) {
    return false
  }
  return (profile.bindings || []).some(needsLeftEyeLidPatch)
}
