/**
 * RJ Multi-Packet Batch TX（Host Batch，非协议 SyncWrite）。
 *
 * 同一 control cycle 内多个合法 CMD08 帧 concat 后一次 transport.write。
 * 发送前统一经 Phase 1 rjHostMotionAdapter 生成 timeMs。
 */

import { PROTOCOL } from "../core/servoTypes.js"
import { buildMoveOnAngleMode } from "../rjsbus/rjSbusPacket.js"
import { rjSbusTransport } from "../rjsbus/rjSbusWebSerialTransport.js"
import { clampAngleTicks } from "../rjsbus/rjSbusCodec.js"
import { ANGLE_TICK_MIN, ANGLE_TICK_MAX } from "../rjsbus/rjSbusConstants.js"
import { bytesToHex } from "./busServoTxUtil.js"
import { resolveBusCommandProtocol } from "./buildBusSyncWriteItem.js"
import {
  planRjHostMotion,
  commitRjHostMotionSend,
  formatRjHostMotionDiag,
} from "../../output/rjHostMotionAdapter.js"

/** @type {boolean} */
let rjBatchDebugEnabled = false

export function setRjBatchDebugEnabled(enabled) {
  rjBatchDebugEnabled = Boolean(enabled)
}

export function isRjBatchDebugEnabled() {
  return rjBatchDebugEnabled
}

function isForbiddenBusId(id) {
  const n = Number(id)
  return !Number.isFinite(n) || n <= 0
}

/**
 * 从 profile 解析 RJ power：显式 0 合法；缺省回退 600（与 write 层一致）。
 * @param {object} [profile]
 */
export function resolveRjPowerFromProfile(profile) {
  const raw = profile?.power
  const hasPower = raw != null && raw !== ""
  if (hasPower && Number.isFinite(Number(raw))) {
    return Math.max(0, Math.round(Number(raw)))
  }
  return 600
}

/**
 * 同周期同 ID 去重：latest wins（保留最后一次出现）。
 * @param {object[]} commands
 * @returns {object[]}
 */
export function dedupeRjCommandsLatestWins(commands = []) {
  const byId = new Map()
  for (const cmd of commands || []) {
    if (!cmd) continue
    const id = Number(cmd.busServoId ?? cmd.profile?.id ?? cmd.profile?.busServoId)
    if (!Number.isFinite(id) || isForbiddenBusId(id)) continue
    byId.set(id, { ...cmd, busServoId: id })
  }
  return [...byId.values()]
}

/**
 * 将多个完整 RJ 请求帧 concat 成一个 Uint8Array。
 * @param {Uint8Array[]} packets
 * @returns {Uint8Array}
 */
