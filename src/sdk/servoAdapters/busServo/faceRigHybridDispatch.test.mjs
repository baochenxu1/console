/**
 * Face Rig / Tracking 混协议发送回归。
 *
 * Face Rig（txMode single-write）：SC/ST 保持逐台写；RJ → Motion + Batch。
 * Tracking hybrid：SC SyncWrite 0x83；ST single-write；RJ Batch。
 *
 * 运行：node src/sdk/servoAdapters/busServo/faceRigHybridDispatch.test.mjs
 */

import assert from "node:assert/strict"
import { REQUEST_HEADER_0, REQUEST_HEADER_1 } from "../rjsbus/rjSbusConstants.js"
import { computeChecksum } from "../rjsbus/rjSbusPacket.js"
import { INSTRUCTION } from "../scservo/scProtocolConstants.js"
import { sendBusServoCommandsHybrid } from "./sendBusServoCommandsHybrid.js"
import { sendBusServoCommands } from "./sendBusServoCommands.js"
import { groupBusCommandsForSyncWrite } from "./sendBusServoFrameSyncWrite.js"
import {
  resetRjHostMotionState,
  RJ_MOTION_CONFIG,
  patchRjMotionConfig,
} from "../../output/rjHostMotionAdapter.js"
import { rjSbusTransport } from "../rjsbus/rjSbusWebSerialTransport.js"
import { scServoTransport } from "../scservo/scServoWebSerialTransport.js"

function rjProfile(id, extra = {}) {
  return {
    protocol: "rj_sbus",
    id,
    busServoId: id,
    power: 600,
    time: 0,
    ...extra,
  }
}

function rjCmd(id, targetPosition, extra = {}) {
  return {
    busServoId: id,
    protocol: "rj_sbus",
    actuatorKey: `servo_${id}`,
    targetPosition,
    busLogical: 500,
    logicalValue: 500,
    profile: rjProfile(id),
    ...extra,
  }
}

function scProfile(id) {
  return {
    protocol: "scscl",
    id,
    busServoId: id,
    time: 0,
    speed: 0,
    positionMin: 0,
    positionMax: 1023,
    logicalPositionMin: 205,
    logicalPositionMax: 819,
  }
}

function scCmd(id, targetPosition) {
  return {
    busServoId: id,
    protocol: "scscl",
    actuatorKey: `servo_${id}`,
    targetPosition,
    busLogical: 500,
    logicalValue: 500,
    time: 0,
    speed: 0,
    profile: scProfile(id),
  }
}

function stProfile(id) {
  return {
    protocol: "sms_sts",
    id,
    busServoId: id,
    time: 0,
    speed: 0,
    acc: 0,
    positionMin: 0,
    positionMax: 4095,
  }
}

function stCmd(id, targetPosition) {
  return {
    busServoId: id,
    protocol: "sms_sts",
    actuatorKey: `servo_${id}`,
    targetPosition,
    busLogical: 500,
    logicalValue: 500,
    time: 0,
    speed: 0,
    acc: 0,
    profile: stProfile(id),
  }
}

function createMockTransport() {
  const writes = []
  return {
    writes,
    getStatus() {
      return { connected: true, supported: true }
    },
    async write(bytes) {
      writes.push(Uint8Array.from(bytes || []))
      return { ok: true }
    },
  }
}

function withConnectedPorts(fn) {
  const rjGet = rjSbusTransport.getStatus
  const scGet = scServoTransport.getStatus
  rjSbusTransport.getStatus = () => ({ connected: true, supported: true, baudRate: 1000000 })
  scServoTransport.getStatus = () => ({ connected: true, supported: true, baudRate: 1000000 })
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      rjSbusTransport.getStatus = rjGet
      scServoTransport.getStatus = scGet
    })
}

