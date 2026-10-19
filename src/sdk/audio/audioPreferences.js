/**
 * Voice Console 非敏感偏好（physical deviceId / label / groupId snapshot）。
 * 不保存 transcript / token / API key。
 * 禁止保存 Chromium pseudo id：default / communications。
 */

import { isPseudoAudioDeviceId } from "./audioDevices.js"

export const VOICE_PREFERRED_AUDIO_INPUT_KEY = "facedev.voice.preferredAudioInput"

/**
 * @returns {{ deviceId: string, label: string, groupId: string } | null}
 */
export function loadPreferredAudioInput(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem?.(VOICE_PREFERRED_AUDIO_INPUT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    const deviceId = String(parsed?.deviceId || "").trim()
    if (!deviceId || isPseudoAudioDeviceId(deviceId)) {
      // Migration：旧 preference 可能保存了 default/communications → 视为无效。
      return null
    }
    return {
      deviceId,
      label: String(parsed?.label || "").trim(),
      groupId: String(parsed?.groupId || "").trim(),
    }
  } catch {
    return null
  }
}

/**
 * @param {{ deviceId: string, label?: string, groupId?: string }} preference
 */
export function savePreferredAudioInput(preference, storage = globalThis.localStorage) {
  const deviceId = String(preference?.deviceId || "").trim()
  if (!deviceId || isPseudoAudioDeviceId(deviceId) || !storage?.setItem) return false
  try {
    storage.setItem(
      VOICE_PREFERRED_AUDIO_INPUT_KEY,
      JSON.stringify({
        deviceId,
        label: String(preference?.label || "").trim(),
        groupId: String(preference?.groupId || "").trim(),
      }),
    )
    return true
  } catch {
    return false
  }
}

export function clearPreferredAudioInput(storage = globalThis.localStorage) {
  try {
    storage?.removeItem?.(VOICE_PREFERRED_AUDIO_INPUT_KEY)
    return true
  } catch {
    return false
  }
}
