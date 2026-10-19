/**
 * 绑定 / 追踪输出模式（PWM 文本协议已移除，仅 Preview + Bus Servo）。
 */

export * from "./bindingWorkbenchRig.js"
export * from "./buildFinalServoOutputsForBindingWorkbench.js"
export * from "./evaluateBindingOutputGates.js"
export * from "./buildBindingWorkbenchState.js"
export * from "./dispatchBindingWorkbenchOutputs.js"

export const BINDING_OUTPUT_MODE_STORAGE_KEY = "facedev.binding.outputMode"

export const BINDING_OUTPUT_MODES = /** @type {const} */ ({
  PREVIEW: "preview",
  BUS_SERVO: "bus-servo",
})

export const BINDING_OUTPUT_MODE_LABELS = {
  [BINDING_OUTPUT_MODES.PREVIEW]: "Preview Only",
  [BINDING_OUTPUT_MODES.BUS_SERVO]: "Bus Servo",
}

/** 将历史 localStorage `"pwm"` 迁移为总线模式。 */
export function normalizeBindingOutputMode(raw) {
  if (raw === BINDING_OUTPUT_MODES.PREVIEW || raw === "preview") {
    return BINDING_OUTPUT_MODES.PREVIEW
  }
  // 旧 PWM 模式与未知值一律落到总线
  return BINDING_OUTPUT_MODES.BUS_SERVO
}
