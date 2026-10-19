/**
 * Jaw 2DOF：Semantic jaw.value/lateral → Jaw3d IK → qA/qD → jaw_A / jaw_D Binding。
 */

import {
  CHANNEL_VALUE,
  applyBindingInvertToPwm,
  resolveBindingTargetsForEvaluate,
} from "../../core/faceRigProfile.js"
import {
  SERVO_LOGICAL_MIN_PWM,
  SERVO_LOGICAL_MAX_PWM,
  getServoConfig,
  logicalToActualPwm,
  STANDARD_CENTER_PWM,
} from "../../core/servoConfig.js"
import { clampNumber } from "../../utils/clamp.js"
import {
  JAW_A_DEFAULT_SERVO_ID,
  JAW_D_DEFAULT_SERVO_ID,
} from "../binding/jawNodeBindingDefaults.js"
import {
  createJaw3dState,
  resolveJaw3dStructure,
  solveJaw3dFromPad,
  JAW3D_PAD_LATERAL_SPAN,
  JAW3D_PAD_VALUE_SPAN,
} from "./jaw3dKinematics.js"

export const JAW_KIN_META = Object.freeze({
  semanticControlId: "jaw",
  nodeAControlId: "jaw_A",
  nodeDControlId: "jaw_D",
  expectedServoAId: JAW_A_DEFAULT_SERVO_ID,
  expectedServoDId: JAW_D_DEFAULT_SERVO_ID,
  label: "下颌",
})

function findValueBinding(profile, controlId) {
  if (!controlId) return null
  return (
    (profile?.bindings || []).find(
      (b) => b?.controlId === controlId && b.channel === CHANNEL_VALUE && b.enabled !== false
    ) || null
  )
}

export function jawAngleToBindingLogicalPwm(qDeg, binding) {
  const t = resolveBindingTargetsForEvaluate(binding) || {}
  const neutral = Number(t.neutralPwm)
  const pos = Number(t.positiveTargetPwm)
  const neg = Number(t.negativeTargetPwm)
  const n0 = Number.isFinite(neutral) ? neutral : STANDARD_CENTER_PWM
  const pT = Number.isFinite(pos) ? pos : SERVO_LOGICAL_MAX_PWM
  const nT = Number.isFinite(neg) ? neg : SERVO_LOGICAL_MIN_PWM
  const q = clampNumber(Number(qDeg) || 0, -90, 90)
  const u = q / 90
  const pwm = u >= 0 ? n0 + u * (pT - n0) : n0 + u * (n0 - nT)
  return applyBindingInvertToPwm(
    clampNumber(Math.round(pwm), SERVO_LOGICAL_MIN_PWM, SERVO_LOGICAL_MAX_PWM),
    { ...binding, invert: Boolean(binding?.invert), neutralPwm: n0 }
  )
}

/**
 * @param {object} [rigValues]
 */
export function rigValuesForJaw(rigValues) {
  if (!rigValues || typeof rigValues !== "object") {
    return { value: 0, lateral: 0 }
  }
  const j = rigValues.jaw
  if (j && typeof j === "object") {
    const value = Number(j.value ?? j.val)
    const lateral = Number(j.lateral)
    return {
      value: Number.isFinite(value)
        ? clampNumber(value, -JAW3D_PAD_VALUE_SPAN, JAW3D_PAD_VALUE_SPAN)
        : 0,
      lateral: Number.isFinite(lateral)
        ? clampNumber(lateral, -JAW3D_PAD_LATERAL_SPAN, JAW3D_PAD_LATERAL_SPAN)
        : 0,
    }
  }
  return { value: 0, lateral: 0 }
}

