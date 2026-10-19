/**
 * 锐捷 RJ_SBUS 适配器。
 *
 * 协议层能力（本阶段）：
 * - ping / scan（PING 逐 ID）
 * - writeAngle / writePosition（角度模式 cmd 8 / 11）
 * - readAngle / readPosition
 * - readData / writeData
 * - resetUserData / clearProtect / restart
 * - 电机测试 / SCAN 调试指令
 *
 * 说明：
 * - RJ 无 SyncWrite；syncWritePositions 退化为顺序单写。
 * - 角度控制默认无应答（取决于 response_switch）；timeout 时仍视为已发出。
 * - writePosition 的 position 语义为有符号 0.1° ticks（中位 0；模型窗 -900～+900）。
 * - 默认安全窗对应机构 0°～180°（中位 ±90°）→ 协议 ticks -900 / 0 / +900。
 */

import { ServoAdapter, clampInt } from "../core/servoAdapter.js"
import { PROTOCOL } from "../core/servoTypes.js"
import {
  CMD,
  MAX_ID,
  ANGLE_TICK_MIN,
  ANGLE_TICK_MAX,
  DATA_ID,
  baudBpsFromOptionCode,
  baudOptionCodeFromInput,
} from "./rjSbusConstants.js"
import {
  buildPing,
  buildResetUserData,
  buildReadData,
  buildWriteData,
  buildMoveOnAngleMode,
  buildMoveOnAngleModeExByInterval,
  buildReadAngle,
  buildRestart,
  buildClearProtectStatus,
  buildMotorTestForward,
  buildMotorTestReversal,
  buildScan,
  buildReadBatchDataA,
  buildWriteBatchDataA,
  buildReadBatchDataB,
  buildWriteBatchDataB,
} from "./rjSbusPacket.js"
import {
  clampAngleTicks,
  degreesToAngleTicks,
  encodeDataValue,
  angleTicksFromAdc,
  parseReadAngleContent,
  parseIdRetContent,
  parseReadDataContent,
} from "./rjSbusCodec.js"
import { rjSbusTransport } from "./rjSbusWebSerialTransport.js"

export function isValidRjServoId(id) {
  return Number.isInteger(id) && id >= 0 && id <= MAX_ID
}

function validateAngleWrite({ id, angleTicks, min = ANGLE_TICK_MIN, max = ANGLE_TICK_MAX }) {
  if (!isValidRjServoId(id)) {
    return { ok: false, error: `非法舵机 ID：${id}（应在 0..${MAX_ID}）` }
  }
  const p = Number(angleTicks)
  if (!Number.isFinite(p)) {
    return { ok: false, error: `非法角度 ticks：${angleTicks}` }
  }
  if (p < min || p > max) {
    return { ok: false, error: `角度越界：${p}（应在 ${min}..${max}，单位 0.1°）` }
  }
  return { ok: true }
}

export class RjSbusAdapter extends ServoAdapter {
  /**
   * @param {{ transport?: import("./rjSbusWebSerialTransport.js").RjSbusWebSerialTransport }} [deps]
   */
  constructor({ transport } = {}) {
    super({ transport: transport || rjSbusTransport, protocol: PROTOCOL.RJ_SBUS })
    /** @type {Map<number, {limitHigh:number,limitLow:number,midOffset:number,adcHigh:number,adcLow:number}>} */
    this._angleCalCache = new Map()
  }

