/**
 * 锐捷 RJ_SBUS 角度 / 参数值编解码。
 *
 * 协议角度单位：0.1°（signed）。示例：90° → 900（0x0384 LE = 84 03）。
 */

import {
  DATA_ID_SIZE,
  DATA_ID_SIGNED,
  ANGLE_TICK_MIN,
  ANGLE_TICK_MAX,
} from "./rjSbusConstants.js"
import {
  encodeI16Le,
  encodeU16Le,
  encodeU32Le,
  decodeI16Le,
  decodeU16Le,
  decodeU32Le,
} from "./rjSbusPacket.js"

/** 度 → 0.1° ticks（四舍五入）。 */
export function degreesToAngleTicks(degrees) {
  return Math.round(Number(degrees) * 10)
}

/** 0.1° ticks → 度。 */
export function angleTicksToDegrees(ticks) {
  return Number(ticks) / 10
}

/**
 * 电位器 ADC → 协议角度 ticks（0.1°）。
 * 手册 degrees 式缺 +n；完整 ticks 式：
 *   ticks = (x-b)*(m-n)/(a-b) + n - p
 */
export function angleTicksFromAdc(adc, { limitHigh, limitLow, midOffset, adcHigh, adcLow }) {
  const a = Number(adcHigh)
  const b = Number(adcLow)
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) {
    throw new Error(`invalid ADC calibration: adcHigh=${adcHigh} adcLow=${adcLow}`)
  }
  const x = Number(adc)
  const m = Number(limitHigh)
  const n = Number(limitLow)
  const p = Number(midOffset) || 0
  return Math.round(((x - b) * (m - n)) / (a - b) + n - p)
}

export function clampAngleTicks(ticks, min = ANGLE_TICK_MIN, max = ANGLE_TICK_MAX) {
  const n = Math.round(Number(ticks) || 0)
  if (n < min) return min
  if (n > max) return max
  return n
}

/**
 * 按 data_id 将 host 数值编码为协议字节（小端）。
 * @param {number} dataId
 * @param {number} value
 * @returns {number[]}
 */
export function encodeDataValue(dataId, value) {
  const size = DATA_ID_SIZE[dataId]
  if (!size) {
    throw new Error(`未知或未支持的 data_id：${dataId}`)
  }
  if (size === 1) return [Number(value) & 0xff]
  if (size === 2) {
    return DATA_ID_SIGNED.has(dataId) ? encodeI16Le(value) : encodeU16Le(value)
  }
  if (size === 4) {
    return encodeU32Le(value)
  }
  throw new Error(`不支持的 data_id 长度：${dataId} → ${size}`)
}

/**
 * 按 data_id 解码协议字节。
 * @param {number} dataId
 * @param {number[]|Uint8Array} bytes
 * @returns {number}
 */
export function decodeDataValue(dataId, bytes) {
  const size = DATA_ID_SIZE[dataId]
  if (!size) {
    throw new Error(`未知或未支持的 data_id：${dataId}`)
  }
  const arr = Array.from(bytes || [])
  if (arr.length < size) {
    throw new Error(`data_id=${dataId} 需要 ${size} 字节，实际 ${arr.length}`)
  }
  if (size === 1) return arr[0] & 0xff
  if (size === 2) {
    return DATA_ID_SIGNED.has(dataId) ? decodeI16Le(arr, 0) : decodeU16Le(arr, 0)
  }
  if (size === 4) return decodeU32Le(arr, 0)
  throw new Error(`不支持的 data_id 长度：${dataId} → ${size}`)
}

/**
 * 解析 READ_ANGLE 响应 content：`[id, i16angle_lo, i16angle_hi]`。
 * @returns {{ id:number, angleTicks:number, degrees:number }|null}
 */
export function parseReadAngleContent(content) {
  const c = Array.from(content || [])
  if (c.length < 3) return null
  const id = c[0] & 0xff
  const angleTicks = decodeI16Le(c, 1)
  return { id, angleTicks, degrees: angleTicksToDegrees(angleTicks) }
}

/**
 * 解析带 ret 的短响应：`[id, ret]`。
 * @returns {{ id:number, ret:number, ok:boolean }|null}
 */
export function parseIdRetContent(content) {
  const c = Array.from(content || [])
  if (c.length < 2) return null
  const id = c[0] & 0xff
  const ret = c[1] & 0xff
  return { id, ret, ok: ret === 1 }
}

/**
 * 解析 READ_DATA 响应：`[id, data_id, ...data]`。
 */
export function parseReadDataContent(content) {
  const c = Array.from(content || [])
  if (c.length < 2) return null
  const id = c[0] & 0xff
  const dataId = c[1] & 0xff
  const data = c.slice(2)
  let value
  try {
    value = data.length ? decodeDataValue(dataId, data) : undefined
  } catch {
    value = undefined
  }
  return { id, dataId, data, value }
}
