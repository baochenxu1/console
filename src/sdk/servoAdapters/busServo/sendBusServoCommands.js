import { PROTOCOL } from "../core/servoTypes.js"
import { ScsclAdapter } from "../scservo/scsclAdapter.js"
import { SmsStsAdapter } from "../scservo/smsStsAdapter.js"
import { writeLogicalValueWithProfile } from "../scservo/scServoLabMotion.js"
import { scServoTransport } from "../scservo/scServoWebSerialTransport.js"
import { rjSbusTransport } from "../rjsbus/rjSbusWebSerialTransport.js"
import { bytesToHex } from "./busServoTxUtil.js"
import { sendBusSyncWriteFrame } from "./busSyncWriteRegAction.js"
import { sendBusServoCommandsHybrid } from "./sendBusServoCommandsHybrid.js"
import {
  evaluateBusCommandsPortGate,
  getSharedBusWireTransport,
} from "./resolveBusTransport.js"
import { resolveBusCommandProtocol } from "./buildBusSyncWriteItem.js"
import { sendRjMultiPacketBatchTx } from "./sendRjMultiPacketBatchTx.js"

function isForbiddenBusId(id) {
  const n = Number(id)
  return !Number.isFinite(n) || n <= 0
}

function getAdapter(protocol, transport) {
  if (protocol === PROTOCOL.SMS_STS) {
    return new SmsStsAdapter({ transport: transport || scServoTransport })
  }
  return new ScsclAdapter({ transport: transport || scServoTransport })
}

function partitionCommandsByProtocol(commands) {
  const scSt = []
  const rj = []
  for (const cmd of commands || []) {
    if (resolveBusCommandProtocol(cmd) === PROTOCOL.RJ_SBUS) {
      rj.push(cmd)
    } else {
      scSt.push(cmd)
    }
  }
  return { scSt, rj }
}

/**
 * SC/ST 逐个单写（与单舵机页面 writeLogicalValueWithProfile 相同底层）。
 * RJ 不走此路径：统一走 Host Motion + Multi-Packet Batch TX。
 */
async function sendScStCommandsSingleWrite(commands, transport) {
  const safe = commands.filter((c) => !isForbiddenBusId(c.busServoId))
  const results = []
  const errors = []
  let sent = 0
  const sentServoIds = []
  const skippedServoIds = []
  let lastTx = {
    lastTxPacketHex: "",
    lastTxBusId: null,
    lastTxProtocol: "",
    lastTxTargetPosition: null,
    lastTxReason: "",
  }
  const startMs = Date.now()

  for (const cmd of safe) {
    if (!cmd.profile) {
      errors.push(`#${cmd.busServoId}: missing profile`)
      skippedServoIds.push(cmd.busServoId)
      results.push({ ok: false, busServoId: cmd.busServoId, error: "missing profile" })
      continue
    }

    const protocol = resolveBusCommandProtocol(cmd)
    const adapter = getAdapter(protocol, transport)
    const busLogical = cmd.busLogical ?? cmd.logicalValue ?? 500

    const res = await writeLogicalValueWithProfile(adapter, cmd.profile, busLogical, {
      waitAck: false,
      requireCalibrated: false,
      allowManualWrite: false,
      ...(Number.isFinite(Number(cmd.time)) ? { time: Math.max(0, Math.round(Number(cmd.time))) } : {}),
      ...(Number.isFinite(Number(cmd.speed)) ? { speed: Math.max(0, Math.round(Number(cmd.speed))) } : {}),
      ...(Number.isFinite(Number(cmd.acc)) ? { acc: Math.max(0, Math.round(Number(cmd.acc))) } : {}),
    })

    results.push({
      ok: res.ok,
      busServoId: cmd.busServoId,
      protocol,
      logicalValue: busLogical,
      targetPosition: res.sentTarget ?? res.targetPosition ?? cmd.targetPosition,
      error: res.error,
      txBytes: res.txBytes,
    })

    if (res.ok) {
      sent += 1
      sentServoIds.push(cmd.busServoId)
      lastTx = {
        lastTxPacketHex: bytesToHex(res.txBytes),
        lastTxBusId: cmd.busServoId,
        lastTxProtocol: protocol,
        lastTxTargetPosition: res.sentTarget ?? res.targetPosition ?? cmd.targetPosition,
        lastTxReason: "",
      }
    } else {
      const err = res.error || `写 #${cmd.busServoId} 失败`
      errors.push(err)
      skippedServoIds.push(cmd.busServoId)
      lastTx.lastTxReason = err
    }
  }

  const writeDurationMs = Date.now() - startMs

  return {
    ok: sent > 0 && errors.length === 0,
    sent,
    txAttempted: safe.length,
    txSent: sent,
    commandCount: sent,
    packetCount: sent,
    sentServoIds,
    skippedServoIds,
    txSkippedReason: errors.join("; "),
    portConnected: true,
    results,
    error: errors.join("; ") || "",
    txMode: "single-write",
    writerSharedWithServoPage: true,
    realTxCount: sent,
    writeDurationMs,
    packetHex: lastTx.lastTxPacketHex,
    ...lastTx,
  }
}

