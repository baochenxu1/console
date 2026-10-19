/**
 * 浏览器麦克风设备枚举与 devicechange 监听。
 * 区分 Chromium pseudo alias（default / communications）与 physical deviceId。
 */

const PREFERRED_LABEL_HINTS = Object.freeze(["respeaker", "seeed", "xmos"])
const PSEUDO_DEVICE_IDS = Object.freeze(new Set(["default", "communications"]))

export function isPseudoAudioDeviceId(deviceId = "") {
  return PSEUDO_DEVICE_IDS.has(String(deviceId || "").trim())
}

export function isAudioInputDevice(device) {
  return device?.kind === "audioinput"
}

export function looksLikeRespeakerLabel(label = "") {
  const text = String(label || "").toLowerCase()
  return PREFERRED_LABEL_HINTS.some((hint) => text.includes(hint))
}

export function looksLikeRespeakerLiteLabel(label = "") {
  return /respeaker\s*lite/i.test(String(label || ""))
}

/**
 * @param {MediaDeviceInfo | object} device
 */
export function normalizeAudioInputDevice(device) {
  const deviceId = String(device?.deviceId || "").trim()
  const groupId = String(device?.groupId || "").trim()
  const label = String(device?.label || "").trim()
  const isDefaultAlias = deviceId === "default"
  const isCommunicationsAlias = deviceId === "communications"
  const isPhysical = Boolean(deviceId) && !isDefaultAlias && !isCommunicationsAlias
  const isReSpeaker = looksLikeRespeakerLabel(label)
  return {
    deviceId,
    groupId,
    label,
    kind: "audioinput",
    isDefaultAlias,
    isCommunicationsAlias,
    isPhysical,
    isReSpeaker,
    displayName: shortAudioInputLabel({ deviceId, label }),
  }
}

export function listPhysicalAudioInputs(devices = []) {
  return (devices || [])
    .map((item) => (item?.isPhysical != null ? item : normalizeAudioInputDevice(item)))
    .filter((item) => item.isPhysical)
}

export function listPseudoAudioInputs(devices = []) {
  return (devices || [])
    .map((item) => (item?.isDefaultAlias != null ? item : normalizeAudioInputDevice(item)))
    .filter((item) => item.isDefaultAlias || item.isCommunicationsAlias)
}

export function sortAudioInputDevices(devices = []) {
  const list = (devices || [])
    .filter(isAudioInputDevice)
    .map((item) => normalizeAudioInputDevice(item))
  return [...list].sort((a, b) => {
    // Physical ReSpeaker first, then other physical, then aliases last.
    const rank = (d) => {
      if (d.isPhysical && looksLikeRespeakerLiteLabel(d.label)) return 0
      if (d.isPhysical && d.isReSpeaker) return 1
      if (d.isPhysical) return 2
      if (d.isDefaultAlias) return 3
      if (d.isCommunicationsAlias) return 4
      return 5
    }
    const ra = rank(a)
    const rb = rank(b)
    if (ra !== rb) return ra - rb
    return String(a.label || a.deviceId).localeCompare(String(b.label || b.deviceId))
  })
}

export function formatDeviceLabel(device) {
  if (!device) return "未选择"
  const normalized = device.isPhysical != null ? device : normalizeAudioInputDevice(device)
  const label = String(normalized.label || "").trim()
  if (normalized.isDefaultAlias) return label ? `系统默认 · ${label}` : "系统默认"
  if (normalized.isCommunicationsAlias) return label ? `通讯 · ${label}` : "通讯"
  if (label) return normalized.isReSpeaker ? `${label} · 优先` : label
  const id = String(normalized.deviceId || "")
  if (!id) return "未知麦克风"
  return `麦克风（${id.slice(0, 8)}…）`
}

