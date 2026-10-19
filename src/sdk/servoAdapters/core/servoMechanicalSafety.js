/**
 * 机械安全：FaceDEV logical 0~1000 映射到舵机量程中间 180° 窗口。
 */

import { clampInt } from "./servoAdapter.js"
import { PROTOCOL } from "./servoTypes.js"

export const MECHANICAL_MAX_TRAVEL_DEG = 180

export const SERVO_MODEL = Object.freeze({
  SC_300_1024: "sc_300_1024",
  ST32_360_4096: "st32_360_4096",
  /** 锐捷 RJ_SBUS：有符号 0.1° ticks；模型窗中位 0 ↔ 机构中位 90° */
  RJ_SBUS_ANGLE: "rj_sbus_angle",
  CUSTOM: "custom",
})

const SC_RES = 300 / 1024
const ST_RES = 360 / 4096

const SC_SPEC = {
  label: "SC 300° / 0–1023",
  positionMin: 0,
  positionMax: 1023,
  positionCenter: 512,
  angleRangeDeg: 300,
  totalTravelDeg: 300,
  tickCount: 1024,
  positionResolution: SC_RES,
  protocol: PROTOCOL.SCSCL,
  logicalAngleMinDeg: 60,
  logicalAngleCenterDeg: 150,
  logicalAngleMaxDeg: 240,
  logicalPositionMin: 205,
  logicalPositionCenter: 512,
  logicalPositionMax: 819,
}

const ST_SPEC = {
  label: "ST32 360° / 0–4095",
  positionMin: 0,
  positionMax: 4095,
  positionCenter: 2048,
  angleRangeDeg: 360,
  totalTravelDeg: 360,
  tickCount: 4096,
  positionResolution: ST_RES,
  protocol: PROTOCOL.SMS_STS,
  logicalAngleMinDeg: 90,
  logicalAngleCenterDeg: 180,
  logicalAngleMaxDeg: 270,
  logicalPositionMin: 1024,
  logicalPositionCenter: 2048,
  logicalPositionMax: 3072,
}

const CUSTOM_DEFAULT = {
  label: "Custom（自定义量程）",
  positionMin: 0,
  positionMax: 4095,
  positionCenter: 2048,
  angleRangeDeg: 360,
  totalTravelDeg: 360,
  tickCount: 4096,
  positionResolution: ST_RES,
  protocol: null,
}

/**
 * RJ_SBUS：position = 有符号角度 ticks（0.1°），MID_OFFSET=0 时中位为 0。
 * 实机限位通常为 -1500～1500（±150°）。
 *
 * 模型层铁律不变：logical 0～1000 ↔ 机构总行程 180°，中位 ±90°。
 * 仅做固定映射到协议窗：
 *   logical 0/500/1000 → 协议 ticks -900 / 0 / +900（协议角 -90° / 0° / +90°）
 * 机构角展示仍为 0°～180°（由 logical 直接换算），不要求协议角等于装配绝对角。
 */
const RJ_SPEC = {
  label: "RJ ±150° / 中位 0",
  positionMin: -1500,
  positionMax: 1500,
  positionCenter: 0,
  angleRangeDeg: 300,
  totalTravelDeg: 180,
  tickCount: 3001,
  positionResolution: 0.1,
  protocol: PROTOCOL.RJ_SBUS,
  /** 协议角（写入 ticks = deg / 0.1） */
  logicalAngleMinDeg: -90,
  logicalAngleCenterDeg: 0,
  logicalAngleMaxDeg: 90,
  logicalPositionMin: -900,
  logicalPositionCenter: 0,
  logicalPositionMax: 900,
}

/** @type {Record<string, typeof SC_SPEC>} */
export const SERVO_MODEL_SPECS = Object.freeze({
  [SERVO_MODEL.SC_300_1024]: SC_SPEC,
  [SERVO_MODEL.ST32_360_4096]: ST_SPEC,
  [SERVO_MODEL.RJ_SBUS_ANGLE]: RJ_SPEC,
  [SERVO_MODEL.CUSTOM]: CUSTOM_DEFAULT,
})

