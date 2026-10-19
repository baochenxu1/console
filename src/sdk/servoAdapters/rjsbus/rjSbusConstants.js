/**
 * 锐捷 RJ_SBUS 总线伺服舵机协议常量。
 *
 * 数据来源：东莞市锐捷齿轮传动有限公司《RJ_SBUS 总线伺服舵机通信协议》
 * （文档含 2024.12～2026.07 修订）。
 *
 * 约定：
 * - 主机串口默认 1M 8N1（与飞特 ST 共总线）；出厂常见 115200 仍可选手动切换。
 * - EEPROM 目标波特率工程默认 1M，可在参数页写入。
 * - 多字节均为小端序（LE）。
 * - 角度单位为 0.1°（int16）：90° → 900。
 * - 广播 ID = 255；单舵机 ID ∈ [0, 254]。
 * - 磁编码专用 / 轮式 / 阻尼 / 多圈等「暂不支持」指令不在本层实现。
 */

// ---- 包头 ----
export const REQUEST_HEADER_0 = 0x12
export const REQUEST_HEADER_1 = 0x4c
export const RESPONSE_HEADER_0 = 0x05
export const RESPONSE_HEADER_1 = 0x1c

// ---- ID ----
export const BROADCAST_ID = 0xff
export const MAX_ID = 0xfe

// ---- 指令码（仅实现控制台会用到的子集）----
export const CMD = Object.freeze({
  PING: 0x01,
  RESET_USER_DATA: 0x02,
  READ_DATA: 0x03,
  WRITE_DATA: 0x04,
  READ_BATCH_DATA_A: 0x05,
  WRITE_BATCH_DATA_A: 0x06,
  /** 角度模式控制 — 设置目标角度 / 时间 / 功率 */
  MOVE_ON_ANGLE_MODE: 0x08,
  READ_ANGLE: 0x0a,
  /** 角度模式控制 — 指定时间（含加减速段） */
  MOVE_ON_ANGLE_MODE_EX_BY_INTERVAL: 0x0b,
  READ_BATCH_DATA_B: 0x69, // 105
  WRITE_BATCH_DATA_B: 0x6a, // 106
  RESTART: 0x3c, // 60
  CLEAR_PROTECT_STATUS: 0x3d, // 61
  MOTOR_TEST_FORWARD: 0x3e, // 62
  MOTOR_TEST_REVERSAL: 0x3f, // 63
  SCAN: 0x40, // 64
})

/** A 区批量读写固定载荷长度（不含 ID）。 */
export const BATCH_A_DATA_BYTES = 32
/** B 区批量读写固定载荷长度（不含 ID）。文档写 40；响应长度字段以实机为准。 */
export const BATCH_B_DATA_BYTES = 40

// ---- 参数表 data_id（状态只读 + A/B 配置常用项）----
export const DATA_ID = Object.freeze({
  // 状态表（只读）
  VOLTAGE: 1,
  CURRENT: 2,
  POWER: 3,
  TEMPERATURE: 4,
  SERVO_STATUS: 5,
  SERVO_TYPE: 6,
  FIRMWARE_VERSION: 7,
  SERIAL_NUMBER: 8,
  ANGLE_ADC: 9,
  OVERLOAD_PROTECTION_STATUS: 10,

  // A 区配置
  RESPONSE_SWITCH: 33,
  SERVO_ID: 34,
  BAUDRATE: 36,
  STALL_PROTECT_MODE: 37,
  STALL_POWER_LIMIT: 38,
  OVER_VOLT_LOW: 39,
  OVER_VOLT_HIGH: 40,
  OVER_TEMPERATURE: 41,
  OVER_POWER: 42,
  OVER_CURRENT: 43,
  PO_LOCK_SWITCH: 46,
  SOFT_START_SWITCH: 49,
  SOFT_START_TIME: 50,
  ANGLE_LIMIT_HIGH: 51,
  ANGLE_LIMIT_LOW: 52,
  ANGLE_MID_OFFSET: 53,

  // B 区配置
  STALL_POWER_TIME: 100,
  PID_P: 101,
  PID_I: 102,
  PID_D: 103,
  ANGLE_UPPER_LIMIT_ADC: 106,
  ANGLE_LOWER_LIMIT_ADC: 107,
  DRIVER_MAX_PER: 108,
  DRIVER_MIN_PER: 109,
})

