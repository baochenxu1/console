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
  chooseNearestIkCandidate,
  fivebarFk,
  fivebarIkAllCandidates,
} from "./fiveBar2d.js"
import { getMouthCornerLabSide } from "./mouthCornerFiveBarLabConfig.js"

function buildPadFlipDefaultsFromLab() {
  /** @type {Record<string, { flipPadX: boolean, flipPadY: boolean }>} */
  const out = {}
  for (const id of ["left", "right"]) {
    const d = getMouthCornerLabSide(id).defaultCalibration
    out[id] = { flipPadX: Boolean(d.flipPadX), flipPadY: Boolean(d.flipPadY) }
  }
  return out
}

/** 默认几何与 Pad 映射（与 MATLAB 一致） */
export const RIGHT_MOUTH_CORNER_FIVEBAR_PARAMS = {
  B: [0, 0],
  A: [3.07, 16.76],

  L_AE: 14.81,
  L_BC: 18.69,
  L_ED: 39.57,
  L_CD: 19.12,

  thetaA0Deg: 142.33,
  thetaB0Deg: -125.18,

  dirA: 1,
  dirB: 1,

  fkDBranch: "left",

  qAMinDeg: -90,
  qAMaxDeg: 90,
  qBMinDeg: -90,
  qBMaxDeg: 90,

  padXCenter: 50,
  padYCenter: 50,

  Kx: 7,
  Ky: 7,
  /** Pad→D 与 D→Pad 符号（与 MATLAB Pad Axis Reachable Debug 一致，默认 +1） */
  xSign: 1,
  ySign: 1,

  /** @deprecated 使用 {@link MOUTH_CORNER_PAD_FLIP_DEFAULTS} 按侧默认值 */
  flipPadX: false,
  flipPadY: false,

  maxStepDeg: 2.0,
  filterAlpha: 0.35,
}

/** 左右嘴角 IK 输入 pad 翻转默认值（与 mouthCornerFiveBarLabConfig.defaultCalibration 同步） */
export const MOUTH_CORNER_PAD_FLIP_DEFAULTS = /** @type {const} */ (buildPadFlipDefaultsFromLab())

export const MOUTH_CORNER_PAD_SPAN = 100

/**
 * @param {"left"|"right"|string} [sideId]
 */
export function normalizeMouthCornerSideId(sideId = "right") {
  return String(sideId || "right").toLowerCase() === "left" ? "left" : "right"
}

/**
 * @param {"left"|"right"|string} [sideId]
 */
export function getDefaultMouthCornerPadFlip(sideId = "right") {
  const side = normalizeMouthCornerSideId(sideId)
  const d = getMouthCornerLabSide(side).defaultCalibration
  return {
    ...MOUTH_CORNER_PAD_FLIP_DEFAULTS[side],
    padRotateCcwDeg: normalizePadRotateCcwDeg(d.padRotateCcwDeg, 0),
  }
}

/**
 * @param {object} [params]
 * @param {"left"|"right"|string} [sideId]
 */
export function resolveMouthCornerPadFlipFlags(params = {}, sideId = "right") {
  const side = normalizeMouthCornerSideId(sideId)
  const sideDefaults = MOUTH_CORNER_PAD_FLIP_DEFAULTS[side]
  const sidePrefix = side === "left" ? "leftMouthCorner" : "rightMouthCorner"
  const sideBlock =
    params[side] && typeof params[side] === "object" ? params[side] : null
  const flipPadX = Boolean(
    sideBlock?.flipPadX ??
      params[`${sidePrefix}PadFlipX`] ??
      sideDefaults.flipPadX ??
      params.flipPadX
  )
  const flipPadY = Boolean(
    sideBlock?.flipPadY ??
      params[`${sidePrefix}PadFlipY`] ??
      sideDefaults.flipPadY ??
      params.flipPadY
  )
  return { flipPadX, flipPadY, sideId: side }
}

/**
 * @param {unknown} value
 * @param {number} [fallback]
 */
export function normalizePadRotateCcwDeg(value, fallback = 0) {
  const n = Number(value)
  const base = Number.isFinite(n) ? n : Number(fallback)
  if (!Number.isFinite(base)) return 0
  let d = ((((Math.round(base / 90) * 90) % 360) + 360) % 360)
  if (d > 180) d -= 360
  return d === 0 ? 0 : d
}

/**
 * 绕 pad 中心逆时针旋转（仅支持 0/±90/180）。
 * @param {number} padX
 * @param {number} padY
 * @param {number} degCcw
 * @param {number} [span]
 */
export function rotatePadCcwAroundCenter(padX, padY, degCcw, span = MOUTH_CORNER_PAD_SPAN) {
  const d = normalizePadRotateCcwDeg(degCcw, 0)
  if (d === 90) return { x: padY, y: span - padX }
  if (d === -90) return { x: span - padY, y: padX }
  if (d === 180 || d === -180) return { x: span - padX, y: span - padY }
  return { x: padX, y: padY }
}

