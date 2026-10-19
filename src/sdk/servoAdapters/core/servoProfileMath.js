/**
 * logicalValue (0~1000) → position。
 * standard_window：理论中间 180° 窗口。
 * installed_center：当前装配 position 为 logical 500，±90°。
 */

import { clampInt } from "./servoAdapter.js"
import {
  resolveModelFields,
  computeServoAngleFromLogical,
  validateServoProfile,
  enrichProfileWithSafety as enrichBaseSafety,
  getTheoreticalCenterFromProfile,
  MECHANICAL_MAX_TRAVEL_DEG,
} from "./servoMechanicalSafety.js"
import {
  CENTER_MODE,
  isInstalledCenterMode,
  computeInstalledRawTarget,
  computeInstalledCenterWindow,
  attachInstalledCenterFields,
  getEffectiveSafeWindow,
  INSTALLED_CENTER_BOUNDARY_WARNING,
} from "./servoCenterMode.js"

export const LOGICAL_MIN = 0
export const LOGICAL_MAX = 1000
export const LOGICAL_CENTER = 500
export const MECHANICAL_CENTER_DEG = 90
export const MECHANICAL_TRAVEL_DEG = 180

export { CENTER_MODE, INSTALLED_CENTER_BOUNDARY_WARNING } from "./servoCenterMode.js"
export {
  computeInstalledCenterWindow,
  isInstalledCenterMode,
  isInstalledCenterInModelRange,
  getEffectiveSafeWindow,
} from "./servoCenterMode.js"

export const RANGE_MODE = Object.freeze({
  MODE_4096: "4096",
  MODE_1000: "1000",
  MODE_CUSTOM: "custom",
  POSITION_4096: "4096",
  POSITION_1000: "1000",
})

/** 机构角度 0~180° */
export function logicalValueToAngleDeg(logicalValue) {
  const v = clampInt(Number(logicalValue) || 0, LOGICAL_MIN, LOGICAL_MAX)
  return (v / LOGICAL_MAX) * MECHANICAL_TRAVEL_DEG
}

function clampTargetForProfileInternal(rawTarget, profile) {
  const raw = Math.round(Number(rawTarget) || 0)
  const model = resolveModelFields(profile)
  const { safeMinValue, safeMaxValue } = getEffectiveSafeWindow(profile)

  let target = raw
  const warnings = []
  let clamped = false

  if (profile.safetyLimited !== false) {
    if (target < safeMinValue || target > safeMaxValue) {
      const before = target
      target = clampInt(target, safeMinValue, safeMaxValue)
      clamped = before !== target
      warnings.push(`安全窗口 clamp：${before} → ${target}（${safeMinValue}..${safeMaxValue}）`)
      if (isInstalledCenterMode(profile) && !profile.installedCenterFullRangeReachable) {
        warnings.push(INSTALLED_CENTER_BOUNDARY_WARNING)
      }
    }
  }

  if (target < model.positionMin || target > model.positionMax) {
    const before = target
    target = clampInt(target, model.positionMin, model.positionMax)
    clamped = clamped || before !== target
    warnings.push(`舵机量程 clamp：${before} → ${target}`)
  }

  return {
    target,
    rawTarget: raw,
    clamped,
    clampedTarget: target,
    warning: warnings.join("; "),
    warnings,
    safeMinValue,
    safeMaxValue,
    isClamped: clamped,
  }
}

export function clampTargetForProfile(rawTarget, profile) {
  return clampTargetForProfileInternal(rawTarget, enrichProfileWithSafety(profile))
}

