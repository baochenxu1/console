/**
 * GET /api/voice/token?provider=assemblyai|deepgram
 * + Xinqi Gateway HTTP routes under /api/voice/xinqi/*
 */

import { VOICE_TOKEN_ERROR_CODES, jsonError } from "./errors.js"
import { fetchAssemblyAITemporaryToken } from "./fetchAssemblyAIToken.js"
import { fetchDeepgramTemporaryToken } from "./fetchDeepgramToken.js"
import { createXinqiGatewayContext } from "./xinqi/createXinqiGatewayHandler.js"

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader("Content-Type", "application/json; charset=utf-8")
  res.setHeader("Cache-Control", "no-store")
  res.end(payload)
}

function pickInjectedKey(value) {
  return value != null && String(value).trim() !== "" ? String(value).trim() : undefined
}

/**
 * @param {object} [deps]
 * @param {(args: object) => Promise<object>} [deps.fetchAssemblyAIToken]
 * @param {(args: object) => Promise<object>} [deps.fetchDeepgramToken]
 * @param {string} [deps.assemblyAIAPIKey]
 * @param {string} [deps.deepgramAPIKey]
 */
export function createVoiceTokenHandler(deps = {}) {
  const fetchAssemblyAI = deps.fetchAssemblyAIToken || fetchAssemblyAITemporaryToken
  const fetchDeepgram = deps.fetchDeepgramToken || fetchDeepgramTemporaryToken
  const assemblyKey = deps.assemblyAIAPIKey
  const deepgramKey = deps.deepgramAPIKey

  return async function handleVoiceToken(req, res) {
    try {
      const url = new URL(req.url || "/", "http://localhost")
      if (req.method !== "GET") {
        sendJson(res, 405, {
          error: {
            code: VOICE_TOKEN_ERROR_CODES.UnknownServerError,
            message: "仅支持 GET。",
          },
        })
        return
      }

      const provider = String(url.searchParams.get("provider") || "assemblyai").toLowerCase()

      if (provider === "assemblyai") {
        const result = await fetchAssemblyAI({
          apiKey: pickInjectedKey(assemblyKey),
        })
        sendJson(res, result.status, result.body)
        return
      }

      if (provider === "deepgram") {
        const result = await fetchDeepgram({
          apiKey: pickInjectedKey(deepgramKey),
        })
        sendJson(res, result.status, result.body)
        return
      }

      const err = jsonError(
        VOICE_TOKEN_ERROR_CODES.UnknownProvider,
        `不支持的 provider：${provider}`,
        400,
      )
      sendJson(res, err.status, err.body)
    } catch (error) {
      console.error("[voiceToken] handler error", error?.name || error)
      const err = jsonError(
        VOICE_TOKEN_ERROR_CODES.UnknownServerError,
        "Voice token 服务内部错误。",
        500,
      )
      sendJson(res, err.status, err.body)
    }
  }
}

/**
 * Connect-style middleware：/api/voice/token* + /api/voice/xinqi/*
 * @param {object} [deps]
 * @param {string} [deps.assemblyAIAPIKey]
 * @param {string} [deps.deepgramAPIKey]
 * @param {string} [deps.xinqiBaseUrl]
 * @param {string} [deps.xinqiRobotApiKey]
 * @param {(args: object) => Promise<object>} [deps.fetchAssemblyAIToken]
 * @param {(args: object) => Promise<object>} [deps.fetchDeepgramToken]
 */
export function createVoiceApiMiddleware(deps = {}) {
  const handle = createVoiceTokenHandler(deps)
  const xinqi = createXinqiGatewayContext({
    xinqiBaseUrl: deps.xinqiBaseUrl,
    xinqiRobotApiKey: deps.xinqiRobotApiKey,
    client: deps.xinqiClient,
    sessionStore: deps.xinqiSessionStore,
    fetchImpl: deps.fetchImpl,
  })

  async function voiceApiMiddleware(req, res, next) {
    const url = req.url || ""
    if (url.startsWith("/api/voice/xinqi/")) {
      await xinqi.httpHandler(req, res)
      return
    }
    if (!url.startsWith("/api/voice/token")) {
      if (typeof next === "function") return next()
      res.statusCode = 404
      res.end("Not Found")
      return
    }
    await handle(req, res)
  }

  voiceApiMiddleware.xinqi = xinqi
  return voiceApiMiddleware
}
