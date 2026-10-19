/**
 * Page-level singleton for WebSerialSlcanTransport.
 * Prevents React remount from creating ghost reader/writer instances.
 */

import { createWebSerialSlcanTransport } from "./webSerialSlcanTransport.js"

/** @type {ReturnType<typeof createWebSerialSlcanTransport>|null} */
let _shared = null
let _refCount = 0
/** @type {Set<(state: object|null) => void>} */
const _listeners = new Set()
/** @type {ReturnType<typeof setInterval>|null} */
let _pollTimer = null

function emitState() {
  const state = _shared ? _shared.getState() : null
  for (const cb of _listeners) {
    try {
      cb(state)
    } catch {
      //
    }
  }
}

function ensurePoll() {
  if (_pollTimer || _listeners.size === 0) return
  _pollTimer = setInterval(() => emitState(), 250)
}

function stopPollIfIdle() {
  if (_listeners.size > 0) return
  if (_pollTimer) {
    clearInterval(_pollTimer)
    _pollTimer = null
  }
}

/**
 * Acquire the shared Browser SLCAN transport (create once per tab).
 * @param {object} [options] forwarded only on first create
 */
export function getSharedBrowserSlcanTransport(options = {}) {
  if (!_shared) {
    _shared = createWebSerialSlcanTransport(options)
    _refCount = 0
  }
  _refCount += 1
  return _shared
}

/**
 * Release a shared reference. Last release closes the port and clears the singleton.
 */
export async function releaseSharedBrowserSlcanTransport() {
  if (!_shared) return
  _refCount = Math.max(0, _refCount - 1)
  if (_refCount === 0) {
    const t = _shared
    _shared = null
    try {
      await t.close?.()
    } catch {
      //
    }
    emitState()
  }
}

/** @returns {ReturnType<typeof createWebSerialSlcanTransport>|null} */
export function peekSharedBrowserSlcanTransport() {
  return _shared
}

export function getSharedBrowserSlcanRefCount() {
  return _refCount
}

/**
 * Subscribe to transport.getState() snapshots (polled while listeners exist).
 * @param {(state: object|null) => void} callback
 * @returns {() => void}
 */
export function subscribeBrowserSlcanState(callback) {
  if (typeof callback !== "function") {
    throw new Error("subscribeBrowserSlcanState requires a function")
  }
  _listeners.add(callback)
  ensurePoll()
  try {
    callback(_shared ? _shared.getState() : null)
  } catch {
    //
  }
  return () => {
    _listeners.delete(callback)
    stopPollIfIdle()
  }
}

/** Push a fresh getState() to subscribers (after Select/Open/Close/TX). */
export function notifyBrowserSlcanState() {
  emitState()
}

/** Test helper — force-clear singleton without waiting for refs. */
export async function _resetSharedBrowserSlcanTransportForTest() {
  if (_pollTimer) {
    clearInterval(_pollTimer)
    _pollTimer = null
  }
  _listeners.clear()
  const t = _shared
  _shared = null
  _refCount = 0
  if (t) {
    try {
      await t.close?.()
    } catch {
      //
    }
  }
}
