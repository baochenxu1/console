/**
 * Servo Lab 运动：prepareServoWrite + 写位置 / 回中（含机械安全校验）。
 */

import { PROTOCOL } from "../core/servoTypes.js"
import {
  normalizeLabServoProfile,
  validateServoProfile,
} from "../core/servoProfile.js"
import { prepareServoWrite, computeServoTargetFromLogical } from "../core/servoProfileMath.js"

export function buildWriteOptionsFromProfile(profile, protocol) {
  const p = normalizeLabServoProfile({ ...profile, protocol })
  if (protocol === PROTOCOL.SCSCL) {
    return { time: p.time, speed: p.speed }
  }
  if (protocol === PROTOCOL.RJ_SBUS) {
    /* power=0 为协议合法值（按上限执行）；仅缺省时回退 600 */
    const raw = p.power
    const hasPower = raw != null && raw !== ""
    const power = hasPower && Number.isFinite(Number(raw))
      ? Math.max(0, Math.round(Number(raw)))
      : 600
    return { time: p.time ?? 0, power, waitAck: false }
  }
  return { speed: p.speed, acc: p.acc }
}

export async function writePositionWithProfile(adapter, profile, input, options = {}) {
  const p = normalizeLabServoProfile(profile)
  const prep =
    typeof input === "number"
      ? prepareServoWrite(p, {
          targetPosition: input,
          requireCalibrated: options.requireCalibrated,
          allowManualWrite: options.allowManualWrite !== false,
        })
      : prepareServoWrite(p, {
          ...input,
          requireCalibrated: options.requireCalibrated,
          allowManualWrite: options.allowManualWrite,
        })

  if (!prep.ok) {
    return {
      ok: false,
      id: p.id,
      error: prep.error,
      blocked: prep.blocked,
      warnings: prep.warnings,
      errors: prep.errors,
    }
  }

  for (const w of prep.warnings || []) {
    if (options.onWarning) options.onWarning(w)
  }

  const writeOpts = {
    ...buildWriteOptionsFromProfile(p, p.protocol),
    posMin: p.effectiveSafeMinValue ?? p.installedSafeMinValue ?? p.logicalPositionMin ?? p.safeMinValue ?? p.minValue,
    posMax: p.effectiveSafeMaxValue ?? p.installedSafeMaxValue ?? p.logicalPositionMax ?? p.safeMaxValue ?? p.maxValue,
    waitAck: options.waitAck !== false,
  }
  /* 下发命令可覆盖 profile 默认 time/speed（实时跟手 time=0） */
  if (Number.isFinite(Number(options.time))) {
    writeOpts.time = Math.max(0, Math.round(Number(options.time)))
  }
  if (Number.isFinite(Number(options.speed))) {
    writeOpts.speed = Math.max(0, Math.round(Number(options.speed)))
  }
  if (Number.isFinite(Number(options.acc))) {
    writeOpts.acc = Math.max(0, Math.round(Number(options.acc)))
  }
  const res = await adapter.writePosition(p.id, prep.targetPosition, writeOpts)
  return {
    ...res,
    id: p.id,
    signedCommand: prep.signedCommand,
    requestedTarget: prep.rawTarget,
    sentTarget: prep.targetPosition,
    targetPosition: prep.targetPosition,
    clamped: prep.clamped,
    clampWarning: (prep.warnings || []).join("; "),
    warnings: prep.warnings,
  }
}

export async function writeLogicalValueWithProfile(adapter, profile, logicalValue, options = {}) {
  return writePositionWithProfile(
    adapter,
    profile,
    { logicalValue, requireCalibrated: options.requireCalibrated === true },
    options
  )
}

export async function writeSignedCommandWithProfile(adapter, profile, signedCommand, options = {}) {
  return writePositionWithProfile(
    adapter,
    profile,
    { signedCommand, requireCalibrated: true },
    options
  )
}

export async function returnNeutralWithProfile(adapter, profile) {
  const p = normalizeLabServoProfile(profile)

  const validation = validateServoProfile(p)
  if (!validation.ok) {
    return {
      ok: false,
      id: p.id,
      error: validation.errors[0] || "Profile 校验失败",
      errors: validation.errors,
    }
  }

  const plan = computeServoTargetFromLogical(p, 500)
  const res = await writePositionWithProfile(
    adapter,
    p,
    { logicalValue: 500 },
    { waitAck: false, allowManualWrite: false }
  )

  const centerPos = plan.targetPosition ?? p.effectiveCenterPosition ?? p.logicalPositionCenter

  return {
    ...res,
    logicalValue: 500,
    centerMode: p.centerMode,
    targetPosition: centerPos,
    message: `Return Neutral #${p.id} => logical 500, position ${centerPos}`,
  }
}
