/**
 * 通用 SCServo 包构建 / 解析 / 校验。
 *
 * 包格式：
 *   0xFF 0xFF ID LENGTH INSTRUCTION PARAM... CHECKSUM
 * 其中：
 *   LENGTH    = 参数字节数 + 2 (INSTRUCTION + CHECKSUM)
 *   CHECKSUM  = ~(ID + LENGTH + INSTRUCTION + sum(PARAM)) & 0xFF
 *
 * 状态返回包：
 *   0xFF 0xFF ID LENGTH ERROR PARAM... CHECKSUM
 *
 * 行为对齐官方 protocol_packet_handler.py。
 */

import {
  PACKET_HEADER,
  BROADCAST_ID,
  INSTRUCTION,
  SCS_END_SC,
} from "./scProtocolConstants.js"

/** 限幅为无符号字节。 */
function u8(value) {
  return value & 0xff
}

/**
 * 取字（16bit）的「低位字节」。
 * scs_end=1（SC）时，低位字节实际取高 8 位；scs_end=0（ST）时取低 8 位。
 * 与官方 scs_lobyte 完全一致，保证线缆字节序兼容。
 */
export function scsLoByte(value, end = SCS_END_SC) {
  const w = value & 0xffff
  return end === 0 ? w & 0xff : (w >> 8) & 0xff
}

/** 取字（16bit）的「高位字节」，与官方 scs_hibyte 一致。 */
export function scsHiByte(value, end = SCS_END_SC) {
  const w = value & 0xffff
  return end === 0 ? (w >> 8) & 0xff : w & 0xff
}

/** 由低/高字节合成字，与官方 scs_makeword 一致。 */
export function scsMakeWord(a, b, end = SCS_END_SC) {
  if (end === 0) {
    return (a & 0xff) | ((b & 0xff) << 8)
  }
  return (b & 0xff) | ((a & 0xff) << 8)
}

/**
 * 将「带符号位」编码（最高位为符号位）转换为带符号 host 值。
 * SCServo 速度/位置在 wheel 模式下用 bit15 表示方向，对齐官方 scs_tohost。
 */
export function scsToHost(value, signBit) {
  if (value & (1 << signBit)) {
    return -(value & ~(1 << signBit))
  }
  return value
}

/** host 带符号值转 SCServo 编码，对齐官方 scs_toscs。 */
export function scsToScs(value, signBit) {
  if (value < 0) {
    return -value | (1 << signBit)
  }
  return value
}

/**
 * 计算校验和：~(ID + LENGTH + INST + PARAMS) & 0xFF。
 * @param {number[]} bytesFromId 从 ID 开始（含 LENGTH/INST/PARAMS），不含校验位本身。
 */
export function computeChecksum(bytesFromId) {
  let sum = 0
  for (let i = 0; i < bytesFromId.length; i += 1) {
    sum += bytesFromId[i] & 0xff
  }
  return ~sum & 0xff
}

/**
 * 构建一条指令包。
 * @param {number} id 舵机 ID（0..253 或广播）。
 * @param {number} instruction 指令码。
 * @param {number[]} [params] 参数字节。
 * @returns {Uint8Array}
 */
export function buildPacket(id, instruction, params = []) {
  const safeParams = (params || []).map(u8)
  const length = safeParams.length + 2 // INSTRUCTION + CHECKSUM
  const body = [u8(id), u8(length), u8(instruction), ...safeParams]
  const checksum = computeChecksum(body)
  return Uint8Array.from([PACKET_HEADER, PACKET_HEADER, ...body, checksum])
}

/** PING。 */
export function buildPing(id) {
  return buildPacket(id, INSTRUCTION.PING, [])
}

/** READ：从 address 读 length 个字节。 */
export function buildRead(id, address, length) {
  return buildPacket(id, INSTRUCTION.READ, [u8(address), u8(length)])
}

/** WRITE：向 address 写入 data 字节。 */
export function buildWrite(id, address, data) {
  return buildPacket(id, INSTRUCTION.WRITE, [u8(address), ...(data || []).map(u8)])
}

