import { clampInt, isValidServoId } from "../core/servoAdapter.js"
import { PROTOCOL } from "../core/servoTypes.js"
import { buildAction, buildRegWrite } from "../scservo/scPacket.js"
import {
  BROADCAST_ID,
  SC_REG,
  ST_REG,
  normalizeScsclBroadcastId,
} from "../scservo/scProtocolConstants.js"
import { bytesToHex } from "./busServoTxUtil.js"
import { buildBusSyncWriteItemFromCommand } from "./buildBusSyncWriteItem.js"
import { sendBusServoFrameSyncWrite } from "./sendBusServoFrameSyncWrite.js"

function coerceId(id) {
  const n = Math.round(Number(id))
  return Number.isFinite(n) ? n : NaN
}

/**
 * 官方 RegWritePos + RegAction 同步写（部分固件对 0x83 SyncWrite 不响应，此路径更兼容）。
 * @param {object[]} commands guard 后 bus commands
 * @param {{ transport: object }} options
 */
export async function sendBusRegActionSyncWrite(commands, options = {}) {
  const transport = options.transport
  const scBroadcastId = normalizeScsclBroadcastId(options.scsclBroadcastId ?? BROADCAST_ID)
  const list = Array.isArray(commands) ? commands : []
  const startMs = Date.now()
  const errors = []
  const packetHexParts = []
  const actualTxPacketHexList = []
  let regWriteCount = 0
  const sentServoIds = []
  const skipped = []

  const sorted = [...list].sort((a, b) => coerceId(a.busServoId) - coerceId(b.busServoId))
  let hasSc = false
  let hasSt = false

  for (const cmd of sorted) {
    const built = buildBusSyncWriteItemFromCommand(cmd)
    if (!built.ok) {
      skipped.push({
        actuatorKey: cmd?.actuatorKey ?? null,
        busServoId: cmd?.busServoId ?? null,
        reason: built.reason,
      })
      continue
    }
    if (!isValidServoId(built.id)) {
      skipped.push({ busServoId: built.id, reason: "invalid-bus-id" })
      continue
    }

    if (built.protocol === PROTOCOL.SMS_STS) {
      hasSt = true
    } else {
      hasSc = true
    }

    const address =
      built.protocol === PROTOCOL.SMS_STS ? ST_REG.ACC : SC_REG.GOAL_POSITION_L
    const tx = buildRegWrite(built.id, address, built.data)
    const w = await transport.write(tx, { force: true, txCapture: actualTxPacketHexList })
    if (!w.ok) {
      errors.push(`REG_WRITE #${built.id}: ${w.error || w.reason || "fail"}`)
      continue
    }
    regWriteCount += 1
    sentServoIds.push(built.id)
    packetHexParts.push(bytesToHex(tx))
  }

  const actionBroadcastId = hasSc && !hasSt ? scBroadcastId : BROADCAST_ID

  if (regWriteCount > 0) {
    const actionTx = buildAction(actionBroadcastId)
    const aw = await transport.write(actionTx, { force: true, txCapture: actualTxPacketHexList })
    if (aw.ok) {
      packetHexParts.push(bytesToHex(actionTx))
    } else {
      errors.push(`ACTION: ${aw.error || aw.reason || "fail"}`)
    }
  }

  const writeDurationMs = Date.now() - startMs
  const packetHex = packetHexParts.join(" | ")
  const packetCount = regWriteCount > 0 ? regWriteCount + (errors.some((e) => e.startsWith("ACTION")) ? 0 : 1) : 0

  return {
    ok: errors.length === 0 && regWriteCount > 0,
    sent: regWriteCount,
    commandCount: regWriteCount,
    packetCount,
    regWriteCount,
    sentServoIds,
    skipped,
    errors,
    error: errors.join("; "),
    txMode: "reg-action",
    broadcastId: actionBroadcastId,
    writeDurationMs,
    packetHex,
    plannedPacketHexList: packetHexParts,
    actualTxPacketHexList,
    lastTxPacketHex: packetHexParts[packetHexParts.length - 1] || "",
  }
}

/**
 * @param {object[]} commands
 * @param {{ transport: object, syncMode?: 'sync-inst' | 'reg-action', scsclBroadcastId?: number }} options
 */
export async function sendBusSyncWriteFrame(commands, options = {}) {
  const syncMode = options.syncMode ?? "reg-action"
  if (syncMode === "sync-inst") {
    return sendBusServoFrameSyncWrite(commands, options)
  }
  return sendBusRegActionSyncWrite(commands, options)
}
