/**
 * Physical Neck Target Dispatch Hotfix — gates + diagnostics A–O.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { playKeyframes } from "./actionPlayer.js"
import { createDefaultFrameProject, normalizeFrameProject } from "./frameProject.js"
import { addCharacterKeyAtTime } from "./expressionKeyframeOps.js"
import { createInitialEliteRig } from "./faceDofMapper.js"
import {
  _resetNeckBridgeClientSingletonsForTest,
  createNeckBridgeClient,
  getSharedNeckBridgeClient,
  releaseSharedNeckBridgeClient,
} from "../sdk/neck/neckBridgeClient.js"
import {
  FACEDEV_NECK_PROTOCOL_VERSION,
  NECK_BRIDGE_CLIENT_STATES,
  NECK_TARGET_DISPATCH_DECISIONS,
} from "../sdk/neck/neckBridgeProtocol.js"
import { dispatchCharacterHardware } from "../sdk/expression/characterHardwareDispatch.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

_resetNeckBridgeClientSingletonsForTest()

class MockWebSocket {
  static OPEN = 1
  readyState = MockWebSocket.CONNECTING
  bufferedAmount = 0
  sent = []
  onopen = null
  onmessage = null
  onerror = null
  onclose = null
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
    }
  }
  close(code = 1000) {
    this.readyState = 3
    this.onclose?.({ code, wasClean: true })
  }
}

function mockFetch() {
  return (url) => {
    if (String(url).includes("health")) {
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

async function readyClient(extra = {}) {
  let lastSock = null
  class Cap extends MockWebSocket {
    constructor(url) {
      super(url)
      lastSock = this
    }
  }
  const client = createNeckBridgeClient({
    environment: chromeEnv(),
    fetch: mockFetch(),
    WebSocket: Cap,
    heartbeatIntervalMs: 50,
    staleAfterMs: 5000,
    ...extra,
  })
  await client.connect()
  client._injectNeckState({
    connected: true,
    enabled: true,
    streaming: true,
    hardwareExecutionEnabled: false,
    transport: { virtual: false, channel: "COM3" },
  })
  return { client, getSock: () => lastSock }
}

function targetMsgs(sock) {
  return (sock?.sent || [])
    .map((s) => {
      try {
        return JSON.parse(s)
      } catch {
        return null
      }
    })
    .filter((m) => m?.type === "neck.target")
}

test("A — Manual drag + preview OFF → no target send", async () => {
  const { client, getSock } = await readyClient()
  client.setHardwarePreview(false)
  const before = getSock().sent.length
  assert.equal(
    client.offerTarget({ pose: { pitch: 1, roll: 2, yaw: 0 }, timelineTimeMs: 0, source: "editor" }),
    false
  )
  assert.equal(
    client.getSnapshot().lastTargetDispatchDecision,
    NECK_TARGET_DISPATCH_DECISIONS.SKIPPED_HARDWARE_PREVIEW_OFF
  )
  assert.equal(targetMsgs(getSock()).length, 0)
  assert.equal(getSock().sent.length, before) // no new target (heartbeats may add — filter)
  client.disconnect()
})

test("B — Manual drag + preview ON + session/hw/enabled → SENT", async () => {
  const { client, getSock } = await readyClient()
  client.setHardwarePreview(true)
  assert.equal(
    client.offerTarget({ pose: { pitch: 1, roll: 2, yaw: 0 }, timelineTimeMs: 10, source: "editor" }),
    true
  )
  assert.equal(client.getSnapshot().lastTargetDispatchDecision, NECK_TARGET_DISPATCH_DECISIONS.SENT)
  const targets = targetMsgs(getSock())
  assert.ok(targets.length >= 1)
  const last = targets[targets.length - 1]
  assert.equal(last.pose.pitch, 1)
  assert.equal(last.pose.roll, 2)
  assert.equal(last.pose.yaw, 0)
  client.disconnect()
})

test("C — Timeline playback + preview OFF → target SENT", async () => {
  const { client, getSock } = await readyClient()
  client.setHardwarePreview(false)
  assert.equal(
    client.offerTarget({ pose: { pitch: 3, roll: 0, yaw: 0 }, timelineTimeMs: 100, source: "timeline" }),
    true
  )
  assert.equal(client.getSnapshot().lastTargetDispatchDecision, NECK_TARGET_DISPATCH_DECISIONS.SENT)
  assert.ok(targetMsgs(getSock()).some((m) => m.pose.pitch === 3))
  client.disconnect()
})

test("D — Timeline playback + preview ON → target SENT", async () => {
  const { client, getSock } = await readyClient()
  client.setHardwarePreview(true)
  assert.equal(
    client.offerTarget({ pose: { yaw: 5 }, timelineTimeMs: 50, source: "timeline" }),
    true
  )
  assert.ok(targetMsgs(getSock()).some((m) => m.pose.yaw === 5))
  client.disconnect()
})

test("E — productionReady=false does not block commissioning target", async () => {
  const { client, getSock } = await readyClient()
  assert.equal(client.getSnapshot().productionReady, false)
  assert.equal(client.offerTarget({ pose: { pitch: 1 }, source: "timeline" }), true)
  assert.ok(targetMsgs(getSock()).length >= 1)
  client.disconnect()
})

test("F — hardwareExecutionEnabled=false does not block", async () => {
  const { client, getSock } = await readyClient()
  assert.equal(client.getSnapshot().hardwareExecutionEnabled, false)
  assert.equal(client.offerTarget({ pose: { roll: 2 }, source: "timeline" }), true)
  assert.ok(targetMsgs(getSock()).length >= 1)
  client.disconnect()
})

test("G — session inactive → skipped reason", async () => {
  const client = createNeckBridgeClient({ environment: chromeEnv() })
  assert.equal(client.offerTarget({ pose: { pitch: 1 }, source: "timeline" }), false)
  assert.equal(
    client.getSnapshot().lastTargetDispatchDecision,
    NECK_TARGET_DISPATCH_DECISIONS.SKIPPED_SESSION_INACTIVE
  )
})

test("H — hardware disconnected → skipped reason", async () => {
  const { client } = await readyClient()
  client._injectNeckState({ connected: false, enabled: true })
  assert.equal(client.offerTarget({ pose: { pitch: 1 }, source: "timeline" }), false)
  assert.equal(
    client.getSnapshot().lastTargetDispatchDecision,
    NECK_TARGET_DISPATCH_DECISIONS.SKIPPED_HARDWARE_DISCONNECTED
  )
  client.disconnect()
})

test("I — disabled → skipped reason", async () => {
  const { client } = await readyClient()
  client._injectNeckState({ connected: true, enabled: false })
  assert.equal(client.offerTarget({ pose: { pitch: 1 }, source: "timeline" }), false)
  assert.equal(
    client.getSnapshot().lastTargetDispatchDecision,
    NECK_TARGET_DISPATCH_DECISIONS.SKIPPED_NOT_ENABLED
  )
  client.disconnect()
})

test("J — stale → skipped reason", async () => {
  const { client } = await readyClient()
  client._forceStale()
  assert.equal(client.offerTarget({ pose: { pitch: 1 }, source: "timeline" }), false)
  assert.equal(
    client.getSnapshot().lastTargetDispatchDecision,
    NECK_TARGET_DISPATCH_DECISIONS.SKIPPED_STALE
  )
  client.disconnect()
})

test("K — shared client after hardware connect", async () => {
  _resetNeckBridgeClientSingletonsForTest()
  const a = getSharedNeckBridgeClient({
    environment: chromeEnv(),
    fetch: mockFetch(),
    WebSocket: MockWebSocket,
    heartbeatIntervalMs: 50,
    staleAfterMs: 5000,
  })
  await a.connect()
  a._injectNeckState({ connected: true, enabled: true, transport: { channel: "COM3" } })
  const b = getSharedNeckBridgeClient()
  assert.equal(a.instanceId, b.instanceId)
  assert.equal(b.getSnapshot().hardwareConnected, true)
  assert.equal(b.offerTarget({ pose: { pitch: 1 }, source: "timeline" }), true)
  releaseSharedNeckBridgeClient()
  releaseSharedNeckBridgeClient()
  _resetNeckBridgeClientSingletonsForTest()
})

test("L — no stale closure: live inject enables subsequent dispatch", async () => {
  const { client } = await readyClient()
  // Simulate editor/timeline always reading via ref.current.getSnapshot / offerTarget
  const dispatchViaRef = (pose) => client.offerTarget({ pose, source: "timeline" })
  client._injectNeckState({ connected: false, enabled: false })
  assert.equal(dispatchViaRef({ pitch: 1 }), false)
  client._injectNeckState({ connected: true, enabled: true })
  assert.equal(dispatchViaRef({ pitch: 2 }), true)
  assert.equal(client.getSnapshot().lastTargetDispatchDecision, NECK_TARGET_DISPATCH_DECISIONS.SENT)
  client.disconnect()
})

test("M — target diagnostic counters", async () => {
  const { client } = await readyClient()
  client.offerTarget({ pose: { pitch: 1 }, timelineTimeMs: 7, source: "timeline" })
  client.offerTarget({ pose: { pitch: 2 }, timelineTimeMs: 14, source: "timeline" })
  const d = client.getSnapshot().targetDiagnostics
  assert.ok(d.targetPreparedCount >= 2)
  assert.ok(d.targetSendAttemptCount >= 1)
  assert.ok(d.targetSentCount >= 1)
  assert.equal(d.lastTargetPose.pitch, 2)
  assert.equal(d.lastTargetTimelineTimeMs, 14)
  assert.equal(d.lastTargetDispatchDecision, NECK_TARGET_DISPATCH_DECISIONS.SENT)
  client.disconnect()
})

test("N — Face no-profile still does not block Neck", async () => {
  let neckCalls = 0
  const result = await dispatchCharacterHardware({
    keyframe: { positions: {} },
    configs: [],
    sample: { timelineTimeMs: 0, characterPose: { neck: { pitch: 1, roll: 0, yaw: 0 } } },
    timelineTimeMs: 0,
    dispatchNeck: async () => {
      neckCalls += 1
      return { attempted: true, status: "SENT", sequence: 1, error: null }
    },
  })
  assert.equal(result.neck.status, "SENT")
  assert.ok(neckCalls >= 1)
  assert.ok(
    result.face.status === "SKIPPED_NO_PROFILE" ||
      result.face.status === "FAILED" ||
      result.face.status === "SKIPPED_NO_OUTPUTS" ||
      result.face.status === "DISCONNECTED" ||
      result.face.status === "SENT" ||
      result.face.status === "IDLE"
  )
})

test("O — SC/ST/RJ unchanged by Neck target dispatch layer", () => {
  const root = join(__dirname, "..")
  const clientSrc = readFileSync(join(root, "sdk/neck/neckBridgeClient.js"), "utf8")
  assert.equal(/servoCloud|SC_|rightMouth|fiveBar|RJ_|ST_/.test(clientSrc), false)
  const editorSrc = readFileSync(join(root, "sdk/react/FaceExpressionEditor.jsx"), "utf8")
  assert.ok(editorSrc.includes('source: "timeline"'))
  assert.ok(editorSrc.includes('source: "editor"'))
})

test("Timeline playKeyframes path sends with preview OFF", async () => {
  const { client, getSock } = await readyClient()
  client.setHardwarePreview(false)
  let p = createDefaultFrameProject([])
  p = addCharacterKeyAtTime(p, 0, createInitialEliteRig(), {}, [], {
    neck: { pitch: 0, roll: 0, yaw: 0 },
  })
  p = addCharacterKeyAtTime(p, 40, createInitialEliteRig(), {}, [], {
    neck: { pitch: 4, roll: 0, yaw: 0 },
  })
  p = normalizeFrameProject(p)
  let clock = 0
  await playKeyframes({
    keyframes: p.keyframes,
    frameProject: p,
    loop: false,
    hardwareIntervalMs: 10,
    clock: () => clock,
    scheduleUi: (cb) =>
      setTimeout(() => {
        clock += 20
        cb()
      }, 0),
    cancelUi: clearTimeout,
    scheduleHw: (cb) =>
      setInterval(() => {
        clock += 10
        cb()
      }, 5),
    clearHw: clearInterval,
    dispatchNeck: async (neck, meta) => {
      client.offerTarget({ pose: neck, timelineTimeMs: meta?.timelineTimeMs, source: "timeline" })
    },
    sendKeyframe: async () => {},
  })
  await new Promise((r) => setTimeout(r, 80))
  assert.ok(targetMsgs(getSock()).length >= 1)
  client.disconnect()
})
