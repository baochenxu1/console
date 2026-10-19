import { clampInt, isValidServoId } from "../core/servoAdapter.js"
import { normalizeLabServoProfile } from "../core/servoProfile.js"
import { resolveModelFields } from "../core/servoMechanicalSafety.js"
import { PROTOCOL } from "../core/servoTypes.js"
import { encodeScPositionData, encodeStPositionData } from "../scservo/scServoCodec.js"
import { resolveBusSyncWriteMotion } from "./busSyncWriteMotion.js"

function coerceBusServoId(id) {
  const n = Math.round(Number(id))
  return Number.isFinite(n) ? n : NaN
}

export function resolveBusCommandProtocol(cmd) {
  const profile = cmd?.profile
  const p = profile?.protocol
  if (p === PROTOCOL.SMS_STS || p === "sms_sts") {
    return PROTOCOL.SMS_STS
  }
  if (
    p === PROTOCOL.RJ_SBUS ||
    p === "rj_sbus" ||
    p === "RJ" ||
    p === "RJ_SBUS"
  ) {
    return PROTOCOL.RJ_SBUS
  }
  if (p === PROTOCOL.SCSCL || p === "scscl") {
    return PROTOCOL.SCSCL
  }
  if (cmd?.protocol === PROTOCOL.SMS_STS || cmd?.protocol === "sms_sts") {
    return PROTOCOL.SMS_STS
  }
  if (
    cmd?.protocol === PROTOCOL.RJ_SBUS ||
    cmd?.protocol === "rj_sbus" ||
    cmd?.protocol === "RJ" ||
    cmd?.protocol === "RJ_SBUS"
  ) {
    return PROTOCOL.RJ_SBUS
  }
  return PROTOCOL.SCSCL
}

/**
 * 与 single-write（writeLogicalValueWithProfile → writePosition）使用相同的
 * profile 归一化 + time/speed/acc + targetPosition 编码，仅打包方式改为 SyncWrite item。
 * @param {object} cmd guard 后 bus command（targetPosition 为最终发送目标）
 */
export function buildBusSyncWriteItemFromCommand(cmd) {
  if (!cmd?.profile) {
    return { ok: false, reason: "missing-profile", actuatorKey: cmd?.actuatorKey ?? null }
  }

  const id = coerceBusServoId(cmd.busServoId)
  if (!isValidServoId(id)) {
    return { ok: false, reason: "invalid-bus-id", busServoId: cmd.busServoId }
  }

  const position = Number(cmd.targetPosition)
  if (!Number.isFinite(position)) {
    return { ok: false, reason: "invalid-target-position", busServoId: id }
  }

  const profile = normalizeLabServoProfile({
    ...cmd.profile,
    id,
    busServoId: id,
  })
  const protocol = resolveBusCommandProtocol({ ...cmd, profile })
  if (protocol === PROTOCOL.RJ_SBUS) {
    return {
      ok: false,
      reason: "rj-sbus-no-sync-write",
      protocol,
      actuatorKey: cmd.actuatorKey ?? null,
      busServoId: id,
    }
  }
  const motionResolved = resolveBusSyncWriteMotion(profile, protocol, cmd)
  const model = resolveModelFields(profile)
  const pos = clampInt(position, model.positionMin, model.positionMax)

  if (protocol === PROTOCOL.SMS_STS) {
    return {
      ok: true,
      protocol,
      id,
      actuatorKey: cmd.actuatorKey ?? null,
      position: pos,
      data: encodeStPositionData({
        position: pos,
        speed: motionResolved.speed,
        acc: motionResolved.acc,
      }),
      motion: motionResolved,
    }
  }

  return {
    ok: true,
    protocol,
    id,
    actuatorKey: cmd.actuatorKey ?? null,
    position: pos,
    data: encodeScPositionData({
      position: pos,
      time: motionResolved.time,
      speed: motionResolved.speed,
    }),
    motion: motionResolved,
  }
}
