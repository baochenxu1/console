/**
 * FaceDEV Browser-Native Neck Runtime R2.1 — Protocol / Transport Decoupling tests (A–Z practical).
 */
import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  assertMotorProtocolAdapter,
  createMotorFeedback,
  validateProtocolTransportCompatibility,
  MotorProtocolError,
  createMotorCommand,
  createMotorCommandFromMotorTargets,
  MotorCommandError,
  createMotorProtocolAdapter,
  createBmHmdProtocolAdapter,
  createFakeMotorProtocolAdapter,
  FAKE_POSITION_ARB_ID,
  createProductionBmHmdProtocol,
  MotorCmd,
  dataToHex,
  encodeSlcanAscii,
  decodeSlcanAscii,
  planNeckTransportCommand,
  createCanFrame,
  decodeDriveFeedback,
} from "../sdk/neck/protocol/index.js"
import {
  createMockCanTransport,
  assertCanTransport,
  createClassicTransportConfig,
  createLuviaFdTransportConfig,
  createTransportCodec,
} from "../sdk/neck/transport/index.js"
import {
  createLuviaReferenceProfile,
  normalizeNeckRuntimeProfile,
  planNeckPose,
  createNeckPlannerState,
} from "../sdk/neck/core/index.js"
import { createNeckBridgeClient } from "../sdk/neck/neckBridgeClient.js"
import { createNeckBrowserShadow } from "../sdk/neck/neckBrowserShadow.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "../..")
const FIXTURE = path.resolve(ROOT, "tests/fixtures/neck-luvia-protocol-golden-v1.json")
const CORE_DIR = path.resolve(__dirname, "../sdk/neck/core")
const TRANSPORT_DIR = path.resolve(__dirname, "../sdk/neck/transport")
const PROTOCOL_DIR = path.resolve(__dirname, "../sdk/neck/protocol")

function loadFixture() {
  assert.ok(fs.existsSync(FIXTURE), "golden fixture required")
  return JSON.parse(fs.readFileSync(FIXTURE, "utf8"))
}

function hexCompact(spaced) {
  return String(spaced).replace(/\s+/g, "").toUpperCase()
}

function readJsSources(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => ({
      file: f,
      src: fs.readFileSync(path.join(dir, f), "utf8"),
    }))
}

// ——— A MotorProtocol contract ———
test("A: MotorProtocol contract helpers", () => {
  const adapter = createBmHmdProtocolAdapter(createLuviaReferenceProfile())
  assertMotorProtocolAdapter(adapter)
  assert.equal(adapter.type, "bm-hmd")
  assert.ok(adapter.capabilities.modes.includes("POSITION"))
  assert.throws(() => assertMotorProtocolAdapter({}), MotorProtocolError)
  assert.throws(
    () => assertMotorProtocolAdapter({ type: "x", version: "1", capabilities: {} }),
    MotorProtocolError
  )
})

// ——— B BM_HMD implements contract ———
test("B: BM_HMD adapter implements contract + byte-exact 0x32", () => {
  const adapter = createBmHmdProtocolAdapter(createLuviaReferenceProfile())
  assert.equal(adapter.capabilities.requiresCanFd, true)
  assert.equal(adapter.capabilities.requiresBrs, false)
  assert.equal(adapter.capabilities.maxMotorsPerFrame, 4)
  assert.equal(adapter.capabilities.supportsFeedback, true)

  const cmd = createMotorCommand({
    mode: "POSITION",
    motors: [
      { logicalMotorId: 1, positionRaw: 100 },
      { logicalMotorId: 2, positionRaw: -100 },
      { logicalMotorId: 3, positionRaw: 50 },
      { logicalMotorId: 4, positionRaw: 0 },
    ],
  })
  const frame = adapter.encodePositionCommand(cmd)
  assert.equal(frame.arbitrationId, 0x32)
  assert.equal(frame.isFd, true)
  assert.equal(frame.brs, false)
  assert.equal(dataToHex(frame.data), "0064FF9C00320000")
  assert.equal(encodeSlcanAscii(frame), "d03280064FF9C00320000")

  const mode = adapter.encodeControlModeCommand(1, "POSITION")
  assert.equal(mode.arbitrationId, 0x36)
  assert.equal(dataToHex(mode.data), "011D050000000000")

  const en = adapter.encodeEnableCommand([1, 2, 3])
  assert.equal(en.arbitrationId, 0x38)
  assert.equal(dataToHex(en.data), "0202020000000000")
})

