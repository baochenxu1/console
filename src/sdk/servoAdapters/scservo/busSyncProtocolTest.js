/**
 * SC / ST 帧同步协议验收（Servo Lab）。
 * SC 复用 scSyncProtocolTest；ST 走 adapter 同路径，便于硬件就绪后统一验收。
 */

import { PROTOCOL } from "../core/servoTypes.js"
import { clampInt } from "../core/servoAdapter.js"
import { SC_POSITION_MAX, SC_POSITION_MIN } from "../core/servoProfile.js"
import { resolveStSyncWriteMotion } from "../busServo/busSyncWriteMotion.js"
import {
  runScSingleWriteBaselineTest,
  runScSyncBroadcastTest,
  runScSyncInst83Test,
  SC_SYNC_TEST_OFFSET_TICKS,
  SC_SYNC_INST_OFFSET_TICKS,
  SC_SYNC_INST_HOLD_MS,
  SC_SYNC_INST_DEFAULT_SPEED,
} from "./scSyncProtocolTest.js"
import { toHex } from "./scPacket.js"
import { normalizeScsclBroadcastId, formatScsclBroadcastId } from "./scProtocolConstants.js"

export {
  SC_SYNC_TEST_OFFSET_TICKS,
  SC_SYNC_INST_OFFSET_TICKS,
  SC_SYNC_INST_HOLD_MS,
}

const ST_POS_MIN = 0
const ST_POS_MAX = 4095

function clampSc(pos) {
  return clampInt(pos, SC_POSITION_MIN, SC_POSITION_MAX)
}

function clampSt(pos) {
  return clampInt(pos, ST_POS_MIN, ST_POS_MAX)
}

function sortIds(idA, idB) {
  return [idA, idB].sort((a, b) => a - b)
}

function makeBusResult(partial) {
  return {
    mode: partial.mode,
    protocol: partial.protocol,
    broadcastId: partial.broadcastId ?? "n/a",
    instruction: partial.instruction ?? null,
    servoIds: partial.servoIds ?? [],
    readPositions: partial.readPositions ?? [],
    targetPositions: partial.targetPositions ?? [],
    actualTxPacketHexList: partial.actualTxPacketHexList ?? [],
    packetHexList: partial.actualTxPacketHexList ?? [],
    writeDurationMs: partial.writeDurationMs ?? 0,
    packetCount: partial.packetCount ?? 0,
    holdMs: partial.holdMs ?? null,
    offsetTicks: partial.offsetTicks ?? null,
    ok: Boolean(partial.ok),
    resultNote: partial.resultNote ?? "",
  }
}

