/**
 * 真实浏览器：从 CF Pages Origin 访问本机 Companion discover。
 * 使用本机 Edge/Chrome（puppeteer-core 可选；无依赖时用 CDP 手工也可）。
 *
 *   node scripts/companion/p0-browser-lna-verify.mjs
 */

import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { existsSync } from "node:fs"
import path from "node:path"

const PAGES = process.env.FACEDEV_P0_ORIGIN || "https://release.faceconsole-web-staging.pages.dev"
const COMPANION = process.env.FACEDEV_COMPANION_BASE || "http://127.0.0.1:18740"
const EDGE = [
  process.env.EDGE_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].find((p) => p && existsSync(p))

if (!EDGE) {
  console.error("未找到 Edge/Chrome，跳过浏览器 LNA 验证")
  process.exit(2)
}

// 通过临时本地中继页无法伪造 pages.dev Origin。
// 使用 Chrome DevTools Protocol：打开真实 Pages，再 Runtime.evaluate fetch。

const debugPort = 9229 + Math.floor(Math.random() * 200)
const userData = path.join(process.env.TEMP || "/tmp", `facedev-p0-lna-${Date.now()}`)

const child = spawn(EDGE, [
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${userData}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-popup-blocking",
  PAGES,
], { stdio: ["ignore", "pipe", "pipe"] })

async function waitForDebugger(ms = 15000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`)
      if (res.ok) return await res.json()
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error("CDP 未就绪")
}

async function main() {
  try {
    await waitForDebugger()
    const tabs = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
    let page = tabs.find((t) => t.type === "page" && String(t.url || "").includes("pages.dev"))
      || tabs.find((t) => t.type === "page")
    if (!page?.webSocketDebuggerUrl) throw new Error("无可用 page target")

    // 最小 WebSocket CDP 客户端
    const { default: WebSocket } = await import("ws")
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.once("open", resolve)
      ws.once("error", reject)
    })

    let nextId = 1
    const pending = new Map()
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw))
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message || "cdp error"))
        else resolve(msg.result)
      }
    })

    function send(method, params = {}) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }))
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id)
            reject(new Error(`CDP timeout ${method}`))
          }
        }, 20000)
      })
    }

    await send("Page.enable")
    await send("Runtime.enable")
    // 等页面 settle
    await new Promise((r) => setTimeout(r, 2500))
    await send("Page.navigate", { url: PAGES })
    await new Promise((r) => setTimeout(r, 3500))

    const evaluated = await send("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `(() => {
        const companion = ${JSON.stringify(COMPANION)};
        return fetch(companion + "/api/companion/discover", {
          headers: { Accept: "application/json" },
          cache: "no-store",
        }).then(async (res) => ({
          ok: res.ok,
          status: res.status,
          body: await res.json().catch(() => null),
        })).catch((error) => ({
          ok: false,
          error: String(error && error.message || error),
          name: String(error && error.name || "Error"),
        }));
      })()`,
    })

    const value = evaluated?.result?.value
    console.log("Browser origin page:", PAGES)
    console.log("Companion probe result:", JSON.stringify(value, null, 2))

    ws.close()
    child.kill()

    if (value?.ok && value?.body?.ok) {
      console.log("\nPASS 真实 CF Pages 页面 → 本机 Companion HTTP discover")
      process.exit(0)
    }
    if (value?.name === "TypeError" || /Failed to fetch|NetworkError|Local Network/i.test(value?.error || "")) {
      console.log("\nBLOCKED 浏览器本机访问权限 / LNA — 需用户在页面上手动授权后重试")
      console.log("Node Origin 闸门已通过；勿在未授权 LNA 时声称云端语音可用。")
      process.exit(3)
    }
    console.log("\nFAIL 浏览器跨源 discover 未成功")
    process.exit(1)
  } catch (error) {
    console.error(error)
    try { child.kill() } catch { /* ignore */ }
    process.exit(1)
  }
}

main()
