import { clampNumber } from "../../utils/clamp.js"
import { getServoConfig, logicalToActualPwm } from "../../core/servoConfig.js"
import {
  angleToBindingLogicalPwm,
  clampDToReachableArea,
  createRightMouthCornerFivebarState,
  MOUTH_CORNER_PAD_SPAN,
  padToMouthCornerDTarget,
  resolveMouthCornerPadFlipFlags,
  resolveMouthCornerPadRotateCcwDeg,
  rotatePadCcwAroundCenter,
  servoOutputFilter,
} from "./mouthCornerFivebar.js"
import {
  chooseNearestIkCandidate,
  fivebarFk,
  fivebarIkAllCandidates,
} from "./fiveBar2d.js"

/**
 * D → Pad（与 {@link padToMouthCornerDTarget} 互逆）。
 * @param {[number, number]} D
 * @param {[number, number]} D0
 * @param {object} params
 * @param {"left"|"right"|string} [sideId]
 */
export function dToPadPosition(D, D0, params, sideId = "right") {
  const cx = Number(params?.padXCenter ?? 50)
  const cy = Number(params?.padYCenter ?? 50)
  const Kx = Number(params?.Kx ?? 7)
  const Ky = Number(params?.Ky ?? 7)
  const xSign = Number(params?.xSign ?? 1)
  const ySign = Number(params?.ySign ?? 1)

  if (!D0 || !D || !Number.isFinite(D0[0]) || !Number.isFinite(D0[1]) || !Number.isFinite(D[0]) || !Number.isFinite(D[1])) {
    return { x: cx, y: cy, ok: false, message: "D 或 D0 无效" }
  }

  const denomX = xSign * Kx
  const denomY = ySign * Ky
  if (!Number.isFinite(denomX) || Math.abs(denomX) < 1e-12) {
    return { x: cx, y: cy, ok: false, message: "xSign*Kx 为 0，无法反算 padX" }
  }
  if (!Number.isFinite(denomY) || Math.abs(denomY) < 1e-12) {
    return { x: cx, y: cy, ok: false, message: "ySign*Ky 为 0，无法反算 padY" }
  }

  const dx = (D[0] - D0[0]) / denomX
  const dy = (D[1] - D0[1]) / denomY
  const effectivePadX = cx + (cx !== 0 ? dx * cx : 0)
  const effectivePadY = cy - (cy !== 0 ? dy * cy : 0)
  const { flipPadX, flipPadY } = resolveMouthCornerPadFlipFlags(params, sideId)
  const padRotateCcwDeg = resolveMouthCornerPadRotateCcwDeg(params, sideId)
  /* 逆变换：先撤销旋转，再撤销 flip */
  const unrotated = rotatePadCcwAroundCenter(effectivePadX, effectivePadY, -padRotateCcwDeg)
  const padX = flipPadX ? MOUTH_CORNER_PAD_SPAN - unrotated.x : unrotated.x
  const padY = flipPadY ? MOUTH_CORNER_PAD_SPAN - unrotated.y : unrotated.y
  return {
    x: clampNumber(padX, 0, 100),
    y: clampNumber(padY, 0, 100),
    effectivePadX: clampNumber(effectivePadX, 0, 100),
    effectivePadY: clampNumber(effectivePadY, 0, 100),
    flipPadX,
    flipPadY,
    padRotateCcwDeg,
    ok: true,
    message: "",
  }
}

function isDReachable(D, params) {
  return fivebarIkAllCandidates(D, params).length > 0
}

function padPointFromXY(x, y) {
  return { x: clampNumber(Number(x), 0, 100), y: clampNumber(Number(y), 0, 100) }
}

/**
 * @param {object} args
 * @param {{ x: number, y: number }} args.pad
 * @param {object} args.params
 * @param {ReturnType<typeof createRightMouthCornerFivebarState>} [args.state]
 * @param {object} [args.bindingA]
 * @param {object} [args.bindingB]
 * @param {number} [args.servoAId]
 * @param {number} [args.servoBId]
 * @param {object[]} [args.configs]
 * @param {"static-target"|"stateful-one-step"|"run-to-target"} [args.outputMode]
 */
