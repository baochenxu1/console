/**
 * FakeMotorProtocolAdapter — test-only Classic CAN stub.
 * Proves Neck Core / planning can swap protocols without knowing BM_HMD.
 */

import { createCanFrame } from "./canFrame.js"
import { packI16Be } from "./codec.js"
import {
  assertMotorProtocolAdapter,
  createMotorFeedback,
  MotorProtocolError,
} from "./motorProtocol.js"
import { assertMotorCommand } from "./motorCommand.js"

export const FAKE_MOTOR_PROTOCOL_TYPE = "fake-classic-can"
export const FAKE_MOTOR_PROTOCOL_VERSION = "fake-classic-can-v1"
export const FAKE_POSITION_ARB_ID = 0x123

/**
 * @param {object} [profile]
 */
export function createFakeMotorProtocolAdapter(profile = {}) {
  const can = profile.transport?.can || profile.can || {}
  const isFd = can.mode === "fd" ? true : false
  const brs = Boolean(can.brs)

  const adapter = {
    type: FAKE_MOTOR_PROTOCOL_TYPE,
    version: FAKE_MOTOR_PROTOCOL_VERSION,
    capabilities: Object.freeze({
      modes: Object.freeze(["POSITION"]),
      maxMotorsPerFrame: 4,
      supportsFeedback: true,
      requiresCanFd: false,
      requiresBrs: false,
    }),

    encodePositionCommand(motorCommand) {
      const cmd = assertMotorCommand(motorCommand)
      const slots = [0, 0, 0, 0]
      for (const m of cmd.motors) {
        const id = Number(m.logicalMotorId)
        if (id >= 1 && id <= 4) slots[id - 1] = Math.trunc(Number(m.positionRaw) || 0)
      }
      const data = new Uint8Array(8)
      for (let i = 0; i < 4; i++) {
        const packed = packI16Be(slots[i])
        data[i * 2] = packed[0]
        data[i * 2 + 1] = packed[1]
      }
      return createCanFrame({
        arbitrationId: FAKE_POSITION_ARB_ID,
        data,
        isExtendedId: false,
        isFd,
        brs: isFd ? brs : false,
      })
    },

    encodeEnableCommand(motorIds = [1, 2, 3]) {
      const ids = Array.isArray(motorIds) ? motorIds : [motorIds]
      const data = new Uint8Array(8)
      data[0] = 0x01
      data[1] = ids.length & 0xff
      return createCanFrame({
        arbitrationId: 0x124,
        data,
        isFd,
        brs: false,
      })
    },

    encodeDisableCommand(motorIds = [1, 2, 3]) {
      const ids = Array.isArray(motorIds) ? motorIds : [motorIds]
      const data = new Uint8Array(8)
      data[0] = 0x00
      data[1] = ids.length & 0xff
      return createCanFrame({
        arbitrationId: 0x124,
        data,
        isFd,
        brs: false,
      })
    },

    encodeControlModeCommand(motorId, mode = "POSITION") {
      const data = new Uint8Array(8)
      data[0] = Number(motorId) & 0xff
      data[1] = mode === "POSITION" ? 0x05 : 0x00
      return createCanFrame({
        arbitrationId: 0x125,
        data,
        isFd,
        brs: false,
      })
    },

    decodeFrame(frame) {
      if (!frame || typeof frame !== "object") {
        throw new MotorProtocolError("missing frame", "INVALID_FRAME")
      }
      // Minimal / null-heavy canonical feedback for architecture tests
      return {
        kind: "fake",
        feedback: createMotorFeedback({
          motorId: null,
          position: null,
          speed: null,
          current: null,
          voltage: null,
          fault: null,
          enabled: null,
          mode: null,
          kind: "fake",
          raw: {
            arbitrationId: frame.arbitrationId ?? null,
            isFd: Boolean(frame.isFd),
            dataLength: frame.data?.length ?? 0,
          },
        }),
      }
    },
  }

  return assertMotorProtocolAdapter(adapter)
}