function computeStandardWindowTarget(profile, logicalValue) {
  const p = enrichProfileWithSafety(profile)
  const logical = clampInt(Number(logicalValue) || 0, LOGICAL_MIN, LOGICAL_MAX)
  const ratio = logical / 1000
  const dir = p.direction === -1 ? -1 : 1
  const servoAngleDeg = computeServoAngleFromLogical(p, logical)
  const baseTarget = Math.round(servoAngleDeg / p.positionResolution)
  const centerOffsetTicks = Math.round(Number(p.centerOffsetTicks) || 0)
  const rawTarget = baseTarget + centerOffsetTicks
  const clamped = clampTargetForProfileInternal(rawTarget, p)
  const offsetWarnings = []
  if (clamped.clamped && centerOffsetTicks !== 0) {
    offsetWarnings.push(
      `零位偏移 ${centerOffsetTicks > 0 ? "+" : ""}${centerOffsetTicks} 导致 clamp`
    )
  }

  return {
    logicalValue: logical,
    ratio,
    angleDeg: logicalValueToAngleDeg(logical),
    servoAngleDeg,
    baseTarget,
    centerOffsetTicks,
    rawTarget,
    direction: dir,
    centerMode: CENTER_MODE.STANDARD_WINDOW,
    ...clamped,
    targetPosition: clamped.target,
    clampedTarget: clamped.target,
    warning: [clamped.warning, ...offsetWarnings].filter(Boolean).join("; ") || undefined,
  }
}

function computeInstalledCenterTarget(profile, logicalValue) {
  const p = enrichProfileWithSafety(profile)
  const logical = clampInt(Number(logicalValue) || 0, LOGICAL_MIN, LOGICAL_MAX)
  const dir = p.direction === -1 ? -1 : 1
  const angleDeg = logicalValueToAngleDeg(logical)
  const deltaDegFromCenter = angleDeg - 90
  const deltaTicks = Math.round(deltaDegFromCenter / p.positionResolution)
  const rawTargetPosition = computeInstalledRawTarget(p, logical)
  const clamped = clampTargetForProfileInternal(rawTargetPosition, p)

  return {
    logicalValue: logical,
    ratio: logical / 1000,
    angleDeg,
    deltaDegFromCenter,
    deltaTicks,
    servoAngleDeg: null,
    rawTarget: rawTargetPosition,
    rawTargetPosition,
    direction: dir,
    centerMode: CENTER_MODE.INSTALLED_CENTER,
    installedCenterPosition: p.installedCenterPosition,
    installedSafeMinValue: p.installedSafeMinValue,
    installedSafeMaxValue: p.installedSafeMaxValue,
    installedCenterFullRangeReachable: p.installedCenterFullRangeReachable,
    ...clamped,
    targetPosition: clamped.target,
    clampedTarget: clamped.target,
    isClamped: clamped.clamped,
    warning: clamped.warning || undefined,
  }
}

export function computeLogicalTargetRaw(profile, logicalValue) {
  if (isInstalledCenterMode(profile)) {
    return computeInstalledRawTarget(profile, logicalValue)
  }
  const model = resolveModelFields(profile)
  const servoAngleDeg = computeServoAngleFromLogical(profile, logicalValue)
  const base = Math.round(servoAngleDeg / model.positionResolution)
  const offset = Math.round(Number(profile.centerOffsetTicks) || 0)
  return base + offset
}

/**
 * 主映射：logicalValue → targetPosition。
 */
export function computeServoTargetFromLogical(profile, logicalValue) {
  const p = enrichProfileWithSafety(profile)
  if (isInstalledCenterMode(p)) {
    const result = computeInstalledCenterTarget(p, logicalValue)
    return {
      ...result,
      logicalPositionMin: p.installedSafeMinValue,
      logicalPositionCenter: p.installedCenterPosition,
      logicalPositionMax: p.installedSafeMaxValue,
      safeMinValue: p.installedSafeMinValue,
      safeMaxValue: p.installedSafeMaxValue,
      positionResolution: p.positionResolution,
    }
  }

  const result = computeStandardWindowTarget(p, logicalValue)
  return {
    ...result,
    logicalPositionMin: p.logicalPositionMin,
    logicalPositionCenter: p.logicalPositionCenter,
    logicalPositionMax: p.logicalPositionMax,
    logicalAngleMinDeg: p.logicalAngleMinDeg,
    logicalAngleCenterDeg: p.logicalAngleCenterDeg,
    logicalAngleMaxDeg: p.logicalAngleMaxDeg,
    safeMinValue: p.logicalPositionMin,
    safeMaxValue: p.logicalPositionMax,
    positionResolution: p.positionResolution,
  }
}

