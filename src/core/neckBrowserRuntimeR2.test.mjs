/**
 * FaceDEV Browser-Native Neck Runtime R2 — Protocol + SLCAN tests (A–AJ practical subset).
 */
import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  createCanFrame,
  dataToHex,
  assertProductionNeckTxFrame,
  CanFrameError,
  packI16Be,
  unpackI16Be,
  packU16Be,
  unpackU16Be,
  packU32Le,
  roundHalfAwayFromZero,
  CodecError,
  BmHmdProtocol,
  createProductionBmHmdProtocol,
  MotorCmd,
  ProtocolError,
  decodeDriveFeedback,
  decodeTelemetry,
  decodeState,
  decodeFeedbackFrame,
  FeedbackError,
  encodeSlcanAscii,
  decodeSlcanAscii,
  buildSlcanOpenSequence,
  SLCAN_OPEN_SEQUENCE,
  createLuviaTransportProfile,
  rejectBrsConfig,
  PROTOCOL_PROFILE_VERSION,
  TransportProfileError,
  planNeckTransportCommand,
} from "../sdk/neck/protocol/index.js"
import {
  createLuviaReferenceProfile,
  planNeckPose,
  createNeckPlannerState,
} from "../sdk/neck/core/index.js"
import { createNeckBridgeClient } from "../sdk/neck/neckBridgeClient.js"
import { createNeckBrowserShadow } from "../sdk/neck/neckBrowserShadow.js"
import { FACEDEV_NECK_PROTOCOL_VERSION } from "../sdk/neck/neckBridgeProtocol.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(__dirname, "../../tests/fixtures/neck-luvia-protocol-golden-v1.json")
const PROTOCOL_DIR = path.resolve(__dirname, "../sdk/neck/protocol")

function loadFixture() {
  assert.ok(fs.existsSync(FIXTURE), "run generate-neck-luvia-protocol-golden.py first")
  return JSON.parse(fs.readFileSync(FIXTURE, "utf8"))
}

function hexCompact(spaced) {
  return String(spaced).replace(/\s+/g, "").toUpperCase()
}

function frameFromHex(arb, hex, { isFd = true, brs = false } = {}) {
  const compact = hexCompact(hex)
  const data = new Uint8Array(compact.length / 2)
  for (let i = 0; i < data.length; i++) {
    data[i] = Number.parseInt(compact.slice(i * 2, i * 2 + 2), 16)
  }
  return createCanFrame({ arbitrationId: arb, data, isFd, brs })
}

// ——— A CanFrame model ———
test("A: CanFrame model + dataToHex", () => {
  const f = createCanFrame({
    arbitrationId: 0x32,
    data: new Uint8Array(8),
    isFd: true,
    brs: false,
  })
  assert.equal(f.arbitrationId, 0x32)
  assert.equal(f.isExtendedId, false)
  assert.equal(f.isFd, true)
  assert.equal(f.brs, false)
  assert.ok(f.data instanceof Uint8Array)
  assert.equal(dataToHex(f.data), "0000000000000000")
  assertProductionNeckTxFrame(f)
  assert.throws(() => assertProductionNeckTxFrame({ ...f, brs: true }), CanFrameError)
  assert.throws(() => assertProductionNeckTxFrame({ ...f, isFd: false }), CanFrameError)
})

// ——— B–F 0x32 encoding ———
test("B–E: 0x32 zero / positive / negative / mixed reference facts", () => {
  const p = createProductionBmHmdProtocol()
  const z = p.encodePositionCommandFrameFromRaw(0, 0, 0, 0)
  assert.equal(z.arbitrationId, 0x32)
  assert.equal(dataToHex(z.data), "0000000000000000")
  assert.equal(z.isFd, true)
  assert.equal(z.brs, false)
  assert.equal(encodeSlcanAscii(z), "d03280000000000000000")

  const mixed = p.encodePositionCommandFrameFromRaw(100, -100, 50, 0)
  assert.equal(dataToHex(mixed.data), "0064FF9C00320000")
  assert.equal(encodeSlcanAscii(mixed), "d03280064FF9C00320000")

  const pos = p.encodePositionCommandFrameFromRaw(100, 200, 50, 0)
  assert.equal(unpackI16Be(pos.data, 0), 100)
  assert.equal(unpackI16Be(pos.data, 2), 200)

  const neg = p.encodePositionCommandFrameFromRaw(-100, -200, -50, 0)
  assert.equal(unpackI16Be(neg.data, 0), -100)
  assert.equal(unpackI16Be(neg.data, 2), -200)
})

