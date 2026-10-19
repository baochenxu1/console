/**
 * Browser MediaPipe Worker init smoke：
 * 1) 静态契约：package 版本、module WASM、Worker 源码 bootstrap
 * 2) 可选浏览器：headless Edge/Chrome + CDP 等待 READY（真实墙钟，不用 virtual-time-budget）
 *
 * 用法：
 *   node scripts/smoke-browser-mediapipe-worker-init.mjs
 *   node scripts/smoke-browser-mediapipe-worker-init.mjs --browser
 */
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { existsSync, readFileSync, statSync, createReadStream } from "node:fs"
import { dirname, extname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "..")
const wantBrowser = process.argv.includes("--browser") || process.env.SMOKE_BROWSER === "1"

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".task": "application/octet-stream",
  ".json": "application/json",
  ".map": "application/json",
}

function fail(msg) {
  console.error(`[smoke-mediapipe-worker] FAIL: ${msg}`)
  process.exit(1)
}

function ok(msg) {
  console.log(`[smoke-mediapipe-worker] OK: ${msg}`)
}

function runStaticChecks() {
  const pkgPath = join(root, "node_modules/@mediapipe/tasks-vision/package.json")
  if (!existsSync(pkgPath)) fail("missing @mediapipe/tasks-vision")
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
  if (pkg.version !== "1.0.1") {
    fail(`expected @mediapipe/tasks-vision@1.0.1, got ${pkg.version}`)
  }
  ok(`package locked @mediapipe/tasks-vision@${pkg.version}`)

  const workerSrc = readFileSync(
    join(root, "src/sdk/tracking/browser/browserFaceLandmarkerWorker.js"),
    "utf8"
  )
  if (!/from\s+["']@mediapipe\/tasks-vision["']/.test(workerSrc)) {
    fail("worker must ES-import @mediapipe/tasks-vision")
  }
  if (!/forVisionTasks\([^)]*,\s*true\s*\)/.test(workerSrc)) {
    fail("worker must call FilesetResolver.forVisionTasks(wasmBase, true)")
  }
  if (!/modelAssetBuffer/.test(workerSrc)) {
    fail("worker must use modelAssetBuffer")
  }
  if (/importScripts\s*\(/.test(workerSrc)) {
    fail("worker must not call importScripts()")
  }
  ok("worker bootstrap: module import + forVisionTasks(..., true) + modelAssetBuffer")

  const wasmDir = join(root, "public/assets/mediapipe/wasm")
  for (const name of [
    "vision_wasm_module_internal.js",
    "vision_wasm_module_internal.wasm",
    "vision_wasm_internal.js",
    "vision_wasm_internal.wasm",
  ]) {
    const p = join(wasmDir, name)
    if (!existsSync(p)) fail(`missing public wasm ${name} — run prepare:mediapipe-assets`)
    const pkgFile = join(root, "node_modules/@mediapipe/tasks-vision/wasm", name)
    if (existsSync(pkgFile) && statSync(p).size !== statSync(pkgFile).size) {
      fail(`size mismatch ${name}: public=${statSync(p).size} pkg=${statSync(pkgFile).size}`)
    }
    ok(`wasm ${name} (${statSync(p).size} bytes)`)
  }

  const model = join(root, "public/models/face_landmarker.task")
  if (!existsSync(model)) fail("missing public/models/face_landmarker.task")
  ok(`model face_landmarker.task (${statSync(model).size} bytes)`)
}

function findBrowser() {
  const candidates = [
    process.env.EDGE_PATH,
    process.env.CHROME_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

function startStaticServer(dir) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const urlPath = decodeURIComponent((req.url || "/").split("?")[0])
        let filePath = join(dir, urlPath === "/" ? "/scripts/smoke-mediapipe-worker.html" : urlPath)
        if (!existsSync(filePath)) {
          res.writeHead(404)
          res.end("not found")
          return
        }
        const type = MIME[extname(filePath)] || "application/octet-stream"
        res.writeHead(200, {
          "Content-Type": type,
          "Cache-Control": "no-store",
        })
        createReadStream(filePath).pipe(res)
      } catch (error) {
        res.writeHead(500)
        res.end(String(error))
      }
    })
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      resolve({ server, port: addr.port })
    })
    server.on("error", reject)
  })
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitForJson(url, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url)
      if (res.ok) return res.json()
    } catch {
      //
    }
    await sleep(250)
  }
  throw new Error(`CDP not ready: ${url}`)
}

