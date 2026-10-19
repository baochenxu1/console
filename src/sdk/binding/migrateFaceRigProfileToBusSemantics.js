import {
  normalizeBinding,
  normalizeBindingNeutralForBus,
  normalizeFaceRigProfile,
} from "../../core/faceRigProfile.js"

/**
 * 迁移当前绑定为 Bus Servo 语义：
 * - 补 actuatorKey
 * - neutralPwm → 1500（保留相对行程）
 * - 默认禁用 tongue / servo_11
 */
export function migrateFaceRigProfileToBusSemantics(profile, {
  disableTongue = true,
} = {}) {
  const base = normalizeFaceRigProfile(profile)

  const bindings = base.bindings.map((b) => {
    let next = normalizeBinding(b)

    if (next.enabled !== false) {
      next = normalizeBindingNeutralForBus(next)
    }

    if (
      disableTongue &&
      (next.controlId === "tongue" || Number(next.servoId) === 11)
    ) {
      next = {
        ...next,
        enabled: false,
        disabledReason: "tongue-not-configured",
      }
    }

    return next
  })

  return normalizeFaceRigProfile({
    ...base,
    bindings,
    busSemanticsMigratedAt: new Date().toISOString(),
    busSemanticsVersion: "1",
  })
}
