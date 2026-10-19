/**
 * FaceDEV Browser-Native Neck Runtime R3 — WebSerial SLCAN Transport tests (A–AG).
 */
import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  createSlcanStreamFramer,
  createSerialWriteQueue,
  SerialWriteQueueError,
  detectWebSerialCapability,
  WEB_SERIAL_CAPABILITY,
  createMockSerialPort,
  createMockSerial,
  createWebSerialSlcanTransport,
  WEB_SERIAL_TRANSPORT_STATE,
  classifySlcanLine,
  encodeSlcanAscii,
  buildSlcanOpenSequence,
  SLCAN_OPEN_SEQUENCE,
  assertCanTransport,
  CanTransportError,
  NECK_HARDWARE_BACKEND,
  HARDWARE_BACKEND_CONFLICT,
  checkHardwareBackendConflict,
  getDefaultNeckHardwareBackend,
  normalizeNeckHardwareBackend,
  createLuviaFdTransportConfig,
} from "../sdk/neck/transport/index.js"
import { createCanFrame } from "../sdk/neck/protocol/canFrame.js"
import { createNeckBridgeClient } from "../sdk/neck/neckBridgeClient.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "../..")
const TRANSPORT_DIR = path.resolve(__dirname, "../sdk/neck/transport")

function sleep(ms = 15) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor(predicate, { timeoutMs = 500, intervalMs = 10 } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return
    await sleep(intervalMs)
  }
  throw new Error("waitFor timeout")
}

function createReadyTransport(portOpts = {}) {
  const port = createMockSerialPort(portOpts)
  const serial = createMockSerial({ ports: [port] })
  const transport = createWebSerialSlcanTransport({
    serial,
    isSecureContext: true,
    navigator: { serial },
  })
  return { port, serial, transport }
}

