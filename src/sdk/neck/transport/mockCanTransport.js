/**
 * MockCanTransport — in-memory CanTransport for architecture / unit tests.
 * No serial I/O.
 */

import { assertCanTransport } from "./canTransport.js"

/**
 * @param {{ autoOpen?: boolean }} [options]
 */
export function createMockCanTransport(options = {}) {
  let state = options.autoOpen ? "open" : "closed"
  /** @type {Set<Function>} */
  const listeners = new Set()
  /** @type {object[]} */
  const sent = []
  /** @type {object[]} */
  const received = []

  const transport = {
    async open() {
      state = "open"
      return { ok: true }
    },

    async close() {
      state = "closed"
      return { ok: true }
    },

    /**
     * @param {object} frame
     */
    async sendFrame(frame) {
      if (state !== "open") {
        throw new Error("MockCanTransport is closed")
      }
      sent.push(frame)
      return { ok: true }
    },

    /**
     * @param {(frame: object) => void} callback
     * @returns {() => void} unsubscribe
     */
    onFrame(callback) {
      if (typeof callback !== "function") {
        throw new Error("onFrame requires a function")
      }
      listeners.add(callback)
      return () => listeners.delete(callback)
    },

    getState() {
      return {
        state,
        sentCount: sent.length,
        receivedCount: received.length,
      }
    },

    /** Test helper: inject RX frame */
    injectFrame(frame) {
      received.push(frame)
      for (const cb of listeners) cb(frame)
    },

    getSentFrames() {
      return [...sent]
    },

    getReceivedFrames() {
      return [...received]
    },

    clear() {
      sent.length = 0
      received.length = 0
    },
  }

  return assertCanTransport(transport)
}