export function resolveJawKinematics(profile, options = null) {
  const bindingA = findValueBinding(profile, JAW_KIN_META.nodeAControlId)
  const bindingD = findValueBinding(profile, JAW_KIN_META.nodeDControlId)
  const servoAId = bindingA ? Number(bindingA.servoId) : null
  const servoDId = bindingD ? Number(bindingD.servoId) : null

  const userKin = options?.kinematics?.jaw3d || options?.kinematics?.jaw || options?.kinematics || {}
  const enabled = userKin.enabled !== false
  const params = {
    ...resolveJaw3dStructure(userKin),
    ...(options?.runtimeParams || {}),
  }

  const readyForIk =
    enabled &&
    bindingA &&
    bindingD &&
    Number.isFinite(servoAId) &&
    Number.isFinite(servoDId) &&
    servoAId !== servoDId

  let skipReason = ""
  if (!enabled) skipReason = `${JAW_KIN_META.label}三自由度 IK 未启用`
  else if (!bindingA || !bindingD) {
    skipReason = `${JAW_KIN_META.label}缺少 jaw_A / jaw_D 绑定`
  } else if (!Number.isFinite(servoAId) || !Number.isFinite(servoDId)) {
    skipReason = `${JAW_KIN_META.label} A/D 舵机号无效`
  } else if (servoAId === servoDId) skipReason = `${JAW_KIN_META.label} A/D 不能共用舵机`

  return {
    meta: JAW_KIN_META,
    enabled,
    readyForIk: Boolean(readyForIk),
    skipReason,
    bindingA,
    bindingD,
    servoAId: Number.isFinite(servoAId) ? servoAId : null,
    servoDId: Number.isFinite(servoDId) ? servoDId : null,
    nodeABindingKey: bindingA?.controlId || JAW_KIN_META.nodeAControlId,
    nodeDBindingKey: bindingD?.controlId || JAW_KIN_META.nodeDControlId,
    params,
  }
}

export function createJawKinematicsState() {
  return createJaw3dState()
}

export function computeJaw3dIk(rigValues, resolved, state) {
  const pad = rigValuesForJaw(rigValues)
  const result = solveJaw3dFromPad(pad, state || createJawKinematicsState(), resolved?.params)
  const pwmA = result.ok ? jawAngleToBindingLogicalPwm(result.qA, resolved.bindingA) : null
  const pwmD = result.ok ? jawAngleToBindingLogicalPwm(result.qD, resolved.bindingD) : null

  const diagnostics = {
    enabled: resolved?.enabled !== false,
    readyForIk: Boolean(resolved?.readyForIk),
    ikOk: Boolean(result.ok),
    ikMessage: result.ok ? "" : result.message || "IK 失败",
    input: result.diagnostics?.input || pad,
    geometry: result.diagnostics?.geometry || null,
    servo: {
      qA: result.qA,
      qD: result.qD,
    },
    binding: {
      nodeAKey: resolved?.nodeABindingKey || JAW_KIN_META.nodeAControlId,
      nodeDKey: resolved?.nodeDBindingKey || JAW_KIN_META.nodeDControlId,
      servoAId: resolved?.servoAId ?? null,
      servoDId: resolved?.servoDId ?? null,
    },
    constraints: result.diagnostics?.constraints || null,
    overrideNote: result.ok
      ? "jaw.{value,lateral} → jaw3d IK → jaw_A(qA)/jaw_D(qD)"
      : "",
    hold: Boolean(result.hold),
  }

  return {
    ok: Boolean(result.ok),
    message: result.message,
    qA: result.qA,
    qD: result.qD,
    pwmA,
    pwmD,
    diagnostics,
  }
}

/**
 * 剔除旧 jaw direct 与节点线性贡献，改由 IK 写入。
 */
export function contributionExcludedForJaw3d(c, resolved) {
  if (!resolved?.readyForIk) return false
  if (c.controlId === "jaw") return true
  if (
    (c.controlId === JAW_KIN_META.nodeAControlId || c.controlId === JAW_KIN_META.nodeDControlId) &&
    c.channel === CHANNEL_VALUE
  ) {
    return true
  }
  const sid = Number(c.servoId)
  if (
    Number.isFinite(sid) &&
    (sid === Number(resolved.servoAId) || sid === Number(resolved.servoDId))
  ) {
    /* 仅当该贡献来自 jaw / jaw_A / jaw_D 时排除，避免误伤同 ID 其它控件 */
    if (
      c.controlId === "jaw" ||
      c.controlId === JAW_KIN_META.nodeAControlId ||
      c.controlId === JAW_KIN_META.nodeDControlId
    ) {
      return true
    }
  }
  return false
}

