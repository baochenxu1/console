/**
 * WebSerialSlcanTransport — CanTransport over navigator.serial + SLCAN.
 *
 * Physical bring-up only (R3):
 *   - NO 100 Hz loop / Worker / auto enable
 *   - MUST NOT import motor protocol adapters, kinematics, pose/timeline, or core/
 *   - Knows only CanFrame ↔ SLCAN ↔ serial bytes
 */

import { CanTransportError, assertCanTransport } from "./canTransport.js"
import {
  encodeSlcanAscii,
  decodeSlcanAscii,
  buildSlcanOpenSequence,
  SlcanCodecError,
} from "./slcanCodec.js"
import { createSlcanStreamFramer } from "./slcanStreamFramer.js"
import { createSerialWriteQueue, SerialWriteQueueError } from "./serialWriteQueue.js"
import { detectWebSerialCapability, WEB_SERIAL_CAPABILITY } from "./webSerialCapability.js"
import {
  normalizeTransportConfig,
  rejectBrsConfig,
  createLuviaFdTransportConfig,
} from "./transportProfile.js"

export const WEB_SERIAL_TRANSPORT_STATE = Object.freeze({
  CLOSED: "CLOSED",
  OPENING: "OPENING",
  PORT_OPEN: "PORT_OPEN",
  SLCAN_INITIALIZING: "SLCAN_INITIALIZING",
  READY: "READY",
  CLOSING: "CLOSING",
  ERROR: "ERROR",
  DISCONNECTED: "DISCONNECTED",
})

/** Lines that are SLCAN control / ACK / version — not CAN frames. */
const CONTROL_LINE_RE = /^(z|Z|v|V|f|F|w|W|\?|\x07)$/

/**
 * @param {string} line
 * @returns {"can"|"control"|"malformed"|"empty"}
 */
export function classifySlcanLine(line) {
  const s = String(line ?? "")
  if (s.length === 0) return "empty"
  try {
    decodeSlcanAscii(s)
    return "can"
  } catch {
    if (CONTROL_LINE_RE.test(s) || /^[zZvVfFwW?]/.test(s)) return "control"
    return "malformed"
  }
}

/**
 * @param {{
 *   serial?: { requestPort: Function, getPorts: Function },
 *   requestPort?: Function,
 *   getPorts?: Function,
 *   baudRate?: number,
 *   dataBits?: number,
 *   stopBits?: number,
 *   parity?: string,
 *   flowControl?: string,
 *   transportProfile?: object,
 *   maxWriteQueue?: number,
 *   isSecureContext?: boolean,
 *   navigator?: object,
 * }} [options]
 */