  async _loadAngleCalibration(id, { timeoutMs = 120 } = {}) {
    if (this._angleCalCache.has(id)) return this._angleCalCache.get(id)
    const keys = [
      DATA_ID.ANGLE_LIMIT_HIGH,
      DATA_ID.ANGLE_LIMIT_LOW,
      DATA_ID.ANGLE_MID_OFFSET,
      DATA_ID.ANGLE_UPPER_LIMIT_ADC,
      DATA_ID.ANGLE_LOWER_LIMIT_ADC,
    ]
    const vals = {}
    for (const dataId of keys) {
      const res = await this.readData(id, dataId, { timeoutMs })
      if (!res.ok || res.value == null) return null
      vals[dataId] = res.value
    }
    const cal = {
      limitHigh: vals[DATA_ID.ANGLE_LIMIT_HIGH],
      limitLow: vals[DATA_ID.ANGLE_LIMIT_LOW],
      midOffset: vals[DATA_ID.ANGLE_MID_OFFSET],
      adcHigh: vals[DATA_ID.ANGLE_UPPER_LIMIT_ADC],
      adcLow: vals[DATA_ID.ANGLE_LOWER_LIMIT_ADC],
    }
    this._angleCalCache.set(id, cal)
    return cal
  }

  async readAngleFromAdc(id, { timeoutMs = 100 } = {}) {
    if (!isValidRjServoId(id)) {
      return { ok: false, id, error: `非法舵机 ID：${id}` }
    }
    const cal = await this._loadAngleCalibration(id, { timeoutMs })
    if (!cal) {
      return { ok: false, id, error: "角度标定参数读取失败" }
    }
    const adcRes = await this.readData(id, DATA_ID.ANGLE_ADC, { timeoutMs })
    if (!adcRes.ok || adcRes.value == null) {
      return { ok: false, id, error: adcRes.error || "angle_ADC 读取失败" }
    }
    try {
      const angleTicks = angleTicksFromAdc(adcRes.value, {
        limitHigh: cal.limitHigh,
        limitLow: cal.limitLow,
        midOffset: cal.midOffset,
        adcHigh: cal.adcHigh,
        adcLow: cal.adcLow,
      })
      return {
        ok: true,
        id,
        angleTicks,
        degrees: angleTicks / 10,
        value: angleTicks,
        angleAdc: adcRes.value,
        source: "angle_adc",
      }
    } catch (error) {
      return { ok: false, id, error: error.message, angleAdc: adcRes.value }
    }
  }

  async readAngleCmd10(id, { timeoutMs = 100 } = {}) {
    if (!isValidRjServoId(id)) {
      return { ok: false, id, error: `非法舵机 ID：${id}` }
    }
    const tx = buildReadAngle(id)
    const res = await this.transport.request(tx, {
      expectedId: id,
      expectedCmd: CMD.READ_ANGLE,
      timeoutMs,
    })
    if (!res.ok) {
      return {
        ok: false,
        id,
        error: res.reason === "timeout" ? "无响应" : res.reason,
        txBytes: Array.from(tx),
      }
    }
    const parsed = parseReadAngleContent(res.content)
    if (!parsed) {
      return { ok: false, id, error: "角度响应解析失败", txBytes: Array.from(tx), rxBytes: res.raw }
    }
    return {
      ok: true,
      id,
      angleTicks: parsed.angleTicks,
      degrees: parsed.degrees,
      value: parsed.angleTicks,
      source: "read_angle_cmd10",
      txBytes: Array.from(tx),
      rxBytes: res.raw,
    }
  }

  /**
   * @returns {Promise<import("../core/servoTypes.js").ServoCommandResult>}
   */
  async ping(id, { timeoutMs = 100 } = {}) {
    if (!isValidRjServoId(id)) {
      return { ok: false, id, error: `非法舵机 ID：${id}` }
    }
    const tx = buildPing(id)
    const res = await this.transport.request(tx, {
      expectedId: id,
      expectedCmd: CMD.PING,
      timeoutMs,
    })
    if (!res.ok) {
      return {
        ok: false,
        id,
        error: res.reason === "timeout" ? "无响应" : res.reason,
        txBytes: Array.from(tx),
      }
    }
    return {
      ok: true,
      id,
      txBytes: Array.from(tx),
      rxBytes: res.raw,
      value: id,
    }
  }