test("F–G: i16 boundary codec + big-endian layout", () => {
  assert.deepEqual([...packI16Be(0)], [0x00, 0x00])
  assert.deepEqual([...packI16Be(1)], [0x00, 0x01])
  assert.deepEqual([...packI16Be(-1)], [0xff, 0xff])
  assert.deepEqual([...packI16Be(-32768)], [0x80, 0x00])
  assert.deepEqual([...packI16Be(32767)], [0x7f, 0xff])
  assert.equal(unpackI16Be(packI16Be(-32768)), -32768)
  assert.equal(unpackI16Be(packI16Be(32767)), 32767)
  assert.throws(() => packI16Be(32768), CodecError)
  assert.throws(() => packI16Be(-32769), CodecError)
  assert.equal(roundHalfAwayFromZero(1.5), 2)
  assert.equal(roundHalfAwayFromZero(-1.5), -2)
  // BE layout: high byte first
  assert.deepEqual([...packU16Be(0x1234)], [0x12, 0x34])
  assert.equal(unpackU16Be(new Uint8Array([0x12, 0x34])), 0x1234)
  assert.deepEqual([...packU32Le(0x05)], [0x05, 0x00, 0x00, 0x00])
})

// ——— H–K 0x36 / 0x38 ———
test("H–K: 0x36 position mode + 0x38 enable/disable/calibrate", () => {
  const p = createProductionBmHmdProtocol()
  const mode = p.encodeSetPositionMode(1)
  assert.equal(mode.arbitrationId, 0x36)
  assert.equal(dataToHex(mode.data), "011D050000000000")
  assert.equal(encodeSlcanAscii(mode), "d0368011D050000000000")

  const en = p.encodeStateControl([MotorCmd.ENABLE, MotorCmd.ENABLE, MotorCmd.ENABLE])
  assert.equal(en.arbitrationId, 0x38)
  assert.equal(dataToHex(en.data), "0202020000000000")
  assert.equal(encodeSlcanAscii(en), "d03880202020000000000")

  const dis = p.encodeStateControl([MotorCmd.DISABLE, MotorCmd.DISABLE, MotorCmd.DISABLE])
  assert.equal(dataToHex(dis.data), "0101010000000000")

  const cal = p.encodeStateControl([MotorCmd.CALIBRATE])
  assert.equal(dataToHex(cal.data), "0300000000000000")
})

// ——— L–P feedback ———
test("L: DriveFeedback 0x51 sample scales", () => {
  const frame = frameFromHex(0x51, "FF9C FF06 0800 01E0")
  const fb = decodeDriveFeedback(frame)
  assert.equal(fb.motorId, 1)
  assert.equal(fb.speedRpm, -10)
  assert.equal(fb.iqA, -2.5)
  assert.equal(fb.rawAbsolutePosition, 2048)
  assert.equal(fb.absolutePositionDeg, 180)
  assert.equal(fb.voltageV, 48.0)
  assert.equal("temperature" in fb, false)
})

test("M: Telemetry 0x71 decode", () => {
  const frame = frameFromHex(0x71, "0032 0064 00F0 0000")
  const fb = decodeTelemetry(frame)
  assert.equal(fb.motorId, 1)
  assert.equal(fb.speedRpm, 5.0)
  assert.equal(fb.iqA, 1.0)
  assert.equal(fb.voltageV, 24.0)
  assert.equal(fb.rawAbsolutePosition, 0)
})

test("N: State 0xA1 decode", () => {
  const frame = frameFromHex(0xa1, "01 05 01 01 00 00 FF FF")
  const st = decodeState(frame)
  assert.equal(st.motorId, 1)
  assert.equal(st.controlMode, 0x05)
  assert.equal(st.cmd, 1)
  assert.equal(st.calibrated, true)
  assert.equal(st.faultCode, 0)
  assert.equal(st.enabled, false)
})