export function concatRjPackets(packets = []) {
  let total = 0
  for (const p of packets) {
    total += p?.length || 0
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of packets) {
    if (!p?.length) continue
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/**
 * 规划可发送的 RJ motion（不写串口、不 commit）。
 * @param {object[]} commands 已去重的 RJ bus commands
 * @param {{ nowMs?: number }} [options]
 */
export function planRjBatchFromCommands(commands = [], options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : performance.now()
  const sendable = []
  const deferred = []
  const failed = []
  const diags = []

  for (const cmd of commands) {
    const servoId = Number(cmd.busServoId)
    const targetPosition = Number(cmd.targetPosition)
    if (!Number.isFinite(servoId) || isForbiddenBusId(servoId)) {
      failed.push({ cmd, error: "invalid-bus-id" })
      continue
    }
    if (!Number.isFinite(targetPosition)) {
      failed.push({ cmd, error: "invalid-target-position" })
      continue
    }

    const power = resolveRjPowerFromProfile(cmd.profile)
    const motionPlan = planRjHostMotion({
      servoId,
      targetPosition,
      protocol: "RJ",
      power,
      nowMs,
      config: options.motionConfig,
    })

    if (!motionPlan.ok) {
      failed.push({ cmd, error: motionPlan.error || "plan-failed", motionPlan })
      continue
    }

    if (motionPlan.deferred) {
      deferred.push({ cmd, motionPlan })
      diags.push(motionPlan.diag)
      continue
    }

    const angleTicks = clampAngleTicks(targetPosition, ANGLE_TICK_MIN, ANGLE_TICK_MAX)
    const packet = buildMoveOnAngleMode(servoId, {
      angleTicks,
      timeMs: motionPlan.timeMs,
      power,
    })

    sendable.push({
      cmd,
      servoId,
      targetPosition: angleTicks,
      power,
      timeMs: motionPlan.timeMs,
      motionPlan,
      packet,
    })
    diags.push(motionPlan.diag)
  }

  return { sendable, deferred, failed, diags, nowMs }
}

/**
 * 构建 batch 字节（不发送）。
 * @param {ReturnType<typeof planRjBatchFromCommands>['sendable']} sendable
 */
export function buildRjBatchBytesFromSendable(sendable = []) {
  const packets = sendable.map((s) => s.packet)
  const batchBytes = concatRjPackets(packets)
  return {
    packets,
    batchBytes,
    packetBytes: batchBytes.length,
    commandCount: sendable.length,
    servoIds: sendable.map((s) => s.servoId),
  }
}

function logRjBatchDiag(line) {
  if (!rjBatchDebugEnabled) return
  if (typeof console !== "undefined" && typeof console.debug === "function") {
    console.debug(line)
  }
}

/**
 * RJ Host Motion + Multi-Packet Batch TX。
 *
 * 事务顺序：plan → build → write → commit（仅 write 成功后）。
 *
 * @param {object[]} commands RJ bus commands（可含重复 ID）
 * @param {{
 *   transport?: { write: Function, getStatus?: Function },
 *   nowMs?: number,
 *   debug?: boolean,
 * }} [options]
 */
export async function sendRjMultiPacketBatchTx(commands = [], options = {}) {
  const transport = options.transport ?? rjSbusTransport
  const debug = options.debug != null ? Boolean(options.debug) : rjBatchDebugEnabled
  const list = Array.isArray(commands) ? commands : []
  const rjOnly = list.filter((c) => resolveBusCommandProtocol(c) === PROTOCOL.RJ_SBUS)
  const deduped = dedupeRjCommandsLatestWins(rjOnly)

  const empty = (reason, extra = {}) => ({
    ok: false,
    error: reason,
    sent: 0,
    commandCount: 0,
    packetCount: 0,
    sentServoIds: [],
    skippedServoIds: deduped.map((c) => c.busServoId),
    deferredServoIds: [],
    results: [],
    errors: reason ? [reason] : [],
    writeDurationMs: 0,
    batchBuildMs: 0,
    transportWriteMs: 0,
    transportWriteCount: 0,
    packetBytes: 0,
    packetHex: "",
    packetHexList: [],
    txMode: "rj-multi-packet-batch",
    mode: "rj-multi-packet-batch",
    ...extra,
  })

  if (!deduped.length) {
    return empty("无有效 RJ 命令", { skippedServoIds: [] })
  }

  if (typeof transport?.write !== "function") {
    return empty("RJ transport 不可用")
  }

  const status = transport.getStatus?.()
  if (status && status.connected === false) {
    return empty("RJ 串口未连接")
  }

  const t0 = performance.now()
  const planned = planRjBatchFromCommands(deduped, {
    nowMs: options.nowMs,
    motionConfig: options.motionConfig,
  })
  const built = buildRjBatchBytesFromSendable(planned.sendable)
  const batchBuildMs = performance.now() - t0

  const deferredServoIds = planned.deferred.map((d) => d.cmd.busServoId)
  const failedIds = planned.failed.map((f) => f.cmd.busServoId)
  const skippedServoIds = [...new Set([...deferredServoIds, ...failedIds])]

  if (debug) {
    for (const d of planned.diags) {
      logRjBatchDiag(formatRjHostMotionDiag(d))
    }
  }

  if (!planned.sendable.length) {
    const hardErrors = planned.failed.map((f) => f.error).filter(Boolean)
    const deferredOnly = planned.deferred.length > 0 && hardErrors.length === 0
    const reason = hardErrors.length
      ? hardErrors.join("; ")
      : "全部 RJ 命令因 minSendInterval 延迟"
    return {
      ...empty(reason, {
        skippedServoIds,
        deferredServoIds,
        batchBuildMs,
        /* 仅 interval 延迟：本周期无包可发，不算硬失败 */
        ok: deferredOnly,
        deferredOnly,
        error: hardErrors.length ? reason : "",
        errors: hardErrors,
      }),
      results: [
        ...planned.deferred.map((d) => ({
          ok: false,
          deferred: true,
          busServoId: d.cmd.busServoId,
          retryAfterMs: d.motionPlan.retryAfterMs,
        })),
        ...planned.failed.map((f) => ({
          ok: false,
          busServoId: f.cmd?.busServoId,
          error: f.error,
        })),
      ],
    }
  }

  const writeStart = performance.now()
  let writeRes
  try {
    writeRes = await transport.write(built.batchBytes)
  } catch (err) {
    const msg = err?.message || String(err)
    if (debug) {
      logRjBatchDiag(
        `[RJ Batch] FAIL writeCount=0 cmd=${built.commandCount} bytes=${built.packetBytes} err=${msg}`
      )
    }
    return {
      ...empty(msg, {
        skippedServoIds: [
          ...skippedServoIds,
          ...planned.sendable.map((s) => s.servoId),
        ],
        deferredServoIds,
        batchBuildMs,
        transportWriteMs: performance.now() - writeStart,
        transportWriteCount: 0,
        packetBytes: built.packetBytes,
        packetHexList: planned.sendable.map((s) => bytesToHex(s.packet)),
        packetHex: bytesToHex(built.batchBytes),
        results: planned.sendable.map((s) => ({
          ok: false,
          busServoId: s.servoId,
          error: msg,
          timeMs: s.timeMs,
          targetPosition: s.targetPosition,
        })),
      }),
    }
  }

  const transportWriteMs = performance.now() - writeStart
  const writeOk = writeRes == null ? true : writeRes.ok !== false

  if (!writeOk) {
    const msg = writeRes?.error || writeRes?.reason || "RJ batch write 失败"
    if (debug) {
      logRjBatchDiag(
        `[RJ Batch] FAIL writeCount=1 cmd=${built.commandCount} bytes=${built.packetBytes} err=${msg}`
      )
    }
    return {
      ...empty(msg, {
        skippedServoIds: [
          ...skippedServoIds,
          ...planned.sendable.map((s) => s.servoId),
        ],
        deferredServoIds,
        batchBuildMs,
        transportWriteMs,
        transportWriteCount: 1,
        packetBytes: built.packetBytes,
        packetHexList: planned.sendable.map((s) => bytesToHex(s.packet)),
        packetHex: bytesToHex(built.batchBytes),
        results: planned.sendable.map((s) => ({
          ok: false,
          busServoId: s.servoId,
          error: msg,
          timeMs: s.timeMs,
          targetPosition: s.targetPosition,
        })),
      }),
    }
  }

  /* 仅 write 成功后 commit */
  for (const item of planned.sendable) {
    commitRjHostMotionSend(item.servoId, item.motionPlan)
  }

  const sentServoIds = planned.sendable.map((s) => s.servoId)
  const packetHexList = planned.sendable.map((s) => bytesToHex(s.packet))
  const writeDurationMs = batchBuildMs + transportWriteMs

  if (debug) {
    logRjBatchDiag(
      `[RJ Batch] t=${Date.now()} cmd=${built.commandCount} ids=[${sentServoIds.join(",")}]` +
        ` bytes=${built.packetBytes} writeCount=1` +
        ` buildMs=${batchBuildMs.toFixed(2)} writeMs=${transportWriteMs.toFixed(2)}`
    )
  }

  const errors = planned.failed.map((f) => `#${f.cmd?.busServoId}: ${f.error}`)

  return {
    ok: errors.length === 0,
    error: errors.join("; "),
    errors,
    sent: sentServoIds.length,
    commandCount: sentServoIds.length,
    packetCount: 1,
    sentServoIds,
    skippedServoIds,
    deferredServoIds,
    results: [
      ...planned.sendable.map((s) => ({
        ok: true,
        busServoId: s.servoId,
        protocol: PROTOCOL.RJ_SBUS,
        targetPosition: s.targetPosition,
        timeMs: s.timeMs,
        power: s.power,
        txBytes: Array.from(s.packet),
      })),
      ...planned.deferred.map((d) => ({
        ok: false,
        deferred: true,
        busServoId: d.cmd.busServoId,
        retryAfterMs: d.motionPlan.retryAfterMs,
      })),
      ...planned.failed.map((f) => ({
        ok: false,
        busServoId: f.cmd?.busServoId,
        error: f.error,
      })),
    ],
    writeDurationMs,
    batchBuildMs,
    transportWriteMs,
    transportWriteCount: 1,
    packetBytes: built.packetBytes,
    packetHexList,
    packetHex: bytesToHex(built.batchBytes),
    txMode: "rj-multi-packet-batch",
    mode: "rj-multi-packet-batch",
    timestamp: Date.now(),
  }
}
