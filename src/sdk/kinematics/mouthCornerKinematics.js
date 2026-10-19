import { CHANNEL_X, CHANNEL_Y } from "../../core/faceRigProfile.js"
import {
  SERVO_LOGICAL_MIN_PWM,
  SERVO_LOGICAL_MAX_PWM,
  STANDARD_CENTER_PWM,
  getServoConfig,
  logicalToActualPwm,
} from "../../core/servoConfig.js"
import { clampNumber } from "../../utils/clamp.js"
import {
  createRightMouthCornerFivebarState,
  resolveRightMouthCornerFivebar,
  angleToBindingLogicalPwm,
  applyMouthCornerPadFlip,
  getDefaultMouthCornerPadFlip,
  resolveMouthCornerPadFlipFlags,
  resolveMouthCornerPadRotateCcwDeg,
} from "./mouthCornerFivebar.js"
import { getDefaultRightMouthRuntimeParams } from "./rightMouthFiveBarRuntime.js"
import { getMouthCornerLabSide } from "./mouthCornerFiveBarLabConfig.js"
import { getMouthCornerFrozenRuntimeDefaults } from "./mouthCornerFrozenConfig.js"

/** 可在后续接入 UI / 全局配置；控件层 / Tracking / Keyframe 与 mapFaceRigToPose 共用 */
const DEFAULT_MOUTH_FIVEBAR_SLICE = {
  enabled: true,
  runtimeOutputMode: /** @type {"static-target" | "stateful-one-step" | "run-to-target"} */ (
    "static-target"
  ),
  Kx: 7,
  Ky: 7,
  padXCenter: 50,
  padYCenter: 50,
  maxStepDeg: 2.0,
  filterAlpha: 0.35,
}

export const DEFAULT_FACE_RIG_KINEMATICS = {
  rightMouthCornerFiveBar: {
    ...DEFAULT_MOUTH_FIVEBAR_SLICE,
    ...getMouthCornerFrozenRuntimeDefaults("right"),
  },
  leftMouthCornerFiveBar: {
    ...DEFAULT_MOUTH_FIVEBAR_SLICE,
    ...getMouthCornerFrozenRuntimeDefaults("left"),
  },
}

function getDefaultRuntimeParamsForSide(sideId = "right") {
  const defaults = getDefaultRightMouthRuntimeParams()
  const frozen = getMouthCornerFrozenRuntimeDefaults(sideId)
  return {
    ...defaults,
    ...frozen,
    flipPadX: frozen.flipPadX,
    flipPadY: frozen.flipPadY,
  }
}

/**
 * @param {object} [rig]
 * @returns {boolean}
 */
function isRigValuesShapeForSide(rig, rigValuesKey) {
  return Boolean(rig && typeof rig === "object" && rig[rigValuesKey] && typeof rig[rigValuesKey] === "object")
}

/**
 * @param {object} rig
 * @param {import("./mouthCornerFiveBarLabConfig.js").MouthCornerLabSideId | string} [sideId]
 */
export function rigValuesForMouthCorner(rig, sideId = "right") {
  const side = getMouthCornerLabSide(sideId)
  if (!rig || typeof rig !== "object") {
    return { x: 50, y: 50 }
  }
  if (isRigValuesShapeForSide(rig, side.rigValuesKey)) {
    const rv = rig[side.rigValuesKey]
    const x = Number(rv.x)
    const y = Number(rv.y)
    return {
      x: Number.isFinite(x) ? x : 50,
      y: Number.isFinite(y) ? y : 50,
    }
  }
  const mouthSide = rig.mouth?.[side.rigSideKey]
  const x = Number(mouthSide?.x)
  const y = Number(mouthSide?.y)
  return {
    x: Number.isFinite(x) ? x : 50,
    y: Number.isFinite(y) ? y : 50,
  }
}

/** @param {object} rig */
export function rigValuesForRightMouthCorner(rig) {
  return rigValuesForMouthCorner(rig, "right")
}

/** @param {object} rig */
export function rigValuesForLeftMouthCorner(rig) {
  return rigValuesForMouthCorner(rig, "left")
}

/** @param {object} [userKinematics] mapFaceRigToPose(..., { kinematics }) 可为嵌套或扁平静态覆盖 */
function sliceMouthFiveBarKinematics(userKinematics, sideId = "right") {
  if (!userKinematics || typeof userKinematics !== "object") {
    return {}
  }
  const key = sideId === "left" ? "leftMouthCornerFiveBar" : "rightMouthCornerFiveBar"
  const inner = userKinematics[key]
  if (inner && typeof inner === "object") {
    return inner
  }
  if (userKinematics.leftMouthCornerFiveBar || userKinematics.rightMouthCornerFiveBar) {
    return {}
  }
  return userKinematics
}

function applyRuntimeAngleMod(qDeg, sign, gain) {
  return Number(qDeg) * Number(sign ?? 1) * Number(gain ?? 1)
}

/**
 * runtimeParams 优先级最高，其次 userKinematics，最后 runtime 模块默认。
 * @param {object} [runtimeParams]
 * @param {object} [userKinematics]
 */
