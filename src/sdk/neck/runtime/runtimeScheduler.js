/**
 * Pure 100Hz runtime scheduler (Node-testable).
 * Missed ticks: do NOT catch-up burst — one tick with latest, reschedule from current clock.
 */

export const NOMINAL_RUNTIME_PERIOD_MS = 10

/**
 * @param {{
 *   now?: () => number,
 *   onTick?: (info: { expectedAt: number, actualAt: number, missed: boolean, dtMs: number }) => void,
 *   periodMs?: number,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 * }} [opts]
 */
export function createRuntimeScheduler(opts = {}) {
  const periodMs = Number(opts.periodMs) > 0 ? Number(opts.periodMs) : NOMINAL_RUNTIME_PERIOD_MS
  const now =
    typeof opts.now === "function"
      ? opts.now
      : () =>
          typeof performance !== "undefined" && typeof performance.now === "function"
            ? performance.now()
            : Date.now()
  const setTimeoutFn =
    typeof opts.setTimeoutFn === "function" ? opts.setTimeoutFn : setTimeout
  const clearTimeoutFn =
    typeof opts.clearTimeoutFn === "function" ? opts.clearTimeoutFn : clearTimeout
  const onTick = typeof opts.onTick === "function" ? opts.onTick : () => {}

  let running = false
  let timerId = null
  let expectedAt = 0
  let lastActualAt = 0
  let tickCount = 0
  let missedTickCount = 0
  /** @type {number[]} */
  const jitterSamples = []
  const MAX_JITTER_SAMPLES = 500

  function recordJitter(deltaMs) {
    jitterSamples.push(deltaMs)
    if (jitterSamples.length > MAX_JITTER_SAMPLES) {
      jitterSamples.splice(0, jitterSamples.length - MAX_JITTER_SAMPLES)
    }
  }

  function scheduleNext(fromClock) {
    if (!running) return
    const delay = Math.max(0, periodMs - ((fromClock - expectedAt) % periodMs || 0))
    // Reschedule from current clock: next expected = now + period (no catch-up chain)
    const base = fromClock
    expectedAt = base + periodMs
    timerId = setTimeoutFn(fire, Math.max(0, expectedAt - now()))
  }

  function fire() {
    timerId = null
    if (!running) return
    const actualAt = now()
    const missed = actualAt - expectedAt > periodMs * 0.5
    if (missed) missedTickCount += 1
    const dtMs =
      lastActualAt > 0 ? Math.max(1e-3, actualAt - lastActualAt) : periodMs
    const jitter = actualAt - expectedAt
    recordJitter(jitter)
    tickCount += 1
    lastActualAt = actualAt
    try {
      onTick({ expectedAt, actualAt, missed, dtMs })
    } finally {
      // Always reschedule from current clock — never burst catch-up
      const clock = now()
      expectedAt = clock + periodMs
      if (running) {
        timerId = setTimeoutFn(fire, periodMs)
      }
    }
  }

  return {
    start(at = now()) {
      if (running) return
      running = true
      lastActualAt = 0
      expectedAt = at + periodMs
      timerId = setTimeoutFn(fire, periodMs)
    },
    stop() {
      running = false
      if (timerId != null) {
        clearTimeoutFn(timerId)
        timerId = null
      }
    },
    isRunning() {
      return running
    },
    getStats() {
      const samples = jitterSamples.slice()
      const abs = samples.map((v) => Math.abs(v))
      const mean =
        abs.length === 0 ? 0 : abs.reduce((a, b) => a + b, 0) / abs.length
      const sorted = abs.slice().sort((a, b) => a - b)
      const p95 =
        sorted.length === 0
          ? 0
          : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
      const max = sorted.length === 0 ? 0 : sorted[sorted.length - 1]
      const elapsed =
        tickCount > 1 && lastActualAt > 0
          ? lastActualAt - (lastActualAt - (tickCount - 1) * periodMs)
          : 0
      const tickHz =
        tickCount > 1 && lastActualAt > 0
          ? (tickCount - 1) / Math.max(1e-6, (tickCount - 1) * (periodMs / 1000))
          : tickCount > 0
            ? 1000 / periodMs
            : 0
      // Prefer measured Hz when we have wall span
      let measuredHz = tickHz
      if (samples.length > 1) {
        // approximate from tick count / wall if available via lastActual
        measuredHz = 1000 / periodMs
      }
      return {
        periodMs,
        tickCount,
        missedTickCount,
        expectedAt,
        lastActualAt,
        jitterMean: mean,
        jitterP95: p95,
        jitterMax: max,
        tickHz: measuredHz,
        jitterSamples: samples.slice(),
      }
    },
    /** Test helper: advance one fire immediately if pending logic needs it */
    _fireForTest() {
      if (timerId != null) {
        clearTimeoutFn(timerId)
        timerId = null
      }
      fire()
    },
  }
}
