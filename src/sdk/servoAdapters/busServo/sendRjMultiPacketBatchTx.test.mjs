/**
 * Phase 2：RJ Host Motion + Multi-Packet Batch TX 自动测试（A–K）
 * 运行：node src/sdk/servoAdapters/busServo/sendRjMultiPacketBatchTx.test.mjs
 */

import assert from "node:assert/strict"
import { buildMoveOnAngleMode, computeChecksum, toHex } from "../rjsbus/rjSbusPacket.js"
import { REQUEST_HEADER_0, REQUEST_HEADER_1 } from "../rjsbus/rjSbusConstants.js"
import {
  concatRjPackets,
  dedupeRjCommandsLatestWins,
  planRjBatchFromCommands,
  buildRjBatchBytesFromSendable,
  sendRjMultiPacketBatchTx,
} from "./sendRjMultiPacketBatchTx.js"
import { sendBusServoCommandsHybrid } from "./sendBusServoCommandsHybrid.js"
import { sendBusServoCommands } from "./sendBusServoCommands.js"
import {
  resetRjHostMotionState,
  getRjHostMotionState,
  planRjHostMotion,
  commitRjHostMotionSend,
  RJ_MOTION_CONFIG,
  patchRjMotionConfig,
} from "../../output/rjHostMotionAdapter.js"
import { rjSbusTransport } from "../rjsbus/rjSbusWebSerialTransport.js"
import { scServoTransport } from "../scservo/scServoWebSerialTransport.js"
import { groupBusCommandsForSyncWrite } from "./sendBusServoFrameSyncWrite.js"

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
    center: 1500,
    min: 0,
    max: 4095,
    time: 0,
    speed: 0,
  }
}

function scCmd(id, targetPosition) {
  return {
    busServoId: id,
    protocol: "scscl",
    targetPosition,
    busLogical: 500,
    logicalValue: 500,
    time: 0,
    speed: 0,
    profile: scProfile(id),
  }
}

function createMockTransport({ fail = false, throwOnWrite = false } = {}) {
  const writes = []
  return {
    writes,
    getStatus() {
      return { connected: true, supported: true }
    },
    async write(bytes) {
      if (throwOnWrite) {
        throw new Error("mock-transport-throw")
      }
      writes.push(Uint8Array.from(bytes || []))
      if (fail) {
        return { ok: false, reason: "mock-fail" }
      }
      return { ok: true }
    },
  }
}

