/**
 * FaceDEV 2.8：MediaPipe 实时追踪低延迟下发默认值（与关键帧 durationMs、手动单舵机控制无关）。
 * @see useFaceRigInteraction
 */
export const DEFAULT_REALTIME_TUNING = {
  /** 总开关：关闭时不做实时预览自动下发（与 realtimePreview 一致时可省略） */
  enabled: true,
  /** 逻辑姿态 → 串口节流周期（ms） */
  sendIntervalMs: 16,
  /** 实时追踪下发命令中的 T（ms）；跟随时宜小，避免舵机反复重规划 */
  servoMoveTimeMs: 20,
  /** 手动实时：命令 T（ms）；与 RJ forceTimeMs 对齐，过小（0）实机可能不动 */
  manualServoMoveTimeMs: 20,
  /** 仅追踪下发：各舵机实际 PWM 相对上次下发变化均小于此值则跳过 */
  minPwmDelta: 3,
  /** 仅追踪：串口忙时合并为只发最新姿态（见 pushToServo flush） */
  dropStaleFrame: true,
}

/**
 * Face Rig 实时 RJ 跟手：
 * - 关闭默认 20ms defer 堆积（minSendInterval 对齐控制环）
 * - forceTimeMs：固定短时，跳过按 Δθ 估长时（否则拖快不跟手）
 * - 禁止用 0：锐捷 CMD08 实机对 time=0 常表现为“不动”；产品默认下限即 20ms
 */
export const REALTIME_RJ_MOTION_CONFIG = Object.freeze({
  minTimeMs: 20,
  minSendIntervalMs: 16,
  forceTimeMs: 20,
})

/**
 * 绑定检视改方向 / 行程后强制预览：
 * 与 ST 一样立刻下发；RJ 关闭 minSendInterval defer，避免「ST 动了 RJ 没包」。
 */
export const BINDING_PREVIEW_RJ_MOTION_CONFIG = Object.freeze({
  minTimeMs: 20,
  minSendIntervalMs: 0,
  forceTimeMs: 20,
})

/** @deprecated 使用 {@link DEFAULT_REALTIME_TUNING}.sendIntervalMs */
export const REALTIME_THROTTLE_MS = DEFAULT_REALTIME_TUNING.sendIntervalMs
