/** Device Drive 轻量诊断工具（与实时发送路径同文件域，无 React 依赖） */

import { inferActuatorSafetyRole } from "../output/actuatorOutputSafety.js"

export const MAX_REAL_SEND_SNAPSHOTS = 300
export const MAX_DEVICE_ENVELOPES = 128
export const PACKET_HEX_RING_SIZE = 10
export const COMPACT_DIAGNOSTIC_SAMPLE_MS = 500

export function createRingBuffer(maxSize = PACKET_HEX_RING_SIZE) {
  const buf = []
  return {
    push(item) {
      if (item == null || item === "") return buf
      buf.push(item)
      while (buf.length > maxSize) buf.shift()
      return buf
    },
    latest() {
      return buf[buf.length - 1] ?? null
    },
    toArray() {
      return buf.slice()
    },
  }
}

export function pruneSeqMap(map, maxSize = MAX_REAL_SEND_SNAPSHOTS) {
  if (!map || typeof map.size !== "number") return
  while (map.size > maxSize) {
    const oldest = map.keys().next().value
    map.delete(oldest)
  }
}

export function createSendPumpTiming() {
  return {
    tickIntervalMsMin: null,
    tickIntervalMsAvg: null,
    tickIntervalMsMax: null,
    tickIntervalOver60msCount: 0,
    tickIntervalOver100msCount: 0,
    buildOutputsMsAvg: null,
    buildCommandsMsAvg: null,
    safetyMsAvg: null,
    twitchGuardMsAvg: null,
    serialWriteMsAvg: null,
    debugBuildMsAvg: null,
    recorderAppendMsAvg: null,
    _tickSamples: [],
    _buildOutputs: [],
    _buildCommands: [],
    _safety: [],
    _twitch: [],
    _serial: [],
    _debugBuild: [],
    _recorder: [],
  }
}

function pushSample(arr, v, max = 120) {
  if (!Number.isFinite(v)) return
  arr.push(v)
  if (arr.length > max) arr.shift()
}

function sampleAvg(arr) {
  if (!arr.length) return null
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length)
}

export function recordPumpTick(timing, intervalMs) {
  if (!timing || !Number.isFinite(intervalMs)) return
  pushSample(timing._tickSamples, intervalMs)
  timing.tickIntervalMsMin = Math.min(...timing._tickSamples)
  timing.tickIntervalMsMax = Math.max(...timing._tickSamples)
  timing.tickIntervalMsAvg = sampleAvg(timing._tickSamples)
  if (intervalMs > 60) timing.tickIntervalOver60msCount += 1
  if (intervalMs > 100) timing.tickIntervalOver100msCount += 1
}

export function recordPhaseMs(timing, phase, ms) {
  if (!timing || !Number.isFinite(ms)) return
  const PHASE_AVG = {
    buildOutputs: "buildOutputsMsAvg",
    buildCommands: "buildCommandsMsAvg",
    safety: "safetyMsAvg",
    twitch: "twitchGuardMsAvg",
    serial: "serialWriteMsAvg",
    debugBuild: "debugBuildMsAvg",
    recorder: "recorderAppendMsAvg",
  }
  const bucket = `_${phase}`
  if (!Array.isArray(timing[bucket])) return
  pushSample(timing[bucket], ms)
  const avgKey = PHASE_AVG[phase]
  if (avgKey) timing[avgKey] = sampleAvg(timing[bucket])
}

function absMaxN(...vals) {
  return Math.max(0, ...vals.map((v) => Math.abs(Number(v) || 0)))
}

