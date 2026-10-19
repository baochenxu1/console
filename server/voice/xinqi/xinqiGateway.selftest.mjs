/**
 * Xinqi Gateway Phase 1 selftest（mock upstream，不访问真实云）。
 */
import assert from "node:assert/strict"
import http from "node:http"
import { WebSocketServer, WebSocket } from "ws"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { resolveVoiceServerConfig } from "../loadEnv.js"
import {
  DEFAULT_XINQI_BASE_URL,
  normalizeXinqiBaseUrl,
  validateXinqiProtocol,
  XINQI_EXPECTED_PROTOCOL,
  XINQI_INPUT_FRAME_BYTES,
} from "./xinqiConfig.js"
import { XINQI_ERROR_CODES } from "./xinqiErrors.js"
import { createXinqiClient } from "./xinqiClient.js"
import { createXinqiGatewaySessionStore } from "./xinqiGatewaySession.js"
import { createXinqiGatewayHttpHandler } from "./createXinqiGatewayHandler.js"
import { attachXinqiRealtimeGateway } from "./xinqiRealtimeGateway.js"

function makeProtocol(overrides = {}) {
  return {
    version: 1,
    websocketPath: "/api/realtime",
    inputAudio: { ...XINQI_EXPECTED_PROTOCOL.inputAudio },
    outputAudio: { ...XINQI_EXPECTED_PROTOCOL.outputAudio },
    ...overrides,
  }
}

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(k, v) { this.headers[k] = v },
    end(text) { this.body = text },
  }
}

async function invoke(handler, { method, url, body }) {
  const req = {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (body != null) yield Buffer.from(JSON.stringify(body))
    },
  }
  const res = mockRes()
  await handler(req, res)
  return {
    status: res.statusCode,
    body: res.body ? JSON.parse(res.body) : null,
  }
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      resolve(addr.port)
    })
  })
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (predicate()) return resolve(true)
      } catch (error) {
        return reject(error)
      }
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"))
      setTimeout(tick, 20)
    }
    tick()
  })
}

// --- Config ---
{
  const ok = normalizeXinqiBaseUrl("")
  assert.equal(ok.ok, true)
  assert.equal(ok.baseUrl, DEFAULT_XINQI_BASE_URL)
  assert.equal(ok.origin, "http://127.0.0.1:3212")

  const custom = normalizeXinqiBaseUrl("https://xinqi.example.com/")
  assert.equal(custom.ok, true)
  assert.equal(custom.baseUrl, "https://xinqi.example.com")
  assert.equal(custom.wsBaseUrl, "wss://xinqi.example.com")

  assert.equal(normalizeXinqiBaseUrl("javascript:alert(1)").ok, false)
  assert.equal(normalizeXinqiBaseUrl("file:///tmp").ok, false)
  assert.equal(normalizeXinqiBaseUrl("http://user:pass@127.0.0.1:3212").ok, false)

  const dir = mkdtempSync(path.join(tmpdir(), "facedev-xinqi-env-"))
  writeFileSync(
    path.join(dir, ".env"),
    "XINQI_BASE_URL=http://127.0.0.1:3999\nXINQI_ROBOT_API_KEY=robot_secret_test\n",
    "utf8",
  )
  const cfg = resolveVoiceServerConfig({ root: dir, processEnv: {} })
  assert.equal(cfg.xinqiBaseUrl, "http://127.0.0.1:3999")
  assert.equal(cfg.xinqiRobotApiKey, "robot_secret_test")
  assert.equal(cfg.hasXinqiRobotApiKey, true)
  const publicShape = JSON.stringify({
    baseUrl: cfg.xinqiBaseUrl,
    hasKey: cfg.hasXinqiRobotApiKey,
  })
  assert.equal(publicShape.includes("robot_secret_test"), false)
  rmSync(dir, { recursive: true, force: true })
}

