/**
 * Physical Neck Connection Hotfix — Runtime vs Hardware + enable gate.
 * Tests A–J (scoped to FaceDEV client/protocol; SC/ST/RJ untouched by absence).
 */
import assert from "node:assert/strict"
import test from "node:test"
import { createDefaultFrameProject, normalizeFrameProject } from "./frameProject.js"
import { addCharacterKeyAtTime } from "./expressionKeyframeOps.js"
import { createInitialEliteRig } from "./faceDofMapper.js"
import { sampleExpressionTimeline } from "./expressionTimelineSampler.js"
import {
  createNeckBridgeClient,
  _resetNeckBridgeClientSingletonsForTest,
} from "../sdk/neck/neckBridgeClient.js"
import {
  FACEDEV_NECK_PROTOCOL_VERSION,
  NECK_BRIDGE_CLIENT_STATES,
  createNeckConnectMessage,
  createNeckDisconnectMessage,
} from "../sdk/neck/neckBridgeProtocol.js"
import { NECK_BRIDGE_ERROR_CODES } from "../sdk/neck/neckBridgeErrors.js"

_resetNeckBridgeClientSingletonsForTest()

class MockWebSocket {
  static OPEN = 1
  static CONNECTING = 0
  readyState = MockWebSocket.CONNECTING
  bufferedAmount = 0
  sent = []
  onopen = null
  onmessage = null
  onerror = null
  onclose = null
  /** @type {{ failConnect?: boolean, connectReason?: string }} */
  behavior = {}
  constructor(url) {
    this.url = url
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN
      this.onopen?.({})
    })
  }
  send(data) {
    this.sent.push(String(data))
    const msg = JSON.parse(String(data))
    if (msg.type === "client.hello") {
      queueMicrotask(() => {
        this.onmessage?.({
          data: JSON.stringify({
            type: "server.hello",
            accepted: true,
            protocolVersion: FACEDEV_NECK_PROTOCOL_VERSION,
          }),
        })
      })
      return
    }
    if (msg.type === "neck.connect") {
      queueMicrotask(() => {
        if (this.behavior.failConnect) {
          this.onmessage?.({
            data: JSON.stringify({
              type: "neck.connectResult",
              id: msg.id,
              ok: false,
              reason: this.behavior.connectReason || "未选择 COM 端口",
            }),
          })
          return
        }
        this.onmessage?.({
          data: JSON.stringify({
            type: "neck.connectResult",
            id: msg.id,
            ok: true,
            virtual: Boolean(msg.virtual),
          }),
        })
        // Simulate bridge state stream after successful connect
        this.onmessage?.({
          data: JSON.stringify({
            type: "neck.state",
            state: {
              connected: true,
              enabled: false,
              streaming: false,
              hardwareExecutionEnabled: false,
              targetPose: { pitch: 0, roll: 0, yaw: 0 },
              transport: { virtual: Boolean(msg.virtual), channel: String(msg.channel || "") },
              diagnostics: { commandLoopTickCount: 0, last0x32: "00 00 00 00 00 00 00 00" },
            },
          }),
        })
      })
      return
    }
    if (msg.type === "neck.disconnect") {
      queueMicrotask(() => {
        this.onmessage?.({
          data: JSON.stringify({
            type: "neck.disconnectResult",
            id: msg.id,
            ok: true,
          }),
        })
        this.onmessage?.({
          data: JSON.stringify({
            type: "neck.state",
            state: {
              connected: false,
              enabled: false,
              streaming: false,
              hardwareExecutionEnabled: false,
              transport: { virtual: false, channel: "" },
            },
          }),
        })
      })
      return
    }
    if (msg.type === "neck.enable") {
      queueMicrotask(() => {
        this.onmessage?.({
          data: JSON.stringify({
            type: "neck.enableResult",
            id: msg.id,
            ok: true,
            state: "ENABLED",
          }),
        })
        this.onmessage?.({
          data: JSON.stringify({
            type: "neck.state",
            state: {
              connected: true,
              enabled: true,
              streaming: true,
              hardwareExecutionEnabled: false,
              transport: { virtual: false, channel: "COM5" },
              diagnostics: { commandLoopTickCount: 12, last0x32: "01 02 03 04 05 06 07 08" },
            },
          }),
        })
      })
    }
  }
  close(code = 1000) {
    this.readyState = 3
    this.onclose?.({ code, wasClean: true })
  }
}

