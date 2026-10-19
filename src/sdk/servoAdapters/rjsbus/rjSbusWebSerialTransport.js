/**
 * 锐捷 RJ_SBUS 二进制 WebSerial 传输层。
 *
 * 与 SCServo 传输层独立：帧格式、默认波特率（115200）均不同，不可混用解析器。
 */

import { parseResponsePacket, toHex } from "./rjSbusPacket.js"
import { DEFAULT_RJ_BAUDRATE } from "./rjSbusConstants.js"

export class RjSbusWebSerialTransport {
  constructor() {
    /** @type {SerialPort|null} */
    this.port = null
    this.reader = null
    this.writer = null

    this.connected = false
    this.keepReading = false
    this.readingTask = null
    this.baudRate = DEFAULT_RJ_BAUDRATE

    this.txCount = 0
    this.rxCount = 0
    this.writeInFlight = false

    /** @type {number[]} */
    this._rxBuffer = []

    this.onStatus = null
    this.onLog = null
  }

  isSupported() {
    return typeof navigator !== "undefined" && "serial" in navigator
  }

  setCallbacks({ onStatus, onLog } = {}) {
    this.onStatus = onStatus || null
    this.onLog = onLog || null
    this.emitStatus()
  }

  getStatus() {
    return {
      supported: this.isSupported(),
      portSelected: Boolean(this.port),
      connected: this.connected,
      baudRate: this.baudRate,
      txCount: this.txCount,
      rxCount: this.rxCount,
    }
  }

  emitStatus() {
    if (typeof this.onStatus === "function") {
      this.onStatus(this.getStatus())
    }
  }

  emitLog(level, message) {
    if (typeof this.onLog === "function") {
      this.onLog({ level, message, time: new Date().toLocaleTimeString() })
    }
  }

  async selectPort() {
    if (!this.isSupported()) {
      throw new Error("当前浏览器不支持 Web Serial API，请使用 Chrome 或 Edge。")
    }
    this.port = await navigator.serial.requestPort()
    this.emitLog("INFO", "RJ_SBUS 串口已选择。")
    this.emitStatus()
    return this.port
  }

  /**
   * @param {{ baudRate?: number, requestPortIfNeeded?: boolean }} [options]
   */
  async open({ baudRate = DEFAULT_RJ_BAUDRATE, requestPortIfNeeded = false } = {}) {
    if (!this.port) {
      if (requestPortIfNeeded) {
        await this.selectPort()
      } else {
        throw new Error("未选择串口：请先选择 RJ_SBUS 串口。")
      }
    }
    if (this.connected) {
      this.emitLog("WARN", "RJ_SBUS 串口已处于打开状态。")
      return
    }

    this.baudRate = Number(baudRate) || DEFAULT_RJ_BAUDRATE
    await this.port.open({
      baudRate: this.baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none",
    })

    this.writer = this.port.writable.getWriter()
    this.connected = true
    this.keepReading = true
    this._rxBuffer = []

    this.emitLog("INFO", `RJ_SBUS 串口已打开，波特率：${this.baudRate}`)
    this.emitStatus()

    this.readingTask = this._startReadLoop()
  }

  async close({ releasePort = false } = {}) {
    this.keepReading = false
    if (this.reader) {
      try {
        await this.reader.cancel()
      } catch {
        // ignore
      }
    }
    if (this.readingTask) {
      try {
        await this.readingTask
      } catch {
        // ignore
      }
      this.readingTask = null
    }
    if (this.writer) {
      try {
        await this.writer.close()
      } catch {
        // ignore
      }
      try {
        this.writer.releaseLock()
      } catch {
        // ignore
      }
      this.writer = null
    }
    if (this.port) {
      try {
        await this.port.close()
      } catch (error) {
        this.emitLog("ERROR", `关闭 RJ_SBUS 串口失败：${error.message}`)
      }
    }
    this.connected = false
    if (releasePort) {
      this.port = null
    }
    this.emitLog("INFO", releasePort ? "RJ_SBUS 串口已关闭并释放端口。" : "RJ_SBUS 串口已关闭。")
    this.emitStatus()
  }

  clearRxBuffer() {
    this._rxBuffer = []
  }

  /**
   * @param {Uint8Array} bytes
   * @param {{ force?: boolean, txCapture?: string[] }} [options]
   */
  async write(bytes, { force = true, txCapture } = {}) {
    if (!this.connected || !this.writer) {
      return { ok: false, reason: "not-connected" }
    }
    if (!bytes || bytes.length === 0) {
      return { ok: false, reason: "empty" }
    }
    if (this.writeInFlight) {
      if (force) {
        while (this.writeInFlight) {
          await new Promise((resolve) => setTimeout(resolve, 1))
        }
      } else {
        return { ok: false, dropped: true, reason: "busy" }
      }
    }
    this.writeInFlight = true
    try {
      const payload = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes)
      await this.writer.write(payload)
      this.txCount += 1
      const hex = toHex(payload)
      if (Array.isArray(txCapture)) {
        txCapture.push(hex)
      }
      this.emitLog("TX", hex)
      this.emitStatus()
      return { ok: true }
    } catch (error) {
      const msg = error?.message || String(error)
      this.emitLog("ERROR", `RJ_SBUS 写入失败：${msg}`)
      return { ok: false, error: msg }
    } finally {
      this.writeInFlight = false
    }
  }

  /**
   * 写入并等待一条响应包。
   * @param {Uint8Array} bytes
   * @param {{ expectedId?:number, expectedCmd?:number, timeoutMs?:number }} [options]
   */
  async request(bytes, { expectedId, expectedCmd, timeoutMs = 100 } = {}) {
    if (!this.connected || !this.writer) {
      return { ok: false, reason: "not-connected" }
    }
    this.clearRxBuffer()
    const w = await this.write(bytes)
    if (!w.ok) {
      return { ok: false, reason: w.reason || "tx-fail", error: w.error }
    }

    const deadline = Date.now() + Math.max(10, timeoutMs)
    while (Date.now() < deadline) {
      const parsed = parseResponsePacket(this._rxBuffer, { expectedId, expectedCmd })
      if (parsed.ok) {
        if (typeof parsed.consumedUntil === "number") {
          this._rxBuffer = this._rxBuffer.slice(parsed.consumedUntil)
        }
        this.emitLog("RX", toHex(parsed.raw))
        return parsed
      }
      if (parsed.reason === "incomplete") {
        await new Promise((resolve) => setTimeout(resolve, 2))
        continue
      }
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    return { ok: false, reason: "timeout" }
  }

  async _startReadLoop() {
    if (!this.port || !this.port.readable) {
      return
    }
    while (this.keepReading && this.port.readable) {
      this.reader = this.port.readable.getReader()
      try {
        while (this.keepReading) {
          const { value, done } = await this.reader.read()
          if (done) break
          if (value && value.length) {
            for (let i = 0; i < value.length; i += 1) {
              this._rxBuffer.push(value[i])
            }
            if (this._rxBuffer.length > 4096) {
              this._rxBuffer = this._rxBuffer.slice(this._rxBuffer.length - 4096)
            }
            this.rxCount += 1
          }
        }
      } catch (error) {
        if (this.keepReading) {
          this.emitLog("ERROR", `RJ_SBUS 读取失败：${error.message}`)
        }
      } finally {
        try {
          this.reader.releaseLock()
        } catch {
          // ignore
        }
        this.reader = null
      }
    }
  }
}

/** 全局单例（RJ_SBUS 独立物理链路）。 */
export const rjSbusTransport = new RjSbusWebSerialTransport()
