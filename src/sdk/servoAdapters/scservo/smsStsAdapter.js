/**
 * ST / SMS / STS 系列（sms_sts）最小兼容适配器。
 */

import { ServoAdapter, clampInt, isValidServoId, validateWriteRequest } from "../core/servoAdapter.js"
import { PROTOCOL } from "../core/servoTypes.js"
import {
  ST_REG,
  ST_SYNC_WRITE_START,
  ST_SYNC_WRITE_DATA_LENGTH,
  SCS_END_ST,
  BROADCAST_ID,
  describeServoError,
} from "./scProtocolConstants.js"
import { buildPing, buildRead, buildWrite, buildSyncWrite, buildRegWrite, buildAction } from "./scPacket.js"
import { encodeStPositionData, decodeStPosition, decodeStSpeed } from "./scServoCodec.js"
import { resolveStSyncWriteMotion } from "../busServo/busSyncWriteMotion.js"
import {
  readServoId,
  changeServoId,
  decodePresentCurrent,
  decodePresentLoad,
  readPresentVoltage,
  readPresentTemperature,
  readMoving,
  finalizePositionRead,
} from "./busServoOps.js"

const ST_POS_MIN = 0
const ST_POS_MAX = 4095

export class SmsStsAdapter extends ServoAdapter {
  constructor({ transport }) {
    super({ transport, protocol: PROTOCOL.SMS_STS })
  }

  async ping(id, { timeoutMs = 100 } = {}) {
    if (!isValidServoId(id)) {
      return { ok: false, id, error: `非法舵机 ID：${id}` }
    }
    const tx = buildPing(id)
    const res = await this.transport.request(tx, { expectedId: id, timeoutMs })
    if (!res.ok) {
      return { ok: false, id, error: res.reason === "timeout" ? "无响应" : res.reason, txBytes: Array.from(tx) }
    }
    return {
      ok: true,
      id,
      servoError: res.error,
      error: res.error ? describeServoError(res.error) : "",
      txBytes: Array.from(tx),
      rxBytes: res.raw,
    }
  }

  async scan(startId = 0, endId = 20, { timeoutMs = 30 } = {}) {
    if (!this.connected) {
      return { ok: false, found: [], error: "串口未连接" }
    }
    const found = []
    const lo = clampInt(startId, 0, 252)
    const hi = clampInt(endId, lo, 252)
    for (let id = lo; id <= hi; id += 1) {
      const r = await this.ping(id, { timeoutMs })
      if (r.ok) found.push(id)
    }
    return { ok: true, found }
  }

  async writePosition(id, position, options = {}) {
    const { speed = 0, acc = 0, posMin = ST_POS_MIN, posMax = ST_POS_MAX, waitAck = true } = options
    const v = validateWriteRequest({ id, position, posMin, posMax })
    if (!v.ok) return { ok: false, id, error: v.error }

    const data = encodeStPositionData({ position: clampInt(position, posMin, posMax), speed, acc })
    const tx = buildWrite(id, ST_REG.ACC, data)

    if (!waitAck) {
      const w = await this.transport.write(tx)
      return { ok: w.ok, id, error: w.ok ? "" : w.error || w.reason, txBytes: Array.from(tx) }
    }
    const res = await this.transport.request(tx, { expectedId: id, timeoutMs: 60 })
    if (!res.ok) {
      if (res.reason === "timeout") {
        return { ok: true, id, acked: false, txBytes: Array.from(tx) }
      }
      return { ok: false, id, error: res.reason, txBytes: Array.from(tx) }
    }
    return {
      ok: true,
      id,
      acked: true,
      servoError: res.error,
      error: res.error ? describeServoError(res.error) : "",
      txBytes: Array.from(tx),
      rxBytes: res.raw,
    }
  }

  async _read(id, address, length, decode, timeoutMs, label) {
    if (!isValidServoId(id)) {
      return { ok: false, id, error: `非法舵机 ID：${id}` }
    }
    const tx = buildRead(id, address, length)
    const res = await this.transport.request(tx, { expectedId: id, timeoutMs })
    if (!res.ok) {
      return { ok: false, id, error: res.reason === "timeout" ? "无响应" : res.reason, txBytes: Array.from(tx) }
    }
    const value = decode(res.params)
    return {
      ok: true,
      id,
      value,
      label,
      servoError: res.error,
      error: res.error ? describeServoError(res.error) : "",
      txBytes: Array.from(tx),
      rxBytes: res.raw,
    }
  }

  async readPosition(id, { timeoutMs = 100 } = {}) {
    const res = await this._read(id, ST_REG.PRESENT_POSITION_L, 2, decodeStPosition, timeoutMs, "position")
    return finalizePositionRead(res)
  }

  async readSpeed(id, { timeoutMs = 100 } = {}) {
    return this._read(id, ST_REG.PRESENT_SPEED_L, 2, decodeStSpeed, timeoutMs, "speed")
  }

  async syncWritePositions(commands, options = {}) {
    const mode = options.mode ?? "reg-action"
    if (mode === "reg-action") {
      return this._syncWriteRegAction(commands)
    }
    return this._syncWriteInst(commands)
  }

