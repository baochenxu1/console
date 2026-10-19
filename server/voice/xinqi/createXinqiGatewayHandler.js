/**
 * HTTP: GET /api/voice/xinqi/health
 *       POST /api/voice/xinqi/session
 */

import { createXinqiClient } from "./xinqiClient.js"
import { createXinqiGatewaySessionStore } from "./xinqiGatewaySession.js"
import { XINQI_ERROR_CODES, xinqiJsonError } from "./xinqiErrors.js"

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader("Content-Type", "application/json; charset=utf-8")
  res.setHeader("Cache-Control", "no-store")
  res.end(payload)
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString("utf8")
  if (!text.trim()) return {}
  return JSON.parse(text)
}

/**
 * @param {object} [deps]
 * @param {string} [deps.xinqiBaseUrl]
 * @param {string} [deps.xinqiRobotApiKey]
 * @param {ReturnType<typeof createXinqiClient>} [deps.client]
 * @param {ReturnType<typeof createXinqiGatewaySessionStore>} [deps.sessionStore]
 * @param {typeof fetch} [deps.fetchImpl]
 */
export function createXinqiGatewayHttpHandler(deps = {}) {
  const sessionStore = deps.sessionStore || createXinqiGatewaySessionStore()
  const client = deps.client || createXinqiClient({
    baseUrl: deps.xinqiBaseUrl,
    robotApiKey: deps.xinqiRobotApiKey,
    fetchImpl: deps.fetchImpl,
  })

  return async function handleXinqiGatewayHttp(req, res) {
    try {
      const url = new URL(req.url || "/", "http://localhost")
      const path = url.pathname

      if (path === "/api/voice/xinqi/health") {
        if (req.method !== "GET") {
          sendJson(res, 405, xinqiJsonError(XINQI_ERROR_CODES.Unknown, "仅支持 GET。", 405).body)
          return
        }
        const result = await client.health()
        sendJson(res, result.status, result.body)
        return
      }

      if (path === "/api/voice/xinqi/session") {
        if (req.method !== "POST") {
          sendJson(res, 405, xinqiJsonError(XINQI_ERROR_CODES.Unknown, "仅支持 POST。", 405).body)
          return
        }
        let body = {}
        try {
          body = await readJsonBody(req)
        } catch {
          sendJson(
            res,
            400,
            xinqiJsonError(XINQI_ERROR_CODES.ConnectFailed, "请求体必须是 JSON。", 400).body,
          )
          return
        }

        const connected = await client.connectRobot({
          sessionId: body?.sessionId ? String(body.sessionId) : undefined,
        })
        if (connected.status !== 200) {
          sendJson(res, connected.status, connected.body)
          return
        }

        const created = sessionStore.create({
          upstreamToken: connected.body._upstreamToken,
          sessionId: connected.body.sessionId,
          protocol: connected.body.protocol,
        })
        sendJson(res, created.status, created.body)
        return
      }

      sendJson(
        res,
        404,
        xinqiJsonError(XINQI_ERROR_CODES.Unknown, "Xinqi Gateway 路径不存在。", 404).body,
      )
    } catch (error) {
      console.error("[xinqi-gw] http handler error", error?.name || error)
      sendJson(
        res,
        500,
        xinqiJsonError(XINQI_ERROR_CODES.Unknown, "Xinqi Gateway 内部错误。", 500).body,
      )
    }
  }
}

export function createXinqiGatewayContext(deps = {}) {
  const sessionStore = deps.sessionStore || createXinqiGatewaySessionStore()
  const client = deps.client || createXinqiClient({
    baseUrl: deps.xinqiBaseUrl,
    robotApiKey: deps.xinqiRobotApiKey,
    fetchImpl: deps.fetchImpl,
  })
  const httpHandler = createXinqiGatewayHttpHandler({
    ...deps,
    client,
    sessionStore,
  })
  return { client, sessionStore, httpHandler }
}
