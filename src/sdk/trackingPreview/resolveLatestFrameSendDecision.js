/**
 * Latest-frame send pump 决策：按 frameSeq 判断是否有新帧可发。
 * 同 seq 在 minResendIntervalMs 到达后允许重发，供 safety slew 在帧间追赶。
 *
 * @param {object} args
 * @param {number | null | undefined} args.frameSeq
 * @param {number | null | undefined} args.lastSentFrameSeq
 * @param {number} [args.minResendIntervalMs] 同 seq 重发最小间隔（0=禁用）
 * @param {number} [args.lastSentAtMs]
 * @param {number} [args.nowMs]
 * @returns {{ shouldSend: boolean, reason: "send" | "no-new-frame" | "seq-regression" | "no-frame-seq" | "same-seq-resend" }}
 */
export function resolveLatestFrameSendDecision({
  frameSeq = null,
  lastSentFrameSeq = null,
  minResendIntervalMs = 0,
  lastSentAtMs = 0,
  nowMs = 0,
} = {}) {
  const seq = Number(frameSeq)
  const last = Number(lastSentFrameSeq)

  if (!Number.isFinite(seq)) {
    return { shouldSend: false, reason: "no-frame-seq" }
  }
  if (Number.isFinite(last) && seq === last) {
    const resendMs = Number(minResendIntervalMs)
    const lastAt = Number(lastSentAtMs)
    const now = Number(nowMs)
    if (
      resendMs > 0 &&
      Number.isFinite(lastAt) &&
      lastAt > 0 &&
      Number.isFinite(now) &&
      now - lastAt >= resendMs
    ) {
      return { shouldSend: true, reason: "same-seq-resend" }
    }
    return { shouldSend: false, reason: "no-new-frame" }
  }
  if (Number.isFinite(last) && seq < last) {
    return { shouldSend: false, reason: "seq-regression" }
  }
  return { shouldSend: true, reason: "send" }
}