/** 主 Toolbar Select 用的短显示名（不改 deviceId 身份）。 */
export function shortAudioInputLabel(device) {
  if (!device) return "未选择"
  const full = String(device.label || "").trim()
  const id = String(device.deviceId || "")
  if (id === "default") return full ? `系统默认` : "系统默认"
  if (id === "communications") return "通讯"
  if (/respeaker\s*lite/i.test(full)) return "ReSpeaker Lite"
  if (/respeaker/i.test(full)) {
    const match = full.match(/ReSpeaker[^()]*/i)
    return (match?.[0] || "ReSpeaker").trim()
  }
  if (!full) {
    return id ? `麦克风（${id.slice(0, 8)}…）` : "未知麦克风"
  }
  if (full.length > 28) return `${full.slice(0, 26)}…`
  return full
}

export function shortDeviceId(deviceId = "") {
  const id = String(deviceId || "")
  if (!id) return "N/A"
  if (id.length <= 16) return id
  return `${id.slice(0, 8)}…${id.slice(-6)}`
}

export function sortAudioOutputDevices(devices = []) {
  const list = (devices || []).filter((device) => device?.kind === "audiooutput")
  return [...list].sort((a, b) => {
    const rank = (device) => {
      const id = String(device.deviceId || "")
      const label = String(device.label || "")
      if (id !== "default" && id !== "communications" && looksLikeRespeakerLiteLabel(label)) return 0
      if (id !== "default" && id !== "communications" && looksLikeRespeakerLabel(label)) return 1
      if (id === "default") return 2
      if (id === "communications") return 4
      return 3
    }
    const delta = rank(a) - rank(b)
    if (delta) return delta
    return String(a.label || a.deviceId).localeCompare(String(b.label || b.deviceId))
  })
}

export async function listAudioOutputDevices(mediaDevices = navigator.mediaDevices) {
  if (!mediaDevices?.enumerateDevices) {
    return { ok: false, devices: [], error: "当前环境不支持 enumerateDevices。" }
  }
  try {
    const all = await mediaDevices.enumerateDevices()
    return { ok: true, devices: sortAudioOutputDevices(all) }
  } catch (error) {
    return { ok: false, devices: [], error: error?.message || "枚举输出设备失败" }
  }
}

export function audioOutputSelectionSupported() {
  return typeof AudioContext !== "undefined" && typeof AudioContext.prototype?.setSinkId === "function"
}

export async function listAudioInputDevices(mediaDevices = navigator.mediaDevices) {
  if (!mediaDevices?.enumerateDevices) {
    return { ok: false, devices: [], error: "当前环境不支持 enumerateDevices。" }
  }
  try {
    const all = await mediaDevices.enumerateDevices()
    return { ok: true, devices: sortAudioInputDevices(all) }
  } catch (error) {
    return { ok: false, devices: [], error: error?.message || "枚举设备失败" }
  }
}

/**
 * 仅用于拿到权限，不绑定具体设备。调用方负责 stop。
 */
export async function requestMicrophonePermission(mediaDevices = navigator.mediaDevices) {
  if (!mediaDevices?.getUserMedia) {
    return { ok: false, stream: null, error: "当前环境不支持 getUserMedia。" }
  }
  try {
    const stream = await mediaDevices.getUserMedia({ audio: true, video: false })
    return { ok: true, stream }
  } catch (error) {
    return { ok: false, stream: null, error }
  }
}

export function stopMediaStream(stream) {
  if (!stream) return
  for (const track of stream.getTracks?.() || []) {
    try {
      track.stop()
    } catch {
      /* ignore */
    }
  }
}

export function subscribeDeviceChange(handler, mediaDevices = navigator.mediaDevices) {
  if (!mediaDevices || typeof handler !== "function") {
    return () => {}
  }
  const onChange = () => {
    try {
      handler()
    } catch {
      /* ignore */
    }
  }
  if (typeof mediaDevices.addEventListener === "function") {
    mediaDevices.addEventListener("devicechange", onChange)
    return () => mediaDevices.removeEventListener("devicechange", onChange)
  }
  mediaDevices.ondevicechange = onChange
  return () => {
    if (mediaDevices.ondevicechange === onChange) mediaDevices.ondevicechange = null
  }
}
