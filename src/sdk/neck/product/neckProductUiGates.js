/**
 * Pure presentation helpers for Neck product UI gates / status labels.
 */

/**
 * Settings view: only engineering/calibration entry (no connect/enable/close).
 */
export function getNeckSettingsGates({
  transportReady = false,
  motorsEnabled = false,
  estop = false,
  calibrating = false,
} = {}) {
  const physicalActive = Boolean(transportReady || motorsEnabled || estop || calibrating)
  return {
    showCalibration: Boolean(transportReady && motorsEnabled && !estop && !calibrating),
    canCloseModule: !physicalActive,
    physicalActive,
  }
}

/**
 * Compact device status for header badge.
 */
export function getNeckDeviceStatusLabel({
  moduleEnabled = true,
  transportReady = false,
  motorsEnabled = false,
  estop = false,
  hostState = "",
} = {}) {
  if (!moduleEnabled) return "未启用"
  if (estop) return "ESTOP"
  if (hostState === "HOLD" || hostState === "STALE_SAFE_HOLD") return "保持"
  if (hostState === "ERROR" && transportReady) return "错误"
  if (!transportReady) return "未连接"
  if (!motorsEnabled) return "已连接"
  return "就绪"
}

/**
 * Longer status line for connection feedback.
 */
export function getNeckConnectionStatusText({
  moduleEnabled = true,
  transportReady = false,
  motorsEnabled = false,
  estop = false,
  hardwarePreview = false,
} = {}) {
  if (!moduleEnabled) return "Neck 模块未启用 · 控件只读"
  if (estop) return "设备：ESTOP 已锁存 · 需清除后才能使能"
  if (!transportReady) return "设备：未连接 · 可编辑姿态，不下发硬件"
  if (!motorsEnabled) return "设备：已连接 · 电机未使能"
  const preview = hardwarePreview ? "硬件预览开" : "硬件预览关"
  return `设备：已连接 · 电机已使能 · ${preview}`
}

/**
 * Header connection pill tone (serial-capsule Offline / Connected).
 * @returns {"offline"|"connected"|"ready"|"estop"|"neutral"}
 */
export function getNeckConnectionPillTone({
  moduleEnabled = true,
  transportReady = false,
  motorsEnabled = false,
  estop = false,
  hostState = "",
} = {}) {
  if (estop || (hostState === "ERROR" && transportReady)) return "estop"
  if (!moduleEnabled || !transportReady) return "offline"
  if (!motorsEnabled) return "connected"
  return "ready"
}