// --- Protocol ---
{
  assert.equal(validateXinqiProtocol(makeProtocol()).ok, true)
  const bad = validateXinqiProtocol(makeProtocol({
    inputAudio: { ...XINQI_EXPECTED_PROTOCOL.inputAudio, frameBytes: 640 },
  }))
  assert.equal(bad.ok, false)
  assert.equal(bad.body.error.code, XINQI_ERROR_CODES.ProtocolUnsupported)
  assert.equal(JSON.stringify(bad.body).includes("token"), false)
}

// --- Robot connect / health mock ---
{
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith("/health")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { app: "xinqi-engine", version: "1.2.3", robotApi: "configured", status: "ok" }
        },
      }
    }
    if (String(url).includes("/api/robot/connect")) {
      const auth = init.headers?.Authorization || ""
      if (!auth.includes("Bearer good-key")) {
        return { ok: false, status: 401, async json() { return { error: "unauthorized" } } }
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            token: "upstream-short-token",
            sessionId: "sess-1",
            expiresInSeconds: 120,
            ownerId: "owner-should-not-leak",
            protocol: makeProtocol(),
          }
        },
      }
    }
    return { ok: false, status: 500, async json() { return {} } }
  }

  const client = createXinqiClient({
    baseUrl: "http://127.0.0.1:3212",
    robotApiKey: "good-key",
    fetchImpl,
  })
  const health = await client.health()
  assert.equal(health.status, 200)
  assert.equal(health.body.reachable, true)
  assert.equal(health.body.robotApi, "configured")
  assert.equal(JSON.stringify(health.body).includes("good-key"), false)

  const connected = await client.connectRobot()
  assert.equal(connected.status, 200)
  assert.equal(connected.body._upstreamToken, "upstream-short-token")
  assert.equal(connected.body.sessionId, "sess-1")

  const store = createXinqiGatewaySessionStore({ maxSessions: 2 })
  const handler = createXinqiGatewayHttpHandler({ client, sessionStore: store })
  const sessionRes = await invoke(handler, { method: "POST", url: "/api/voice/xinqi/session", body: {} })
  assert.equal(sessionRes.status, 200)
  assert.ok(sessionRes.body.gatewaySessionId)
  assert.equal(sessionRes.body.sessionId, "sess-1")
  assert.equal(JSON.stringify(sessionRes.body).includes("upstream-short-token"), false)
  assert.equal(JSON.stringify(sessionRes.body).includes("good-key"), false)
  assert.equal(JSON.stringify(sessionRes.body).includes("owner-should-not-leak"), false)

  const missing = createXinqiClient({
    baseUrl: "http://127.0.0.1:3212",
    robotApiKey: "",
    fetchImpl,
  })
  const missingRes = await missing.connectRobot()
  assert.equal(missingRes.body.error.code, XINQI_ERROR_CODES.MissingRobotApiKey)

  const badAuth = createXinqiClient({
    baseUrl: "http://127.0.0.1:3212",
    robotApiKey: "bad-key",
    fetchImpl,
  })
  const authRes = await badAuth.connectRobot()
  assert.equal(authRes.body.error.code, XINQI_ERROR_CODES.AuthFailed)

  const mismatchClient = createXinqiClient({
    baseUrl: "http://127.0.0.1:3212",
    robotApiKey: "good-key",
    fetchImpl: async (url, init) => {
      if (String(url).includes("/api/robot/connect")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              token: "t",
              sessionId: "s",
              protocol: makeProtocol({
                inputAudio: { ...XINQI_EXPECTED_PROTOCOL.inputAudio, frameBytes: 640 },
              }),
            }
          },
        }
      }
      return fetchImpl(url, init)
    },
  })
  const mismatch = await mismatchClient.connectRobot()
  assert.equal(mismatch.body.error.code, XINQI_ERROR_CODES.ProtocolUnsupported)
}

