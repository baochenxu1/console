/**
 * AssemblyAI v3 Streaming 消息 → FaceDEV Provider events。
 */

import { VOICE_PROVIDER_EVENTS } from "../voiceProvider.js"

export const ASSEMBLYAI_PROVIDER_ERROR_CODES = Object.freeze({
  AuthFailed: "AUTH_FAILED",
  TokenFetchFailed: "TOKEN_FETCH_FAILED",
  WebSocketConnectFailed: "WEBSOCKET_CONNECT_FAILED",
  WebSocketClosed: "WEBSOCKET_CLOSED",
  StreamingError: "STREAMING_ERROR",
  ProviderProtocolError: "PROVIDER_PROTOCOL_ERROR",
  ProviderTerminateTimeout: "PROVIDER_TERMINATE_TIMEOUT",
})

export const ASSEMBLYAI_WS_BASE = "wss://streaming.assemblyai.com/v3/ws"
export const ASSEMBLYAI_SPEECH_MODEL = "universal-3-5-pro"
export const ASSEMBLYAI_LANGUAGE_CODES = Object.freeze(["zh"])

/**
 * @param {object} options
 * @param {string} options.token
 * @param {number} [options.sampleRate]
 * @param {string} [options.speechModel]
 * @param {string[]} [options.languageCodes]
 */
export function buildAssemblyAIWebSocketUrl({
  token,
  sampleRate = 16000,
  speechModel = ASSEMBLYAI_SPEECH_MODEL,
  languageCodes = ASSEMBLYAI_LANGUAGE_CODES,
  encoding = "pcm_s16le",
} = {}) {
  if (!token) throw new Error("缺少 temporary token")
  const url = new URL(ASSEMBLYAI_WS_BASE)
  url.searchParams.set("sample_rate", String(sampleRate))
  url.searchParams.set("encoding", encoding)
  url.searchParams.set("speech_model", speechModel)
  url.searchParams.set("token", token)
  if (Array.isArray(languageCodes) && languageCodes.length > 0) {
    url.searchParams.set("language_codes", JSON.stringify(languageCodes))
  }
  return url.toString()
}

/** 日志用：隐藏 token= 查询参数。 */
export function redactWebSocketUrl(url) {
  try {
    const parsed = new URL(url)
    if (parsed.searchParams.has("token")) {
      parsed.searchParams.set("token", "[redacted]")
    }
    return parsed.toString()
  } catch {
    return String(url || "").replace(/token=[^&]+/gi, "token=[redacted]")
  }
}

/**
 * @param {object|string} message
 * @param {() => number} [now]
 */
function defaultNow() {
  if (typeof globalThis.performance?.now === "function") {
    return globalThis.performance.now()
  }
  return Date.now()
}

export function mapAssemblyAIServerMessage(message, now = defaultNow) {
  let msg = message
  if (typeof message === "string") {
    try {
      msg = JSON.parse(message)
    } catch {
      return {
        ok: false,
        code: ASSEMBLYAI_PROVIDER_ERROR_CODES.ProviderProtocolError,
        reason: "invalid_json",
        message: "AssemblyAI 返回了无效 JSON。",
      }
    }
  }
  if (!msg || typeof msg !== "object") {
    return {
      ok: false,
      code: ASSEMBLYAI_PROVIDER_ERROR_CODES.ProviderProtocolError,
      reason: "empty",
      message: "AssemblyAI 消息为空。",
    }
  }

  const type = String(msg.type || "")
  const timestampMs = now()

  if (type === "Begin") {
    return { ok: true, kind: "begin", rawType: type, sessionId: msg.id, timestampMs }
  }
  if (type === "SpeechStarted") {
    return { ok: true, kind: "speech_started", rawType: type, timestampMs }
  }
  if (type === "Turn") {
    const text = String(msg.transcript || "")
    const final = Boolean(msg.end_of_turn)
    return {
      ok: true,
      kind: final ? "transcript_final" : "transcript_partial",
      event: final
        ? VOICE_PROVIDER_EVENTS.transcriptFinal
        : VOICE_PROVIDER_EVENTS.transcriptPartial,
      text,
      timestampMs,
      provider: "assemblyai",
      rawType: type,
      raw: { end_of_turn: msg.end_of_turn, turn_order: msg.turn_order },
    }
  }
  if (type === "Termination") {
    return { ok: true, kind: "termination", rawType: type, timestampMs, raw: msg }
  }
  if (type === "Error") {
    return {
      ok: false,
      code: ASSEMBLYAI_PROVIDER_ERROR_CODES.StreamingError,
      reason: "upstream_error",
      message: String(msg.error || msg.message || "AssemblyAI streaming error"),
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
