/**
 * Mock Voice Provider：不联网，只校验并统计 AudioFrame。
 */

import { validateAudioFrame } from "../audio/audioFrame.js"
import { AUDIO_ERROR_CODES } from "../audio/audioErrors.js"
import {
  VOICE_PROVIDER_EVENTS,
  VOICE_PROVIDER_STATES,
  createEventBus,
} from "./voiceProvider.js"

export function createMockVoiceProvider() {
  const bus = createEventBus()
  let state = VOICE_PROVIDER_STATES.IDLE
  let lastSequence = null
  const stats = {
    framesReceived: 0,
    bytesReceived: 0,
    invalidFrames: 0,
  }

  function setState(next) {
    state = next
  }

  async function connect() {
    if (state === VOICE_PROVIDER_STATES.CONNECTED || state === VOICE_PROVIDER_STATES.CONNECTING) {
      return { ok: true, state }
    }
    setState(VOICE_PROVIDER_STATES.CONNECTING)
    setState(VOICE_PROVIDER_STATES.CONNECTED)
    lastSequence = null
    bus.emit(VOICE_PROVIDER_EVENTS.connected, { provider: "mock" })
    return { ok: true, state }
  }

  function sendAudio(frame) {
    if (state !== VOICE_PROVIDER_STATES.CONNECTED) {
      return { ok: false, code: AUDIO_ERROR_CODES.VoiceProviderSendFailed, error: "Provider 未连接" }
    }
    const validated = validateAudioFrame(frame)
    if (!validated.ok) {
      stats.invalidFrames += 1
      console.error("[mockVoiceProvider] invalid frame", validated, frame)
      bus.emit(VOICE_PROVIDER_EVENTS.error, {
        code: AUDIO_ERROR_CODES.VoiceProviderSendFailed,
        message: validated.message,
        reason: validated.reason,
      })
      return { ok: false, ...validated }
    }
    if (lastSequence != null && Number(frame.sequence) !== lastSequence + 1) {
      stats.invalidFrames += 1
      const message = `sequence 不连续：期望 ${lastSequence + 1}，收到 ${frame.sequence}`
      console.error("[mockVoiceProvider]", message)
      bus.emit(VOICE_PROVIDER_EVENTS.error, {
        code: AUDIO_ERROR_CODES.VoiceProviderSendFailed,
        message,
        reason: "sequence",
      })
      return { ok: false, reason: "sequence", message }
    }
    lastSequence = Number(frame.sequence)
    stats.framesReceived += 1
    stats.bytesReceived += frame.byteLength || 0
    return { ok: true }
  }

  async function disconnect() {
    if (state === VOICE_PROVIDER_STATES.IDLE) return { ok: true, state }
    setState(VOICE_PROVIDER_STATES.DISCONNECTING)
    setState(VOICE_PROVIDER_STATES.IDLE)
    lastSequence = null
    bus.emit(VOICE_PROVIDER_EVENTS.disconnected, { provider: "mock" })
    return { ok: true, state }
  }

  return {
    id: "mock",
    label: "Mock",
    connect,
    sendAudio,
    disconnect,
    onEvent: bus.on,
    getState: () => state,
    getStats: () => ({ ...stats }),
  }
}
