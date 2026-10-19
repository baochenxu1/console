import path from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const reactExternal = [
  "react",
  "react-dom",
  "react/jsx-runtime",
  "react-dom/client",
]

function isReactExternal(id) {
  if (reactExternal.includes(id)) {
    return true
  }
  if (id.startsWith("react/") || id.startsWith("react-dom/")) {
    return true
  }
  return false
}

export default defineConfig({
  publicDir: false,
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  build: {
    outDir: "dist-sdk",
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: {
        index: path.resolve(__dirname, "src/sdk/index.js"),
        core: path.resolve(__dirname, "src/sdk/core/index.js"),
        binding: path.resolve(__dirname, "src/sdk/binding/index.js"),
        expression: path.resolve(__dirname, "src/sdk/expression/index.js"),
        protocol: path.resolve(__dirname, "src/sdk/protocol/index.js"),
        output: path.resolve(__dirname, "src/sdk/output/index.js"),
        "servo-adapters": path.resolve(__dirname, "src/sdk/servoAdapters/index.js"),
        tracking: path.resolve(__dirname, "src/sdk/tracking/index.js"),
        react: path.resolve(__dirname, "src/sdk/react/index.js"),
      },
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: {
      external: isReactExternal,
      output: {
        assetFileNames: "style.css",
        chunkFileNames: "chunks/[name]-[hash].js",
        entryFileNames: "[name].js",
      },
    },
  },
})
