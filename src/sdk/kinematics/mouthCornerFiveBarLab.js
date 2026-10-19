import {
  SERVO_LOGICAL_MAX_PWM,
  SERVO_LOGICAL_MIN_PWM,
  STANDARD_CENTER_PWM,
  getServoConfig,
  logicalToActualPwm,
} from "../../core/servoConfig.js"
import { CHANNEL_X, CHANNEL_Y } from "../../core/faceRigProfile.js"
import { clampNumber } from "../../utils/clamp.js"
import {
  sendAllBusProfilesToCenter,
  sendLegacyLogicalPwmViaBus,
} from "../output/adapters/legacyLogicalBusSend.js"
import { angleToBindingLogicalPwm } from "./mouthCornerFivebar.js"
import { getMouthCornerLabSide } from "./mouthCornerFiveBarLabConfig.js"

function buildBusMovePreviewLine({ servoId, logicalPwm, timeMs }) {
  return `[Bus] legacy#${servoId} logical=${logicalPwm} T=${timeMs}`
}

const SCALE_MIN_SEND = 0.8

/** @typedef {"static-target" | "stateful-one-step" | "run-to-target"} LabOutputMode */
/** @typedef {"separate-write" | "sequential-string" | "multi-brace"} LabSendMode */

/** @param {import("./mouthCornerFiveBarLabConfig.js").MouthCornerLabSideId | string} sideId */
export function createDefaultMouthLabCalibration(sideId) {
  const side = getMouthCornerLabSide(sideId)
  const d = side.defaultCalibration
  return {
    Kx: d.Kx,
    Ky: d.Ky,
    xSign: d.xSign,
    ySign: d.ySign,
    qSignA: d.qSignA,
    qSignB: d.qSignB,
    qGainA: d.qGainA,
    qGainB: d.qGainB,
    servoSwap: d.servoSwap,
    flipPadX: Boolean(d.flipPadX),
    flipPadY: Boolean(d.flipPadY),
    padRotateCcwDeg: Number(d.padRotateCcwDeg) || 0,
    useProfileServoIds: true,
    servoTimeMs: 40,
    runIntervalMs: 30,
    minVisibleDeltaUs: 1,
    outputMode: /** @type {LabOutputMode} */ ("static-target"),
    sendMode: /** @type {LabSendMode} */ ("separate-write"),
    livePadDriveEnabled: false,
    livePadDriveIntervalMs: 40,
    mediaPipeRightMouthDriveEnabled: false,
    mediaPipeLeftMouthDriveEnabled: false,
    neutralPwmA: d.neutralPwmA ?? null,
    neutralPwmB: d.neutralPwmB ?? null,
  }
}

