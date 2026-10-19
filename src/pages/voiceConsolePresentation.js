/**
 * Voice Console presentation-only helpers.
 * No Audio Runtime / Provider / Backend side effects.
 */

import { shortAudioInputLabel, formatDeviceLabel } from "../sdk/audio/audioDevices.js"
import { VOICE_AUDIO_FORMAT } from "../sdk/audio/audioFrame.js"
import { VOICE_SESSION_STATES } from "../sdk/voice/voiceSession.js"

export const VOICE_HELP = Object.freeze({
  pageTitle: "用于验证麦克风采集、实时语音 Provider 与识别链路。",
  pcm16k: "Voice Runtime 输出：16 kHz / Mono / PCM S16LE。",
  sessionIdle: "当前没有活动语音会话。",
  sessionLive: "麦克风、Audio Runtime 与 Provider 均已连接。",
  sessionConnecting: "正在准备音频设备并连接 Provider。",
  sessionStopping: "正在安全结束语音会话。",
  sessionError: "会话异常。可查看下方状态摘要或 Advanced 详情。",
  inputActivity: "基于当前麦克风 RMS / Peak 的实时输入强度，仅用于反馈，不是 VAD。",
  rms: "当前音频信号的均方根强度。",
  peak: "当前采样窗口内的峰值幅度。",
  runtimeRate: "浏览器 AudioContext 输入采样率 → FaceDEV Voice Runtime 标准输出采样率。",
  pcm16Mono: "Runtime 输出为 16-bit little-endian 单声道 PCM。",
  frame20ms: "每个内部 AudioFrame 为 20 ms。",
  dropped: "因处理或发送压力未成功交给 Provider 的音频帧。",
  invalid: "未通过 AudioFrame 格式校验的帧。",
  transportAssemblyAI: "AssemblyAI：5 × 20 ms AudioFrame 聚合为 100 ms 后发送。",
  transportXinqi: "Xinqi：5 × 20 ms AudioFrame 聚合为 100 ms / 3200 B 后经 Gateway 发送。",
  transportMock: "本地测试 Provider，不发送网络请求。",
  providerMock: "本地测试 Provider，不发送网络请求。",
  providerAssemblyAI: "Streaming STT Provider；使用 100 ms PCM chunk。",
  providerXinqi: "心契 Xinqi：经本地 Gateway 发送 100 ms / 3200 B PCM，接收用户识别与 AI 文字回复。",
  authTemporary: "通过本地后端换取的临时身份，不会把永久 API Key 暴露到浏览器。",
  authNone: "当前 Provider 无需临时身份认证。",
  authNotRequired: "Mock Provider 不需要网络身份。",
})

export function shortDeviceDisplayName(device, { preferredDeviceId = "" } = {}) {
  const base = shortAudioInputLabel(device)
  if (preferredDeviceId && device?.deviceId && device.deviceId === preferredDeviceId) {
    return `${base} · 优先`
  }
  return base
}

export function fullDeviceLabel(device) {
  if (!device) return "未选择麦克风"
  return formatDeviceLabel(device)
}

export function providerDisplayInfo(providerId) {
  if (providerId === "mock") {
    return { label: "Mock", tip: VOICE_HELP.providerMock }
  }
  if (providerId === "assemblyai") {
    return { label: "AssemblyAI", tip: VOICE_HELP.providerAssemblyAI }
  }
  if (providerId === "deepgram") {
    return { label: "Deepgram", tip: VOICE_HELP.providerDeepgram }
  }
  if (providerId === "xinqi") {
    return { label: "Xinqi", tip: VOICE_HELP.providerXinqi }
  }
  return { label: providerId || "—", tip: "" }
}

export function sessionDisplayInfo(sessionState, { listening = false, errorSummary = "" } = {}) {
  if (sessionState === VOICE_SESSION_STATES.STARTING) {
    return { badge: "Connecting", live: "Connecting", tip: VOICE_HELP.sessionConnecting, tone: "warn" }
  }
  if (sessionState === VOICE_SESSION_STATES.STOPPING) {
    return { badge: "Stopping", live: "Stopping", tip: VOICE_HELP.sessionStopping, tone: "warn" }
  }
  if (sessionState === VOICE_SESSION_STATES.ERROR) {
    return {
      badge: "Error",
      live: "Error",
      tip: errorSummary ? String(errorSummary).slice(0, 120) : VOICE_HELP.sessionError,
      tone: "danger",
    }
  }
  if (sessionState === VOICE_SESSION_STATES.RUNNING) {
    return {
      badge: listening ? "Listening" : "Live",
      live: "Live",
      tip: VOICE_HELP.sessionLive,
      tone: "ok",
    }
  }
  return { badge: "Ready", live: "Idle", tip: VOICE_HELP.sessionIdle, tone: "neutral" }
}

export function transportDisplayInfo(providerId, stats) {
  if (providerId === "mock") {
    return { short: "Local", tip: VOICE_HELP.transportMock }
  }
  if (providerId === "assemblyai") {
    return { short: "100 ms", tip: VOICE_HELP.transportAssemblyAI }
  }
  if (providerId === "deepgram") {
    return { short: "20 ms", tip: VOICE_HELP.transportDeepgram }
  }
  if (providerId === "xinqi") {
    return { short: "100 ms", tip: VOICE_HELP.transportXinqi }
  }
  if (stats?.chunkDurationMs === 20) return { short: "20 ms", tip: VOICE_HELP.transportDeepgram }
  if (stats?.chunkDurationMs === 100) return { short: "100 ms", tip: VOICE_HELP.transportAssemblyAI }
  return { short: "—", tip: "" }
}

export function transportPolicyLabel(providerId, stats) {
  return transportDisplayInfo(providerId, stats).short
}

export function formatAuthLabel(providerId, authState) {
  if (providerId === "mock") return "Not Required"
  if (authState === "GATEWAY_SESSION") return "Gateway Session"
  if (authState === "REQUESTING") return "Requesting"
  if (authState === "ERROR") return "Error"
  return authState || "None"
}

export function authTooltip(providerId, authState) {
  if (providerId === "mock") return VOICE_HELP.authNotRequired
  if (authState === "TEMP_TOKEN") return VOICE_HELP.authTemporary
  if (!authState || authState === "NONE" || authState === "None") return VOICE_HELP.authNone
  return formatAuthLabel(providerId, authState)
}

export function formatStreamingLabel(providerId, streamingState, sessionState) {
  if (providerId === "mock") {
    return sessionState === VOICE_SESSION_STATES.RUNNING ? "Active (Mock)" : "Disconnected"
  }
  return streamingState || "Disconnected"
}

export function primaryActionLabel(sessionState) {
  if (sessionState === VOICE_SESSION_STATES.STARTING) return "正在连接…"
  if (sessionState === VOICE_SESSION_STATES.STOPPING) return "正在结束…"
  if (sessionState === VOICE_SESSION_STATES.RUNNING) return "结束会话"
  if (sessionState === VOICE_SESSION_STATES.ERROR) return "重新连接"
  return "连接并开始"
}

export function shortErrorSummary(message, max = 48) {
  const text = String(message || "").trim()
  if (!text) return ""
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

export function runtimeFrameMeta() {
  return {
    short: `PCM16 · Mono · ${VOICE_AUDIO_FORMAT.frameDurationMs} ms`,
    tip: `${VOICE_HELP.pcm16Mono} ${VOICE_HELP.frame20ms}`,
  }
}