function cdpSession(wsUrl) {
  return new Promise((resolve, reject) => {
    const WS = globalThis.WebSocket
    if (!WS) {
      reject(new Error("Node WebSocket unavailable; need Node 22+ or --browser skip"))
      return
    }
    const ws = new WS(wsUrl)
    let nextId = 1
    const pending = new Map()
    ws.addEventListener("open", () => {
      resolve({
        async send(method, params = {}) {
          const id = nextId++
          const payload = JSON.stringify({ id, method, params })
          return new Promise((res, rej) => {
            pending.set(id, { res, rej })
            ws.send(payload)
          })
        },
        close() {
          try {
            ws.close()
          } catch {
            //
          }
        },
      })
    })
    ws.addEventListener("error", (err) => reject(err))
    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(String(event.data))
        if (msg.id != null && pending.has(msg.id)) {
          const { res, rej } = pending.get(msg.id)
          pending.delete(msg.id)
          if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)))
          else res(msg.result)
        }
      } catch {
        //
      }
    })
  })
}

async function runBrowserSmoke() {
  const dist = join(root, "dist-smoke-mediapipe")
  if (!existsSync(join(dist, "scripts/smoke-mediapipe-worker.html"))) {
    fail("dist-smoke-mediapipe missing — build smoke first")
  }

  const browserPath = findBrowser()
  if (!browserPath) {
    console.warn(
      "[smoke-mediapipe-worker] WARN: no Edge/Chrome found; static checks only. Re-run with browser installed + --browser"
    )
    return false
  }
  ok(`browser=${browserPath}`)

  const { server, port } = await startStaticServer(dist)
  const pageUrl = `http://127.0.0.1:${port}/scripts/smoke-mediapipe-worker.html`
  ok(`serving ${pageUrl}`)

  const debugPort = 9222 + Math.floor(Math.random() * 1000)
  const userData = join(root, "dist-smoke-mediapipe/.chrome-profile")
  const child = spawn(
    browserPath,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${userData}`,
      `--remote-debugging-port=${debugPort}`,
      pageUrl,
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
  )

  let stderr = ""
  child.stderr.on("data", (d) => {
    stderr += String(d)
  })

  try {
    const targets = await waitForJson(`http://127.0.0.1:${debugPort}/json/list`)
    const page =
      targets.find((t) => t.type === "page" && String(t.url || "").includes("smoke-mediapipe")) ||
      targets.find((t) => t.type === "page")
    if (!page?.webSocketDebuggerUrl) {
      fail(`no CDP page target: ${stderr.slice(0, 400)}`)
    }
    const session = await cdpSession(page.webSocketDebuggerUrl)
    await session.send("Runtime.enable")

    const deadline = Date.now() + 90000
    let title = ""
    while (Date.now() < deadline) {
      const result = await session.send("Runtime.evaluate", {
        expression: "document.title",
        returnByValue: true,
      })
      title = String(result?.result?.value || "")
      if (title.includes("SMOKE_OK")) {
        ok(`browser READY: ${title.slice(0, 200)}`)
        session.close()
        return true
      }
      if (title.includes("SMOKE_FAIL")) {
        session.close()
        fail(`browser smoke: ${title}`)
      }
      await sleep(500)
    }
    session.close()
    fail(`browser smoke timeout; last title=${title || "(empty)"}`)
  } finally {
    try {
      child.kill()
    } catch {
      //
    }
    await new Promise((r) => server.close(() => r()))
  }
  return false
}

async function buildSmokeBundle() {
  const viteBin = join(root, "node_modules/vite/bin/vite.js")
  if (!existsSync(viteBin)) fail("vite missing")
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [viteBin, "build", "--config", "vite.smoke-mediapipe.config.js"],
      {
        cwd: root,
        stdio: "inherit",
        windowsHide: true,
      }
    )
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`vite smoke build exit ${code}`))
    })
  })
  ok("built dist-smoke-mediapipe")
}

async function main() {
  const prepare = join(root, "scripts/prepare-browser-mediapipe-assets.mjs")
  await import(pathToFileURL(prepare).href)

  runStaticChecks()

  if (wantBrowser) {
    await buildSmokeBundle()
    await runBrowserSmoke()
  } else {
    ok("static smoke passed (add --browser for headless Worker READY check)")
  }
  console.log("[smoke-mediapipe-worker] all checks passed")
}

main().catch((error) => {
  fail(error?.message || String(error))
})
