import { PROTOCOL } from "../core/servoTypes.js"
import { ScsclAdapter } from "../scservo/scsclAdapter.js"
import { SmsStsAdapter } from "../scservo/smsStsAdapter.js"
import { writePositionWithProfile } from "../scservo/scServoLabMotion.js"
import { scServoTransport } from "../scservo/scServoWebSerialTransport.js"
import { rjSbusTransport } from "../rjsbus/rjSbusWebSerialTransport.js"
import {
  formatScsclBroadcastId,
  normalizeScsclBroadcastId,
  BROADCAST_ID,
} from "../scservo/scProtocolConstants.js"
import { bytesToHex } from "./busServoTxUtil.js"
import { resolveBusCommandProtocol } from "./buildBusSyncWriteItem.js"
import { sendBusServoFrameSyncWrite } from "./sendBusServoFrameSyncWrite.js"
import { sendBusRegActionSyncWrite } from "./busSyncWriteRegAction.js"
import { sendRjMultiPacketBatchTx } from "./sendRjMultiPacketBatchTx.js"

function isForbiddenBusId(id) {
  const n = Number(id)
  return !Number.isFinite(n) || n <= 0
}

function getAdapterStatic(protocol, transport) {
  return protocol === PROTOCOL.SMS_STS
    ? new SmsStsAdapter({ transport })
    : new ScsclAdapter({ transport })
}

function partitionCommandsByProtocol(commands) {
  const sc = []
  const st = []
  const rj = []
  for (const cmd of commands || []) {
    const proto = resolveBusCommandProtocol(cmd)
    if (proto === PROTOCOL.SMS_STS) {
      st.push(cmd)
    } else if (proto === PROTOCOL.RJ_SBUS) {
      rj.push(cmd)
    } else {
      sc.push(cmd)
    }
  }
  return { sc, st, rj }
}

/**
 * ST / 回退路径：按 guard 后 targetPosition 逐台写（与 sync item 目标一致）。
 */
async function sendStCommandsSingleWrite(commands, transport) {
  const safe = commands.filter((c) => !isForbiddenBusId(c.busServoId))
  const results = []
  const errors = []
  const packetHexList = []
  let sent = 0
  const sentServoIds = []
  const skippedServoIds = []
  const startMs = Date.now()

  for (const cmd of safe) {
    if (!cmd.profile) {
      errors.push(`#${cmd.busServoId}: missing profile`)
      skippedServoIds.push(cmd.busServoId)
      continue
    }
    const target = Number(cmd.targetPosition)
    if (!Number.isFinite(target)) {
      errors.push(`#${cmd.busServoId}: invalid targetPosition`)
      skippedServoIds.push(cmd.busServoId)
      continue
    }

    const adapter = getAdapterStatic(resolveBusCommandProtocol(cmd), transport)
    const res = await writePositionWithProfile(adapter, cmd.profile, target, {
      waitAck: false,
      requireCalibrated: false,
      allowManualWrite: false,
    })

    results.push({
      ok: res.ok,
      busServoId: cmd.busServoId,
      protocol: cmd.protocol,
      targetPosition: target,
      error: res.error,
      txBytes: res.txBytes,
    })

    if (res.ok) {
      sent += 1
      sentServoIds.push(cmd.busServoId)
      if (res.txBytes?.length) {
        packetHexList.push(bytesToHex(res.txBytes))
      }
    } else {
      errors.push(res.error || `写 #${cmd.busServoId} 失败`)
      skippedServoIds.push(cmd.busServoId)
    }
  }

  return {
    ok: sent > 0 && errors.length === 0,
    sent,
    commandCount: sent,
    packetCount: sent,
    sentServoIds,
    skippedServoIds,
    results,
    errors,
    error: errors.join("; "),
    writeDurationMs: Date.now() - startMs,
    packetHexList,
    packetHex: packetHexList[packetHexList.length - 1] || "",
    txMode: "single-write",
  }
}

/**
 * SC sync-inst + ST single-write + RJ Multi-Packet Batch TX 混合发送。
 * RJ 无协议 SyncWrite：Host 侧 concat 合法 CMD08，一次 transport.write。
 * @param {object[]} commands guard 后 bus commands
 * @param {{ transport?: object, scsclBroadcastId?: number, scSyncMode?: 'sync-inst' | 'reg-action', syncMode?: 'sync-inst' | 'reg-action', rjTransport?: object }} [options]
 */
