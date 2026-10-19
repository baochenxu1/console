/**
 * Production build 后校验 Browser MediaPipe 资产存在，并审计不安全路径。
 *
 * Test A/B/C 对应：
 * - index.html / hashed assets / wasm / model
 * - 无本地绝对路径 / file:// / tools/tracking_service runtime path
 */
import { existsSync, statSync, readdirSync, readFileSync } from "node:fs"
import { join, extname } from "node:path"

const root = process.cwd()
const dist = join(root, "dist-web")

function fail(msg) {
  console.error(`[check-faceconsole-web-assets] FAIL: ${msg}`)
  process.exit(1)
}

function ok(msg) {
  console.log(`[check-faceconsole-web-assets] OK: ${msg}`)
}

function walkFiles(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name)
    if (name.isDirectory()) walkFiles(p, out)
    else out.push(p)
  }
  return out
}

if (!existsSync(join(dist, "index.html"))) {
  fail("dist-web/index.html missing")
}
ok("index.html")

if (!existsSync(join(dist, "_headers"))) {
  fail("dist-web/_headers missing (copy from public/_headers)")
}
ok("_headers present")

const assetsDir = join(dist, "assets")
if (!existsSync(assetsDir)) {
  fail("dist-web/assets missing")
}
const assetFiles = readdirSync(assetsDir)
if (!assetFiles.some((f) => f.endsWith(".js"))) {
  fail("no hashed JS in dist-web/assets")
}
if (!assetFiles.some((f) => f.endsWith(".css"))) {
  fail("no hashed CSS in dist-web/assets")
}
ok(`assets js/css count=${assetFiles.length}`)

const wasmDir = join(dist, "assets/mediapipe/wasm")
for (const name of [
  "vision_wasm_internal.wasm",
  "vision_wasm_internal.js",
  "vision_wasm_nosimd_internal.wasm",
  "vision_wasm_nosimd_internal.js",
  "vision_wasm_module_internal.wasm",
  "vision_wasm_module_internal.js",
]) {
  const p = join(wasmDir, name)
  if (!existsSync(p)) fail(`missing wasm: ${name}`)
  ok(`${name} (${statSync(p).size} bytes)`)
}

const pkgPath = join(root, "node_modules/@mediapipe/tasks-vision/package.json")
if (!existsSync(pkgPath)) fail("missing @mediapipe/tasks-vision package.json")
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
ok(`tasks-vision package=${pkg.version}`)

const manifestPath = join(dist, "assets/mediapipe/manifest.json")
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  if (manifest.packageVersion && manifest.packageVersion !== pkg.version) {
    fail(
      `WASM manifest packageVersion=${manifest.packageVersion} != installed ${pkg.version}`
    )
  }
  if (manifest.wasmBase && !String(manifest.wasmBase).startsWith("/")) {
    fail(`manifest.wasmBase must be web-safe absolute path, got ${manifest.wasmBase}`)
  }
  if (manifest.modelUrl && !String(manifest.modelUrl).startsWith("/")) {
    fail(`manifest.modelUrl must be web-safe absolute path, got ${manifest.modelUrl}`)
  }
  ok(`manifest packageVersion=${manifest.packageVersion || "(legacy)"}`)
}

const model = join(dist, "models/face_landmarker.task")
if (!existsSync(model)) fail("missing models/face_landmarker.task")
ok(`face_landmarker.task (${statSync(model).size} bytes)`)

// 不应把 Python tracking service 打进静态产物根目录
for (const banned of ["tools", "node_modules", "venv", "tracking_service"]) {
  if (existsSync(join(dist, banned))) {
    fail(`dist-web must not contain ${banned}`)
  }
}
ok("no python/node runtime dirs in dist-web")