// --- Session lifecycle ---
{
  let now = 1000
  const store = createXinqiGatewaySessionStore({
    ttlMs: 50,
    maxSessions: 2,
    now: () => now,
    enableExpiryTimer: false,
    randomId: (() => {
      let i = 0
      return () => `gw-${++i}`
    })(),
  })
  const a = store.create({
    upstreamToken: "tok-a",
    sessionId: "s-a",
    protocol: makeProtocol(),
  })
  assert.equal(a.body.gatewaySessionId, "gw-1")
  assert.equal(store.get("gw-1").session.upstreamToken, "tok-a")
  store.markWsBound("gw-1")
  now = 10_000
  assert.equal(store.get("gw-1").status, 200)

  const b = store.create({
    upstreamToken: "tok-b",
    sessionId: "s-b",
    protocol: makeProtocol(),
  })
  assert.equal(b.status, 200)
  const c = store.create({
    upstreamToken: "tok-c",
    sessionId: "s-c",
    protocol: makeProtocol(),
  })
  assert.equal(c.body.error.code, XINQI_ERROR_CODES.SessionLimit)

  store.remove("gw-1")
  assert.equal(store.get("gw-1").body.error.code, XINQI_ERROR_CODES.SessionNotFound)

  const d = store.create({
    upstreamToken: "tok-d",
    sessionId: "s-d",
    protocol: makeProtocol(),
  })
  now = now + 100
  assert.equal(store.get(d.body.gatewaySessionId).body.error.code, XINQI_ERROR_CODES.SessionExpired)
  store.clearAll()
}

// --- WebSocket relay / origin / binary ---
{
  const upstreamOrigins = []
  const upstreamStarts = []
  const upstreamBinaries = []
  const upstreamControls = []

  const upstreamHttp = http.createServer()
  const upstreamWss = new WebSocketServer({ server: upstreamHttp, path: "/api/realtime" })
  upstreamWss.on("connection", (socket, req) => {
    upstreamOrigins.push(req.headers.origin || "")
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        upstreamBinaries.push(Buffer.from(data).byteLength)
        return
      }
      const msg = JSON.parse(String(data))
      if (msg.type === "start") {
        upstreamStarts.push(msg)
        socket.send(JSON.stringify({ type: "ready" }))
        return
      }
      upstreamControls.push(msg)
    })
  })
  const upstreamPort = await listen(upstreamHttp)
  const upstreamBase = `http://127.0.0.1:${upstreamPort}`

  const store = createXinqiGatewaySessionStore()
  const created = store.create({
    upstreamToken: "server-held-token",
    sessionId: "upstream-sess",
    protocol: makeProtocol(),
  })
  const gatewaySessionId = created.body.gatewaySessionId

  const gatewayHttp = http.createServer()
  const gateway = attachXinqiRealtimeGateway({
    httpServer: gatewayHttp,
    sessionStore: store,
    getUpstreamWsBaseUrl: () => upstreamBase.replace(/^http/i, "ws"),
    getUpstreamOrigin: () => new URL(upstreamBase).origin,
  })
  const gatewayPort = await listen(gatewayHttp)

  const browserMessages = []
  const browser = new WebSocket(
    `ws://127.0.0.1:${gatewayPort}/api/voice/xinqi/realtime?session=${gatewaySessionId}`,
  )
  browser.on("message", (data) => {
    browserMessages.push(JSON.parse(String(data)))
  })

  await waitFor(() => browser.readyState === WebSocket.OPEN)
  await waitFor(() => browserMessages.some((m) => m.type === "ready"))

  assert.deepEqual(upstreamOrigins, [`http://127.0.0.1:${upstreamPort}`])
  assert.equal(upstreamOrigins[0].includes("5173"), false)
  assert.equal(upstreamStarts.length, 1)
  assert.equal(upstreamStarts[0].token, "server-held-token")
  assert.equal(upstreamStarts[0].sessionId, "upstream-sess")
  assert.equal(upstreamStarts[0].microphone, true)

  browser.send(Buffer.alloc(XINQI_INPUT_FRAME_BYTES, 7))
  await waitFor(() => upstreamBinaries.includes(XINQI_INPUT_FRAME_BYTES))

  // 文本 control（playback.progress）不得被当成非法音频帧。
  browser.send(JSON.stringify({ type: "playback.progress", id: "turn-ack", samples: 6000 }))
  await waitFor(() => upstreamControls.some((m) => m.type === "playback.progress"))
  assert.equal(browserMessages.some((m) => m.code === XINQI_ERROR_CODES.InvalidAudioFrame), false)
  assert.equal(upstreamControls.find((m) => m.type === "playback.progress").samples, 6000)
  browser.send(JSON.stringify({ type: "playback.done", id: "turn-ack" }))
  await waitFor(() => upstreamControls.some((m) => m.type === "playback.done"))

  const badBrowserMessages = []
  const created2 = store.create({
    upstreamToken: "server-held-token-2",
    sessionId: "upstream-sess-2",
    protocol: makeProtocol(),
  })
  const browser2 = new WebSocket(
    `ws://127.0.0.1:${gatewayPort}/api/voice/xinqi/realtime?session=${created2.body.gatewaySessionId}`,
  )
  browser2.on("message", (data) => {
    badBrowserMessages.push(JSON.parse(String(data)))
  })
  await waitFor(() => browser2.readyState === WebSocket.OPEN)
  await waitFor(() => badBrowserMessages.some((m) => m.type === "ready"))
  browser2.send(Buffer.alloc(640, 1))
  await waitFor(() => badBrowserMessages.some((m) => m.code === XINQI_ERROR_CODES.InvalidAudioFrame))
  assert.equal(upstreamBinaries.includes(640), false)

  browser.close()
  browser2.close()
  gateway.close()
  await closeServer(gatewayHttp)
  upstreamWss.close()
  await closeServer(upstreamHttp)
  store.clearAll()
}

