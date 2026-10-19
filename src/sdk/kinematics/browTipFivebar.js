/**
 * 眉尖五杆适配层：Face Rig brow.x/y → BrowFiveBarKinematics → Binding。
 *
 * 右眉：qF → F，qD → D。
 * 遗留字段 tipA_deg ≡ qD，tipB_deg ≡ qF（与旧 tip_a/tip_b 对齐）。
 * 几何与左右镜像见 {@link ./browFiveBarKinematics.js}。
 */

import { clampNumber } from "../../utils/clamp.js"
import {
  SERVO_LOGICAL_MIN_PWM,
  SERVO_LOGICAL_MAX_PWM,
  STANDARD_CENTER_PWM,
} from "../../core/servoConfig.js"
import {
  applyBindingInvertToPwm,
  resolveBindingTargetsForEvaluate,
} from "../../core/faceRigProfile.js"
import {
  BROW_FIVEBAR_PAD_SPAN,
  DEFAULT_BROW_FIVEBAR_STRUCTURE,
  createBrowFiveBarState,
  normalizeBrowFiveBarSideId,
  resolveBrowFiveBarStructure,
  solveBrowFiveBarFromPad,
  BROW_FIVEBAR_RIGHT_GEOMETRY,
  BROW_FIVEBAR_LEFT_ANCHORS,
} from "./browFiveBarKinematics.js"

export const BROW_TIP_PAD_SPAN = BROW_FIVEBAR_PAD_SPAN

/** @deprecated 占位旧五杆参数；新几何由 BrowFiveBarKinematics 固定 + structure.range* */
export const DEFAULT_BROW_TIP_FIVEBAR_PARAMS = Object.freeze({
  right: Object.freeze({
    ...DEFAULT_BROW_FIVEBAR_STRUCTURE,
    A0: BROW_FIVEBAR_RIGHT_GEOMETRY.A0,
    padXCenter: 0,
    padYCenter: 0,
  }),
  left: Object.freeze({
    ...DEFAULT_BROW_FIVEBAR_STRUCTURE,
    A0: BROW_FIVEBAR_LEFT_ANCHORS.A0,
    padXCenter: 0,
    padYCenter: 0,
  }),
})

export function normalizeBrowTipSideId(sideId = "left") {
  return normalizeBrowFiveBarSideId(sideId)
}

export function getDefaultBrowTipFivebarParams(sideId = "left") {
  const side = normalizeBrowTipSideId(sideId)
  return { ...DEFAULT_BROW_TIP_FIVEBAR_PARAMS[side] }
}

export function createBrowTipFivebarState() {
  return createBrowFiveBarState()
}

/**
 * qDeg ∈ [-90,90] → binding logical PWM。
 */
export function browAngleToBindingLogicalPwm(qDeg, binding) {
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
 * 完整 (x,y) → 一次五杆 IK → qD / qF。
 * tipA_deg ≡ qD，tipB_deg ≡ qF（遗留命名）。
 * 禁止 tip_a=f(y)、tip_b=f(x) 或 Horizontal→单舵机。
 */
export function solveBrowTipIk({ browTarget, resolved, params, state } = {}) {
  const bindingF = resolved?.bindingF ?? resolved?.bindingB
  const bindingD = resolved?.bindingD ?? resolved?.bindingA
  const bindingA = bindingD
  const bindingB = bindingF
  const servoFId = resolved?.servoFId ?? resolved?.servoBId
  const servoDId = resolved?.servoDId ?? resolved?.servoAId
  const servoAId = servoDId
  const servoBId = servoFId
  const sideId = normalizeBrowTipSideId(resolved?.sideId || params?.sideId || "right")
  const st = state || createBrowTipFivebarState()
  const structure = resolveBrowFiveBarStructure({
    ...DEFAULT_BROW_FIVEBAR_STRUCTURE,
    ...(params || {}),
  })

  const pad = {
    x: clampNumber(Number(browTarget?.x), -BROW_TIP_PAD_SPAN, BROW_TIP_PAD_SPAN),
    y: clampNumber(Number(browTarget?.y), -BROW_TIP_PAD_SPAN, BROW_TIP_PAD_SPAN),
  }

  const solved = solveBrowFiveBarFromPad(pad, sideId, st, structure)

  const qDDeg = solved.ok ? solved.qDDeg : null
  const qFDeg = solved.ok ? solved.qFDeg : null
  /* 遗留：tip_a ← qD，tip_b ← qF */
  const tipA_deg = qDDeg
  const tipB_deg = qFDeg

  const pwmD =
    solved.ok && bindingD && Number.isFinite(qDDeg)
      ? browAngleToBindingLogicalPwm(qDDeg, bindingD)
      : null
  const pwmF =
    solved.ok && bindingF && Number.isFinite(qFDeg)
      ? browAngleToBindingLogicalPwm(qFDeg, bindingF)
      : null
  const pwmA = pwmD
  const pwmB = pwmF

  const diagnostics = {
    ok: Boolean(solved.ok),
    browTarget: { ...pad },
    brow: { x: pad.x, y: pad.y },
    sideId,
    structure,
    servoFId,
    servoDId,
    servoAId,
    servoBId,
    nodeFBindingKey: resolved?.nodeFBindingKey || null,
    nodeDBindingKey: resolved?.nodeDBindingKey || null,
    tipA_deg,
    tipB_deg,
    qDDeg,
    qFDeg,
    alphaD: solved.diagnostics?.thetaDDeg ?? null,
    alphaF: solved.diagnostics?.thetaFDeg ?? null,
    logicalPwmF: pwmF,
    logicalPwmD: pwmD,
    logicalPwmA: pwmA,
    logicalPwmB: pwmB,
    held: Boolean(solved.held),
    ...(solved.diagnostics || {}),
    message: solved.message || "",
  }
  st.lastDiagnostics = diagnostics

  return {
    ok: Boolean(solved.ok),
    message: solved.ok ? "" : solved.message || "IK 失败",
    tipA_deg,
    tipB_deg,
    qDDeg,
    qFDeg,
    pwmA,
    pwmB,
    pwmF,
    pwmD,
    Aworld: solved.Aworld,
    Acanonical: solved.Acanonical,
    diagnostics,
  }
}

export {
  BROW_FIVEBAR_RIGHT_GEOMETRY,
  BROW_FIVEBAR_LEFT_ANCHORS,
  DEFAULT_BROW_FIVEBAR_STRUCTURE,
  browPadToWorldA,
  solveBrowFiveBarFromPad,
} from "./browFiveBarKinematics.js"