/**
 * single-write 模式下：SC/ST 仍逐台写；RJ 走 Motion Adapter + Batch TX。
 * 保证 Face Rig（默认 single-write）与 Tracking 共享同一 RJ 发送语义。
 */
async function sendBusServoCommandsSingleWrite(commands, transport, options = {}) {
  const { scSt, rj } = partitionCommandsByProtocol(commands)
  const startMs = Date.now()

  let scStRes = null
  let rjRes = null

  if (scSt.length > 0) {
    scStRes = await sendScStCommandsSingleWrite(scSt, transport)
  }

  if (rj.length > 0) {
    rjRes = await sendRjMultiPacketBatchTx(rj, {
      transport: options.rjTransport ?? rjSbusTransport,
      motionConfig: options.rjMotionConfig ?? options.motionConfig,
    })
  }

  const sentServoIds = [
    ...(scStRes?.sentServoIds ?? []),
    ...(rjRes?.sentServoIds ?? []),
  ]
  const skippedServoIds = [
    ...(scStRes?.skippedServoIds ?? []),
    ...(rjRes?.skippedServoIds ?? []),
  ]
  const errors = []
  if (scStRes?.error) errors.push(scStRes.error)
  if (rjRes?.errors?.length) {
    errors.push(...rjRes.errors)
  } else if (rjRes?.error && Number(rjRes.sent) === 0 && !(rjRes.deferredServoIds?.length)) {
    errors.push(rjRes.error)
  }

  const sent = sentServoIds.length
  const rjWriteCount = Number(rjRes?.transportWriteCount) || 0
  const scStWriteCount = Number(scStRes?.realTxCount) || 0
  const packetCount = scStWriteCount + (rjWriteCount > 0 ? 1 : 0)
  const writeDurationMs = Date.now() - startMs
  const hardFail =
    (scSt.length > 0 && scStRes && !scStRes.ok && Number(scStRes.sent) === 0) ||
    (rj.length > 0 && rjRes && Number(rjRes.sent) === 0 && (rjRes.errors?.length > 0))

  const lastTx = rjRes?.sent
    ? {
        lastTxPacketHex: rjRes.packetHex || "",
        lastTxBusId: rjRes.sentServoIds?.[0] ?? null,
        lastTxProtocol: PROTOCOL.RJ_SBUS,
        lastTxTargetPosition: null,
        lastTxReason: "",
      }
    : {
        lastTxPacketHex: scStRes?.lastTxPacketHex || "",
        lastTxBusId: scStRes?.lastTxBusId ?? null,
        lastTxProtocol: scStRes?.lastTxProtocol || "",
        lastTxTargetPosition: scStRes?.lastTxTargetPosition ?? null,
        lastTxReason: scStRes?.lastTxReason || "",
      }

  return {
    ok: !hardFail && errors.length === 0 && sent > 0,
    sent,
    txAttempted: commands.length,
    txSent: sent,
    commandCount: sent,
    packetCount,
    sentServoIds,
    skippedServoIds: [...new Set(skippedServoIds)],
    txSkippedReason: errors.join("; "),
    portConnected: true,
    results: [...(scStRes?.results ?? []), ...(rjRes?.results ?? [])],
    error: errors.join("; ") || "",
    txMode: rj.length > 0 ? "single-write+rj-batch" : "single-write",
    writerSharedWithServoPage: true,
    realTxCount: scStWriteCount + rjWriteCount,
    transportWriteCount: scStWriteCount + rjWriteCount,
    writeDurationMs,
    rjBatch: rjRes
      ? {
          commandCount: rjRes.commandCount,
          packetBytes: rjRes.packetBytes,
          transportWriteCount: rjRes.transportWriteCount,
          batchBuildMs: rjRes.batchBuildMs,
          transportWriteMs: rjRes.transportWriteMs,
          sentServoIds: rjRes.sentServoIds,
        }
      : null,
    packetHex: lastTx.lastTxPacketHex,
    ...lastTx,
  }
}

/**
 * 按协议发送总线命令。实机默认 single-write（INST_WRITE 0x03 逐台写）。
 * RJ 无论 single-write / hybrid 均经 Host Motion Adapter + Multi-Packet Batch TX。
 * @param {object[]} commands
 * @param {{ transport?: object, rjTransport?: object, txMode?: 'single-write' | 'hybrid' | 'sync-write', syncMode?: 'sync-inst' | 'reg-action', scSyncMode?: 'sync-inst' | 'reg-action', scsclBroadcastId?: number }} [options]
 */