// ——— C Registry bm-hmd ———
test("C: registry returns bm-hmd adapter", () => {
  const profile = createLuviaReferenceProfile()
  const adapter = createMotorProtocolAdapter(profile)
  assert.equal(adapter.type, "bm-hmd")
  assert.equal(profile.motorProtocol.type, "bm-hmd")
  assert.equal(profile.transport.can.mode, "fd")
})

// ——— D Unknown protocol reject ———
test("D: unknown protocol → UNSUPPORTED_MOTOR_PROTOCOL (no BM_HMD fallback)", () => {
  assert.throws(
    () =>
      createMotorProtocolAdapter({
        motorProtocol: { type: "unknown-x", version: "1" },
        transport: createLuviaFdTransportConfig(),
      }),
    (err) => err instanceof MotorProtocolError && err.code === "UNSUPPORTED_MOTOR_PROTOCOL"
  )
})

// ——— E Fake adapter ———
test("E: FakeMotorProtocolAdapter classic frame 0x123", () => {
  const profile = createLuviaReferenceProfile({
    motorProtocol: { type: "fake-classic-can", version: "fake-classic-can-v1" },
    transport: createClassicTransportConfig(),
  })
  const adapter = createFakeMotorProtocolAdapter(profile)
  assert.equal(adapter.capabilities.requiresCanFd, false)
  const cmd = createMotorCommand({
    mode: "POSITION",
    motors: [
      { logicalMotorId: 1, positionRaw: 10 },
      { logicalMotorId: 2, positionRaw: 20 },
      { logicalMotorId: 3, positionRaw: 30 },
      { logicalMotorId: 4, positionRaw: 40 },
    ],
  })
  const frame = adapter.encodePositionCommand(cmd)
  assert.equal(frame.arbitrationId, FAKE_POSITION_ARB_ID)
  assert.equal(frame.isFd, false)
  assert.equal(frame.data.length, 8)
  assert.equal(dataToHex(frame.data), "000A0014001E0028")
})

// ——— F Same NeckPose: BM_HMD vs Fake — R1 joints identical ———
test("F: same NeckPose — R1 joints identical across adapters", () => {
  const pose = { pitch: 4, roll: -2, yaw: 8 }
  const prev = createNeckPlannerState({ safetyInitialized: true })
  const bmProfile = createLuviaReferenceProfile()
  const fakeProfile = createLuviaReferenceProfile({
    motorProtocol: { type: "fake-classic-can", version: "fake-classic-can-v1" },
    transport: createClassicTransportConfig(),
  })

  const p1 = planNeckPose({
    pose,
    profile: bmProfile,
    previousState: prev,
    applySafetyLimiter: false,
  })
  const p2 = planNeckPose({
    pose,
    profile: fakeProfile,
    previousState: createNeckPlannerState({ safetyInitialized: true }),
    applySafetyLimiter: false,
  })
  assert.equal(p1.accepted, true)
  assert.equal(p2.accepted, true)
  assert.deepEqual(p1.joints, p2.joints)
  assert.deepEqual(p1.motorTargets.raw, p2.motorTargets.raw)

  const t1 = planNeckTransportCommand({
    pose,
    profile: bmProfile,
    previousState: createNeckPlannerState({ safetyInitialized: true }),
    applySafetyLimiter: false,
  })
  const t2 = planNeckTransportCommand({
    pose,
    profile: fakeProfile,
    previousState: createNeckPlannerState({ safetyInitialized: true }),
    applySafetyLimiter: false,
  })
  assert.deepEqual(t1.plan.joints, t2.plan.joints)
  assert.notEqual(t1.canFrame.arbitrationId, t2.canFrame.arbitrationId)
  assert.equal(t1.canFrame.isFd, true)
  assert.equal(t2.canFrame.isFd, false)
})

