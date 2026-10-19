/**
 * R4 — Browser-Native Neck Runtime (Worker + 100Hz + Enable + Watchdog).
 * Covers A–AO with FakeWorker / pure modules (no real Serial).
 */

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"

import {
  BROWSER_NECK_RUNTIME_STATES,
  isBrowserNeckRuntimeTransitionAllowed,
  normalizeBrowserNeckRuntimeState,
} from "../sdk/neck/runtime/browserNeckRuntimeStates.js"
import {
  createRuntimeScheduler,
  NOMINAL_RUNTIME_PERIOD_MS,
} from "../sdk/neck/runtime/runtimeScheduler.js"
import {
  COMMAND_PRIORITY,
  createCommandPriorityQueue,
  commandPriorityRank,
} from "../sdk/neck/runtime/commandPriority.js"
import {
  buildEnableSequenceSteps,
  createEnableSequenceRunner,
  resolveUserZeroMotorCommand,
} from "../sdk/neck/runtime/enableSequence.js"
import { createNeckRuntimeWorkerLogic } from "../sdk/neck/runtime/neckRuntimeWorkerLogic.js"
import {
  createBrowserNeckRuntimeHost,
  createFakeNeckRuntimeWorker,
} from "../sdk/neck/runtime/browserNeckRuntimeHost.js"
import { createLuviaReferenceProfile } from "../sdk/neck/core/neckRuntimeProfile.js"
import { createMotorProtocolAdapter, getMotorProtocolAdapter } from "../sdk/neck/protocol/motorProtocolRegistry.js"
import { createBmHmdProtocolAdapter } from "../sdk/neck/protocol/bmHmdProtocolAdapter.js"
import { ID_DRIVE_CMD_1_4, ID_PARAM_WRITE, ID_STATE_CONTROL } from "../sdk/neck/protocol/bmHmdProtocol.js"
import { mapBrowserRuntimePhysicalDebugView } from "../sdk/neck/neckPhysicalDebug.js"
import { getDefaultNeckHardwareBackend } from "../sdk/neck/transport/neckHardwareBackend.js"
import { isBrowserMotorControlAvailable } from "../sdk/neck/transport/neckHardwareBackendUi.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "../..")

