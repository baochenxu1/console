/**
 * 面部绑定页输出门控（无 tracking 人脸要求）。
 * PWM 文本协议已移除：实发仅 Bus Servo。
 *
 * @param {object} params
 * @param {boolean} params.driveArmed
 * @param {'preview'|'bus-servo'} params.outputMode
 * @param {boolean} params.busSerialConnected
 * @param {string} [params.busFamilyLabel] 当前选中族短名，如 RJ / SC/ST
 * @param {boolean} params.profilesReady
 * @param {number} [params.finalOutputCount]
 */
export function evaluateBindingOutputGates({
  driveArmed = false,
  outputMode = "preview",
  busSerialConnected = false,
  busFamilyLabel = "",
  profilesReady = false,
  finalOutputCount = 0,
} = {}) {
  if (outputMode === "preview") {
    return {
      canSend: false,
      isPreviewOnly: true,
      note: finalOutputCount > 0 ? "preview-only" : "no-outputs",
      reason: finalOutputCount > 0 ? "output-mode-preview-only" : "no-final-outputs",
    }
  }

  if (!driveArmed) {
    return {
      canSend: false,
      isPreviewOnly: false,
      note: "未 Arm，不会真实下发",
      reason: "drive-not-armed",
    }
  }

  if (!finalOutputCount) {
    return {
      canSend: false,
      isPreviewOnly: false,
      note: "无可下发 finalServoOutputs",
      reason: "no-final-outputs",
    }
  }

  // 历史 `"pwm"` 与 `"bus-servo"` 一律按总线门控
  if (!profilesReady) {
    return {
      canSend: false,
      isPreviewOnly: false,
      note: "无可用 actuator profile",
      reason: "no-actuator-profiles",
    }
  }
  if (!busSerialConnected) {
    const label = busFamilyLabel ? String(busFamilyLabel) : "总线"
    return {
      canSend: false,
      isPreviewOnly: false,
      note: `${label} 串口未连接`,
      reason: "bus-serial-not-connected",
    }
  }
  return { canSend: true, isPreviewOnly: false, note: "", reason: null }
}
