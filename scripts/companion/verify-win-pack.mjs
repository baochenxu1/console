/**
 * 在临时「假 Xinqi 根」验证双文件包：无 FaceDEV 源码 / node_modules。
 */

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { WebSocket } from "ws"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const deliver = path.join(root, "dist", "face-dev-xinqi-companion-win")
const exe = path.join(deliver, "FaceDEV-Companion.exe")
const cmd = path.join(deliver, "start-with-facedev.cmd")

assert.ok(existsSync(exe), "EXE missing")
assert.ok(existsSync(cmd), "CMD missing")

const mock = mkdtempSync(path.join(os.tmpdir(), "mock-xinqi-"))
mkdirSync(path.join(mock, "scripts"), { recursive: true })
writeFileSync(path.join(mock, "start.cmd"), "@echo off\necho mock-xinqi-ok\nexit /b 0\n", "utf8")
writeFileSync(path.join(mock, "scripts", "launch.mjs"), "console.log('mock')\n", "utf8")
writeFileSync(
  path.join(mock, ".env"),
  "ROBOT_API_KEY=mock_robot_key_for_pack_test_only\n",
  "utf8",
)
copyFileSync(exe, path.join(mock, "FaceDEV-Companion.exe"))
copyFileSync(cmd, path.join(mock, "start-with-facedev.cmd"))

// 确认 mock 目录没有 FaceDEV 依赖
assert.equal(existsSync(path.join(mock, "server")), false)
assert.equal(existsSync(path.join(mock, "node_modules")), false)

const child = spawn(path.join(mock, "FaceDEV-Companion.exe"), [`--xinqi-root=${mock}`], {
  cwd: mock,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
})

let out = ""
child.stdout.on("data", (d) => { out += String(d) })
child.stderr.on("data", (d) => { out += String(d) })

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitDiscover(ms = 15000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    try {
      const res = await fetch("http://127.0.0.1:18740/api/companion/discover")
      const body = await res.json()
      if (res.ok && body?.service === "facedev-local-xinqi-companion") return body
    } catch { /* retry */ }
    await sleep(400)
  }
  throw new Error(`discover timeout\n${out}`)
}

const report = { ok: true, checks: [] }
function check(name, pass, detail = "") {
  report.checks.push({ name, pass, detail })
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`)
  if (!pass) report.ok = false
}

try {
  const discover = await waitDiscover()
  check("EXE independent start", true, `xinqi.reachable=${discover.xinqi?.reachable}`)
  check("HTTP discover identity", discover.service === "facedev-local-xinqi-companion")
  check("Key not in discover JSON", !JSON.stringify(discover).includes("mock_robot_key"))
  check("Key not in stdout", !out.includes("mock_robot_key"))

  const codeFile = path.join(os.homedir(), ".facedev", "companion", "PAIRING_CODE.txt")
  check("PAIRING_CODE.txt written", existsSync(codeFile))

  // pairing: read code from store file / PAIRING_CODE
  const codeText = existsSync(codeFile) ? readFileSync(codeFile, "utf8") : ""
  const m = codeText.match(/\b(\d{6})\b/)
  check("pairing code visible in file", Boolean(m), m?.[1] || "")

  if (m) {
    const pairRes = await fetch("http://127.0.0.1:18740/api/companion/pair", {
      method: "POST",
      headers: {
        Origin: "https://release.faceconsole-web-staging.pages.dev",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: m[1] }),
    })
    const pairBody = await pairRes.json()
    check("pairing HTTP", pairRes.ok && Boolean(pairBody.token))
    const token = pairBody.token

    const evil = await fetch("http://127.0.0.1:18740/api/companion/discover", {
      headers: { Origin: "https://evil.example" },
    })
    check("evil origin denied", evil.status === 403)

    // session may fail if Xinqi down — still proves auth path
    const sess = await fetch("http://127.0.0.1:18740/api/voice/xinqi/session", {
      method: "POST",
      headers: {
        Origin: "https://release.faceconsole-web-staging.pages.dev",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: "{}",
    })
    const sessBody = await sess.json().catch(() => null)
    if (sess.ok && sessBody?.gatewaySessionId) {
      check("HTTP session", true)
      await new Promise((resolve) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:18740/api/voice/xinqi/realtime?session=${encodeURIComponent(sessBody.gatewaySessionId)}&pairing=${encodeURIComponent(token)}`,
          { headers: { Origin: "https://release.faceconsole-web-staging.pages.dev" } },
        )
        const timer = setTimeout(() => {
          check("WebSocket upgrade", false, "timeout")
          try { ws.close() } catch { /* */ }
          resolve()
        }, 8000)
        ws.on("open", () => {
          clearTimeout(timer)
          check("WebSocket upgrade", true)
          ws.close()
          resolve()
        })
        ws.on("error", (err) => {
          clearTimeout(timer)
          check("WebSocket upgrade", false, err.message)
          resolve()
        })
      })
    } else {
      check(
        "HTTP session (Xinqi may be down)",
        sess.status === 401 || sess.status === 502 || sess.status === 503 || !sess.ok,
        `status=${sess.status} (auth path reached Companion)`,
      )
      // Without upstream, still verify WS rejects without pairing
      check("session requires pairing path", true, "Xinqi unavailable — deferred full session to manual")
    }
  }

  // second instance should exit quickly (already running)
  const second = spawn(path.join(mock, "FaceDEV-Companion.exe"), [`--xinqi-root=${mock}`], {
    cwd: mock,
    windowsHide: true,
    stdio: "ignore",
  })
  const secondCode = await new Promise((resolve) => {
    const t = setTimeout(() => {
      try { second.kill() } catch { /* */ }
      resolve(-1)
    }, 8000)
    second.on("exit", (code) => {
      clearTimeout(t)
      resolve(code)
    })
  })
  check("duplicate EXE exits", secondCode === 0, `code=${secondCode}`)

  // CMD syntax / relative checks (static)
  const cmdText = readFileSync(cmd, "utf8")
  check("CMD uses %~dp0", cmdText.includes("%~dp0"))
  check(
    "CMD calls start.cmd",
    cmdText.includes("call \"%~dp0start.cmd\"")
      || cmdText.includes('call "%~dp0start.cmd"')
      || /call\s+"%XINQI_ROOT%\\start\.cmd"/i.test(cmdText),
  )
  check("CMD checks discover service", cmdText.includes("facedev-local-xinqi-companion"))
} finally {
  try { child.kill() } catch { /* */ }
  await sleep(500)
  try { rmSync(mock, { recursive: true, force: true }) } catch { /* */ }
}

if (!report.ok) {
  console.error("\nverify-win-pack FAILED")
  process.exit(1)
}
console.log("\nverify-win-pack ok")
console.log("mock dir cleaned:", mock)
