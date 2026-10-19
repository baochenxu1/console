/**
 * Deepgram temporary JWT（服务端专用）。
 * POST https://api.deepgram.com/v1/auth/grant
 */

import { VOICE_TOKEN_ERROR_CODES, jsonError } from "./errors.js"

export const DEEPGRAM_TOKEN_URL = "https://api.deepgram.com/v1/auth/grant"
export const DEEPGRAM_TTL_SECONDS = 30

function defaultFetch(...args) {
  return globalThis.fetch(...args)
}

/**
 * @param {object} options
 * @param {string} [options.apiKey]
 * @param {number} [options.ttlSeconds]
 * @param {typeof fetch} [options.fetchImpl]
 */
export async function fetchDeepgramTemporaryToken({
  apiKey = process.env.DEEPGRAM_API_KEY,
  ttlSeconds = DEEPGRAM_TTL_SECONDS,
  fetchImpl = defaultFetch,
} = {}) {
  const key = String(apiKey || "").trim()
  if (!key) {
    return jsonError(
      VOICE_TOKEN_ERROR_CODES.MissingServerApiKey,
      "服务器未配置 DEEPGRAM_API_KEY。",
      500,
    )
  }

  const ttl = Number(ttlSeconds) || DEEPGRAM_TTL_SECONDS
  let response
  try {
    response = await fetchImpl(DEEPGRAM_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Token ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl_seconds: ttl }),
    })
  } catch (error) {
    console.error("[voiceToken:deepgram] upstream unavailable", error?.name || error)
    return jsonError(
      VOICE_TOKEN_ERROR_CODES.UpstreamUnavailable,
      "无法连接 Deepgram token 服务。",
      502,
    )
  }

  if (response.status === 401) {
    console.error("[voiceToken:deepgram] upstream auth failed", response.status)
    return jsonError(
      VOICE_TOKEN_ERROR_CODES.UpstreamAuthFailed,
      "Deepgram API Key 鉴权失败。",
      502,
    )
  }

  if (response.status === 403) {
    console.error("[voiceToken:deepgram] upstream permission denied", response.status)
    return jsonError(
      VOICE_TOKEN_ERROR_CODES.UpstreamPermissionDenied,
      "Deepgram API Key 权限不足（需要 Member 或更高权限才能签发 temporary token）。",
      502,
    )
  }

  let data = null
  try {
    data = await response.json()
  } catch {
    data = null
  }

  if (!response.ok || !data?.access_token) {
    console.error("[voiceToken:deepgram] upstream token failed", response.status)
    return jsonError(
      VOICE_TOKEN_ERROR_CODES.UpstreamTokenFailed,
      "Deepgram temporary token 获取失败。",
      502,
    )
  }

  const expiresIn = Number(data.expires_in) || ttl
  return {
    status: 200,
    body: {
      provider: "deepgram",
      token: String(data.access_token),
      expiresIn,
    },
  }
}