export function evaluateRightMouthPadPoint({
  pad,
  params,
  state: stateIn,
  bindingA,
  bindingB,
  servoAId,
  servoBId,
  configs = [],
  outputMode = "static-target",
  sideId = "right",
}) {
  const st = stateIn || createRightMouthCornerFivebarState()
  const mode = outputMode || "static-target"
  const padRaw = padPointFromXY(pad?.x, pad?.y)

  const empty = {
    ok: false,
    padRaw,
    D0: null,
    DRaw: null,
    rawReachable: false,
    DSafe: null,
    padSafe: null,
    scale: 0,
    qRaw: null,
    qCmd: null,
    qSend: null,
    DCmd: null,
    padCmd: null,
    logicalPwmA: null,
    logicalPwmB: null,
    actualPwmA: null,
    actualPwmB: null,
    message: "",
  }

  const fk0 = fivebarFk(0, 0, params)
  if (!fk0.ok || !fk0.D) {
    return { ...empty, message: fk0.message || "FK(0,0) 失败" }
  }
  const D0 = [...fk0.D]

  const padFwd = padToMouthCornerDTarget(padRaw, D0, params, sideId)
  if (!padFwd.D_raw) {
    return { ...empty, D0, message: "Pad→DRaw 失败" }
  }
  const DRaw = [...padFwd.D_raw]
  const rawReachable = isDReachable(DRaw, params)

  const clamped = clampDToReachableArea(DRaw, D0, params)
  const DSafe = [...clamped.D_safe]
  const scale = clamped.scale
  let message = clamped.message || ""

  const padSafePt = dToPadPosition(DSafe, D0, params, sideId)
  const padSafe = padSafePt.ok ? { x: padSafePt.x, y: padSafePt.y } : null

  const candidates = fivebarIkAllCandidates(DSafe, params)
  if (candidates.length === 0) {
    return {
      ...empty,
      D0,
      DRaw,
      rawReachable,
      DSafe,
      padSafe,
      scale,
      message: message || "IK 无解（D_safe）",
    }
  }

  const picked = chooseNearestIkCandidate(candidates, {
    qA_deg: st.qPrev[0],
    qB_deg: st.qPrev[1],
  })
  if (!picked) {
    return {
      ...empty,
      D0,
      DRaw,
      rawReachable,
      DSafe,
      padSafe,
      scale,
      message: "IK 候选选择失败",
    }
  }

  const qRawArr = [picked.qA_deg, picked.qB_deg]
  const qRaw = { qA_deg: qRawArr[0], qB_deg: qRawArr[1] }

  const maxStepDeg = params.maxStepDeg ?? 2.0
  const filterAlpha = params.filterAlpha ?? 0.35
  const qCmdArr = servoOutputFilter(qRawArr, st.qPrev, maxStepDeg, filterAlpha)
  const qCmd = { qA_deg: qCmdArr[0], qB_deg: qCmdArr[1] }

  // static-target：PWM 用 qRaw，但 qPrev 必须记住上一帧分支，避免 A/B 在 IK 多解间跳变（表现为某一舵机卡顿）
  if (mode === "static-target") {
    st.qPrev[0] = qRawArr[0]
    st.qPrev[1] = qRawArr[1]
  } else {
    st.qPrev[0] = qCmdArr[0]
    st.qPrev[1] = qCmdArr[1]
  }

  const qSendArr = mode === "static-target" ? qRawArr : qCmdArr
  const qSend = { qA_deg: qSendArr[0], qB_deg: qSendArr[1] }

  const fkCmd = fivebarFk(qSendArr[0], qSendArr[1], params)
  let DCmd = null
  let padCmd = null
  if (fkCmd.ok && fkCmd.D) {
    DCmd = [...fkCmd.D]
    const padCmdPt = dToPadPosition(DCmd, D0, params, sideId)
    if (padCmdPt.ok) {
      padCmd = { x: padCmdPt.x, y: padCmdPt.y }
    }
  }

  let logicalPwmA = null
  let logicalPwmB = null
  let actualPwmA = null
  let actualPwmB = null
  if (bindingA && bindingB) {
    logicalPwmA = angleToBindingLogicalPwm(qSend.qA_deg, bindingA)
    logicalPwmB = angleToBindingLogicalPwm(qSend.qB_deg, bindingB)
    const cfgList = Array.isArray(configs) ? configs : []
    if (Number.isFinite(servoAId)) {
      const rA = logicalToActualPwm(logicalPwmA, getServoConfig(cfgList, servoAId))
      actualPwmA = rA.actualPwm
    }
    if (Number.isFinite(servoBId)) {
      const rB = logicalToActualPwm(logicalPwmB, getServoConfig(cfgList, servoBId))
      actualPwmB = rB.actualPwm
    }
  }

  if (scale < 1 - 1e-9 && !message) {
    message = "D_target 超出可达区，已 clamp"
  }

  return {
    ok: true,
    padRaw,
    D0,
    DRaw,
    rawReachable,
    DSafe,
    padSafe,
    scale,
    qRaw,
    qCmd,
    qSend,
    DCmd,
    padCmd,
    logicalPwmA,
    logicalPwmB,
    actualPwmA,
    actualPwmB,
    message,
  }
}