/** @param {import("./mouthCornerFiveBarLabConfig.js").MouthCornerLabSideId | string} sideId */
/** @param {unknown} raw */
export function loadMouthLabCalibration(sideId, raw) {
  const side = getMouthCornerLabSide(sideId)
  const base = createDefaultMouthLabCalibration(sideId)
  if (!raw || typeof raw !== "object") {
    return base
  }
  const o = /** @type {Record<string, unknown>} */ (raw)
  const num = (k, def) => {
    const v = Number(o[k])
    return Number.isFinite(v) ? v : def
  }
  const sign = (k, def) => {
    if (o[k] === undefined || o[k] === null || o[k] === "") {
      return def
    }
    const v = Number(o[k])
    if (v === -1) return -1
    if (v === 1) return 1
    return def
  }
  const optionalPwm = (k, def) => {
    if (o[k] === null || o[k] === undefined) {
      return def
    }
    const v = Number(o[k])
    if (!Number.isFinite(v)) {
      return def
    }
    return clampNumber(Math.round(v), SERVO_LOGICAL_MIN_PWM, SERVO_LOGICAL_MAX_PWM)
  }
  return {
    ...base,
    Kx: clampNumber(num("Kx", base.Kx), 0.1, 50),
    Ky: clampNumber(num("Ky", base.Ky), 0.1, 50),
    xSign: sign("xSign", base.xSign),
    ySign: sign("ySign", base.ySign),
    qSignA: sign("qSignA", base.qSignA),
    qSignB: sign("qSignB", base.qSignB),
    qGainA: clampNumber(num("qGainA", base.qGainA), 0.01, 4),
    qGainB: clampNumber(num("qGainB", base.qGainB), 0.01, 4),
    servoSwap: Boolean(o.servoSwap),
    flipPadX: o.flipPadX !== undefined ? Boolean(o.flipPadX) : base.flipPadX,
    flipPadY: o.flipPadY !== undefined ? Boolean(o.flipPadY) : base.flipPadY,
    padRotateCcwDeg:
      o.padRotateCcwDeg !== undefined
        ? clampNumber(Math.round(Number(o.padRotateCcwDeg) / 90) * 90, -180, 180)
        : base.padRotateCcwDeg,
    useProfileServoIds:
      o.useProfileServoIds !== undefined ? Boolean(o.useProfileServoIds) : base.useProfileServoIds,
    servoTimeMs: clampNumber(num("servoTimeMs", base.servoTimeMs), 0, 9999),
    runIntervalMs: clampNumber(num("runIntervalMs", base.runIntervalMs), 10, 2000),
    minVisibleDeltaUs: clampNumber(num("minVisibleDeltaUs", base.minVisibleDeltaUs), 1, 500),
    outputMode:
      o.outputMode === "stateful-one-step" || o.outputMode === "run-to-target"
        ? o.outputMode
        : "static-target",
    sendMode:
      o.sendMode === "sequential-string" || o.sendMode === "multi-brace"
        ? o.sendMode
        : "separate-write",
    livePadDriveEnabled: Boolean(o.livePadDriveEnabled),
    livePadDriveIntervalMs: clampNumber(num("livePadDriveIntervalMs", base.livePadDriveIntervalMs), 16, 500),
    mediaPipeRightMouthDriveEnabled: Boolean(o.mediaPipeRightMouthDriveEnabled),
    mediaPipeLeftMouthDriveEnabled: Boolean(o.mediaPipeLeftMouthDriveEnabled),
    neutralPwmA: optionalPwm("neutralPwmA", base.neutralPwmA),
    neutralPwmB: optionalPwm("neutralPwmB", base.neutralPwmB),
    /* 左嘴方向以当前冻结表为准，避免旧 localStorage 锁死上下/旋转 */
    ...(side.id === "left"
      ? {
          xSign: base.xSign,
          ySign: base.ySign,
          flipPadX: Boolean(base.flipPadX),
          flipPadY: Boolean(base.flipPadY),
          padRotateCcwDeg: base.padRotateCcwDeg ?? 90,
        }
      : {}),
  }
}

/**
 * 绑定页「设为中位」后同步 Lab 校准（localStorage），正式链路下次 mapFaceRigToPose 即生效。
 * @param {import("./mouthCornerFiveBarLabConfig.js").MouthCornerLabSideId | string} sideId
 * @param {{ neutralPwmA?: number | null, neutralPwmB?: number | null }} patch
 */
export function persistMouthLabNeutralPwm(sideId, patch) {
  const side = getMouthCornerLabSide(sideId)
  if (!patch || typeof patch !== "object") {
    return null
  }
  try {
    const raw = localStorage.getItem(side.calibStorageKey)
    const prev = raw ? JSON.parse(raw) : {}
    const next = loadMouthLabCalibration(sideId, { ...prev, ...patch })
    localStorage.setItem(side.calibStorageKey, JSON.stringify(next))
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(side.baselineChangedEvent))
    }
    return next
  } catch {
    return null
  }
}

/**
 * 经总线 actuator profile 下发嘴角两路逻辑 PWM（500–2500）。
 * sendMode / writeText 保留兼容签名，实发一律走 bus helper。
 */
