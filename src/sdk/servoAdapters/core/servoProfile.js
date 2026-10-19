/**
 * 通用 Servo Profile：PWM / SC / ST + 机械安全角度窗口。
 */

import { PROTOCOL, SERVO_UNIT, defaultUnitForProtocol } from "./servoTypes.js"
import {
  RANGE_MODE,
  inferRangeModeFromPosition,
  inferServoModelFromPosition,
  getTheoreticalCenter,
  computeLogicalTargetRaw,
} from "./servoProfileMath.js"
import {
  defaultServoModelForProtocol,
  resolveModelFields,
  validateServoProfile as validateServoProfileBase,
  checkReadPositionForModel,
  MECHANICAL_MAX_TRAVEL_DEG,
  SERVO_MODEL,
  isKnownServoModel,
} from "./servoMechanicalSafety.js"
import {
  CENTER_MODE,
  computeInstalledCenterWindow,
  INSTALLED_CENTER_BOUNDARY_WARNING,
} from "./servoCenterMode.js"
import {
  enrichProfileWithSafety,
} from "./servoProfileMath.js"

export { RANGE_MODE, getTheoreticalCenter } from "./servoProfileMath.js"
export { MECHANICAL_MAX_TRAVEL_DEG, SERVO_MODEL } from "./servoMechanicalSafety.js"
export {
  clampTargetForProfile,
  computeServoTarget,
  computeServoTargetFromLogical,
  computeServoTargetFromSigned,
  computeLogicalTargetRaw,
  LOGICAL_MIN,
  LOGICAL_MAX,
  LOGICAL_CENTER,
  clampToMechanicalSafeWindow,
  computeDirectionTargets,
  isProfileCalibrated,
  hasConfiguredNeutral,
  inferRangeModeFromPosition,
  prepareServoWrite,
  computeCenterOffsetLimits,
  CENTER_MODE,
  INSTALLED_CENTER_BOUNDARY_WARNING,
  isInstalledCenterMode,
  isInstalledCenterInModelRange,
  getEffectiveSafeWindow,
  computeInstalledCenterWindow,
} from "./servoProfileMath.js"

export function validateServoProfile(profile) {
  const p = enrichProfileWithSafety(profile)
  const result = validateServoProfileBase(p)

  if (p.centerMode === CENTER_MODE.INSTALLED_CENTER) {
    if (!p.installedCenterValid) {
      result.warnings.push("临时中位模式无效：installedCenterPosition 缺失，请重新读取当前位置作为中位")
    } else if (p.installedCenterFullRangeReachable === false) {
      result.warnings.push(INSTALLED_CENTER_BOUNDARY_WARNING)
    }
  }

  return result
}

export { enrichProfileWithSafety } from "./servoProfileMath.js"
export {
  computeMechanicalSafeWindow,
  suggestMechanicalFromNeutral,
  clampTargetWithSafety,
  checkReadPositionForModel,
  resolveModelFields,
  SERVO_MODEL_SPECS,
  defaultServoModelForProtocol,
  getServoModelSpec,
  getTheoreticalCenterFromProfile,
  degToTicks,
  ticksToDeg,
  isKnownServoModel,
} from "./servoMechanicalSafety.js"

export const SC_POSITION_MIN = 0
export const SC_POSITION_MAX = 1023
export const PWM_MIN = 500
export const PWM_MAX = 2500
export const PWM_NEUTRAL = 1500

function clampNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

export function defaultRangeForProtocol(protocol) {
  const model = resolveModelFields({ protocol, servoModel: defaultServoModelForProtocol(protocol) })
  return { min: model.positionMin, max: model.positionMax, neutral: model.positionCenter }
}

export function createDefaultLabServoProfile(opts = {}) {
  const protocol = opts.protocol || PROTOCOL.SCSCL
  const servoModel = opts.servoModel || defaultServoModelForProtocol(protocol)
  const model = resolveModelFields({ protocol, servoModel })
  const id = Number.isInteger(opts.id) ? opts.id : 1
  return normalizeLabServoProfile({
    id,
    label: opts.label || `舵机 ${id}`,
    protocol,
    servoUnit: defaultUnitForProtocol(protocol),
    servoModel,
    rangeMode:
      servoModel === SERVO_MODEL.SC_300_1024 ? RANGE_MODE.MODE_1000 : RANGE_MODE.MODE_4096,
    enabled: true,
    direction: 1,
    neutralValue: model.logicalPositionCenter,
    calibrated: false,
    positionMin: model.positionMin,
    positionMax: model.positionMax,
    positionCenter: model.positionCenter,
    angleRangeDeg: model.angleRangeDeg,
    mechanicalMaxTravelDeg: MECHANICAL_MAX_TRAVEL_DEG,
    safetyLimited: true,
    speed: 0,
    acc: 0,
    time: 0,
  })
}

