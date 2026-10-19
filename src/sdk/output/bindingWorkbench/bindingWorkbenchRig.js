import { CHANNEL_X, CHANNEL_Y } from "../../../core/faceRigProfile.js"
import { setEliteRigControlRaw } from "../../../core/faceDofMapper.js"

/** @typedef {'center' | 'positive' | 'negative'} BindingTestMode */

/**
 * 按控件通道规格计算测试用 raw 值。
 * @param {object} channelSpec
 * @param {BindingTestMode} testMode
 */
export function rawValueForBindingTest(channelSpec, testMode) {
  const mode = channelSpec?.mode || "signed100"
  if (mode === "percent") {
    if (testMode === "center") return 50
    if (testMode === "positive") return 100
    return 0
  }
  if (testMode === "center") return 0
  if (testMode === "positive") return 100
  return -100
}

/**
 * 将单控件测试位姿写入 elite rig（不直接发舵机）。
 */
export function applyBindingTestPoseToRig(rig, profile, controlId, channel, testMode) {
  const ctrl = (profile?.controls || []).find((c) => c.controlId === controlId)
  const chSpec = ctrl?.channels?.[channel]
  if (!chSpec) {
    return rig
  }
  const raw = rawValueForBindingTest(chSpec, testMode)
  return setEliteRigControlRaw(rig, controlId, channel, raw)
}

/**
 * 对选中 binding 应用测试位姿。
 */
export function applySelectedBindingTestPose(rig, profile, binding, testMode) {
  if (!binding) {
    return rig
  }
  return applyBindingTestPoseToRig(rig, profile, binding.controlId, binding.channel, testMode)
}