export function mergeFiveBarRuntimeParams(runtimeParams, userKinematics, sideId = "right") {
  const side = sideId === "left" ? "left" : "right"
  const sidePrefix = side === "left" ? "leftMouthCorner" : "rightMouthCorner"
  const defaults = getDefaultRuntimeParamsForSide(side)
  const u = sliceMouthFiveBarKinematics(userKinematics, sideId)
  const r = runtimeParams && typeof runtimeParams === "object" ? runtimeParams : {}
  const sideBlock =
    r[side] && typeof r[side] === "object"
      ? r[side]
      : u[side] && typeof u[side] === "object"
        ? u[side]
        : null
  const merged = {
    ...defaults,
    ...u,
    ...r,
    Kx: r.Kx ?? u.Kx ?? defaults.Kx,
    Ky: r.Ky ?? u.Ky ?? defaults.Ky,
    xSign: r.xSign ?? u.xSign ?? defaults.xSign,
    ySign: r.ySign ?? u.ySign ?? defaults.ySign,
    padXCenter: r.padXCenter ?? u.padXCenter ?? defaults.padXCenter,
    padYCenter: r.padYCenter ?? u.padYCenter ?? defaults.padYCenter,
    maxStepDeg: r.maxStepDeg ?? u.maxStepDeg ?? defaults.maxStepDeg,
    filterAlpha: r.filterAlpha ?? u.filterAlpha ?? defaults.filterAlpha,
    qSignA: r.qSignA ?? u.qSignA ?? defaults.qSignA,
    qSignB: r.qSignB ?? u.qSignB ?? defaults.qSignB,
    qGainA: r.qGainA ?? u.qGainA ?? defaults.qGainA,
    qGainB: r.qGainB ?? u.qGainB ?? defaults.qGainB,
    servoSwap: r.servoSwap ?? u.servoSwap ?? defaults.servoSwap,
    neutralPwmA: r.neutralPwmA ?? u.neutralPwmA ?? defaults.neutralPwmA,
    neutralPwmB: r.neutralPwmB ?? u.neutralPwmB ?? defaults.neutralPwmB,
    padRotateCcwDeg: r.padRotateCcwDeg ?? u.padRotateCcwDeg ?? defaults.padRotateCcwDeg ?? 0,
  }
  const flip = resolveMouthCornerPadFlipFlags(merged, side)
  merged.flipPadX = flip.flipPadX
  merged.flipPadY = flip.flipPadY
  merged[`${sidePrefix}PadFlipX`] = flip.flipPadX
  merged[`${sidePrefix}PadFlipY`] = flip.flipPadY
  const rot = resolveMouthCornerPadRotateCcwDeg(merged, side)
  merged.padRotateCcwDeg = rot
  merged[`${sidePrefix}PadRotateCcwDeg`] = rot
  return merged
}

/** 唇瓣单 DOF 控件：与五杆 A/B 舵机互斥时，优先保留唇瓣线性绑定 */
const LIP_MOUTH_CONTROL_IDS = new Set(["mouth_ul", "mouth_ur", "mouth_ll", "mouth_lr"])

/**
 * 收集指定控件占用的舵机 id（用于五杆冲突检测）。
 * @param {object} profile
 * @param {Set<string> | string[]} controlIds
 */
export function collectServoIdsByControlIds(profile, controlIds) {
  const want = controlIds instanceof Set ? controlIds : new Set(controlIds)
  const ids = new Set()
  for (const b of profile?.bindings || []) {
    if (!b || b.enabled === false) {
      continue
    }
    if (!want.has(b.controlId)) {
      continue
    }
    const sid = Number(b.servoId)
    if (Number.isFinite(sid)) {
      ids.add(sid)
    }
  }
  return ids
}

function profileCornerServoIds(profile, controlId) {
  let servoAId = null
  let servoBId = null
  for (const b of profile?.bindings || []) {
    if (!b || b.enabled === false || b.controlId !== controlId) {
      continue
    }
    if (b.channel === CHANNEL_X) {
      servoAId = Number(b.servoId)
    }
    if (b.channel === CHANNEL_Y) {
      servoBId = Number(b.servoId)
    }
  }
  return {
    servoAId: Number.isFinite(servoAId) ? servoAId : null,
    servoBId: Number.isFinite(servoBId) ? servoBId : null,
  }
}

/**
 * 舵机若被唇瓣 / 非嘴角控件占用，则不得被五杆 IK 覆盖。
 * Lab 样机默认嘴角号（右 7/8、左 16/17）仅在「未被其它控件占用」时允许五杆使用；
 * 若 live profile 已把 7/8 分给眼球/唇瓣等，不得再抢占（否则右唇不受控、嘴角带动眼球）。
 * @param {object} profile
 * @param {ReturnType<typeof getMouthCornerLabSide>} side
 * @param {number} servoId
 */
export function servoBlockedForMouthFiveBar(profile, side, servoId) {
  if (!Number.isFinite(servoId)) {
    return true
  }
  const lipServos = collectServoIdsByControlIds(profile, LIP_MOUTH_CONTROL_IDS)
  if (lipServos.has(servoId)) {
    return true
  }
  for (const b of profile?.bindings || []) {
    if (!b || b.enabled === false) {
      continue
    }
    if (b.controlId === side.controlId) {
      continue
    }
    if (Number(b.servoId) === servoId) {
      return true
    }
  }
  return false
}

