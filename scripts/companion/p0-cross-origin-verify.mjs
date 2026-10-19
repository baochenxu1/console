/**
 * P0：以 Cloudflare Pages Release Origin 校验本机 Companion HTTP + WebSocket。
 *
 * 用法（先启动 companion）:
 *   node scripts/companion/p0-cross-origin-verify.mjs
 *
 * 环境:
 *   FACEDEV_COMPANION_BASE=http://127.0.0.1:18740
 *   FACEDEV_P0_ORIGIN=https://release.faceconsole-web-staging.pages.dev
 *   FACEDEV_P0_PAIR_CODE=（若尚未配对）
 *
 * 说明：本脚本用 Node 伪造 Origin，验证 Companion 安全闸门与跨源 CORS/WS。
 * 浏览器 Local Network Access 权限仍需在真实 Chromium 页面上点授权。
 */

import { WebSocket } from "ws"

const BASE = String(process.env.FACEDEV_COMPANION_BASE || "http://127.0.0.1:18740").replace(/\/$/, "")
const ORIGIN = process.env.FACEDEV_P0_ORIGIN || "https://release.faceconsole-web-staging.pages.dev"
const PAIR_CODE = process.env.FACEDEV_P0_PAIR_CODE || ""

const report = []
function pass(name, detail = "") {
  report.push({ ok: true, name, detail })
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`)
}
function fail(name, detail = "") {
  report.push({ ok: false, name, detail })
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`)
}

async function main() {
  // 1) Discover with CF Origin
  let discover
  try {
    const res = await fetch(`${BASE}/api/companion/discover`, {
      headers: { Origin: ORIGIN, Accept: "application/json" },
    })
    discover = await res.json()
    const acao = res.headers.get("access-control-allow-origin")
    if (res.ok && discover?.ok && acao === ORIGIN) {
      pass("HTTP discover + CORS", `xinqi.reachable=${discover.xinqi?.reachable}`)
    } else {
      fail("HTTP discover + CORS", `status=${res.status} acao=${acao}`)
    }
  } catch (error) {
    fail("HTTP discover + CORS", error.message)
    printSummary()
    process.exit(1)
  }

  // 2) Evil origin denied
  try {
    const res = await fetch(`${BASE}/api/companion/discover`, {
      headers: { Origin: "https://evil.example", Accept: "application/json" },
    })
    if (res.status === 403) pass("Evil Origin denied")
    else fail("Evil Origin denied", `status=${res.status}`)
  } catch (error) {
    fail("Evil Origin denied", error.message)
  }

  // 3) Pair if needed
  let token = process.env.FACEDEV_P0_PAIR_TOKEN || ""
  if (discover?.pairing?.pairingRequired) {
    if (!PAIR_CODE) {
      fail("Pairing", "Companion 需要配对：设置 FACEDEV_P0_PAIR_CODE 后重试（控制台配对码）")
    } else {
      const res = await fetch(`${BASE}/api/companion/pair`, {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({ code: PAIR_CODE }),
      })
      const body = await res.json()
      if (res.ok && body?.token) {
        token = body.token
        pass("Pairing", "token issued")
      } else {
        fail("Pairing", body?.error?.message || `status=${res.status}`)
      }
    }
  } else {
    pass("Pairing", "already paired (or token via env)")
  }

  if (!token && !discover?.pairing?.pairingRequired) {
    // 已配对但脚本无 token：跳过 session/ws，仅报告 discover
    fail("Session/WS", "已配对但脚本无 token；请设置 FACEDEV_P0_PAIR_TOKEN 或重新配对")
    printSummary()
    process.exit(report.some((r) => !r.ok) ? 1 : 0)
  }

  if (!token) {
    printSummary()
    process.exit(1)
  }

  // 4) Session (may fail if Xinqi down — still proves HTTP path)
  try {
    const res = await fetch(`${BASE}/api/voice/xinqi/session`, {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: "{}",
    })
    const body = await res.json().catch(() => null)
    if (res.ok && body?.gatewaySessionId) {
      pass("HTTP session", `gatewaySessionId=${String(body.gatewaySessionId).slice(0, 8)}…`)
      // 5) WS
      const u = new URL(BASE)
      const wsUrl = `ws://${u.host}/api/voice/xinqi/realtime?session=${encodeURIComponent(body.gatewaySessionId)}&pairing=${encodeURIComponent(token)}`
      await new Promise((resolve) => {
        const ws = new WebSocket(wsUrl, { headers: { Origin: ORIGIN } })
        const timer = setTimeout(() => {
          fail("WebSocket", "timeout")
          try { ws.close() } catch { /* ignore */ }
          resolve()
        }, 8000)
        ws.on("open", () => {
          // ready 可能依赖上游；open 即证明跨源 WS 握手通过 Companion
          clearTimeout(timer)
          pass("WebSocket", "upgrade open with CF Origin")
          ws.close()
          resolve()
        })
        ws.on("unexpected-response", (_req, res2) => {
          clearTimeout(timer)
          fail("WebSocket", `unexpected ${res2.statusCode}`)
          resolve()
        })
        ws.on("error", (err) => {
          clearTimeout(timer)
          fail("WebSocket", err.message)
          resolve()
        })
      })
    } else {
      fail(
        "HTTP session",
        `status=${res.status} ${body?.error?.message || "Xinqi 可能未启动；跨源 HTTP 鉴权已到达 Companion"}`,
      )
      // 仍尝试无 session 的 WS 应 403/失败 — 可选
    }
  } catch (error) {
    fail("HTTP session", error.message)
  }

  printSummary()
  const failed = report.filter((r) => !r.ok)
  if (failed.length) {
    console.log("\nP0 未完全通过。勿声称云端语音已可用。")
    process.exit(1)
  }
  console.log("\nP0 Node Origin 验证通过（HTTP+WS）。请再在真实 CF Pages 页完成浏览器 LNA 授权确认。")
}

function printSummary() {
  console.log("\n--- P0 summary ---")
  for (const row of report) {
    console.log(`${row.ok ? "OK" : "NG"} ${row.name}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
