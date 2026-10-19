/**
 * Deepgram Streaming Listen 协议辅助：URL / auth / transcript join / Results 映射。
 */

import { VOICE_PROVIDER_EVENTS } from "../voiceProvider.js"

export const DEEPGRAM_PROVIDER_ERROR_CODES = Object.freeze({
  TokenFetchFailed: "DEEPGRAM_TOKEN_FAILED",
  WebSocketConnectFailed: "DEEPGRAM_WS_CONNECT_FAILED",
  WebSocketClosed: "DEEPGRAM_WS_CLOSED",
  ProtocolError: "DEEPGRAM_PROTOCOL_ERROR",
  FinalizeTimeout: "DEEPGRAM_FINALIZE_TIMEOUT",
  StreamingError: "STREAMING_ERROR",
})

export const DEEPGRAM_WS_BASE = "wss://api.deepgram.com/v1/listen"
export const DEEPGRAM_SPEECH_MODEL = "nova-3"
export const DEEPGRAM_LANGUAGE = "zh-CN"
export const DEEPGRAM_LANGUAGE_CODES = Object.freeze([DEEPGRAM_LANGUAGE])
export const DEEPGRAM_CHUNK_DURATION_MS = 20
export const DEEPGRAM_CHUNK_BYTES = 640
export const DEEPGRAM_ENDPOINTING_MS = 300
export const DEEPGRAM_UTTERANCE_END_MS = 1000

function defaultNow() {
  if (typeof globalThis.performance?.now === "function") {
    return globalThis.performance.now()
  }
  return Date.now()
}

function isCjkChar(ch) {
  return /[\u3400-\u9FFF\uF900-\uFAFF]/.test(ch)
}

function shouldInsertSpace(leftText, rightText) {
  if (!leftText || !rightText) return false
  const left = leftText.slice(-1)
  const right = rightText.charAt(0)
  if (!left || !right) return false
  if (/\s/.test(left) || /\s/.test(right)) return false
  if (/[，。！？、；：,.!?;:…]/.test(left)) return false
  if (isCjkChar(left) || isCjkChar(right)) return false
  return /[A-Za-z0-9]/.test(left) && /[A-Za-z0-9]/.test(right)
}

/**
 * 轻量 transcript segment 拼接：CJK 直接相连，拉丁/数字词边界插空格。
 * @param {string[]} segments
 */
export function joinTranscriptSegments(segments) {
  let out = ""
  for (const raw of segments || []) {
    const seg = String(raw || "")
    if (!seg) continue
    if (!out) {
      out = seg
      continue
    }
    out += shouldInsertSpace(out, seg) ? ` ${seg}` : seg
  }
  return out
}

/**
 * @param {string[]} stableSegments
 * @param {string} [interim]
 */
export function composeCurrentTranscript(stableSegments, interim = "") {
  const stable = joinTranscriptSegments(stableSegments)
  const live = String(interim || "")
  if (!stable) return live
  if (!live) return stable
  return shouldInsertSpace(stable, live) ? `${stable} ${live}` : `${stable}${live}`
}

/**
 * @param {object} [options]
 */
export function buildDeepgramWebSocketUrl({
  model = DEEPGRAM_SPEECH_MODEL,
  language = DEEPGRAM_LANGUAGE,
  encoding = "linear16",
  sampleRate = 16000,
  channels = 1,
  interimResults = true,
  smartFormat = true,
  punctuate = true,
  endpointing = DEEPGRAM_ENDPOINTING_MS,
  vadEvents = true,
  utteranceEndMs = DEEPGRAM_UTTERANCE_END_MS,
} = {}) {
  const url = new URL(DEEPGRAM_WS_BASE)
  url.searchParams.set("model", model)
  url.searchParams.set("language", language)
  url.searchParams.set("encoding", encoding)
  url.searchParams.set("sample_rate", String(sampleRate))
  url.searchParams.set("channels", String(channels))
  url.searchParams.set("interim_results", interimResults ? "true" : "false")
  url.searchParams.set("smart_format", smartFormat ? "true" : "false")
  url.searchParams.set("punctuate", punctuate ? "true" : "false")
  url.searchParams.set("endpointing", String(endpointing))
  if (vadEvents) url.searchParams.set("vad_events", "true")
  if (utteranceEndMs != null) url.searchParams.set("utterance_end_ms", String(utteranceEndMs))
  return url.toString()
}