{
  // Upstream closes first → browser receives diagnostic error then close.
  const upstreamHttp = http.createServer()
  let upstreamSocket = null
  const upstreamWss = new WebSocketServer({ server: upstreamHttp })
  upstreamWss.on("connection", (socket) => {
    upstreamSocket = socket
    socket.on("message", (data, isBinary) => {
      if (isBinary) return
      const msg = JSON.parse(String(data))
      if (msg.type === "start") socket.send(JSON.stringify({ type: "ready" }))
    })
  })
  const upstreamPort = await listen(upstreamHttp)
  const upstreamBase = `http://127.0.0.1:${upstreamPort}`
  const store = createXinqiGatewaySessionStore()
  const created = store.create({
    upstreamToken: "server-held-token",
    sessionId: "upstream-sess-close",
    protocol: makeProtocol(),
  })
  const gatewayHttp = http.createServer()
  const gateway = attachXinqiRealtimeGateway({
    httpServer: gatewayHttp,
    sessionStore: store,
    getUpstreamWsBaseUrl: () => upstreamBase.replace(/^http/i, "ws"),
    getUpstreamOrigin: () => new URL(upstreamBase).origin,
  })
  const gatewayPort = await listen(gatewayHttp)
  const browserMessages = []
  let browserClosed = null
  const browser = new WebSocket(
    `ws://127.0.0.1:${gatewayPort}/api/voice/xinqi/realtime?session=${created.body.gatewaySessionId}`,
  )
  browser.on("message", (data) => browserMessages.push(JSON.parse(String(data))))
  browser.on("close", (code, reason) => {
    browserClosed = { code, reason: Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason || "") }
  })
  await waitFor(() => browser.readyState === WebSocket.OPEN)
  await waitFor(() => browserMessages.some((m) => m.type === "ready"))
  upstreamSocket.close(4000, "engine-stop")
  await waitFor(() => browserMessages.some((m) => m.type === "error" && m.closeSide === "upstream"))
  const diag = browserMessages.find((m) => m.type === "error" && m.closeSide === "upstream")
  assert.equal(diag.code, XINQI_ERROR_CODES.UpstreamUnavailable)
  assert.equal(diag.closeCode, 4000)
  assert.equal(diag.closeReason, "engine-stop")
  await waitFor(() => browserClosed != null)
  assert.equal(browserClosed.code, 1000)
  assert.ok(String(browserClosed.reason).includes("upstream"))
  gateway.close()
  await closeServer(gatewayHttp)
  upstreamWss.close()
  await closeServer(upstreamHttp)
  store.clearAll()
}

