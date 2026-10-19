/**
 * centerMode：standard_window（理论中间 180°）| installed_center（当前装配位置为 logical 500）。
 */

import { clampInt } from "./servoAdapter.js"
import { resolveModelFields } from "./servoMechanicalSafety.js"
const LOGICAL_MIN = 0
const LOGICAL_MAX = 1000
const LOGICAL_CENTER = 500
const MECHANICAL_TRAVEL_DEG = 180

export const CENTER_MODE = Object.freeze({
  STANDARD_WINDOW: "standard_window",
  INSTALLED_CENTER: "installed_center",
})

export const INSTALLED_CENTER_BOUNDARY_WARNING =
  "当前中位靠近舵机边界，无法完整覆盖 logical 0~1000。系统将自动限制可达范围，建议重新装配或减少运动幅度。"

export function isInstalledCenterMode(profile) {
  if (profile?.centerMode !== CENTER_MODE.INSTALLED_CENTER) {
    return false
  }
  if (!Number.isFinite(Number(profile?.installedCenterPosition))) {
    return false
  }
  /* 装配中位必须落在本型号量程内，否则 SC 上残留 ST 中位(~2000)会把目标夹到 1023 并锁死 */
  return isInstalledCenterInModelRange(profile)
}

/**
 * 装配中位是否在舵机型号 positionMin~positionMax 内。
 * @param {object} profile
 */
export function isInstalledCenterInModelRange(profile) {
  const ic = Number(profile?.installedCenterPosition)
  if (!Number.isFinite(ic)) return false
  const model = resolveModelFields(profile)
  return ic >= model.positionMin && ic <= model.positionMax
}

export function computeInstalledDeltaTicks(logicalValue, positionResolution) {
  const logical = clampInt(Number(logicalValue) || 0, LOGICAL_MIN, LOGICAL_MAX)
  const angleDeg = (logical / LOGICAL_MAX) * MECHANICAL_TRAVEL_DEG
  const deltaDegFromCenter = angleDeg - 90
  return Math.round(deltaDegFromCenter / positionResolution)
}

export function computeInstalledRawTarget(profile, logicalValue) {
  const model = resolveModelFields(profile)
  const center = Math.round(Number(profile.installedCenterPosition))
  const dir = profile.direction === -1 ? -1 : 1
  const deltaTicks = computeInstalledDeltaTicks(logicalValue, model.positionResolution)
  return Math.round(center + dir * deltaTicks)
}

function computeReachableLogicalRange(profile, installedCenterPosition, safeMin, safeMax) {
  const dir = profile.direction === -1 ? -1 : 1
  const res = resolveModelFields(profile).positionResolution
  const center = Math.round(Number(installedCenterPosition))
  let minL = LOGICAL_MAX
  let maxL = LOGICAL_MIN
  let found = false

  for (let L = LOGICAL_MIN; L <= LOGICAL_MAX; L += 1) {
    const deltaTicks = computeInstalledDeltaTicks(L, res)
    const raw = Math.round(center + dir * deltaTicks)
    if (raw >= safeMin && raw <= safeMax) {
      found = true
      minL = Math.min(minL, L)
      maxL = Math.max(maxL, L)
    }
  }

  if (!found) {
    return {
      installedReachableMinLogical: LOGICAL_CENTER,
      installedReachableMaxLogical: LOGICAL_CENTER,
    }
  }

  return {
    installedReachableMinLogical: minL,
    installedReachableMaxLogical: maxL,
  }
}

/**
 * 围绕 installedCenterPosition 计算 ±90° 安全窗口。
 */