export function normalizeLabServoProfile(raw = {}) {
  const protocol = [PROTOCOL.SCSCL, PROTOCOL.SMS_STS, PROTOCOL.RJ_SBUS].includes(raw.protocol)
    ? raw.protocol
    : PROTOCOL.SCSCL
  const servoUnit =
    raw.servoUnit && Object.values(SERVO_UNIT).includes(raw.servoUnit)
      ? raw.servoUnit
      : defaultUnitForProtocol(protocol)

  let servoModel = raw.servoModel
  if (!isKnownServoModel(servoModel)) {
    servoModel = defaultServoModelForProtocol(protocol)
  }

  if (servoModel !== SERVO_MODEL.CUSTOM && protocol === PROTOCOL.SMS_STS) {
    servoModel = SERVO_MODEL.ST32_360_4096
  }
  if (servoModel !== SERVO_MODEL.CUSTOM && protocol === PROTOCOL.RJ_SBUS) {
    servoModel = SERVO_MODEL.RJ_SBUS_ANGLE
  }
  if (servoModel !== SERVO_MODEL.CUSTOM && protocol === PROTOCOL.SCSCL && servoModel === SERVO_MODEL.ST32_360_4096) {
    if (!raw.servoModel) servoModel = SERVO_MODEL.SC_300_1024
  }

  const model = resolveModelFields({ ...raw, protocol, servoModel })

  let rangeMode = raw.rangeMode
  if (rangeMode === "position_4096") rangeMode = RANGE_MODE.MODE_4096
  if (rangeMode === "position_1000") rangeMode = RANGE_MODE.MODE_1000

  const id = Number.isInteger(raw.id) ? raw.id : Number.isInteger(raw.servoId) ? raw.servoId : 1

  const calibrated =
    raw.calibrated === true || (raw.neutralConfigured === true && raw.calibrated !== false)

  const base = {
    id,
    label: typeof raw.label === "string" ? raw.label : typeof raw.name === "string" ? raw.name : `舵机 ${id}`,
    protocol,
    servoUnit,
    servoModel,
    rangeMode:
      rangeMode ||
      (servoModel === SERVO_MODEL.SC_300_1024 ? RANGE_MODE.MODE_1000 : RANGE_MODE.MODE_4096),
    enabled: raw.enabled !== false,
    direction: raw.direction === -1 ? -1 : 1,
    neutralValue: model.logicalPositionCenter,
    calibrated: Boolean(calibrated),
    neutralConfigured: Boolean(calibrated),
    positionMin: model.positionMin,
    positionMax: model.positionMax,
    positionCenter: model.logicalPositionCenter,
    angleRangeDeg: model.angleRangeDeg,
    minValue: model.positionMin,
    maxValue: model.positionMax,
    positionResolution: model.positionResolution,
    totalTravelDeg: model.totalTravelDeg,
    mechanicalMaxTravelDeg: clampNumber(raw.mechanicalMaxTravelDeg, MECHANICAL_MAX_TRAVEL_DEG),
    safetyLimited: raw.safetyLimited !== false,
    speed: clampNumber(raw.speed, 0),
    acc: clampNumber(raw.acc, 0),
    time: clampNumber(raw.time, 0),
    centerOffsetTicks: Math.round(Number(raw.centerOffsetTicks) || 0),
    centerMode:
      raw.centerMode === CENTER_MODE.INSTALLED_CENTER
        ? CENTER_MODE.INSTALLED_CENTER
        : CENTER_MODE.STANDARD_WINDOW,
    installedCenterPosition: Number.isFinite(Number(raw.installedCenterPosition))
      ? Math.round(Number(raw.installedCenterPosition))
      : null,
    installedCenterCapturedAt:
      typeof raw.installedCenterCapturedAt === "string" ? raw.installedCenterCapturedAt : null,
  }

  if (servoModel === SERVO_MODEL.CUSTOM) {
    base.tickCount = clampNumber(raw.tickCount, model.tickCount)
  }

  return enrichProfileWithSafety(base)
}

export function createDefaultServoEntry(opts = {}) {
  return normalizeLabServoProfile(createDefaultLabServoProfile(opts))
}

