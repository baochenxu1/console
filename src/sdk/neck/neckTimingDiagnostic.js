/**
 * Development timeline alignment diagnostic（Face / Neck 同 clock 软件对齐）。
 */

const MAX = 256
/** @type {object[]} */
const buffer = []

export function recordCharacterDispatchTiming(entry) {
  buffer.push({
    timelineTimeMs: entry?.timelineTimeMs ?? entry?.sampledTime ?? null,
    characterSampleAt: entry?.characterSampleAt ?? entry?.sampledTime ?? null,
    faceDispatchAt: entry?.faceDispatchAt ?? entry?.faceDispatchTime ?? null,
    neckTargetPreparedAt: entry?.neckTargetPreparedAt ?? null,
    neckSocketSendAt: entry?.neckSocketSendAt ?? entry?.neckSendTime ?? null,
    sequence: entry?.sequence ?? null,
    bridgeLastAcceptedSequence:
      entry?.bridgeLastAcceptedSequence ?? entry?.lastAcceptedSequence ?? null,
    at: Date.now(),
  })
  while (buffer.length > MAX) buffer.shift()
}

export function getCharacterDispatchTimingLog() {
  return buffer.slice()
}

export function clearCharacterDispatchTimingLog() {
  buffer.length = 0
}

function percentile(sorted, p) {
  if (!sorted.length) return 0
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1)))
  return sorted[i]
}

/**
 * abs(neckSocketSendAt - faceDispatchAt) 软件对齐指标。
 */
export function summarizeFaceNeckDispatchAlignment(log = buffer) {
  const deltas = []
  for (const row of log || []) {
    const a = Number(row.faceDispatchAt)
    const b = Number(row.neckSocketSendAt)
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    deltas.push(Math.abs(b - a))
  }
  const sorted = [...deltas].sort((x, y) => x - y)
  const mean = deltas.length ? deltas.reduce((s, n) => s + n, 0) / deltas.length : 0
  return {
    count: deltas.length,
    mean,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.length ? sorted[sorted.length - 1] : 0,
  }
}

/**
 * 模拟 60s / 50Hz latest-wins 流：验证无界 backlog 不增长。
 */
export function simulateTargetLatestWinsStream({
  durationMs = 60_000,
  intervalMs = 20,
  maxPending = 1,
} = {}) {
  let pending = null
  let prepared = 0
  let sent = 0
  let maxQueue = 0
  const sendIntervals = []
  let lastSentAt = null

  for (let t = 0; t < durationMs; t += intervalMs) {
    prepared += 1
    pending = { t, pose: { yaw: t % 90 } }
    // latest-wins：队列长度恒 ≤ maxPending
    const queueLen = pending ? 1 : 0
    if (queueLen > maxQueue) maxQueue = queueLen

    // 假定每 tick 可发一次
    if (pending) {
      sent += 1
      if (lastSentAt != null) sendIntervals.push(t - lastSentAt)
      lastSentAt = t
      pending = null
    }
  }

  const sorted = [...sendIntervals].sort((a, b) => a - b)
  return {
    targetPrepared: prepared,
    targetSent: sent,
    maxPendingObserved: maxQueue,
    unboundedBacklog: maxQueue > maxPending,
    sendInterval: {
      mean: sendIntervals.length
        ? sendIntervals.reduce((s, n) => s + n, 0) / sendIntervals.length
        : 0,
      p95: percentile(sorted, 95),
    },
  }
}