export async function sendBusServoCommands(commands, options = {}) {
  /* RJ@1M 与 ST 共总线：默认同一 transport 切换报文；测试可显式分传两个 mock。 */
  const shared = getSharedBusWireTransport(options.activeFamily)
  const scWire = options.transport ?? shared
  const rjWire = options.rjTransport ?? options.transport ?? shared
  const rawList = Array.isArray(commands) ? commands : []
  const portGate = evaluateBusCommandsPortGate(rawList, {
    fallbackTransport: scWire?.getStatus?.()?.connected
      ? scWire
      : rjWire?.getStatus?.()?.connected
        ? rjWire
        : shared,
    activeFamily: options.activeFamily,
  })
  const list = Array.isArray(portGate.kept) ? portGate.kept : rawList
  const portConnected = Boolean(portGate.ok)
  const txMode = options.txMode ?? "single-write"
  const syncMode = options.syncMode ?? options.scSyncMode ?? "sync-inst"
  const scsclBroadcastId = options.scsclBroadcastId

  const emptyResult = (reason, extra = {}) => ({
    ok: false,
    error: reason,
    sent: 0,
    txAttempted: rawList.length,
    txSent: 0,
    commandCount: 0,
    packetCount: 0,
    sentServoIds: [],
    skippedServoIds: [],
    txSkippedReason: reason,
    portConnected,
    results: [],
    txMode,
    writerSharedWithServoPage: txMode === "single-write",
    realTxCount: 0,
    writeDurationMs: 0,
    packetHex: "",
    lastTxPacketHex: "",
    lastTxBusId: null,
    lastTxProtocol: "",
    lastTxTargetPosition: null,
    lastTxReason: reason,
    skippedPortCount: portGate.skipped?.length ?? 0,
    ...extra,
  })

  if (!portGate.ok) {
    return emptyResult(portGate.reason || "总线串口未连接", {
      portConnected: false,
    })
  }

  const safe = list.filter((c) => !isForbiddenBusId(c.busServoId))
  if (!safe.length) {
    return emptyResult("无有效总线命令")
  }

  if (txMode === "hybrid") {
    const res = await sendBusServoCommandsHybrid(safe, {
      transport: scWire,
      rjTransport: rjWire,
      scSyncMode: options.scSyncMode ?? syncMode,
      syncMode,
      scsclBroadcastId,
      rjMotionConfig: options.rjMotionConfig ?? options.motionConfig,
    })
    return { ...res, portConnected }
  }

  if (txMode === "sync-write") {
    /* sync-write 仅 SC/ST；RJ 命令单独走 Batch TX，避免被 SyncWrite item 拒绝后静默丢弃 */
    const { scSt, rj } = partitionCommandsByProtocol(safe)
    const syncRes = scSt.length
      ? await sendBusSyncWriteFrame(scSt, { transport: scWire, syncMode, scsclBroadcastId })
      : null
    const rjRes = rj.length
      ? await sendRjMultiPacketBatchTx(rj, {
          transport: rjWire,
          motionConfig: options.rjMotionConfig ?? options.motionConfig,
        })
      : null

    const sentServoIds = [
      ...(syncRes?.sentServoIds ?? []),
      ...(rjRes?.sentServoIds ?? []),
    ]
    const errors = []
    if (syncRes && !syncRes.ok) errors.push(syncRes.error || "SyncWrite 失败")
    if (rjRes?.errors?.length) errors.push(...rjRes.errors)

    return {
      ok: errors.length === 0 && sentServoIds.length > 0,
      error: errors.join("; "),
      sent: sentServoIds.length,
      txAttempted: safe.length,
      txSent: sentServoIds.length,
      commandCount: sentServoIds.length,
      packetCount:
        (Number(syncRes?.packetCount) || (syncRes?.ok ? 1 : 0)) +
        (Number(rjRes?.transportWriteCount) || 0),
      sentServoIds,
      skippedServoIds: [
        ...(syncRes?.skippedServoIds ?? []),
        ...(rjRes?.skippedServoIds ?? []),
      ],
      txSkippedReason: errors.join("; "),
      portConnected,
      results: [...(syncRes?.results ?? []), ...(rjRes?.results ?? [])],
      txMode: "sync-write",
      writerSharedWithServoPage: false,
      realTxCount: sentServoIds.length,
      writeDurationMs:
        (Number(syncRes?.writeDurationMs) || 0) + (Number(rjRes?.writeDurationMs) || 0),
      packetHex: rjRes?.packetHex || syncRes?.packetHex || "",
      lastTxPacketHex: rjRes?.packetHex || syncRes?.packetHex || "",
      lastTxBusId: sentServoIds[0] ?? null,
      lastTxProtocol: rjRes?.sent ? PROTOCOL.RJ_SBUS : syncRes?.lastTxProtocol || "",
      lastTxTargetPosition: null,
      lastTxReason: errors.join("; "),
      rjBatch: rjRes
        ? {
            commandCount: rjRes.commandCount,
            packetBytes: rjRes.packetBytes,
            transportWriteCount: rjRes.transportWriteCount,
          }
        : null,
    }
  }
  return sendBusServoCommandsSingleWrite(safe, scWire, { ...options, rjTransport: rjWire })
}

export { sendBusServoCommandsHybrid } from "./sendBusServoCommandsHybrid.js"
export { sendRjMultiPacketBatchTx } from "./sendRjMultiPacketBatchTx.js"

export { sendBusServoFrameSyncWrite, groupBusCommandsForSyncWrite } from "./sendBusServoFrameSyncWrite.js"
export { buildBusSyncWriteItemFromCommand, resolveBusCommandProtocol } from "./buildBusSyncWriteItem.js"
