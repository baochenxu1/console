/**
 * Neck Physical Debug 字段映射测试
 */
import assert from "node:assert/strict"
import test from "node:test"
import { mapNeckPhysicalDebugView } from "../sdk/neck/neckPhysicalDebug.js"
import { createNeckBridgeClient } from "../sdk/neck/neckBridgeClient.js"
import { FACEDEV_NECK_PROTOCOL_VERSION } from "../sdk/neck/neckBridgeProtocol.js"

function sampleNeckState(overrides = {}) {
  return {
    connected: true,
    enabled: false,
    streaming: true,
    hardwareExecutionEnabled: false,
    targetPose: { pitch: 1.25, roll: -2.5, yaw: 10 },
    diagnostics: {
      commandLoopTickCount: 42,
      last0x32: "00 11 22 33 44 55 66 77",
    },
    transport: { virtual: true, channel: "virtual" },
    safety: { limited: true, reason: "vel_cap" },
    joints: {
      "1": { motorId: 1, online: true, enabled: false },
      "2": { motorId: 2, online: true, enabled: false },
      "3": { motorId: 3, online: false, enabled: false },
    },
    ...overrides,
  }
}

test("Physical Debug — null state → all dashes", () => {
  const v = mapNeckPhysicalDebugView(null)
  assert.equal(v.hasState, false)
  assert.equal(v.connected, "—")
  assert.equal(v.enabled, "—")
  assert.equal(v.streaming, "—")
  assert.equal(v.hardwareExec, "—")
  assert.equal(v.targetPitch, "—")
  assert.equal(v.targetRoll, "—")
  assert.equal(v.targetYaw, "—")
  assert.equal(v.commandLoopTicks, "—")
  assert.equal(v.last0x32, "—")
  assert.equal(v.transportVirtual, "—")
  assert.equal(v.transportChannel, "—")
  assert.equal(v.safetyLimited, "—")
  assert.equal(v.safetyReason, "—")
  assert.equal(v.joint1, "—")
  assert.equal(v.joint2, "—")
  assert.equal(v.joint3, "—")
})

test("Physical Debug — full Luvia-shaped snapshot mapping", () => {
  const v = mapNeckPhysicalDebugView(sampleNeckState())
  assert.equal(v.hasState, true)
  assert.equal(v.connected, "true")
  assert.equal(v.enabled, "false")
  assert.equal(v.streaming, "true")
  assert.equal(v.hardwareExec, "false")
  assert.equal(v.targetPitch, "1.25")
  assert.equal(v.targetRoll, "-2.50")
  assert.equal(v.targetYaw, "10.00")
  assert.equal(v.commandLoopTicks, "42")
  assert.equal(v.last0x32, "00 11 22 33 44 55 66 77")
  assert.equal(v.transportVirtual, "true")
  assert.equal(v.transportChannel, "virtual")
  assert.equal(v.safetyLimited, "true")
  assert.equal(v.safetyReason, "vel_cap")
  assert.equal(v.joint1, "true/false")
  assert.equal(v.joint2, "true/false")
  assert.equal(v.joint3, "false/false")
})

test("Physical Debug — missing nested fields → dashes", () => {
  const v = mapNeckPhysicalDebugView({
    connected: true,
    // no targetPose / diagnostics / transport / safety / joints
  })
  assert.equal(v.connected, "true")
  assert.equal(v.targetPitch, "—")
  assert.equal(v.commandLoopTicks, "—")
  assert.equal(v.last0x32, "—")
  assert.equal(v.transportVirtual, "—")
  assert.equal(v.safetyReason, "—")
  assert.equal(v.joint1, "—")
  assert.equal(v.joint3, "—")
})

test("Physical Debug — client stores neck.state without console spam path", async () => {
  const logs = []
  const origLog = console.log
  console.log = (...args) => {
    logs.push(args.join(" "))
  }

  class MockWs {
    static OPEN = 1
    readyState = 0
    bufferedAmount = 0
    onopen = null
    onmessage = null
    onerror = null
    onclose = null
    constructor() {
      queueMicrotask(() => {
        this.readyState = MockWs.OPEN
        this.onopen?.({})
      })
    }
    send(data) {
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
          this.onmessage?.({
            data: JSON.stringify({ type: "neck.state", state: sampleNeckState() }),
          })
        })
      }
    }
    close() {
      this.readyState = 3
      this.onclose?.({ code: 1000, wasClean: true })
    }
  }

  try {
    const client = createNeckBridgeClient({
      fetch: async (url) => {
        const u = String(url)
        if (u.includes("/health")) {
          return { ok: true, status: 200, async json() { return { ok: true } } }
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return { protocolVersion: FACEDEV_NECK_PROTOCOL_VERSION, productionReady: false }
          },
        }
      },
      WebSocket: MockWs,
      environment: {
        isSecureContext: true,
        isChromiumFamily: true,
        isLoopbackPage: true,
        browserFamily: "chrome",
      },
      permissions: {
        async query() {
          throw new Error("unsupported")
        },
      },
      heartbeatIntervalMs: 5000,
      staleAfterMs: 10000,
      neckStateUiEmitMinMs: 1,
    })
    await client.connect()
    await new Promise((r) => setTimeout(r, 30))
    const snap = client.getSnapshot()
    const view = mapNeckPhysicalDebugView(snap.neckState)
    assert.equal(view.streaming, "true")
    assert.equal(view.commandLoopTicks, "42")
    assert.equal(view.joint1, "true/false")
    assert.ok(!logs.some((l) => /neck\.state/i.test(l)))
    client.disconnect()
  } finally {
    console.log = origLog
  }
})
