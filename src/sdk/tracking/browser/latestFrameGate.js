/**
 * Latest-frame gate：推理忙时只保留最新 pending，禁止 FIFO。
 */

export function createLatestFrameGate() {
  let inFlight = false
  let pending = null
  let capturedFrames = 0
  let inferredFrames = 0
  let droppedFrames = 0

  return {
    /**
     * @param {unknown} frame
     * @returns {"accepted"|"pending"|"dropped"}
     */
    offer(frame) {
      capturedFrames += 1
      if (!inFlight) {
        return "accepted"
      }
      if (pending != null) {
        droppedFrames += 1
      }
      pending = frame
      return pending === frame ? "pending" : "pending"
    },

    beginInference() {
      inFlight = true
    },

    /**
     * @returns {unknown | null} 下一次应处理的 pending（可能为 null）
     */
    endInference() {
      inFlight = false
      inferredFrames += 1
      const next = pending
      pending = null
      return next
    },

    isBusy() {
      return inFlight
    },

    peekPending() {
      return pending
    },

    getStats() {
      return {
        capturedFrames,
        inferredFrames,
        droppedFrames,
        inFlight,
        hasPending: pending != null,
      }
    },

    reset() {
      inFlight = false
      pending = null
      capturedFrames = 0
      inferredFrames = 0
      droppedFrames = 0
    },
  }
}

/**
 * 保证 detectForVideo 时间戳严格递增。
 */
export function createMonotonicTimestampGuard(startMs = 0) {
  let last = Number(startMs) || 0
  return {
    next(candidateMs) {
      let t = Number(candidateMs)
      if (!Number.isFinite(t)) {
        t = last + 1
      }
      if (t <= last) {
        t = last + 1
      }
      last = t
      return t
    },
    peek() {
      return last
    },
    reset(value = 0) {
      last = Number(value) || 0
    },
  }
}
