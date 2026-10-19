/**
 * Serial write queue — single writer authority for Web Serial writable.
 * Sequential flush; bounded capacity; releases writer lock on close.
 */

export class SerialWriteQueueError extends Error {
  constructor(message, code = "SERIAL_WRITE_QUEUE_ERROR") {
    super(message)
    this.name = "SerialWriteQueueError"
    this.code = code
  }
}

/**
 * @param {{
 *   writer: { write: (chunk: Uint8Array) => Promise<void>, releaseLock?: () => void, close?: () => Promise<void> },
 *   maxQueue?: number,
 * }} options
 */
export function createSerialWriteQueue(options = {}) {
  const maxQueue = Number.isFinite(Number(options.maxQueue))
    ? Math.max(1, Math.trunc(Number(options.maxQueue)))
    : 32
  let writer = options.writer || null
  /** @type {Uint8Array[]} */
  const queue = []
  let flushing = false
  let closed = false
  /** @type {Promise<void>|null} */
  let flushPromise = null

  function ensureOpen() {
    if (closed || !writer) {
      throw new SerialWriteQueueError("write queue closed", "QUEUE_CLOSED")
    }
  }

  function toBytes(data) {
    if (data instanceof Uint8Array) return data
    if (typeof data === "string") return new TextEncoder().encode(data)
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    }
    if (data instanceof ArrayBuffer) return new Uint8Array(data)
    throw new SerialWriteQueueError("enqueue requires bytes or string", "INVALID_BYTES")
  }

  async function runFlush() {
    while (!closed && queue.length > 0 && writer) {
      const next = queue.shift()
      try {
        await writer.write(next)
      } catch (err) {
        queue.length = 0
        throw err
      }
    }
  }

  function kickFlush() {
    if (flushing) return flushPromise
    flushing = true
    flushPromise = runFlush()
      .finally(() => {
        flushing = false
        flushPromise = null
      })
    return flushPromise
  }

  return {
    get size() {
      return queue.length
    },

    get maxQueue() {
      return maxQueue
    },

    get closed() {
      return closed
    },

    /**
     * Replace writer (e.g. after reopen). Does not reset closed flag — use reopen().
     * @param {object} nextWriter
     */
    setWriter(nextWriter) {
      if (closed) {
        throw new SerialWriteQueueError("cannot setWriter on closed queue", "QUEUE_CLOSED")
      }
      writer = nextWriter
    },

    /**
     * Enqueue one write; returns promise that settles when this item (and prior) flushed.
     * @param {Uint8Array|string|ArrayBufferView|ArrayBuffer} data
     */
    enqueue(data) {
      ensureOpen()
      if (queue.length >= maxQueue) {
        throw new SerialWriteQueueError(
          `write queue full (max=${maxQueue})`,
          "QUEUE_FULL"
        )
      }
      const bytes = toBytes(data)
      queue.push(bytes)
      return kickFlush()
    },

    /** Drain remaining items. */
    flush() {
      if (closed) return Promise.resolve()
      return kickFlush() || Promise.resolve()
    },

    /**
     * Reject further enqueues, clear pending, release writer lock.
     * Idempotent.
     */
    async close() {
      if (closed) return
      closed = true
      queue.length = 0
      const w = writer
      writer = null
      if (w && typeof w.releaseLock === "function") {
        try {
          w.releaseLock()
        } catch {
          /* already released */
        }
      }
    },

    /**
     * Re-arm after close for a new session (tests / reopen).
     * @param {object} nextWriter
     */
    reopen(nextWriter) {
      closed = false
      queue.length = 0
      writer = nextWriter
      flushing = false
      flushPromise = null
    },
  }
}