export function computeInstalledCenterWindow(profile, installedCenterPosition) {
  const model = resolveModelFields(profile)
  const center = Math.round(Number(installedCenterPosition))
  const res = model.positionResolution
  const ticks90 = Math.round(90 / res)
  const rawMin = center - ticks90
  const rawMax = center + ticks90
  const posMin = model.positionMin
  const posMax = model.positionMax

  const installedSafeMinValue = clampInt(Math.min(rawMin, rawMax), posMin, posMax)
  const installedSafeMaxValue = clampInt(Math.max(rawMin, rawMax), posMin, posMax)
  const installedCenterFullRangeReachable = rawMin >= posMin && rawMax <= posMax

  const reachable = computeReachableLogicalRange(
    profile,
    center,
    installedSafeMinValue,
    installedSafeMaxValue
  )

  const warnings = []
  if (!installedCenterFullRangeReachable) {
    warnings.push(INSTALLED_CENTER_BOUNDARY_WARNING)
  }

  return {
    installedCenterPosition: center,
    installedSafeMinValue,
    installedSafeMaxValue,
    installedCenterFullRangeReachable,
    installedRawMin: rawMin,
    installedRawMax: rawMax,
    ticks90,
    warnings,
    ...reachable,
  }
}

export function attachInstalledCenterFields(profile) {
  const hasCenter =
    profile?.centerMode === CENTER_MODE.INSTALLED_CENTER &&
    Number.isFinite(Number(profile?.installedCenterPosition))

  if (!hasCenter) {
    return {
      installedCenterValid: false,
      installedCenterFullRangeReachable: null,
      installedSafeMinValue: null,
      installedSafeMaxValue: null,
      installedReachableMinLogical: null,
      installedReachableMaxLogical: null,
    }
  }

  if (!isInstalledCenterInModelRange(profile)) {
    const model = resolveModelFields(profile)
    const ic = Math.round(Number(profile.installedCenterPosition))
    return {
      installedCenterValid: false,
      installedCenterOutOfRange: true,
      installedCenterFullRangeReachable: false,
      installedSafeMinValue: null,
      installedSafeMaxValue: null,
      installedReachableMinLogical: null,
      installedReachableMaxLogical: null,
      installedCenterRangeWarning:
        `装配中位 ${ic} 超出型号量程 ${model.positionMin}~${model.positionMax}（常见于 SC/ST 串号）。已回退理论中位，请删除错误协议 profile 并重新标定。`,
    }
  }

  const win = computeInstalledCenterWindow(profile, profile.installedCenterPosition)
  /* 安全窗塌成单点（几乎总是量程外中位被 clamp 的结果）→ 视为无效，避免预览一发就锁死在边界 */
  if (win.installedSafeMinValue === win.installedSafeMaxValue) {
    return {
      installedCenterValid: false,
      installedCenterCollapsedWindow: true,
      installedCenterFullRangeReachable: false,
      installedSafeMinValue: null,
      installedSafeMaxValue: null,
      installedReachableMinLogical: null,
      installedReachableMaxLogical: null,
      installedCenterRangeWarning:
        `装配中位安全窗已塌缩为 ${win.installedSafeMinValue}，无法驱动。已回退理论中位，请重新标定。`,
    }
  }

  return {
    installedCenterValid: true,
    installedCenterPosition: win.installedCenterPosition,
    installedCenterFullRangeReachable: win.installedCenterFullRangeReachable,
    installedSafeMinValue: win.installedSafeMinValue,
    installedSafeMaxValue: win.installedSafeMaxValue,
    installedReachableMinLogical: win.installedReachableMinLogical,
    installedReachableMaxLogical: win.installedReachableMaxLogical,
  }
}

export function getEffectiveSafeWindow(profile) {
  if (isInstalledCenterMode(profile)) {
    return {
      safeMinValue: profile.installedSafeMinValue,
      safeMaxValue: profile.installedSafeMaxValue,
      centerMode: CENTER_MODE.INSTALLED_CENTER,
      centerPosition: profile.installedCenterPosition,
    }
  }
  const model = resolveModelFields(profile)
  return {
    safeMinValue: model.logicalPositionMin,
    safeMaxValue: model.logicalPositionMax,
    centerMode: CENTER_MODE.STANDARD_WINDOW,
    centerPosition: model.logicalPositionCenter,
  }
}
