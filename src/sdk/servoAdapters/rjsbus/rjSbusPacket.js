/**
 * 锐捷 RJ_SBUS 包构建 / 解析 / 校验。
 *
 * 请求包：
 *   0x12 0x4C | cmd_id | n | content[0..n-1] | checksum
 * 响应包：
 *   0x05 0x1C | cmd_id | n | content[0..n-1] | checksum
 *
 * 校验：对 [0 .. 4+n-1] 字节求和后对 256 取余（即 & 0xFF）。
 * 多字节字段：小端序。
 */

import {
  REQUEST_HEADER_0,
  REQUEST_HEADER_1,
  RESPONSE_HEADER_0,
  RESPONSE_HEADER_1,
  CMD,
} from "./rjSbusConstants.js"

function u8(value) {
  return value & 0xff
}

/** 无符号 16 位 → LE 两字节。 */
export function encodeU16Le(value) {
  const w = value & 0xffff
  return [w & 0xff, (w >> 8) & 0xff]
}

/** 有符号 16 位 → LE 两字节（按补码）。 */
export function encodeI16Le(value) {
  return encodeU16Le(value)
}

/** 无符号 32 位 → LE 四字节。 */
export function encodeU32Le(value) {
  const n = value >>> 0
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]
}

/** 有符号 32 位 → LE 四字节。 */
export function encodeI32Le(value) {
  return encodeU32Le(value)
}

export function decodeU16Le(bytes, offset = 0) {
  const a = bytes[offset] & 0xff
  const b = bytes[offset + 1] & 0xff
  return a | (b << 8)
}

export function decodeI16Le(bytes, offset = 0) {
  const u = decodeU16Le(bytes, offset)
  return u > 0x7fff ? u - 0x10000 : u
}

export function decodeU32Le(bytes, offset = 0) {
  const a = bytes[offset] & 0xff
  const b = bytes[offset + 1] & 0xff
  const c = bytes[offset + 2] & 0xff
  const d = bytes[offset + 3] & 0xff
  return (a | (b << 8) | (c << 16) | (d << 24)) >>> 0
}

export function decodeI32Le(bytes, offset = 0) {
  const u = decodeU32Le(bytes, offset)
  return u > 0x7fffffff ? u - 0x100000000 : u
}

/**
 * 计算校验和：sum(bytes) & 0xFF。
 * @param {number[]|Uint8Array} bytes
 */
export function computeChecksum(bytes) {
  let sum = 0
  for (let i = 0; i < bytes.length; i += 1) {
    sum += bytes[i] & 0xff
  }
  return sum & 0xff
}

/**
 * 构建请求包。
 * @param {number} cmdId
 * @param {number[]} content 内容负载（通常以舵机 ID 开头）
 * @returns {Uint8Array}
 */
export function buildRequest(cmdId, content = []) {
  const body = (content || []).map(u8)
  const n = body.length
  const prefix = [REQUEST_HEADER_0, REQUEST_HEADER_1, u8(cmdId), u8(n), ...body]
  const checksum = computeChecksum(prefix)
  return Uint8Array.from([...prefix, checksum])
}

/** PING / 通讯检测。 */
export function buildPing(id) {
  return buildRequest(CMD.PING, [u8(id)])
}

/** A&B 区配置重置。 */
export function buildResetUserData(id) {
  return buildRequest(CMD.RESET_USER_DATA, [u8(id)])
}

/** 读参数表单项。 */
export function buildReadData(id, dataId) {
  return buildRequest(CMD.READ_DATA, [u8(id), u8(dataId)])
}

/**
 * 写参数表单项。
 * @param {number} id
 * @param {number} dataId
 * @param {number[]} dataBytes
 */
export function buildWriteData(id, dataId, dataBytes = []) {
  return buildRequest(CMD.WRITE_DATA, [u8(id), u8(dataId), ...dataBytes.map(u8)])
}

export function buildReadBatchDataA(id) {
  return buildRequest(CMD.READ_BATCH_DATA_A, [u8(id)])
}

export function buildWriteBatchDataA(id, data32) {
  const data = (data32 || []).map(u8)
  if (data.length !== 32) {
    throw new Error(`WRITE_BATCH_DATA_A 需要 32 字节，实际 ${data.length}`)
  }
  return buildRequest(CMD.WRITE_BATCH_DATA_A, [u8(id), ...data])
}

export function buildReadBatchDataB(id) {
  return buildRequest(CMD.READ_BATCH_DATA_B, [u8(id)])
}

export function buildWriteBatchDataB(id, data40) {
  const data = (data40 || []).map(u8)
  if (data.length !== 40) {
    throw new Error(`WRITE_BATCH_DATA_B 需要 40 字节，实际 ${data.length}`)
  }
  return buildRequest(CMD.WRITE_BATCH_DATA_B, [u8(id), ...data])
}