// ——— G–J FD / Classic frames + SLCAN ———
test("G–J: FD→d / Classic→t via adapters + codec", () => {
  const bm = createBmHmdProtocolAdapter(createLuviaReferenceProfile())
  const cmd = createMotorCommand({
    mode: "POSITION",
    motors: [{ logicalMotorId: 1, positionRaw: 0 }, { logicalMotorId: 2, positionRaw: 0 }],
  })
  const fdFrame = bm.encodePositionCommand(cmd)
  assert.equal(fdFrame.isFd, true)
  assert.equal(encodeSlcanAscii(fdFrame).startsWith("d"), true)

  const fake = createFakeMotorProtocolAdapter({
    transport: createClassicTransportConfig(),
  })
  const classicFrame = fake.encodePositionCommand(cmd)
  assert.equal(classicFrame.isFd, false)
  assert.equal(encodeSlcanAscii(classicFrame).startsWith("t"), true)
  assert.equal(encodeSlcanAscii(classicFrame), "t12380000000000000000")
})

// ——— K BM_HMD + Classic incompatible ———
test("K: BM_HMD + classic → PROTOCOL_TRANSPORT_INCOMPATIBLE", () => {
  const profile = {
    motorProtocol: { type: "bm-hmd", version: "bm-hmd-luvia-v1" },
    transport: createClassicTransportConfig(),
  }
  assert.throws(
    () => createMotorProtocolAdapter(profile),
    (err) =>
      err instanceof MotorProtocolError && err.code === "PROTOCOL_TRANSPORT_INCOMPATIBLE"
  )
  assert.throws(
    () =>
      validateProtocolTransportCompatibility({
        motorProtocol: profile.motorProtocol,
        transport: profile.transport,
        capabilities: {
          modes: ["POSITION"],
          maxMotorsPerFrame: 4,
          supportsFeedback: true,
          requiresCanFd: true,
          requiresBrs: false,
        },
      }),
    (err) => err.code === "PROTOCOL_TRANSPORT_INCOMPATIBLE"
  )
})

// ——— L Fake classic compatible ———
test("L: Fake + classic profile compatible", () => {
  const profile = createLuviaReferenceProfile({
    motorProtocol: { type: "fake-classic-can", version: "fake-classic-can-v1" },
    transport: createClassicTransportConfig(),
  })
  const adapter = createMotorProtocolAdapter(profile)
  validateProtocolTransportCompatibility({
    motorProtocol: profile.motorProtocol,
    transport: profile.transport,
    capabilities: adapter.capabilities,
  })
  assert.equal(adapter.type, "fake-classic-can")
})

