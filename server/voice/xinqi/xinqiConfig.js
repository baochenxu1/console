/**
 * Xinqi Engine Gateway 配置与协议常量。
 */

import { XINQI_ERROR_CODES, xinqiJsonError } from "./xinqiErrors.js"

export const DEFAULT_XINQI_BASE_URL = "http://127.0.0.1:3212"

export const XINQI_EXPECTED_PROTOCOL = Object.freeze({
  version: 1,
  inputAudio: Object.freeze({
    encoding: "pcm_s16le",
    sampleRate: 16000,
    channels: 1,
    frameBytes: 3200,
    frameMilliseconds: 100,
  }),
  outputAudio: Object.freeze({
    encoding: "pcm_s16le",
    sampleRate: 24000,
    channels: 1,
  }),
})

export const XINQI_GATEWAY_SESSION_TTL_MS = 60_000
export const XINQI_GATEWAY_MAX_SESSIONS = 16
export const XINQI_INPUT_FRAME_BYTES = 3200
export const XINQI_WS_MAX_PAYLOAD = 2 * 1024 * 1024
export const XINQI_BACKPRESSURE_BYTES = 1024 * 1024

export const XINQI_BROWSER_TO_UPSTREAM_TYPES = Object.freeze([
  "interrupt",
  "playback.progress",
  "playback.done",
  "vision.context",
  "vision.frame",
  "text",
])

export const XINQI_UPSTREAM_TO_BROWSER_TYPES = Object.freeze([
  "ready",
  "policy",
  "listening",
  "transcript.partial",
  "environment",
  "user",
  "turn.start",
  "turn.delta",
  "turn.vision",
  "search.status",
  "supervision",
  "turn.text.done",
  "audio",
  "audio.done",
  "turn.done",
  "turn.interrupted",
  "warning",
  "fatal",
  "vision.request",
  "identity.context",
  "proactive",
  "proactive.status",
  "error",
])

/**
 * @param {string} raw
 */
export function normalizeXinqiBaseUrl(raw) {
  const value = String(raw || "").trim() || DEFAULT_XINQI_BASE_URL
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return {
      ok: false,
      ...xinqiJsonError(XINQI_ERROR_CODES.InvalidBaseUrl, "XINQI_BASE_URL 非法。", 500),
    }
  }

  if (parsed.username || parsed.password) {
    return {
      ok: false,
      ...xinqiJsonError(XINQI_ERROR_CODES.InvalidBaseUrl, "XINQI_BASE_URL 不得包含用户名或密码。", 500),
    }
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      ...xinqiJsonError(XINQI_ERROR_CODES.InvalidBaseUrl, "XINQI_BASE_URL 仅支持 http/https。", 500),
    }
  }

  // strip trailing slash
  const href = parsed.toString().replace(/\/+$/, "")
  return {
    ok: true,
    baseUrl: href,
    origin: parsed.origin,
    wsBaseUrl: href.replace(/^http/i, "ws"),
  }
}

/**
 * @param {object} protocol
 */
export function validateXinqiProtocol(protocol) {
  const expected = XINQI_EXPECTED_PROTOCOL
  const actual = protocol && typeof protocol === "object" ? protocol : {}
  const input = actual.inputAudio || {}
  const output = actual.outputAudio || {}

  const mismatches = []
  if (Number(actual.version) !== expected.version) {
    mismatches.push({ field: "version", expected: expected.version, actual: actual.version ?? null })
  }
  for (const [key, value] of Object.entries(expected.inputAudio)) {
    if (input[key] !== value && Number(input[key]) !== value) {
      mismatches.push({ field: `inputAudio.${key}`, expected: value, actual: input[key] ?? null })
    }
  }
  for (const [key, value] of Object.entries(expected.outputAudio)) {
    if (output[key] !== value && Number(output[key]) !== value) {
      mismatches.push({ field: `outputAudio.${key}`, expected: value, actual: output[key] ?? null })
    }
  }

  if (mismatches.length > 0) {
    return {
      ok: false,
      ...xinqiJsonError(
        XINQI_ERROR_CODES.ProtocolUnsupported,
        "Xinqi Robot API 协议与当前 FaceDEV Gateway 不兼容。",
        502,
        {
          expected: {
            version: expected.version,
            inputAudio: { ...expected.inputAudio },
            outputAudio: { ...expected.outputAudio },
          },
          actual: {
            version: actual.version ?? null,
            sampleRate: input.sampleRate ?? null,
            frameBytes: input.frameBytes ?? null,
            outputSampleRate: output.sampleRate ?? null,
          },
          mismatches,
        },
      ),
    }
  }

  return {
    ok: true,
    protocol: {
      version: expected.version,
      inputAudio: { ...expected.inputAudio },
      outputAudio: { ...expected.outputAudio },
      websocketPath: String(actual.websocketPath || "/api/realtime"),
    },
  }
}