  async scan(startId = 0, endId = 20, { timeoutMs = 40 } = {}) {
    if (!this.connected) {
      return { ok: false, found: [], error: "串口未连接" }
    }
    const found = []
    const lo = clampInt(startId, 0, MAX_ID)
    const hi = clampInt(endId, lo, MAX_ID)
    for (let id = lo; id <= hi; id += 1) {
      const r = await this.ping(id, { timeoutMs })
      if (r.ok) found.push(id)
    }
    return { ok: true, found }
  }

  /**
   * 角度模式写位置（position = 0.1° ticks）。
   * @param {number} id
   * @param {number} position
   * @param {{
   *   time?: number,
   *   power?: number,
   *   posMin?: number,
   *   posMax?: number,
   *   waitAck?: boolean,
   *   accIntervalMs?: number,
   *   decIntervalMs?: number,
   *   useExInterval?: boolean
   * }} [options]
   */
  async writePosition(id, position, options = {}) {
    const {
      time = 0,
      power = 0,
      posMin = ANGLE_TICK_MIN,
      posMax = ANGLE_TICK_MAX,
      waitAck = false,
      accIntervalMs = 0,
      decIntervalMs = 0,
      useExInterval = false,
    } = options

    const angleTicks = clampAngleTicks(position, posMin, posMax)
    const v = validateAngleWrite({ id, angleTicks, min: posMin, max: posMax })
    if (!v.ok) return { ok: false, id, error: v.error }

    const tx =
      useExInterval || accIntervalMs > 0 || decIntervalMs > 0
        ? buildMoveOnAngleModeExByInterval(id, {
            angleTicks,
            intervalMs: time,
            accIntervalMs,
            decIntervalMs,
            power,
          })
        : buildMoveOnAngleMode(id, { angleTicks, timeMs: time, power })

    if (!waitAck) {
      const w = await this.transport.write(tx)
      return { ok: w.ok, id, error: w.ok ? "" : w.error || w.reason, txBytes: Array.from(tx) }
    }

    const res = await this.transport.request(tx, {
      expectedId: id,
      expectedCmd: useExInterval ? CMD.MOVE_ON_ANGLE_MODE_EX_BY_INTERVAL : CMD.MOVE_ON_ANGLE_MODE,
      timeoutMs: Math.max(80, Number(time) || 0) + 100,
    })
    if (!res.ok) {
      if (res.reason === "timeout") {
        return { ok: true, id, acked: false, txBytes: Array.from(tx) }
      }
      return { ok: false, id, error: res.reason, txBytes: Array.from(tx) }
    }
    const parsed = parseIdRetContent(res.content)
    return {
      ok: parsed ? parsed.ok : true,
      id,
      acked: true,
      value: parsed,
      txBytes: Array.from(tx),
      rxBytes: res.raw,
      error: parsed && !parsed.ok ? "舵机返回失败" : "",
    }
  }

  /** 以度为单位写角度。 */
  async writeAngleDegrees(id, degrees, options = {}) {
    return this.writePosition(id, degreesToAngleTicks(degrees), options)
  }

  /**
   * RJ 无硬件 SyncWrite：顺序单写。
   * @param {import("../core/servoTypes.js").ServoSyncWriteCommand[]} commands
   */
  async syncWritePositions(commands = [], options = {}) {
    const results = []
    for (const cmd of commands) {
      if (!cmd || !isValidRjServoId(cmd.id)) continue
      const r = await this.writePosition(cmd.id, cmd.position, {
        time: cmd.time ?? 0,
        power: cmd.power ?? 0,
        waitAck: false,
        ...options,
      })
      results.push(r)
    }
    const ok = results.length > 0 && results.every((r) => r.ok)
    return { ok, results, error: ok ? "" : "部分或全部 RJ_SBUS 写入失败" }
  }

  async readPosition(id, { timeoutMs = 100 } = {}) {
    const r = await this.readAngle(id, { timeoutMs })
    if (!r.ok) return r
    return {
      ...r,
      value: r.angleTicks,
    }
  }