test("O–P: unknown frame + invalid DLC typed errors", () => {
  assert.throws(() => decodeFeedbackFrame(frameFromHex(0x99, "00".repeat(8))), FeedbackError)
  assert.throws(
    () => decodeDriveFeedback(createCanFrame({ arbitrationId: 0x51, data: new Uint8Array(4) })),
    FeedbackError
  )
})

// ——— Q–S CAN FD / BRS ———
test("Q–S: CAN FD flags + BRS false + BRS config reject", () => {
  const p = createProductionBmHmdProtocol()
  const f = p.encodePositionCommandFrameFromRaw(0, 0)
  assert.equal(f.isFd, true)
  assert.equal(f.brs, false)
  assert.throws(() => new BmHmdProtocol({ fd: true, brs: true, production: true }), (err) => {
    return err instanceof ProtocolError || err instanceof TransportProfileError
  })
  assert.throws(() => rejectBrsConfig({ brs: true }), TransportProfileError)
  assert.throws(() => createLuviaTransportProfile({ brs: true }), TransportProfileError)
  const tp = createLuviaTransportProfile()
  assert.equal(tp.protocolProfileVersion, PROTOCOL_PROFILE_VERSION)
  assert.equal(tp.protocolProfileVersion, "bm-hmd-luvia-v1")
  assert.notEqual(tp.protocolProfileVersion, FACEDEV_NECK_PROTOCOL_VERSION)
  assert.equal(tp.arbitrationBitrate, 1e6)
  assert.equal(tp.dataBitrate, 5e6)
})

// ——— T–V SLCAN ———
test("T–U: SLCAN FD no-BRS encode/decode + classic", () => {
  const p = createProductionBmHmdProtocol()
  const f = p.encodePositionCommandFrameFromRaw(100, -100, 50, 0)
  const line = encodeSlcanAscii(f)
  assert.equal(line, "d03280064FF9C00320000")
  const decoded = decodeSlcanAscii(line + "\r\n")
  assert.equal(decoded.arbitrationId, 0x32)
  assert.equal(decoded.isFd, true)
  assert.equal(decoded.brs, false)
  assert.equal(dataToHex(decoded.data), dataToHex(f.data))

  // BRS grammar parse-only
  const brsParsed = decodeSlcanAscii("b03280000000000000000")
  assert.equal(brsParsed.brs, true)

  const classic = decodeSlcanAscii("t03280000000000000000")
  assert.equal(classic.isFd, false)
})

test("V: SLCAN open sequence C S8 Y5 M0 A1 O", () => {
  assert.deepEqual([...SLCAN_OPEN_SEQUENCE], ["C", "S8", "Y5", "M0", "A1", "O"])
  assert.deepEqual(buildSlcanOpenSequence(), ["C", "S8", "Y5", "M0", "A1", "O"])
  assert.deepEqual(buildSlcanOpenSequence({ withCr: true }), [
    "C\r",
    "S8\r",
    "Y5\r",
    "M0\r",
    "A1\r",
    "O\r",
  ])
})

