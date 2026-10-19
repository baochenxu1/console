/**
 * Servo Adapter 层通用类型与枚举。
 */

import { PROTOCOL } from "../scservo/scProtocolConstants.js"

export { PROTOCOL }

/** 舵机数值单位。 */
export const SERVO_UNIT = Object.freeze({
  SC_POSITION: "sc_position", // SC 系列位置（0..4095）
  ST_POSITION: "st_position", // ST 系列位置（0..4095）
  RJ_ANGLE_TICK: "rj_angle_tick", // RJ_SBUS：有符号 0.1° ticks；模型窗 -900～+900（中位 0）↔ 机构 ±90°
  /** @deprecated 逻辑绑定空间仍用 500–2500；不再作为协议单位 */
  PWM_US: "pwm_us",
})

/** 协议 -> 默认单位。 */
export function defaultUnitForProtocol(protocol) {
  switch (protocol) {
    case PROTOCOL.SMS_STS:
      return SERVO_UNIT.ST_POSITION
    case PROTOCOL.RJ_SBUS:
      return SERVO_UNIT.RJ_ANGLE_TICK
    case PROTOCOL.SCSCL:
    default:
      return SERVO_UNIT.SC_POSITION
  }
}

/**
 * @typedef {Object} ServoCommandResult
 * @property {boolean} ok
 * @property {string} [error]        失败原因（可显示）
 * @property {number} [id]
 * @property {number[]} [txBytes]    发送的原始字节
 * @property {number[]} [rxBytes]    收到的原始字节
 * @property {number} [servoError]   舵机状态错误位
 * @property {*} [value]             读取类指令的解析值
 */

/**
 * @typedef {Object} ServoWritePositionOptions
 * @property {number} [time]   SC：运动时间（ms 计的协议单位）
 * @property {number} [speed]  目标速度
 * @property {number} [acc]    ST：加速度
 */

/**
 * @typedef {Object} ServoSyncWriteCommand
 * @property {number} id
 * @property {number} position
 * @property {number} [time]
 * @property {number} [speed]
 * @property {number} [acc]
 */