  async readAngle(id, { timeoutMs = 100 } = {}) {
    const adc = await this.readAngleFromAdc(id, { timeoutMs })
    if (adc.ok) return adc
    const fallback = await this.readAngleCmd10(id, { timeoutMs })
    if (fallback.ok) {
      fallback.fallbackFrom = adc.error || "angle_adc-failed"
    }
    return fallback
  }

  async readData(id, dataId, { timeoutMs = 100 } = {}) {
    if (!isValidRjServoId(id)) {
      return { ok: false, id, error: `非法舵机 ID：${id}` }
    }
    const tx = buildReadData(id, dataId)
    const res = await this.transport.request(tx, {
      expectedId: id,
      expectedCmd: CMD.READ_DATA,
      timeoutMs,
    })
    if (!res.ok) {
      return {
        ok: false,
        id,
        error: res.reason === "timeout" ? "无响应" : res.reason,
        txBytes: Array.from(tx),
      }
    }
    const parsed = parseReadDataContent(res.content)
    return {
      ok: true,
      id,
      dataId,
      value: parsed?.value,
      data: parsed?.data,
      txBytes: Array.from(tx),
      rxBytes: res.raw,
    }
  }

  async writeData(id, dataId, value, { timeoutMs = 100, waitAck = true } = {}) {
    if (!isValidRjServoId(id)) {
      return { ok: false, id, error: `非法舵机 ID：${id}` }
    }
    let dataBytes
    try {
      dataBytes = encodeDataValue(dataId, value)
    } catch (error) {
      return { ok: false, id, error: error.message }
    }
    const tx = buildWriteData(id, dataId, dataBytes)
    if (!waitAck) {
      const w = await this.transport.write(tx)
      return { ok: w.ok, id, error: w.ok ? "" : w.error || w.reason, txBytes: Array.from(tx) }
    }
    const res = await this.transport.request(tx, {
      expectedId: id,
      expectedCmd: CMD.WRITE_DATA,
      timeoutMs,
    })
    if (!res.ok) {
      if (res.reason === "timeout") {
        return { ok: true, id, acked: false, txBytes: Array.from(tx) }
      }
      return { ok: false, id, error: res.reason, txBytes: Array.from(tx) }
    }
    // WRITE_DATA 响应：[id, data_id, ret]
    const ret = res.content.length >= 3 ? res.content[2] & 0xff : undefined
    return {
      ok: ret === 1 || ret === undefined,
      id,
      dataId,
      acked: true,
      value: ret,
      txBytes: Array.from(tx),
      rxBytes: res.raw,
      error: ret === 0 ? "写入失败" : "",
    }
  }

  async changeServoId(currentId, newId, { timeoutMs = 120 } = {}) {
    if (!isValidRjServoId(currentId) || !isValidRjServoId(newId)) {
      return { ok: false, error: `ID 须在 0..${MAX_ID}` }
    }
    if (currentId === newId) {
      return { ok: false, error: "新旧 ID 不能相同" }
    }
    const pingOld = await this.ping(currentId, { timeoutMs })
    if (!pingOld.ok) {
      return { ok: false, error: `Ping oldId=${currentId} 失败：${pingOld.error}` }
    }
    const wr = await this.writeData(currentId, DATA_ID.SERVO_ID, newId, { timeoutMs })
    if (!wr.ok) {
      return { ok: false, error: wr.error || "写入新 ID 失败", txBytes: wr.txBytes }
    }
    const pingNew = await this.ping(newId, { timeoutMs: Math.max(150, timeoutMs) })
    const pingOldAgain = await this.ping(currentId, { timeoutMs: 80 })
    const success = pingNew.ok && !pingOldAgain.ok
    return {
      ok: success,
      id: newId,
      error: success ? "" : "改 ID 后校验失败（新 ID 无响应或旧 ID 仍在线）",
      txBytes: wr.txBytes,
      value: { oldId: currentId, newId, pingNew: pingNew.ok, pingOldAgain: pingOldAgain.ok },
    }
  }

