/**
 * 准备 Browser MediaPipe 静态资源：
 * - 从 node_modules 复制匹配版本 WASM
 * - 确认 / 下载 face_landmarker.task（Canonical：tools/tracking_service/models）
 *
 * Developer / CI 行为；最终用户只通过 HTTP 获取这些资源。
 */
import { createHash } from "node:crypto"
import { createWriteStream, existsSync, mkdirSync, copyFileSync, statSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { pipeline } from "node:stream/promises"
import { Readable } from "node:stream"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "..")

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
const CANONICAL_MODEL = join(root, "tools/tracking_service/models/face_landmarker.task")
const PUBLIC_MODELS = join(root, "public/models/face_landmarker.task")
const PUBLIC_WASM = join(root, "public/assets/mediapipe/wasm")
const PKG_WASM = join(root, "node_modules/@mediapipe/tasks-vision/wasm")

const WASM_FILES = [
  "vision_wasm_internal.js",
  "vision_wasm_internal.wasm",
  "vision_wasm_nosimd_internal.js",
  "vision_wasm_nosimd_internal.wasm",
  // 1.x module Worker（FilesetResolver.forVisionTasks(path, true)）
  "vision_wasm_module_internal.js",
  "vision_wasm_module_internal.wasm",
]

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
}

function sha256File(path) {
  const hash = createHash("sha256")
  hash.update(readFileSync(path))
  return hash.digest("hex")
}

async function downloadModel(dest) {
  console.log(`[browser-mediapipe-assets] downloading model → ${dest}`)
  const res = await fetch(MODEL_URL)
  if (!res.ok) {
    throw new Error(`model download failed: HTTP ${res.status}`)
  }
  ensureDir(dirname(dest))
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
}

function copyWasm() {
  if (!existsSync(PKG_WASM)) {
    throw new Error(`Missing MediaPipe wasm package dir: ${PKG_WASM}. Run npm install.`)
  }
  ensureDir(PUBLIC_WASM)
  for (const name of WASM_FILES) {
    const src = join(PKG_WASM, name)
    if (!existsSync(src)) {
      throw new Error(`Missing wasm file: ${src}`)
    }
    copyFileSync(src, join(PUBLIC_WASM, name))
    console.log(`[browser-mediapipe-assets] wasm: ${name} (${statSync(src).size} bytes)`)
  }
}

async function ensureModel() {
  ensureDir(dirname(CANONICAL_MODEL))
  ensureDir(dirname(PUBLIC_MODELS))
  if (!existsSync(CANONICAL_MODEL)) {
    await downloadModel(CANONICAL_MODEL)
  } else {
    console.log(
      `[browser-mediapipe-assets] canonical model ok (${statSync(CANONICAL_MODEL).size} bytes)`
    )
  }
  copyFileSync(CANONICAL_MODEL, PUBLIC_MODELS)
  const hash = sha256File(PUBLIC_MODELS)
  console.log(`[browser-mediapipe-assets] public model hash sha256=${hash.slice(0, 16)}…`)
  return { path: PUBLIC_MODELS, bytes: statSync(PUBLIC_MODELS).size, sha256: hash }
}

async function main() {
  const pkgPath = join(root, "node_modules/@mediapipe/tasks-vision/package.json")
  if (!existsSync(pkgPath)) {
    throw new Error("Missing @mediapipe/tasks-vision. Run npm install.")
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
  console.log(`[browser-mediapipe-assets] package version=${pkg.version}`)

  copyWasm()
  const model = await ensureModel()
  const manifest = {
    package: "@mediapipe/tasks-vision",
    packageVersion: pkg.version,
    wasmBase: "/assets/mediapipe/wasm",
    wasmFiles: WASM_FILES,
    modelUrl: "/models/face_landmarker.task",
    modelBytes: model.bytes,
    modelSha256: model.sha256,
    preparedAt: new Date().toISOString(),
  }
  ensureDir(join(root, "public/assets/mediapipe"))
  const manifestPath = join(root, "public/assets/mediapipe/manifest.json")
  const { writeFileSync } = await import("node:fs")
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`[browser-mediapipe-assets] wrote ${manifestPath}`)
  console.log("[browser-mediapipe-assets] done")
}

main().catch((error) => {
  console.error("[browser-mediapipe-assets] FAILED:", error.message || error)
  process.exit(1)
})