/**
 * 角度模式控制（cmd 8）。
 * @param {number} id
 * @param {{ angleTicks:number, timeMs?:number, power?:number }} opts
 *   angleTicks：目标角度，单位 0.1°（signed int16）
 *   timeMs：到达时间 ms；0 表示尽快
 *   power：执行功率；0 表示按上限
 */
export function buildMoveOnAngleMode(id, { angleTicks, timeMs = 0, power = 0 } = {}) {
  return buildRequest(CMD.MOVE_ON_ANGLE_MODE, [
    u8(id),
    ...encodeI16Le(angleTicks),
    ...encodeU16Le(timeMs),
    ...encodeU16Le(power),
  ])
}

/** 读取当前角度（cmd 10）。 */
export function buildReadAngle(id) {
  return buildRequest(CMD.READ_ANGLE, [u8(id)])
}

/**
 * 角度模式控制 — 指定时间（cmd 11，含加减速）。
 * @param {number} id
 * @param {{
 *   angleTicks:number,
 *   intervalMs?:number,
 *   accIntervalMs?:number,
 *   decIntervalMs?:number,
 *   power?:number
 * }} opts
 */
export function buildMoveOnAngleModeExByInterval(
  id,
  { angleTicks, intervalMs = 0, accIntervalMs = 0, decIntervalMs = 0, power = 0 } = {}
) {
  return buildRequest(CMD.MOVE_ON_ANGLE_MODE_EX_BY_INTERVAL, [
    u8(id),
    ...encodeI16Le(angleTicks),
    ...encodeU16Le(intervalMs),
    ...encodeU16Le(accIntervalMs),
    ...encodeU16Le(decIntervalMs),
    ...encodeU16Le(power),
  ])
}

export function buildRestart(id) {
  return buildRequest(CMD.RESTART, [u8(id), 0x12, 0x34, 0x56, 0x78])
}

export function buildClearProtectStatus(id) {
  return buildRequest(CMD.CLEAR_PROTECT_STATUS, [u8(id), 0xfe, 0xdc, 0xba, 0x98])
}

export function buildMotorTestForward(id) {
  return buildRequest(CMD.MOTOR_TEST_FORWARD, [u8(id)])
}

export function buildMotorTestReversal(id) {
  return buildRequest(CMD.MOTOR_TEST_REVERSAL, [u8(id)])
}

/**
 * 舵机扫描（cmd 64）。
 * @param {number} id
 * @param {number} stepTimeMs 1..50
 */
export function buildScan(id, stepTimeMs = 10) {
  const t = Math.max(1, Math.min(50, Math.round(Number(stepTimeMs) || 10)))
  return buildRequest(CMD.SCAN, [u8(id), u8(t)])
}

/**
 * 从缓冲中查找并解析一条响应包。
 * @param {Uint8Array|number[]} buffer
 * @param {object} [options]
 * @param {number} [options.expectedId] 期望 content[0]（舵机 ID）
 * @param {number} [options.expectedCmd] 期望 cmd_id
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   cmdId?: number,
 *   id?: number,
 *   content?: number[],
 *   raw?: number[],
 *   consumedUntil?: number
 * }}
 */
export function parseResponsePacket(buffer, options = {}) {
  const bytes = Array.from(buffer || [])
  const { expectedId, expectedCmd } = options

  for (let i = 0; i + 4 < bytes.length; i += 1) {
    if (bytes[i] !== RESPONSE_HEADER_0 || bytes[i + 1] !== RESPONSE_HEADER_1) continue

    const cmdId = bytes[i + 2]
    const n = bytes[i + 3]
    const totalLen = 5 + n // header(2)+cmd+n+content(n)+checksum
    if (i + totalLen > bytes.length) {
      return { ok: false, reason: "incomplete" }
    }

    const frame = bytes.slice(i, i + totalLen)
    const content = frame.slice(4, 4 + n)
    const checksum = frame[totalLen - 1]
    const calc = computeChecksum(frame.slice(0, totalLen - 1))
    if (checksum !== calc) {
      continue
    }

    const id = content.length > 0 ? content[0] : undefined
    if (typeof expectedCmd === "number" && cmdId !== expectedCmd) {
      continue
    }
    if (typeof expectedId === "number" && id !== expectedId) {
      continue
    }

    return {
      ok: true,
      cmdId,
      id,
      content,
      raw: frame,
      consumedUntil: i + totalLen,
    }
  }

  return { ok: false, reason: "not-found" }
}

/** 将字节数组格式化为十六进制字符串（调试用）。 */
export function toHex(bytes) {
  return Array.from(bytes || [])
    .map((b) => (b & 0xff).toString(16).toUpperCase().padStart(2, "0"))
    .join(" ")
}

/** 取完整包最后一字节校验和。 */
export function packetChecksumByte(bytes) {
  const arr = Array.from(bytes || [])
  if (!arr.length) return null
  return arr[arr.length - 1] & 0xff
}
