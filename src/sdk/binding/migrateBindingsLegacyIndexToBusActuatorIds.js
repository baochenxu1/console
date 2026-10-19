import { CHANNEL_VALUE, normalizeBinding } from "../../core/faceRigProfile.js"
import { FACE_BUS_SERVO_ROUTE } from "../servoAdapters/busServo/faceBusServoRoute.js"
import { bindingTargetPatch } from "./bindingActuatorFields.js"

export const BINDING_BUS_ACTUATOR_VERSION = "1"

/**
 * 旧 PWM legacy 索引 → 物理 bus / actuator 编号（routeMap 仅用于一次性迁移）。
 */
export function legacyRouteIndexToBusActuatorId(legacyRouteIndex) {
  const L = Number(legacyRouteIndex)
  if (!Number.isFinite(L)) {
    return 0
  }
  const route = FACE_BUS_SERVO_ROUTE[L]
  if (route?.busServoId != null) {
    return Number(route.busServoId)
  }
  return L
}

/** 是否仍为旧版 0 基 legacy 索引（典型：左眉尖 DOF A 绑定 servo_0 / servoId 0） */
export function profileUsesLegacyRouteServoIndexing(bindings) {
  const tip =
    bindings.find((b) => b.controlId === "brow_l_tip_a" && b.channel === CHANNEL_VALUE) ||
    bindings.find((b) => b.controlId === "brow_l_tip" && b.channel === CHANNEL_VALUE)
  if (!tip) {
    return false
  }
  return Number(tip.servoId) === 0 || tip.actuatorKey === "servo_0"
}

/**
 * 将仍使用 route legacy 索引的 binding 迁移为 bus actuator 编号（servo_N = bus N）。
 */
export function migrateBindingsLegacyIndexToBusActuatorIds(bindings) {
  return (bindings || []).map((b) => {
    const oldId = Number(b.servoId)
    const route = FACE_BUS_SERVO_ROUTE[oldId]
    if (!route || route.busServoId == null || Number(route.busServoId) === oldId) {
      return normalizeBinding(b)
    }
    const newId = Number(route.busServoId)
    return normalizeBinding({
      ...b,
      ...bindingTargetPatch(newId),
      migratedFromLegacyServoIndex: oldId,
    })
  })
}
