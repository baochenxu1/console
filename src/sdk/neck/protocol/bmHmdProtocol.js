/**
 * BM_HMD CAN FD protocol encode — port of Luvia bm_hmd.BmHmdProtocol (TX subset).
 * R2.1 adapter factory: see bmHmdProtocolAdapter.js (re-exported below).
 */

import { createCanFrame, assertProductionNeckTxFrame, dataToHex } from "./canFrame.js"
import { packI16Be, packU32Le, roundHalfAwayFromZero, CodecError } from "./codec.js"
import { rejectBrsConfig } from "../transport/transportProfile.js"

export class ProtocolError extends Error {
  constructor(message, code = "PROTOCOL_ERROR") {
    super(message)
    this.name = "ProtocolError"
    this.code = code
  }
}

export const ID_DRIVE_CMD_1_4 = 0x32
export const ID_PARAM_WRITE = 0x36
export const ID_STATE_CONTROL = 0x38
// ENGINEERING_ONLY / NOT_FOR_FACEDEV_CALIBRATION:
// BM_HMD absolute/firmware zero (historically ~0x39 / FLASH zero / Set Current as Motor Zero)
// must NEVER be wired into FaceDEV product Calibration UI or runtime path.
// FaceDEV Calibration is software trim only: mapping.side*.offsetDeg.

export const PARAM_WORK_MODE = 0x1d
export const CONTROL_MODE_POSITION = 0x05
export const POSITION_CMD_FULL_SCALE = 1000

export const BM_HMD_PROTOCOL_TYPE = "bm-hmd"
export const BM_HMD_PROTOCOL_VERSION = "bm-hmd-luvia-v1"

/** @enum {number} */
export const MotorCmd = Object.freeze({
  RESERVED: 0,
  DISABLE: 1,
  ENABLE: 2,
  /** ENGINEERING_ONLY — NOT_FOR_FACEDEV_CALIBRATION (state-control calibrate opcode) */
  CALIBRATE: 3,
})

export class BmHmdProtocol {
  /**
   * @param {{ fd?: boolean, brs?: boolean, production?: boolean }} [opts]
   */
  constructor({ fd = true, brs = false, production = false } = {}) {
    if (production) {
      rejectBrsConfig({ brs })
      if (fd !== true) {
        throw new ProtocolError("production BmHmdProtocol requires fd=true", "FD_REQUIRED")
      }
    }
    this.fd = Boolean(fd)
    // Hard rule: BRS must stay false unless explicitly proven safe.
    this.brs = Boolean(brs) && Boolean(fd)
    this.production = Boolean(production)
  }

  _frame(arbId, dataBytes) {
    const data = dataBytes instanceof Uint8Array ? dataBytes : new Uint8Array(dataBytes)
    if (data.length !== 8) {
      throw new ProtocolError(`stage-1 frames must be 8 bytes, got ${data.length}`, "DLC")
    }
    const frame = createCanFrame({
      arbitrationId: arbId,
      data,
      isExtendedId: false,
      isFd: this.fd,
      brs: this.brs,
    })
    if (this.production) {
      assertProductionNeckTxFrame(frame)
    }
    return frame
  }

  static commandAngleDegToRaw(commandAngleDeg) {
    const x = Number(commandAngleDeg) / 360.0 * POSITION_CMD_FULL_SCALE
    const raw = roundHalfAwayFromZero(x)
    if (raw < -POSITION_CMD_FULL_SCALE || raw > POSITION_CMD_FULL_SCALE) {
      throw new ProtocolError(
        `command-domain angle out of signed range ±${POSITION_CMD_FULL_SCALE} raw: ${commandAngleDeg}° → ${raw}`,
        "CMD_RANGE"
      )
    }
    return raw
  }