/**
 * @param {object} [params]
 * @param {"left"|"right"|string} [sideId]
 */
export function resolveMouthCornerPadRotateCcwDeg(params = {}, sideId = "right") {
  const side = normalizeMouthCornerSideId(sideId)
  const sidePrefix = side === "left" ? "leftMouthCorner" : "rightMouthCorner"
  const sideBlock =
    params[side] && typeof params[side] === "object" ? params[side] : null
  const labDefault = getMouthCornerLabSide(side).defaultCalibration.padRotateCcwDeg ?? 0
  const raw =
    sideBlock?.padRotateCcwDeg ??
    params[`${sidePrefix}PadRotateCcwDeg`] ??
    params.padRotateCcwDeg ??
    labDefault
  return normalizePadRotateCcwDeg(raw, labDefault)
}

/**
 * 保留 raw 控件 pad，生成 IK 用 effective pad（先轴翻转，再按侧旋转）。
 * @param {{ x?: number, y?: number }} rawPad
 * @param {object} [params]
 * @param {"left"|"right"|string} [sideId]
 */
export function applyMouthCornerPadFlip(rawPad, params = {}, sideId = "right") {
  const cx = Number(params.padXCenter ?? 50)
  const rawX = Number(rawPad?.x)
  const rawY = Number(rawPad?.y)
  const rawPadX = Number.isFinite(rawX) ? rawX : cx
  const rawPadY = Number.isFinite(rawY) ? rawY : cx
  const { flipPadX, flipPadY, sideId: resolvedSideId } = resolveMouthCornerPadFlipFlags(
    params,
    sideId
  )
  const flippedX = flipPadX ? MOUTH_CORNER_PAD_SPAN - rawPadX : rawPadX
  const flippedY = flipPadY ? MOUTH_CORNER_PAD_SPAN - rawPadY : rawPadY
  const padRotateCcwDeg = resolveMouthCornerPadRotateCcwDeg(params, resolvedSideId)
  const rotated = rotatePadCcwAroundCenter(flippedX, flippedY, padRotateCcwDeg)
  return {
    rawPadX,
    rawPadY,
    effectivePadX: rotated.x,
    effectivePadY: rotated.y,
    flipPadX,
    flipPadY,
    padRotateCcwDeg,
    sideId: resolvedSideId,
    x: rotated.x,
    y: rotated.y,
  }
}

export function createRightMouthCornerFivebarState() {
  return {
    qPrev: [0, 0],
    lastOk: false,
    lastDiagnostics: null,
  }
}

export function resetRightMouthCornerFivebarState(state) {
  if (!state || typeof state !== "object") {
    return
  }
  state.qPrev[0] = 0
  state.qPrev[1] = 0
  state.lastOk = false
  state.lastDiagnostics = null
}

/**
 * @param {number} qDeg
 * @param {object} binding
 */
export function angleToBindingLogicalPwm(qDeg, binding) {
  const resolved = resolveBindingTargetsForEvaluate(binding || {})
  const neutral = resolved.neutralPwm
  const positiveTargetPwm = resolved.positiveTargetPwm
  const negativeTargetPwm = resolved.negativeTargetPwm
  const q = Number(qDeg)
  const qSafe = Number.isFinite(q) ? q : 0
  let pwm
  if (qSafe >= 0) {
    pwm = neutral + (positiveTargetPwm - neutral) * (qSafe / 90)
  } else {
    pwm = neutral + (negativeTargetPwm - neutral) * (Math.abs(qSafe) / 90)
  }
  return applyBindingInvertToPwm(
    clampNumber(Math.round(pwm), SERVO_LOGICAL_MIN_PWM, SERVO_LOGICAL_MAX_PWM),
    binding
  )
}

/**
 * @param {{ x: number, y: number }} pad
 * @param {[number, number] | null} D0
 * @param {object} params
 * @param {"left"|"right"|string} [sideId]
 */
export function padToMouthCornerDTarget(pad, D0, params, sideId = "right") {
  const cx = Number(params.padXCenter ?? 50)
  const cy = Number(params.padYCenter ?? 50)
  const Kx = Number(params.Kx ?? 7)
  const Ky = Number(params.Ky ?? 7)
  const xSign = Number(params.xSign ?? 1)
  const ySign = Number(params.ySign ?? 1)
  const padFlip = applyMouthCornerPadFlip(pad, params, sideId)
  const sx = padFlip.effectivePadX
  const sy = padFlip.effectivePadY

  if (!D0 || !Number.isFinite(D0[0]) || !Number.isFinite(D0[1])) {
    return { D_raw: null, u: 0, v: 0, padFlip }
  }

  const u = cx !== 0 ? (sx - cx) / cx : 0
  const v = cy !== 0 ? (cy - sy) / cy : 0
  const D_raw = [D0[0] + xSign * Kx * u, D0[1] + ySign * Ky * v]
  return { D_raw, u, v, padFlip }
}

