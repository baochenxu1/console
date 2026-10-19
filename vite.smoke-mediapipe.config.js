/**
 * Face Console — Browser MediaPipe Worker init smoke Vite config.
 * Output: dist-smoke-mediapipe/
 */
import path from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: __dirname,
  publicDir: "public",
  base: "/",
  build: {
    outDir: "dist-smoke-mediapipe",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: path.resolve(__dirname, "scripts/smoke-mediapipe-worker.html"),
    },
  },
  worker: {
    format: "es",
  },
})