function findCornerBinding(profile, controlId, channel) {
  return (
    (profile?.bindings || []).find(
      (b) =>
        b?.controlId === controlId &&
        b.channel === channel &&
        b.enabled !== false
    ) || null
  )
}

function findBindingByServoId(profile, servoId) {
  const sid = Number(servoId)
  if (!Number.isFinite(sid)) {
    return null
  }
  return (
    (profile?.bindings || []).find(
      (b) => b?.enabled !== false && Number(b.servoId) === sid
    ) || null
  )
}

/**
 * baseline 只覆盖 bindingId 等元数据；舵机号与行程以 live profile 为准。
 * 若 live profile 已无该嘴角绑定，不得用 baseline 伪造绑定。
 * 不得用旧 Lab 基线（如 7/8）覆盖用户已配置的嘴角舵机号（如 9/10）。
 */
function mouthCornerBindingFromProfileOverride(profile, controlId, channel, overrideEntry) {
  const fromProfile = findCornerBinding(profile, controlId, channel)
  if (!fromProfile) {
    return null
  }
  if (!overrideEntry || typeof overrideEntry !== "object") {
    return fromProfile
  }
  return {
    ...fromProfile,
    controlId,
    channel,
    servoId: fromProfile.servoId,
    bindingId: overrideEntry.bindingId ?? fromProfile.bindingId,
    neutralPwm: fromProfile.neutralPwm,
    positiveTargetPwm: fromProfile.positiveTargetPwm,
    negativeTargetPwm: fromProfile.negativeTargetPwm,
    pwmPerUnit: fromProfile.pwmPerUnit,
    invert: fromProfile.invert,
    weight: fromProfile.weight,
    curve: fromProfile.curve,
    rangeMode: fromProfile.rangeMode,
  }
}

function resolveLabAxisNeutralPwm(value, sideDefault) {
  const pick = (raw) => {
    if (raw == null || raw === "") return null
    const n = Number(raw)
    /* Number(null)===0 不能当中位；合法 logical PWM 在舵机行程内 */
    if (!Number.isFinite(n) || n < SERVO_LOGICAL_MIN_PWM || n > SERVO_LOGICAL_MAX_PWM) {
      return null
    }
    return Math.round(n)
  }
  return pick(value) ?? pick(sideDefault)
}

/**
 * 五杆中位优先级：profile 已标定（≠1500）> Lab 校准 > 侧别默认。
 * Lab neutralPwmA/B 按 labHwServoA/B（如右 7/8、左 16/17）写入，不受 servoSwap 错位。
 * 侧别默认 / Lab 为 null 时不得写成 0。
 */
function applyMouthCornerBindingNeutralOverrides(bindingA, bindingB, params, side) {
  const applyForHw = (binding, hwServoId, paramKey) => {
    if (!binding || Number(binding.servoId) !== Number(hwServoId)) {
      return binding
    }
    const profileN = Number(binding.neutralPwm)
    if (
      Number.isFinite(profileN) &&
      profileN !== STANDARD_CENTER_PWM &&
      profileN >= SERVO_LOGICAL_MIN_PWM &&
      profileN <= SERVO_LOGICAL_MAX_PWM
    ) {
      return binding
    }
    const labN = resolveLabAxisNeutralPwm(params?.[paramKey], null)
    if (labN != null && labN !== STANDARD_CENTER_PWM) {
      return { ...binding, neutralPwm: labN }
    }
    const defN = resolveLabAxisNeutralPwm(side.defaultCalibration[paramKey], null)
    if (defN != null) {
      return { ...binding, neutralPwm: defN }
    }
    /* 左嘴无硬编码中位时，保留 profile 1500，禁止落到 0 */
    if (Number.isFinite(profileN) && profileN >= SERVO_LOGICAL_MIN_PWM && profileN <= SERVO_LOGICAL_MAX_PWM) {
      return binding
    }
    return { ...binding, neutralPwm: STANDARD_CENTER_PWM }
  }

  return {
    bindingA: applyForHw(bindingA, side.labHwServoA, "neutralPwmA"),
    bindingB: applyForHw(bindingB, side.labHwServoB, "neutralPwmB"),
  }
}

/**
 * 嘴角五杆启用时，「设为中位」应取 IK 下发 logicalPwm（servo 7/8），而非线性 binding contribution。
 * @param {object} binding
 * @param {object} [kinematics]
 */
export function resolveMouthCornerNeutralCapture(binding, kinematics) {
  if (!binding) {
    return null
  }
  const sideId =
    binding.controlId === "mouth_corner_l"
      ? "left"
      : binding.controlId === "mouth_corner_r"
        ? "right"
        : null
  if (!sideId) {
    return null
  }
  if (binding.channel !== CHANNEL_X && binding.channel !== CHANNEL_Y) {
    return null
  }

  const kin =
    sideId === "left"
      ? kinematics?.leftMouthCornerFivebar ??
        kinematics?.leftMouthCorner ??
        kinematics?.leftMouthFiveBar
      : kinematics?.rightMouthCornerFivebar ??
        kinematics?.rightMouthCorner ??
        kinematics?.rightMouthFiveBar

  if (!kin || kin.readyForIk === false) {
    return null
  }

  const isX = binding.channel === CHANNEL_X
  const pwm = Number(isX ? (kin.logicalPwmA ?? kin.pwmA) : (kin.logicalPwmB ?? kin.pwmB))
  const hwServoId = Number(isX ? kin.servoAId : kin.servoBId)
  if (!Number.isFinite(pwm) || !Number.isFinite(hwServoId)) {
    return null
  }

  return {
    sideId,
    controlId: binding.controlId,
    channel: binding.channel,
    labParam: isX ? "neutralPwmA" : "neutralPwmB",
    pwm: Math.round(pwm),
    hwServoId,
  }
}