function mockFetchFactory({ ports = ["COM3", "COM5"] } = {}) {
  return function mockFetch(url) {
    const u = String(url)
    if (u.includes("/v1/ports")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, ports }),
      })
    }
    if (u.includes("health")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        protocolVersion: FACEDEV_NECK_PROTOCOL_VERSION,
        productionReady: false,
        runtimeSafetyMode: "COMMISSIONING_OPEN_LOOP",
      }),
    })
  }
}

function chromeEnv() {
  return {
    isSecureContext: true,
    hostname: "localhost",
    browserFamily: "chrome",
    isChromiumFamily: true,
    isLoopbackPage: true,
  }
}

async function sessionClient(extra = {}) {
  const client = createNeckBridgeClient({
    environment: chromeEnv(),
    fetch: mockFetchFactory(),
    WebSocket: MockWebSocket,
    heartbeatIntervalMs: 50,
    staleAfterMs: 5000,
    ...extra,
  })
  const snap = await client.connect()
  assert.equal(snap.state, NECK_BRIDGE_CLIENT_STATES.SESSION_ACTIVE)
  return client
}

test("C — neck.connect schema uses channel + virtual (not port)", () => {
  const msg = createNeckConnectMessage({
    sessionId: "s1",
    sequence: 2,
    channel: "COM5",
    virtual: false,
    id: "c1",
  })
  assert.equal(msg.type, "neck.connect")
  assert.equal(msg.channel, "COM5")
  assert.equal(msg.virtual, false)
  assert.equal(msg.id, "c1")
  assert.equal("port" in msg, false)
  const d = createNeckDisconnectMessage({ sessionId: "s1", sequence: 3, id: "d1" })
  assert.equal(d.type, "neck.disconnect")
})

test("A — Bridge session active + hardware disconnected clearly represented", async () => {
  const client = await sessionClient()
  const snap = client.getSnapshot()
  assert.equal(snap.runtimeConnected, true)
  assert.equal(snap.hardwareConnected, false)
  assert.equal(snap.state, NECK_BRIDGE_CLIENT_STATES.SESSION_ACTIVE)
  client.disconnect()
})

test("B — Enable while hardware disconnected → HARDWARE_NOT_CONNECTED", async () => {
  const client = await sessionClient()
  assert.equal(client.enable(), false)
  const snap = client.getSnapshot()
  assert.equal(snap.lastErrorObj?.code, NECK_BRIDGE_ERROR_CODES.HARDWARE_NOT_CONNECTED)
  assert.equal(snap.hardwareConnected, false)
  client.disconnect()
})

test("D — successful hardware connect → connected true / channel set", async () => {
  const client = await sessionClient()
  const result = await client.connectHardware({ channel: "COM5", virtual: false })
  assert.equal(result.ok, true)
  // allow microtask state inject
  await new Promise((r) => queueMicrotask(r))
  await new Promise((r) => setTimeout(r, 10))
  const snap = client.getSnapshot()
  assert.equal(snap.hardwareConnected, true)
  assert.equal(snap.hardwareChannel, "COM5")
  assert.equal(snap.neckState?.connected, true)
  assert.equal(snap.neckState?.enabled, false) // E — no auto-enable
  client.disconnect()
})

test("E — connect does not auto-enable", async () => {
  const client = await sessionClient()
  await client.connectHardware({ channel: "COM5" })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(client.getSnapshot().neckState?.enabled, false)
  assert.equal(client.getSnapshot().hardwareConnected, true)
  client.disconnect()
})