export async function sendBusServoCommandsHybrid(commands, options = {}) {
  const transport = options.transport ?? scServoTransport
  const scsclBroadcastId = normalizeScsclBroadcastId(options.scsclBroadcastId ?? BROADCAST_ID)
  const scSyncMode = options.scSyncMode ?? options.syncMode ?? "sync-inst"
  const list = Array.isArray(commands) ? commands : []
  const safe = list.filter((c) => !isForbiddenBusId(c.busServoId))

  if (!safe.length) {
    return {
      ok: false,
      error: "无有效总线命令",
      txMode: "hybrid",
      groups: [],
      packetCount: 0,
      packetCountTotal: 0,
      commandCount: 0,
      commandCountTotal: 0,
      sentServoIds: [],
      skippedServoIds: [],
      sendModeByBusServoId: {},
      writeDurationMs: 0,
      writeDurationMsTotal: 0,
    }
  }

  const { sc, st, rj } = partitionCommandsByProtocol(safe)
  const groups = []
  const errors = []
  const sentServoIds = []
  const skippedServoIds = []
  const sendModeByBusServoId = {}
  const startMs = Date.now()

  if (sc.length > 0) {
    const scStart = Date.now()
    const scRes =
      scSyncMode === "reg-action"
        ? await sendBusRegActionSyncWrite(sc, { transport, scsclBroadcastId })
        : await sendBusServoFrameSyncWrite(sc, { transport, scsclBroadcastId })

    const scGroup = {
      protocol: "scscl",
      mode: scSyncMode,
      broadcastId: formatScsclBroadcastId(scsclBroadcastId),
      instruction: scSyncMode === "sync-inst" ? "0x83" : "0x04+0x05",
      packetCount: Number(scRes.packetCount) || (scRes.ok ? 1 : 0),
      commandCount: Number(scRes.sent) || sc.length,
      sentServoIds: scRes.sentServoIds ?? [],
      packetHex: scRes.packetHex ?? bytesToHex(scRes.txBytes) ?? "",
      writeDurationMs: scRes.writeDurationMs ?? Date.now() - scStart,
      ok: Boolean(scRes.ok),
      error: scRes.error || "",
    }
    groups.push(scGroup)

    if (!scRes.ok) {
      errors.push(scRes.error || "SC 同步写失败")
    } else {
      for (const id of scGroup.sentServoIds) {
        sentServoIds.push(id)
        sendModeByBusServoId[id] = scSyncMode
      }
    }
  }

  if (st.length > 0) {
    const stStart = Date.now()
    const stRes = await sendStCommandsSingleWrite(st, transport)
    const stGroup = {
      protocol: "sms_sts",
      mode: "single-write",
      packetCount: stRes.packetCount ?? stRes.sent ?? 0,
      commandCount: stRes.commandCount ?? stRes.sent ?? 0,
      sentServoIds: stRes.sentServoIds ?? [],
      packetHexList: stRes.packetHexList ?? [],
      packetHex: stRes.packetHex ?? "",
      writeDurationMs: stRes.writeDurationMs ?? Date.now() - stStart,
      ok: Boolean(stRes.ok),
      error: stRes.error || "",
    }
    groups.push(stGroup)

    if (!stRes.ok) {
      errors.push(stRes.error || "ST single-write 失败")
      skippedServoIds.push(...(stRes.skippedServoIds ?? []))
    } else {
      for (const id of stGroup.sentServoIds) {
        sentServoIds.push(id)
        sendModeByBusServoId[id] = "single-write"
      }
    }
  }

  if (rj.length > 0) {
    const rjStart = Date.now()
    const rjRes = await sendRjMultiPacketBatchTx(rj, {
      transport: options.rjTransport ?? transport,
      motionConfig: options.rjMotionConfig ?? options.motionConfig,
    })
    const hardErrors = rjRes.errors?.length
      ? rjRes.errors
      : rjRes.error && Number(rjRes.sent) === 0 && !rjRes.deferredOnly
        ? [rjRes.error]
        : []
    const rjGroup = {
      protocol: "rj_sbus",
      mode: "rj-multi-packet-batch",
      packetCount: rjRes.packetCount ?? (Number(rjRes.sent) > 0 ? 1 : 0),
      commandCount: rjRes.commandCount ?? rjRes.sent ?? 0,
      sentServoIds: rjRes.sentServoIds ?? [],
      packetHexList: rjRes.packetHexList ?? [],
      packetHex: rjRes.packetHex ?? "",
      packetBytes: rjRes.packetBytes ?? 0,
      transportWriteCount: rjRes.transportWriteCount ?? 0,
      batchBuildMs: rjRes.batchBuildMs ?? 0,
      transportWriteMs: rjRes.transportWriteMs ?? 0,
      writeDurationMs: rjRes.writeDurationMs ?? Date.now() - rjStart,
      ok: hardErrors.length === 0,
      error: hardErrors.join("; "),
    }
    groups.push(rjGroup)

    for (const id of rjGroup.sentServoIds) {
      sentServoIds.push(id)
      sendModeByBusServoId[id] = "rj-multi-packet-batch"
    }
    if (rjRes.deferredServoIds?.length) {
      skippedServoIds.push(...rjRes.deferredServoIds)
    }
    if (hardErrors.length) {
      errors.push(...hardErrors)
      skippedServoIds.push(
        ...(rjRes.skippedServoIds ?? []).filter((id) => !rjGroup.sentServoIds.includes(id))
      )
    }
  }

  const writeDurationMs = Date.now() - startMs
  const packetCountTotal = groups.reduce((sum, g) => sum + (Number(g.packetCount) || 0), 0)
  const commandCountTotal = groups.reduce((sum, g) => sum + (Number(g.commandCount) || 0), 0)
  const allOk = errors.length === 0 && groups.length > 0 && groups.every((g) => g.ok)

  const lastGroup = groups[groups.length - 1]

  return {
    ok: allOk,
    error: errors.join("; "),
    txMode: "hybrid",
    scSyncMode,
    scsclBroadcastId,
    groups,
    packetCount: packetCountTotal,
    packetCountTotal,
    commandCount: commandCountTotal,
    commandCountTotal,
    sent: commandCountTotal,
    txSent: commandCountTotal,
    txAttempted: safe.length,
    sentServoIds: [...new Set(sentServoIds)].sort((a, b) => Number(a) - Number(b)),
    skippedServoIds: [...new Set(skippedServoIds)],
    sendModeByBusServoId,
    writeDurationMs,
    writeDurationMsTotal: writeDurationMs,
    writerSharedWithServoPage: false,
    realTxCount: commandCountTotal,
    packetHex: lastGroup?.packetHex ?? "",
    lastTxPacketHex: lastGroup?.packetHex ?? "",
    lastTxBusId: lastGroup?.sentServoIds?.[0] ?? null,
    lastTxProtocol: lastGroup?.protocol ?? "",
    portConnected: true,
  }
}