/**
 * profile 默认嘴角 bus 号（legacy route 迁移后）与样机五杆硬件不一致时才回退 labHw。
 * 右：默认 21/22 → Lab 7/8。
 * 左：默认 19/20 → Lab 16/17；若 profile/baseline 已是有效异号对（如 16/17），不得强改。
 */
const STALE_DEFAULT_MOUTH_BUS_PAIRS = Object.freeze({
  right: Object.freeze([Object.freeze([21, 22])]),
  left: Object.freeze([Object.freeze([19, 20])]),
})

function toMouthServoId(value) {
  if (value == null || value === "") return NaN
  const n = Number(value)
  /* bus actuator 从 1 起；Number(null)===0 不能当成有效舵机号 */
  return Number.isFinite(n) && n > 0 ? n : NaN
}

function isStaleDefaultMouthBusPair(sideId, servoAId, servoBId) {
  const pairs = STALE_DEFAULT_MOUTH_BUS_PAIRS[sideId] || []
  const a = toMouthServoId(servoAId)
  const b = toMouthServoId(servoBId)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  return pairs.some(
    ([x, y]) => (a === x && b === y) || (a === y && b === x)
  )
}

/**
 * profile / baseline 若 X/Y 落到同一舵机、无效，或仍是「默认 profile 嘴角号」时，
 * 回退到 labHwServoA/B；已配置的有效硬件对（如左 16/17）原样保留。
 */
function applyMouthCornerLabHwServoFallback(
  profile,
  side,
  servoAId,
  servoBId,
  bindingA,
  bindingB
) {
  const labA = side.labHwServoA
  const labB = side.labHwServoB
  if (!Number.isFinite(labA) || !Number.isFinite(labB) || labA === labB) {
    return { servoAId, servoBId, bindingA, bindingB }
  }

  let outA = toMouthServoId(servoAId)
  let outB = toMouthServoId(servoBId)
  let bindA = bindingA
  let bindB = bindingB

  const finitePair = Number.isFinite(outA) && Number.isFinite(outB)
  const sameId = finitePair && outA === outB
  const staleDefault = finitePair && isStaleDefaultMouthBusPair(side.id, outA, outB)
  if (sameId || !finitePair || staleDefault) {
    const labFree =
      !servoBlockedForMouthFiveBar(profile, side, labA) &&
      !servoBlockedForMouthFiveBar(profile, side, labB)
    if (labFree) {
      outA = labA
      outB = labB
      bindA = null
      bindB = null
    }
  }

  const resolveBindingForServo = (sid, channel, fallback) => {
    if (!Number.isFinite(sid)) {
      return fallback
    }
    /* 优先嘴角控件自身 binding（改写舵机号），避免误用同号的 jaw/唇瓣行程与中位 */
    if (fallback && Number(fallback.servoId) === sid && fallback.controlId === side.controlId) {
      return fallback
    }
    const corner = findCornerBinding(profile, side.controlId, channel)
    if (corner) {
      return { ...corner, servoId: sid }
    }
    if (fallback && fallback.controlId === side.controlId) {
      return { ...fallback, servoId: sid }
    }
    const byServo = findBindingByServoId(profile, sid)
    if (byServo && byServo.controlId === side.controlId) {
      return { ...byServo, channel, servoId: sid }
    }
    return fallback ? { ...fallback, servoId: sid } : null
  }

  if (!Number.isFinite(outA)) {
    outA = labA
  }
  if (!Number.isFinite(outB)) {
    outB = labB
  }

  bindA = resolveBindingForServo(outA, CHANNEL_X, bindA)
  bindB = resolveBindingForServo(outB, CHANNEL_Y, bindB)

  return { servoAId: outA, servoBId: outB, bindingA: bindA, bindingB: bindB }
}

function enrichPadOffsetDiagnostics(d, sideR, params, sideId = "right") {
  const cx = Number(params.padXCenter ?? 50)
  const cy = Number(params.padYCenter ?? 50)
  const padFlip = applyMouthCornerPadFlip(sideR, params, sideId)
  const u = cx !== 0 ? (padFlip.effectivePadX - cx) / cx : 0
  const v = cy !== 0 ? (cy - padFlip.effectivePadY) / cy : 0
  const xSign = Number(params.xSign ?? 1)
  const ySign = Number(params.ySign ?? 1)
  const Kx = Number(params.Kx ?? 1)
  const Ky = Number(params.Ky ?? 1)
  const expectedDOffset = [xSign * Kx * u, ySign * Ky * v]
  let actualDOffset = [null, null]
  const D0 = d.D0
  const D_raw = d.D_raw
  if (Array.isArray(D0) && Array.isArray(D_raw) && D0.length >= 2 && D_raw.length >= 2) {
    actualDOffset = [D_raw[0] - D0[0], D_raw[1] - D0[1]]
  }
  const offsetError = [
    actualDOffset[0] != null ? actualDOffset[0] - expectedDOffset[0] : null,
    actualDOffset[1] != null ? actualDOffset[1] - expectedDOffset[1] : null,
  ]
  return {
    u,
    v,
    rawPadX: padFlip.rawPadX,
    rawPadY: padFlip.rawPadY,
    effectivePadX: padFlip.effectivePadX,
    effectivePadY: padFlip.effectivePadY,
    flipPadX: padFlip.flipPadX,
    flipPadY: padFlip.flipPadY,
    expectedDOffset,
    actualDOffset,
    offsetError,
  }
}