// ——— W–Z / AA golden parity ———
test("W–Z / AA: Python command + feedback + random + SLCAN golden parity + roundtrip", () => {
  const fixture = loadFixture()
  const p = createProductionBmHmdProtocol()

  for (const c of fixture.cases) {
    const fr = c.frame
    let encoded
    if (c.category === "A") encoded = p.encodePositionCommandFrameFromRaw(0, 0, 0, 0)
    else if (c.category === "B") encoded = p.encodePositionCommandFrameFromRaw(100, 200, 50, 0)
    else if (c.category === "C") encoded = p.encodePositionCommandFrameFromRaw(-100, -200, -50, 0)
    else if (c.category === "D") encoded = p.encodePositionCommandFrameFromRaw(100, -100, 50, 0)
    else if (c.category === "E")
      encoded = p.encodePositionCommandFrameFromRaw(1000, -1000, 1000, -1000)
    else if (c.category === "F") encoded = p.encodePositionCommandFrameFromRaw(1, 2, 3, 4)
    else if (c.id === "G-pos-mode-1") encoded = p.encodeSetPositionMode(1)
    else if (c.id === "G-pos-mode-2") encoded = p.encodeSetPositionMode(2)
    else if (c.id === "G-pos-mode-3") encoded = p.encodeSetPositionMode(3)
    else if (c.category === "H")
      encoded = p.encodeStateControl([MotorCmd.ENABLE, MotorCmd.ENABLE, MotorCmd.ENABLE])
    else if (c.category === "I")
      encoded = p.encodeStateControl([MotorCmd.DISABLE, MotorCmd.DISABLE, MotorCmd.DISABLE])
    else if (c.category === "J") encoded = p.encodeStateControl([MotorCmd.CALIBRATE])
    else continue

    assert.equal(encoded.arbitrationId, fr.arbitrationId, c.id)
    assert.equal(dataToHex(encoded.data), hexCompact(fr.dataHex), `${c.id} data`)
    assert.equal(encoded.isFd, fr.isFd)
    assert.equal(encoded.brs, fr.brs)
    assert.equal(encodeSlcanAscii(encoded), fr.slcanAscii, `${c.id} slcan`)

    const rt = decodeSlcanAscii(encodeSlcanAscii(encoded))
    assert.equal(rt.arbitrationId, encoded.arbitrationId)
    assert.equal(dataToHex(rt.data), dataToHex(encoded.data))
  }

  for (const fb of fixture.feedbackCases) {
    const frame = frameFromHex(fb.input.arbitrationId, fb.input.dataHexCompact || fb.input.dataHex, {
      isFd: fb.input.isFd,
      brs: fb.input.brs,
    })
    if (fb.category === "L") {
      const d = decodeDriveFeedback(frame)
      assert.equal(d.speedRpm, fb.reference.speedRpm)
      assert.equal(d.iqA, fb.reference.iqA)
      assert.equal(d.rawAbsolutePosition, fb.reference.rawAbsolutePosition)
      assert.equal(d.absolutePositionDeg, fb.reference.absolutePositionDeg)
      assert.equal(d.voltageV, fb.reference.voltageV)
    } else if (fb.category === "M") {
      const d = decodeTelemetry(frame)
      assert.equal(d.speedRpm, fb.reference.speedRpm)
      assert.equal(d.iqA, fb.reference.iqA)
      assert.equal(d.voltageV, fb.reference.voltageV)
    } else if (fb.category === "N") {
      const d = decodeState(frame)
      assert.equal(d.controlMode, fb.reference.controlMode)
      assert.equal(d.cmd, fb.reference.cmd)
      assert.equal(d.calibrated, fb.reference.calibrated)
    }
  }

  assert.deepEqual(fixture.openSequence, ["C", "S8", "Y5", "M0", "A1", "O"])

  assert.ok(fixture.randomCases.length >= 1000)
  let matched = 0
  for (const rc of fixture.randomCases) {
    const enc = p.encodePositionCommandFrameFromRaw(rc.raw.m1, rc.raw.m2, rc.raw.m3, rc.raw.m4)
    assert.equal(dataToHex(enc.data), hexCompact(rc.frame.dataHex), rc.id)
    assert.equal(encodeSlcanAscii(enc), rc.frame.slcanAscii, rc.id)
    matched++
  }
  assert.equal(matched, fixture.randomCases.length)
})