function readSrc(rel) {
  return readFileSync(join(root, rel), "utf8")
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function createLogicHarness(opts = {}) {
  /** @type {object[]} */
  const messages = []
  const logic = createNeckRuntimeWorkerLogic({
    postMessage: (m) => messages.push(m),
    delay: opts.delay || ((ms) => sleep(Math.min(ms, 5))),
    staleTimeoutMs: opts.staleTimeoutMs ?? 50,
    periodMs: opts.periodMs ?? 10,
    now: opts.now,
    createScheduler: opts.createScheduler,
    getAdapter: opts.getAdapter,
  })
  return {
    logic,
    messages,
    async dispose() {
      await logic.handleMessage({ type: "dispose" })
    },
  }
}

describe("R4 Browser Neck Runtime", () => {
  it("A: Worker startup (FakeWorker ready)", async () => {
    const msgs = []
    const fake = createFakeNeckRuntimeWorker({
      delay: (ms) => sleep(Math.min(ms, 1)),
    })
    fake.onmessage = (ev) => msgs.push(ev.data)
    fake.postMessage({ type: "init", profile: createLuviaReferenceProfile() })
    await sleep(20)
    assert.ok(msgs.some((m) => m.type === "ready"))
    fake.terminate()
  })

  it("B: Worker shutdown dispose", async () => {
    const { logic, messages } = createLogicHarness()
    await logic.handleMessage({ type: "init", profile: createLuviaReferenceProfile() })
    await logic.handleMessage({ type: "dispose" })
    assert.equal(logic.getState(), BROWSER_NECK_RUNTIME_STATES.DISCONNECTED)
    assert.ok(messages.some((m) => m.type === "state" && m.state === "DISCONNECTED"))
  })

  it("C: 100Hz nominal scheduler period", () => {
    assert.equal(NOMINAL_RUNTIME_PERIOD_MS, 10)
    let ticks = 0
    let clock = 0
    const timers = []
    const sched = createRuntimeScheduler({
      periodMs: 10,
      now: () => clock,
      setTimeoutFn: (fn, ms) => {
        const id = { fn, at: clock + ms }
        timers.push(id)
        return id
      },
      clearTimeoutFn: (id) => {
        const i = timers.indexOf(id)
        if (i >= 0) timers.splice(i, 1)
      },
      onTick: () => {
        ticks += 1
      },
    })
    sched.start(0)
    for (let i = 0; i < 5; i++) {
      clock += 10
      const due = timers.filter((t) => t.at <= clock)
      timers.length = 0
      for (const t of due) t.fn()
    }
    assert.ok(ticks >= 4)
    sched.stop()
  })

  it("D: missed tick no catch-up burst", () => {
    let ticks = 0
    let clock = 0
    /** @type {Array<{fn:Function,at:number}>} */
    const timers = []
    const sched = createRuntimeScheduler({
      periodMs: 10,
      now: () => clock,
      setTimeoutFn: (fn, ms) => {
        const id = { fn, at: clock + Number(ms) }
        timers.push(id)
        return id
      },
      clearTimeoutFn: (id) => {
        const i = timers.indexOf(id)
        if (i >= 0) timers.splice(i, 1)
      },
      onTick: () => {
        ticks += 1
      },
    })
    sched.start(0)
    // Jump 30ms — should fire once, not 3
    clock = 30
    const due = timers.splice(0, timers.length).filter((t) => t.at <= clock)
    for (const t of due) t.fn()
    assert.equal(ticks, 1)
    assert.ok(sched.getStats().missedTickCount >= 1)
    sched.stop()
  })

  it("E: latest target wins", async () => {
    const { logic } = createLogicHarness()
    await logic.handleMessage({ type: "init", profile: createLuviaReferenceProfile() })
    await logic.handleMessage({ type: "setTarget", pose: { pitch: 1, roll: 0, yaw: 0 }, sequence: 1 })
    await logic.handleMessage({ type: "setTarget", pose: { pitch: 2, roll: 0, yaw: 0 }, sequence: 2 })
    assert.equal(logic._test.getLatestTarget().pose.pitch, 2)
    assert.equal(logic._test.getLatestTarget().sequence, 2)
  })

  it("F: no target FIFO (overwrite only)", async () => {
    const { logic } = createLogicHarness()
    await logic.handleMessage({ type: "init", profile: createLuviaReferenceProfile() })
    for (let i = 0; i < 10; i++) {
      await logic.handleMessage({ type: "setTarget", pose: { pitch: i }, sequence: i })
    }
    assert.equal(logic._test.getLatestTarget().pose.pitch, 9)
  })

  it("G: timeline sequence preserved on latest", async () => {
    const { logic } = createLogicHarness()
    await logic.handleMessage({ type: "init", profile: createLuviaReferenceProfile() })
    await logic.handleMessage({
      type: "setTarget",
      pose: { pitch: 0, roll: 0, yaw: 1 },
      sequence: 42,
      timelineTimeMs: 1200,
      source: "timeline",
    })
    const t = logic._test.getLatestTarget()
    assert.equal(t.sequence, 42)
    assert.equal(t.timelineTimeMs, 1200)
    assert.equal(t.source, "timeline")
  })

  it("H: main heartbeat updates age", async () => {
    let clock = 1000
    const { logic } = createLogicHarness({ now: () => clock })
    await logic.handleMessage({ type: "init", profile: createLuviaReferenceProfile() })
    await logic.handleMessage({ type: "heartbeat" })
    clock = 1050
    const snap = logic.getSnapshot()
    assert.ok(snap.heartbeatAgeMs != null && snap.heartbeatAgeMs <= 50)
  })

  it("I/J: heartbeat timeout → STALE_SAFE_HOLD", async () => {
    let clock = 0
    let onTick = null
    const h2 = createLogicHarness({
      now: () => clock,
      staleTimeoutMs: 30,
      delay: async () => {},
      createScheduler: (opts) => {
        onTick = opts.onTick
        return {
          start() {},
          stop() {},
          isRunning: () => true,
          getStats: () => ({
            tickCount: 1,
            missedTickCount: 0,
            jitterMean: 0,
            jitterP95: 0,
            jitterMax: 0,
            tickHz: 100,
          }),
        }
      },
    })
    await h2.logic.handleMessage({ type: "init", profile: createLuviaReferenceProfile() })
    await h2.logic.handleMessage({ type: "enable" })
    await sleep(30)
    assert.ok(
      h2.logic.getState() === BROWSER_NECK_RUNTIME_STATES.ENABLED ||
        h2.logic.getState() === BROWSER_NECK_RUNTIME_STATES.HOLD ||
        h2.logic.getState() === BROWSER_NECK_RUNTIME_STATES.RUNNING
    )
    clock = 1000
    await h2.logic.handleMessage({ type: "heartbeat" })
    clock = 1040
    onTick?.({ dtMs: 10, expectedAt: clock, actualAt: clock, missed: false })
    assert.equal(h2.logic.getState(), BROWSER_NECK_RUNTIME_STATES.STALE_SAFE_HOLD)
    assert.ok(h2.messages.some((m) => m.type === "state" && m.state === "STALE_SAFE_HOLD"))
    await h2.dispose()
  })

  it("K: explicit resume from stale", async () => {
    let clock = 0
    let onTick = null
    const { logic, dispose } = createLogicHarness({
      now: () => clock,
      staleTimeoutMs: 20,
      delay: async () => {},
      createScheduler: (opts) => {
        onTick = opts.onTick
        return {
          start() {},
          stop() {},
          getStats: () => ({
            tickCount: 0,
            missedTickCount: 0,
            jitterMean: 0,
            jitterP95: 0,
            jitterMax: 0,
            tickHz: 0,
          }),
        }
      },
    })
    await logic.handleMessage({ type: "init", profile: createLuviaReferenceProfile() })
    await logic.handleMessage({ type: "enable" })
    await sleep(20)
    clock = 100
    await logic.handleMessage({ type: "heartbeat" })
    clock = 200
    onTick?.({ dtMs: 10, expectedAt: 200, actualAt: 200, missed: false })
    assert.equal(logic.getState(), BROWSER_NECK_RUNTIME_STATES.STALE_SAFE_HOLD)
    await logic.handleMessage({ type: "resume" })
    assert.equal(logic.getState(), BROWSER_NECK_RUNTIME_STATES.HOLD)
    await dispose()
  })

  it("L–P: Enable sequence exact frame kinds via adapter", async () => {
    const profile = createLuviaReferenceProfile()
    const adapter = createBmHmdProtocolAdapter(profile)
    const steps = buildEnableSequenceSteps({ adapter, profile, motorIds: [1, 2, 3] })
    assert.equal(steps[0].kind, "disable")
    assert.equal(steps[0].frames[0].arbitrationId, ID_STATE_CONTROL)
    const modeSteps = steps.filter((s) => s.kind === "mode")
    assert.equal(modeSteps.length, 3)
    for (const s of modeSteps) {
      assert.equal(s.frames[0].arbitrationId, ID_PARAM_WRITE)
    }
    const pre = steps.find((s) => s.kind === "prehold")
    assert.equal(pre.frames[0].arbitrationId, ID_DRIVE_CMD_1_4)
    const en = steps.find((s) => s.kind === "enable")
    assert.equal(en.frames[0].arbitrationId, ID_STATE_CONTROL)
    const post = steps.find((s) => s.kind === "posthold")
    assert.equal(post.frames[0].arbitrationId, ID_DRIVE_CMD_1_4)
    // M: disable-before-enable order
    assert.ok(steps.findIndex((s) => s.kind === "disable") < steps.findIndex((s) => s.kind === "enable"))
    // O/P zero hold + enable present
    assert.ok(pre && en && post)
  })

  it("Q: failed enable step → not ENABLED", async () => {
    const profile = createLuviaReferenceProfile()
    const adapter = createBmHmdProtocolAdapter(profile)
    const steps = buildEnableSequenceSteps({ adapter, profile })
    const runner = createEnableSequenceRunner({
      sendFrame: async (_f, meta) => {
        if (meta?.kind === "mode") throw new Error("boom")
      },
      delay: async () => {},
    })
    const result = await runner.run(steps)
    assert.equal(result.ok, false)
  })

  it("R: no auto enable on transport ready", async () => {
    const sent = []
    const host = createBrowserNeckRuntimeHost({
      getTransport: () => ({
        sendFrame: async (f) => sent.push(f),
        getState: () => ({ state: "READY", slcanReady: true }),
      }),
      createWorker: () =>
        createFakeNeckRuntimeWorker({
          delay: async () => {},
        }),
    })
    await host.loadProfile(createLuviaReferenceProfile())
    await sleep(30)
    host.notifyTransportReady()
    await sleep(20)
    assert.notEqual(host.getSnapshot().state, BROWSER_NECK_RUNTIME_STATES.ENABLED)
    assert.equal(host.getSnapshot().enabled, false)
    await host.dispose()
  })

  it("S/T: manual + timeline offerTarget when ENABLED", async () => {
    const frames = []
    const host = createBrowserNeckRuntimeHost({
      getTransport: () => ({
        sendFrame: async (f) => frames.push(f),
        getState: () => ({ state: "READY", slcanReady: true }),
      }),
      createWorker: () =>
        createFakeNeckRuntimeWorker({
          delay: async () => {},
        }),
    })
    await host.loadProfile(createLuviaReferenceProfile())
    await sleep(20)
    host.setHardwarePreview(true)
    await host.enableMotors()
    await sleep(80)
    assert.ok(host.getSnapshot().enabled)
    assert.equal(host.offerTarget({ pose: { pitch: 1, roll: 0, yaw: 0 }, source: "editor" }), true)
    assert.equal(
      host.offerTarget({ pose: { pitch: 0, roll: 1, yaw: 0 }, source: "timeline", sequence: 7 }),
      true
    )
    await host.dispose()
  })

  it("U/V/W/X: plan → motor raw → 0x32 via worker tick", async () => {
    const { logic, messages, dispose } = createLogicHarness({
      delay: async () => {},
      createScheduler: (opts) => ({
        start() {},
        stop() {},
        getStats: () => ({
          tickCount: 1,
          missedTickCount: 0,
          jitterMean: 0,
          jitterP95: 0,
          jitterMax: 0,
          tickHz: 100,
        }),
        _onTick: opts.onTick,
      }),
    })
    await logic.handleMessage({ type: "init", profile: createLuviaReferenceProfile() })
    await logic.handleMessage({ type: "enable" })
    await sleep(20)
    await logic.handleMessage({
      type: "setTarget",
      pose: { pitch: 1, roll: 0, yaw: 0 },
      source: "timeline",
    })
    logic._test.tickOnce()
    const tx = messages.filter((m) => m.type === "txFrame" && m.priority === COMMAND_PRIORITY.PERIODIC_POSITION)
    assert.ok(tx.length >= 1)
    assert.equal(tx[tx.length - 1].frame.arbitrationId, ID_DRIVE_CMD_1_4)
    const snap = logic.getSnapshot()
    assert.ok(snap.command.motorRaw)
    assert.ok(snap.safety)
    await dispose()
  })

  it("Y: periodic latest-wins in commandPriority", () => {
    const q = createCommandPriorityQueue()
    q.submit({ priority: COMMAND_PRIORITY.PERIODIC_POSITION, frame: { id: 1 } })
    q.submit({ priority: COMMAND_PRIORITY.PERIODIC_POSITION, frame: { id: 2 } })
    assert.equal(q.getStats().periodicPending, 1)
    assert.equal(q.takeNext().frame.id, 2)
    assert.equal(q.getStats().droppedPeriodic, 1)
  })

  it("Z: ESTOP priority > periodic", () => {
    const q = createCommandPriorityQueue()
    q.submit({ priority: COMMAND_PRIORITY.PERIODIC_POSITION, frame: { id: "p" } })
    q.submit({ priority: COMMAND_PRIORITY.ESTOP, frame: { id: "e" } })
    assert.equal(q.takeNext().frame.id, "e")
    assert.ok(commandPriorityRank(COMMAND_PRIORITY.ESTOP) > commandPriorityRank(COMMAND_PRIORITY.PERIODIC_POSITION))
  })

  it("AA: DISABLE priority over periodic", () => {
    const q = createCommandPriorityQueue()
    q.submit({ priority: COMMAND_PRIORITY.PERIODIC_POSITION, frame: { id: "p" } })
    q.submit({ priority: COMMAND_PRIORITY.DISABLE_CONTROL, frame: { id: "d" } })
    assert.equal(q.takeNext().frame.id, "d")
  })

  it("AB: periodic cannot starve control", () => {
    const q = createCommandPriorityQueue()
    for (let i = 0; i < 20; i++) {
      q.submit({ priority: COMMAND_PRIORITY.PERIODIC_POSITION, frame: { id: `p${i}` } })
    }
    q.submit({ priority: COMMAND_PRIORITY.ENABLE_STEP, frame: { id: "en" } })
    assert.equal(q.takeNext().frame.id, "en")
  })

  it("AC: transport backpressure bounded (one periodic)", async () => {
    let resolveSend
    const gate = new Promise((r) => {
      resolveSend = r
    })
    let inFlight = 0
    const host = createBrowserNeckRuntimeHost({
      getTransport: () => ({
        sendFrame: async () => {
          inFlight += 1
          await gate
        },
        getState: () => ({ state: "READY", slcanReady: true }),
      }),
      createWorker: () =>
        createFakeNeckRuntimeWorker({
          delay: async () => {},
        }),
    })
    await host.loadProfile(createLuviaReferenceProfile())
    await sleep(20)
    // inject many periodics via worker messages path
    const w = host._getWorker()
    for (let i = 0; i < 10; i++) {
      w.onmessage?.({
        data: {
          type: "txFrame",
          priority: COMMAND_PRIORITY.PERIODIC_POSITION,
          frame: { arbitrationId: 0x32, data: new Uint8Array(8), n: i },
        },
      })
    }
    await sleep(10)
    assert.ok(host._txQueue.getStats().periodicPending <= 1)
    resolveSend()
    await sleep(20)
    await host.dispose()
  })

  it("AD: serial disconnect → ERROR clears enabled", async () => {
    const host = createBrowserNeckRuntimeHost({
      getTransport: () => ({
        sendFrame: async () => {},
        getState: () => ({ state: "READY", slcanReady: true }),
      }),
      createWorker: () =>
        createFakeNeckRuntimeWorker({
          delay: async () => {},
        }),
    })
    await host.loadProfile(createLuviaReferenceProfile())
    await sleep(20)
    await host.enableMotors()
    await sleep(60)
    host.notifyTransportLost()
    await sleep(20)
    assert.equal(host.getSnapshot().state, BROWSER_NECK_RUNTIME_STATES.ERROR)
    await host.dispose()
  })

  it("AE/AF: no silent reconnect / re-enable", async () => {
    let ready = false
    const host = createBrowserNeckRuntimeHost({
      getTransport: () => ({
        sendFrame: async () => {},
        getState: () =>
          ready
            ? { state: "READY", slcanReady: true }
            : { state: "CLOSED", slcanReady: false },
      }),
      createWorker: () =>
        createFakeNeckRuntimeWorker({
          delay: async () => {},
        }),
    })
    await host.loadProfile(createLuviaReferenceProfile())
    await sleep(20)
    host.notifyTransportLost()
    ready = true
    host.notifyTransportReady()
    await sleep(20)
    assert.equal(host.getSnapshot().enabled, false)
    assert.notEqual(host.getSnapshot().state, BROWSER_NECK_RUNTIME_STATES.ENABLED)
    await host.dispose()
  })

  it("AG/AH: CanFrame decode / feedback state", async () => {
    const { logic } = createLogicHarness({ delay: async () => {} })
    await logic.handleMessage({ type: "init", profile: createLuviaReferenceProfile() })
    await logic.handleMessage({
      type: "feedback",
      feedback: { motorId: 1, position: 1.5, enabled: true },
    })
    const snap = logic.getSnapshot()
    assert.equal(snap.feedback.available, true)
    assert.ok(snap.feedback.motors[1])
  })

  it("AI/AJ: unavailable feedback semantics", async () => {
    const { logic } = createLogicHarness({ delay: async () => {} })
    await logic.handleMessage({ type: "init", profile: createLuviaReferenceProfile() })
    const snap = logic.getSnapshot()
    assert.equal(snap.feedback.available, false)
    assert.equal(snap.actualPoseAvailable ?? false, false)
  })

  it("AK: worker entry does not import BM_HMD / slcan / webSerial", () => {
    const workerEntry = readSrc("src/sdk/neck/runtime/neckRuntime.worker.js")
    assert.doesNotMatch(workerEntry, /bmHmdProtocol\.js/)
    assert.doesNotMatch(workerEntry, /slcanCodec/)
    assert.doesNotMatch(workerEntry, /webSerial/)
    const logic = readSrc("src/sdk/neck/runtime/neckRuntimeWorkerLogic.js")
    assert.doesNotMatch(logic, /slcanCodec/)
    assert.doesNotMatch(logic, /webSerialSlcan/)
    assert.doesNotMatch(logic, /from ["'].*bmHmdProtocol\.js["']/)
  })

  it("AL: Runtime does not import SLCAN directly", () => {
    const files = [
      "src/sdk/neck/runtime/neckRuntimeWorkerLogic.js",
      "src/sdk/neck/runtime/enableSequence.js",
      "src/sdk/neck/runtime/browserNeckRuntimeHost.js",
    ]
    for (const f of files) {
      const src = readSrc(f)
      assert.doesNotMatch(src, /encodeSlcanAscii|decodeSlcanAscii/)
    }
  })

  it("AM: CanTransport boundary — host calls sendFrame only", () => {
    const host = readSrc("src/sdk/neck/runtime/browserNeckRuntimeHost.js")
    assert.match(host, /sendFrame/)
    assert.doesNotMatch(host, /encodeSlcanAscii/)
  })

  it("AN: protocol registry getMotorProtocolAdapter works", () => {
    const a = getMotorProtocolAdapter(createLuviaReferenceProfile())
    assert.equal(a.type, "bm-hmd")
    const b = createMotorProtocolAdapter(createLuviaReferenceProfile())
    assert.equal(b.type, a.type)
  })

  it("AO: fake classic adapter still works", () => {
    const fakeProfile = {
      ...createLuviaReferenceProfile(),
      motorProtocol: { type: "fake-classic-can", version: "fake-classic-can-v1" },
      transport: {
        type: "slcan",
        can: { mode: "classic", arbitrationBitrate: 1_000_000, dataBitrate: null, brs: false },
      },
    }
    const adapter = getMotorProtocolAdapter(fakeProfile)
    assert.equal(adapter.type, "fake-classic-can")
    const steps = buildEnableSequenceSteps({ adapter, profile: fakeProfile })
    assert.ok(steps.length >= 5)
    const zero = resolveUserZeroMotorCommand(fakeProfile)
    const frame = adapter.encodePositionCommand(zero)
    assert.ok(frame.arbitrationId)
  })

  it("states normalize + transition helper", () => {
    assert.equal(normalizeBrowserNeckRuntimeState("running"), "RUNNING")
    assert.equal(
      isBrowserNeckRuntimeTransitionAllowed("DISABLED", "ENABLING"),
      true
    )
  })

  it("Physical Debug maps R4 snapshot fields", () => {
    const view = mapBrowserRuntimePhysicalDebugView({
      state: "RUNNING",
      enabled: true,
      estop: false,
      stale: false,
      worker: { running: true, tickHz: 99.5, tickCount: 100, jitterMean: 0.4, jitterP95: 1.2, missedTickCount: 2 },
      safety: { limited: false, reason: "" },
      command: { physicalTxCount: 50, lastWriteOk: true },
      profile: { loaded: true, name: "luvia-reference", version: "facedev-neck-runtime-profile-v1" },
    })
    assert.equal(view.runtimeState, "RUNNING")
    assert.equal(view.enabled, "true")
    assert.equal(view.tickCount, "100")
    assert.equal(view.profileName, "luvia-reference")
  })

  it("R1–R3 still importable + default backend luvia", async () => {
    assert.equal(getDefaultNeckHardwareBackend(), "luvia-bridge")
    assert.equal(isBrowserMotorControlAvailable(true), true)
    await import("../sdk/neck/core/planNeckPose.js")
    await import("../sdk/neck/protocol/bmHmdProtocolAdapter.js")
    await import("../sdk/neck/transport/webSerialSlcanTransport.js")
    await import("../sdk/neck/neckBridgeClient.js")
  })

  it("UI wiring: panel has Enable Motors / Load Profile / Runtime state", () => {
    const panel = readSrc("src/sdk/react/NeckBridgePanel.jsx")
    assert.match(panel, /Enable Motors/)
    assert.match(panel, /Load Profile/)
    assert.match(panel, /Disable Motors/)
    assert.match(panel, /browserRuntimeSnapshot/)
    assert.doesNotMatch(panel, /NOT AVAILABLE \[R3\]/)
    const editor = readSrc("src/sdk/react/FaceExpressionEditor.jsx")
    assert.match(editor, /createBrowserNeckRuntimeHost/)
    assert.match(editor, /getSharedBrowserSlcanTransport|createConnectNeckService/)
    assert.match(editor, /offerTarget/)
    const eng = readSrc("src/sdk/react/NeckEngineeringPanel.jsx")
    assert.match(eng, /NeckBridgePanel/)
    assert.match(eng, /onEnableBrowserMotors|onLoadBrowserProfile/)
  })
})