function attachEffectiveRuntimeDiagnostics(
  d,
  params,
  runtimeSource,
  diagnosticsSource = "rightMouthFiveBar",
  sideId = "right"
) {
  d.source = diagnosticsSource
  d.runtimeSource = runtimeSource || "default"
  d.effectiveKx = params.Kx
  d.effectiveKy = params.Ky
  d.effectiveXSign = params.xSign
  d.effectiveYSign = params.ySign
  d.effectiveQSignA = params.qSignA
  d.effectiveQSignB = params.qSignB
  d.effectiveQGainA = params.qGainA
  d.effectiveQGainB = params.qGainB
  d.effectiveServoSwap = Boolean(params.servoSwap)
  const flip = resolveMouthCornerPadFlipFlags(params, sideId)
  d.effectiveFlipPadX = flip.flipPadX
  d.effectiveFlipPadY = flip.flipPadY
  d.effectivePadRotateCcwDeg = resolveMouthCornerPadRotateCcwDeg(params, sideId)
  d.effectiveNeutralPwmA = params.neutralPwmA ?? null
  d.effectiveNeutralPwmB = params.neutralPwmB ?? null
}

/**
 * @param {object} profile
 * @param {object} [options]
 * @param {object} [options.runtimeParams] getRightMouthFiveBarRuntime().params（最高优先级）
 * @param {object} [options.runtimeBindingOverride] baseline profileBindings / servoA/B
 * @param {object} [options.kinematics] mapFaceRigToPose kinematics 包装
 * @param {string} [options.runtimeSource] "runtimeBaseline" | "default"
 * @returns {{
 *   enabled: boolean,
 *   readyForIk: boolean,
 *   servoAId: number|null,
 *   servoBId: number|null,
 *   bindingA: object|null,
 *   bindingB: object|null,
 *   params: object,
 *   runtimeOutputMode: "static-target"|"stateful-one-step"|"run-to-target",
 *   skipReason?: string
 * }}
 */
/**
 * @param {object} profile
 * @param {import("./mouthCornerFiveBarLabConfig.js").MouthCornerLabSideId | string} sideId
 * @param {object} [options]
 */