/**
 * @param {{ params: object, step?: number }} args
 */
export function buildRightMouthPadReachabilityMap({ params, step = 2, sideId = "right" } = {}) {
  const st = Math.max(1, Math.round(Number(step) || 2))
  const fk0 = fivebarFk(0, 0, params)
  if (!fk0.ok || !fk0.D) {
    return {
      points: [],
      validCount: 0,
      invalidCount: 0,
      message: fk0.message || "FK(0,0) 失败",
    }
  }
  const D0 = fk0.D
  const points = []
  let validCount = 0
  let invalidCount = 0

  for (let padY = 0; padY <= 100; padY += st) {
    for (let padX = 0; padX <= 100; padX += st) {
      const pad = { x: padX, y: padY }
      const fwd = padToMouthCornerDTarget(pad, D0, params, sideId)
      if (!fwd.D_raw) {
        invalidCount += 1
        points.push({
          padX,
          padY,
          rawReachable: false,
          scale: 0,
          padSafeX: padX,
          padSafeY: padY,
        })
        continue
      }
      const DRaw = fwd.D_raw
      const rawReachable = isDReachable(DRaw, params)
      const clamped = clampDToReachableArea(DRaw, D0, params)
      const scale = clamped.scale
      const safePt = dToPadPosition(clamped.D_safe, D0, params, sideId)
      const padSafeX = safePt.ok ? safePt.x : padX
      const padSafeY = safePt.ok ? safePt.y : padY
      if (rawReachable) {
        validCount += 1
      } else {
        invalidCount += 1
      }
      points.push({
        padX,
        padY,
        rawReachable,
        scale,
        padSafeX,
        padSafeY,
      })
    }
  }

  return { points, validCount, invalidCount, message: "" }
}

/**
 * @param {{ params: object, qStep?: number }} args
 */
export function buildRightMouthFkProjectionMap({ params, qStep = 2, sideId = "right" } = {}) {
  const step = Math.max(1, Math.round(Number(qStep) || 2))
  const qMinA = Number(params.qAMinDeg ?? -90)
  const qMaxA = Number(params.qAMaxDeg ?? 90)
  const qMinB = Number(params.qBMinDeg ?? -90)
  const qMaxB = Number(params.qBMaxDeg ?? 90)

  const fk0 = fivebarFk(0, 0, params)
  const D0 = fk0.ok && fk0.D ? fk0.D : null

  const fkPadPoints = []
  const fkInsidePadPoints = []
  let fkSuccessCount = 0
  let fkFailCount = 0

  for (let qA = qMinA; qA <= qMaxA; qA += step) {
    for (let qB = qMinB; qB <= qMaxB; qB += step) {
      const fk = fivebarFk(qA, qB, params)
      if (!fk.ok || !fk.D) {
        fkFailCount += 1
        continue
      }
      fkSuccessCount += 1
      const D = fk.D
      let padX = null
      let padY = null
      let inside = false
      if (D0) {
        const pt = dToPadPosition(D, D0, params, sideId)
        if (pt.ok) {
          padX = pt.x
          padY = pt.y
          inside = padX >= 0 && padX <= 100 && padY >= 0 && padY <= 100
        }
      }
      const entry = { qA_deg: qA, qB_deg: qB, D: [...D], padX, padY, inside }
      fkPadPoints.push(entry)
      if (inside) {
        fkInsidePadPoints.push(entry)
      }
    }
  }

  return {
    fkPadPoints,
    fkInsidePadPoints,
    fkSuccessCount,
    fkFailCount,
  }
}

/** 用于缓存可达图：仅 Kx/Ky/符号/几何变化时重算 */
export function rightMouthPadReachabilityParamsKey(params) {
  if (!params || typeof params !== "object") {
    return ""
  }
  const pick = [
    "Kx",
    "Ky",
    "xSign",
    "ySign",
    "padXCenter",
    "padYCenter",
    "L_AE",
    "L_BC",
    "L_ED",
    "L_CD",
    "thetaA0Deg",
    "thetaB0Deg",
    "dirA",
    "dirB",
    "fkDBranch",
    "qAMinDeg",
    "qAMaxDeg",
    "qBMinDeg",
    "qBMaxDeg",
  ]
  const o = {}
  for (const k of pick) {
    if (params[k] !== undefined) {
      o[k] = params[k]
    }
  }
  return JSON.stringify(o)
}

/** 左右嘴角 FiveBar 通用 Pad 解算（params 由 resolveMouthCornerKinematics / Lab 注入）。 */
export function evaluateMouthFiveBarPadPoint(args) {
  return evaluateRightMouthPadPoint(args)
}