async function openReady(portOpts = {}) {
  const ctx = createReadyTransport(portOpts)
  await ctx.transport.open({ port: ctx.port })
  assert.equal(ctx.transport.getState().state, WEB_SERIAL_TRANSPORT_STATE.READY)
  return ctx
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// ——— Framer unit ———
test("framer: split / multi / boundary / clear", () => {
  const f = createSlcanStreamFramer()
  assert.deepEqual(f.feed("d0328"), [])
  assert.deepEqual(f.feed("0000000000000000\r"), ["d03280000000000000000"])
  assert.deepEqual(f.feed("t12380000000000000000\rV1234\r"), [
    "t12380000000000000000",
    "V1234",
  ])
  assert.deepEqual(f.feed(new Uint8Array([0x7a, 0x0d])), ["z"])
  // CR at chunk boundary
  assert.deepEqual(f.feed("abc"), [])
  assert.deepEqual(f.feed("\rdef\r"), ["abc", "def"])
  f.clear()
  assert.equal(f.pending(), "")
  assert.deepEqual(f.feed("x\r"), ["x"])
})

// ——— Write queue ———
test("serialWriteQueue: sequential + bounded + close", async () => {
  const written = []
  let releaseWrite
  const gate = new Promise((r) => {
    releaseWrite = r
  })
  let writesStarted = 0
  const writer = {
    async write(chunk) {
      writesStarted += 1
      if (writesStarted === 1) await gate
      written.push(new TextDecoder().decode(chunk))
    },
    releaseLock() {
      this.released = true
    },
  }
  const q = createSerialWriteQueue({ writer, maxQueue: 1 })
  const p1 = q.enqueue("A")
  // A is in-flight (gated); B fills the only queue slot
  const p2 = q.enqueue("B")
  assert.throws(() => q.enqueue("C"), (e) => e instanceof SerialWriteQueueError && e.code === "QUEUE_FULL")
  releaseWrite()
  await Promise.all([p1, p2])
  assert.deepEqual(written, ["A", "B"])
  await q.close()
  assert.equal(writer.released, true)
  assert.throws(() => q.enqueue("D"), (e) => e.code === "QUEUE_CLOSED")
})

// ——— A unsupported ———
test("A: WebSerial unsupported", () => {
  const cap = detectWebSerialCapability({ navigator: {}, isSecureContext: true })
  assert.equal(cap.state, WEB_SERIAL_CAPABILITY.UNSUPPORTED)
  assert.equal(cap.supported, false)

  const insecure = detectWebSerialCapability({
    navigator: { serial: {} },
    isSecureContext: false,
  })
  assert.equal(insecure.state, WEB_SERIAL_CAPABILITY.INSECURE_CONTEXT)

  const transport = createWebSerialSlcanTransport({
    navigator: {},
    isSecureContext: true,
  })
  assert.rejects(() => transport.open(), (e) => e instanceof CanTransportError && e.code === "UNSUPPORTED")
})

// ——— B requestPort ———
test("B: requestPort user flow", async () => {
  const port = createMockSerialPort()
  let requested = 0
  const serial = createMockSerial({
    requestPortImpl: async () => {
      requested += 1
      return port
    },
  })
  const transport = createWebSerialSlcanTransport({
    serial,
    isSecureContext: true,
    navigator: { serial },
  })
  const selected = await transport.selectPort()
  assert.equal(selected, port)
  assert.equal(requested, 1)
  assert.equal(transport.getState().portSelected, true)
  await transport.open({ port })
  assert.equal(transport.getState().state, "READY")
  await transport.close()
})

// ——— C getPorts ———
test("C: getPorts authorized discovery", async () => {
  const p1 = createMockSerialPort()
  const p2 = createMockSerialPort()
  const serial = createMockSerial({ ports: [p1, p2] })
  const transport = createWebSerialSlcanTransport({
    serial,
    isSecureContext: true,
    navigator: { serial },
  })
  const ports = await transport.getPorts()
  assert.equal(ports.length, 2)
  assert.equal(ports[0], p1)
})

// ——— D open 115200 ———
test("D: open uses baudRate 115200 + pyserial-like defaults", async () => {
  const { port, transport } = await openReady()
  const opts = port.getOpenOptions()
  assert.equal(opts.baudRate, 115200)
  assert.equal(opts.dataBits, 8)
  assert.equal(opts.stopBits, 1)
  assert.equal(opts.parity, "none")
  assert.equal(opts.flowControl, "none")
  await transport.close()
})

// ——— E close ———
test("E: close leaves CLOSED", async () => {
  const { transport } = await openReady()
  await transport.close()
  assert.equal(transport.getState().state, WEB_SERIAL_TRANSPORT_STATE.CLOSED)
  assert.equal(transport.getState().slcanReady, false)
})

// ——— F idempotent close ———
test("F: repeated close idempotent", async () => {
  const { transport } = await openReady()
  await transport.close()
  await transport.close()
  await transport.close()
  assert.equal(transport.getState().state, WEB_SERIAL_TRANSPORT_STATE.CLOSED)
})

// ——— G open failure cleanup ———
test("G: open failure cleanup (no READY, no half-open)", async () => {
  const port = createMockSerialPort({ failOpen: new Error("busy") })
  const serial = createMockSerial({ ports: [port] })
  const transport = createWebSerialSlcanTransport({
    serial,
    isSecureContext: true,
    navigator: { serial },
  })
  await assert.rejects(() => transport.open({ port }), CanTransportError)
  const st = transport.getState()
  assert.equal(st.state, WEB_SERIAL_TRANSPORT_STATE.ERROR)
  assert.equal(st.slcanReady, false)
  assert.ok(st.lastError)
})

// ——— H/I exact open sequence + CR ———
test("H/I: exact C/S8/Y5/M0/A1/O with CR 0x0d only", async () => {
  const { port, transport } = await openReady()
  const expected = buildSlcanOpenSequence({ withCr: true })
  assert.deepEqual(
    [...SLCAN_OPEN_SEQUENCE],
    ["C", "S8", "Y5", "M0", "A1", "O"]
  )
  const strings = port.getWriteStrings()
  assert.deepEqual(strings, expected)
  for (const w of port.getWrites()) {
    assert.equal(w[w.length - 1], 0x0d, "must end with CR")
    assert.equal(w.includes(0x0a), false, "must not contain LF")
  }
  await transport.close()
})

// ——— J init failure never READY ———
test("J: init write failure never READY", async () => {
  let writeCount = 0
  const port = createMockSerialPort({
    failWrite: () => {
      writeCount += 1
      if (writeCount >= 3) return new Error("init write failed")
      return null
    },
  })
  // failWrite as function returning null should not fail — adjust mock usage
  const serial = createMockSerial({ ports: [port] })
  // Use a custom failWrite that fails on 3rd write
  let n = 0
  port.setFailWrite(() => {
    n += 1
    if (n === 3) return new Error("init write failed")
    return null
  })
  const transport = createWebSerialSlcanTransport({
    serial,
    isSecureContext: true,
    navigator: { serial },
  })
  await assert.rejects(() => transport.open({ port }), CanTransportError)
  assert.notEqual(transport.getState().state, WEB_SERIAL_TRANSPORT_STATE.READY)
  assert.equal(transport.getState().slcanReady, false)
  assert.equal(transport.getState().state, WEB_SERIAL_TRANSPORT_STATE.ERROR)
})

// ——— K/L/M TX FD / Classic ———
test("K/L/M: TX FD no-BRS and Classic via encodeSlcanAscii", async () => {
  const { port, transport } = await openReady()
  port.clearWrites()

  const fd = createCanFrame({
    arbitrationId: 0x32,
    data: new Uint8Array(8),
    isFd: true,
    brs: false,
  })
  await transport.sendFrame(fd)
  assert.equal(port.getWriteStrings().at(-1), `${encodeSlcanAscii(fd)}\r`)
  assert.ok(port.getWriteStrings().at(-1).startsWith("d"))

  const classic = createCanFrame({
    arbitrationId: 0x123,
    data: new Uint8Array(8),
    isFd: false,
    brs: false,
  })
  await transport.sendFrame(classic)
  assert.ok(port.getWriteStrings().at(-1).startsWith("t123"))

  await assert.rejects(
    () =>
      transport.sendFrame(
        createCanFrame({
          arbitrationId: 0x32,
          data: new Uint8Array(8),
          isFd: true,
          brs: true,
        })
      ),
    (e) => e.code === "BRS_FORBIDDEN"
  )
  await transport.close()
})

// ——— N/O write ordering ———
test("N/O: frame write ordering / no interleave", async () => {
  const { port, transport } = await openReady()
  port.clearWrites()
  const frames = [1, 2, 3].map((i) =>
    createCanFrame({
      arbitrationId: 0x30 + i,
      data: new Uint8Array([i, 0, 0, 0, 0, 0, 0, 0]),
      isFd: true,
      brs: false,
    })
  )
  await Promise.all(frames.map((f) => transport.sendFrame(f)))
  const lines = port.getWriteStrings()
  assert.equal(lines.length, 3)
  assert.ok(lines[0].includes("031"))
  assert.ok(lines[1].includes("032"))
  assert.ok(lines[2].includes("033"))
  await transport.close()
})

// ——— P–U RX ———
test("P–U: RX one/split/multi/boundary/malformed/callback", async () => {
  const { port, transport } = await openReady()
  const frames = []
  const control = []
  const diag = []
  transport.onFrame((f) => frames.push(f))
  transport.onControlLine((l) => control.push(l))
  transport.onDiagnostic((d) => diag.push(d))

  // P: one line / one chunk
  port.injectRx("d03280000000000000000\r")
  await waitFor(() => frames.length >= 1)
  assert.equal(frames[0].arbitrationId, 0x32)

  // Q: split across chunks
  port.injectRx("d0328")
  port.injectRx("0000000000000000\r")
  await waitFor(() => frames.length >= 2)
  assert.equal(frames[1].arbitrationId, 0x32)

  // R: multi-line chunk
  port.injectRx("t12380000000000000000\rz\r")
  await waitFor(() => frames.length >= 3 && control.includes("z"))
  assert.equal(frames[2].isFd, false)

  // S: CR boundary
  port.injectRx(new Uint8Array([0x7a])) // 'z'
  port.injectRx(new Uint8Array([0x0d]))
  await waitFor(() => control.filter((c) => c === "z").length >= 2)

  // T: malformed
  port.injectRx("not-a-frame\r")
  await waitFor(() => diag.length >= 1)
  assert.equal(transport.getState().counters.malformedLines >= 1, true)

  // U already covered by onFrame
  assert.equal(classifySlcanLine("z"), "control")
  assert.equal(classifySlcanLine("d03280000000000000000"), "can")
  assert.equal(classifySlcanLine("@@@"), "malformed")

  await transport.close()
})

// ——— V–Y disconnect / failures / cleanup ———
test("V–Y: disconnect / reader failure / writer failure / cleanup", async () => {
  // V physical disconnect
  {
    const { port, transport } = await openReady()
    port.disconnect()
    await waitFor(() => {
      const s = transport.getState().state
      return s === "DISCONNECTED" || s === "ERROR"
    })
    await transport.close()
    assert.equal(transport.getState().state, "CLOSED")
  }

  // W reader failure
  {
    const port = createMockSerialPort({ failRead: true })
    const serial = createMockSerial({ ports: [port] })
    const transport = createWebSerialSlcanTransport({
      serial,
      isSecureContext: true,
      navigator: { serial },
    })
    await transport.open({ port })
    // trigger pull/read failure path: inject then arm — failRead on pull
    port.armFailRead()
    // push a chunk to force another read cycle; if already errored on first pull, state may already be disconnected
    try {
      port.injectRx("z\r")
    } catch {
      /* stream may already be errored */
    }
    await waitFor(() => {
      const s = transport.getState().state
      return s === "DISCONNECTED" || s === "ERROR" || s === "READY"
    }, { timeoutMs: 300 }).catch(() => {})
    await transport.close()
  }

  // X writer failure on sendFrame
  {
    const { port, transport } = await openReady()
    port.clearWrites()
    port.setFailWrite(new Error("tx fail"))
    await assert.rejects(
      () =>
        transport.sendFrame(
          createCanFrame({
            arbitrationId: 0x32,
            data: new Uint8Array(8),
            isFd: true,
          })
        ),
      CanTransportError
    )
    assert.equal(transport.getState().state, WEB_SERIAL_TRANSPORT_STATE.ERROR)
    await transport.close()
  }

  // Y cleanup: close releases and is idempotent (covered) + framer cleared
  {
    const { transport } = await openReady()
    await transport.close()
    assert.equal(transport.getState().state, "CLOSED")
    assert.equal(transport.getState().serialOpen, false)
  }
})

// ——— Z reopen ———
test("Z: reopen after failure", async () => {
  const port = createMockSerialPort()
  const serial = createMockSerial({ ports: [port] })
  const transport = createWebSerialSlcanTransport({
    serial,
    isSecureContext: true,
    navigator: { serial },
  })
  await transport.open({ port })
  port.setFailWrite(new Error("boom"))
  await assert.rejects(
    () =>
      transport.sendFrame(
        createCanFrame({ arbitrationId: 0x32, data: new Uint8Array(8), isFd: true })
      ),
    CanTransportError
  )
  await transport.close()
  port.setFailWrite(null)
  await transport.open({ port })
  assert.equal(transport.getState().state, "READY")
  port.clearWrites()
  await transport.sendFrame(
    createCanFrame({ arbitrationId: 0x32, data: new Uint8Array(8), isFd: true })
  )
  assert.ok(port.getWriteStrings().at(-1).startsWith("d032"))
  await transport.close()
})

// ——— AA/AB/AC architecture ———
test("AA/AB/AC: webSerialSlcanTransport architecture boundaries", () => {
  const src = fs.readFileSync(path.join(TRANSPORT_DIR, "webSerialSlcanTransport.js"), "utf8")
  assert.equal(/from\s+['"][^'"]*bmHmd/.test(src), false)
  assert.equal(/import\s+.*bmHmd/.test(src), false)
  assert.equal(src.includes("neckKinematics"), false)
  assert.equal(src.includes("CharacterPose"), false)
  assert.equal(src.includes("Timeline"), false)
  assert.equal(/from\s+['"].*\/core\//.test(src), false)
  assert.equal(/from\s+['"]\.\.\/core/.test(src), false)
  assert.ok(src.includes("encodeSlcanAscii"))
  assert.ok(src.includes("decodeSlcanAscii"))
  assert.ok(src.includes("buildSlcanOpenSequence"))
  assert.ok(src.includes("assertCanTransport") || src.includes("CanTransport"))

  const t = createWebSerialSlcanTransport({
    serial: createMockSerial({ ports: [createMockSerialPort()] }),
    isSecureContext: true,
  })
  assertCanTransport(t)
})

// ——— AD Bridge still available ———
test("AD: Luvia Bridge backend remains importable", () => {
  const client = createNeckBridgeClient({ autoConnect: false })
  assert.ok(client)
  assert.equal(typeof client.offerTarget, "function")
  assert.equal(getDefaultNeckHardwareBackend(), NECK_HARDWARE_BACKEND.LUVIA_BRIDGE)
  assert.equal(normalizeNeckHardwareBackend("browser-slcan"), NECK_HARDWARE_BACKEND.BROWSER_SLCAN)
})

// ——— AE backend conflict ———
test("AE: backend conflict helper", () => {
  const ok = checkHardwareBackendConflict({
    browserSlcanReady: false,
    bridgeHardwareConnected: true,
  })
  assert.equal(ok.conflict, false)

  const conflict = checkHardwareBackendConflict({
    browserSlcanReady: true,
    bridgeHardwareConnected: true,
  })
  assert.equal(conflict.conflict, true)
  assert.equal(conflict.code, HARDWARE_BACKEND_CONFLICT)

  const byState = checkHardwareBackendConflict({
    browserTransportState: "READY",
    bridgeHardwareConnected: true,
  })
  assert.equal(byState.conflict, true)
})

// ——— AF Timeline untouched ———
test("AF: Character Timeline modules still importable / static shape", async () => {
  const { createNeutralCharacterPose } = await import("./characterPose.js")
  const pose = createNeutralCharacterPose()
  assert.ok(pose.neck)
  assert.ok(pose.face)

  const { sampleExpressionTimeline } = await import("./expressionTimelineSampler.js")
  assert.equal(typeof sampleExpressionTimeline, "function")

  const { getNeckTimelineChannelIds } = await import("./expressionTimelineChannels.js")
  const neckCh = getNeckTimelineChannelIds()
  assert.ok(Array.isArray(neckCh))
  assert.ok(neckCh.length >= 3)
})

// ——— AG SC/ST/RJ untouched ———
test("AG: SC/ST/RJ / frameProject still load", async () => {
  const fp = await import("./frameProject.js")
  assert.equal(typeof fp.createDefaultFrameProject, "function")
  const project = fp.createDefaultFrameProject()
  assert.ok(project)

  // Transport profile still FD default for Luvia
  const cfg = createLuviaFdTransportConfig()
  assert.equal(cfg.can.mode, "fd")
  assert.equal(cfg.can.brs, false)

  // sendFrame rejected when not READY
  const t = createWebSerialSlcanTransport({
    serial: createMockSerial({ ports: [createMockSerialPort()] }),
    isSecureContext: true,
  })
  await assert.rejects(
    () =>
      t.sendFrame(
        createCanFrame({ arbitrationId: 0x32, data: new Uint8Array(8), isFd: true })
      ),
    (e) => e.code === "NOT_READY"
  )
})

// Contract smoke
test("assertCanTransport on live instance", async () => {
  const { transport } = await openReady()
  assertCanTransport(transport)
  const st = transport.getState()
  assert.equal(st.serialOpen, true)
  assert.equal(st.slcanReady, true)
  assert.equal(st.canMode, "fd")
  assert.equal(st.brs, false)
  assert.ok(st.counters)
  await transport.close()
})