/**
 * Browser WebSocket：JWT 必须用 bearer scheme（非 token）。
 * @param {string} temporaryToken
 */
export function buildDeepgramWebSocketProtocols(temporaryToken) {
  const token = String(temporaryToken || "")
  if (!token) throw new Error("缺少 Deepgram temporary token")
  return ["bearer", token]
}

/** 日志用：Deepgram URL 本身不含 token，仍统一脱敏。 */
export function redactDeepgramWebSocketUrl(url) {
  try {
    const parsed = new URL(url)
    if (parsed.searchParams.has("access_token")) {
      parsed.searchParams.set("access_token", "[redacted]")
    }
    if (parsed.searchParams.has("token")) {
      parsed.searchParams.set("token", "[redacted]")
    }
    return parsed.toString()
  } catch {
    return String(url || "")
      .replace(/access_token=[^&]+/gi, "access_token=[redacted]")
      .replace(/token=[^&]+/gi, "token=[redacted]")
  }
}

/**
 * @param {object|string} message
 * @param {() => number} [now]
 */
export function mapDeepgramServerMessage(message, now = defaultNow) {
  let msg = message
  if (typeof message === "string") {
    try {
      msg = JSON.parse(message)
    } catch {
      return {
        ok: false,
        code: DEEPGRAM_PROVIDER_ERROR_CODES.ProtocolError,
        reason: "invalid_json",
        message: "Deepgram 返回了无效 JSON。",
      }
    }
  }
  if (!msg || typeof msg !== "object") {
    return {
      ok: false,
      code: DEEPGRAM_PROVIDER_ERROR_CODES.ProtocolError,
      reason: "empty",
      message: "Deepgram 消息为空。",
    }
  }

  const type = String(msg.type || "")
  const timestampMs = now()

  if (type === "Results") {
    const alt = msg.channel?.alternatives?.[0]
    const text = String(alt?.transcript || "")
    const isFinal = Boolean(msg.is_final)
    const speechFinal = Boolean(msg.speech_final)
    const fromFinalize = Boolean(msg.from_finalize)
    return {
      ok: true,
      kind: "results",
      rawType: type,
      text,
      isFinal,
      speechFinal,
      fromFinalize,
      timestampMs,
      provider: "deepgram",
      eventPartial: VOICE_PROVIDER_EVENTS.transcriptPartial,
      eventFinal: VOICE_PROVIDER_EVENTS.transcriptFinal,
      raw: {
        is_final: msg.is_final,
        speech_final: msg.speech_final,
        from_finalize: msg.from_finalize,
      },
    }
  }

  if (type === "Metadata") {
    return { ok: true, kind: "metadata", rawType: type, timestampMs, raw: msg }
  }
  if (type === "SpeechStarted") {
    return { ok: true, kind: "speech_started", rawType: type, timestampMs }
  }
  if (type === "UtteranceEnd") {
    return { ok: true, kind: "utterance_end", rawType: type, timestampMs, raw: msg }
  }
  if (type === "Error") {
    return {
      ok: false,
      code: DEEPGRAM_PROVIDER_ERROR_CODES.StreamingError,
      reason: "upstream_error",
      message: String(msg.description || msg.message || msg.error || "Deepgram streaming error"),
      rawType: type,
      timestampMs,
    }
  }

  return {
    ok: true,
    kind: "ignored",
    rawType: type || "unknown",
    timestampMs,
  }
}
