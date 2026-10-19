/**
 * Bounded command priority queue for CanFrame TX (main-thread transport host).
 * ESTOP > DISABLE/CONTROL > ENABLE_STEP > PERIODIC_POSITION
 * At most one pending PERIODIC (latest-wins overwrite).
 * Control commands are never dropped by periodic.
 */

export const COMMAND_PRIORITY = Object.freeze({
  ESTOP: "ESTOP",
  DISABLE_CONTROL: "DISABLE_CONTROL",
  ENABLE_STEP: "ENABLE_STEP",
  PERIODIC_POSITION: "PERIODIC_POSITION",
})

const RANK = Object.freeze({
  [COMMAND_PRIORITY.ESTOP]: 100,
  [COMMAND_PRIORITY.DISABLE_CONTROL]: 80,
  [COMMAND_PRIORITY.ENABLE_STEP]: 60,
  [COMMAND_PRIORITY.PERIODIC_POSITION]: 10,
})

/**
 * @param {string} priority
 * @returns {number}
 */
export function commandPriorityRank(priority) {
  const p = String(priority || "")
  return RANK[p] ?? 0
}

/**
 * @param {string} priority
 */
export function normalizeCommandPriority(priority) {
  const p = String(priority || "").toUpperCase()
  if (p === "ESTOP") return COMMAND_PRIORITY.ESTOP
  if (p === "DISABLE" || p === "DISABLE_CONTROL" || p === "CONTROL") {
    return COMMAND_PRIORITY.DISABLE_CONTROL
  }
  if (p === "ENABLE" || p === "ENABLE_STEP" || p === "MODE") {
    return COMMAND_PRIORITY.ENABLE_STEP
  }
  if (p === "PERIODIC" || p === "PERIODIC_POSITION" || p === "POSITION") {
    return COMMAND_PRIORITY.PERIODIC_POSITION
  }
  return COMMAND_PRIORITY.PERIODIC_POSITION
}

/**
 * @param {{ maxControlPending?: number }} [opts]
 */
export function createCommandPriorityQueue(opts = {}) {
  const maxControlPending = Number(opts.maxControlPending) > 0 ? Number(opts.maxControlPending) : 64
  /** @type {Array<{ priority: string, frame: object, id?: string, meta?: object }>} */
  let controlQueue = []
  /** @type {{ priority: string, frame: object, id?: string, meta?: object }|null} */
  let periodicPending = null
  let droppedPeriodic = 0
  let submitted = 0
  let flushed = 0

  function submit({ priority, frame, id, replacePeriodic = true, meta } = {}) {
    if (!frame || typeof frame !== "object") {
      return { accepted: false, reason: "MISSING_FRAME" }
    }
    const p = normalizeCommandPriority(priority)
    submitted += 1
    if (p === COMMAND_PRIORITY.PERIODIC_POSITION) {
      if (periodicPending && replacePeriodic !== false) {
        droppedPeriodic += 1
      }
      periodicPending = { priority: p, frame, id, meta }
      return { accepted: true, replacedPeriodic: droppedPeriodic > 0, next: peekReady() }
    }
    if (controlQueue.length >= maxControlPending) {
      return { accepted: false, reason: "CONTROL_QUEUE_FULL" }
    }
    controlQueue.push({ priority: p, frame, id, meta })
    controlQueue.sort((a, b) => commandPriorityRank(b.priority) - commandPriorityRank(a.priority))
    return { accepted: true, next: peekReady() }
  }

  function peekReady() {
    if (controlQueue.length > 0) return controlQueue[0]
    return periodicPending
  }

  function takeNext() {
    if (controlQueue.length > 0) {
      const item = controlQueue.shift()
      flushed += 1
      return item
    }
    if (periodicPending) {
      const item = periodicPending
      periodicPending = null
      flushed += 1
      return item
    }
    return null
  }

  /**
   * Drain ready frames in priority order (control first, then at most one periodic).
   * @param {number} [max]
   */
  function drainReady(max = 32) {
    const out = []
    const n = Math.max(1, Number(max) || 32)
    while (out.length < n) {
      const item = takeNext()
      if (!item) break
      out.push(item)
    }
    return out
  }

  function clearPeriodic() {
    periodicPending = null
  }

  function clearAll() {
    controlQueue = []
    periodicPending = null
  }

  function getStats() {
    return {
      controlPending: controlQueue.length,
      periodicPending: periodicPending ? 1 : 0,
      droppedPeriodic,
      submitted,
      flushed,
    }
  }

  return {
    submit,
    takeNext,
    drainReady,
    peekReady,
    clearPeriodic,
    clearAll,
    getStats,
  }
}
