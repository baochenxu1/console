/**
 * Companion 安全与配对 selftest（不依赖 Xinqi Engine）。
 */

import assert from "node:assert/strict"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { WebSocketServer, WebSocket } from "ws"
import { createPairingStore } from "./pairingStore.js"
import {
  authorizeCompanionUpgrade,
  createCompanionHttpHandler,
} from "./companionHttp.js"
import {
  assertLoopbackBaseUrl,
  originAllowed,
} from "./companionSecurity.js"
import { COMPANION_DEFAULT_ALLOWED_ORIGINS } from "./companionConfig.js"
import { attachXinqiRealtimeGateway } from "../xinqi/xinqiRealtimeGateway.js"
import { createXinqiGatewaySessionStore } from "../xinqi/xinqiGatewaySession.js"

assert.equal(assertLoopbackBaseUrl("http://127.0.0.1:18740").ok, true)
assert.equal(assertLoopbackBaseUrl("http://localhost:18740").ok, true)
assert.equal(assertLoopbackBaseUrl("https://evil.example").ok, false)
assert.equal(assertLoopbackBaseUrl("http://192.168.1.8:18740").ok, false)
assert.equal(
  originAllowed("https://release.faceconsole-web-staging.pages.dev", COMPANION_DEFAULT_ALLOWED_ORIGINS),
  true,
)
assert.equal(originAllowed("https://evil.example", COMPANION_DEFAULT_ALLOWED_ORIGINS), false)

const statePath = path.join(os.tmpdir(), `facedev-companion-selftest-${Date.now()}.json`)
const store = createPairingStore({ statePath, codeTtlMs: 60_000, tokenTtlMs: 60_000 })
const code = store.ensurePairingCode()
assert.equal(store.snapshotPublic().pairingRequired, true)
const paired = store.pairWithCode(code, "https://release.faceconsole-web-staging.pages.dev")
assert.equal(paired.ok, true)
assert.equal(store.isTokenValid(paired.token), true)
assert.equal(store.snapshotPublic().pairingRequired, false)

const CF_ORIGIN = "https://release.faceconsole-web-staging.pages.dev"

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port))
  })
}

async function invoke(handler, { method, url, headers = {}, body }) {
  const server = http.createServer((req, res) => handler(req, res))
  const port = await listen(server)
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* ignore */ }
    return { status: res.status, body: json, headers: res.headers }
  } finally {
    server.close()
  }
}

{
  const pairingStore = createPairingStore({
    statePath: path.join(os.tmpdir(), `facedev-c2-${Date.now()}.json`),
    codeTtlMs: 60_000,
    tokenTtlMs: 60_000,
  })
  const pairCode = pairingStore.ensurePairingCode()
  let xinqiOk = true
  const handler = createCompanionHttpHandler({
    allowedOrigins: COMPANION_DEFAULT_ALLOWED_ORIGINS,
    pairingStore,
    probeXinqi: async () => ({ ok: xinqiOk, status: xinqiOk ? 200 : 503 }),
    xinqiHttpHandler: async (_req, res) => {
      res.statusCode = 200
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ ok: true, gatewaySessionId: "gw-test", sessionId: "s1" }))
    },
    port: 18740,
    host: "127.0.0.1",
  })

  const denied = await invoke(handler, {
    method: "GET",
    url: "/api/companion/discover",
    headers: { Origin: "https://evil.example", Accept: "application/json" },
  })
  assert.equal(denied.status, 403)

  const discover = await invoke(handler, {
    method: "GET",
    url: "/api/companion/discover",
    headers: { Origin: CF_ORIGIN, Accept: "application/json" },
  })
  assert.equal(discover.status, 200)
  assert.equal(discover.body?.ok, true)
  assert.equal(discover.headers.get("access-control-allow-origin"), CF_ORIGIN)
  assert.equal(discover.body?.pairing?.pairingRequired, true)

  const badPair = await invoke(handler, {
    method: "POST",
    url: "/api/companion/pair",
    headers: { Origin: CF_ORIGIN, "Content-Type": "application/json" },
    body: { code: "000000" },
  })
  assert.equal(badPair.status, 401)

  const pairRes = await invoke(handler, {
    method: "POST",
    url: "/api/companion/pair",
    headers: { Origin: CF_ORIGIN, "Content-Type": "application/json" },
    body: { code: pairCode },
  })
  assert.equal(pairRes.status, 200)
  const token = pairRes.body.token
  assert.ok(token)

  const sessionDenied = await invoke(handler, {
    method: "POST",
    url: "/api/voice/xinqi/session",
    headers: { Origin: CF_ORIGIN, "Content-Type": "application/json" },
    body: {},
  })
  assert.equal(sessionDenied.status, 401)

  const sessionOk = await invoke(handler, {
    method: "POST",
    url: "/api/voice/xinqi/session",
    headers: {
      Origin: CF_ORIGIN,
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: {},
  })
  assert.equal(sessionOk.status, 200)
  assert.equal(sessionOk.body?.gatewaySessionId, "gw-test")

  xinqiOk = false
  const discoverXinqiDown = await invoke(handler, {
    method: "GET",
    url: "/api/companion/discover",
    headers: { Origin: CF_ORIGIN, Accept: "application/json" },
  })
  assert.equal(discoverXinqiDown.body?.xinqi?.reachable, false)
}