export function normalizeServoEntry(raw = {}) {
  // 历史 PWM 文本协议条目：迁移为 SC 总线 profile（逻辑空间字段仍可保留在别处）
  if (raw.protocol === "pwm" || raw.servoUnit === SERVO_UNIT.PWM_US) {
    return normalizeLabServoProfile({
      ...raw,
      protocol: PROTOCOL.SCSCL,
      servoUnit: SERVO_UNIT.SC_POSITION,
      servoModel: SERVO_MODEL.SC_300_1024,
    })
  }
  return normalizeLabServoProfile(raw)
}

export function resolveNeutralValue(entry) {
  const e = normalizeLabServoProfile(entry)
  if (!e.calibrated) return null
  return e.neutralValue
}

export function buildServoEntryExport(entry) {
  return normalizeLabServoProfile(entry)
}

export function applyInstalledCenterFromPosition(profile, rawPosition) {
  const norm =
    typeof rawPosition === "object" && rawPosition?.value != null ? rawPosition.value : rawPosition
  const pos = Math.round(Number(norm))
  if (!Number.isFinite(pos) || pos < 0) {
    throw new Error("无效 position 读数")
  }

  const check = checkReadPositionForModel(profile, pos)
  if (!check.ok) {
    throw new Error(check.errors[0] || "读数非法")
  }

  const model = resolveModelFields(profile)
  if (pos < model.positionMin || pos > model.positionMax) {
    throw new Error(`position ${pos} 超出舵机量程 ${model.positionMin}~${model.positionMax}`)
  }

  const win = computeInstalledCenterWindow(profile, pos)

  return normalizeLabServoProfile({
    ...profile,
    centerMode: CENTER_MODE.INSTALLED_CENTER,
    installedCenterPosition: pos,
    installedCenterCapturedAt: new Date().toISOString(),
    installedCenterValid: true,
    installedCenterFullRangeReachable: win.installedCenterFullRangeReachable,
    installedSafeMinValue: win.installedSafeMinValue,
    installedSafeMaxValue: win.installedSafeMaxValue,
    installedReachableMinLogical: win.installedReachableMinLogical,
    installedReachableMaxLogical: win.installedReachableMaxLogical,
    centerOffsetTicks: 0,
    calibrated: true,
  })
}

export function resetToStandardWindow(profile) {
  return normalizeLabServoProfile({
    ...profile,
    centerMode: CENTER_MODE.STANDARD_WINDOW,
    installedCenterPosition: null,
    installedCenterCapturedAt: null,
    installedCenterValid: false,
    installedCenterFullRangeReachable: null,
    installedSafeMinValue: null,
    installedSafeMaxValue: null,
    installedReachableMinLogical: null,
    installedReachableMaxLogical: null,
    centerOffsetTicks: 0,
  })
}

export function applyJogPositionAsCenterOffset(profile, jogPosition) {
  const pos = Math.round(Number(jogPosition))
  if (!Number.isFinite(pos) || pos < 0) {
    throw new Error("无效 position")
  }

  const check = checkReadPositionForModel(profile, pos)
  if (!check.ok) {
    throw new Error(check.errors[0] || "position 非法")
  }

  const model = resolveModelFields(profile)
  if (pos < model.logicalPositionMin || pos > model.logicalPositionMax) {
    throw new Error(
      `position ${pos} 超出安全窗口 ${model.logicalPositionMin}~${model.logicalPositionMax}`
    )
  }

  const centerOffsetTicks = pos - model.logicalPositionCenter
  const baseAt0 = computeLogicalTargetRaw(profile, 0)
  const baseAt1000 = computeLogicalTargetRaw(profile, 1000)
  if (baseAt0 + centerOffsetTicks < model.logicalPositionMin) {
    throw new Error("偏移过大：logical 0 将超出安全窗口")
  }
  if (baseAt1000 + centerOffsetTicks > model.logicalPositionMax) {
    throw new Error("偏移过大：logical 1000 将超出安全窗口")
  }

  return normalizeLabServoProfile({
    ...profile,
    centerOffsetTicks,
    calibrated: true,
  })
}

/** @deprecated 使用 applyJogPositionAsCenterOffset */
export function applyCurrentPositionAsNeutral(profile, rawPosition) {
  const norm = typeof rawPosition === "object" && rawPosition?.value != null ? rawPosition.value : rawPosition
  return applyJogPositionAsCenterOffset(profile, norm)
}

export function clearProfileNeutral(profile) {
  return resetToStandardWindow({
    ...profile,
    calibrated: false,
    neutralConfigured: false,
  })
}