export function resolveMouthCornerKinematics(profile, sideId = "right", options = null) {
  const side = getMouthCornerLabSide(sideId)
  const opts = options && typeof options === "object" ? options : {}
  const userKinematics = opts.kinematics ?? (options && !opts.runtimeParams && !opts.runtimeBindingOverride ? options : null)
  const u = sliceMouthFiveBarKinematics(userKinematics, sideId)
  const defaultKey = sideId === "left" ? "leftMouthCornerFiveBar" : "rightMouthCornerFiveBar"
  const d = DEFAULT_FACE_RIG_KINEMATICS[defaultKey] || DEFAULT_FACE_RIG_KINEMATICS.rightMouthCornerFiveBar || {}
  const enabled = u.enabled !== false && d.enabled !== false

  const runtimeOutputMode =
    u.runtimeOutputMode ?? d.runtimeOutputMode ?? /** @type {const} */ ("static-target")

  const params = mergeFiveBarRuntimeParams(opts.runtimeParams, userKinematics, sideId)

  const bindOv = opts.runtimeBindingOverride
  const pb = bindOv?.profileBindings || {}
  const bindKeyX = `${side.profileBindingPrefix}_x`
  const bindKeyY = `${side.profileBindingPrefix}_y`

  let bindingA = mouthCornerBindingFromProfileOverride(profile, side.controlId, CHANNEL_X, pb[bindKeyX])
  let bindingB = mouthCornerBindingFromProfileOverride(profile, side.controlId, CHANNEL_Y, pb[bindKeyY])

  if (!bindingA || !bindingB) {
    for (const b of profile?.bindings || []) {
      if (!b || b.enabled === false || b.controlId !== side.controlId) {
        continue
      }
      if (b.channel === CHANNEL_X && !bindingA) {
        bindingA = b
      }
      if (b.channel === CHANNEL_Y && !bindingB) {
        bindingB = b
      }
    }
  }

  const profileCornersEarly = profileCornerServoIds(profile, side.controlId)
  const profilePairValid =
    Number.isFinite(profileCornersEarly.servoAId) &&
    Number.isFinite(profileCornersEarly.servoBId) &&
    profileCornersEarly.servoAId !== profileCornersEarly.servoBId &&
    !isStaleDefaultMouthBusPair(side.id, profileCornersEarly.servoAId, profileCornersEarly.servoBId)

  /* 用户已配置有效嘴角舵机对时，禁止旧 baseline 的 labHw 7/8 覆盖 */
  let servoAId = bindingA ? Number(bindingA.servoId) : null
  let servoBId = bindingB ? Number(bindingB.servoId) : null
  if (!profilePairValid) {
    if (bindOv?.servoAId != null) servoAId = Number(bindOv.servoAId)
    if (bindOv?.servoBId != null) servoBId = Number(bindOv.servoBId)
  }

  if (params.servoSwap) {
    const tmpB = bindingB
    const tmpS = servoBId
    bindingB = bindingA
    servoBId = servoAId
    bindingA = tmpB
    servoAId = tmpS
  }

  const profileCorners = profileCornerServoIds(profile, side.controlId)
  const fiveBarConflicts = []

  function reconcileFiveBarServo(candidateId, profileCornerId, axisLabel, bindingRef) {
    if (!Number.isFinite(candidateId)) {
      return { servoId: profileCornerId, binding: bindingRef }
    }
    if (!servoBlockedForMouthFiveBar(profile, side, candidateId)) {
      return { servoId: candidateId, binding: bindingRef }
    }
    const blockedControls = (profile?.bindings || [])
      .filter(
        (b) =>
          b?.enabled !== false &&
          Number(b.servoId) === candidateId &&
          b.controlId !== side.controlId
      )
      .map((b) => `${b.controlId}.${b.channel}`)
    fiveBarConflicts.push({
      axis: axisLabel,
      blockedServoId: candidateId,
      blockedBy: blockedControls,
      fallbackServoId: profileCornerId,
    })
    if (
      Number.isFinite(profileCornerId) &&
      !servoBlockedForMouthFiveBar(profile, side, profileCornerId)
    ) {
      const ch = axisLabel === "A" ? CHANNEL_X : CHANNEL_Y
      const profileBinding = findCornerBinding(profile, side.controlId, ch)
      return { servoId: profileCornerId, binding: profileBinding || bindingRef }
    }
    return { servoId: null, binding: null }
  }

  const recA = reconcileFiveBarServo(servoAId, profileCorners.servoAId, "A", bindingA)
  const recB = reconcileFiveBarServo(servoBId, profileCorners.servoBId, "B", bindingB)
  servoAId = recA.servoId
  servoBId = recB.servoId
  bindingA = recA.binding
  bindingB = recB.binding

  const labHw = applyMouthCornerLabHwServoFallback(
    profile,
    side,
    servoAId,
    servoBId,
    bindingA,
    bindingB
  )
  servoAId = labHw.servoAId
  servoBId = labHw.servoBId
  bindingA = labHw.bindingA
  bindingB = labHw.bindingB

  const neutralOv = applyMouthCornerBindingNeutralOverrides(bindingA, bindingB, params, side)
  bindingA = neutralOv.bindingA
  bindingB = neutralOv.bindingB

  const hasA = Number.isFinite(servoAId) && bindingA
  const hasB = Number.isFinite(servoBId) && bindingB
  const readyForIk = Boolean(enabled && hasA && hasB)

  let skipReason
  if (enabled && !readyForIk) {
    skipReason = `已启用${side.label}五杆，但未找到已启用的 ${side.controlId}.x / ${side.controlId}.y 绑定（或舵机 id 无效）`
  } else if (fiveBarConflicts.length) {
    skipReason = ""
  }

  return {
    enabled,
    readyForIk,
    servoAId: hasA ? servoAId : null,
    servoBId: hasB ? servoBId : null,
    bindingA,
    bindingB,
    params,
    runtimeOutputMode,
    runtimeSource: opts.runtimeSource || "default",
    diagnosticsSource: side.diagnosticsSource,
    sideId: side.id,
    skipReason,
    fiveBarConflicts,
  }
}

export function resolveRightMouthCornerKinematics(profile, options = null) {
  return resolveMouthCornerKinematics(profile, "right", options)
}

export function resolveLeftMouthCornerKinematics(profile, options = null) {
  return resolveMouthCornerKinematics(profile, "left", options)
}

/**
 * @param {number} qDeg
 * @param {number} neutralPwm
 * @param {number} pwmPerDeg
 * @deprecated 请使用 {@link angleToBindingLogicalPwm} 与 profile 绑定目标
 */
export function angleDegToLogicalPwm(qDeg, neutralPwm, pwmPerDeg) {
  const n = Number(neutralPwm)
  const neutral = Number.isFinite(n) ? n : STANDARD_CENTER_PWM
  const logicalPwm = neutral + Number(qDeg) * Number(pwmPerDeg)
  return clampNumber(
    Math.round(logicalPwm),
    SERVO_LOGICAL_MIN_PWM,
    SERVO_LOGICAL_MAX_PWM
  )
}

/**
 * @param {object} rigValues
 * @param {ReturnType<typeof resolveRightMouthCornerKinematics>} resolved
 * @param {ReturnType<typeof createRightMouthCornerFivebarState>} [state]
 */
