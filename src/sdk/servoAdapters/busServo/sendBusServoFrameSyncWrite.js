import { PROTOCOL } from "../core/servoTypes.js"
import { buildSyncWrite } from "../scservo/scPacket.js"
import {
  SC_SYNC_WRITE_DATA_LENGTH,
  SC_SYNC_WRITE_START,
  ST_SYNC_WRITE_DATA_LENGTH,
  ST_SYNC_WRITE_START,
  normalizeScsclBroadcastId,
  BROADCAST_ID,
} from "../scservo/scProtocolConstants.js"
import { scServoTransport } from "../scservo/scServoWebSerialTransport.js"
import { bytesToHex } from "./busServoTxUtil.js"
import {
  buildBusSyncWriteItemFromCommand,
  resolveBusCommandProtocol,
} from "./buildBusSyncWriteItem.js"

function isForbiddenBusId(id) {
  const n = Math.round(Number(id))
  return !Number.isFinite(n) || n <= 0
}

function resolveSyncWriteGroupMeta(protocol) {
  if (protocol === PROTOCOL.SMS_STS) {
    return {
      positionAddress: ST_SYNC_WRITE_START,
      positionByteLength: ST_SYNC_WRITE_DATA_LENGTH,
      speedTimeMode: "acc-pos-speed",
    }
  }
  return {
    positionAddress: SC_SYNC_WRITE_START,
    positionByteLength: SC_SYNC_WRITE_DATA_LENGTH,
    speedTimeMode: "pos-time-speed",
  }
}

function buildGroupKey(protocol) {
  const meta = resolveSyncWriteGroupMeta(protocol)
  return `${protocol}:${meta.positionAddress}:${meta.positionByteLength}:${meta.speedTimeMode}`
}

/**
 * 按官方 scscl.py / sms_sts.py 的 SyncWrite 寄存器布局分组；同 ID 保留最后一项。
 * @param {object[]} commands
 */
export function groupBusCommandsForSyncWrite(commands) {
  const groups = new Map()
  const skipped = []
  const duplicateIds = []

  for (const cmd of commands || []) {
    const built = buildBusSyncWriteItemFromCommand(cmd)
    if (!built.ok) {
      skipped.push({
        actuatorKey: cmd?.actuatorKey ?? null,
        busServoId: cmd?.busServoId ?? null,
        reason: built.reason,
      })
      continue
    }

    const groupKey = buildGroupKey(built.protocol)
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        groupKey,
        protocol: built.protocol,
        itemsById: new Map(),
      })
    }
    const group = groups.get(groupKey)
    if (group.itemsById.has(built.id)) {
      duplicateIds.push({ busServoId: built.id, actuatorKey: built.actuatorKey })
    }
    group.itemsById.set(built.id, built)
  }

  const grouped = [...groups.values()].map((g) => ({
    groupKey: g.groupKey,
    protocol: g.protocol,
    commands: [...g.itemsById.values()].sort((a, b) => a.id - b.id),
  }))

  return {
    groups: grouped,
    skipped,
    duplicateIds,
  }
}

async function transmitSyncWriteGroup(group, transport, scsclBroadcastId) {
  const meta = resolveSyncWriteGroupMeta(group.protocol)
  const broadcastId =
    group.protocol === PROTOCOL.SCSCL
      ? normalizeScsclBroadcastId(scsclBroadcastId)
      : BROADCAST_ID
  const items = group.commands.map((c) => ({ id: c.id, data: c.data }))
  let tx
  try {
    tx = buildSyncWrite(meta.positionAddress, meta.positionByteLength, items, broadcastId)
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      protocol: group.protocol,
      count: items.length,
      txBytes: [],
    }
  }

  // 与 single-write 一致：等待串口槽位，避免 force:false 在实机节拍下丢包
  const w = await transport.write(tx, { force: true })
  if (!w.ok) {
    return {
      ok: false,
      dropped: Boolean(w.dropped),
      error: w.error || w.reason || "串口写入失败",
      protocol: group.protocol,
      count: items.length,
      txBytes: Array.from(tx),
    }
  }

  return {
    ok: true,
    protocol: group.protocol,
    count: items.length,
    txBytes: Array.from(tx),
    broadcastId,
  }
}

