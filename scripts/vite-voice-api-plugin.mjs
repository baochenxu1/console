/**
 * Vite plugin：dev 时挂载 /api/voice/*（token + Xinqi Gateway HTTP/WS）。
 * 使用 Vite loadEnv(mode, root, "") 读取无 VITE_ 前缀的 server secret，
 * 经 DI 注入 handler，不写入 define / import.meta.env。
 */

import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadEnv } from "vite"
import { resolveVoiceServerConfig } from "../server/voice/loadEnv.js"
import { createVoiceApiMiddleware } from "../server/voice/createVoiceTokenHandler.js"
import { attachXinqiRealtimeGateway } from "../server/voice/xinqi/xinqiRealtimeGateway.js"
import { DEFAULT_XINQI_BASE_URL } from "../server/voice/xinqi/xinqiConfig.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

export function voiceApiPlugin() {
  /** @type {{ close: () => void } | null} */
  let xinqiGateway = null

  return {
    name: "facedev-voice-api",
    configureServer(server) {
      const mode = server.config.mode || "development"
      const viteEnv = loadEnv(mode, root, "")
      const resolved = resolveVoiceServerConfig({
        root,
        processEnv: process.env,
        fileEnv: {
          ASSEMBLYAI_API_KEY: viteEnv.ASSEMBLYAI_API_KEY || "",
          DEEPGRAM_API_KEY: viteEnv.DEEPGRAM_API_KEY || "",
          VOICE_API_PORT: viteEnv.VOICE_API_PORT || "",
          XINQI_BASE_URL: viteEnv.XINQI_BASE_URL || "",
          XINQI_ROBOT_API_KEY: viteEnv.XINQI_ROBOT_API_KEY || "",
        },
        applyToProcessEnv: true,
      })

      const middleware = createVoiceApiMiddleware({
        assemblyAIAPIKey: resolved.assemblyAIAPIKey,
        deepgramAPIKey: resolved.deepgramAPIKey,
        xinqiBaseUrl: resolved.xinqiBaseUrl || DEFAULT_XINQI_BASE_URL,
        xinqiRobotApiKey: resolved.xinqiRobotApiKey,
      })

      console.info(
        `[voice-api] middleware ready (assemblyai=${resolved.hasAssemblyAIAPIKey ? "ok" : "MISSING"}, deepgram=${resolved.hasDeepgramAPIKey ? "ok" : "MISSING"}, xinqi=${resolved.hasXinqiRobotApiKey ? "ok" : "MISSING"})`,
      )

      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/voice/")) {
          next()
          return
        }
        await middleware(req, res, next)
      })

      const httpServer = server.httpServer
      if (httpServer && middleware.xinqi) {
        xinqiGateway = attachXinqiRealtimeGateway({
          httpServer,
          sessionStore: middleware.xinqi.sessionStore,
          getUpstreamWsBaseUrl: () => middleware.xinqi.client.getWsBaseUrl(),
          getUpstreamOrigin: () => middleware.xinqi.client.getOrigin(),
        })
        console.info("[voice-api] xinqi realtime gateway attached")
      }
    },
    configurePreviewServer(server) {
      // preview 不挂 secret middleware；保持空操作
      void server
    },
    closeBundle() {
      xinqiGateway?.close?.()
      xinqiGateway = null
    },
  }
}