  /** 与 SC/ST UI 对齐的别名。 */
  async readId(id, opts) {
    const res = await this.readData(id, DATA_ID.SERVO_ID, opts)
    if (!res.ok) return res
    return { ...res, value: res.value, label: "id" }
  }

  async changeId(oldId, newId) {
    return this.changeServoId(oldId, newId)
  }

  /**
   * 读取舵机 EEPROM 波特率选项码（DATA_ID.BAUDRATE）。
   * 不切换主机串口波特率。
   */
  async readBaudrate(id, { timeoutMs = 120 } = {}) {
    if (!isValidRjServoId(id)) {
      return { ok: false, id, error: `非法舵机 ID：${id}` }
    }
    const res = await this.readData(id, DATA_ID.BAUDRATE, { timeoutMs })
    if (!res.ok) return { ...res, id }
    const optionCode = Number(res.value)
    const baudRate = baudBpsFromOptionCode(optionCode)
    if (baudRate == null) {
      return {
        ok: false,
        id,
        error: `未知波特率选项码：${optionCode}`,
        optionCode,
        txBytes: res.txBytes,
        rxBytes: res.rxBytes,
      }
    }
    return {
      ok: true,
      id,
      optionCode,
      baudRate,
      value: optionCode,
      label: "baudrate",
      txBytes: res.txBytes,
      rxBytes: res.rxBytes,
    }
  }

  /**
   * 写入舵机 EEPROM 波特率（DATA_ID.BAUDRATE）。
   * 本阶段不自动切换主机串口波特率；写入后若目标速率与当前主机不同，需手动改串口再 Ping。
   * @param {number} id
   * @param {number} bpsOrOptionCode 常见 bps（如 115200）或选项码 1..8
   */
  async writeBaudrate(id, bpsOrOptionCode, { timeoutMs = 150 } = {}) {
    if (!isValidRjServoId(id)) {
      return { ok: false, id, error: `非法舵机 ID：${id}` }
    }
    const optionCode = baudOptionCodeFromInput(bpsOrOptionCode)
    if (optionCode == null) {
      return {
        ok: false,
        id,
        error: `非法波特率：${bpsOrOptionCode}（须为选项码 1..8 或已知 bps）`,
      }
    }
    const baudRate = baudBpsFromOptionCode(optionCode)
    const ping = await this.ping(id, { timeoutMs: Math.min(120, timeoutMs) })
    if (!ping.ok) {
      return { ok: false, id, error: `Ping #${id} 失败：${ping.error || "无响应"}` }
    }
    const wr = await this.writeData(id, DATA_ID.BAUDRATE, optionCode, { timeoutMs })
    if (!wr.ok) {
      return {
        ok: false,
        id,
        error: wr.error || "写入波特率失败",
        optionCode,
        baudRate,
        txBytes: wr.txBytes,
      }
    }
    return {
      ok: true,
      id,
      optionCode,
      baudRate,
      acked: wr.acked !== false,
      txBytes: wr.txBytes,
      rxBytes: wr.rxBytes,
      message: `已写入舵机 #${id} 波特率选项 ${optionCode}（${baudRate}）。主机串口未自动切换，请手动改波特率后 Ping 验证。`,
    }
  }

  /**
   * 读取 response_switch（DATA_ID=33）。
   * 1 = 指令应答开；0 = 关（连续写角度时更适合实时）。
   */
  async readResponseSwitch(id, { timeoutMs = 120 } = {}) {
    if (!isValidRjServoId(id)) {
      return { ok: false, id, error: `非法舵机 ID：${id}` }
    }
    const res = await this.readData(id, DATA_ID.RESPONSE_SWITCH, { timeoutMs })
    if (!res.ok) return { ...res, id }
    const value = Number(res.value) & 0xff
    return {
      ok: true,
      id,
      value,
      enabled: value === 1,
      label: "response_switch",
      txBytes: res.txBytes,
      rxBytes: res.rxBytes,
    }
  }