export function computeMouthCornerFiveBarIk(rigValues, resolved, state, sideId = "right") {
  const pad = rigValuesForMouthCorner(rigValues, sideId)
  const {
    params,
    bindingA,
    bindingB,
    servoAId,
    servoBId,
    runtimeOutputMode = "static-target",
    runtimeSource = "default",
    diagnosticsSource = "rightMouthFiveBar",
  } = resolved

  const mode = runtimeOutputMode || "static-target"
  const st = state || createRightMouthCornerFivebarState()

  const result = resolveRightMouthCornerFivebar({
    resolved: { bindingA, bindingB, servoAId, servoBId },
    sideR: pad,
    params,
    state: st,
    sideId,
  })

  if (mode === "static-target") {
    const qr = result.diagnostics?.qRaw
    if (qr && Number.isFinite(Number(qr.qA_deg)) && Number.isFinite(Number(qr.qB_deg))) {
      st.qPrev[0] = Number(qr.qA_deg)
      st.qPrev[1] = Number(qr.qB_deg)
    }
  }

  const d = { ...result.diagnostics }
  Object.assign(d, enrichPadOffsetDiagnostics(d, pad, params, sideId))
  d.enabled = true
  const side = getMouthCornerLabSide(sideId)
  d.overrideNote = `${side.controlId} 使用 fivebar IK 覆盖线性绑定`
  d.ikOk = result.ok
  d.ikMessage = result.ok ? "" : result.message || "IK 失败"
  d.runtimeOutputMode = mode
  d.outputMode = mode
  attachEffectiveRuntimeDiagnostics(d, params, runtimeSource, diagnosticsSource, sideId)
  d.bindingNeutralPwmA = bindingA?.neutralPwm ?? null
  d.bindingNeutralPwmB = bindingB?.neutralPwm ?? null

  if (!result.ok) {
    d.qSend = null
    return {
      ok: false,
      message: result.message || "IK 失败",
      diagnostics: d,
    }
  }

  const qRaw = d.qRaw
  const qCmd = d.qCmd

  if (mode === "static-target" && qRaw && bindingA && bindingB) {
    const qSend = { qA_deg: qRaw.qA_deg, qB_deg: qRaw.qB_deg }
    d.qSend = qSend
    const pwmA = angleToBindingLogicalPwm(
      applyRuntimeAngleMod(qSend.qA_deg, params.qSignA, params.qGainA),
      bindingA
    )
    const pwmB = angleToBindingLogicalPwm(
      applyRuntimeAngleMod(qSend.qB_deg, params.qSignB, params.qGainB),
      bindingB
    )
    d.logicalPwmA = pwmA
    d.logicalPwmB = pwmB
    d.pwmA = pwmA
    d.pwmB = pwmB
    return {
      ok: true,
      message: "",
      pwmA,
      pwmB,
      diagnostics: d,
    }
  }

  d.qSend = qCmd ? { qA_deg: qCmd.qA_deg, qB_deg: qCmd.qB_deg } : null
  d.logicalPwmA = result.pwmA
  d.logicalPwmB = result.pwmB
  return {
    ok: true,
    message: "",
    pwmA: result.pwmA,
    pwmB: result.pwmB,
    diagnostics: d,
  }
}

export function computeRightMouthCornerFiveBarIk(rigValues, resolved, state) {
  return computeMouthCornerFiveBarIk(rigValues, resolved, state, "right")
}

export function computeLeftMouthCornerFiveBarIk(rigValues, resolved, state) {
  return computeMouthCornerFiveBarIk(rigValues, resolved, state, "left")
}

/**
 * 合并贡献时：若某条 mouth_corner_r.x/y 指向五杆的两个舵机，则从合成中剔除，避免与 IK 叠加。
 * @param {object} c
 * @param {ReturnType<typeof resolveRightMouthCornerKinematics>} resolved
 */
export function contributionExcludedForMouthFiveBar(c, resolved) {
  if (!resolved?.readyForIk) {
    return false
  }
  const side = getMouthCornerLabSide(resolved.sideId || "right")
  // 嘴角控件线性绑定一律让位五杆（即使仍指向 profile 默认 21/22）
  if (
    c.controlId === side.controlId &&
    (c.channel === CHANNEL_X || c.channel === CHANNEL_Y)
  ) {
    return true
  }
  const sid = Number(c.servoId)
  if (!Number.isFinite(sid)) {
    return false
  }
  // 五杆目标舵机上的其他线性贡献也剔除（含误绑到 Lab 7/8 的眼睑）
  return sid === resolved.servoAId || sid === resolved.servoBId
}

export function contributionExcludedForRightMouthFiveBar(c, resolved) {
  return contributionExcludedForMouthFiveBar(c, resolved)
}

function setMouthCornerKinematicsDiag(pose, sideId, diag) {
  if (!pose.kinematics) {
    pose.kinematics = {}
  }
  if (sideId === "left") {
    pose.kinematics.leftMouthFiveBar = diag
    pose.kinematics.leftMouthCorner = diag
    pose.kinematics.leftMouthCornerFivebar = diag
  } else {
    pose.kinematics.rightMouthFiveBar = diag
    pose.kinematics.rightMouthCorner = diag
    pose.kinematics.rightMouthCornerFivebar = diag
  }
}

/**
 * 在已有 pose 上应用嘴角五杆（供外部与 mapFaceRigToPose 共用）。
 * 成功时：期望 pose.logicalPose 已由「已排除 mouth_corner_*→A/B 的贡献」合并得到，本函数写入两路 PWM 与 actual。
 *
 * @param {{
 *   rig: object,
 *   profile: object,
 *   configs: object[],
 *   pose: { logicalPose: object, actualPose: object, contributions: object[], warnings: string[] },
 *   sideId?: import("./mouthCornerFiveBarLabConfig.js").MouthCornerLabSideId,
 *   kinematics?: object,
 *   ikResult?: ReturnType<typeof computeMouthCornerFiveBarIk>,
 *   rightMouthRuntime?: object,
 *   leftMouthRuntime?: object,
 *   mouthRuntime?: object,
 *   rightMouthCornerFivebarState?: ReturnType<typeof createRightMouthCornerFivebarState>,
 *   leftMouthCornerFivebarState?: ReturnType<typeof createRightMouthCornerFivebarState>,
 * }} args
 */