export function summarizeRigChannels(rig) {
  if (!rig) {
    return { eyeAbsMax: 0, browAbsMax: 0, mouthAbsMax: 0, jawAbsMax: 0 }
  }
  const eyeAbsMax = Math.max(
    absMaxN(rig.eyeL?.up, rig.eyeL?.lo),
    absMaxN(rig.eyeR?.up, rig.eyeR?.lo)
  )
  const browAbsMax = Math.max(
    absMaxN(rig.browL?.tipA ?? rig.browL?.tip, rig.browL?.tipB, rig.browL?.mid, rig.browL?.tail),
    absMaxN(rig.browR?.tipA ?? rig.browR?.tip, rig.browR?.tipB, rig.browR?.mid, rig.browR?.tail)
  )
  const mouthAbsMax = Math.max(
    Math.abs(Number(rig.mouth?.UL) || 0),
    Math.abs(Number(rig.mouth?.UR) || 0),
    Math.abs(Number(rig.mouth?.LL) || 0),
    Math.abs(Number(rig.mouth?.LR) || 0)
  )
  const jawAbsMax = Math.abs(Number(rig.jaw?.val) || 0)
  return { eyeAbsMax, browAbsMax, mouthAbsMax, jawAbsMax }
}

/**
 * 轻量 real-send 快照（compact/off 模式；不含 packetHex / 全量 busCommands）。
 */
export function buildMinimalRealSendSnapshot({
  frameSeq,
  txMode,
  writeResult,
  writeDurationMs,
  sentAtMs,
  sourceTimestampMs = null,
  timing = null,
  safetyStats = null,
  twitchStats = null,
  includeBusCommands = false,
  commands = [],
}) {
  const packetCount = Number(writeResult?.packetCountTotal ?? writeResult?.packetCount) || 0
  const commandCount =
    Number(writeResult?.commandCountTotal ?? writeResult?.commandCount) || commands.length || 0
  const snap = {
    sent: true,
    frameSeq,
    txMode,
    groups: (writeResult?.groups ?? []).map((g) => ({
      protocol: g.protocol,
      mode: g.mode,
      packetCount: g.packetCount,
      commandCount: g.commandCount,
      writeDurationMs: g.writeDurationMs,
      broadcastId: g.broadcastId ?? null,
    })),
    packetCount,
    packetCountTotal: packetCount,
    commandCount,
    commandCountTotal: commandCount,
    writeDurationMs,
    writeDurationMsTotal: writeResult?.writeDurationMsTotal ?? writeDurationMs,
    sentServoIds: writeResult?.sentServoIds ?? [],
    sentAtMs,
    sourceTimestampMs,
    timing: timing || null,
    safetyStats: safetyStats || null,
    twitchStats: twitchStats || null,
  }
  if (includeBusCommands && commands?.length) {
    snap.busCommands = commands.map((c) => ({
      actuatorKey: c.actuatorKey,
      busServoId: c.busServoId,
      protocol: c.protocol,
      sendMode: c.sendMode ?? null,
      realSentTargetPosition: c.realSentTargetPosition ?? c.targetPosition ?? null,
    }))
  }
  return snap
}

export function shouldBuildUiDebug(nowMs, lastUiDebugAtMs, intervalMs = 250) {
  return nowMs - lastUiDebugAtMs >= intervalMs
}

export function exportSendPumpTiming(timing) {
  if (!timing) return null
  return {
    tickIntervalMsMin: timing.tickIntervalMsMin,
    tickIntervalMsAvg: timing.tickIntervalMsAvg,
    tickIntervalMsMax: timing.tickIntervalMsMax,
    tickIntervalOver60msCount: timing.tickIntervalOver60msCount,
    tickIntervalOver100msCount: timing.tickIntervalOver100msCount,
    buildOutputsMsAvg: timing.buildOutputsMsAvg,
    buildCommandsMsAvg: timing.buildCommandsMsAvg,
    safetyMsAvg: timing.safetyMsAvg,
    twitchGuardMsAvg: timing.twitchGuardMsAvg,
    serialWriteMsAvg: timing.serialWriteMsAvg,
    debugBuildMsAvg: timing.debugBuildMsAvg,
    recorderAppendMsAvg: timing.recorderAppendMsAvg,
  }
}

function emptyRoleCounts() {
  return { brow: 0, eye: 0, eyeXY: 0, lip: 0, jaw: 0, mouthCorner: 0, default: 0 }
}

function emptyTwitchActionCounts() {
  return { pass: 0, hold: 0, recoverSlew: 0, frameSpikeHold: 0 }
}

/**
 * 从 bus commands 汇总 safety slew-limit 统计（per-frame）。
 */
