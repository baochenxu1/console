/**
 * SC 系列（scscl）主链路适配器。
 *
 * 支持：ping / scan / writePosition / syncWritePositions /
 *      readPosition / readSpeed / readPosSpeed / returnNeutral / stop / stopAll。
 *
 * 协议细节对齐官方 scscl.py（scs_end = 1）。
 */

import { ServoAdapter, clampInt, isValidServoId, validateWriteRequest } from "../core/servoAdapter.js"
import { PROTOCOL } from "../core/servoTypes.js"
import {
  SC_REG,
  SC_SYNC_WRITE_START,
  SC_SYNC_WRITE_DATA_LENGTH,
  BROADCAST_ID,
  normalizeScsclBroadcastId,
  describeServoError,
} from "./scProtocolConstants.js"
import {
  buildPing,
  buildRead,
  buildWrite,
  buildSyncWrite,
  buildRegWrite,
  buildAction,
  toHex,
} from "./scPacket.js"
import {
  encodeScPositionData,
  decodeScPosition,
  decodeScSpeed,
  decodeScPosSpeed,
} from "./scServoCodec.js"
import { resolveScSyncWriteMotion } from "../busServo/busSyncWriteMotion.js"
import { SC_POSITION_MAX, SC_POSITION_MIN } from "../core/servoProfile.js"
import { SCS_END_SC } from "./scProtocolConstants.js"
import {
  readServoId,
  changeServoId,
  decodePresentSpeed,
  decodePresentLoad,
  decodePresentCurrent,
  readPresentVoltage,
  readPresentTemperature,
  readMoving,
  finalizePositionRead,
} from "./busServoOps.js"

const SC_POS_MIN = SC_POSITION_MIN
const SC_POS_MAX = SC_POSITION_MAX

export class ScsclAdapter extends ServoAdapter {
  constructor({ transport }) {
    super({ transport, protocol: PROTOCOL.SCSCL })
  }

  /**
   * PING 单个舵机。
   * @returns {Promise<import("../core/servoTypes.js").ServoCommandResult>}
   */
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

  /**
   * 扫描 ID 区间，返回在线舵机列表。
   * @returns {Promise<{ ok:boolean, found:number[], error?:string }>}
   */
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