/** @param {{ x: number, y: number }} sideR @param {[number, number] | null} D0 @param {object} params */
export function padToRightMouthCornerDTarget(sideR, D0, params) {
  return padToMouthCornerDTarget(sideR, D0, params, "right")
}

/** @param {{ x: number, y: number }} sideL @param {[number, number] | null} D0 @param {object} params */
export function padToLeftMouthCornerDTarget(sideL, D0, params) {
  return padToMouthCornerDTarget(sideL, D0, params, "left")
}

function dReachableCount(D, params) {
  return fivebarIkAllCandidates(D, params).length
}

/**
 * @param {[number, number]} D_raw
 * @param {[number, number]} D0
 * @param {object} params
 */
export function clampDToReachableArea(D_raw, D0, params) {
  if (!D_raw || !D0 || !Number.isFinite(D_raw[0]) || !Number.isFinite(D_raw[1])) {
    return {
      D_safe: D0,
      scale: 0,
      message: "D_raw 或 D0 无效",
    }
  }
  if (!Number.isFinite(D0[0]) || !Number.isFinite(D0[1])) {
    return { D_safe: D0, scale: 0, message: "D0 无效" }
  }

  if (dReachableCount(D_raw, params) > 0) {
    return { D_safe: [...D_raw], scale: 1, message: "" }
  }

  if (dReachableCount(D0, params) === 0) {
    return {
      D_safe: [...D0],
      scale: 0,
      message: "D0 不可达，无法沿射线 clamp",
    }
  }

  let lo = 0
  let hi = 1
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    const Dm = [
      D0[0] + mid * (D_raw[0] - D0[0]),
      D0[1] + mid * (D_raw[1] - D0[1]),
    ]
    if (dReachableCount(Dm, params) > 0) {
      lo = mid
    } else {
      hi = mid
    }
  }
  const scale = lo
  const D_safe = [
    D0[0] + scale * (D_raw[0] - D0[0]),
    D0[1] + scale * (D_raw[1] - D0[1]),
  ]
  const message = scale < 1 - 1e-9 ? "D_target 超出可达区，已 clamp" : ""
  return { D_safe, scale, message }
}

/**
 * @param {[number, number]} qRaw
 * @param {[number, number]} qPrev
 * @param {number} maxStepDeg
 * @param {number} alpha
 * @returns {[number, number]}
 */
export function servoOutputFilter(qRaw, qPrev, maxStepDeg, alpha) {
  const maxS = Number(maxStepDeg)
  const a = Number(alpha)
  const maxStep = Number.isFinite(maxS) ? maxS : 2
  const al = Number.isFinite(a) ? a : 0.35
  const out = [0, 0]
  for (let i = 0; i < 2; i++) {
    const prev = Number(qPrev[i])
    const raw = Number(qRaw[i])
    const p0 = Number.isFinite(prev) ? prev : 0
    const r0 = Number.isFinite(raw) ? raw : 0
    const qSmooth = p0 + al * (r0 - p0)
    let dq = qSmooth - p0
    dq = clampNumber(dq, -maxStep, maxStep)
    out[i] = p0 + dq
  }
  return out
}

/**
 * @param {object} resolved — {@link resolveRightMouthCornerFivebar} 的「就绪」上下文（bindingA/B、params、servo id）
 * @param {{ x: number, y: number }} sideR
 * @param {object} params
 * @param {ReturnType<typeof createRightMouthCornerFivebarState>} state
 * @param {"left"|"right"|string} [sideId]
 */
