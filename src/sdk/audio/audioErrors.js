/**
 * 将 getUserMedia / MediaDevices 错误映射为页面可读状态。
 */

export const AUDIO_ERROR_CODES = Object.freeze({
  NotAllowedError: "NotAllowedError",
  NotFoundError: "NotFoundError",
  NotReadableError: "NotReadableError",
  OverconstrainedError: "OverconstrainedError",
  DeviceDisconnected: "DEVICE_DISCONNECTED",
  AudioWorkletUnsupported: "AUDIO_WORKLET_UNSUPPORTED",
  AudioWorkletLoadFailed: "AUDIO_WORKLET_LOAD_FAILED",
  AudioRuntimeStartFailed: "AUDIO_RUNTIME_START_FAILED",
  AudioRuntimeProcessingError: "AUDIO_RUNTIME_PROCESSING_ERROR",
  VoiceProviderConnectFailed: "VOICE_PROVIDER_CONNECT_FAILED",
  VoiceProviderSendFailed: "VOICE_PROVIDER_SEND_FAILED",
  VoiceSessionStartFailed: "VOICE_SESSION_START_FAILED",
  NoAudioInput: "NO_AUDIO_INPUT",
  MultiplePreferredDevices: "MULTIPLE_PREFERRED_DEVICES",
  Unknown: "UNKNOWN_ERROR",
})

export function classifyAudioError(error) {
  const name = String(error?.name || "")
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return {
      code: AUDIO_ERROR_CODES.NotAllowedError,
      message: "麦克风权限被拒绝。请在浏览器站点设置中允许麦克风后重试。",
    }
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return {
      code: AUDIO_ERROR_CODES.NotFoundError,
      message: "没有找到可用的音频输入设备。",
    }
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return {
      code: AUDIO_ERROR_CODES.NotReadableError,
      message: "无法打开麦克风（可能被其它程序占用）。",
    }
  }
  if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
    return {
      code: AUDIO_ERROR_CODES.OverconstrainedError,
      message: "当前音频约束无法满足。可改选其它设备，或放宽约束后重试。",
    }
  }
  if (name === "AbortError") {
    return {
      code: "AbortError",
      message: "音频请求被中止。",
    }
  }
  return {
    code: AUDIO_ERROR_CODES.Unknown,
    message: error?.message ? String(error.message) : "未知音频错误。",
  }
}