function parseFeetechPacket(bytes) {
  const b = Array.from(bytes || [])
  assert.ok(b.length >= 6, "packet too short")
  assert.equal(b[0], 0xff)
  assert.equal(b[1], 0xff)
  return {
    id: b[2],
    len: b[3],
    instruction: b[4],
    params: b.slice(5, 5 + b[3] - 2),
    raw: b,
  }
}

function parseSyncWriteIds(params) {
  assert.ok(params.length >= 2)
  const dataLen = params[1]
  const ids = []
  let i = 2
  while (i < params.length) {
    ids.push(params[i])
    i += 1 + dataLen
  }
  return ids
}

function splitRjRequestPackets(batchBytes) {
  const bytes = Array.from(batchBytes || [])
  const packets = []
  let i = 0
  while (i < bytes.length) {
    assert.equal(bytes[i], REQUEST_HEADER_0)
    assert.equal(bytes[i + 1], REQUEST_HEADER_1)
    const n = bytes[i + 3]
    const len = 4 + n + 1
    const pkt = Uint8Array.from(bytes.slice(i, i + len))
    assert.equal(pkt[pkt.length - 1], computeChecksum(pkt.slice(0, pkt.length - 1)))
    packets.push(pkt)
    i += len
  }
  return packets
}

async function run() {
  const savedCfg = { ...RJ_MOTION_CONFIG }
  patchRjMotionConfig({
    velocityRatio: 0.9,
    defaultVelocityDegS: 400,
    minTimeMs: 20,
    minSendIntervalMs: 20,
  })

  /* ---------- Test A — Face Rig：Jaw SC 保持 single-write（不强制 SyncWrite） ---------- */
  await withConnectedPorts(async () => {
    const scTransport = createMockTransport()
    const commands = [scCmd(8, 442), scCmd(15, 450)]
    const res = await sendBusServoCommands(commands, {
      txMode: "single-write",
      transport: scTransport,
    })
    assert.ok(res.ok, res.error)
    assert.equal(res.txMode, "single-write")
    /* 两台 SC 各一条 INST_WRITE，不是一个 0x83 */
    assert.equal(scTransport.writes.length, 2)
    for (const w of scTransport.writes) {
      assert.equal(parseFeetechPacket(w).instruction, INSTRUCTION.WRITE)
      assert.notEqual(parseFeetechPacket(w).instruction, INSTRUCTION.SYNC_WRITE)
    }
    console.log("Test A ok — Face Rig SC/ST remains per-servo WRITE (not SyncWrite)")
  })

  /* ---------- Test B — Face Rig：RJ Batch + SC single-write 共存 ---------- */
  await withConnectedPorts(async () => {
    resetRjHostMotionState()
    const rjTransport = createMockTransport()
    const scTransport = createMockTransport()
    const commands = [rjCmd(1, 100), rjCmd(2, 200), scCmd(8, 442), scCmd(15, 450)]
    const res = await sendBusServoCommands(commands, {
      txMode: "single-write",
      transport: scTransport,
      rjTransport,
    })
    assert.ok(res.ok, res.error)
    assert.ok(String(res.txMode).includes("rj-batch") || res.rjBatch)
    assert.equal(rjTransport.writes.length, 1)
    assert.equal(splitRjRequestPackets(rjTransport.writes[0]).length, 2)
    assert.equal(scTransport.writes.length, 2)
    for (const w of scTransport.writes) {
      assert.equal(parseFeetechPacket(w).instruction, INSTRUCTION.WRITE)
    }
    console.log("Test B ok — Face Rig: RJ batch×1 + SC WRITE×2, no SC SyncWrite")
  })

  /* ---------- Test C — Tracking hybrid：ST 仍 single-write ---------- */
  await withConnectedPorts(async () => {
    const scTransport = createMockTransport()
    const commands = [scCmd(8, 442), stCmd(9, 2048)]
    const res = await sendBusServoCommands(commands, {
      txMode: "hybrid",
      transport: scTransport,
      scSyncMode: "sync-inst",
    })
    assert.ok(res.ok, res.error)
    assert.equal(res.sendModeByBusServoId[8], "sync-inst")
    assert.equal(res.sendModeByBusServoId[9], "single-write")
    const stGroup = res.groups?.find((g) => g.protocol === "sms_sts")
    assert.ok(stGroup)
    assert.equal(stGroup.mode, "single-write")
    console.log("Test C ok — Tracking hybrid: ST single-write preserved")
  })

  /* ---------- Test D — Face Rig RJ Phase 2（single-write+rj-batch） ---------- */
  await withConnectedPorts(async () => {
    resetRjHostMotionState()
    const rjTransport = createMockTransport()
    const res = await sendBusServoCommands([rjCmd(21, 100), rjCmd(22, 200)], {
      txMode: "single-write",
      rjTransport,
      transport: createMockTransport(),
      activeFamily: "rj_sbus",
    })
    assert.ok(res.ok, res.error)
    assert.equal(rjTransport.writes.length, 1)
    assert.equal(res.rjBatch?.transportWriteCount, 1)
    assert.equal(splitRjRequestPackets(rjTransport.writes[0]).length, 2)
    assert.equal(RJ_MOTION_CONFIG.velocityRatio, 0.9)
    assert.equal(RJ_MOTION_CONFIG.defaultVelocityDegS, 400)
    console.log("Test D ok — Face Rig RJ still Motion+Batch")
  })

  /* ---------- Test E — Tracking hybrid：Jaw SC SyncWrite（仅 Tracking） ---------- */
  await withConnectedPorts(async () => {
    const scTransport = createMockTransport()
    const res = await sendBusServoCommands([scCmd(8, 442), scCmd(15, 450)], {
      txMode: "hybrid",
      transport: scTransport,
      scSyncMode: "sync-inst",
    })
    assert.ok(res.ok, res.error)
    assert.equal(scTransport.writes.length, 1)
    const pkt = parseFeetechPacket(scTransport.writes[0])
    assert.equal(pkt.instruction, 0x83)
    assert.deepEqual(parseSyncWriteIds(pkt.params).sort((a, b) => a - b), [8, 15])
    console.log("Test E ok — Tracking hybrid: Jaw SC SyncWrite 0x83 (Face Rig 不用此模式)")
  })

  /* ---------- Test F — Tracking hybrid：RJ + SC 分区 ---------- */
  await withConnectedPorts(async () => {
    resetRjHostMotionState()
    const rjTransport = createMockTransport()
    const scTransport = createMockTransport()
    const res = await sendBusServoCommandsHybrid(
      [rjCmd(1, 111), rjCmd(1, 222), scCmd(8, 400), scCmd(8, 442), scCmd(15, 450)],
      { transport: scTransport, rjTransport, scSyncMode: "sync-inst" }
    )
    assert.ok(res.ok, res.error)
    assert.equal(rjTransport.writes.length, 1)
    assert.equal(scTransport.writes.length, 1)
    const rjParts = splitRjRequestPackets(rjTransport.writes[0])
    assert.equal(rjParts.length, 1)
    assert.equal(rjParts[0][4], 1)
    const ticks = rjParts[0][5] | (rjParts[0][6] << 8)
    const signed = ticks > 0x7fff ? ticks - 0x10000 : ticks
    assert.equal(signed, 222)
    assert.deepEqual(
      parseSyncWriteIds(parseFeetechPacket(scTransport.writes[0]).params).sort((a, b) => a - b),
      [8, 15]
    )
    const grouped = groupBusCommandsForSyncWrite([scCmd(8, 400), scCmd(8, 442), scCmd(15, 450)])
    assert.equal(grouped.groups[0].commands.find((c) => c.id === 8).position, 442)
    console.log("Test F ok — Tracking hybrid latest-wins + RJ/SC partition")
  })

  patchRjMotionConfig(savedCfg)
  resetRjHostMotionState()
  console.log("faceRigHybridDispatch.test: all ok (A–F)")
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
