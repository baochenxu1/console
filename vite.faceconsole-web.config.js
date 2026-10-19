/**
 * Face Console Production Web Build（HTTPS Static Hosting Ready）。
 * 输出：dist-web/
 */
import path from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import {
  readPackageVersion,
  resolveBuildTime,
  resolveGitSha,
} from "./scripts/faceconsole-web-build-meta.mjs"
import { voiceApiPlugin } from "./scripts/vite-voice-api-plugin.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const faceConsoleVersion = readPackageVersion()
const faceConsoleGitSha = resolveGitSha()
const faceConsoleBuildTime = resolveBuildTime()

export default defineConfig({
  plugins: [react(), voiceApiPlugin()],
  base: "/",
  publicDir: "public",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  build: {
    outDir: "dist-web",
    emptyOutDir: true,
    sourcemap: true,
    assetsDir: "assets",
    // AudioWorklet 必须是独立 script URL；勿内联为 data:（CSP / fetch+compose / addModule 兼容性）。
    // 仅排除 capture 会让 pcmPlaybackProcessor 被打成 data: URL，云端 Pages 上播放链路静默失败。
    assetsInlineLimit(filePath) {
      const p = String(filePath)
      if (
        p.includes("pcmCaptureProcessor")
        || p.includes("pcmPlaybackProcessor")
        || p.includes("pcmPlaybackQueue")
      ) {
        return false
      }
      return undefined
    },
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
  worker: {
    format: "es",
  },
  define: {
    "import.meta.env.VITE_TRACKING_BACKEND": JSON.stringify(
      process.env.VITE_TRACKING_BACKEND || "browser"
    ),
    "import.meta.env.VITE_FACECONSOLE_VERSION": JSON.stringify(faceConsoleVersion),
    "import.meta.env.VITE_FACECONSOLE_GIT_SHA": JSON.stringify(faceConsoleGitSha),
    "import.meta.env.VITE_FACECONSOLE_BUILD_TIME": JSON.stringify(faceConsoleBuildTime),
  },
})
