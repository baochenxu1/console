/**
 * Xinqi realtime JSON → FaceDEV 平台无关事件。
 * turn.delta.text 是增量（Xinqi pushText 发送的是本段新增文字）。
 */

import { VOICE_PROVIDER_EVENTS } from "../voiceProvider.js"

export const XINQI_PROVIDER_ERROR_CODES = Object.freeze({
  Unreachable: "XINQI_UNREACHABLE",
  AuthFailed: "XINQI_AUTH_FAILED",
  ProtocolUnsupported: "XINQI_PROTOCOL_UNSUPPORTED",
  WsConnectFailed: "XINQI_WS_CONNECT_FAILED",
  InvalidAudioFrame: "XINQI_INVALID_AUDIO_FRAME",
  Backpressure: "XINQI_BACKPRESSURE",
  Fatal: "XINQI_FATAL",
  SessionFailed: "XINQI_CONNECT_FAILED",
  WsClosed: "XINQI_WS_CLOSED",
})

export const XINQI_CHUNK_DURATION_MS = 100
export const XINQI_CHUNK_BYTES = 3200
export const XINQI_BACKPRESSURE_BYTES = 512 * 1024

/**
 * @param {object|string} message
 */
export function mapXinqiServerMessage(message) {
  let msg = message
  if (typeof message === "string") {
    try {
      msg = JSON.parse(message)
    } catch {
      return { ok: false, code: XINQI_PROVIDER_ERROR_CODES.SessionFailed, message: "Xinqi 返回了无效 JSON。" }
    }
  }
  if (!msg || typeof msg !== "object") {
    return { ok: false, code: XINQI_PROVIDER_ERROR_CODES.SessionFailed, message: "Xinqi 消息为空。" }
  }

  const type = String(msg.type || "")
  if (type === "policy") return { ok: true, kind: "policy", rawType: type }
  if (type === "ready") return { ok: true, kind: "ready", rawType: type, microphone: Boolean(msg.microphone) }
  if (type === "listening") return { ok: true, kind: "listening", rawType: type }
  if (type === "environment") {
    return {
      ok: true,
      kind: "environment",
      rawType: type,
      environmentState: String(msg.state || ""),
      environmentTarget: String(msg.target || ""),
      environmentReason: String(msg.reason || "").slice(0, 160),
    }
  }
  if (type === "transcript.partial") {
    return {
      ok: true,
      kind: "user_partial",
      rawType: type,
      event: VOICE_PROVIDER_EVENTS.transcriptPartial,
      text: String(msg.text || ""),
    }
  }
  if (type === "user") {
    const text = String(msg.message?.content || msg.text || "").trim()
    return {
      ok: true,
      kind: "user_final",
      rawType: type,
      event: VOICE_PROVIDER_EVENTS.transcriptFinal,
      text,
      role: "user",
    }
  }
  if (type === "turn.start") {
    return {
      ok: true,
      kind: "assistant_start",
      rawType: type,
      event: VOICE_PROVIDER_EVENTS.assistantStart,
      turnId: msg.id || null,
    }
  }
  if (type === "turn.delta") {
    return {
      ok: true,
      kind: "assistant_delta",
      rawType: type,
      event: VOICE_PROVIDER_EVENTS.assistantDelta,
      turnId: msg.id || null,
      text: String(msg.text || ""),
      incremental: true,
    }
  }
  if (type === "turn.text.done") {
    const full = String(msg.message?.content || "")
    return {
      ok: true,
      kind: "assistant_done",
      rawType: type,
      event: VOICE_PROVIDER_EVENTS.assistantTextDone,
      turnId: msg.id || msg.message?.turnId || null,
      text: full,
    }
  }
  if (type === "turn.interrupted") {
    return {
      ok: true,
      kind: "assistant_interrupted",
      rawType: type,
      event: VOICE_PROVIDER_EVENTS.turnInterrupted,
      turnId: msg.id || null,
    }
  }
  if (type === "audio") {
    const data = typeof msg.data === "string" ? msg.data : ""
    return {
      ok: true,
      kind: "audio",
      rawType: type,
      event: VOICE_PROVIDER_EVENTS.audioDelta,
      turnId: msg.id || null,
      sampleRate: Number(msg.sampleRate) || 24000,
      data,
      encodedBytes: data.length,
    }
  }
  if (type === "audio.done") {
    return {
      ok: true,
      kind: "audio_done",
      rawType: type,
      event: VOICE_PROVIDER_EVENTS.audioDone,
      turnId: msg.id || null,
    }
  }
  if (type === "turn.done") {
    return {
      ok: true,
      kind: "turn_done",
      rawType: type,
      event: VOICE_PROVIDER_EVENTS.turnDone,
      turnId: msg.id || null,
    }
  }
  if (type === "warning") {
    return { ok: true, kind: "warning", rawType: type, message: String(msg.message || "").slice(0, 160) }
  }
  if (type === "fatal") {
    return {
      ok: false,
      kind: "fatal",
      rawType: type,
      code: XINQI_PROVIDER_ERROR_CODES.Fatal,
      message: String(msg.message || "Xinqi 会话失败。"),
    }
  }
  if (type === "error") {
    return {
      ok: false,
      kind: "gateway_error",
      rawType: type,
      code: String(msg.code || XINQI_PROVIDER_ERROR_CODES.SessionFailed),
      message: String(msg.message || "Xinqi Gateway 错误。"),
      closeSide: String(msg.closeSide || ""),
      closeCode: Number.isInteger(msg.closeCode) ? msg.closeCode : null,
      closeReason: String(msg.closeReason || "").slice(0, 120),
      cleanupReason: String(msg.cleanupReason || "").slice(0, 80),
      connectionMs: Number.isFinite(msg.connectionMs) ? Math.round(msg.connectionMs) : null,
      expectedBytes: Number.isInteger(msg.expectedBytes) ? msg.expectedBytes : null,
      actualBytes: Number.isInteger(msg.actualBytes) ? msg.actualBytes : null,
      dataType: String(msg.dataType || "").slice(0, 40),
      byteOffset: Number.isInteger(msg.byteOffset) ? msg.byteOffset : null,
      stage: String(msg.stage || "gateway").slice(0, 40),
    }
  }
  return { ok: true, kind: "ignored", rawType: type || "unknown" }
}