export function isKnownServoModel(servoModel) {
  return Object.values(SERVO_MODEL).includes(servoModel)
}

export function defaultServoModelForProtocol(protocol) {
  if (protocol === PROTOCOL.SMS_STS) return SERVO_MODEL.ST32_360_4096
  if (protocol === PROTOCOL.RJ_SBUS) return SERVO_MODEL.RJ_SBUS_ANGLE
  return SERVO_MODEL.SC_300_1024
}

function finiteOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 由角度窗口计算 logical position 端点（custom 模型用） */
export function attachLogicalWindow(fields) {
  const res = fields.positionResolution
  const travel = fields.angleRangeDeg
  const minDeg = finiteOr(fields.logicalAngleMinDeg, (travel - MECHANICAL_MAX_TRAVEL_DEG) / 2)
  const maxDeg = finiteOr(fields.logicalAngleMaxDeg, minDeg + MECHANICAL_MAX_TRAVEL_DEG)
  const centerDeg = finiteOr(fields.logicalAngleCenterDeg, (minDeg + maxDeg) / 2)
  return {
    ...fields,
    logicalAngleMinDeg: minDeg,
    logicalAngleCenterDeg: centerDeg,
    logicalAngleMaxDeg: maxDeg,
    logicalPositionMin: Math.round(minDeg / res),
    logicalPositionCenter: Math.round(centerDeg / res),
    logicalPositionMax: Math.round(maxDeg / res),
  }
}

export function resolveModelFields(profile = {}) {
  const model = profile.servoModel || defaultServoModelForProtocol(profile.protocol)

  if (model === SERVO_MODEL.CUSTOM) {
    const positionMin = finiteOr(profile.positionMin ?? profile.minValue, CUSTOM_DEFAULT.positionMin)
    const positionMax = finiteOr(profile.positionMax ?? profile.maxValue, CUSTOM_DEFAULT.positionMax)
    const angleRangeDeg = finiteOr(profile.angleRangeDeg ?? profile.totalTravelDeg, CUSTOM_DEFAULT.angleRangeDeg)
    const tickCount = finiteOr(profile.tickCount, Math.max(1, positionMax - positionMin + 1))
    const positionResolution = finiteOr(profile.positionResolution, angleRangeDeg / tickCount)
    const positionCenter = finiteOr(profile.positionCenter, Math.round((positionMin + positionMax) / 2))
    return attachLogicalWindow({
      servoModel: SERVO_MODEL.CUSTOM,
      label: CUSTOM_DEFAULT.label,
      positionMin,
      positionMax,
      positionCenter,
      angleRangeDeg,
      totalTravelDeg: angleRangeDeg,
      tickCount,
      positionResolution,
      protocol: profile.protocol || PROTOCOL.SCSCL,
      logicalAngleMinDeg: profile.logicalAngleMinDeg,
      logicalAngleCenterDeg: profile.logicalAngleCenterDeg,
      logicalAngleMaxDeg: profile.logicalAngleMaxDeg,
    })
  }

  const spec = SERVO_MODEL_SPECS[model] || SC_SPEC
  let positionMin = finiteOr(profile.positionMin ?? profile.minValue, spec.positionMin)
  let positionMax = finiteOr(profile.positionMax ?? profile.maxValue, spec.positionMax)

  if (model === SERVO_MODEL.SC_300_1024) {
    positionMin = 0
    positionMax = 1023
  }
  if (model === SERVO_MODEL.ST32_360_4096) {
    positionMin = 0
    positionMax = 4095
  }
  if (model === SERVO_MODEL.RJ_SBUS_ANGLE) {
    positionMin = -1500
    positionMax = 1500
  }

  return attachLogicalWindow({
    ...spec,
    servoModel: model,
    positionMin,
    positionMax,
    positionCenter:
      model === SERVO_MODEL.RJ_SBUS_ANGLE ? spec.positionCenter : spec.logicalPositionCenter,
  })
}

