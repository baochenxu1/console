/**
 * Mock SerialPort + streams for automated Web Serial transport tests.
 * Captures TX writes; allows injecting RX chunks without real navigator.serial.
 * Streams are (re)created on each successful open() so reopen tests work.
 */

function toUint8Array(chunk) {
  if (chunk instanceof Uint8Array) return chunk
  if (typeof chunk === "string") return new TextEncoder().encode(chunk)
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  }
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk)
  throw new TypeError("MockSerialPort expects Uint8Array or string chunks")
}

/**
 * @param {{ failOpen?: boolean|Error|(() => Error), failWrite?: boolean|Error|(() => Error), failRead?: boolean|Error|(() => Error) }} [options]
 */
export function createMockSerialPort(options = {}) {
  /** @type {(Uint8Array)[]} */
  const writes = []
  let opened = false
  /** @type {object|null} */
  let openOptions = null
  let disconnectRequested = false
  /** @type {ReadableStream<Uint8Array>|null} */
  let readable = null
  /** @type {WritableStream<Uint8Array>|null} */
  let writable = null
  /** @type {ReadableStreamDefaultController<Uint8Array>|null} */
  let rxController = null
  let readableLocked = false
  let writableLocked = false
  let failReadArmed = false

  function resolveFail(spec) {
    if (!spec) return null
    if (typeof spec === "function") return spec()
    if (spec instanceof Error) return spec
    return new Error(String(spec === true ? "mock serial failure" : spec))
  }

  function buildStreams() {
    failReadArmed = Boolean(options.failRead)
    readableLocked = false
    writableLocked = false
    rxController = null

    readable = new ReadableStream({
      start(controller) {
        rxController = controller
      },
      pull(controller) {
        if (failReadArmed) {
          failReadArmed = false
          const err = resolveFail(options.failRead) || new Error("mock read failure")
          controller.error(err)
          rxController = null
        }
      },
      cancel() {
        rxController = null
      },
    })

    writable = new WritableStream({
      write(chunk) {
        if (!opened) {
          return Promise.reject(new Error("MockSerialPort not open"))
        }
        const fail = resolveFail(options.failWrite)
        if (fail) return Promise.reject(fail)
        const bytes = toUint8Array(chunk)
        writes.push(bytes.slice())
        return Promise.resolve()
      },
      close() {
        return Promise.resolve()
      },
      abort() {
        return Promise.resolve()
      },
    })

    const originalGetReader = readable.getReader.bind(readable)
    readable.getReader = (...args) => {
      readableLocked = true
      const reader = originalGetReader(...args)
      const origRelease = reader.releaseLock.bind(reader)
      reader.releaseLock = () => {
        readableLocked = false
        return origRelease()
      }
      const origCancel = reader.cancel?.bind(reader)
      if (origCancel) {
        reader.cancel = async (...a) => {
          readableLocked = false
          return origCancel(...a)
        }
      }
      return reader
    }

    const originalGetWriter = writable.getWriter.bind(writable)
    writable.getWriter = (...args) => {
      writableLocked = true
      const writer = originalGetWriter(...args)
      const origRelease = writer.releaseLock.bind(writer)
      writer.releaseLock = () => {
        writableLocked = false
        return origRelease()
      }
      return writer
    }
  }

  // Pre-create closed placeholder streams so property access is safe before open.
  buildStreams()
  // Not open yet — discard first stream pair until open().
  readable = null
  writable = null
  rxController = null

  const port = {
    get readable() {
      if (!readable) throw new Error("MockSerialPort readable unavailable (not open)")
      return readable
    },
    get writable() {
      if (!writable) throw new Error("MockSerialPort writable unavailable (not open)")
      return writable
    },
    get opened() {
      return opened
    },
    getInfo() {
      return { usbVendorId: 0x1d50, usbProductId: 0x606f }
    },

    async open(opts = {}) {
      if (opened) {
        throw new Error("MockSerialPort already open")
      }
      const fail = resolveFail(options.failOpen)
      if (fail) throw fail
      openOptions = { ...opts }
      buildStreams()
      opened = true
      disconnectRequested = false
    },

    async close() {
      if (!opened && !readable && !writable) return
      opened = false
      if (rxController) {
        try {
          rxController.close()
        } catch {
          /* already closed/errored */
        }
        rxController = null
      }
      readable = null
      writable = null
    },

    /**
     * Inject RX bytes (Uint8Array or string).
     * @param {Uint8Array|string} chunk
     */
    injectRx(chunk) {
      if (!rxController) {
        throw new Error("MockSerialPort RX not available")
      }
      rxController.enqueue(toUint8Array(chunk))
    },

    /** Simulate USB unplug / disconnect (errors the readable stream). */
    disconnect() {
      disconnectRequested = true
      opened = false
      if (rxController) {
        try {
          rxController.error(new Error("device disconnected"))
        } catch {
          /* already closed */
        }
        rxController = null
      }
    },

    getWrites() {
      return writes.map((w) => w.slice())
    },

    getWriteStrings() {
      const dec = new TextDecoder()
      return this.getWrites().map((w) => dec.decode(w))
    },

    clearWrites() {
      writes.length = 0
    },

    getOpenOptions() {
      return openOptions ? { ...openOptions } : null
    },

    isReadableLocked() {
      return readableLocked
    },

    isWritableLocked() {
      return writableLocked
    },

    wasDisconnected() {
      return disconnectRequested
    },

    /** Arm next read to fail (after open). */
    armFailRead() {
      failReadArmed = true
    },

    /** Arm next write to fail. */
    setFailWrite(spec) {
      options.failWrite = spec
    },
  }

  return port
}

/**
 * Mock navigator.serial facade for tests.
 * @param {{ ports?: object[], requestPortImpl?: Function }} [options]
 */
export function createMockSerial(options = {}) {
  /** @type {object[]} */
  const ports = Array.isArray(options.ports) ? [...options.ports] : []
  let lastRequested = null

  return {
    async requestPort(filters) {
      if (typeof options.requestPortImpl === "function") {
        const p = await options.requestPortImpl(filters)
        lastRequested = p
        if (p && !ports.includes(p)) ports.push(p)
        return p
      }
      const p = ports[0] || createMockSerialPort()
      if (!ports.includes(p)) ports.push(p)
      lastRequested = p
      return p
    },

    async getPorts() {
      return [...ports]
    },

    addPort(port) {
      if (!ports.includes(port)) ports.push(port)
    },

    getLastRequested() {
      return lastRequested
    },
  }
}

export { createMockSerialPort as MockSerialPort }
