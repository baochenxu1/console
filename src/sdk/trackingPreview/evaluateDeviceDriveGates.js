import { DEVICE_DRIVE_QUALITY_MIN, OUTPUT_MODES } from "./trackingPreviewConstants.js"

/**
 * Device Drive 发送门控（不下发 ≠ 不映射预览）。仅总线舵机。
 * @param {object} params
 * @param {boolean} params.armed
 * @param {boolean} [params.cameraRunning]
 * @param {boolean} [params.serialConnected] 兼容旧调用方；与 busSerialConnected 等价
 * @param {boolean} [params.busSerialConnected]
 * @param {string} [params.busFamilyLabel] 当前选中族短名，如 RJ / SC/ST
 * @param {import("./trackingPreviewConstants.js").TrackingPreviewOutputMode} [params.outputMode]
 * @param {boolean} [params.profilesReady]
 * @param {boolean} params.faceDetected
 * @param {number} params.quality
 * @param {number} [params.qualityMin]
 * @param {boolean} [params.trackingRunning]
 * @param {boolean} [params.videoPaused]
 */
export function evaluateDeviceDriveGates({
  armed,
  cameraRunning = false,
  serialConnected,
  busSerialConnected = false,
  busFamilyLabel = "",
  outputMode = OUTPUT_MODES.BUS_SERVO,
  profilesReady = true,
  faceDetected,
  quality,
  qualityMin = DEVICE_DRIVE_QUALITY_MIN,
  trackingRunning = false,
  videoPaused = false,
}) {
  void outputMode
  const reasons = []
  if (!armed) {
    reasons.push("未 Arm")
  }
  if (videoPaused) {
    reasons.push("video 已暂停")
  }
  if (!trackingRunning && !cameraRunning) {
    reasons.push("tracking 未运行")
  }
  const busConnected = Boolean(busSerialConnected || serialConnected)
  if (!busConnected) {
    const label = busFamilyLabel ? String(busFamilyLabel) : "总线"
    reasons.push(`${label} 串口未连接`)
  }
  if (!profilesReady) {
    reasons.push("无总线 profile")
  }
  if (!faceDetected) {
    reasons.push("face=0")
  }
  if (Number(quality) < qualityMin) {
    reasons.push(`q<${qualityMin}`)
  }
  return {
    canSend: reasons.length === 0,
    reasons,
    note: reasons.join(" · "),
  }
}
