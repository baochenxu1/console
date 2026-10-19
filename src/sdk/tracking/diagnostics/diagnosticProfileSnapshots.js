import { normalizeFaceRigProfile } from "../../../core/faceRigProfile.js"

/**
 * Diagnostic 导出：binding profile 文件头快照（每文件一份，不每帧重复）。
 */
export function buildBindingProfileSnapshot(profile) {
  const p = normalizeFaceRigProfile(profile || {})
  return {
    version: p.version ?? p.busSemanticsVersion ?? null,
    busSemanticsMigratedAt: p.busSemanticsMigratedAt ?? null,
    bindings: (p.bindings || []).map((b) => ({
      bindingId: b.bindingId,
      controlId: b.controlId,
      channel: b.channel,
      actuatorKey: b.actuatorKey ?? null,
      legacyServoIndex: b.legacyServoIndex ?? b.servoId ?? null,
      neutralPwm: b.neutralPwm,
      positiveTargetPwm: b.positiveTargetPwm,
      negativeTargetPwm: b.negativeTargetPwm,
      direction: b.direction ?? null,
      weight: b.weight ?? null,
      curve: b.curve ?? null,
      enabled: b.enabled !== false,
      migratedFromNeutralPwm: b.migratedFromNeutralPwm ?? null,
    })),
  }
}

/**
 * Diagnostic 导出：actuator profile 文件头快照。
 */
export function buildActuatorProfileSnapshot(actuatorProfiles) {
  return (actuatorProfiles || []).map((ap) => ({
    actuatorKey: ap.actuatorKey ?? ap.id ?? null,
    outputType: ap.outputType ?? null,
    protocol: ap.protocol ?? null,
    busServoId: ap.busServoId ?? null,
    servoModel: ap.servoModel ?? null,
    centerMode: ap.centerMode ?? null,
    installedCenterPosition: ap.installedCenterPosition ?? null,
    installedCenterValid: Boolean(ap.installedCenterValid ?? ap.installedCenterPosition != null),
    direction: ap.direction ?? null,
    safeMinValue: ap.safeMinValue ?? ap.minValue ?? null,
    safeMaxValue: ap.safeMaxValue ?? ap.maxValue ?? null,
    enabled: ap.enabled !== false,
  }))
}
