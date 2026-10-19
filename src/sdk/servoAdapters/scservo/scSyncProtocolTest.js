/**
 * SC 同步写协议最小验证（ScServo Lab）。
 * 字节序与 single-write 一致；仅 broadcastId / 指令类型可变。
 */

import { clampInt } from "../core/servoAdapter.js"
import { SC_POSITION_MAX, SC_POSITION_MIN } from "../core/servoProfile.js"
import { resolveScSyncWriteMotion } from "../busServo/busSyncWriteMotion.js"
import { encodeScPositionData } from "./scServoCodec.js"
import {
  buildAction,
  buildRegWrite,
  buildSyncWrite,
  buildWrite,
  formatPacketChecksum,
  toHex,
} from "./scPacket.js"
import {
  SC_REG,
  SC_SYNC_WRITE_DATA_LENGTH,
  SC_SYNC_WRITE_START,
  formatScsclBroadcastId,
  normalizeScsclBroadcastId,
} from "./scProtocolConstants.js"

export const SC_SYNC_TEST_OFFSET_TICKS = 30
/** 真同步写 0x83 默认 offset（tick） */
export const SC_SYNC_INST_OFFSET_TICKS = 60
export const SC_SYNC_INST_HOLD_MS = 800
export const SC_SYNC_INST_DEFAULT_SPEED = 2400

const REG_ACTION_PHASE_GAP_MS = 400

function isSyncWrite83Hex(hex) {
  const p = String(hex).split(" ")
  return p.length >= 7 && p[4] === "83" && p[5] === "2A" && p[6] === "06"
}

function verifySyncInst83Packet(hex, bid) {
  const p = String(hex).split(" ")
  const bidHex = (bid & 0xff).toString(16).toUpperCase().padStart(2, "0")
  if (!isSyncWrite83Hex(hex)) {
    return { ok: false, note: "非 0x83 2A 06 SYNC_WRITE" }
  }
  if (p[2] !== bidHex) {
    return { ok: false, note: `broadcast 0x${p[2]} 期望 0x${bidHex}` }
  }
  if (p[3] !== "12") {
    return { ok: false, note: `LENGTH 0x${p[3]} 期望 0x12（2 舵机 × 7 + 4）` }
  }
  return { ok: true }
}

function isRegWriteHex(hex) {
  const p = String(hex).split(" ")
  return p.length >= 6 && p[4] === "04"
}

function isActionHex(hex) {
  const p = String(hex).split(" ")
  return p.length >= 6 && p[3] === "02" && p[4] === "05"
}

function verifyRegActionTxOrder(actualList) {
  const actionIdx = actualList.map((h, i) => (isActionHex(h) ? i : -1)).filter((i) => i >= 0)
  if (!actionIdx.length) return { ok: false, note: "无 ACTION 包", actionIndices: [] }

  let pos = 0
  for (const ai of actionIdx) {
    let regCount = 0
    while (pos < ai) {
      if (!isRegWriteHex(actualList[pos])) {
        return {
          ok: false,
          note: `index ${pos} 期望 REG_WRITE(04)，实际: ${actualList[pos]}`,
          actionIndices: actionIdx,
        }
      }
      regCount += 1
      pos += 1
    }
    if (regCount < 1) {
      return { ok: false, note: `ACTION@${ai} 前无 REG_WRITE`, actionIndices: actionIdx }
    }
    pos = ai + 1
  }

  while (pos < actualList.length) {
    if (!isRegWriteHex(actualList[pos])) {
      return { ok: false, note: `ACTION 后 index ${pos} 非 REG_WRITE`, actionIndices: actionIdx }
    }
    pos += 1
  }

  return { ok: true, actionIndices: actionIdx }
}

/** @typedef {'single-write' | 'sync-inst' | 'reg-action'} ScSyncTestMode */

/**
 * @param {object} partial
 * @returns {object}
 */
function makeSyncTestResult(partial) {
  const actual = partial.actualTxPacketHexList ?? partial.packetHexList ?? []
  return {
    mode: partial.mode,
    protocol: "scscl",
    broadcastId: partial.broadcastId ?? "n/a",
    instruction: partial.instruction ?? null,
    startAddress: partial.startAddress ?? "0x2A",
    dataLength: partial.dataLength ?? 6,
    servoIds: partial.servoIds ?? [],
    readPositions: partial.readPositions ?? [],
    targetPositions: partial.targetPositions ?? [],
    byteOrder: "same-as-single-write",
    plannedPacketHexList: partial.plannedPacketHexList ?? actual,
    actualTxPacketHexList: actual,
    packetHexList: actual,
    checksumList: partial.checksumList ?? [],
    actionPacketIndex: partial.actionPacketIndex ?? null,
    holdMs: partial.holdMs ?? null,
    offsetTicks: partial.offsetTicks ?? null,
    writeDurationMs: partial.writeDurationMs ?? 0,
    expectedAck: false,
    resultNote: partial.resultNote ?? "",
    ok: Boolean(partial.ok),
    packetCount: partial.packetCount ?? actual.length,
  }
}