export function enrichProfileWithSafety(profile) {
  const base = enrichBaseSafety(profile)
  const wantInstalled = profile.centerMode === CENTER_MODE.INSTALLED_CENTER
  const installedFields = wantInstalled
    ? attachInstalledCenterFields({ ...base, ...profile, centerMode: CENTER_MODE.INSTALLED_CENTER })
    : {
        installedCenterValid: false,
        installedCenterFullRangeReachable: null,
        installedSafeMinValue: null,
        installedSafeMaxValue: null,
        installedReachableMinLogical: null,
        installedReachableMaxLogical: null,
      }

  /* 量程外/塌缩装配中位：回退 standard_window，避免 SC 被打到 1023 锁死 */
  const centerMode =
    wantInstalled && installedFields.installedCenterValid
      ? CENTER_MODE.INSTALLED_CENTER
      : CENTER_MODE.STANDARD_WINDOW

  const forWindow = {
    ...base,
    ...profile,
    ...installedFields,
    centerMode,
  }
  if (centerMode === CENTER_MODE.STANDARD_WINDOW) {
    forWindow.installedSafeMinValue = null
    forWindow.installedSafeMaxValue = null
  }

  const effective = getEffectiveSafeWindow(forWindow)

  return {
    ...base,
    ...profile,
    installedCenterPosition: Number.isFinite(Number(profile.installedCenterPosition))
      ? Math.round(Number(profile.installedCenterPosition))
      : null,
    installedCenterCapturedAt: profile.installedCenterCapturedAt || null,
    ...installedFields,
    centerMode,
    effectiveSafeMinValue: effective.safeMinValue,
    effectiveSafeMaxValue: effective.safeMaxValue,
    effectiveCenterPosition: effective.centerPosition,
  }
}

/** 偏移允许范围（standard_window + centerOffsetTicks） */
export function computeCenterOffsetLimits(profile) {
  const p = enrichProfileWithSafety(profile)
  const center = p.logicalPositionCenter
  const baseAt0 = computeLogicalTargetRaw({ ...p, centerMode: CENTER_MODE.STANDARD_WINDOW, centerOffsetTicks: 0 }, 0)
  const baseAt1000 = computeLogicalTargetRaw({ ...p, centerMode: CENTER_MODE.STANDARD_WINDOW, centerOffsetTicks: 0 }, 1000)
  return {
    minOffset: p.logicalPositionMin - baseAt0,
    maxOffset: p.logicalPositionMax - baseAt1000,
    actualCenter: center + Math.round(Number(p.centerOffsetTicks) || 0),
  }
}

export function defaultLimitsForRangeMode(rangeMode) {
  void rangeMode
  return { minValue: 0, maxValue: 4095, neutralValue: 2048 }
}

export function getTheoreticalCenter(profileOrMode) {
  if (typeof profileOrMode === "object" && profileOrMode != null) {
    if (isInstalledCenterMode(profileOrMode)) {
      return profileOrMode.installedCenterPosition
    }
    return getTheoreticalCenterFromProfile(profileOrMode)
  }
  const model = profileOrMode === "1000" ? "sc_300_1024" : "st32_360_4096"
  return getTheoreticalCenterFromProfile({ servoModel: model })
}

export function inferRangeModeFromPosition(position) {
  const p = Number(position)
  if (!Number.isFinite(p)) return RANGE_MODE.MODE_4096
  if (p <= 1200) return RANGE_MODE.MODE_1000
  return RANGE_MODE.MODE_4096
}

export function inferServoModelFromPosition(position, protocol) {
  if (protocol === "sms_sts") return "st32_360_4096"
  const p = Number(position)
  if (Number.isFinite(p) && p > 1023) return "st32_360_4096"
  return "sc_300_1024"
}

export function isProfileCalibrated(profile) {
  return profile?.calibrated === true || isInstalledCenterMode(profile)
}

export function hasConfiguredNeutral(profile) {
  return isProfileCalibrated(profile)
}

/** @deprecated */
export function computeServoTarget(profile, signedCommand) {
  const sc = Number(signedCommand)
  if (!Number.isFinite(sc)) {
    return computeServoTargetFromLogical(profile, LOGICAL_CENTER)
  }
  const logicalValue = clampInt(
    Math.round(LOGICAL_CENTER + sc * LOGICAL_CENTER),
    LOGICAL_MIN,
    LOGICAL_MAX
  )
  return { signedCommand: sc, ...computeServoTargetFromLogical(profile, logicalValue) }
}