// ——— AB–AD pipeline ———
test("AB–AD: R1→R2 pipeline + offsets + branch continuity", () => {
  const profile = createLuviaReferenceProfile()
  const prev = createNeckPlannerState({ safetyInitialized: true })
  const transport = planNeckTransportCommand({
    pose: { pitch: 5, roll: -3, yaw: 10 },
    profile,
    previousState: prev,
    applySafetyLimiter: false,
  })
  assert.equal(transport.accepted, true)
  assert.ok(transport.canFrame)
  assert.equal(transport.canFrame.arbitrationId, 0x32)
  assert.equal(transport.canFrame.isFd, true)
  assert.equal(transport.canFrame.brs, false)
  assert.ok(transport.slcanLine.startsWith("d0328"))
  assert.equal(transport.motorRawSlots.motor1, transport.plan.motorTargets.raw.id1)
  assert.equal(transport.motorRawSlots.motor2, transport.plan.motorTargets.raw.id2)
  assert.equal(transport.motorRawSlots.motor3, transport.plan.motorTargets.raw.id3)
  assert.equal(transport.motorRawSlots.motor4, 0)
  assert.equal(transport.plan.diagnostics.branch, "nearest_continuous")

  // non-zero offsets
  const offProf = createLuviaReferenceProfile({
    mapping: {
      ...profile.mapping,
      side1: { ...profile.mapping.side1, offsetDeg: 2 },
      side2: { ...profile.mapping.side2, offsetDeg: -1.5 },
    },
  })
  const t2 = planNeckTransportCommand({
    pose: { pitch: 0, roll: 0, yaw: 0 },
    profile: offProf,
    previousState: createNeckPlannerState({ safetyInitialized: true }),
    applySafetyLimiter: false,
  })
  assert.equal(t2.accepted, true)
  // offsets change mapped raw vs zero-offset neutral
  const neutral = planNeckPose({
    pose: { pitch: 0, roll: 0, yaw: 0 },
    profile,
    previousState: createNeckPlannerState({ safetyInitialized: true }),
    applySafetyLimiter: false,
  })
  assert.notDeepEqual(t2.plan.motorTargets.raw, neutral.motorTargets.raw)
})

// ——— AE–AG purity ———
test("AE–AG: protocol has no DOM / WebSerial / physical TX", () => {
  const files = fs.readdirSync(PROTOCOL_DIR).filter((f) => f.endsWith(".js"))
  assert.ok(files.length >= 7)
  const forbidden = [
    "from \"react\"",
    "from 'react'",
    "document.",
    "window.",
    "navigator.",
    "websocket",
    "navigator.serial",
    "serialport",
    "settimeout(",
    "setinterval(",
    "requestanimationframe(",
  ]
  for (const f of files) {
    const src = fs.readFileSync(path.join(PROTOCOL_DIR, f), "utf8").toLowerCase()
    for (const token of forbidden) {
      assert.equal(src.includes(token.toLowerCase()), false, `${f} must not contain ${token}`)
    }
  }
  // planning does not throw / touch serial
  const r = planNeckTransportCommand({
    pose: { pitch: 0, roll: 0, yaw: 0 },
    previousState: createNeckPlannerState({ safetyInitialized: true }),
    applySafetyLimiter: false,
  })
  assert.equal(r.accepted, true)
  assert.ok(r.slcanLine)
})

// ——— AH Bridge still importable ———
test("AH: Luvia Bridge client still importable (hardware path unchanged)", () => {
  const client = createNeckBridgeClient({ autoConnect: false })
  assert.ok(client)
  assert.equal(typeof client.connect, "function")
  assert.equal(typeof client.offerTarget, "function")
  const snap = client.getSnapshot?.() || client.getState?.()
  // shadow default off
  if (snap && typeof snap === "object") {
    if ("browserCoreShadowEnabled" in snap) {
      assert.equal(snap.browserCoreShadowEnabled, false)
    }
    if ("browserProtocolShadowEnabled" in snap) {
      assert.equal(snap.browserProtocolShadowEnabled, false)
    }
  }
})

test("AI–AJ: shadow protocol optional + Character/Bridge protocol version intact", () => {
  assert.equal(FACEDEV_NECK_PROTOCOL_VERSION, "facedev-neck-v1")
  const shadow = createNeckBrowserShadow({ enabled: true, protocolShadow: true })
  const snap = shadow.observePose({ pitch: 2, roll: 0, yaw: 0 }, { forceEmit: true })
  assert.ok(snap)
  assert.ok(snap.browserNativeProtocol)
  assert.ok(snap.browserNativeProtocol.can)
  assert.ok(snap.browserNativeProtocol.slcan.line.startsWith("d032"))
  // default protocol shadow off
  const shadowOff = createNeckBrowserShadow({ enabled: true })
  const snap2 = shadowOff.observePose({ pitch: 1, roll: 0, yaw: 0 }, { forceEmit: true })
  assert.equal(snap2.browserNativeProtocol, null)
})