/**
 * 一帧多舵机 SyncWrite（对齐官方 GroupSyncWrite.txPacket / syncWriteTxOnly）。
 * @param {object[]} commands guard 后 bus commands
 * @param {{ transport?: object, scsclBroadcastId?: number }} [options]
 */
export async function sendBusServoFrameSyncWrite(commands, options = {}) {
  const transport = options.transport ?? scServoTransport
  const scsclBroadcastId = options.scsclBroadcastId ?? BROADCAST_ID
  const list = Array.isArray(commands) ? commands : []
  const startMs = Date.now()

  const safe = list.filter((c) => !isForbiddenBusId(c.busServoId))
  const { groups, skipped, duplicateIds } = groupBusCommandsForSyncWrite(safe)
  const results = []
  const errors = []
  const packetHexParts = []
  let sent = 0
  let packetCount = 0
  const sentServoIds = []
  const skippedServoIds = skipped.map((s) => s.busServoId).filter((id) => id != null)

  if (!groups.length) {
    const errMsg = skipped.length ? "全部命令被跳过" : "无有效总线命令"
    return {
      ok: false,
      error: errMsg,
      sent: 0,
      txAttempted: list.length,
      txSent: 0,
      commandCount: 0,
      packetCount: 0,
      sentServoIds,
      skippedServoIds,
      skipped,
      duplicateIds,
      txSkippedReason: skipped.map((s) => `${s.actuatorKey || s.busServoId}:${s.reason}`).join("; "),
      portConnected: Boolean(transport.getStatus()?.connected),
      results: [],
      txMode: "sync-write",
      writerSharedWithServoPage: false,
      realTxCount: 0,
      writeDurationMs: Date.now() - startMs,
      packetHex: "",
      lastTxPacketHex: "",
      lastTxBusId: null,
      lastTxProtocol: "",
      lastTxTargetPosition: null,
      lastTxReason: skipped.length ? "all-skipped" : "no-valid-commands",
    }
  }

  for (const group of groups) {
    const res = await transmitSyncWriteGroup(group, transport, scsclBroadcastId)
    results.push({
      groupKey: group.groupKey,
      ...res,
    })

    if (res.ok) {
      sent += res.count
      packetCount += 1
      for (const c of group.commands) {
        sentServoIds.push(c.id)
      }
      if (res.txBytes?.length) {
        packetHexParts.push(bytesToHex(res.txBytes))
      }
    } else {
      errors.push(res.error || `${group.protocol} SyncWrite 失败`)
      for (const c of group.commands) {
        skippedServoIds.push(c.id)
      }
    }
  }

  const writeDurationMs = Date.now() - startMs
  const packetHex = packetHexParts.join(" | ")
  const firstCmd = groups[0]?.commands?.[0]

  return {
    ok: errors.length === 0 && sent > 0,
    sent,
    txAttempted: list.length,
    txSent: sent,
    commandCount: sent,
    packetCount,
    sentServoIds: [...sentServoIds].sort((a, b) => Number(a) - Number(b)),
    skippedServoIds: [...new Set(skippedServoIds)],
    skipped,
    duplicateIds,
    txSkippedReason: errors.join("; "),
    portConnected: true,
    results,
    error: errors.join("; ") || "",
    txMode: "sync-write",
    writerSharedWithServoPage: false,
    realTxCount: sent,
    writeDurationMs,
    packetHex,
    lastTxPacketHex: packetHexParts[packetHexParts.length - 1] || "",
    lastTxBusId: firstCmd?.id ?? null,
    lastTxProtocol: firstCmd ? resolveBusCommandProtocol({ protocol: firstCmd.protocol }) : "",
    lastTxTargetPosition: firstCmd?.position ?? null,
    lastTxReason: errors.join("; "),
  }
}