export async function sendMouthFiveBarPreview(preview, sendMode = "separate-write", _writeText) {
  if (!preview?.canSend) {
    return { ok: false, command: "", error: (preview?.blockReasons || ["不可发送"]).join("；") }
  }
  const timeMs = Math.max(0, Number(preview.timeMs) || 40)
  const targets = [
    { servoId: preview.servoAId, logicalPwm: preview.logicalPwmA },
    { servoId: preview.servoBId, logicalPwm: preview.logicalPwmB },
  ]
  const lines = []
  for (const t of targets) {
    const res = await sendLegacyLogicalPwmViaBus(t.servoId, t.logicalPwm, { timeMs })
    if (!res.ok) {
      return {
        ok: false,
        command: lines.join(" | "),
        error: res.error || `legacy#${t.servoId} 总线发送失败`,
      }
    }
    lines.push(
      `[Bus] legacy#${t.servoId} → bus#${res.busServoId} logical=${res.busLogical} pos=${res.targetPosition}`
    )
  }
  return {
    ok: true,
    command: lines.join(" | "),
    error: "",
    sendMode: sendMode || "bus-legacy",
  }
}

/** 全部已配置总线 profile 回中。 */
export async function stopAllMouthLabServosViaBus({ timeMs = 200 } = {}) {
  return sendAllBusProfilesToCenter({ timeMs })
}

/** @param {import("./mouthCornerFiveBarLabConfig.js").MouthCornerLabSideId | string} sideId */
export function buildLabKinematicsOverrideForSide(sideId, calibration, outputModeOverride) {
  return buildMouthCornerLabKinematicsWrap(sideId, calibration, outputModeOverride)
}

/**
 * Lab / 调试页与正式链路共用的 kinematics 包装（含 flip、neutralPwm、q 符号）。
 * @param {import("./mouthCornerFiveBarLabConfig.js").MouthCornerLabSideId | string} sideId
 * @param {object} calibration
 * @param {string} [outputModeOverride]
 * @param {object} [runtimeParams] get*MouthFiveBarRuntime().params
 */
export function buildMouthCornerLabKinematicsWrap(
  sideId,
  calibration,
  outputModeOverride,
  runtimeParams = null
) {
  const side = getMouthCornerLabSide(sideId)
  const cal = loadMouthLabCalibration(sideId, calibration)
  const rt = runtimeParams && typeof runtimeParams === "object" ? runtimeParams : {}
  const mode = outputModeOverride || cal.outputMode || "static-target"
  const stateful = mode === "stateful-one-step" || mode === "run-to-target"
  const sidePrefix = sideId === "left" ? "leftMouthCorner" : "rightMouthCorner"
  const flipPadX = cal.flipPadX ?? rt.flipPadX ?? side.defaultCalibration.flipPadX
  const flipPadY = cal.flipPadY ?? rt.flipPadY ?? side.defaultCalibration.flipPadY
  const padRotateCcwDeg =
    cal.padRotateCcwDeg ?? rt.padRotateCcwDeg ?? side.defaultCalibration.padRotateCcwDeg ?? 0
  const slice = {
    enabled: true,
    runtimeOutputMode: mode,
    flipPadX: Boolean(flipPadX),
    flipPadY: Boolean(flipPadY),
    padRotateCcwDeg: Number(padRotateCcwDeg) || 0,
    [`${sidePrefix}PadFlipX`]: Boolean(flipPadX),
    [`${sidePrefix}PadFlipY`]: Boolean(flipPadY),
    [`${sidePrefix}PadRotateCcwDeg`]: Number(padRotateCcwDeg) || 0,
    Kx: cal.Kx ?? rt.Kx,
    Ky: cal.Ky ?? rt.Ky,
    xSign: cal.xSign ?? rt.xSign,
    ySign: cal.ySign ?? rt.ySign,
    qSignA: cal.qSignA ?? rt.qSignA,
    qSignB: cal.qSignB ?? rt.qSignB,
    qGainA: cal.qGainA ?? rt.qGainA,
    qGainB: cal.qGainB ?? rt.qGainB,
    servoSwap: cal.servoSwap ?? rt.servoSwap,
    neutralPwmA: cal.neutralPwmA ?? rt.neutralPwmA ?? null,
    neutralPwmB: cal.neutralPwmB ?? rt.neutralPwmB ?? null,
    maxStepDeg: stateful ? 90 : (rt.maxStepDeg ?? 1.0),
    filterAlpha: stateful ? 1.0 : (rt.filterAlpha ?? 0.25),
  }
  const key = sideId === "left" ? "leftMouthCornerFiveBar" : "rightMouthCornerFiveBar"
  return { [key]: slice }
}