function splitRjRequestPackets(batchBytes) {
  const bytes = Array.from(batchBytes || [])
  const packets = []
  let i = 0
  while (i < bytes.length) {
    assert.equal(bytes[i], REQUEST_HEADER_0, `header0 @${i}`)
    assert.equal(bytes[i + 1], REQUEST_HEADER_1, `header1 @${i}`)
    const n = bytes[i + 3]
    const len = 4 + n + 1
    const pkt = Uint8Array.from(bytes.slice(i, i + len))
    const expectedCs = computeChecksum(pkt.slice(0, pkt.length - 1))
    assert.equal(pkt[pkt.length - 1], expectedCs, `checksum id≈${pkt[4]}`)
    packets.push(pkt)
    i += len
  }
  return packets
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

const savedCfg = { ...RJ_MOTION_CONFIG }

async function run() {
  patchRjMotionConfig({
    velocityRatio: 0.9,
    defaultVelocityDegS: 400,
    minTimeMs: 20,
    minSendIntervalMs: 20,
  })
  resetRjHostMotionState()

  /* ---------- Test A — RJ Packet Batch concat + checksum ---------- */
  {
    const p1 = buildMoveOnAngleMode(1, { angleTicks: 100, timeMs: 50, power: 600 })
    const p2 = buildMoveOnAngleMode(2, { angleTicks: 200, timeMs: 60, power: 600 })
    const p3 = buildMoveOnAngleMode(3, { angleTicks: 300, timeMs: 70, power: 600 })
    const batch = concatRjPackets([p1, p2, p3])
    assert.equal(batch.length, p1.length + p2.length + p3.length)
    assert.deepEqual(Array.from(batch.slice(0, p1.length)), Array.from(p1))
    assert.deepEqual(Array.from(batch.slice(p1.length, p1.length + p2.length)), Array.from(p2))
    assert.deepEqual(Array.from(batch.slice(p1.length + p2.length)), Array.from(p3))
    const parts = splitRjRequestPackets(batch)
    assert.equal(parts.length, 3)
    assert.equal(toHex(parts[0]), toHex(p1))
    assert.equal(toHex(parts[1]), toHex(p2))
    assert.equal(toHex(parts[2]), toHex(p3))
    console.log("Test A ok")
  }

  /* ---------- Test B — one Host write for 3 RJ ---------- */
  {
    resetRjHostMotionState()
    const transport = createMockTransport()
    const res = await sendRjMultiPacketBatchTx(
      [rjCmd(1, 100), rjCmd(2, 200), rjCmd(3, 300)],
      { transport, nowMs: 10000 }
    )
    assert.equal(res.transportWriteCount, 1)
    assert.equal(transport.writes.length, 1)
    assert.equal(res.commandCount, 3)
    assert.deepEqual(res.sentServoIds.sort((a, b) => a - b), [1, 2, 3])
    const parts = splitRjRequestPackets(transport.writes[0])
    assert.equal(parts.length, 3)
    console.log("Test B ok")
  }

  /* ---------- Test C — one servo still 1 write ---------- */
  {
    resetRjHostMotionState()
    const transport = createMockTransport()
    const res = await sendRjMultiPacketBatchTx([rjCmd(9, 450)], {
      transport,
      nowMs: 20000,
    })
    assert.equal(res.transportWriteCount, 1)
    assert.equal(transport.writes.length, 1)
    assert.equal(res.commandCount, 1)
    assert.deepEqual(res.sentServoIds, [9])
    console.log("Test C ok")
  }

  /* ---------- Test D — latest wins ---------- */
  {
    resetRjHostMotionState()
    const transport = createMockTransport()
    const res = await sendRjMultiPacketBatchTx(
      [rjCmd(1, 111), rjCmd(1, 222), rjCmd(2, 333)],
      { transport, nowMs: 30000 }
    )
    assert.equal(res.commandCount, 2)
    assert.deepEqual(res.sentServoIds.sort((a, b) => a - b), [1, 2])
    const parts = splitRjRequestPackets(transport.writes[0])
    assert.equal(parts.length, 2)
    const ids = parts.map((p) => p[4])
    assert.ok(ids.includes(1) && ids.includes(2))
    const id1 = parts.find((p) => p[4] === 1)
    /* angleTicks 222 little-endian at offset 5..6 */
    const ticks = id1[5] | (id1[6] << 8)
    const signed = ticks > 0x7fff ? ticks - 0x10000 : ticks
    assert.equal(signed, 222)
    const deduped = dedupeRjCommandsLatestWins([
      rjCmd(1, 111),
      rjCmd(1, 222),
      rjCmd(2, 333),
    ])
    assert.equal(deduped.length, 2)
    assert.equal(deduped.find((c) => c.busServoId === 1).targetPosition, 222)
    console.log("Test D ok")
  }

  /* ---------- Test E — per-servo interval ---------- */
  {
    resetRjHostMotionState()
    const transport = createMockTransport()
    /* 先发 ID2，建立 lastSendTime */
    await sendRjMultiPacketBatchTx([rjCmd(2, 50)], { transport, nowMs: 40000 })
    transport.writes.length = 0
    const res = await sendRjMultiPacketBatchTx(
      [rjCmd(1, 100), rjCmd(2, 200), rjCmd(3, 300)],
      { transport, nowMs: 40005 }
    )
    assert.deepEqual(res.sentServoIds.sort((a, b) => a - b), [1, 3])
    assert.ok(res.deferredServoIds.includes(2))
    assert.equal(res.transportWriteCount, 1)
    const parts = splitRjRequestPackets(transport.writes[0])
    assert.equal(parts.length, 2)
    assert.deepEqual(parts.map((p) => p[4]).sort((a, b) => a - b), [1, 3])
    console.log("Test E ok")
  }

  /* ---------- Test F — transport failure does not commit ---------- */
  {
    resetRjHostMotionState()
    const transport = createMockTransport({ throwOnWrite: true })
    const before = getRjHostMotionState(11)
    assert.equal(before.lastSendTime, 0)
    const res = await sendRjMultiPacketBatchTx([rjCmd(11, 400)], {
      transport,
      nowMs: 50000,
    })
    assert.equal(res.ok, false)
    assert.equal(res.transportWriteCount, 0)
    const after = getRjHostMotionState(11)
    assert.equal(after.lastSendTime, 0)
    assert.equal(after.motion, null)

    const failTransport = createMockTransport({ fail: true })
    resetRjHostMotionState(12)
    const res2 = await sendRjMultiPacketBatchTx([rjCmd(12, 400)], {
      transport: failTransport,
      nowMs: 51000,
    })
    assert.equal(res2.ok, false)
    assert.equal(getRjHostMotionState(12).lastSendTime, 0)
    console.log("Test F ok")
  }

  /* ---------- Test G — Face Rig RJ path (single-write + rj-batch) ---------- */
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
    assert.equal(res.rjBatch?.commandCount, 2)
    assert.ok(String(res.txMode).includes("rj-batch"))
    const parts = splitRjRequestPackets(rjTransport.writes[0])
    assert.equal(parts.length, 2)
    /* Motion Adapter 生成 timeMs（非强制 0） */
    for (const item of res.results.filter((r) => r.ok && r.timeMs != null)) {
      assert.ok(item.timeMs >= RJ_MOTION_CONFIG.minTimeMs)
    }
    console.log("Test G ok")
  })

  /* ---------- Test H — Tracking RJ path (hybrid) ---------- */
  await withConnectedPorts(async () => {
    resetRjHostMotionState()
    const rjTransport = createMockTransport()
    const res = await sendBusServoCommands([rjCmd(31, 150), rjCmd(32, 250)], {
      txMode: "hybrid",
      rjTransport,
      transport: createMockTransport(),
      activeFamily: "rj_sbus",
    })
    assert.ok(res.ok, res.error)
    const rjGroup = res.groups?.find((g) => g.protocol === "rj_sbus")
    assert.ok(rjGroup)
    assert.equal(rjGroup.mode, "rj-multi-packet-batch")
    assert.equal(rjGroup.transportWriteCount, 1)
    assert.equal(rjGroup.commandCount, 2)
    assert.equal(rjTransport.writes.length, 1)
    console.log("Test H ok")
  })

  /* ---------- Test I — Mixed RJ + SC/ST ---------- */
  await withConnectedPorts(async () => {
    resetRjHostMotionState()
    const rjTransport = createMockTransport()
    const scTransport = createMockTransport()
    const commands = [
      rjCmd(41, 100),
      rjCmd(42, 200),
      scCmd(43, 1500),
      scCmd(44, 1600),
    ]
    /* SyncWrite 分组应只含 SC，RJ 被拒 */
    const { groups: syncGroups, skipped } = groupBusCommandsForSyncWrite(commands)
    assert.ok(skipped.some((s) => s.reason === "rj-sbus-no-sync-write" || String(s.reason).includes("rj")))
    assert.ok(syncGroups.every((g) => g.protocol === "scscl"))

    const res = await sendBusServoCommandsHybrid(commands, {
      transport: scTransport,
      rjTransport,
      scSyncMode: "sync-inst",
    })
    assert.ok(res.ok, res.error)
    const rjGroup = res.groups.find((g) => g.protocol === "rj_sbus")
    const scGroup = res.groups.find((g) => g.protocol === "scscl")
    assert.ok(rjGroup && scGroup)
    assert.equal(rjGroup.mode, "rj-multi-packet-batch")
    assert.ok(scGroup.mode === "sync-inst" || scGroup.instruction === "0x83")
    assert.equal(rjTransport.writes.length, 1)
    assert.ok(scTransport.writes.length >= 1)
    assert.equal(res.sendModeByBusServoId[41], "rj-multi-packet-batch")
    assert.equal(res.sendModeByBusServoId[42], "rj-multi-packet-batch")
    assert.equal(res.sendModeByBusServoId[43], "sync-inst")
    assert.equal(res.sendModeByBusServoId[44], "sync-inst")
    console.log("Test I ok")
  })

  /* ---------- Test J — Phase 1 regression (selftest core) ---------- */
  {
    resetRjHostMotionState()
    patchRjMotionConfig({
      velocityRatio: 0.9,
      defaultVelocityDegS: 400,
      minTimeMs: 20,
      minSendIntervalMs: 20,
    })
    const p1 = planRjHostMotion({
      servoId: 7,
      targetPosition: 900,
      protocol: "RJ",
      nowMs: 1000,
    })
    assert.equal(p1.ok, true)
    assert.equal(p1.deferred, false)
    assert.equal(p1.timeMs, 250)
    commitRjHostMotionSend(7, p1)
    const p2 = planRjHostMotion({
      servoId: 7,
      targetPosition: 0,
      protocol: "RJ",
      nowMs: 1125,
    })
    assert.ok(Math.abs(p2.currentEstimateDeg - 45) < 0.01)
    console.log("Test J ok")
  }

  /* ---------- Test K — SC SyncWrite grouping regression ---------- */
  {
    const commands = [scCmd(1, 1500), scCmd(2, 1600)]
    const { groups, skipped } = groupBusCommandsForSyncWrite(commands)
    assert.equal(skipped.length, 0, JSON.stringify(skipped))
    assert.equal(groups.length, 1)
    assert.equal(groups[0].protocol, "scscl")
    assert.equal(groups[0].commands.length, 2)
    console.log("Test K ok")
  }

  /* plan helpers smoke */
  {
    resetRjHostMotionState()
    const planned = planRjBatchFromCommands([rjCmd(1, 100), rjCmd(2, 200)], { nowMs: 90000 })
    const built = buildRjBatchBytesFromSendable(planned.sendable)
    assert.equal(built.commandCount, 2)
    assert.ok(built.packetBytes > 0)
  }

  patchRjMotionConfig(savedCfg)
  resetRjHostMotionState()
  console.log("sendRjMultiPacketBatchTx.test: all ok (A–K)")
}

run().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