/** REG_WRITE：异步写（配合 ACTION 一起触发）。 */
export function buildRegWrite(id, address, data) {
  return buildPacket(id, INSTRUCTION.REG_WRITE, [u8(address), ...(data || []).map(u8)])
}

/** ACTION：触发已缓存的 REG_WRITE。 */
export function buildAction(broadcastId = BROADCAST_ID) {
  return buildPacket(broadcastId, INSTRUCTION.ACTION, [])
}

/**
 * SYNC_WRITE：同一起始地址、同一数据长度，对多个舵机批量写。
 * @param {number} startAddress 起始寄存器地址。
 * @param {number} dataLength 每个舵机的数据字节数。
 * @param {{ id:number, data:number[] }[]} items 每个舵机的 {id, data}。
 * @returns {Uint8Array}
 */
export function buildSyncWrite(startAddress, dataLength, items, broadcastId = BROADCAST_ID) {
  const list = Array.isArray(items) ? items : []
  const params = [u8(startAddress), u8(dataLength)]
  for (const item of list) {
    const data = (item.data || []).slice(0, dataLength).map(u8)
    if (data.length !== dataLength) {
      throw new Error(
        `SyncWrite 数据长度不符：id=${item.id} 期望 ${dataLength} 字节，实际 ${data.length}`
      )
    }
    params.push(u8(item.id), ...data)
  }
  return buildPacket(broadcastId, INSTRUCTION.SYNC_WRITE, params)
}

/** 取完整包最后一字节校验和（不含字头 FF FF）。 */
export function packetChecksumByte(bytes) {
  const arr = Array.from(bytes || [])
  if (!arr.length) return null
  return arr[arr.length - 1] & 0xff
}

export function formatPacketChecksum(bytes) {
  const cs = packetChecksumByte(bytes)
  if (cs == null) return ""
  return `0x${cs.toString(16).toUpperCase().padStart(2, "0")}`
}

/** SYNC_READ 指令包。 */
export function buildSyncRead(startAddress, dataLength, ids) {
  const list = (ids || []).map(u8)
  return buildPacket(BROADCAST_ID, INSTRUCTION.SYNC_READ, [
    u8(startAddress),
    u8(dataLength),
    ...list,
  ])
}

/**
 * 从字节缓冲中查找并解析一条状态返回包。
 * @param {Uint8Array|number[]} buffer 收到的原始字节。
 * @param {object} [options]
 * @param {number} [options.expectedId] 期望的舵机 ID（用于跳过无关包）。
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   id?: number,
 *   error?: number,
 *   params?: number[],
 *   raw?: number[],
 *   consumedUntil?: number
 * }}
 */
export function parseStatusPacket(buffer, options = {}) {
  const bytes = Array.from(buffer || [])
  const { expectedId } = options

  for (let i = 0; i + 5 < bytes.length; i += 1) {
    if (bytes[i] !== 0xff || bytes[i + 1] !== 0xff) continue
    // 跳过填充 0xFF：确保 ID 字节不是 0xFF
    if (bytes[i + 2] === 0xff) continue

    const id = bytes[i + 2]
    const length = bytes[i + 3]
    if (length < 2) continue

    const totalLen = length + 4 // header(2) + id + length...
    if (i + totalLen > bytes.length) {
      // 包还没收全
      return { ok: false, reason: "incomplete" }
    }

    const error = bytes[i + 4]
    const params = bytes.slice(i + 5, i + totalLen - 1)
    const checksum = bytes[i + totalLen - 1]
    const calc = computeChecksum(bytes.slice(i + 2, i + totalLen - 1))
    const raw = bytes.slice(i, i + totalLen)

    if (checksum !== calc) {
      // 校验失败，继续向后找下一个包头
      continue
    }
    if (typeof expectedId === "number" && id !== expectedId) {
      // 不是期望的舵机，继续找
      continue
    }

    return {
      ok: true,
      id,
      error,
      params,
      raw,
      consumedUntil: i + totalLen,
    }
  }

  return { ok: false, reason: "not-found" }
}

/** 将字节数组格式化为十六进制字符串（调试用）。 */
export function toHex(bytes) {
  return Array.from(bytes || [])
    .map((b) => (b & 0xff).toString(16).padStart(2, "0").toUpperCase())
    .join(" ")
}