function applyAngleLabMods(qDeg, sign, gain) {
  return Number(qDeg) * Number(sign) * Number(gain)
}

function isForbiddenExtremePad(pad) {
  const x = Number(pad?.x)
  const y = Number(pad?.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return false
  }
  return (x === 0 && y === 0) || (x === 100 && y === 100)
}

/**
 * @param {object} args
 * @param {import("./mouthCornerFiveBarLabConfig.js").MouthCornerLabSideId | string} args.sideId
 */
export function buildMouthFiveBarSendPreview({
  sideId = "right",
  evalResult,
  pad,
  calibration,
  resolved,
  configs = [],
  outputMode,
}) {
  const side = getMouthCornerLabSide(sideId)
  const cal = loadMouthLabCalibration(sideId, calibration)
  const mode = outputMode || cal.outputMode || "static-target"
  const swap = Boolean(cal.servoSwap)
  const profA = resolved?.servoAId
  const profB = resolved?.servoBId
  let bindingA = resolved?.bindingA
  let bindingB = resolved?.bindingB
  let profileServoAId = profA
  let profileServoBId = profB
  if (swap) {
    bindingA = resolved?.bindingB
    bindingB = resolved?.bindingA
    profileServoAId = profB
    profileServoBId = profA
  }
  const useProf = Boolean(cal.useProfileServoIds)
  const servoAId = useProf ? profileServoAId : side.labHwServoA
  const servoBId = useProf ? profileServoBId : side.labHwServoB
  const timeMs = clampNumber(Number(cal.servoTimeMs) || 50, 0, 9999)

  const qRaw = evalResult?.qRaw
  const qCmd = evalResult?.qCmd
  const qSendMode = mode === "run-to-target" ? "stateful-one-step" : mode
  let qSend = null
  if (qSendMode === "static-target" && qRaw) {
    qSend = qRaw
  } else if (qCmd) {
    qSend = qCmd
  }

  let errorA = null
  let errorB = null
  let errorAbsA = null
  let errorAbsB = null
  if (qSendMode === "stateful-one-step" && qRaw && qCmd) {
    errorA = Number(qRaw.qA_deg) - Number(qCmd.qA_deg)
    errorB = Number(qRaw.qB_deg) - Number(qCmd.qB_deg)
    errorAbsA = Math.abs(errorA)
    errorAbsB = Math.abs(errorB)
  }

  let logicalPwmA = null
  let logicalPwmB = null
  if (qSend && bindingA && bindingB) {
    const qA = applyAngleLabMods(qSend.qA_deg, cal.qSignA, cal.qGainA)
    const qB = applyAngleLabMods(qSend.qB_deg, cal.qSignB, cal.qGainB)
    logicalPwmA = angleToBindingLogicalPwm(qA, bindingA)
    logicalPwmB = angleToBindingLogicalPwm(qB, bindingB)
  }

  const blockReasons = []
  if (isForbiddenExtremePad(pad)) {
    blockReasons.push("禁止发送 Pad 0/0 或 100/100 极限点")
  }
  if (!evalResult?.ok) {
    blockReasons.push(evalResult?.message || "evaluate 失败")
  }
  if (!evalResult?.qSend && !qSend) {
    blockReasons.push("qSend 无效")
  }
  if (evalResult?.scale != null && Number(evalResult.scale) < SCALE_MIN_SEND) {
    blockReasons.push(`scale=${Number(evalResult.scale).toFixed(2)} < ${SCALE_MIN_SEND}`)
  }
  if (!Number.isFinite(servoAId) || !Number.isFinite(servoBId)) {
    blockReasons.push("命令 servoId 无效")
  }

  const cfgList = Array.isArray(configs) ? configs : []
  const neutralLogicalA = Number(bindingA?.neutralPwm)
  const neutralLogicalB = Number(bindingB?.neutralPwm)
  const nLogA = Number.isFinite(neutralLogicalA) ? neutralLogicalA : STANDARD_CENTER_PWM
  const nLogB = Number.isFinite(neutralLogicalB) ? neutralLogicalB : STANDARD_CENTER_PWM

  const actualA =
    logicalPwmA != null && Number.isFinite(servoAId)
      ? logicalToActualPwm(logicalPwmA, getServoConfig(cfgList, servoAId))
      : null
  const actualB =
    logicalPwmB != null && Number.isFinite(servoBId)
      ? logicalToActualPwm(logicalPwmB, getServoConfig(cfgList, servoBId))
      : null

  const moves = []
  for (const [label, sid, logical, actual] of [
    ["A", servoAId, logicalPwmA, actualA],
    ["B", servoBId, logicalPwmB, actualB],
  ]) {
    if (logical == null || !Number.isFinite(Number(logical))) {
      blockReasons.push(`logicalPwm${label} 无效`)
      continue
    }
    const lg = Number(logical)
    if (lg < SERVO_LOGICAL_MIN_PWM || lg > SERVO_LOGICAL_MAX_PWM) {
      blockReasons.push(`logicalPwm${label} 超出逻辑限位`)
    }
    if (!actual) {
      blockReasons.push(`servo${label} 配置无效`)
      continue
    }
    const cfg = getServoConfig(cfgList, sid)
    if (cfg.enabled === false) {
      blockReasons.push(`舵机 ${sid} 未启用`)
    }
    if (actual.limited) {
      blockReasons.push(`actualPwm（servo ${sid}）被钳制`)
    }
    moves.push({
      servoId: sid,
      logicalPwm: Math.round(lg),
      pwm: actual.actualPwm,
      timeMs,
      minPwm: cfg.actualMinPwm,
      maxPwm: cfg.actualMaxPwm,
    })
  }

  let multiBraceCommand = ""
  let sequentialCommand = ""
  let singleCommands = []
  if (moves.length === 2 && blockReasons.length === 0) {
    singleCommands = moves.map((move) =>
      buildBusMovePreviewLine({
        servoId: move.servoId,
        logicalPwm: move.logicalPwm,
        timeMs: move.timeMs,
      })
    )
    multiBraceCommand = `[Bus] sync ${moves
      .map((m) => `#${m.servoId}@${m.logicalPwm}`)
      .join(",")}`
    sequentialCommand = singleCommands.join(" | ")
  }

  const actAp = actualA?.actualPwm
  const actBp = actualB?.actualPwm
  const neutralActualA =
    Number.isFinite(servoAId) && Number.isFinite(nLogA)
      ? logicalToActualPwm(nLogA, getServoConfig(cfgList, servoAId)).actualPwm
      : null
  const neutralActualB =
    Number.isFinite(servoBId) && Number.isFinite(nLogB)
      ? logicalToActualPwm(nLogB, getServoConfig(cfgList, servoBId)).actualPwm
      : null

  const logicalNeutralA = Math.round(nLogA)
  const logicalNeutralB = Math.round(nLogB)
  const logicalDeltaA =
    logicalPwmA != null && Number.isFinite(logicalPwmA)
      ? Math.round(Number(logicalPwmA)) - logicalNeutralA
      : null
  const logicalDeltaB =
    logicalPwmB != null && Number.isFinite(logicalPwmB)
      ? Math.round(Number(logicalPwmB)) - logicalNeutralB
      : null
  const actualNeutralA =
    neutralActualA != null && Number.isFinite(neutralActualA) ? Math.round(Number(neutralActualA)) : null
  const actualNeutralB =
    neutralActualB != null && Number.isFinite(neutralActualB) ? Math.round(Number(neutralActualB)) : null
  const actualDeltaA =
    actAp != null && actualNeutralA != null ? Math.round(Number(actAp)) - actualNeutralA : null
  const actualDeltaB =
    actBp != null && actualNeutralB != null ? Math.round(Number(actBp)) - actualNeutralB : null
  const absDeltaA = actualDeltaA != null ? Math.abs(actualDeltaA) : null
  const absDeltaB = actualDeltaB != null ? Math.abs(actualDeltaB) : null
  const minVis = clampNumber(Number(cal.minVisibleDeltaUs) || 1, 1, 500)
  const visibleMotion =
    absDeltaA != null && absDeltaB != null ? !(absDeltaA < minVis && absDeltaB < minVis) : null

  return {
    sideId: side.id,
    pad,
    scale: evalResult?.scale,
    qRaw,
    qCmd,
    qSend,
    qSendMode,
    outputMode: mode,
    errorA,
    errorB,
    errorAbsA,
    errorAbsB,
    logicalPwmA,
    logicalPwmB,
    logicalNeutralA,
    logicalNeutralB,
    logicalDeltaA,
    logicalDeltaB,
    actualPwmA: actAp ?? null,
    actualPwmB: actBp ?? null,
    actualNeutralA,
    actualNeutralB,
    actualDeltaA,
    actualDeltaB,
    minVisibleDeltaUs: minVis,
    visibleMotion,
    profileServoAId: profA,
    profileServoBId: profB,
    servoAId,
    servoBId,
    multiBraceCommand,
    sequentialCommand,
    singleCommands,
    canSend: blockReasons.length === 0 && singleCommands.length === 2,
    blockReasons,
    timeMs,
  }
}

/** @param {object} profile */
/** @param {import("./mouthCornerFiveBarLabConfig.js").MouthCornerLabSideId | string} sideId */
/** @param {object} calibration */
/** @param {{ x: number, y: number }} [pad] */
export function buildMouthRuntimeSnapshot(profile, sideId, calibration, pad) {
  const side = getMouthCornerLabSide(sideId)
  const cal = loadMouthLabCalibration(sideId, calibration)
  const normalizedProfile = profile || {}

  const bindings = {}
  let servoAId = null
  let servoBId = null
  for (const b of normalizedProfile.bindings || []) {
    if (b?.controlId !== side.controlId || b.enabled === false) {
      continue
    }
    if (b.channel === CHANNEL_X || b.channel === CHANNEL_Y) {
      bindings[`${side.profileBindingPrefix}_${b.channel}`] = {
        bindingId: b.bindingId,
        servoId: b.servoId,
        enabled: b.enabled !== false,
      }
      if (b.channel === CHANNEL_X) {
        servoAId = Number(b.servoId)
      }
      if (b.channel === CHANNEL_Y) {
        servoBId = Number(b.servoId)
      }
    }
  }

  const labA = side.labHwServoA
  const labB = side.labHwServoB
  const needLabHw =
    !Number.isFinite(servoAId) ||
    !Number.isFinite(servoBId) ||
    servoAId === servoBId ||
    servoAId !== labA ||
    servoBId !== labB

  if (needLabHw && Number.isFinite(labA) && Number.isFinite(labB) && labA !== labB) {
    servoAId = labA
    servoBId = labB
    const routeBinding = (sid, channel) => {
      const byServo = (normalizedProfile.bindings || []).find(
        (b) => b?.enabled !== false && Number(b.servoId) === sid
      )
      return {
        bindingId: byServo?.bindingId || `${side.profileBindingPrefix}_${channel}`,
        servoId: sid,
        enabled: true,
      }
    }
    bindings[`${side.profileBindingPrefix}_x`] = routeBinding(labA, CHANNEL_X)
    bindings[`${side.profileBindingPrefix}_y`] = routeBinding(labB, CHANNEL_Y)
  }

  const readyForIk = Number.isFinite(servoAId) && Number.isFinite(servoBId)

  return {
    version: `facedev.${side.id}MouthFivebar.runtimeSnapshot.v1`,
    side: side.id,
    savedAt: new Date().toISOString(),
    calibration: cal,
    runtime: {
      enabled: true,
      runtimeOutputMode: "static-target",
      Kx: cal.Kx,
      Ky: cal.Ky,
      xSign: cal.xSign,
      ySign: cal.ySign,
      qSignA: cal.qSignA,
      qSignB: cal.qSignB,
      qGainA: cal.qGainA,
      qGainB: cal.qGainB,
      servoSwap: cal.servoSwap,
      neutralPwmA: cal.neutralPwmA,
      neutralPwmB: cal.neutralPwmB,
      maxStepDeg: 1.0,
      filterAlpha: 0.25,
      servoTimeMs: cal.servoTimeMs,
      sendIntervalMs: cal.livePadDriveIntervalMs,
    },
    profileBindings: bindings,
    servoAId,
    servoBId,
    readyForIk,
    skipReason: readyForIk ? "" : `${side.controlId}.x/y 绑定未就绪`,
    pad: pad ? { x: Number(pad.x), y: Number(pad.y) } : null,
  }
}