export function getServoModelSpec(servoModel, profile) {
  if (profile && (profile.servoModel === SERVO_MODEL.CUSTOM || servoModel === SERVO_MODEL.CUSTOM)) {
    return resolveModelFields({ ...profile, servoModel: SERVO_MODEL.CUSTOM })
  }
  if (servoModel === SERVO_MODEL.CUSTOM) return attachLogicalWindow({ ...CUSTOM_DEFAULT })
  return SERVO_MODEL_SPECS[servoModel] || ST_SPEC
}

export function getTheoreticalCenterFromProfile(profile) {
  return resolveModelFields(profile).logicalPositionCenter
}

export function degToTicks(deg, positionResolution) {
  if (!Number.isFinite(deg) || !Number.isFinite(positionResolution) || positionResolution <= 0) return 0
  return Math.round(deg / positionResolution)
}

export function ticksToDeg(ticks, positionResolution) {
  if (!Number.isFinite(ticks) || !Number.isFinite(positionResolution)) return 0
  return ticks * positionResolution
}

/**
 * logical → 舵机角度。
 * 以型号 min/center/max 做分段线性：logical 500 永远对应中位角。
 * 对称窗（SC/ST/RJ 中位 ±90°）下与「min + ratio×180」等价。
 */
export function computeServoAngleFromLogical(profile, logicalValue) {
  const model = resolveModelFields(profile)
  const logical = clampInt(Number(logicalValue) || 0, 0, 1000)
  const dir = profile.direction === -1 ? -1 : 1
  const minDeg = model.logicalAngleMinDeg
  const centerDeg = model.logicalAngleCenterDeg
  const maxDeg = model.logicalAngleMaxDeg

  let angleDeg
  if (logical <= 500) {
    const t = logical / 500
    angleDeg = minDeg + t * (centerDeg - minDeg)
  } else {
    const t = (logical - 500) / 500
    angleDeg = centerDeg + t * (maxDeg - centerDeg)
  }

  if (dir === 1) return angleDeg
  // 反向：绕中位镜像
  return centerDeg - (angleDeg - centerDeg)
}

export function computeMechanicalSafeWindow(profile) {
  const model = resolveModelFields(profile)
  const dir = profile.direction === -1 ? -1 : 1

  return {
    servoModel: model.servoModel,
    positionMin: model.positionMin,
    positionMax: model.positionMax,
    positionCenter: model.logicalPositionCenter,
    angleRangeDeg: model.angleRangeDeg,
    positionResolution: model.positionResolution,
    logicalAngleMinDeg: model.logicalAngleMinDeg,
    logicalAngleCenterDeg: model.logicalAngleCenterDeg,
    logicalAngleMaxDeg: model.logicalAngleMaxDeg,
    logicalPositionMin: model.logicalPositionMin,
    logicalPositionCenter: model.logicalPositionCenter,
    logicalPositionMax: model.logicalPositionMax,
    neutralValue: model.logicalPositionCenter,
    direction: dir,
    mechanicalMaxTravelDeg: MECHANICAL_MAX_TRAVEL_DEG,
    safeMinValue: model.logicalPositionMin,
    safeMaxValue: model.logicalPositionMax,
    safeWindowDeg: MECHANICAL_MAX_TRAVEL_DEG,
    targetAtLogical0: model.logicalPositionMin,
    targetAtLogical500: model.logicalPositionCenter,
    targetAtLogical1000: model.logicalPositionMax,
    warnings: [],
  }
}

export function suggestMechanicalFromNeutral(profile) {
  void profile
  return { mechanicalMaxTravelDeg: MECHANICAL_MAX_TRAVEL_DEG, warnings: [] }
}