function clampScPosition(pos) {
  return clampInt(pos, SC_POSITION_MIN, SC_POSITION_MAX)
}

function sortItemsById(items) {
  return [...items].sort((a, b) => a.id - b.id)
}

/**
 * @param {object} transport
 * @param {Uint8Array} tx
 * @param {string[]} plannedList
 * @param {string[]} checksumList
 * @param {string[]} actualList
 */
async function transmitPacket(transport, tx, plannedList, checksumList, actualList) {
  plannedList.push(toHex(tx))
  checksumList.push(formatPacketChecksum(tx))
  return transport.write(tx, { force: true, txCapture: actualList })
}

function scMotionPayload(position, { speed = 0, time = 0 } = {}) {
  const motion = resolveScSyncWriteMotion({ time, speed })
  return encodeScPositionData({
    position: clampScPosition(position),
    time: motion.time,
    speed: motion.speed,
  })
}

/**
 * @param {object} options
 * @param {object} options.transport
 * @param {number} options.idA
 * @param {number} options.idB
 * @param {number} options.centerA
 * @param {number} options.centerB
 * @param {number} [options.offset]
 * @param {(id:number)=>Promise<void>} [options.enableTorque]
 */
export async function runScSingleWriteBaselineTest({
  transport,
  idA,
  idB,
  centerA,
  centerB,
  offset = SC_SYNC_TEST_OFFSET_TICKS,
  speed = 0,
  time = 0,
  enableTorque,
  readPosition,
}) {
  const servoIds = sortItemsById([{ id: idA }, { id: idB }]).map((x) => x.id)
  let cA = clampScPosition(centerA)
  let cB = clampScPosition(centerB)

  if (typeof readPosition === "function") {
    const rA = await readPosition(idA)
    const rB = await readPosition(idB)
    if (rA != null) cA = clampScPosition(rA)
    if (rB != null) cB = clampScPosition(rB)
  }

  const oA = clampScPosition(cA + offset)
  const oB = clampScPosition(cB + offset)

  const result = makeSyncTestResult({
    mode: "single-write",
    broadcastId: "n/a",
    servoIds,
    targetPositions: [cA, oA, cA, cB, oB, cB],
    resultNote: "Baseline 0x03：按 ID 升序 center→offset→center",
  })

  const plannedPacketHexList = []
  const actualTxPacketHexList = []
  const checksumList = []
  const startMs = Date.now()

  if (typeof enableTorque === "function") {
    for (const id of servoIds) {
      await enableTorque(id)
    }
    await new Promise((r) => setTimeout(r, 20))
  }

  const sequence = sortItemsById([
    { id: idA, positions: [cA, oA, cA] },
    { id: idB, positions: [cB, oB, cB] },
  ])

  for (const step of sequence) {
    for (const pos of step.positions) {
      const data = scMotionPayload(pos, { speed, time })
      const tx = buildWrite(step.id, SC_REG.GOAL_POSITION_L, data)
      const w = await transmitPacket(
        transport,
        tx,
        plannedPacketHexList,
        checksumList,
        actualTxPacketHexList
      )
      if (!w.ok) {
        result.plannedPacketHexList = plannedPacketHexList
        result.actualTxPacketHexList = actualTxPacketHexList
        result.packetHexList = actualTxPacketHexList
        result.checksumList = checksumList
        result.writeDurationMs = Date.now() - startMs
        result.packetCount = actualTxPacketHexList.length
        result.resultNote = `串口写出失败 #${step.id}: ${w.error || w.reason || "fail"}`
        return result
      }
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  result.plannedPacketHexList = plannedPacketHexList
  result.actualTxPacketHexList = actualTxPacketHexList
  result.packetHexList = actualTxPacketHexList
  result.checksumList = checksumList
  result.writeDurationMs = Date.now() - startMs
  result.packetCount = actualTxPacketHexList.length
  result.ok = true
  result.resultNote =
    "串口写出成功；actualTxPacketHexList 为真实发送顺序（非 Raw 日志倒序）"
  return result
}

async function runRegActionPhase({
  transport,
  bid,
  items,
  plannedPacketHexList,
  actualTxPacketHexList,
  checksumList,
}) {
  const errors = []
  const sorted = sortItemsById(items)

  for (const item of sorted) {
    const tx = buildRegWrite(item.id, SC_REG.GOAL_POSITION_L, item.data)
    const w = await transmitPacket(
      transport,
      tx,
      plannedPacketHexList,
      checksumList,
      actualTxPacketHexList
    )
    if (!w.ok) {
      errors.push(`REG_WRITE #${item.id}: ${w.error || w.reason || "fail"}`)
    }
  }

  if (!errors.length) {
    const actionTx = buildAction(bid)
    const aw = await transmitPacket(
      transport,
      actionTx,
      plannedPacketHexList,
      checksumList,
      actualTxPacketHexList
    )
    if (!aw.ok) {
      errors.push(`ACTION: ${aw.error || aw.reason || "fail"}`)
    }
  }

  return errors
}

async function transmitSyncInst83Packet({
  transport,
  bid,
  items,
  speed,
  time,
  plannedPacketHexList,
  actualTxPacketHexList,
  checksumList,
}) {
  const sorted = sortItemsById(
    items.map((item) => ({
      id: item.id,
      data: scMotionPayload(item.position, { speed, time }),
    }))
  )
  const tx = buildSyncWrite(SC_SYNC_WRITE_START, SC_SYNC_WRITE_DATA_LENGTH, sorted, bid)
  return transmitPacket(transport, tx, plannedPacketHexList, checksumList, actualTxPacketHexList)
}

/**
 * SC 真同步写 0x83：读位置 → offset 一包 → hold → 回位一包。
 * @param {object} options
 */
export async function runScSyncInst83Test({
  transport,
  broadcastId = 0xfe,
  idA,
  idB,
  centerA,
  centerB,
  offset = SC_SYNC_INST_OFFSET_TICKS,
  holdMs = SC_SYNC_INST_HOLD_MS,
  speed = SC_SYNC_INST_DEFAULT_SPEED,
  time = 0,
  enableTorque,
  readPosition,
}) {
  const bid = normalizeScsclBroadcastId(broadcastId)
  const servoIds = sortItemsById([{ id: idA }, { id: idB }]).map((x) => x.id)

  let posA = clampScPosition(centerA)
  let posB = clampScPosition(centerB)
  if (typeof readPosition === "function") {
    const rA = await readPosition(idA)
    const rB = await readPosition(idB)
    if (rA != null) posA = clampScPosition(rA)
    if (rB != null) posB = clampScPosition(rB)
  }

  const offsetA = clampScPosition(posA + offset)
  const offsetB = clampScPosition(posB + offset)

  const result = makeSyncTestResult({
    mode: "sync-inst",
    broadcastId: formatScsclBroadcastId(bid),
    instruction: "0x83",
    servoIds,
    readPositions: [posA, posB],
    targetPositions: [offsetA, offsetB, posA, posB],
    offsetTicks: offset,
    holdMs,
    resultNote: `SYNC_WRITE 0x83 · 2 phase · packetCount=2`,
  })

  const plannedPacketHexList = []
  const actualTxPacketHexList = []
  const checksumList = []
  const startMs = Date.now()
  const errors = []

  if (typeof enableTorque === "function") {
    for (const id of servoIds) {
      await enableTorque(id)
    }
    await new Promise((r) => setTimeout(r, 20))
  }

  const w1 = await transmitSyncInst83Packet({
    transport,
    bid,
    items: [
      { id: idA, position: offsetA },
      { id: idB, position: offsetB },
    ],
    speed,
    time,
    plannedPacketHexList,
    actualTxPacketHexList,
    checksumList,
  })
  if (!w1.ok) {
    errors.push(`phase1 offset: ${w1.error || w1.reason || "fail"}`)
  } else {
    const v1 = verifySyncInst83Packet(actualTxPacketHexList[0], bid)
    if (!v1.ok) errors.push(`phase1 packet: ${v1.note}`)
  }

  if (!errors.length) {
    await new Promise((r) => setTimeout(r, Math.max(100, holdMs)))
    const w2 = await transmitSyncInst83Packet({
      transport,
      bid,
      items: [
        { id: idA, position: posA },
        { id: idB, position: posB },
      ],
      speed,
      time,
      plannedPacketHexList,
      actualTxPacketHexList,
      checksumList,
    })
    if (!w2.ok) {
      errors.push(`phase2 return: ${w2.error || w2.reason || "fail"}`)
    } else {
      const v2 = verifySyncInst83Packet(actualTxPacketHexList[1], bid)
      if (!v2.ok) errors.push(`phase2 packet: ${v2.note}`)
    }
  }

  result.plannedPacketHexList = plannedPacketHexList
  result.actualTxPacketHexList = actualTxPacketHexList
  result.packetHexList = actualTxPacketHexList
  result.checksumList = checksumList
  result.writeDurationMs = Date.now() - startMs
  result.packetCount = actualTxPacketHexList.length
  result.ok = errors.length === 0 && actualTxPacketHexList.length === 2

  result.resultNote = errors.length
    ? errors.join("; ")
    : `SYNC_WRITE 0x83 broadcast ${formatScsclBroadcastId(bid)} · ` +
      `read=[${posA},${posB}] offset=+${offset} hold=${holdMs}ms · ` +
      `packetCount=2 · 请目视确认两台是否同时动作`

  return result
}

/**
 * @param {object} options
 * @param {'reg-action' | 'sync-inst'} options.mode
 * @param {number} [options.broadcastId]
 * @param {(id:number)=>Promise<number|null>} [options.readPosition]
 */
export async function runScSyncBroadcastTest({
  transport,
  mode,
  broadcastId,
  idA,
  idB,
  centerA,
  centerB,
  offset = SC_SYNC_TEST_OFFSET_TICKS,
  holdMs = SC_SYNC_INST_HOLD_MS,
  speed = 0,
  time = 0,
  enableTorque,
  readPosition,
}) {
  if (mode === "sync-inst") {
    return runScSyncInst83Test({
      transport,
      broadcastId,
      idA,
      idB,
      centerA,
      centerB,
      offset: offset ?? SC_SYNC_INST_OFFSET_TICKS,
      holdMs,
      speed: speed || SC_SYNC_INST_DEFAULT_SPEED,
      time,
      enableTorque,
      readPosition,
    })
  }

  const bid = normalizeScsclBroadcastId(broadcastId)
  const servoIds = sortItemsById([{ id: idA }, { id: idB }]).map((x) => x.id)

  let posA = clampScPosition(centerA)
  let posB = clampScPosition(centerB)
  if (typeof readPosition === "function") {
    const rA = await readPosition(idA)
    const rB = await readPosition(idB)
    if (rA != null) posA = clampScPosition(rA)
    if (rB != null) posB = clampScPosition(rB)
  }

  const offsetA = clampScPosition(posA + offset)
  const offsetB = clampScPosition(posB + offset)

  const result = makeSyncTestResult({
    mode,
    broadcastId: formatScsclBroadcastId(bid),
    servoIds,
    targetPositions:
      mode === "reg-action"
        ? [offsetA, offsetB, posA, posB]
        : [offsetA, offsetB],
    resultNote:
      mode === "reg-action"
        ? `REG_WRITE(ID asc) → ACTION last · broadcast ${formatScsclBroadcastId(bid)} · offset+return`
        : `SYNC_WRITE broadcast ${formatScsclBroadcastId(bid)}`,
  })

  const plannedPacketHexList = []
  const actualTxPacketHexList = []
  const checksumList = []
  const startMs = Date.now()

  if (typeof enableTorque === "function") {
    for (const id of servoIds) {
      await enableTorque(id)
    }
    await new Promise((r) => setTimeout(r, 20))
  }

  const errors = []

  const phase1Errors = await runRegActionPhase({
    transport,
    bid,
    items: [
      { id: idA, data: scMotionPayload(offsetA, { speed, time }) },
      { id: idB, data: scMotionPayload(offsetB, { speed, time }) },
    ],
    plannedPacketHexList,
    actualTxPacketHexList,
    checksumList,
  })
  errors.push(...phase1Errors)

  if (!phase1Errors.length) {
    await new Promise((r) => setTimeout(r, REG_ACTION_PHASE_GAP_MS))
    const phase2Errors = await runRegActionPhase({
      transport,
      bid,
      items: [
        { id: idA, data: scMotionPayload(posA, { speed, time }) },
        { id: idB, data: scMotionPayload(posB, { speed, time }) },
      ],
      plannedPacketHexList,
      actualTxPacketHexList,
      checksumList,
    })
    errors.push(...phase2Errors)
  }

  const orderCheck = verifyRegActionTxOrder(actualTxPacketHexList)
  const actionIndices = orderCheck.actionIndices ?? []

  result.plannedPacketHexList = plannedPacketHexList
  result.actualTxPacketHexList = actualTxPacketHexList
  result.packetHexList = actualTxPacketHexList
  result.checksumList = checksumList
  result.writeDurationMs = Date.now() - startMs
  result.packetCount = actualTxPacketHexList.length
  result.actionPacketIndex =
    actionIndices.length === 1 && actionIndices[0] === actualTxPacketHexList.length - 1
      ? "last"
      : actionIndices.join(",")

  result.ok = errors.length === 0 && orderCheck.ok

  result.resultNote = errors.length
    ? errors.join("; ")
    : `ACTION must be last · 阶段1 offset(+${offset}) → 阶段2 回位 · ` +
      `readPos=[${posA},${posB}] · actualTx ${actualTxPacketHexList.length}包` +
      (orderCheck.ok
        ? ` · action@${result.actionPacketIndex}`
        : ` · 顺序异常: ${orderCheck.note}`)

  return result
}
