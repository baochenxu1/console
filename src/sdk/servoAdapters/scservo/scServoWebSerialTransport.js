/**
 * SCServo 二进制 WebSerial 传输层。
 *
 * - 拥有自己的 SerialPort（与 RJ_SBUS transport 独立）。
 * - 二进制收发；维护滚动接收缓冲，供 request() 解析返回包。
 * - 提供 raw tx / rx 日志回调，方便调试页面展示。
 */

import { parseStatusPacket, toHex } from "./scPacket.js"
import { DEFAULT_SC_BAUDRATE } from "./scProtocolConstants.js"

export class ScServoWebSerialTransport {
  constructor() {
    /** @type {SerialPort|null} */
    this.port = null
    this.reader = null
    this.writer = null

    this.connected = false
    this.keepReading = false
    this.readingTask = null
    this.baudRate = DEFAULT_SC_BAUDRATE

    this.txCount = 0
    this.rxCount = 0
    this.writeInFlight = false

    /** 滚动接收缓冲（number[]）。 */
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
    this.emitLog("INFO", "SCServo 串口已选择。")
    this.emitStatus()
    return this.port
  }

  /**
   * @param {{ baudRate?: number, requestPortIfNeeded?: boolean }} [options]
   */
  async open({ baudRate = DEFAULT_SC_BAUDRATE, requestPortIfNeeded = false } = {}) {
    if (!this.port) {
      if (requestPortIfNeeded) {
        await this.selectPort()
      } else {
        throw new Error("未选择串口：请先选择 SCServo 串口。")
      }
    }
    if (this.connected) {
      this.emitLog("WARN", "SCServo 串口已处于打开状态。")
      return
    }

    this.baudRate = Number(baudRate) || DEFAULT_SC_BAUDRATE
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

    this.emitLog("INFO", `SCServo 串口已打开，波特率：${this.baudRate}`)
    this.emitStatus()

    this.readingTask = this._startReadLoop()
  }

  async close({ releasePort = false } = {}) {
    this.keepReading = false
    if (this.reader) {
      try {
        await this.reader.cancel()
      } catch (error) {
        // ignore
      }
    }
    if (this.readingTask) {
      try {
        await this.readingTask
      } catch (error) {
        // ignore
      }
      this.readingTask = null
    }
    if (this.writer) {
      try {
        await this.writer.close()
      } catch (error) {
        // ignore
      }
      try {
        this.writer.releaseLock()
      } catch (error) {
        // ignore
      }
      this.writer = null
    }
    if (this.port) {
      try {
        await this.port.close()
      } catch (error) {
        this.emitLog("ERROR", `关闭 SCServo 串口失败：${error.message}`)
      }
    }
    this.connected = false
    if (releasePort) {
      this.port = null
    }
    this.emitLog("INFO", releasePort ? "SCServo 串口已关闭并释放端口。" : "SCServo 串口已关闭。")
    this.emitStatus()
  }

  /** 清空接收缓冲（在发起一次 request 前调用，避免旧字节干扰）。 */
  clearRxBuffer() {
    this._rxBuffer = []
  }

  /**
   * 仅写入（无应答场景，如 SyncWrite / 广播）。
   * @param {Uint8Array} bytes
   * @param {{ force?: boolean, txCapture?: string[] }} [options]
   * @returns {Promise<{ ok:boolean, dropped?:boolean, reason?:string, error?:string }>}
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
      this.emitLog("ERROR", `SCServo 写入失败：${msg}`)
      return { ok: false, error: msg }
    } finally {
      this.writeInFlight = false
    }
  }

  /**
   * 写入并等待一条状态返回包（用于 PING / READ）。
   * @param {Uint8Array} bytes 指令包。
   * @param {{ expectedId:number, timeoutMs?:number }} options
   * @returns {Promise<{ ok:boolean, reason?:string, error?:number, params?:number[], raw?:number[] }>}
   */
  async request(bytes, { expectedId, timeoutMs = 100 } = {}) {
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
      const parsed = parseStatusPacket(this._rxBuffer, { expectedId })
      if (parsed.ok) {
        if (typeof parsed.consumedUntil === "number") {
          this._rxBuffer = this._rxBuffer.slice(parsed.consumedUntil)
        }
        this.emitLog("RX", toHex(parsed.raw))
        return parsed
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
            // 限制缓冲上限，避免无限增长
            if (this._rxBuffer.length > 4096) {
              this._rxBuffer = this._rxBuffer.slice(this._rxBuffer.length - 4096)
            }
            this.rxCount += 1
          }
        }
      } catch (error) {
        if (this.keepReading) {
          this.emitLog("ERROR", `SCServo 读取失败：${error.message}`)
        }
      } finally {
        try {
          this.reader.releaseLock()
        } catch (error) {
          // ignore
        }
        this.reader = null
      }
    }
  }
}

/** 全局单例（SC Lab 与未来 Tracking 接入共用一条 SCServo 总线）。 */
export const scServoTransport = new ScServoWebSerialTransport()