// ——— M SLCAN codec no BM_HMD dependency ———
test("M: slcanCodec sources must not import bmHmd", () => {
  const slcanPath = path.join(TRANSPORT_DIR, "slcanCodec.js")
  const src = fs.readFileSync(slcanPath, "utf8")
  assert.equal(src.includes("bmHmd"), false)
  assert.equal(src.includes("bm_hmd"), false)
  assert.equal(/from\s+['"].*bmHmd/.test(src), false)
  // codec still works on plain CanFrame
  const frame = createCanFrame({
    arbitrationId: 0x32,
    data: new Uint8Array(8),
    isFd: true,
    brs: false,
  })
  assert.equal(encodeSlcanAscii(frame), "d03280000000000000000")
})

// ——— N Runtime Core no BM_HMD / SLCAN ———
test("N: core/ must not import bmHmdProtocol or slcanCodec", () => {
  for (const { file, src } of readJsSources(CORE_DIR)) {
    assert.equal(src.includes("bmHmdProtocol"), false, file)
    assert.equal(src.includes("slcanCodec"), false, file)
    assert.equal(src.includes("navigator.serial"), false, file)
    assert.equal(/from\s+['"].*bmHmd/.test(src), false, file)
    assert.equal(/from\s+['"].*slcan/.test(src), false, file)
  }
})

// ——— O Motor feedback canonicalization ———
test("O: BM_HMD decodeFrame → canonical MotorFeedback", () => {
  const adapter = createBmHmdProtocolAdapter(createLuviaReferenceProfile())
  const compact = hexCompact("FF9C FF06 0800 01E0")
  const data = new Uint8Array(compact.length / 2)
  for (let i = 0; i < data.length; i++) {
    data[i] = Number.parseInt(compact.slice(i * 2, i * 2 + 2), 16)
  }
  const frame = createCanFrame({ arbitrationId: 0x51, data, isFd: true, brs: false })
  const decoded = adapter.decodeFrame(frame)
  assert.equal(decoded.kind, "drive")
  assert.equal(decoded.feedback.motorId, 1)
  assert.equal(decoded.feedback.speed, -10)
  assert.equal(decoded.feedback.current, -2.5)
  assert.equal(decoded.feedback.position, 180)
  assert.equal(decoded.feedback.voltage, 48)
  // legacy decode still available
  const legacy = decodeDriveFeedback(frame)
  assert.equal(legacy.speedRpm, decoded.feedback.speed)
})

// ——— P Alternate adapter feedback ———
test("P: Fake decodeFrame returns minimal/null MotorFeedback", () => {
  const adapter = createFakeMotorProtocolAdapter({
    transport: createClassicTransportConfig(),
  })
  const frame = createCanFrame({
    arbitrationId: 0x123,
    data: new Uint8Array(8),
    isFd: false,
  })
  const decoded = adapter.decodeFrame(frame)
  assert.equal(decoded.kind, "fake")
  assert.equal(decoded.feedback.position, null)
  assert.equal(decoded.feedback.speed, null)
  assert.equal(decoded.feedback.enabled, null)
  const blank = createMotorFeedback({})
  assert.equal(blank.motorId, null)
})

// ——— Q planNeckTransportCommand uses registry ———
test("Q: planNeckTransportCommand uses registry adapter", () => {
  const r = planNeckTransportCommand({
    pose: { pitch: 0, roll: 0, yaw: 0 },
    previousState: createNeckPlannerState({ safetyInitialized: true }),
    applySafetyLimiter: false,
  })
  assert.equal(r.accepted, true)
  assert.equal(r.adapterType, "bm-hmd")
  assert.ok(r.motorCommand)
  assert.equal(r.motorCommand.mode, "POSITION")
  assert.equal(r.canFrame.arbitrationId, 0x32)
})

// ——— R Convenience API backward compatibility ———
test("R: convenience API keeps outward result shape", () => {
  const r = planNeckTransportCommand({
    pose: { pitch: 1, roll: 0, yaw: 0 },
    previousState: createNeckPlannerState({ safetyInitialized: true }),
    applySafetyLimiter: false,
  })
  for (const key of [
    "accepted",
    "rejectReason",
    "plan",
    "canFrame",
    "slcanLine",
    "motorRawSlots",
    "nextState",
    "diagnostics",
  ]) {
    assert.ok(key in r, key)
  }
  assert.ok(r.slcanLine.startsWith("d0328"))
})

// ——— S–V Golden parity via adapter path ———
test("S–V: golden command/feedback/random/SLCAN parity via adapter", () => {
  const fixture = loadFixture()
  const adapter = createBmHmdProtocolAdapter(createLuviaReferenceProfile())
  const proto = adapter.getUnderlyingProtocol()

  for (const c of fixture.cases) {
    const fr = c.frame
    let encoded
    if (c.category === "A") {
      encoded = adapter.encodePositionCommand(
        createMotorCommand({
          mode: "POSITION",
          motors: [
            { logicalMotorId: 1, positionRaw: 0 },
            { logicalMotorId: 2, positionRaw: 0 },
            { logicalMotorId: 3, positionRaw: 0 },
            { logicalMotorId: 4, positionRaw: 0 },
          ],
        })
      )
    } else if (c.category === "B") {
      encoded = adapter.encodePositionCommand(
        createMotorCommand({
          mode: "POSITION",
          motors: [
            { logicalMotorId: 1, positionRaw: 100 },
            { logicalMotorId: 2, positionRaw: 200 },
            { logicalMotorId: 3, positionRaw: 50 },
            { logicalMotorId: 4, positionRaw: 0 },
          ],
        })
      )
    } else if (c.category === "C") {
      encoded = adapter.encodePositionCommand(
        createMotorCommand({
          mode: "POSITION",
          motors: [
            { logicalMotorId: 1, positionRaw: -100 },
            { logicalMotorId: 2, positionRaw: -200 },
            { logicalMotorId: 3, positionRaw: -50 },
            { logicalMotorId: 4, positionRaw: 0 },
          ],
        })
      )
    } else if (c.category === "D") {
      encoded = adapter.encodePositionCommand(
        createMotorCommand({
          mode: "POSITION",
          motors: [
            { logicalMotorId: 1, positionRaw: 100 },
            { logicalMotorId: 2, positionRaw: -100 },
            { logicalMotorId: 3, positionRaw: 50 },
            { logicalMotorId: 4, positionRaw: 0 },
          ],
        })
      )
    } else if (c.category === "E") {
      encoded = adapter.encodePositionCommand(
        createMotorCommand({
          mode: "POSITION",
          motors: [
            { logicalMotorId: 1, positionRaw: 1000 },
            { logicalMotorId: 2, positionRaw: -1000 },
            { logicalMotorId: 3, positionRaw: 1000 },
            { logicalMotorId: 4, positionRaw: -1000 },
          ],
        })
      )
    } else if (c.category === "F") {
      encoded = adapter.encodePositionCommand(
        createMotorCommand({
          mode: "POSITION",
          motors: [
            { logicalMotorId: 1, positionRaw: 1 },
            { logicalMotorId: 2, positionRaw: 2 },
            { logicalMotorId: 3, positionRaw: 3 },
            { logicalMotorId: 4, positionRaw: 4 },
          ],
        })
      )
    } else if (c.id === "G-pos-mode-1") encoded = adapter.encodeControlModeCommand(1)
    else if (c.id === "G-pos-mode-2") encoded = adapter.encodeControlModeCommand(2)
    else if (c.id === "G-pos-mode-3") encoded = adapter.encodeControlModeCommand(3)
    else if (c.category === "H") encoded = adapter.encodeEnableCommand([1, 2, 3])
    else if (c.category === "I") encoded = adapter.encodeDisableCommand([1, 2, 3])
    else if (c.category === "J")
      encoded = proto.encodeStateControl([MotorCmd.CALIBRATE])
    else continue

    assert.equal(encoded.arbitrationId, fr.arbitrationId, c.id)
    assert.equal(dataToHex(encoded.data), hexCompact(fr.dataHex), `${c.id} data`)
    assert.equal(encodeSlcanAscii(encoded), fr.slcanAscii, `${c.id} slcan`)
  }

  assert.ok(fixture.randomCases.length >= 1000)
  for (const rc of fixture.randomCases) {
    const enc = adapter.encodePositionCommand(
      createMotorCommand({
        mode: "POSITION",
        motors: [
          { logicalMotorId: 1, positionRaw: rc.raw.m1 },
          { logicalMotorId: 2, positionRaw: rc.raw.m2 },
          { logicalMotorId: 3, positionRaw: rc.raw.m3 },
          { logicalMotorId: 4, positionRaw: rc.raw.m4 },
        ],
      })
    )
    assert.equal(dataToHex(enc.data), hexCompact(rc.frame.dataHex), rc.id)
    assert.equal(encodeSlcanAscii(enc), rc.frame.slcanAscii, rc.id)
  }
})

// ——— W R1 IK/mapping still works ———
test("W: R1 IK/mapping parity unchanged through profile migration", () => {
  const oldStyle = normalizeNeckRuntimeProfile({
    name: "legacy-no-protocol-fields",
    // intentionally omit motorProtocol / transport
  })
  assert.equal(oldStyle.motorProtocol.type, "bm-hmd")
  assert.equal(oldStyle.transport.can.mode, "fd")
  const plan = planNeckPose({
    pose: { pitch: 0, roll: 0, yaw: 0 },
    profile: oldStyle,
    previousState: createNeckPlannerState({ safetyInitialized: true }),
    applySafetyLimiter: false,
  })
  assert.equal(plan.accepted, true)
})

// ——— X Bridge path regression ———
test("X: Luvia Bridge client still importable", () => {
  const client = createNeckBridgeClient({ autoConnect: false })
  assert.ok(client)
  assert.equal(typeof client.offerTarget, "function")
})

// ——— Y Shadow path bit-exact bm-hmd + slcan ———
test("Y: protocol shadow still bm-hmd + slcan bit path", () => {
  const shadow = createNeckBrowserShadow({ enabled: true, protocolShadow: true })
  const snap = shadow.observePose({ pitch: 2, roll: 0, yaw: 0 }, { forceEmit: true })
  assert.ok(snap.browserNativeProtocol)
  assert.equal(snap.browserNativeProtocol.can.id, 0x32)
  assert.equal(snap.browserNativeProtocol.can.isFd, true)
  assert.equal(snap.browserNativeProtocol.can.brs, false)
  assert.ok(snap.browserNativeProtocol.slcan.line.startsWith("d032"))

  const direct = planNeckTransportCommand({
    pose: { pitch: 2, roll: 0, yaw: 0 },
    previousState: createNeckPlannerState(),
    applySafetyLimiter: true,
  })
  assert.equal(snap.browserNativeProtocol.slcan.line, direct.slcanLine)
  assert.equal(snap.browserNativeProtocol.can.dataHex, dataToHex(direct.canFrame.data))
})

// ——— Z CanTransport mock + MotorCommand purity + SC/ST note ———
test("Z: MockCanTransport contract + MotorCommand forbids CAN leak", () => {
  const transport = createMockCanTransport()
  assertCanTransport(transport)
  assert.equal(transport.getState().state, "closed")
  // sync open for test
  return transport.open().then(async () => {
    const frame = createCanFrame({
      arbitrationId: 0x32,
      data: new Uint8Array(8),
      isFd: true,
    })
    await transport.sendFrame(frame)
    assert.equal(transport.getSentFrames().length, 1)
    let got = null
    const unsub = transport.onFrame((f) => {
      got = f
    })
    transport.injectFrame(frame)
    assert.equal(got.arbitrationId, 0x32)
    unsub()
    await transport.close()

    assert.throws(
      () =>
        createMotorCommand({
          mode: "POSITION",
          motors: [{ logicalMotorId: 1, positionRaw: 1, arbitrationId: 0x32 }],
        }),
      MotorCommandError
    )

    const fromTargets = createMotorCommandFromMotorTargets({
      raw: { id1: 1, id2: 2, id3: 3 },
    })
    assert.equal(fromTargets.motors[0].positionRaw, 1)

    const codec = createTransportCodec({ type: "slcan" })
    assert.equal(typeof codec.encodeFrame, "function")

    // architecture: protocol sources must not reference navigator.serial / Worker physical TX
    for (const { file, src } of readJsSources(PROTOCOL_DIR)) {
      const lower = src.toLowerCase()
      assert.equal(lower.includes("navigator.serial"), false, file)
      assert.equal(lower.includes("from \"worker"), false, file)
      assert.equal(/\bnavigator\s*\.\s*serial\b/.test(src), false, file)
    }
  })
})
