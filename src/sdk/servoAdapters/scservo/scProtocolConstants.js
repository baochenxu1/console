/**
 * SCServo (Feetech) 协议常量。
 *
 * 数据来源：官方 STServo_Python SDK（scservo_def.py / scscl.py / sms_sts.py）。
 * 仅作为协议与寄存器参考，不直接引入 Python SDK 本体。
 *
 * 重要：SC 与 ST 字节序不同。
 *   - SC (scscl):   scs_end = 1 -> 字（word）按「高字节在前」打包；
 *   - ST (sms_sts): scs_end = 0 -> 字（word）按「低字节在前」打包。
 * 详见 scPacket.js 的 scsLoByte / scsHiByte。
 */

// ---- 包头 ----
export const PACKET_HEADER = 0xff

// ---- 广播 ID ----
/** Feetech Python SDK 默认（scservo_def.py） */
export const BROADCAST_ID_SDK = 0xff
/** 通讯协议手册示例（254 = 0xFE） */
export const BROADCAST_ID_MANUAL = 0xfe
/** @deprecated 使用 BROADCAST_ID_SDK；保留别名兼容旧代码 */
export const BROADCAST_ID = BROADCAST_ID_SDK
export const MAX_ID = 0xfc

/** @typedef {0xff | 0xfe} ScsclBroadcastId */

/** @returns {ScsclBroadcastId} */
export function normalizeScsclBroadcastId(value) {
  const n = Number(value)
  if (n === 0xfe || n === 254) return 0xfe
  return 0xff
}

export function formatScsclBroadcastId(value) {
  return `0x${normalizeScsclBroadcastId(value).toString(16).toUpperCase().padStart(2, "0")}`
}

// ---- 指令码 ----
export const INSTRUCTION = Object.freeze({
  PING: 0x01,
  READ: 0x02,
  WRITE: 0x03,
  REG_WRITE: 0x04,
  ACTION: 0x05,
  SYNC_READ: 0x82,
  SYNC_WRITE: 0x83,
})

// ---- 协议字节序标记 ----
export const SCS_END_SC = 1 // scscl
export const SCS_END_ST = 0 // sms_sts

// ---- 协议标识（与 servoProfile.protocol 对应）----
export const PROTOCOL = Object.freeze({
  SCSCL: "scscl",
  SMS_STS: "sms_sts",
  /** 锐捷 RJ_SBUS 总线伺服 */
  RJ_SBUS: "rj_sbus",
})

/**
 * SC 系列（scscl）寄存器表。
 * 参考 scscl.py。
 */
export const SC_REG = Object.freeze({
  MODEL_L: 3,
  ID: 5,
  BAUD_RATE: 6,
  MIN_ANGLE_LIMIT_L: 9,
  MAX_ANGLE_LIMIT_L: 11,
  TORQUE_ENABLE: 40,
  GOAL_POSITION_L: 42,
  GOAL_POSITION_H: 43,
  GOAL_TIME_L: 44,
  GOAL_TIME_H: 45,
  GOAL_SPEED_L: 46,
  GOAL_SPEED_H: 47,
  LOCK: 48,
  PRESENT_POSITION_L: 56,
  PRESENT_POSITION_H: 57,
  PRESENT_SPEED_L: 58,
  PRESENT_SPEED_H: 59,
  PRESENT_LOAD_L: 60,
  PRESENT_VOLTAGE: 62,
  PRESENT_TEMPERATURE: 63,
  MOVING: 66,
  PRESENT_CURRENT_L: 69,
})

// SC SyncWrite：起始地址 GOAL_POSITION_L=42，数据长度 6（pos/time/speed 各 2 字节）
export const SC_SYNC_WRITE_START = SC_REG.GOAL_POSITION_L
export const SC_SYNC_WRITE_DATA_LENGTH = 6

/**
 * ST / SMS / STS 系列（sms_sts）寄存器表。
 * 参考 sms_sts.py。
 */
export const ST_REG = Object.freeze({
  MODEL_L: 3,
  ID: 5,
  BAUD_RATE: 6,
  MIN_ANGLE_LIMIT_L: 9,
  MAX_ANGLE_LIMIT_L: 11,
  MODE: 33,
  TORQUE_ENABLE: 40,
  ACC: 41,
  GOAL_POSITION_L: 42,
  GOAL_POSITION_H: 43,
  GOAL_TIME_L: 44,
  GOAL_SPEED_L: 46,
  GOAL_SPEED_H: 47,
  LOCK: 55,
  PRESENT_POSITION_L: 56,
  PRESENT_POSITION_H: 57,
  PRESENT_SPEED_L: 58,
  PRESENT_LOAD_L: 60,
  PRESENT_VOLTAGE: 62,
  PRESENT_TEMPERATURE: 63,
  MOVING: 66,
  PRESENT_CURRENT_L: 69,
})

// ST SyncWrite：起始地址 ACC=41，数据长度 7（acc + pos2 + 保留2 + speed2）
export const ST_SYNC_WRITE_START = ST_REG.ACC
export const ST_SYNC_WRITE_DATA_LENGTH = 7

// ---- 通信结果码（对齐官方 COMM_*）----
export const COMM = Object.freeze({
  SUCCESS: 0,
  PORT_BUSY: -1,
  TX_FAIL: -2,
  RX_FAIL: -3,
  TX_ERROR: -4,
  RX_WAITING: -5,
  RX_TIMEOUT: -6,
  RX_CORRUPT: -7,
  NOT_AVAILABLE: -9,
})

// ---- 舵机状态错误位 ----
export const ERROR_BIT = Object.freeze({
  VOLTAGE: 1,
  ANGLE: 2,
  OVERHEAT: 4,
  OVERELE: 8,
  OVERLOAD: 32,
})

export function describeServoError(error) {
  if (!error) return ""
  const parts = []
  if (error & ERROR_BIT.VOLTAGE) parts.push("电压异常")
  if (error & ERROR_BIT.ANGLE) parts.push("角度传感异常")
  if (error & ERROR_BIT.OVERHEAT) parts.push("过热")
  if (error & ERROR_BIT.OVERELE) parts.push("过流")
  if (error & ERROR_BIT.OVERLOAD) parts.push("过载")
  return parts.join("、")
}

// ---- 常用波特率（默认 1M）----
export const DEFAULT_SC_BAUDRATE = 1000000
export const COMMON_BAUDRATES = [1000000, 500000, 250000, 128000, 115200, 57600, 38400]