  /**
   * 单舵机写位置。
   * @param {number} id
   * @param {number} position 0..1023（SC09 / sc_300_1024）
   * @param {{ time?:number, speed?:number, posMin?:number, posMax?:number, waitAck?:boolean }} [options]
   */
  async writePosition(id, position, options = {}) {
    const { time = 0, speed = 0, posMin = SC_POS_MIN, posMax = SC_POS_MAX, waitAck = true } = options
    const v = validateWriteRequest({ id, position, posMin, posMax })
    if (!v.ok) return { ok: false, id, error: v.error }

    const data = encodeScPositionData({ position: clampInt(position, posMin, posMax), time, speed })
    const tx = buildWrite(id, SC_REG.GOAL_POSITION_L, data)

    if (!waitAck) {
      const w = await this.transport.write(tx)
      return { ok: w.ok, id, error: w.ok ? "" : w.error || w.reason, txBytes: Array.from(tx) }
    }

    const res = await this.transport.request(tx, { expectedId: id, timeoutMs: 60 })
    if (!res.ok) {
      // 舵机可能未配置应答；写入已发出，仍视为成功但标记未确认。
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

  /**
   * 多舵机同步写。默认 reg-action（RegWrite + Action），兼容部分不响应 0x83 的固件。
   * @param {import("../core/servoTypes.js").ServoSyncWriteCommand[]} commands
   * @param {{ mode?: 'sync-inst' | 'reg-action', broadcastId?: number }} [options]
   */
  async syncWritePositions(commands, options = {}) {
    const mode = options.mode ?? "reg-action"
    const broadcastId = normalizeScsclBroadcastId(options.broadcastId ?? BROADCAST_ID)
    if (mode === "reg-action") {
      return this._syncWriteRegAction(commands, { broadcastId })
    }
    return this._syncWriteInst(commands, { broadcastId })
  }

  async _syncWriteInst(commands, { broadcastId = BROADCAST_ID } = {}) {
    const list = Array.isArray(commands) ? commands : []
    if (list.length === 0) {
      return { ok: false, error: "无 SyncWrite 指令" }
    }
    const items = []
    for (const cmd of list) {
      if (!isValidServoId(cmd.id)) {
        return { ok: false, error: `非法舵机 ID：${cmd.id}` }
      }
      const position = clampInt(cmd.position, SC_POS_MIN, SC_POS_MAX)
      const motion = resolveScSyncWriteMotion({
        time: cmd.time ?? 0,
        speed: cmd.speed ?? 0,
      })
      items.push({
        id: cmd.id,
        data: encodeScPositionData({
          position,
          time: motion.time,
          speed: motion.speed,
        }),
      })
    }
    let tx
    try {
      tx = buildSyncWrite(SC_SYNC_WRITE_START, SC_SYNC_WRITE_DATA_LENGTH, items, broadcastId)
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
    return { ok: true, error: "", txBytes: Array.from(tx), txMode: "sync-inst", broadcastId }
  }

  async _syncWriteRegAction(commands, { broadcastId = BROADCAST_ID } = {}) {
    const list = Array.isArray(commands) ? commands : []
    if (list.length === 0) {
      return { ok: false, error: "无 RegAction 指令" }
    }
    const errors = []
    const txList = []
    const actualTxPacketHexList = []
    let sent = 0

    const sorted = [...list].sort((a, b) => a.id - b.id)

    for (const cmd of sorted) {
      if (!isValidServoId(cmd.id)) {
        return { ok: false, error: `非法舵机 ID：${cmd.id}` }
      }
      const position = clampInt(cmd.position, SC_POS_MIN, SC_POS_MAX)
      const motion = resolveScSyncWriteMotion({
        time: cmd.time ?? 0,
        speed: cmd.speed ?? 0,
      })
      const data = encodeScPositionData({
        position,
        time: motion.time,
        speed: motion.speed,
      })
      const tx = buildRegWrite(cmd.id, SC_REG.GOAL_POSITION_L, data)
      const w = await this.transport.write(tx, { force: true, txCapture: actualTxPacketHexList })
      txList.push(Array.from(tx))
      if (!w.ok) {
        errors.push(`#${cmd.id}: ${w.error || w.reason}`)
      } else {
        sent += 1
      }
    }

    const actionTx = buildAction(broadcastId)
    const aw = await this.transport.write(actionTx, { force: true, txCapture: actualTxPacketHexList })
    txList.push(Array.from(actionTx))
    if (!aw.ok) {
      errors.push(`ACTION: ${aw.error || aw.reason}`)
    }

    const lastTx = txList[txList.length - 1] || []
    return {
      ok: errors.length === 0 && sent > 0,
      sent,
      error: errors.join("; "),
      txBytes: lastTx,
      txMode: "reg-action",
      broadcastId,
      actualTxPacketHexList,
      regWriteCount: sent,
      packetCount: sent + (aw.ok ? 1 : 0),
    }
  }

  async readPosition(id, { timeoutMs = 100 } = {}) {
    const res = await this._read(id, SC_REG.PRESENT_POSITION_L, 2, decodeScPosition, timeoutMs, "position")
    return finalizePositionRead(res)
  }

  async readSpeed(id, { timeoutMs = 100 } = {}) {
    return this._read(id, SC_REG.PRESENT_SPEED_L, 2, decodeScSpeed, timeoutMs, "speed")
  }

  async readPosSpeed(id, { timeoutMs = 100 } = {}) {
    return this._read(id, SC_REG.PRESENT_POSITION_L, 4, decodeScPosSpeed, timeoutMs, "posSpeed")
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

  /**
   * 回中：必须使用已配置的 neutralValue（禁止默认发 0）。
   * @param {{ id:number, neutralValue:number, neutralConfigured?:boolean, speed?:number, time?:number }[]} list
   */
  async returnNeutral(list, { speed = 0, time = 0 } = {}) {
    const arr = Array.isArray(list) ? list : []
    if (arr.length === 0) return { ok: false, error: "无回中目标" }
    const commands = []
    for (const s of arr) {
      const nv = s.neutralValue ?? s.neutral
      const cal = s.calibrated === true || s.neutralConfigured === true
      if (!cal || nv == null || !Number.isFinite(Number(nv))) {
        return { ok: false, id: s.id, error: `舵机 #${s.id} 未完成标定，无法回中` }
      }
      commands.push({
        id: s.id,
        position: clampInt(nv, SC_POS_MIN, SC_POS_MAX),
        speed: s.speed ?? speed,
        time: s.time ?? time,
        neutralValue: clampInt(nv, SC_POS_MIN, SC_POS_MAX),
      })
    }
    if (commands.length === 1) {
      const c = commands[0]
      const res = await this.writePosition(c.id, c.position, { speed: c.speed, time: c.time, waitAck: false })
      return { ...res, neutralValue: c.neutralValue, message: `Return Neutral #${c.id} => ${c.neutralValue}` }
    }
    const syncRes = await this.syncWritePositions(commands)
    return { ...syncRes, commands }
  }

  async readId(id, opts) {
    return readServoId(this, id, opts)
  }

  async changeId(oldId, newId) {
    return changeServoId(this, oldId, newId, { lockReg: SC_REG.LOCK })
  }

  async readVoltage(id, opts) {
    const res = await readPresentVoltage(this, id, SC_REG.PRESENT_VOLTAGE, opts)
    if (res.ok) return { ...res, value: res.value, display: `${(res.value / 10).toFixed(1)} V` }
    return res
  }

  async readTemperature(id, opts) {
    const res = await readPresentTemperature(this, id, SC_REG.PRESENT_TEMPERATURE, opts)
    if (res.ok) return { ...res, value: res.value, display: `${res.value} °C` }
    return res
  }

  async readCurrent(id, opts) {
    return this._read(
      id,
      SC_REG.PRESENT_CURRENT_L,
      2,
      (p) => decodePresentCurrent(p, SCS_END_SC),
      opts?.timeoutMs ?? 100,
      "current"
    )
  }

  async readLoad(id, opts) {
    return this._read(
      id,
      SC_REG.PRESENT_LOAD_L,
      2,
      (p) => decodePresentLoad(p, SCS_END_SC),
      opts?.timeoutMs ?? 100,
      "load"
    )
  }

  async readMoving(id, opts) {
    return readMoving(this, id, SC_REG.MOVING, opts)
  }

  /**
   * 停止单个舵机：扭矩关闭（立即停止，舵机失力）。
   */
  async stop(id) {
    if (!isValidServoId(id)) {
      return { ok: false, id, error: `非法舵机 ID：${id}` }
    }
    const tx = buildWrite(id, SC_REG.TORQUE_ENABLE, [0])
    const w = await this.transport.write(tx)
    return { ok: w.ok, id, error: w.ok ? "" : w.error || w.reason, txBytes: Array.from(tx) }
  }

  /**
   * 停止全部舵机：广播扭矩关闭。
   */
  async stopAll() {
    const tx = buildWrite(BROADCAST_ID, SC_REG.TORQUE_ENABLE, [0])
    const w = await this.transport.write(tx)
    return { ok: w.ok, error: w.ok ? "" : w.error || w.reason, txBytes: Array.from(tx) }
  }

  /** 扭矩使能（写位置前若曾 stop，需要重新使能）。 */
  async enableTorque(id, enabled = true) {
    if (!isValidServoId(id)) {
      return { ok: false, id, error: `非法舵机 ID：${id}` }
    }
    const tx = buildWrite(id, SC_REG.TORQUE_ENABLE, [enabled ? 1 : 0])
    const w = await this.transport.write(tx)
    return { ok: w.ok, id, error: w.ok ? "" : w.error || w.reason, txBytes: Array.from(tx) }
  }

  /** 调试：返回构建出的 SyncWrite 原始字节十六进制。 */
  previewSyncWriteHex(commands) {
    const items = (commands || []).map((c) => {
      const motion = resolveScSyncWriteMotion({
        time: c.time ?? 0,
        speed: c.speed ?? 0,
      })
      return {
        id: c.id,
        data: encodeScPositionData({
          position: clampInt(c.position, SC_POS_MIN, SC_POS_MAX),
          time: motion.time,
          speed: motion.speed,
        }),
      }
    })
    try {
      return toHex(buildSyncWrite(SC_SYNC_WRITE_START, SC_SYNC_WRITE_DATA_LENGTH, items))
    } catch (error) {
      return `错误：${error.message}`
    }
  }
}