export function createWebSerialSlcanTransport(options = {}) {
  const baudRate = Number(options.baudRate ?? 115200)
  const dataBits = Number(options.dataBits ?? 8)
  const stopBits = Number(options.stopBits ?? 1)
  const parity = options.parity ?? "none"
  const flowControl = options.flowControl ?? "none"
  const maxWriteQueue = Number(options.maxWriteQueue ?? 32)

  let transportProfile
  try {
    transportProfile = options.transportProfile
      ? normalizeTransportConfig(options.transportProfile)
      : createLuviaFdTransportConfig()
    rejectBrsConfig(transportProfile)
  } catch (err) {
    throw new CanTransportError(
      err?.message || "invalid transport profile",
      err?.code || "INVALID_PROFILE"
    )
  }

  const capability = detectWebSerialCapability({
    navigator: options.navigator,
    isSecureContext: options.isSecureContext,
  })

  /** @type {string} */
  let state = WEB_SERIAL_TRANSPORT_STATE.CLOSED
  /** @type {object|null} */
  let port = null
  /** @type {ReadableStreamDefaultReader|null} */
  let reader = null
  /** @type {WritableStreamDefaultWriter|null} */
  let writer = null
  /** @type {ReturnType<typeof createSerialWriteQueue>|null} */
  let writeQueue = null
  const framer = createSlcanStreamFramer()
  /** @type {Set<Function>} */
  const frameListeners = new Set()
  /** @type {Set<Function>} */
  const controlListeners = new Set()
  /** @type {Set<Function>} */
  const diagnosticListeners = new Set()

  let rxLoopActive = false
  let rxLoopPromise = null
  let openGeneration = 0

  const counters = {
    txFrames: 0,
    rxFrames: 0,
    txBytes: 0,
    rxLines: 0,
    controlLines: 0,
    malformedLines: 0,
  }

  /** @type {object|null} */
  let lastTxFrame = null
  /** @type {object|null} */
  let lastRxFrame = null
  /** @type {string|null} */
  let lastLine = null
  /** @type {{ code?: string, message?: string }|null} */
  let lastError = null
  /** @type {object|null} */
  let portInfo = null

  function setError(code, message) {
    lastError = { code, message: String(message || code) }
  }

  function getSerialApi() {
    if (options.serial) return options.serial
    const nav =
      options.navigator !== undefined
        ? options.navigator
        : typeof globalThis !== "undefined"
          ? globalThis.navigator
          : null
    return nav?.serial || null
  }

  async function requestPort(filters) {
    if (typeof options.requestPort === "function") {
      return options.requestPort(filters)
    }
    const serial = getSerialApi()
    if (!serial?.requestPort) {
      throw new CanTransportError("Web Serial requestPort unavailable", "UNSUPPORTED")
    }
    return serial.requestPort(filters)
  }

  async function getPorts() {
    if (typeof options.getPorts === "function") {
      return options.getPorts()
    }
    const serial = getSerialApi()
    if (!serial?.getPorts) return []
    return serial.getPorts()
  }

  function notifyFrame(frame) {
    for (const cb of frameListeners) {
      try {
        cb(frame)
      } catch {
        /* subscriber errors must not kill RX loop */
      }
    }
  }

  function notifyControl(line) {
    for (const cb of controlListeners) {
      try {
        cb(line)
      } catch {
        /* ignore */
      }
    }
  }

  function notifyDiagnostic(entry) {
    for (const cb of diagnosticListeners) {
      try {
        cb(entry)
      } catch {
        /* ignore */
      }
    }
  }

  function handleRxLine(line) {
    lastLine = line
    counters.rxLines += 1
    const kind = classifySlcanLine(line)
    if (kind === "empty") return
    if (kind === "can") {
      try {
        const frame = decodeSlcanAscii(line)
        lastRxFrame = frame
        counters.rxFrames += 1
        notifyFrame(frame)
      } catch (err) {
        counters.malformedLines += 1
        notifyDiagnostic({ kind: "malformed", line, error: String(err?.message || err) })
      }
      return
    }
    if (kind === "control") {
      counters.controlLines += 1
      notifyControl(line)
      return
    }
    counters.malformedLines += 1
    notifyDiagnostic({ kind: "malformed", line })
  }

  async function stopRxLoop() {
    rxLoopActive = false
    const r = reader
    reader = null
    if (r) {
      try {
        await r.cancel()
      } catch {
        /* ignore */
      }
      try {
        r.releaseLock()
      } catch {
        /* ignore */
      }
    }
  }

  async function awaitRxLoopSettled() {
    const loop = rxLoopPromise
    rxLoopPromise = null
    if (!loop) return
    try {
      await loop
    } catch {
      /* ignore */
    }
  }

  async function cleanupPort({ nextState = WEB_SERIAL_TRANSPORT_STATE.CLOSED, awaitLoop = false } = {}) {
    const gen = openGeneration
    rxLoopActive = false

    await stopRxLoop()

    if (writeQueue) {
      try {
        await writeQueue.close()
      } catch {
        /* ignore */
      }
      writeQueue = null
    }
    writer = null

    const p = port
    if (p && typeof p.close === "function") {
      try {
        await p.close()
      } catch {
        /* ignore */
      }
    }

    framer.clear()

    if (awaitLoop) {
      await awaitRxLoopSettled()
    } else {
      // Drop reference so a later close() can still await if needed; do not
      // await here — cleanup may run inside the RX loop (would deadlock).
      rxLoopPromise = null
    }

    if (gen === openGeneration) {
      state = nextState
    }
  }

  async function runRxLoop(generation) {
    while (rxLoopActive && generation === openGeneration && reader) {
      let result
      try {
        result = await reader.read()
      } catch (err) {
        if (!rxLoopActive || generation !== openGeneration) return
        setError("READ_FAILED", err?.message || "serial read failed")
        await cleanupPort({ nextState: WEB_SERIAL_TRANSPORT_STATE.DISCONNECTED })
        return
      }
      if (!rxLoopActive || generation !== openGeneration) return
      if (result.done) {
        setError("DISCONNECTED", "serial readable closed")
        await cleanupPort({ nextState: WEB_SERIAL_TRANSPORT_STATE.DISCONNECTED })
        return
      }
      const lines = framer.feed(result.value)
      for (const line of lines) handleRxLine(line)
    }
  }

  function startRxLoop(generation) {
    rxLoopActive = true
    rxLoopPromise = runRxLoop(generation).catch((err) => {
      if (generation !== openGeneration) return
      setError("RX_LOOP", err?.message || String(err))
      state = WEB_SERIAL_TRANSPORT_STATE.ERROR
    })
  }

  /**
   * @param {{ port?: object }} [openOpts]
   */
  async function open(openOpts = {}) {
    if (
      state === WEB_SERIAL_TRANSPORT_STATE.READY ||
      state === WEB_SERIAL_TRANSPORT_STATE.OPENING ||
      state === WEB_SERIAL_TRANSPORT_STATE.SLCAN_INITIALIZING ||
      state === WEB_SERIAL_TRANSPORT_STATE.PORT_OPEN
    ) {
      throw new CanTransportError(`cannot open from state ${state}`, "INVALID_STATE")
    }

    if (!capability.supported && !options.serial && !openOpts.port) {
      throw new CanTransportError(
        capability.message || "Web Serial unsupported",
        capability.state === WEB_SERIAL_CAPABILITY.INSECURE_CONTEXT
          ? "INSECURE_CONTEXT"
          : "UNSUPPORTED"
      )
    }

    openGeneration += 1
    const generation = openGeneration
    state = WEB_SERIAL_TRANSPORT_STATE.OPENING
    lastError = null
    framer.clear()

    try {
      // Prefer explicit openOpts.port, then port already chosen via selectPort().
      let selected = openOpts.port || port || null
      if (!selected) {
        // Last resort: chooser (must be called from a user-gesture click path).
        selected = await requestPort()
      }
      if (!selected) {
        throw new CanTransportError("no serial port selected", "NO_PORT")
      }
      port = selected
      try {
        portInfo = typeof port.getInfo === "function" ? port.getInfo() : null
      } catch {
        portInfo = null
      }

      await port.open({
        baudRate,
        dataBits,
        stopBits,
        parity,
        flowControl,
      })
      if (generation !== openGeneration) return { ok: false, aborted: true }
      state = WEB_SERIAL_TRANSPORT_STATE.PORT_OPEN

      writer = port.writable.getWriter()
      writeQueue = createSerialWriteQueue({ writer, maxQueue: maxWriteQueue })

      reader = port.readable.getReader()
      framer.clear()
      startRxLoop(generation)

      state = WEB_SERIAL_TRANSPORT_STATE.SLCAN_INITIALIZING
      const sequence = buildSlcanOpenSequence({ withCr: true })
      for (const cmd of sequence) {
        if (generation !== openGeneration) return { ok: false, aborted: true }
        // Each line ends with CR only (0x0d) — never LF / CRLF.
        const bytes = new TextEncoder().encode(cmd)
        counters.txBytes += bytes.length
        await writeQueue.enqueue(bytes)
      }

      if (generation !== openGeneration) return { ok: false, aborted: true }
      state = WEB_SERIAL_TRANSPORT_STATE.READY
      return { ok: true }
    } catch (err) {
      const code =
        err?.code ||
        (err instanceof SerialWriteQueueError ? err.code : null) ||
        "OPEN_FAILED"
      setError(code, err?.message || String(err))
      try {
        await cleanupPort({ nextState: WEB_SERIAL_TRANSPORT_STATE.ERROR })
      } catch {
        state = WEB_SERIAL_TRANSPORT_STATE.ERROR
      }
      throw new CanTransportError(lastError.message, lastError.code)
    }
  }

  async function close() {
    if (
      state === WEB_SERIAL_TRANSPORT_STATE.CLOSED ||
      state === WEB_SERIAL_TRANSPORT_STATE.CLOSING
    ) {
      state = WEB_SERIAL_TRANSPORT_STATE.CLOSED
      return { ok: true }
    }
    openGeneration += 1
    state = WEB_SERIAL_TRANSPORT_STATE.CLOSING
    try {
      await cleanupPort({
        nextState: WEB_SERIAL_TRANSPORT_STATE.CLOSED,
        awaitLoop: true,
      })
    } catch (err) {
      setError("CLOSE_FAILED", err?.message || String(err))
      state = WEB_SERIAL_TRANSPORT_STATE.CLOSED
    }
    return { ok: true }
  }

  /**
   * @param {object} canFrame
   */
  async function sendFrame(canFrame) {
    if (state !== WEB_SERIAL_TRANSPORT_STATE.READY) {
      throw new CanTransportError(
        `sendFrame requires READY (state=${state})`,
        "NOT_READY"
      )
    }
    if (!writeQueue) {
      throw new CanTransportError("writer unavailable", "NO_WRITER")
    }
    if (canFrame?.brs === true || canFrame?.bitrateSwitch === true) {
      throw new CanTransportError(
        "production neck transport forbids brs=true",
        "BRS_FORBIDDEN"
      )
    }

    let ascii
    try {
      ascii = encodeSlcanAscii(canFrame)
    } catch (err) {
      throw new CanTransportError(
        err?.message || "SLCAN encode failed",
        err?.code || "ENCODE_FAILED"
      )
    }
    const line = `${ascii}\r`
    const bytes = new TextEncoder().encode(line)
    try {
      await writeQueue.enqueue(bytes)
    } catch (err) {
      setError(err?.code || "WRITE_FAILED", err?.message || String(err))
      if (err?.code === "QUEUE_FULL") {
        throw new CanTransportError(err.message, "QUEUE_FULL")
      }
      await cleanupPort({ nextState: WEB_SERIAL_TRANSPORT_STATE.ERROR })
      throw new CanTransportError(lastError.message, lastError.code || "WRITE_FAILED")
    }
    lastTxFrame = canFrame
    counters.txFrames += 1
    counters.txBytes += bytes.length
    return { ok: true, slcanLine: ascii }
  }

  function onFrame(callback) {
    if (typeof callback !== "function") {
      throw new CanTransportError("onFrame requires a function", "INVALID_CALLBACK")
    }
    frameListeners.add(callback)
    return () => frameListeners.delete(callback)
  }

  function onControlLine(callback) {
    if (typeof callback !== "function") {
      throw new CanTransportError("onControlLine requires a function", "INVALID_CALLBACK")
    }
    controlListeners.add(callback)
    return () => controlListeners.delete(callback)
  }

  function onDiagnostic(callback) {
    if (typeof callback !== "function") {
      throw new CanTransportError("onDiagnostic requires a function", "INVALID_CALLBACK")
    }
    diagnosticListeners.add(callback)
    return () => diagnosticListeners.delete(callback)
  }

  /**
   * Explicit user-gesture port chooser (does not open).
   */
  async function selectPort(filters) {
    const selected = await requestPort(filters)
    port = selected
    try {
      portInfo = typeof selected?.getInfo === "function" ? selected.getInfo() : null
    } catch {
      portInfo = null
    }
    return selected
  }

  function getState() {
    const serialOpen = Boolean(
      port &&
        (state === WEB_SERIAL_TRANSPORT_STATE.PORT_OPEN ||
          state === WEB_SERIAL_TRANSPORT_STATE.SLCAN_INITIALIZING ||
          state === WEB_SERIAL_TRANSPORT_STATE.READY)
    )
    return {
      state,
      portSelected: Boolean(port),
      portInfo: portInfo ? { ...portInfo } : null,
      serialOpen,
      slcanReady: state === WEB_SERIAL_TRANSPORT_STATE.READY,
      canMode: transportProfile.can?.mode || "fd",
      brs: Boolean(transportProfile.can?.brs),
      baudRate,
      dataBits,
      stopBits,
      parity,
      flowControl,
      capability,
      counters: { ...counters },
      lastTxFrame,
      lastRxFrame,
      lastLine,
      lastError: lastError ? { ...lastError } : null,
      writeQueueSize: writeQueue?.size ?? 0,
      maxWriteQueue,
    }
  }

  const transport = {
    open,
    close,
    sendFrame,
    onFrame,
    onControlLine,
    onDiagnostic,
    selectPort,
    getPorts,
    getState,
    /** Test / wiring helper */
    getPort() {
      return port
    },
  }

  return assertCanTransport(transport)
}

export { CanTransportError, SlcanCodecError }