export function checkReadPositionForModel(profile, position) {
  const model = resolveModelFields(profile)
  const pos = Math.round(Number(position))
  const errors = []
  const warnings = []

  if (!Number.isFinite(pos)) {
    errors.push("无效 position 读数")
    return { ok: false, errors, warnings }
  }
  // Feetech 位置为无符号；RJ_SBUS 为有符号 ticks（中位 0，安全窗约 ±900）
  if (pos < 0 && model.servoModel !== SERVO_MODEL.RJ_SBUS_ANGLE) {
    errors.push("position 为负数，解析错误（须为 unsigned）")
    return { ok: false, errors, warnings, value: pos }
  }

  if (pos < model.positionMin || pos > model.positionMax) {
    if (model.servoModel === SERVO_MODEL.SC_300_1024) {
      warnings.push(`读数 ${pos} 超出 SC 0～1023，请确认 servoModel`)
    } else if (model.servoModel === SERVO_MODEL.ST32_360_4096) {
      warnings.push(`读数 ${pos} 超出 ST32 0～4095，请确认 servoModel`)
    } else {
      warnings.push(`读数 ${pos} 超出模型范围 ${model.positionMin}～${model.positionMax}`)
    }
  }

  if (pos < model.logicalPositionMin || pos > model.logicalPositionMax) {
    warnings.push(
      `读数 ${pos} 超出 FaceDEV 逻辑窗口 position ${model.logicalPositionMin}～${model.logicalPositionMax}`
    )
  }

  return { ok: errors.length === 0, errors, warnings, value: pos, model }
}

export function validateServoProfile(profile) {
  const errors = []
  const warnings = []

  if (!isKnownServoModel(profile.servoModel)) {
    errors.push(`非法 servoModel：${profile.servoModel}`)
  }

  const protocol = profile.protocol
  if (
    protocol !== PROTOCOL.SCSCL &&
    protocol !== PROTOCOL.SMS_STS &&
    protocol !== PROTOCOL.RJ_SBUS
  ) {
    errors.push(`非法 protocol：${protocol}`)
  }

  const model = resolveModelFields(profile)

  if (model.positionMin >= model.positionMax) {
    errors.push("positionMin / positionMax 非法")
  }

  if (!Number.isFinite(model.positionResolution) || model.positionResolution <= 0) {
    errors.push("positionResolution 非法")
  }

  if (profile.servoModel === SERVO_MODEL.SC_300_1024 && model.positionMax > 1023) {
    errors.push("SC 模型必须使用 position 0～1023")
  }

  if (profile.servoModel === SERVO_MODEL.ST32_360_4096 && model.positionMax <= 1023) {
    errors.push("ST32 模型不应使用 0～1023 量程")
  }

  if (profile.direction !== 1 && profile.direction !== -1) {
    errors.push("direction 只能是 +1 或 -1")
  }

  if (model.logicalPositionMin >= model.logicalPositionMax) {
    errors.push("logicalPositionMin / logicalPositionMax 非法")
  }

  if (profile.calibrated === false) {
    warnings.push("尚未 Write Logical Center / 完成装配确认")
  }

  const window = computeMechanicalSafeWindow(profile)
  warnings.push(...(window.warnings || []))

  return { ok: errors.length === 0, errors, warnings }
}

export function clampTargetWithSafety(rawTarget, profile) {
  const raw = Math.round(Number(rawTarget) || 0)
  const model = resolveModelFields(profile)
  const window = enrichProfileWithSafety(profile)

  let target = raw
  const warnings = []
  let clamped = false

  const safeMin = window.logicalPositionMin
  const safeMax = window.logicalPositionMax

  if (profile.safetyLimited !== false) {
    if (target < safeMin || target > safeMax) {
      const before = target
      target = clampInt(target, safeMin, safeMax)
      clamped = before !== target
      warnings.push(`逻辑窗口 clamp：${before} → ${target}（${safeMin}..${safeMax}）`)
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
    safeMinValue: safeMin,
    safeMaxValue: safeMax,
    logicalPositionMin: safeMin,
    logicalPositionMax: safeMax,
  }
}

export function enrichProfileWithSafety(profile) {
  const model = resolveModelFields(profile)
  const window = computeMechanicalSafeWindow(profile)
  return {
    ...profile,
    ...model,
    minValue: model.positionMin,
    maxValue: model.positionMax,
    neutralValue: model.logicalPositionCenter,
    ...window,
    safetyLimited: profile.safetyLimited !== false,
  }
}
