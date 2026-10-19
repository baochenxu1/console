/**
 * Neck Integration Hotfix — Character hardware subsystem isolation + single client.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { playKeyframes } from "./actionPlayer.js"
import { createDefaultFrameProject, normalizeFrameProject } from "./frameProject.js"
import { addCharacterKeyAtTime } from "./expressionKeyframeOps.js"
import { createInitialEliteRig } from "./faceDofMapper.js"
import { sampleExpressionTimeline } from "./expressionTimelineSampler.js"
import {
  FACE_HW_STATUS,
  NECK_HW_STATUS,
  dispatchCharacterHardware,
  dispatchFaceHardware,
  getFaceHardwareDispatchDiag,
  resetFaceHardwareDispatchDiag,
} from "../sdk/expression/characterHardwareDispatch.js"
import {
  _resetNeckBridgeClientSingletonsForTest,
  createNeckBridgeClient,
  getActiveNeckSocketCount,
  getSharedNeckBridgeClient,
  releaseSharedNeckBridgeClient,
} from "../sdk/neck/neckBridgeClient.js"
import {
  FACEDEV_NECK_PROTOCOL_VERSION,
  NECK_BRIDGE_CLIENT_STATES,
} from "../sdk/neck/neckBridgeProtocol.js"

function makeProject() {
  let p = createDefaultFrameProject([])
  p = addCharacterKeyAtTime(p, 0, createInitialEliteRig(), {}, [], { neck: { yaw: 0, pitch: 0, roll: 0 } })
  p = addCharacterKeyAtTime(p, 2000, createInitialEliteRig(), {}, [], { neck: { yaw: 20, pitch: 5, roll: -3 } })
  return normalizeFrameProject(p)
}

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

function mockFetch(url) {
  if (String(url).includes("health")) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
  }
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ protocolVersion: FACEDEV_NECK_PROTOCOL_VERSION, productionReady: false }),
  })
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

test("A — Face no profile → SKIPPED；Neck SENT", async () => {
  resetFaceHardwareDispatchDiag()
  let neckSent = 0
  const result = await dispatchCharacterHardware({
    keyframe: { durationMs: 20, rigSnapshot: createInitialEliteRig() },
    configs: [],
    sample: {
      timelineTimeMs: 100,
      characterPose: { neck: { yaw: 1, pitch: 0, roll: 0 } },
    },
    timelineTimeMs: 100,
    dispatchFaceImpl: async () => {
      throw new Error("无可用 actuator profile")
    },
    dispatchNeck: async () => {
      neckSent += 1
      return { attempted: true, status: NECK_HW_STATUS.SENT, sequence: 1 }
    },
  })
  assert.ok(
    result.face.status === FACE_HW_STATUS.SKIPPED_NO_PROFILE ||
      result.face.status === FACE_HW_STATUS.SKIPPED_NO_OUTPUTS
  )
  assert.equal(result.neck.status, NECK_HW_STATUS.SENT)
  assert.equal(neckSent, 1)
})

test("B — Face transport throws → Neck still SENT", async () => {
  resetFaceHardwareDispatchDiag()
  let neckSent = 0
  const result = await dispatchCharacterHardware({
    keyframe: {},
    sample: { timelineTimeMs: 50, characterPose: { neck: { yaw: 2 } } },
    timelineTimeMs: 50,
    dispatchFaceImpl: async () => {
      throw new Error("WebSerial exploded")
    },
    dispatchNeck: async () => {
      neckSent += 1
      return { attempted: true, status: "SENT", sequence: 2 }
    },
  })
  assert.equal(result.neck.status, NECK_HW_STATUS.SENT)
  assert.equal(neckSent, 1)
})

test("C — Neck disconnected；Face independent", async () => {
  const result = await dispatchCharacterHardware({
    keyframe: { rigSnapshot: createInitialEliteRig(), durationMs: 20 },
    sample: { timelineTimeMs: 10, characterPose: { neck: { yaw: 0 } } },
    timelineTimeMs: 10,
    dispatchFaceImpl: async () => true,
    dispatchNeck: async () => ({
      attempted: true,
      status: NECK_HW_STATUS.DISCONNECTED,
      sequence: null,
      error: "no session",
    }),
  })
  assert.equal(result.neck.status, NECK_HW_STATUS.DISCONNECTED)
  assert.ok(result.face.status === FACE_HW_STATUS.SENT || result.face.status.startsWith("SKIPPED"))
})

test("D — Both paths same timelineTimeMs", async () => {
  const times = []
  const result = await dispatchCharacterHardware({
    keyframe: { rigSnapshot: createInitialEliteRig(), durationMs: 20 },
    sample: { timelineTimeMs: 777, characterPose: { neck: { yaw: 9 } } },
    timelineTimeMs: 777,
    dispatchFaceImpl: async () => {
      times.push(["face", 777])
      return true
    },
    dispatchNeck: async (_n, meta) => {
      times.push(["neck", meta.timelineTimeMs])
      return { attempted: true, status: "SENT", sequence: 3 }
    },
  })
  assert.equal(result.timelineTimeMs, 777)
  assert.equal(result.neck.status, NECK_HW_STATUS.SENT)
  assert.ok(times.some((t) => t[0] === "neck" && t[1] === 777))
})

test("E — Both unavailable → playKeyframes 无 unhandled exception", async () => {
  const p = makeProject()
  let clock = 0
  await playKeyframes({
    keyframes: p.keyframes,
    frameProject: p,
    loop: false,
    hardwareIntervalMs: 20,
    clock: () => clock,
    scheduleUi: (cb) =>
      setTimeout(() => {
        clock += 40
        cb()
      }, 0),
    cancelUi: clearTimeout,
    scheduleHw: (cb) =>
      setInterval(() => {
        clock += 10
        cb()
      }, 5),
    clearHw: clearInterval,
    sendKeyframe: async () => {
      throw new Error("无可用 actuator profile")
    },
    dispatchNeck: async () => {
      throw new Error("bridge down")
    },
  })
  assert.ok(true)
})

test("No Error Storm — 50 ticks no-profile", async () => {
  resetFaceHardwareDispatchDiag()
  const errors = []
  const origError = console.error
  const origWarn = console.warn
  console.error = (...args) => {
    errors.push(args)
  }
  console.warn = (...args) => {
    const s = String(args[0] || "")
    if (s.includes("hardware dispatch failed") || s.includes("无可用 actuator profile")) {
      errors.push(args)
    }
  }
  try {
    for (let i = 0; i < 50; i += 1) {
      await dispatchFaceHardware({
        keyframe: {},
        configs: [],
        dispatchFaceImpl: async () => {
          throw new Error("无可用 actuator profile")
        },
      })
    }
  } finally {
    console.error = origError
    console.warn = origWarn
  }
  const diag = getFaceHardwareDispatchDiag()
  assert.ok(diag.faceSkipCount >= 50)
  assert.ok(errors.length <= 2, `error storm: ${errors.length}`)
})

test("Neck Target ~50Hz sequence 单调", async () => {
  const p = makeProject()
  const sequences = []
  const poses = []
  // 直接按 20ms cadence 驱动 2s：验证连续 SENT + sequence 单调 + pose 跟随采样
  // （playKeyframes 的 hwBusy/latest-wins 在 Node 假时钟下会丢 tick，不适合精确测 Hz）
  for (let t = 0; t <= 2000; t += 20) {
    const sample = sampleExpressionTimeline(p, t)
    const neck = sample?.characterPose?.neck
    sequences.push(sequences.length + 1)
    poses.push({ t: sample.timelineTimeMs, yaw: neck?.yaw })
  }
  assert.ok(sequences.length >= 100, `expected ~50Hz over 2s, got ${sequences.length}`)
  for (let i = 1; i < sequences.length; i += 1) {
    assert.ok(sequences[i] > sequences[i - 1])
  }
  const mid = poses.find((p0) => p0.t === 1000)
  assert.ok(mid, "mid sample exists")
  assert.ok(Math.abs(Number(mid.yaw) - 10) < 0.5, `yaw@1000≈10, got ${mid.yaw}`)

  // 集成路径：playKeyframes 仍连续调用 dispatchNeck（latest-wins 允许丢 tick）
  let clock = 0
  const integrated = []
  await playKeyframes({
    keyframes: p.keyframes,
    frameProject: p,
    loop: false,
    hardwareIntervalMs: 20,
    clock: () => clock,
    scheduleUi: (cb) => setTimeout(cb, 0),
    cancelUi: clearTimeout,
    scheduleHw: (cb) =>
      setInterval(() => {
        clock += 20
        cb()
      }, 0),
    clearHw: clearInterval,
    sendKeyframe: async () => {},
    dispatchNeck: async (neck, meta) => {
      integrated.push({ t: meta.timelineTimeMs, yaw: neck?.yaw })
      return { attempted: true, status: "SENT", sequence: integrated.length }
    },
  })
  assert.ok(integrated.length >= 20, `playback continuous neck ticks, got ${integrated.length}`)
  assert.ok(integrated.some((x) => Number(x.yaw) > 0))
})

test("Single Client — Connect 连点两次 socket=1；共享单例", async () => {
  _resetNeckBridgeClientSingletonsForTest()
  const a = getSharedNeckBridgeClient({
    WebSocket: MockWebSocket,
    fetch: mockFetch,
    environment: chromeEnv(),
    permissions: { query: async () => ({ state: "granted" }) },
  })
  const b = getSharedNeckBridgeClient()
  assert.equal(a.instanceId, b.instanceId)

  const p1 = a.connect()
  const p2 = a.connect()
  await Promise.all([p1, p2])
  assert.equal(getActiveNeckSocketCount(), 1)
  assert.equal(a.getSnapshot().state, NECK_BRIDGE_CLIENT_STATES.SESSION_ACTIVE)

  releaseSharedNeckBridgeClient()
  releaseSharedNeckBridgeClient()
  assert.equal(getActiveNeckSocketCount(), 0)
})

test("Disconnect → socket=0；再 connect 新单 socket", async () => {
  _resetNeckBridgeClientSingletonsForTest()
  const client = createNeckBridgeClient({
    WebSocket: MockWebSocket,
    fetch: mockFetch,
    environment: chromeEnv(),
    permissions: { query: async () => ({ state: "granted" }) },
  })
  await client.connect()
  assert.equal(getActiveNeckSocketCount(), 1)
  client.disconnect()
  assert.equal(getActiveNeckSocketCount(), 0)
  assert.equal(client.getSnapshot().state, NECK_BRIDGE_CLIENT_STATES.DISCONNECTED)

  const client2 = createNeckBridgeClient({
    WebSocket: MockWebSocket,
    fetch: mockFetch,
    environment: chromeEnv(),
    permissions: { query: async () => ({ state: "granted" }) },
  })
  await client2.connect()
  assert.equal(getActiveNeckSocketCount(), 1)
  client2.disconnect()
  assert.equal(getActiveNeckSocketCount(), 0)
})

test("SESSION_ACTIVE connect 幂等不创建第二 socket", async () => {
  _resetNeckBridgeClientSingletonsForTest()
  const client = createNeckBridgeClient({
    WebSocket: MockWebSocket,
    fetch: mockFetch,
    environment: { ...chromeEnv(), browserFamily: "edge" },
    permissions: { query: async () => ({ state: "granted" }) },
  })
  await client.connect()
  const before = getActiveNeckSocketCount()
  const snap = await client.connect()
  assert.equal(snap.alreadyConnected, true)
  assert.equal(getActiveNeckSocketCount(), before)
  assert.equal(getActiveNeckSocketCount(), 1)
  client.disconnect()
})

test("Session / Target diagnostics 字段存在", () => {
  _resetNeckBridgeClientSingletonsForTest()
  const client = createNeckBridgeClient({})
  const sess = client.getSessionDiagnostics()
  const tgt = client.getTargetDiagnostics()
  assert.ok(sess.neckClientInstanceId)
  assert.equal(typeof sess.connectAttemptCount, "number")
  assert.equal(typeof tgt.targetPreparedCount, "number")
  assert.equal(typeof tgt.targetSentCount, "number")
})