  /**
   * 写入 response_switch（DATA_ID=33）。仅接受 0 / 1。
   */
  async writeResponseSwitch(id, enabledOr01, { timeoutMs = 150 } = {}) {
    if (!isValidRjServoId(id)) {
      return { ok: false, id, error: `非法舵机 ID：${id}` }
    }
    const value = Number(enabledOr01) ? 1 : 0
    const ping = await this.ping(id, { timeoutMs: Math.min(120, timeoutMs) })
    if (!ping.ok) {
      return { ok: false, id, error: `Ping #${id} 失败：${ping.error || "无响应"}` }
    }
    const wr = await this.writeData(id, DATA_ID.RESPONSE_SWITCH, value, { timeoutMs })
    if (!wr.ok) {
      return { ok: false, id, error: wr.error || "写入 response_switch 失败", value, txBytes: wr.txBytes }
    }
    return {
      ok: true,
      id,
      value,
      enabled: value === 1,
      acked: wr.acked !== false,
      txBytes: wr.txBytes,
      rxBytes: wr.rxBytes,
      message:
        value === 0
          ? `已将 #${id} response_switch=0（无应答）。可回舵机控制页拖条测实时性。`
          : `已将 #${id} response_switch=1（有应答）。`,
    }
  }

  async resetUserData(id, { timeoutMs = 120 } = {}) {
    if (!isValidRjServoId(id)) {
      return { ok: false, id, error: `非法舵机 ID：${id}` }
    }
    const tx = buildResetUserData(id)
    const res = await this.transport.request(tx, {
      expectedId: id,
      expectedCmd: CMD.RESET_USER_DATA,
      timeoutMs,
    })
    if (!res.ok) {
      return {
        ok: false,
        id,
        error: res.reason === "timeout" ? "无响应" : res.reason,
        txBytes: Array.from(tx),
      }
    }
    const parsed = parseIdRetContent(res.content)
    return {
      ok: parsed ? parsed.ok : true,
      id,
      value: parsed,
      txBytes: Array.from(tx),
      rxBytes: res.raw,
    }
  }

  async clearProtectStatus(id, { timeoutMs = 120 } = {}) {
    if (!isValidRjServoId(id)) {
      return { ok: false, id, error: `非法舵机 ID：${id}` }
    }
    const tx = buildClearProtectStatus(id)
    const res = await this.transport.request(tx, {
      expectedId: id,
      expectedCmd: CMD.CLEAR_PROTECT_STATUS,
      timeoutMs,
    })
    if (!res.ok) {
      return {
        ok: false,
        id,
        error: res.reason === "timeout" ? "无响应" : res.reason,
        txBytes: Array.from(tx),
      }
    }
    const parsed = parseIdRetContent(res.content)
    return {
      ok: parsed ? parsed.ok : true,
      id,
      value: parsed,
      txBytes: Array.from(tx),
      rxBytes: res.raw,
    }
  }

  async restart(id, { timeoutMs = 120 } = {}) {
    if (!isValidRjServoId(id)) {
      return { ok: false, id, error: `非法舵机 ID：${id}` }
    }
    const tx = buildRestart(id)
    const res = await this.transport.request(tx, {
      expectedId: id,
      expectedCmd: CMD.RESTART,
      timeoutMs,
    })
    if (!res.ok) {
      // 重启后可能不再应答
      if (res.reason === "timeout") {
        return { ok: true, id, acked: false, txBytes: Array.from(tx) }
      }
      return { ok: false, id, error: res.reason, txBytes: Array.from(tx) }
    }
    const parsed = parseIdRetContent(res.content)
    return {
      ok: parsed ? parsed.ok : true,
      id,
      value: parsed,
      txBytes: Array.from(tx),
      rxBytes: res.raw,
    }
  }

  async motorTestForward(id, { timeoutMs = 120 } = {}) {
    const tx = buildMotorTestForward(id)
    const res = await this.transport.request(tx, {
      expectedId: id,
      expectedCmd: CMD.MOTOR_TEST_FORWARD,
      timeoutMs,
    })
    return this._wrapIdRet(id, tx, res)
  }

