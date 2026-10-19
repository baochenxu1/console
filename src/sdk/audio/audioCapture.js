/**
 * getUserMedia 采集与生命周期。
 * 支持 Native / Mono / Stereo Diagnostic 通道模式。
 * sampleRate / channelCount 以 track.getSettings() 为准。
 */

import { classifyAudioError } from "./audioErrors.js"

export const AUDIO_CAPTURE_CONSTRAINTS = Object.freeze({
  channelCountIdeal: 1,
  sampleRateIdeal: 16000,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
})

export const AUDIO_CHANNEL_MODES = Object.freeze({
  native: "native",
  mono: "mono",
  stereo: "stereo",
})

export const AUDIO_CHANNEL_MODE_LABELS = Object.freeze({
  native: "Native",
  mono: "Mono",
  stereo: "Stereo Diagnostic",
})

export function normalizeChannelMode(mode) {
  if (mode === AUDIO_CHANNEL_MODES.native) return AUDIO_CHANNEL_MODES.native
  if (mode === AUDIO_CHANNEL_MODES.stereo) return AUDIO_CHANNEL_MODES.stereo
  return AUDIO_CHANNEL_MODES.mono
}

export function requestedChannelCountForMode(mode) {
  const normalized = normalizeChannelMode(mode)
  if (normalized === AUDIO_CHANNEL_MODES.native) return null
  if (normalized === AUDIO_CHANNEL_MODES.stereo) return 2
  return 1
}

export function buildAudioCaptureConstraints(deviceId, channelMode = AUDIO_CHANNEL_MODES.mono) {
  const mode = normalizeChannelMode(channelMode)
  const audio = {
    sampleRate: { ideal: AUDIO_CAPTURE_CONSTRAINTS.sampleRateIdeal },
    echoCancellation: AUDIO_CAPTURE_CONSTRAINTS.echoCancellation,
    noiseSuppression: AUDIO_CAPTURE_CONSTRAINTS.noiseSuppression,
    autoGainControl: AUDIO_CAPTURE_CONSTRAINTS.autoGainControl,
  }
  if (mode === AUDIO_CHANNEL_MODES.mono) {
    audio.channelCount = { ideal: 1 }
  } else if (mode === AUDIO_CHANNEL_MODES.stereo) {
    audio.channelCount = { ideal: 2 }
  }
  // Native：不传 channelCount，让 Device / OS / Browser 自行决定。
  // Physical device 使用 exact；禁止对 default/communications 套 exact 语义。
  const id = String(deviceId || "").trim()
  if (id && id !== "default" && id !== "communications") {
    audio.deviceId = { exact: id }
  }
  return {
    audio,
    video: false,
    channelMode: mode,
    requestedChannels: requestedChannelCountForMode(mode),
  }
}

export function readTrackSettings(track) {
  if (!track || typeof track.getSettings !== "function") {
    return {
      sampleRate: null,
      sampleSize: null,
      channelCount: null,
      deviceId: null,
      groupId: null,
      echoCancellation: null,
      noiseSuppression: null,
      autoGainControl: null,
      latency: null,
    }
  }
  const settings = track.getSettings() || {}
  return {
    sampleRate: Number.isFinite(Number(settings.sampleRate)) ? Number(settings.sampleRate) : null,
    sampleSize: Number.isFinite(Number(settings.sampleSize)) ? Number(settings.sampleSize) : null,
    channelCount: Number.isFinite(Number(settings.channelCount)) ? Number(settings.channelCount) : null,
    deviceId: settings.deviceId ?? null,
    groupId: settings.groupId ?? null,
    echoCancellation: typeof settings.echoCancellation === "boolean" ? settings.echoCancellation : null,
    noiseSuppression: typeof settings.noiseSuppression === "boolean" ? settings.noiseSuppression : null,
    autoGainControl: typeof settings.autoGainControl === "boolean" ? settings.autoGainControl : null,
    latency: Number.isFinite(Number(settings.latency)) ? Number(settings.latency) : null,
  }
}

export function formatSettingValue(value) {
  if (value == null) return "N/A"
  if (typeof value === "boolean") return value ? "true" : "false"
  return String(value)
}

export async function startAudioCapture({
  deviceId,
  channelMode = AUDIO_CHANNEL_MODES.mono,
  mediaDevices = typeof navigator !== "undefined" ? navigator.mediaDevices : null,
} = {}) {
  if (!mediaDevices?.getUserMedia) {
    return {
      ok: false,
      ...classifyAudioError(new Error("当前环境不支持 getUserMedia")),
    }
  }
  try {
    const built = buildAudioCaptureConstraints(deviceId, channelMode)
    const { channelMode: mode, requestedChannels, ...constraints } = built
    const stream = await mediaDevices.getUserMedia(constraints)
    const track = stream.getAudioTracks()[0] || null
    if (!track) {
      for (const item of stream.getTracks()) item.stop()
      return {
        ok: false,
        code: "UNKNOWN_ERROR",
        message: "getUserMedia 成功但没有 audio track。",
      }
    }
    const settings = readTrackSettings(track)
    return {
      ok: true,
      stream,
      track,
      settings,
      constraints,
      channelMode: mode,
      requestedChannels,
      actualChannels: settings.channelCount,
      label: track.label || "",
      readyState: track.readyState,
      muted: Boolean(track.muted),
    }
  } catch (error) {
    console.error("[audioCapture] getUserMedia failed", error)
    return {
      ok: false,
      ...classifyAudioError(error),
      error,
    }
  }
}

export function stopAudioCapture(stream) {
  if (!stream) return
  for (const track of stream.getTracks?.() || []) {
    try {
      track.stop()
    } catch {
      /* ignore */
    }
  }
}

export function attachTrackEnded(track, onEnded) {
  if (!track || typeof onEnded !== "function") return () => {}
  const handler = () => onEnded()
  track.addEventListener("ended", handler)
  return () => track.removeEventListener("ended", handler)
}
