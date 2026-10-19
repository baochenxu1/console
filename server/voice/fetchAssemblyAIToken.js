/**
 * AssemblyAI temporary streaming token（服务端专用）。
 */

import { VOICE_TOKEN_ERROR_CODES, jsonError } from "./errors.js"

export const ASSEMBLYAI_TOKEN_URL = "https://streaming.assemblyai.com/v3/token"
export const DEFAULT_EXPIRES_IN_SECONDS = 60

/** 避免 `const f = globalThis.fetch; f()` 在部分运行时 Illegal invocation。 */
function defaultFetch(...args) {
  return globalThis.fetch(...args)
}

/**
 * @param {object} options
 * @param {string} [options.apiKey]
 * @param {number} [options.expiresInSeconds]
 * @param {typeof fetch} [options.fetchImpl]
 */
export async function fetchAssemblyAITemporaryToken({
  apiKey = process.env.ASSEMBLYAI_API_KEY,
  expiresInSeconds = DEFAULT_EXPIRES_IN_SECONDS,
  fetchImpl = defaultFetch,
} = {}) {
  const key = String(apiKey || "").trim()
  if (!key) {
    return jsonError(
      VOICE_TOKEN_ERROR_CODES.MissingServerApiKey,
      "服务器未配置 ASSEMBLYAI_API_KEY。",
      500,
    )
  }

  const url = new URL(ASSEMBLYAI_TOKEN_URL)
  url.searchParams.set("expires_in_seconds", String(expiresInSeconds))

  let response
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: key,
      },
    })
  } catch (error) {
    console.error("[voiceToken] upstream unavailable", error?.name || error)
    return jsonError(
      VOICE_TOKEN_ERROR_CODES.UpstreamUnavailable,
      "无法连接 AssemblyAI token 服务。",
      502,
    )
  }

  if (response.status === 401 || response.status === 403) {
    console.error("[voiceToken] upstream auth failed", response.status)
    return jsonError(
      VOICE_TOKEN_ERROR_CODES.UpstreamAuthFailed,
      "AssemblyAI API Key 鉴权失败。",
      502,
    )
  }

  let data = null
  try {
    data = await response.json()
  } catch {
    data = null
  }

  if (!response.ok || !data?.token) {
    console.error("[voiceToken] upstream token failed", response.status)
    return jsonError(
      VOICE_TOKEN_ERROR_CODES.UpstreamTokenFailed,
      "AssemblyAI temporary token 获取失败。",
      502,
    )
  }

  const expiresIn = Number(data.expires_in_seconds) || Number(expiresInSeconds) || DEFAULT_EXPIRES_IN_SECONDS
  return {
    status: 200,
    body: {
      provider: "assemblyai",
      token: String(data.token),
      expiresIn,
    },
  }
}
