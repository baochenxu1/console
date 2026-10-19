/**
 * 平台无关 VoiceProvider 契约。
 */

export const VOICE_PROVIDER_STATES = Object.freeze({
  IDLE: "IDLE",
  CONNECTING: "CONNECTING",
  CONNECTED: "CONNECTED",
  DISCONNECTING: "DISCONNECTING",
  ERROR: "ERROR",
})

export const VOICE_PROVIDER_EVENTS = Object.freeze({
  connected: "connected",
  disconnected: "disconnected",
  transcriptPartial: "transcript.partial",
  transcriptFinal: "transcript.final",
  assistantStart: "assistant.start",
  assistantDelta: "assistant.delta",
  assistantTextDone: "assistant.text.done",
  trace: "trace",
  error: "error",
  audioDelta: "audio.delta",
  audioDone: "audio.done",
  turnInterrupted: "turn.interrupted",
  turnDone: "turn.done",
})

export function createEventBus() {
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map()

  function on(type, handler) {
    if (typeof handler !== "function") return () => {}
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type).add(handler)
    return () => off(type, handler)
  }

  function off(type, handler) {
    listeners.get(type)?.delete(handler)
  }

  function emit(type, payload) {
    const set = listeners.get(type)
    if (!set) return
    for (const handler of [...set]) {
      try {
        handler(payload)
      } catch (error) {
        console.error("[voiceProvider] event handler failed", type, error)
      }
    }
  }

  function clear() {
    listeners.clear()
  }

  return { on, off, emit, clear }
}