{
  // WS upgrade: Origin + pairing
  const pairingStore = createPairingStore({
    statePath: path.join(os.tmpdir(), `facedev-c3-${Date.now()}.json`),
    codeTtlMs: 60_000,
    tokenTtlMs: 60_000,
  })
  const code2 = pairingStore.ensurePairingCode()
  const token2 = pairingStore.pairWithCode(code2, CF_ORIGIN).token
  const sessionStore = createXinqiGatewaySessionStore()
  const created = sessionStore.create({
    upstreamToken: "upstream-test",
    sessionId: "s-ws",
    protocol: { version: 1 },
  })

  const mockUpstream = new WebSocketServer({ port: 0, host: "127.0.0.1" })
  await new Promise((r) => mockUpstream.once("listening", r))
  const upstreamPort = mockUpstream.address().port
  mockUpstream.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "ready" }))
  })

  const server = http.createServer((_req, res) => {
    res.statusCode = 404
    res.end()
  })
  attachXinqiRealtimeGateway({
    httpServer: server,
    sessionStore,
    getUpstreamWsBaseUrl: () => `ws://127.0.0.1:${upstreamPort}`,
    getUpstreamOrigin: () => "http://127.0.0.1",
    authorizeUpgrade: (req) => authorizeCompanionUpgrade(req, {
      allowedOrigins: COMPANION_DEFAULT_ALLOWED_ORIGINS,
      pairingStore,
    }),
  })
  const port = await listen(server)

  await new Promise((resolve, reject) => {
    const bad = new WebSocket(
      `ws://127.0.0.1:${port}/api/voice/xinqi/realtime?session=${created.body.gatewaySessionId}`,
      { headers: { Origin: "https://evil.example" } },
    )
    bad.on("unexpected-response", (_req, res) => {
      assert.equal(res.statusCode, 403)
      resolve()
    })
    bad.on("open", () => reject(new Error("evil origin should not open")))
    bad.on("error", () => resolve())
  })

  await new Promise((resolve, reject) => {
    const ok = new WebSocket(
      `ws://127.0.0.1:${port}/api/voice/xinqi/realtime?session=${created.body.gatewaySessionId}&pairing=${encodeURIComponent(token2)}`,
      { headers: { Origin: CF_ORIGIN } },
    )
    const timer = setTimeout(() => reject(new Error("ws open timeout")), 3000)
    ok.on("open", () => {
      clearTimeout(timer)
      ok.close()
      resolve()
    })
    ok.on("error", reject)
  })

  server.close()
  mockUpstream.close()
}

console.log("companion.selftest ok")