export function resolveRightMouthCornerFivebar({ resolved, sideR, params, state, sideId = "right" }) {
  const bindingA = resolved.bindingA
  const bindingB = resolved.bindingB
  const servoAId = resolved.servoAId
  const servoBId = resolved.servoBId

  const baseDiag = {
    enabled: true,
    ok: false,
    sideR: { x: sideR.x, y: sideR.y },
    rawPadX: null,
    rawPadY: null,
    effectivePadX: null,
    effectivePadY: null,
    flipPadX: null,
    flipPadY: null,
    sideId: normalizeMouthCornerSideId(sideId),
    D0: null,
    D_raw: null,
    D_safe: null,
    scale: 0,
    candidateCount: 0,
    qRaw: null,
    qCmd: null,
    servoAId,
    servoBId,
    logicalPwmA: null,
    logicalPwmB: null,
    pwmA: null,
    pwmB: null,
    message: "",
  }

  const fk0 = fivebarFk(0, 0, params)
  if (!fk0.ok || !fk0.D) {
    const msg = fk0.message || "FK(0,0) 失败"
    return {
      ok: false,
      message: msg,
      pwmA: null,
      pwmB: null,
      diagnostics: {
        ...baseDiag,
        message: msg,
        rightMouthCornerFivebar: { ...baseDiag, message: msg },
      },
    }
  }
  const D0 = fk0.D
  baseDiag.D0 = [...D0]

  const pad = padToMouthCornerDTarget(sideR, D0, params, sideId)
  if (pad.padFlip) {
    baseDiag.rawPadX = pad.padFlip.rawPadX
    baseDiag.rawPadY = pad.padFlip.rawPadY
    baseDiag.effectivePadX = pad.padFlip.effectivePadX
    baseDiag.effectivePadY = pad.padFlip.effectivePadY
    baseDiag.flipPadX = pad.padFlip.flipPadX
    baseDiag.flipPadY = pad.padFlip.flipPadY
  }
  baseDiag.u = pad.u
  baseDiag.v = pad.v
  if (!pad.D_raw) {
    const msg = "Pad→D_raw 失败"
    return {
      ok: false,
      message: msg,
      pwmA: null,
      pwmB: null,
      diagnostics: {
        ...baseDiag,
        D0: [...D0],
        message: msg,
        rightMouthCornerFivebar: { ...baseDiag, D0: [...D0], message: msg },
      },
    }
  }

  const D_raw = pad.D_raw
  baseDiag.D_raw = [...D_raw]

  const clamped = clampDToReachableArea(D_raw, D0, params)
  const D_safe = clamped.D_safe
  const scale = clamped.scale
  let msgExtra = clamped.message || ""

  baseDiag.D_safe = [...D_safe]
  baseDiag.scale = scale

  const candidates = fivebarIkAllCandidates(D_safe, params)
  baseDiag.candidateCount = candidates.length

  if (candidates.length === 0) {
    const msg = `IK 无解（D_safe 上无有效候选，clamp 后仍不可解）${msgExtra ? `；${msgExtra}` : ""}`
    state.lastOk = false
    state.lastDiagnostics = { ...baseDiag, message: msg }
    const full = { ...baseDiag, message: msg, rightMouthCornerFivebar: { ...baseDiag, message: msg } }
    return { ok: false, message: msg, pwmA: null, pwmB: null, diagnostics: full }
  }

  const qRef = { qA_deg: state.qPrev[0], qB_deg: state.qPrev[1] }
  const picked = chooseNearestIkCandidate(candidates, qRef)
  if (!picked) {
    const msg = "最近 IK 候选选择失败"
    return {
      ok: false,
      message: msg,
      pwmA: null,
      pwmB: null,
      diagnostics: {
        ...baseDiag,
        message: msg,
        rightMouthCornerFivebar: { ...baseDiag, message: msg },
      },
    }
  }

  const qRaw = [picked.qA_deg, picked.qB_deg]
  baseDiag.qRaw = { qA_deg: qRaw[0], qB_deg: qRaw[1] }

  const maxStepDeg = params.maxStepDeg ?? 2.0
  const filterAlpha = params.filterAlpha ?? 0.35
  const qCmd = servoOutputFilter(qRaw, state.qPrev, maxStepDeg, filterAlpha)
  state.qPrev[0] = qCmd[0]
  state.qPrev[1] = qCmd[1]

  baseDiag.qCmd = { qA_deg: qCmd[0], qB_deg: qCmd[1] }

  const logicalPwmA = angleToBindingLogicalPwm(qCmd[0], bindingA)
  const logicalPwmB = angleToBindingLogicalPwm(qCmd[1], bindingB)
  baseDiag.logicalPwmA = logicalPwmA
  baseDiag.logicalPwmB = logicalPwmB
  baseDiag.pwmA = logicalPwmA
  baseDiag.pwmB = logicalPwmB

  let message = msgExtra
  if (scale < 1 - 1e-9 && !message) {
    message = "D_target 超出可达区，已 clamp"
  }

  baseDiag.ok = true
  baseDiag.message = message
  state.lastOk = true
  state.lastDiagnostics = { ...baseDiag }

  const fullDiag = {
    ...baseDiag,
    ikOk: true,
    ikMessage: "",
    qA_deg: qCmd[0],
    qB_deg: qCmd[1],
    qRawA: qRaw[0],
    qRawB: qRaw[1],
    qCmdA: qCmd[0],
    qCmdB: qCmd[1],
    rightMouthCornerFivebar: {
      ...baseDiag,
      qRaw: baseDiag.qRaw,
      qCmd: baseDiag.qCmd,
    },
  }

  return {
    ok: true,
    message: "",
    pwmA: logicalPwmA,
    pwmB: logicalPwmB,
    diagnostics: fullDiag,
  }
}