test("F — enable after hardware connection sends neck.enable", async () => {
  let lastSocket = null
  class CaptureWs extends MockWebSocket {
    constructor(url) {
      super(url)
      lastSocket = this
    }
  }
  const client = createNeckBridgeClient({
    environment: chromeEnv(),
    fetch: mockFetchFactory(),
    WebSocket: CaptureWs,
    heartbeatIntervalMs: 50,
    staleAfterMs: 5000,
  })
  await client.connect()
  await client.connectHardware({ channel: "COM5" })
  await new Promise((r) => setTimeout(r, 15))
  assert.equal(client.enable(), true)
  const types = lastSocket.sent.map((s) => JSON.parse(s).type)
  assert.ok(types.includes("neck.enable"))
  client.disconnect()
})

test("G — hardware disconnect clears connected", async () => {
  const client = await sessionClient()
  await client.connectHardware({ channel: "COM5" })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(client.getSnapshot().hardwareConnected, true)
  const r = await client.disconnectHardware()
  assert.equal(r.ok, true)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(client.getSnapshot().hardwareConnected, false)
  assert.equal(client.getSnapshot().runtimeConnected, true)
  client.disconnect()
})

test("H — Face playback / project sampling unaffected", () => {
  let p = createDefaultFrameProject([])
  p = addCharacterKeyAtTime(p, 0, createInitialEliteRig(), {}, [], {
    neck: { yaw: 0, pitch: 0, roll: 0 },
  })
  p = addCharacterKeyAtTime(p, 1000, createInitialEliteRig(), {}, [], {
    neck: { yaw: 5, pitch: 1, roll: -1 },
  })
  p = normalizeFrameProject(p)
  const s = sampleExpressionTimeline(p, 500)
  assert.ok(s?.characterPose?.face)
  assert.ok(s?.characterPose?.neck)
})

test("I — Neck Timeline still continuous (character pose path)", () => {
  let p = createDefaultFrameProject([])
  p = addCharacterKeyAtTime(p, 0, createInitialEliteRig(), {}, [], {
    neck: { yaw: 0, pitch: 0, roll: 0 },
  })
  p = addCharacterKeyAtTime(p, 1000, createInitialEliteRig(), {}, [], {
    neck: { yaw: 10, pitch: 0, roll: 0 },
  })
  p = normalizeFrameProject(p)
  const a = sampleExpressionTimeline(p, 0)
  const b = sampleExpressionTimeline(p, 500)
  const c = sampleExpressionTimeline(p, 1000)
  assert.equal(a.characterPose.neck.yaw, 0)
  assert.ok(b.characterPose.neck.yaw > 0 && b.characterPose.neck.yaw < 10)
  assert.equal(c.characterPose.neck.yaw, 10)
})

test("J — listHardwarePorts uses GET /v1/ports (discovery)", async () => {
  const urls = []
  const fetchWrap = (url, ...rest) => {
    urls.push(String(url))
    return mockFetchFactory()(url, ...rest)
  }
  const client = createNeckBridgeClient({
    environment: chromeEnv(),
    fetch: fetchWrap,
    WebSocket: MockWebSocket,
    heartbeatIntervalMs: 50,
    staleAfterMs: 5000,
  })
  await client.connect()
  const r = await client.listHardwarePorts()
  assert.equal(r.ok, true)
  assert.deepEqual(r.ports, ["COM3", "COM5"])
  assert.ok(urls.some((u) => u.includes("/v1/ports")))
  client.disconnect()
})

test("channel required when virtual=false", async () => {
  const client = await sessionClient()
  const r = await client.connectHardware({ channel: "", virtual: false })
  assert.equal(r.ok, false)
  assert.equal(r.reason, NECK_BRIDGE_ERROR_CODES.CHANNEL_REQUIRED)
  client.disconnect()
})
