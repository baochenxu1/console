/**
 * SC / ST 位置写入数据编码 + 读取数据解码。
 *
 * 位置 (Present Position) 一律按 **无符号 16-bit** 解析。
 * 速度 / 电流 / 负载 等才使用 bit 符号位（scsToHost）。
 */

import { scsLoByte, scsHiByte, scsMakeWord, scsToHost } from "./scPacket.js"
import { SCS_END_SC, SCS_END_ST } from "./scProtocolConstants.js"
import { SC_POSITION_MAX, SC_POSITION_MIN } from "../core/servoProfile.js"

function clampInt(value, min, max) {
  const n = Math.round(Number(value) || 0)
  if (n < min) return min
  if (n > max) return max
  return n
}

/** 无符号 16-bit 字（SC/ST 位置读数）。 */
export function decodePresentPositionUnsigned(params, end = SCS_END_SC) {
  if (!params || params.length < 2) return null
  return scsMakeWord(params[0], params[1], end) & 0xffff
}

/**
 * 规范化位置读数：禁止负数；若解析为负则视为错误。
 * @returns {{ value: number|null, parseError?: string }}
 */
export function normalizeRawPosition(value) {
  if (value == null || !Number.isFinite(Number(value))) {
    return { value: null, parseError: "无效位置" }
  }
  const n = Math.round(Number(value))
  if (n < 0) {
    return {
      value: null,
      parseError: `位置解析为负数 (${n})，应使用 unsigned 16-bit 解析，请检查 decodePresentPosition`,
    }
  }
  return { value: n }
}

export function encodeScPositionData({ position, time = 0, speed = 0 }) {
  const pos = clampInt(position, SC_POSITION_MIN, SC_POSITION_MAX)
  const t = clampInt(time, 0, 65535)
  const spd = clampInt(speed, 0, 65535)
  return [
    scsLoByte(pos, SCS_END_SC),
    scsHiByte(pos, SCS_END_SC),
    scsLoByte(t, SCS_END_SC),
    scsHiByte(t, SCS_END_SC),
    scsLoByte(spd, SCS_END_SC),
    scsHiByte(spd, SCS_END_SC),
  ]
}

export function encodeStPositionData({ position, speed = 0, acc = 0 }) {
  const pos = clampInt(position, 0, 4095)
  const spd = clampInt(speed, 0, 65535)
  const a = clampInt(acc, 0, 255)
  return [
    a,
    scsLoByte(pos, SCS_END_ST),
    scsHiByte(pos, SCS_END_ST),
    0,
    0,
    scsLoByte(spd, SCS_END_ST),
    scsHiByte(spd, SCS_END_ST),
  ]
}

/** SC 位置（unsigned）。 */
export function decodeScPosition(params) {
  return decodePresentPositionUnsigned(params, SCS_END_SC)
}

/** ST 位置（unsigned，与 SC 相同语义，仅字节序不同）。 */
export function decodeStPosition(params) {
  return decodePresentPositionUnsigned(params, SCS_END_ST)
}

export function decodeScSpeed(params) {
  if (!params || params.length < 2) return null
  return scsToHost(scsMakeWord(params[0], params[1], SCS_END_SC), 15)
}

export function decodeScPosSpeed(params) {
  if (!params || params.length < 4) return null
  const position = decodePresentPositionUnsigned(params.slice(0, 2), SCS_END_SC)
  const speed = scsToHost(scsMakeWord(params[2], params[3], SCS_END_SC), 15)
  return { position, speed }
}

export function decodeStSpeed(params) {
  if (!params || params.length < 2) return null
  return scsToHost(scsMakeWord(params[0], params[1], SCS_END_ST), 15)
}

export function decodeStPosSpeed(params) {
  if (!params || params.length < 4) return null
  const position = decodePresentPositionUnsigned(params.slice(0, 2), SCS_END_ST)
  const speed = scsToHost(scsMakeWord(params[2], params[3], SCS_END_ST), 15)
  return { position, speed }
}
