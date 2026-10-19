/**
 * Servo Adapter 基类与通用校验/限幅工具。
 *
 * 适配器统一接口（各协议按需实现）：
 *   ping(id)
 *   scan(startId, endId)
 *   writePosition(id, position, options)
 *   syncWritePositions(commands)
 *   readPosition(id)
 *   readSpeed(id)
 *   readPosSpeed(id)
 *   returnNeutral(profileOrList)
 *   stop(id)
 *   stopAll()
 */

import { MAX_ID } from "../scservo/scProtocolConstants.js"

export function clampInt(value, min, max) {
  const n = Math.round(Number(value) || 0)
  if (n < min) return min
  if (n > max) return max
  return n
}

export function isValidServoId(id) {
  return Number.isInteger(id) && id >= 0 && id <= MAX_ID
}

/**
 * 校验单条写位置请求。
 * @returns {{ ok:boolean, error?:string }}
 */
export function validateWriteRequest({ id, position, posMin = 0, posMax = 4095 }) {
  if (!isValidServoId(id)) {
    return { ok: false, error: `非法舵机 ID：${id}（应在 0..${MAX_ID}）` }
  }
  const p = Number(position)
  if (!Number.isFinite(p)) {
    return { ok: false, error: `非法位置：${position}` }
  }
  if (p < posMin || p > posMax) {
    return { ok: false, error: `位置越界：${p}（应在 ${posMin}..${posMax}）` }
  }
  return { ok: true }
}

export class ServoAdapter {
  /**
   * @param {object} options
   * @param {import("../scservo/scServoWebSerialTransport.js").ScServoWebSerialTransport} options.transport
   * @param {string} options.protocol
   */
  constructor({ transport, protocol }) {
    if (!transport) {
      throw new Error("ServoAdapter 需要 transport。")
    }
    this.transport = transport
    this.protocol = protocol
  }

  get connected() {
    return Boolean(this.transport && this.transport.connected)
  }

  // 子类必须实现：
  async ping() {
    throw new Error("ping 未实现")
  }
  async writePosition() {
    throw new Error("writePosition 未实现")
  }
  async readPosition() {
    throw new Error("readPosition 未实现")
  }
}