  /**
   * Encode 0x32 from signed raw slots (ID1..ID4). Range ±1000.
   */
  encodePositionCommandFrameFromRaw(motor1Raw, motor2Raw, motor3Raw = 0, motor4Raw = 0) {
    const raws = [Number(motor1Raw), Number(motor2Raw), Number(motor3Raw), Number(motor4Raw)].map(
      (r) => Math.trunc(r)
    )
    for (const raw of raws) {
      if (raw < -POSITION_CMD_FULL_SCALE || raw > POSITION_CMD_FULL_SCALE) {
        throw new ProtocolError(
          `command raw out of signed range ±${POSITION_CMD_FULL_SCALE}: ${raw}`,
          "CMD_RANGE"
        )
      }
    }
    const data = new Uint8Array(8)
    for (let idx = 0; idx < 4; idx++) {
      const packed = packI16Be(raws[idx])
      data[idx * 2] = packed[0]
      data[idx * 2 + 1] = packed[1]
    }
    return this._frame(ID_DRIVE_CMD_1_4, data)
  }

  /**
   * Encode 0x32 from command angles (deg). slot4 None→0 when omitted.
   */
  encodePositionCommandFrame({
    motor1CommandAngleDeg = null,
    motor2CommandAngleDeg = null,
    motor3CommandAngleDeg = null,
    motor4CommandAngleDeg = null,
    requireInitialized = true,
  } = {}) {
    const targets = [
      motor1CommandAngleDeg,
      motor2CommandAngleDeg,
      motor3CommandAngleDeg,
      motor4CommandAngleDeg,
    ]
    if (requireInitialized && (targets[0] == null || targets[1] == null)) {
      throw new ProtocolError("motor 1/2 targets must be initialized before encode", "UNINITIALIZED")
    }
    const raws = targets.map((deg) =>
      deg == null ? 0 : BmHmdProtocol.commandAngleDegToRaw(deg)
    )
    return this.encodePositionCommandFrameFromRaw(raws[0], raws[1], raws[2], raws[3])
  }

  encodeParameterWrite(motorId, paramIndex, valueU32) {
    this._checkMotorId(motorId)
    if (!(paramIndex >= 0 && paramIndex <= 0xff)) {
      throw new ProtocolError(`param index out of range: ${paramIndex}`, "PARAM_INDEX")
    }
    const payload = packU32Le(valueU32 >>> 0)
    const data = new Uint8Array(8)
    data[0] = motorId & 0xff
    data[1] = paramIndex & 0xff
    data[2] = payload[0]
    data[3] = payload[1]
    data[4] = payload[2]
    data[5] = payload[3]
    data[6] = 0
    data[7] = 0
    return this._frame(ID_PARAM_WRITE, data)
  }

  /** 0x36 set work mode to POSITION (0x05). */
  encodeSetPositionMode(motorId) {
    return this.encodeParameterWrite(motorId, PARAM_WORK_MODE, CONTROL_MODE_POSITION)
  }

  /**
   * 0x38 state control. cmds[i] in {0,1,2,3}; pad to 8 zeros.
   * @param {number[]} cmds
   */
  encodeStateControl(cmds) {
    const list = Array.isArray(cmds) ? cmds : []
    if (list.length > 8) {
      throw new ProtocolError("at most 8 motor cmds", "CMD_COUNT")
    }
    const data = new Uint8Array(8)
    for (let i = 0; i < list.length; i++) {
      const value = Number(list[i])
      if (![0, 1, 2, 3].includes(value)) {
        throw new ProtocolError(`invalid cmd: ${value}`, "INVALID_CMD")
      }
      data[i] = value
    }
    return this._frame(ID_STATE_CONTROL, data)
  }

  static _checkMotorId(motorId) {
    const id = Number(motorId)
    if (!(id >= 1 && id <= 8)) {
      throw new ProtocolError(`motor_id out of range 1..8: ${motorId}`, "MOTOR_ID")
    }
  }

  _checkMotorId(motorId) {
    BmHmdProtocol._checkMotorId(motorId)
  }
}

/** Production helper: fd=true, brs=false; rejects brs on construction. */
export function createProductionBmHmdProtocol() {
  return new BmHmdProtocol({ fd: true, brs: false, production: true })
}

export function frameDataHex(frame) {
  return dataToHex(frame.data)
}

// re-export for callers that catch CodecError from pack paths
export { CodecError }