export function applyFaceRigKinematicsOverrides(args) {
  const { rig, profile, configs = [], pose, kinematics: kinematicsUser, ikResult: ikResultIn } = args || {}
  if (!pose || typeof pose !== "object") {
    return pose
  }
  const sideId = args?.sideId || "right"
  const side = getMouthCornerLabSide(sideId)
  const rigValues = isRigValuesShapeForSide(rig, side.rigValuesKey)
    ? rig
    : { [side.rigValuesKey]: rigValuesForMouthCorner(rig, sideId) }
  const rt =
    sideId === "left"
      ? args?.leftMouthRuntime ?? args?.mouthRuntime
      : args?.rightMouthRuntime ?? args?.mouthRuntime
  const fiveBarStateIn =
    sideId === "left"
      ? args?.leftMouthCornerFivebarState ?? args?.mouthFiveBarStates?.left
      : args?.rightMouthCornerFivebarState ?? args?.mouthFiveBarStates?.right

  const resolved = resolveMouthCornerKinematics(profile, sideId, {
    runtimeParams: rt?.params ?? args?.runtimeParams,
    runtimeBindingOverride: rt?.bindingOverride ?? args?.runtimeBindingOverride,
    kinematics: kinematicsUser,
    runtimeSource: rt?.source ?? args?.runtimeSource,
  })
  if (!pose.kinematics) {
    pose.kinematics = {}
  }

  if (!resolved.enabled) {
    setMouthCornerKinematicsDiag(pose, sideId, {
      enabled: false,
      overrideNote: "",
      ikOk: null,
      ikMessage: "",
    })
    return pose
  }

  if (!resolved.readyForIk) {
    if (resolved.skipReason) {
      pose.warnings = [...(pose.warnings || []), resolved.skipReason]
    }
    setMouthCornerKinematicsDiag(pose, sideId, {
      enabled: true,
      readyForIk: false,
      overrideNote: "",
      ikOk: null,
      ikMessage: resolved.skipReason || "未就绪",
      servoAId: resolved.servoAId,
      servoBId: resolved.servoBId,
    })
    return pose
  }

  const ikResult =
    ikResultIn ??
    computeMouthCornerFiveBarIk(
      rigValues,
      resolved,
      fiveBarStateIn ?? createRightMouthCornerFivebarState(),
      sideId
    )
  const diag = ikResult.diagnostics
  setMouthCornerKinematicsDiag(pose, sideId, diag)

  if (!ikResult.ok) {
    pose.warnings = [...(pose.warnings || []), `${side.label}五杆 IK：${ikResult.message}`]
    return pose
  }

  const cfgList = Array.isArray(configs) ? configs : []
  const sa = String(resolved.servoAId)
  const sb = String(resolved.servoBId)
  const blockA = servoBlockedForMouthFiveBar(profile, side, resolved.servoAId)
  const blockB = servoBlockedForMouthFiveBar(profile, side, resolved.servoBId)

  if (!blockA) {
    pose.logicalPose[sa] = ikResult.pwmA
  } else {
    pose.warnings = [
      ...(pose.warnings || []),
      `舵机 ${resolved.servoAId} 由唇瓣/其他控件绑定占用，${side.label}五杆 IK 不覆盖该路`,
    ]
  }
  if (!blockB) {
    pose.logicalPose[sb] = ikResult.pwmB
  } else {
    pose.warnings = [
      ...(pose.warnings || []),
      `舵机 ${resolved.servoBId} 由唇瓣/其他控件绑定占用，${side.label}五杆 IK 不覆盖该路`,
    ]
  }

  for (const [sid, blocked] of [
    [resolved.servoAId, blockA],
    [resolved.servoBId, blockB],
  ]) {
    if (blocked) {
      continue
    }
    const key = String(sid)
    const cfg = getServoConfig(cfgList, sid)
    if (cfg.enabled === false) {
      pose.warnings = [...(pose.warnings || []), `舵机 ${sid}：未启用，五杆输出跳过 actual 映射`]
      continue
    }
    const r = logicalToActualPwm(pose.logicalPose[key], cfg)
    pose.actualPose[key] = r.actualPwm
  }

  const k = sideId === "left" ? pose.kinematics.leftMouthCorner : pose.kinematics.rightMouthCorner
  if (k) {
    k.actualPwmA = pose.actualPose[sa] ?? null
    k.actualPwmB = pose.actualPose[sb] ?? null
    attachEffectiveRuntimeDiagnostics(
      k,
      resolved.params,
      resolved.runtimeSource,
      resolved.diagnosticsSource,
      sideId
    )
    setMouthCornerKinematicsDiag(pose, sideId, k)
  }

  for (const c of pose.contributions || []) {
    if (contributionExcludedForMouthFiveBar(c, resolved)) {
      c.supersededByFiveBarIk = true
    }
  }

  return pose
}