  async _syncWriteInst(commands) {
    const list = Array.isArray(commands) ? commands : []
    if (list.length === 0) return { ok: false, error: "无 SyncWrite 指令" }
    const items = []
    for (const cmd of list) {
      if (!isValidServoId(cmd.id)) {
        return { ok: false, error: `非法舵机 ID：${cmd.id}` }
      }
      items.push({
        id: cmd.id,
        data: encodeStPositionData({
          position: clampInt(cmd.position, ST_POS_MIN, ST_POS_MAX),
          ...resolveStSyncWriteMotion({
            speed: cmd.speed ?? 0,
            acc: cmd.acc ?? 0,
          }),
        }),
      })
    }
    let tx
    try {
      tx = buildSyncWrite(ST_SYNC_WRITE_START, ST_SYNC_WRITE_DATA_LENGTH, items)
    } catch (error) {
      return { ok: false, error: error.message }
    }
    const w = await this.transport.write(tx, { force: true })
    if (!w.ok) {
      return {
        ok: false,
        dropped: Boolean(w.dropped),
        error: w.error || w.reason || "串口写入失败",
        txBytes: Array.from(tx),
      }
    }
    return { ok: true, error: "", txBytes: Array.from(tx), txMode: "sync-inst" }
  }

  async _syncWriteRegAction(commands) {
    const list = Array.isArray(commands) ? commands : []
    if (list.length === 0) return { ok: false, error: "无 RegAction 指令" }
    const errors = []
    const txList = []
    let sent = 0

    for (const cmd of list) {
      if (!isValidServoId(cmd.id)) {
        return { ok: false, error: `非法舵机 ID：${cmd.id}` }
      }
      const motion = resolveStSyncWriteMotion({
        speed: cmd.speed ?? 0,
        acc: cmd.acc ?? 0,
      })
      const data = encodeStPositionData({
        position: clampInt(cmd.position, ST_POS_MIN, ST_POS_MAX),
        speed: motion.speed,
        acc: motion.acc,
      })
      const tx = buildRegWrite(cmd.id, ST_REG.ACC, data)
      const w = await this.transport.write(tx, { force: true })
      txList.push(Array.from(tx))
      if (!w.ok) {
        errors.push(`#${cmd.id}: ${w.error || w.reason}`)
      } else {
        sent += 1
      }
    }

    const actionTx = buildAction(BROADCAST_ID)
    const aw = await this.transport.write(actionTx, { force: true })
    txList.push(Array.from(actionTx))
    if (!aw.ok) {
      errors.push(`ACTION: ${aw.error || aw.reason}`)
    }

    return {
      ok: errors.length === 0 && sent > 0,
      sent,
      error: errors.join("; "),
      txBytes: txList[txList.length - 1] || [],
      txMode: "reg-action",
      regWriteCount: sent,
      packetCount: sent + (aw.ok ? 1 : 0),
    }
  }

  async returnNeutral(list, { speed = 0, acc = 0 } = {}) {
    const arr = Array.isArray(list) ? list : []
    if (arr.length === 0) return { ok: false, error: "无回中目标" }
    const results = []
    for (const s of arr) {
      const nv = s.neutralValue ?? s.neutral
      const cal = s.calibrated === true || s.neutralConfigured === true
      if (!cal || nv == null || !Number.isFinite(Number(nv))) {
        return { ok: false, id: s.id, error: `舵机 #${s.id} 未完成标定，无法回中` }
      }
      const pos = clampInt(nv, ST_POS_MIN, ST_POS_MAX)
      const res = await this.writePosition(s.id, pos, { speed: s.speed ?? speed, acc: s.acc ?? acc, waitAck: false })
      results.push({ ...res, neutralValue: pos, message: `Return Neutral #${s.id} => ${pos}` })
    }
    return { ok: results.every((r) => r.ok), results }
  }

  async readId(id, opts) {
    return readServoId(this, id, opts)
  }

  async changeId(oldId, newId) {
    return changeServoId(this, oldId, newId, { lockReg: ST_REG.LOCK })
  }

  async readVoltage(id, opts) {
    const res = await readPresentVoltage(this, id, ST_REG.PRESENT_VOLTAGE, opts)
    if (res.ok) return { ...res, display: `${(res.value / 10).toFixed(1)} V` }
    return res
  }

  async readTemperature(id, opts) {
    const res = await readPresentTemperature(this, id, ST_REG.PRESENT_TEMPERATURE, opts)
    if (res.ok) return { ...res, display: `${res.value} °C` }
    return res
  }

  async readCurrent(id, opts) {
    return this._read(
      id,
      ST_REG.PRESENT_CURRENT_L,
      2,
      (p) => decodePresentCurrent(p, SCS_END_ST),
      opts?.timeoutMs ?? 100,
      "current"
    )
  }

  async readLoad(id, opts) {
    return this._read(
      id,
      ST_REG.PRESENT_LOAD_L,
      2,
      (p) => decodePresentLoad(p, SCS_END_ST),
      opts?.timeoutMs ?? 100,
      "load"
    )
  }

  async readMoving(id, opts) {
    return readMoving(this, id, ST_REG.MOVING, opts)
  }

  async stop(id) {
    if (!isValidServoId(id)) {
      return { ok: false, id, error: `非法舵机 ID：${id}` }
    }
    const tx = buildWrite(id, ST_REG.TORQUE_ENABLE, [0])
    const w = await this.transport.write(tx)
    return { ok: w.ok, id, error: w.ok ? "" : w.error || w.reason, txBytes: Array.from(tx) }
  }

  async enableTorque(id, enabled = true) {
    const tx = buildWrite(id, ST_REG.TORQUE_ENABLE, [enabled ? 1 : 0])
    const w = await this.transport.write(tx)
    return { ok: w.ok, id, error: w.ok ? "" : w.error || w.reason, txBytes: Array.from(tx) }
  }
}