/** data_id → 字节长度（用于 READ/WRITE_DATA 编解码）。 */
export const DATA_ID_SIZE = Object.freeze({
  [DATA_ID.VOLTAGE]: 2,
  [DATA_ID.CURRENT]: 2,
  [DATA_ID.POWER]: 2,
  [DATA_ID.TEMPERATURE]: 2,
  [DATA_ID.SERVO_STATUS]: 1,
  [DATA_ID.SERVO_TYPE]: 2,
  [DATA_ID.FIRMWARE_VERSION]: 2,
  [DATA_ID.SERIAL_NUMBER]: 4,
  [DATA_ID.ANGLE_ADC]: 2,
  [DATA_ID.OVERLOAD_PROTECTION_STATUS]: 2,
  [DATA_ID.RESPONSE_SWITCH]: 1,
  [DATA_ID.SERVO_ID]: 1,
  [DATA_ID.BAUDRATE]: 1,
  [DATA_ID.STALL_PROTECT_MODE]: 1,
  [DATA_ID.STALL_POWER_LIMIT]: 2,
  [DATA_ID.OVER_VOLT_LOW]: 2,
  [DATA_ID.OVER_VOLT_HIGH]: 2,
  [DATA_ID.OVER_TEMPERATURE]: 2,
  [DATA_ID.OVER_POWER]: 2,
  [DATA_ID.OVER_CURRENT]: 2,
  [DATA_ID.PO_LOCK_SWITCH]: 1,
  [DATA_ID.SOFT_START_SWITCH]: 1,
  [DATA_ID.SOFT_START_TIME]: 2,
  [DATA_ID.ANGLE_LIMIT_HIGH]: 2,
  [DATA_ID.ANGLE_LIMIT_LOW]: 2,
  [DATA_ID.ANGLE_MID_OFFSET]: 2,
  [DATA_ID.STALL_POWER_TIME]: 4,
  [DATA_ID.PID_P]: 4,
  [DATA_ID.PID_I]: 4,
  [DATA_ID.PID_D]: 4,
  [DATA_ID.ANGLE_UPPER_LIMIT_ADC]: 4,
  [DATA_ID.ANGLE_LOWER_LIMIT_ADC]: 4,
  [DATA_ID.DRIVER_MAX_PER]: 4,
  [DATA_ID.DRIVER_MIN_PER]: 4,
})

/** 带符号 data_id（按 int16/int32 解释）。 */
export const DATA_ID_SIGNED = Object.freeze(
  new Set([DATA_ID.ANGLE_LIMIT_HIGH, DATA_ID.ANGLE_LIMIT_LOW, DATA_ID.ANGLE_MID_OFFSET])
)

/** 波特率选项码 → bps。 */
export const BAUD_OPTION = Object.freeze({
  1: 9600,
  2: 19200,
  3: 38400,
  4: 57600,
  5: 115200,
  6: 250000,
  7: 500000,
  8: 1000000,
})

/** @returns {number | null} */
export function baudBpsFromOptionCode(code) {
  const n = Number(code)
  if (!Number.isFinite(n)) return null
  const bps = BAUD_OPTION[n]
  return Number.isFinite(bps) ? bps : null
}

/**
 * bps 或选项码 → 协议写入用的选项码 1..8。
 * @returns {number | null}
 */
export function baudOptionCodeFromInput(bpsOrCode) {
  const n = Number(bpsOrCode)
  if (!Number.isFinite(n)) return null
  if (BAUD_OPTION[n] != null) return n
  for (const [code, bps] of Object.entries(BAUD_OPTION)) {
    if (Number(bps) === n) return Number(code)
  }
  return null
}

/** 主机 WebSerial / 串口面板默认波特率（与飞特 ST 共总线时用 1M） */
export const DEFAULT_RJ_BAUDRATE = 1000000
/** 参数页「RJ 波特率 EEPROM」目标下拉默认（工程目标 1M） */
export const DEFAULT_RJ_EEPROM_BAUDRATE = 1000000
/** UI / 串口连接常用档 */
export const COMMON_RJ_BAUDRATES = [1000000, 115200]

/** 拓展指令密钥。 */
export const RESTART_KEY = Object.freeze([0x12, 0x34, 0x56, 0x78])
export const CLEAR_PROTECT_KEY = Object.freeze([0xfe, 0xdc, 0xba, 0x98])

/** 协议可表示角度范围（0.1° ticks，signed）；实机以 A 区限位为准。 */
export const ANGLE_TICK_HARD_MIN = -1500
export const ANGLE_TICK_HARD_MAX = 1500

/**
 * Face Console / RJ 协议安全窗（有符号，MID_OFFSET=0 时中位为 0）：
 * 模型层仍是机构 0°～180° / 中位±90°；
 * 固定映射到协议 ticks -900 / 0 / +900（落在实机常见限位 -1500～1500 内）。
 */
export const ANGLE_TICK_MIN = -900
export const ANGLE_TICK_CENTER = 0
export const ANGLE_TICK_MAX = 900

export const ANGLE_DEG_MIN = -90
export const ANGLE_DEG_CENTER = 0
export const ANGLE_DEG_MAX = 90

export const RET = Object.freeze({
  FAIL: 0,
  OK: 1,
})