// --- Large Base64 audio / audio.done relay (Companion 与 Vite 共用同一 Gateway) ---
{
  const upstreamHttp = http.createServer()
  let upstreamSocket = null
  const upstreamWss = new WebSocketServer({ server: upstreamHttp, path: "/api/realtime" })
  upstreamWss.on("connection", (socket) => {
    upstreamSocket = socket
    socket.on("message", (data, isBinary) => {
      if (isBinary) return
      const msg = JSON.parse(String(data))
      if (msg.type === "start") socket.send(JSON.stringify({ type: "ready" }))
    })
  })
  const upstreamPort = await listen(upstreamHttp)
  const upstreamBase = `http://127.0.0.1:${upstreamPort}`
  const store = createXinqiGatewaySessionStore()
  const created = store.create({
    upstreamToken: "audio-relay-token",
    sessionId: "audio-relay-sess",
    protocol: makeProtocol(),
  })
  const gatewayHttp = http.createServer()
  const gateway = attachXinqiRealtimeGateway({
    httpServer: gatewayHttp,
    sessionStore: store,
    getUpstreamWsBaseUrl: () => upstreamBase.replace(/^http/i, "ws"),
    getUpstreamOrigin: () => new URL(upstreamBase).origin,
  })
  const gatewayPort = await listen(gatewayHttp)
  const browserMessages = []
  const browser = new WebSocket(
    `ws://127.0.0.1:${gatewayPort}/api/voice/xinqi/realtime?session=${created.body.gatewaySessionId}`,
  )
  browser.on("message", (data) => {
    browserMessages.push(JSON.parse(String(data)))
  })
  await waitFor(() => browser.readyState === WebSocket.OPEN)
  await waitFor(() => browserMessages.some((m) => m.type === "ready"))
  await waitFor(() => upstreamSocket != null)

  const pcmBytes = Buffer.alloc(48_000, 0x11) // 1s @ 24k mono s16le
  const b64 = pcmBytes.toString("base64")
  assert.ok(b64.length > 60_000)
  upstreamSocket.send(JSON.stringify({
    type: "turn.start",
    id: "turn-audio-1",
  }))
  upstreamSocket.send(JSON.stringify({
    type: "turn.text.done",
    id: "turn-audio-1",
    message: { content: "hello", turnId: "turn-audio-1" },
  }))
  for (let i = 0; i < 3; i += 1) {
    upstreamSocket.send(JSON.stringify({
      type: "audio",
      id: "turn-audio-1",
      sampleRate: 24000,
      channels: 1,
      format: "pcm_s16le",
      data: b64,
    }))
  }
  upstreamSocket.send(JSON.stringify({ type: "audio.done", id: "turn-audio-1" }))
  upstreamSocket.send(JSON.stringify({ type: "turn.done", id: "turn-audio-1" }))

  await waitFor(() => browserMessages.filter((m) => m.type === "audio").length >= 3)
  await waitFor(() => browserMessages.some((m) => m.type === "audio.done"))
  await waitFor(() => browserMessages.some((m) => m.type === "turn.done"))

  const audios = browserMessages.filter((m) => m.type === "audio")
  assert.equal(audios.length, 3)
  for (const msg of audios) {
    assert.equal(msg.id, "turn-audio-1")
    assert.equal(msg.sampleRate, 24000)
    assert.equal(msg.data.length, b64.length)
    assert.equal(msg.data.slice(0, 16), b64.slice(0, 16))
    assert.equal(msg.data.slice(-16), b64.slice(-16))
  }
  assert.equal(browserMessages.some((m) => m.type === "audio.done" && m.id === "turn-audio-1"), true)
  assert.equal(browserMessages.some((m) => m.type === "turn.text.done"), true)

  browser.close()
  gateway.close()
  await closeServer(gatewayHttp)
  upstreamWss.close()
  await closeServer(upstreamHttp)
  store.clearAll()
}

console.log("xinqiGateway.selftest ok")
