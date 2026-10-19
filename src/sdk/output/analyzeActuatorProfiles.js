import { actuatorKeyToLegacyIndex } from "./actuatorKeys.js"
import { normalizeActuatorProfile } from "./actuatorProfileTypes.js"

export const ACTUATOR_BUS_ID_MISMATCH = "actuator-bus-id-mismatch"

/**
 * 从 actuatorKey 解析舵机编号（servo_N → N）。
 */
export function parseActuatorKeyNumber(actuatorKey) {
  return actuatorKeyToLegacyIndex(actuatorKey)
}

/**
 * actuatorKey 与 busServoId 是否一致（默认应 1:1）。
 */
export function isActuatorBusIdAligned(profile) {
  const n = parseActuatorKeyNumber(profile?.actuatorKey)
  if (!Number.isFinite(n)) {
    return true
  }
  return Number(profile?.busServoId) === n
}

/**
 * 诊断 actuator profiles：检测旧 +1 迁移残留。
 */
export function analyzeActuatorProfiles(profiles) {
  const list = Array.isArray(profiles)
    ? profiles.map((p) => normalizeActuatorProfile(p))
    : []

  const warnings = []
  const errors = []
  const mismatches = []

  for (const p of list) {
    const n = parseActuatorKeyNumber(p.actuatorKey)
    if (!Number.isFinite(n)) {
      continue
    }
    if (Number(p.busServoId) !== n) {
      const msg = `actuatorKey ${p.actuatorKey} 但 busServoId=${p.busServoId}（应为 ${n}）`
      warnings.push(msg)
      mismatches.push({
        actuatorKey: p.actuatorKey,
        expectedBusServoId: n,
        actualBusServoId: Number(p.busServoId),
        reason: ACTUATOR_BUS_ID_MISMATCH,
        message:
          "actuatorKey 与 busServoId 不一致。当前会导致选择舵机 " +
          `${n} 但实际驱动 ID ${p.busServoId}。`,
      })
    }
  }

  return {
    profileCount: list.length,
    mismatchCount: mismatches.length,
    mismatches,
    warnings,
    errors,
    aligned: mismatches.length === 0,
  }
}

/**
 * 将 servo_N 形 actuator profile 的 busServoId / id 与 N 对齐（保留零点等字段）。
 */
export function fixActuatorProfileBusIdAlignment(profiles) {
  return (profiles || []).map((raw) => {
    const p = normalizeActuatorProfile(raw)
    const n = parseActuatorKeyNumber(p.actuatorKey)
    if (!Number.isFinite(n)) {
      return p
    }
    return normalizeActuatorProfile({
      ...p,
      busServoId: n,
      legacyServoIndex: n,
      id: n,
    })
  })
}
