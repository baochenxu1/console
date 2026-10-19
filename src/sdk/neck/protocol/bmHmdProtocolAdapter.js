/**
 * BM_HMD MotorProtocol Adapter factory (separated to avoid circular imports
 * with bmHmdFeedback ↔ bmHmdProtocol).
 */

import {
  BmHmdProtocol,
  MotorCmd,
  CONTROL_MODE_POSITION,
  BM_HMD_PROTOCOL_TYPE,
  BM_HMD_PROTOCOL_VERSION,
  ProtocolError,
} from "./bmHmdProtocol.js"
import { decodeFeedbackFrame } from "./bmHmdFeedback.js"
import {
  assertMotorProtocolAdapter,
  createMotorFeedback,
  MotorProtocolError,
} from "./motorProtocol.js"
import { assertMotorCommand } from "./motorCommand.js"
import { rejectBrsConfig, normalizeTransportConfig } from "../transport/transportProfile.js"

function resolveBmHmdFrameFlags(profile = {}) {
  const nested =
    profile.transport || profile.can
      ? normalizeTransportConfig(profile.transport || { can: profile.can, ...profile })
      : normalizeTransportConfig({
          canFd: profile.canFd !== false && profile.fd !== false,
          brs: profile.brs,
          arbitrationBitrate: profile.arbitrationBitrate,
          dataBitrate: profile.dataBitrate,
        })

  if (nested.can.brs === true) {
    rejectBrsConfig(nested)
  }
  if (nested.can.mode === "classic") {
    throw new MotorProtocolError(
      "BM_HMD requires CAN FD; classic transport is incompatible",
      "PROTOCOL_TRANSPORT_INCOMPATIBLE"
    )
  }

  return {
    isFd: true,
    brs: false,
    transport: nested,
  }
}

function slotsFromMotorCommand(motorCommand) {
  const cmd = assertMotorCommand(motorCommand)
  const slots = [0, 0, 0, 0]
  for (const m of cmd.motors) {
    const id = Number(m.logicalMotorId)
    if (id >= 1 && id <= 4) {
      slots[id - 1] = Math.trunc(Number(m.positionRaw) || 0)
    }
  }
  return slots
}

function stateControlForMotors(proto, motorIds, cmdValue) {
  const ids = Array.isArray(motorIds) ? motorIds.map(Number) : [1, 2, 3]
  const cmds = [0, 0, 0, 0, 0, 0, 0, 0]
  let last = 0
  for (const id of ids) {
    if (id >= 1 && id <= 8) {
      cmds[id - 1] = cmdValue
      if (id > last) last = id
    }
  }
  return proto.encodeStateControl(cmds.slice(0, Math.max(last, 1)))
}

/**
 * MotorProtocol Adapter for BM_HMD (CAN FD, no BRS).
 * encode* → CanFrame only (never SLCAN).
 *
 * @param {object} [profile] NeckRuntimeProfile or partial { transport, motorProtocol, brs, canFd }
 */
export function createBmHmdProtocolAdapter(profile = {}) {
  const flags = resolveBmHmdFrameFlags(profile)
  const proto = new BmHmdProtocol({
    fd: flags.isFd,
    brs: flags.brs,
    production: true,
  })

  const adapter = {
    type: BM_HMD_PROTOCOL_TYPE,
    version: BM_HMD_PROTOCOL_VERSION,
    capabilities: Object.freeze({
      modes: Object.freeze(["POSITION"]),
      maxMotorsPerFrame: 4,
      supportsFeedback: true,
      requiresCanFd: true,
      requiresBrs: false,
    }),

    encodePositionCommand(motorCommand) {
      const [m1, m2, m3, m4] = slotsFromMotorCommand(motorCommand)
      return proto.encodePositionCommandFrameFromRaw(m1, m2, m3, m4)
    },

    encodeEnableCommand(motorIds = [1, 2, 3]) {
      return stateControlForMotors(proto, motorIds, MotorCmd.ENABLE)
    },

    encodeDisableCommand(motorIds = [1, 2, 3]) {
      return stateControlForMotors(proto, motorIds, MotorCmd.DISABLE)
    },

    encodeControlModeCommand(motorId, mode = "POSITION") {
      if (mode !== "POSITION" && mode !== CONTROL_MODE_POSITION && mode !== 0x05) {
        throw new ProtocolError(
          `BM_HMD adapter only supports POSITION control mode (got ${mode})`,
          "UNSUPPORTED_MODE"
        )
      }
      return proto.encodeSetPositionMode(Number(motorId))
    },

    decodeFrame(frame) {
      const decoded = decodeFeedbackFrame(frame)
      const fb = decoded.feedback || {}
      return {
        kind: decoded.kind,
        feedback: createMotorFeedback({
          motorId: fb.motorId,
          position: fb.absolutePositionDeg ?? null,
          speed: fb.speedRpm ?? null,
          current: fb.iqA ?? null,
          voltage: fb.voltageV ?? null,
          fault: fb.faultCode ?? null,
          enabled: fb.enabled ?? null,
          mode: fb.controlMode ?? null,
          kind: decoded.kind,
          raw: fb,
        }),
      }
    },

    getUnderlyingProtocol() {
      return proto
    },
  }

  return assertMotorProtocolAdapter(adapter)
}