export function summarizeSafetyFromCommands(commands = []) {
  const safetyLimitedCountByRole = emptyRoleCounts()
  const actuatorMap = new Map()

  for (const cmd of commands || []) {
    const safety = cmd?.safety
    if (!safety?.limited) continue
    const role = safety.role || inferActuatorSafetyRole(cmd.sourceChannel, cmd.actuatorKey)
    safetyLimitedCountByRole[role] = (safetyLimitedCountByRole[role] || 0) + 1

    const key = String(cmd.actuatorKey || cmd.busServoId || "")
    if (!key) continue
    const prev = actuatorMap.get(key) || {
      actuatorKey: key,
      sourceChannel: cmd.sourceChannel || null,
      limitedCount: 0,
      twitchHoldCount: 0,
      recoverSlewCount: 0,
    }
    prev.limitedCount += 1
    actuatorMap.set(key, prev)
  }

  return { safetyLimitedCountByRole, limitedActuators: [...actuatorMap.values()] }
}

/**
 * 从 twitch guard debug 汇总 per-frame 统计。
 */
export function summarizeTwitchFromDebug(twitchDebug = [], frameSpikeDebug = null) {
  const twitchGuardActionCountByRole = emptyTwitchActionCounts()
  const actuatorMap = new Map()

  if (frameSpikeDebug?.triggered) {
    twitchGuardActionCountByRole.frameSpikeHold += 1
  }

  for (const tg of twitchDebug || []) {
    const action = String(tg?.action || "pass")
    if (action === "hold") {
      twitchGuardActionCountByRole.hold += 1
    } else if (action === "recover-slew") {
      twitchGuardActionCountByRole.recoverSlew += 1
    } else {
      twitchGuardActionCountByRole.pass += 1
    }

    const key = String(tg?.actuatorKey || "")
    if (!key) continue
    const prev = actuatorMap.get(key) || {
      actuatorKey: key,
      sourceChannel: tg.sourceChannel || null,
      limitedCount: 0,
      twitchHoldCount: 0,
      recoverSlewCount: 0,
    }
    if (action === "hold") prev.twitchHoldCount += 1
    if (action === "recover-slew") prev.recoverSlewCount += 1
    actuatorMap.set(key, prev)
  }

  return { twitchGuardActionCountByRole, limitedActuators: [...actuatorMap.values()] }
}

export function mergeActuatorRank(safetyActuators = [], twitchActuators = []) {
  const map = new Map()
  for (const row of [...safetyActuators, ...twitchActuators]) {
    const key = String(row.actuatorKey || "")
    if (!key) continue
    const prev = map.get(key) || {
      actuatorKey: key,
      sourceChannel: row.sourceChannel || null,
      limitedCount: 0,
      twitchHoldCount: 0,
      recoverSlewCount: 0,
    }
    prev.limitedCount += Number(row.limitedCount) || 0
    prev.twitchHoldCount += Number(row.twitchHoldCount) || 0
    prev.recoverSlewCount += Number(row.recoverSlewCount) || 0
    if (!prev.sourceChannel && row.sourceChannel) {
      prev.sourceChannel = row.sourceChannel
    }
    map.set(key, prev)
  }
  return [...map.values()].sort(
    (a, b) =>
      b.limitedCount + b.twitchHoldCount + b.recoverSlewCount -
      (a.limitedCount + a.twitchHoldCount + a.recoverSlewCount)
  )
}

export function percentile(values, p) {
  const nums = (values || []).filter((v) => Number.isFinite(Number(v))).map(Number).sort((a, b) => a - b)
  if (!nums.length) return null
  const idx = Math.min(nums.length - 1, Math.max(0, Math.ceil((p / 100) * nums.length) - 1))
  return Math.round(nums[idx] * 100) / 100
}

export function latencyStats(values) {
  const nums = (values || []).filter((v) => Number.isFinite(Number(v))).map(Number)
  if (!nums.length) {
    return { min: null, avg: null, p50: null, p90: null, max: null, count: 0 }
  }
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  const avg = Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100
  return {
    min: Math.round(min * 100) / 100,
    avg,
    p50: percentile(nums, 50),
    p90: percentile(nums, 90),
    max: Math.round(max * 100) / 100,
    count: nums.length,
  }
}