  async motorTestReversal(id, { timeoutMs = 120 } = {}) {
    const tx = buildMotorTestReversal(id)
    const res = await this.transport.request(tx, {
      expectedId: id,
      expectedCmd: CMD.MOTOR_TEST_REVERSAL,
      timeoutMs,
    })
    return this._wrapIdRet(id, tx, res)
  }

  /**
   * 启动机械扫描（调试）。运行中再发命令可暂停。
   */
  async startMechanicalScan(id, stepTimeMs = 10, { timeoutMs = 120 } = {}) {
    const tx = buildScan(id, stepTimeMs)
    const res = await this.transport.request(tx, {
      expectedId: id,
      expectedCmd: CMD.SCAN,
      timeoutMs,
    })
    return this._wrapIdRet(id, tx, res)
  }

  async readBatchDataA(id, { timeoutMs = 150 } = {}) {
    const tx = buildReadBatchDataA(id)
    const res = await this.transport.request(tx, {
      expectedId: id,
      expectedCmd: CMD.READ_BATCH_DATA_A,
      timeoutMs,
    })
    if (!res.ok) {
      return {
        ok: false,
        id,
        error: res.reason === "timeout" ? "无响应" : res.reason,
        txBytes: Array.from(tx),
      }
    }
    return {
      ok: true,
      id,
      data: (res.content || []).slice(1),
      txBytes: Array.from(tx),
      rxBytes: res.raw,
    }
  }

  async writeBatchDataA(id, data32, { timeoutMs = 150 } = {}) {
    const tx = buildWriteBatchDataA(id, data32)
    const res = await this.transport.request(tx, {
      expectedId: id,
      expectedCmd: CMD.WRITE_BATCH_DATA_A,
      timeoutMs,
    })
    return this._wrapIdRet(id, tx, res)
  }

  async readBatchDataB(id, { timeoutMs = 150 } = {}) {
    const tx = buildReadBatchDataB(id)
    const res = await this.transport.request(tx, {
      expectedId: id,
      expectedCmd: CMD.READ_BATCH_DATA_B,
      timeoutMs,
    })
    if (!res.ok) {
      return {
        ok: false,
        id,
        error: res.reason === "timeout" ? "无响应" : res.reason,
        txBytes: Array.from(tx),
      }
    }
    return {
      ok: true,
      id,
      data: (res.content || []).slice(1),
      txBytes: Array.from(tx),
      rxBytes: res.raw,
    }
  }

  async writeBatchDataB(id, data40, { timeoutMs = 150 } = {}) {
    const tx = buildWriteBatchDataB(id, data40)
    const res = await this.transport.request(tx, {
      expectedId: id,
      expectedCmd: CMD.WRITE_BATCH_DATA_B,
      timeoutMs,
    })
    return this._wrapIdRet(id, tx, res)
  }

  /** 无阻尼/卸力专用指令时，用写中位 + 低功率近似 stop；当前仅发当前角保持。 */
  async stop(id) {
    const cur = await this.readAngle(id, { timeoutMs: 80 })
    if (!cur.ok) return cur
    return this.writePosition(id, cur.angleTicks, { time: 0, power: 0, waitAck: false })
  }

  async stopAll(ids = []) {
    const list = Array.isArray(ids) ? ids : []
    const results = []
    for (const id of list) {
      results.push(await this.stop(id))
    }
    return { ok: results.every((r) => r.ok), results }
  }

  _wrapIdRet(id, tx, res) {
    if (!res.ok) {
      return {
        ok: false,
        id,
        error: res.reason === "timeout" ? "无响应" : res.reason,
        txBytes: Array.from(tx),
      }
    }
    const parsed = parseIdRetContent(res.content)
    return {
      ok: parsed ? parsed.ok : true,
      id,
      value: parsed,
      txBytes: Array.from(tx),
      rxBytes: res.raw,
      error: parsed && !parsed.ok ? "舵机返回失败" : "",
    }
  }
}
