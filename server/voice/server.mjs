/**
 * FaceDEV Voice Backend：temporary token + Xinqi Gateway。
 * 默认端口 8787；从项目根 .env / .env.local 加载（不覆盖非空 process.env）。
 */

import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { resolveVoiceServerConfig } from "./loadEnv.js"
import { createVoiceApiMiddleware } from "./createVoiceTokenHandler.js"
import { attachXinqiRealtimeGateway } from "./xinqi/xinqiRealtimeGateway.js"
import { DEFAULT_XINQI_BASE_URL } from "./xinqi/xinqiConfig.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "../..")
const config = resolveVoiceServerConfig({
  root,
  processEnv: process.env,
  applyToProcessEnv: true,
})

const port = Number(config.voiceApiPort || process.env.VOICE_API_PORT || 8787)
const middleware = createVoiceApiMiddleware({
  assemblyAIAPIKey: config.assemblyAIAPIKey,
  deepgramAPIKey: config.deepgramAPIKey,
  xinqiBaseUrl: config.xinqiBaseUrl || DEFAULT_XINQI_BASE_URL,
  xinqiRobotApiKey: config.xinqiRobotApiKey,
})

const server = http.createServer(async (req, res) => {
  if (req.url === "/healthz") {
    res.statusCode = 200
    res.setHeader("Content-Type", "application/json; charset=utf-8")
    res.end(JSON.stringify({ ok: true, service: "facedev-voice-api" }))
    return
  }
  await middleware(req, res, () => {
    res.statusCode = 404
    res.setHeader("Content-Type", "application/json; charset=utf-8")
    res.end(JSON.stringify({
      error: { code: "NOT_FOUND", message: "Not Found" },
    }))
  })
})

attachXinqiRealtimeGateway({
  httpServer: server,
  sessionStore: middleware.xinqi.sessionStore,
  getUpstreamWsBaseUrl: () => middleware.xinqi.client.getWsBaseUrl(),
  getUpstreamOrigin: () => middleware.xinqi.client.getOrigin(),
})

server.listen(port, "127.0.0.1", () => {
  console.log(`[voice-api] listening on http://127.0.0.1:${port}`)
  console.log(`[voice-api] ASSEMBLYAI_API_KEY ${config.hasAssemblyAIAPIKey ? "configured" : "MISSING"}`)
  console.log(`[voice-api] DEEPGRAM_API_KEY ${config.hasDeepgramAPIKey ? "configured" : "MISSING"}`)
  console.log(`[voice-api] XINQI_BASE_URL ${config.xinqiBaseUrl || DEFAULT_XINQI_BASE_URL}`)
  console.log(`[voice-api] XINQI_ROBOT_API_KEY ${config.hasXinqiRobotApiKey ? "configured" : "MISSING"}`)
})