export function computeDirectionTargets(profile) {
  const at0 = computeServoTargetFromLogical(profile, 0)
  const at500 = computeServoTargetFromLogical(profile, LOGICAL_CENTER)
  const at1000 = computeServoTargetFromLogical(profile, LOGICAL_MAX)
  const effective = getEffectiveSafeWindow(enrichProfileWithSafety(profile))
  return {
    logicalMin: 0,
    logicalCenter: LOGICAL_CENTER,
    logicalMax: LOGICAL_MAX,
    targetAt0: at0.targetPosition,
    targetAtCenter: at500.targetPosition,
    targetAt1000: at1000.targetPosition,
    servoAngleAt0: at0.servoAngleDeg,
    servoAngleAtCenter: at500.targetPosition,
    servoAngleAt1000: at1000.targetPosition,
    logicalWindowPos: `${effective.safeMinValue}~${effective.safeMaxValue}`,
    centerMode: profile.centerMode || CENTER_MODE.STANDARD_WINDOW,
    direction: profile.direction === -1 ? -1 : 1,
  }
}

export function prepareServoWrite(profile, input = {}) {
  const p = enrichProfileWithSafety(profile)
  const warnings = []
  let logicalValue = null
  let rawTarget = null
  let computed = null

  const validation = validateServoProfile(p)
  warnings.push(...validation.warnings)

  if (input.requireCalibrated && !isProfileCalibrated(p)) {
    return {
      ok: false,
      blocked: true,
      error: "请先完成中位标定",
      warnings,
    }
  }

  if (p.centerMode === CENTER_MODE.INSTALLED_CENTER && !p.installedCenterValid) {
    return {
      ok: false,
      blocked: true,
      error: "临时中位模式无效，请重新读取当前位置作为中位",
      warnings,
    }
  }

  if (!validation.ok && input.requireValidation !== false) {
    return {
      ok: false,
      blocked: true,
      error: validation.errors[0] || "Profile 校验失败",
      errors: validation.errors,
      warnings,
    }
  }

  if (typeof input.logicalValue === "number" && Number.isFinite(input.logicalValue)) {
    logicalValue = input.logicalValue
    computed = computeServoTargetFromLogical(p, logicalValue)
    rawTarget = computed.rawTarget
    if (computed.warning) warnings.push(computed.warning)
  } else if (typeof input.signedCommand === "number" && Number.isFinite(input.signedCommand)) {
    logicalValue = clampInt(
      Math.round(LOGICAL_CENTER + input.signedCommand * LOGICAL_CENTER),
      LOGICAL_MIN,
      LOGICAL_MAX
    )
    computed = computeServoTargetFromLogical(p, logicalValue)
    rawTarget = computed.rawTarget
    if (computed.warning) warnings.push(computed.warning)
  } else if (typeof input.targetPosition === "number" && Number.isFinite(input.targetPosition)) {
    rawTarget = Math.round(input.targetPosition)
    if (rawTarget === 0 && !input.bypassZeroWarning) {
      warnings.push("高风险：目标 position=0")
    }
    computed = clampTargetForProfile(rawTarget, p)
    if (computed.warning) warnings.push(computed.warning)
  } else {
    return { ok: false, blocked: true, error: "需要 logicalValue 或 targetPosition", warnings }
  }

  const target = computed.targetPosition ?? computed.target ?? computed.clampedTarget
  const clamped = computed.clamped === true

  return {
    ok: true,
    blocked: false,
    logicalValue,
    rawTarget,
    targetPosition: target,
    clampedTarget: target,
    clamped,
    warnings: [...new Set(warnings.filter(Boolean))],
    profile: p,
    validation,
    angleDeg: computed.angleDeg,
    servoAngleDeg: computed.servoAngleDeg,
    centerMode: computed.centerMode,
  }
}

export { MECHANICAL_MAX_TRAVEL_DEG }

export const computeServoTargetFromSigned = computeServoTarget
export const clampToMechanicalSafeWindow = clampTargetForProfile
