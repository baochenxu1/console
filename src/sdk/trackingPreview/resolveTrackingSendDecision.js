/**
 * Tracking Device Drive 统一发送决策（legacy / 非 latest-frame pump 路径）。
 * Latest-frame send pump 请使用 resolveLatestFrameSendDecision。
 */
export function resolveTrackingSendDecision({
  nowMs,
  lastSendAtMs,
  maxSendFps,
  sourceSeq = null,
  lastAcceptedSourceSeq = null,
  frameTimestampMs = null,
  lastFrameTimestampMs = null,
  dropStaleFrame = false,
} = {}) {
  const fps = Number(maxSendFps)
  const minIntervalMs = Number.isFinite(fps) && fps > 0 ? 1000 / fps : 0

  let staleFrame = false
  let staleBy = /** @type {"source-seq" | "timestamp" | null} */ (null)

  if (dropStaleFrame) {
    const seq = Number(sourceSeq)
    const lastSeq = Number(lastAcceptedSourceSeq)
    if (Number.isFinite(seq) && Number.isFinite(lastSeq)) {
      // 仅拒绝倒退/重复的 source seq；同 seq 在 maxSendFps 下允许重发最新姿态
      if (seq < lastSeq) {
        staleFrame = true
        staleBy = "source-seq"
      }
    } else if (!Number.isFinite(seq)) {
      // payload 无 seq 时退回时间戳判断
      const frameTs = Number(frameTimestampMs)
      const lastFrameTs = Number(lastFrameTimestampMs)
      if (
        Number.isFinite(frameTs) &&
        frameTs > 0 &&
        Number.isFinite(lastFrameTs) &&
        lastFrameTs > 0 &&
        frameTs <= lastFrameTs
      ) {
        staleFrame = true
        staleBy = "timestamp"
      }
    }
  }

  if (staleFrame) {
    return { shouldSend: false, reason: "stale-frame", minIntervalMs, staleFrame: true, staleBy }
  }

  const lastAt = Number(lastSendAtMs)
  if (
    minIntervalMs > 0 &&
    Number.isFinite(lastAt) &&
    lastAt > 0 &&
    Number(nowMs) - lastAt < minIntervalMs
  ) {
    return { shouldSend: false, reason: "fps-limit", minIntervalMs, staleFrame: false, staleBy: null }
  }

  return { shouldSend: true, reason: "send", minIntervalMs, staleFrame: false, staleBy: null }
}