async function enableTorqueIds(adapter, ids, enableTorque) {
  if (typeof enableTorque === "function") {
    for (const id of ids) {
      await enableTorque(id)
    }
    await new Promise((r) => setTimeout(r, 20))
    return
  }
  if (adapter?.enableTorque) {
    for (const id of ids) {
      await adapter.enableTorque(id, true)
    }
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function readCenters({ readPosition, idA, idB, centerA, centerB, clampFn }) {
  let cA = clampFn(centerA)
  let cB = clampFn(centerB)
  if (typeof readPosition === "function") {
    const rA = await readPosition(idA)
    const rB = await readPosition(idB)
    if (rA != null) cA = clampFn(rA)
    if (rB != null) cB = clampFn(rB)
  }
  return { cA, cB }
}

async function runStSingleWriteBaselineTest({
  adapter,
  idA,
  idB,
  centerA,
  centerB,
  offset = SC_SYNC_TEST_OFFSET_TICKS,
  enableTorque,
  readPosition,
}) {
  const servoIds = sortIds(idA, idB)
  const { cA, cB } = await readCenters({
    readPosition,
    idA,
    idB,
    centerA,
    centerB,
    clampFn: clampSt,
  })
  const oA = clampSt(cA + offset)
  const oB = clampSt(cB + offset)
  const motion = resolveStSyncWriteMotion({ speed: 0, acc: 0 })

  const result = makeBusResult({
    mode: "single-write",
    protocol: PROTOCOL.SMS_STS,
    broadcastId: "n/a",
    servoIds,
    targetPositions: [cA, oA, cA, cB, oB, cB],
    resultNote: "ST Baseline 0x03：按 ID 升序 center→offset→center",
  })

  const actualTxPacketHexList = []
  const startMs = Date.now()

  await enableTorqueIds(adapter, servoIds, enableTorque)

  const sequence = [
    { id: idA, positions: [cA, oA, cA] },
    { id: idB, positions: [cB, oB, cB] },
  ].sort((a, b) => a.id - b.id)

  for (const step of sequence) {
    for (const pos of step.positions) {
      const res = await adapter.writePosition(step.id, pos, {
        speed: motion.speed,
        acc: motion.acc,
        waitAck: false,
      })
      if (res.txBytes?.length) {
        actualTxPacketHexList.push(toHex(new Uint8Array(res.txBytes)))
      }
      if (!res.ok) {
        result.actualTxPacketHexList = actualTxPacketHexList
        result.packetCount = actualTxPacketHexList.length
        result.writeDurationMs = Date.now() - startMs
        result.resultNote = `串口写出失败 #${step.id}: ${res.error || "fail"}`
        return result
      }
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  result.actualTxPacketHexList = actualTxPacketHexList
  result.packetCount = actualTxPacketHexList.length
  result.writeDurationMs = Date.now() - startMs
  result.ok = true
  result.resultNote = "ST single-write 成功；请目视确认两台是否依次动作"
  return result
}

async function runStSyncInstTest({
  adapter,
  idA,
  idB,
  centerA,
  centerB,
  offset = SC_SYNC_INST_OFFSET_TICKS,
  holdMs = SC_SYNC_INST_HOLD_MS,
  enableTorque,
  readPosition,
}) {
  const servoIds = sortIds(idA, idB)
  const { cA, cB } = await readCenters({
    readPosition,
    idA,
    idB,
    centerA,
    centerB,
    clampFn: clampSt,
  })
  const oA = clampSt(cA + offset)
  const oB = clampSt(cB + offset)
  const motion = resolveStSyncWriteMotion({ speed: 0, acc: 0 })

  const result = makeBusResult({
    mode: "sync-inst",
    protocol: PROTOCOL.SMS_STS,
    broadcastId: "0xFF",
    instruction: "0x83",
    servoIds,
    readPositions: [cA, cB],
    targetPositions: [oA, oB, cA, cB],
    offsetTicks: offset,
    holdMs,
    resultNote: "ST SYNC_WRITE 0x83 · 2 phase",
  })

  const actualTxPacketHexList = []
  const startMs = Date.now()
  const errors = []

  await enableTorqueIds(adapter, servoIds, enableTorque)

  const mkCmd = (id, position) => ({
    id,
    position,
    speed: motion.speed,
    acc: motion.acc,
  })

  const phase1 = await adapter.syncWritePositions([mkCmd(idA, oA), mkCmd(idB, oB)], {
    mode: "sync-inst",
  })
  if (phase1.txBytes?.length) {
    actualTxPacketHexList.push(toHex(new Uint8Array(phase1.txBytes)))
  }
  if (!phase1.ok) {
    errors.push(`phase1: ${phase1.error || "fail"}`)
  }

  if (!errors.length) {
    await new Promise((r) => setTimeout(r, Math.max(100, holdMs)))
    const phase2 = await adapter.syncWritePositions([mkCmd(idA, cA), mkCmd(idB, cB)], {
      mode: "sync-inst",
    })
    if (phase2.txBytes?.length) {
      actualTxPacketHexList.push(toHex(new Uint8Array(phase2.txBytes)))
    }
    if (!phase2.ok) {
      errors.push(`phase2: ${phase2.error || "fail"}`)
    }
  }

  result.actualTxPacketHexList = actualTxPacketHexList
  result.packetCount = actualTxPacketHexList.length
  result.writeDurationMs = Date.now() - startMs
  result.ok = errors.length === 0 && actualTxPacketHexList.length === 2
  result.resultNote = errors.length
    ? errors.join("; ")
    : `ST SYNC_WRITE 0x83 · read=[${cA},${cB}] offset=+${offset} hold=${holdMs}ms · ` +
      `speed=${motion.speed} acc=${motion.acc} · packetCount=2 · 请目视确认是否同时动作`
  return result
}

async function runStRegActionTest({
  adapter,
  idA,
  idB,
  centerA,
  centerB,
  offset = SC_SYNC_TEST_OFFSET_TICKS,
  holdMs = SC_SYNC_INST_HOLD_MS,
  enableTorque,
  readPosition,
}) {
  const servoIds = sortIds(idA, idB)
  const { cA, cB } = await readCenters({
    readPosition,
    idA,
    idB,
    centerA,
    centerB,
    clampFn: clampSt,
  })
  const oA = clampSt(cA + offset)
  const oB = clampSt(cB + offset)
  const motion = resolveStSyncWriteMotion({ speed: 0, acc: 0 })

  const result = makeBusResult({
    mode: "reg-action",
    protocol: PROTOCOL.SMS_STS,
    broadcastId: "0xFF",
    servoIds,
    targetPositions: [oA, oB, cA, cB],
    resultNote: "ST RegAction：offset → 回位",
  })

  const actualTxPacketHexList = []
  const startMs = Date.now()
  const errors = []

  await enableTorqueIds(adapter, servoIds, enableTorque)

  const mkCmd = (id, position) => ({
    id,
    position,
    speed: motion.speed,
    acc: motion.acc,
  })

  const pushTx = (res) => {
    if (Array.isArray(res.txBytes?.[0])) {
      for (const row of res.txBytes) {
        if (row?.length) actualTxPacketHexList.push(toHex(new Uint8Array(row)))
      }
    } else if (res.txBytes?.length) {
      actualTxPacketHexList.push(toHex(new Uint8Array(res.txBytes)))
    }
  }

  const p1 = await adapter.syncWritePositions([mkCmd(idA, oA), mkCmd(idB, oB)], {
    mode: "reg-action",
  })
  pushTx(p1)
  if (!p1.ok) errors.push(`phase1: ${p1.error || "fail"}`)

  if (!errors.length) {
    await new Promise((r) => setTimeout(r, Math.max(200, holdMs / 2)))
    const p2 = await adapter.syncWritePositions([mkCmd(idA, cA), mkCmd(idB, cB)], {
      mode: "reg-action",
    })
    pushTx(p2)
    if (!p2.ok) errors.push(`phase2: ${p2.error || "fail"}`)
  }

  result.actualTxPacketHexList = actualTxPacketHexList
  result.packetCount = actualTxPacketHexList.length
  result.writeDurationMs = Date.now() - startMs
  result.ok = errors.length === 0
  result.resultNote = errors.length
    ? errors.join("; ")
    : `ST RegAction · read=[${cA},${cB}] offset=+${offset} · ${actualTxPacketHexList.length} 包`
  return result
}

/**
 * @param {'baseline' | 'sync-inst-fe' | 'reg-action-fe' | 'reg-action-ff'} kind
 * @param {object} options
 * @param {string} options.protocol PROTOCOL.SCSCL | PROTOCOL.SMS_STS
 * @param {object} options.transport
 * @param {object} [options.adapter] ST 测试需要
 */
export async function runBusSyncProtocolTest(kind, options) {
  const protocol = options.protocol === PROTOCOL.SMS_STS ? PROTOCOL.SMS_STS : PROTOCOL.SCSCL
  const {
    transport,
    adapter,
    idA,
    idB,
    centerA,
    centerB,
    offset,
    holdMs,
    enableTorque,
    readPosition,
  } = options

  if (protocol === PROTOCOL.SMS_STS) {
    if (!adapter) {
      return makeBusResult({
        mode: kind,
        protocol,
        ok: false,
        resultNote: "ST 测试需要 adapter",
      })
    }
    const common = {
      adapter,
      idA,
      idB,
      centerA,
      centerB,
      offset: offset ?? SC_SYNC_INST_OFFSET_TICKS,
      holdMs: holdMs ?? SC_SYNC_INST_HOLD_MS,
      enableTorque,
      readPosition,
    }
    if (kind === "baseline") {
      return runStSingleWriteBaselineTest({
        ...common,
        offset: SC_SYNC_TEST_OFFSET_TICKS,
      })
    }
    if (kind === "sync-inst-fe") {
      return runStSyncInstTest(common)
    }
    if (kind === "reg-action-fe" || kind === "reg-action-ff") {
      return runStRegActionTest({
        ...common,
        offset: SC_SYNC_TEST_OFFSET_TICKS,
      })
    }
    return makeBusResult({ mode: kind, protocol, ok: false, resultNote: `未知测试项：${kind}` })
  }

  const common = {
    transport,
    idA,
    idB,
    centerA,
    centerB,
    enableTorque,
    readPosition,
  }

  if (kind === "baseline") {
    return runScSingleWriteBaselineTest(common)
  }
  if (kind === "sync-inst-fe") {
    return runScSyncInst83Test({
      ...common,
      broadcastId: 0xfe,
      offset: offset ?? SC_SYNC_INST_OFFSET_TICKS,
      holdMs: holdMs ?? SC_SYNC_INST_HOLD_MS,
      speed: SC_SYNC_INST_DEFAULT_SPEED,
    })
  }
  if (kind === "reg-action-fe") {
    return runScSyncBroadcastTest({
      ...common,
      mode: "reg-action",
      broadcastId: 0xfe,
      offset: SC_SYNC_TEST_OFFSET_TICKS,
      holdMs: holdMs ?? SC_SYNC_INST_HOLD_MS,
    })
  }
  if (kind === "reg-action-ff") {
    return runScSyncBroadcastTest({
      ...common,
      mode: "reg-action",
      broadcastId: 0xff,
      offset: SC_SYNC_TEST_OFFSET_TICKS,
      holdMs: holdMs ?? SC_SYNC_INST_HOLD_MS,
    })
  }

  return makeBusResult({
    mode: kind,
    protocol,
    ok: false,
    resultNote: `未知测试项：${kind}`,
  })
}

export function describeSyncTestKind(kind, protocol) {
  const isSt = protocol === PROTOCOL.SMS_STS
  const syncAddr = isSt ? "0x83 29 07" : "0x83 2A 06"
  switch (kind) {
    case "baseline":
      return "1. Single Write 0x03 Baseline"
    case "sync-inst-fe":
      return `2. SyncInst ${syncAddr} @ 0xFE${isSt ? "（ST 用 0xFF）" : ""}`
    case "reg-action-fe":
      return "3a. RegAction @ 0xFE"
    case "reg-action-ff":
      return "3b. RegAction @ 0xFF（对照）"
    default:
      return kind
  }
}

export function formatSyncBroadcastHint(protocol, broadcastId = 0xfe) {
  if (protocol === PROTOCOL.SMS_STS) {
    return "ST：SyncWrite 广播 0xFF（SDK 默认）"
  }
  return `SC：SyncWrite 广播 ${formatScsclBroadcastId(normalizeScsclBroadcastId(broadcastId))}`
}