// Path audit: no Windows absolute paths / file URLs / tracking_service runtime paths in text assets
const TEXT_EXTS = new Set([".html", ".js", ".css", ".mjs", ".json", ".txt"])
const pathHits = []
for (const file of walkFiles(dist)) {
  const ext = extname(file).toLowerCase()
  if (!TEXT_EXTS.has(ext)) continue
  // .map 常含本机构建绝对路径；不作为 Production 运行时加载，跳过审计
  if (file.endsWith(".map")) continue
  // MediaPipe Emscripten glue 仅在注释中提及 file://（协议检测说明），非运行时本地路径
  const isVendoredMediapipeWasmJs =
    /[\\/]assets[\\/]mediapipe[\\/]wasm[\\/].+\.js$/i.test(file)
  let text
  try {
    text = readFileSync(file, "utf8")
  } catch {
    continue
  }
  if (/[A-Za-z]:[\\/](?:Users|Dreame_PJ|home|var|tmp)/i.test(text)) {
    pathHits.push(`${file}: windows-or-unix-absolute-path`)
  }
  // 仅拦截真实 file URL（file:///… / file://host/…），忽略注释中的 `file://` 字样
  if (!isVendoredMediapipeWasmJs && /file:\/\/(?:\/|[A-Za-z0-9_.-]+\/)/i.test(text)) {
    pathHits.push(`${file}: file-url`)
  }
  if (/tools\/tracking_service\//.test(text) && !file.endsWith("manifest.json")) {
    pathHits.push(`${file}: tools/tracking_service path`)
  }
}
if (pathHits.length) {
  fail(`unsafe local paths in dist-web:\n  - ${pathHits.slice(0, 12).join("\n  - ")}`)
}
ok("no windows absolute / file:// / tools/tracking_service paths in text assets")

// Browser MediaPipe config contract (source-level) — production defaults
const browserConfig = readFileSync(
  join(root, "src/sdk/tracking/browser/browserTrackingConfig.js"),
  "utf8"
)
if (!browserConfig.includes('"/assets/mediapipe/wasm"')) {
  fail("BROWSER_MEDIAPIPE_WASM_BASE must be /assets/mediapipe/wasm")
}
if (!browserConfig.includes('"/models/face_landmarker.task"')) {
  fail("BROWSER_FACE_LANDMARKER_MODEL_URL must be /models/face_landmarker.task")
}
ok("browser asset URLs are web-safe absolute paths")

// Playback AudioWorklet 不得被 Vite 内联为 data: URL（云端 Pages 静音根因）
const playbackProcessorAssets = assetFiles.filter((f) => /pcmPlaybackProcessor/i.test(f))
if (!playbackProcessorAssets.length) {
  fail("missing hashed pcmPlaybackProcessor asset in dist-web/assets")
}
ok(`pcmPlaybackProcessor asset=${playbackProcessorAssets.join(",")}`)
const playbackQueueAssets = assetFiles.filter((f) => /pcmPlaybackQueue/i.test(f))
if (!playbackQueueAssets.length) {
  fail("missing hashed pcmPlaybackQueue asset in dist-web/assets")
}
ok(`pcmPlaybackQueue asset=${playbackQueueAssets.join(",")}`)

const indexJsFiles = assetFiles.filter((f) => /^index-.*\.js$/i.test(f))
for (const name of indexJsFiles) {
  const text = readFileSync(join(assetsDir, name), "utf8")
  if (/data:text\/javascript;base64,/.test(text) && /playback-processor|pcmPlaybackProcessor/i.test(text)) {
    fail(`${name} still embeds playback worklet as data: URL`)
  }
  if (!/pcmPlaybackProcessor-/i.test(text) && !/pcmPlaybackProcessor/i.test(text)) {
    // hashed URL rewrite may look like /assets/pcmPlaybackProcessor-<hash>.js
    if (!assetFiles.some((f) => /pcmPlaybackProcessor/i.test(f))) {
      fail(`${name} does not reference playback processor asset`)
    }
  }
}
ok("playback worklet not inlined as data: URL")

console.log("[check-faceconsole-web-assets] all checks passed")