export function applyJawKinematicsOverrides({ pose, resolved, ikResult, configs = [] } = {}) {
  if (!pose || !resolved?.readyForIk) return pose
  if (!pose.logicalPose) pose.logicalPose = {}
  if (!pose.actualPose) pose.actualPose = {}
  if (!pose.kinematics) pose.kinematics = {}

  if (!ikResult?.ok) {
    pose.kinematics.jaw3d = ikResult?.diagnostics || {
      enabled: true,
      readyForIk: true,
      ikOk: false,
      ikMessage: ikResult?.message || "IK 失败",
    }
    return pose
  }

  const sa = String(resolved.servoAId)
  const sd = String(resolved.servoDId)
  const pwmA = ikResult.pwmA
  const pwmD = ikResult.pwmD
  if (
    pwmA == null ||
    pwmD == null ||
    !Number.isFinite(Number(pwmA)) ||
    !Number.isFinite(Number(pwmD))
  ) {
    pose.kinematics.jaw3d = {
      ...(ikResult.diagnostics || {}),
      ikOk: false,
      ikMessage: "incomplete-pair-pwm",
    }
    return pose
  }

  const cfgList = Array.isArray(configs) ? configs : []
  const write = (servoKey, servoId, pwm) => {
    const logical = Math.round(
      Math.max(SERVO_LOGICAL_MIN_PWM, Math.min(SERVO_LOGICAL_MAX_PWM, Number(pwm)))
    )
    pose.logicalPose[servoKey] = logical
    if (!cfgList.length) {
      pose.actualPose[servoKey] = logical
      return
    }
    const cfg = getServoConfig(cfgList, servoId)
    if (cfg.enabled === false) return
    pose.actualPose[servoKey] = logicalToActualPwm(logical, cfg).actualPwm
  }

  write(sa, resolved.servoAId, pwmA)
  write(sd, resolved.servoDId, pwmD)

  pose.kinematics.jaw3d = {
    ...(ikResult.diagnostics || {}),
    qACommandDeg: ikResult.qA,
    qDCommandDeg: ikResult.qD,
    finalCommandA: pose.logicalPose[sa] ?? null,
    finalCommandD: pose.logicalPose[sd] ?? null,
  }
  return pose
}

/**
 * 下颌 3D IK 启用时，「设为中位 / ±极限」应取 IK 下发 logicalPwm（jaw_A / jaw_D），
 * 而非被剔除的线性 binding contribution。
 * @param {object} binding
 * @param {object} [kinematics]
 */
export function resolveJawNeutralCapture(binding, kinematics) {
  if (!binding) return null
  const isA = binding.controlId === JAW_KIN_META.nodeAControlId
  const isD = binding.controlId === JAW_KIN_META.nodeDControlId
  if (!isA && !isD) return null
  if (binding.channel !== CHANNEL_VALUE && binding.channel !== "value") return null

  const kin = kinematics?.jaw3d
  if (!kin || kin.readyForIk === false) return null
  if (kin.ikOk === false) return null

  const pwm = Number(isA ? kin.finalCommandA : kin.finalCommandD)
  const hwServoId = Number(
    isA ? (kin.binding?.servoAId ?? kin.servoAId) : (kin.binding?.servoDId ?? kin.servoDId)
  )
  if (!Number.isFinite(pwm) || !Number.isFinite(hwServoId)) return null

  return {
    controlId: binding.controlId,
    channel: CHANNEL_VALUE,
    pwm: Math.round(pwm),
    hwServoId,
  }
}

export { createJaw3dState, solveJaw3dFromPad }
