import { CHANNEL_X, CHANNEL_Y } from "../../core/faceRigProfile.js"
import { RIGHT_MOUTH_CORNER_FIVEBAR_PARAMS, getDefaultMouthCornerPadFlip } from "./mouthCornerFivebar.js"
import { getMouthCornerLabSide } from "./mouthCornerFiveBarLabConfig.js"
import { loadRightMouthLabCalibration } from "./rightMouthFiveBarLab.js"

export const RIGHT_MOUTH_RUNTIME_BASELINE_KEY = "facedev.rightMouthFivebar.runtimeBaseline.v1"
export const RIGHT_MOUTH_RUNTIME_SNAPSHOT_VERSION = "facedev.rightMouthFivebar.runtimeSnapshot.v1"
export const RIGHT_MOUTH_BASELINE_CHANGED_EVENT = "facedev:rightMouthFivebarBaselineChanged"

/** 正式链路唯一默认参数（禁止各模块自行 fallback 到 1/3） */
export function getDefaultRightMouthRuntimeParams() {
  const side = getMouthCornerLabSide("right")
  const d = side.defaultCalibration
  return {
    ...RIGHT_MOUTH_CORNER_FIVEBAR_PARAMS,
    ...getDefaultMouthCornerPadFlip("right"),
    qSignA: 1,
    qSignB: 1,
    qGainA: 1,
    qGainB: 1,
    servoSwap: false,
    neutralPwmA: d.neutralPwmA ?? null,
    neutralPwmB: d.neutralPwmB ?? null,
  }
}

function notifyBaselineChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(RIGHT_MOUTH_BASELINE_CHANGED_EVENT))
  }
}

function loadStoredRightMouthLabCalibration() {
  try {
    const key = getMouthCornerLabSide("right").calibStorageKey
    const raw = localStorage.getItem(key)
    if (!raw) {
      return loadRightMouthLabCalibration({})
    }
    return loadRightMouthLabCalibration(JSON.parse(raw))
  } catch {
    return loadRightMouthLabCalibration({})
  }
}

/** baseline 内嵌校准 + Lab 实时校准（localStorage）；后者优先，避免改中位后须重存 baseline。 */
function loadRightMouthLabCalibrationForRuntime(baseline) {
  const embedded = loadRightMouthLabCalibration(baseline?.calibration ?? baseline?.runtime ?? {})
  const live = loadStoredRightMouthLabCalibration()
  return loadRightMouthLabCalibration({ ...embedded, ...live })
}

function buildRuntimeParamsFromCalibration(defaults, cal, rtSlice = {}) {
  const side = getMouthCornerLabSide("right")
  const d = side.defaultCalibration
  return {
    ...defaults,
    ...getDefaultMouthCornerPadFlip("right"),
    Kx: cal.Kx ?? rtSlice.Kx ?? defaults.Kx,
    Ky: cal.Ky ?? rtSlice.Ky ?? defaults.Ky,
    xSign: cal.xSign ?? rtSlice.xSign ?? defaults.xSign,
    ySign: cal.ySign ?? rtSlice.ySign ?? defaults.ySign,
    qSignA: cal.qSignA ?? rtSlice.qSignA ?? defaults.qSignA,
    qSignB: cal.qSignB ?? rtSlice.qSignB ?? defaults.qSignB,
    qGainA: cal.qGainA ?? rtSlice.qGainA ?? defaults.qGainA,
    qGainB: cal.qGainB ?? rtSlice.qGainB ?? defaults.qGainB,
    servoSwap: cal.servoSwap ?? rtSlice.servoSwap ?? defaults.servoSwap,
    neutralPwmA: cal.neutralPwmA ?? rtSlice.neutralPwmA ?? d.neutralPwmA ?? null,
    neutralPwmB: cal.neutralPwmB ?? rtSlice.neutralPwmB ?? d.neutralPwmB ?? null,
    padXCenter: defaults.padXCenter,
    padYCenter: defaults.padYCenter,
    maxStepDeg: rtSlice.maxStepDeg ?? 1.0,
    filterAlpha: rtSlice.filterAlpha ?? 0.25,
  }
}

/**
 * baseline 中 X/Y 同舵机时回退到 Lab 硬件默认（右 7/8，左 16/17）。
 * @param {object} baseline
 * @param {import("./mouthCornerFiveBarLabConfig.js").MouthCornerLabSideId | string} [sideId]
 */
export function sanitizeMouthBaselineBindingOverride(baseline, sideId = "right") {
  if (!baseline || typeof baseline !== "object") {
    return null
  }
  const side = getMouthCornerLabSide(sideId)
  let servoAId = baseline.servoAId ?? null
  let servoBId = baseline.servoBId ?? null
  if (
    Number.isFinite(Number(servoAId)) &&
    Number.isFinite(Number(servoBId)) &&
    Number(servoAId) === Number(servoBId)
  ) {
    servoAId = side.labHwServoA
    servoBId = side.labHwServoB
  }
  if (
    !Number.isFinite(Number(servoAId)) ||
    !Number.isFinite(Number(servoBId)) ||
    Number(servoAId) === Number(servoBId)
  ) {
    return null
  }
  return {
    profileBindings: baseline.profileBindings || {},
    servoAId,
    servoBId,
  }
}

/**
 * Right Mouth FiveBar 唯一运行时入口（正式链路 / 诊断 / 关键帧播放均经此读取）。
 * @returns {{
 *   enabled: boolean,
 *   source: "runtimeBaseline"|"default",
 *   loaded: boolean,
 *   calibration: object|null,
 *   params: object,
 *   runtime: { outputMode: string, servoTimeMs: number, sendIntervalMs: number },
 *   bindingOverride: object|null,
 *   version: string|null,
 *   savedAt: string|null,
 *   servoAId: number|null,
 *   servoBId: number|null,
 * }}
 */
export function getRightMouthFiveBarRuntime() {
  const defaults = getDefaultRightMouthRuntimeParams()
  const baseline = loadRightMouthRuntimeBaseline()

  if (!baseline) {
    const cal = loadStoredRightMouthLabCalibration()
    return {
      enabled: true,
      source: /** @type {const} */ ("default"),
      loaded: false,
      calibration: cal,
      params: buildRuntimeParamsFromCalibration(defaults, cal),
      runtime: {
        outputMode: "static-target",
        servoTimeMs: cal.servoTimeMs ?? 40,
        sendIntervalMs: cal.livePadDriveIntervalMs ?? 40,
      },
      bindingOverride: null,
      version: null,
      savedAt: null,
      servoAId: null,
      servoBId: null,
    }
  }

  const cal = loadRightMouthLabCalibrationForRuntime(baseline)
  const rtSlice = baseline.runtime && typeof baseline.runtime === "object" ? baseline.runtime : {}

  const params = buildRuntimeParamsFromCalibration(defaults, cal, rtSlice)

  return {
    enabled: rtSlice.enabled !== false,
    source: /** @type {const} */ ("runtimeBaseline"),
    loaded: true,
    calibration: cal,
    params,
    runtime: {
      outputMode: rtSlice.runtimeOutputMode || "static-target",
      servoTimeMs: cal.servoTimeMs ?? 40,
      sendIntervalMs: cal.livePadDriveIntervalMs ?? cal.sendIntervalMs ?? 40,
    },
    bindingOverride: sanitizeMouthBaselineBindingOverride(baseline, "right"),
    version: baseline.version || RIGHT_MOUTH_RUNTIME_BASELINE_KEY,
    savedAt: baseline.savedAt || null,
    servoAId: baseline.servoAId ?? null,
    servoBId: baseline.servoBId ?? null,
  }
}

export {
  buildMapFaceRigToPoseOptionsFromMouthRuntimes,
  buildMapFaceRigToPoseOptionsFromRuntime,
} from "./mouthFiveBarRuntimeOptions.js"

/** @deprecated 使用 getRightMouthFiveBarRuntime；保留供旧 import */
export function getFaceRigKinematics() {
  const rt = getRightMouthFiveBarRuntime()
  return {
    rightMouthCornerFiveBar: {
      enabled: rt.enabled,
      runtimeOutputMode: rt.runtime.outputMode,
      ...rt.params,
    },
  }
}

/**
 * @param {object} profile
 * @param {object} calibration Lab 校准（见 loadRightMouthLabCalibration）
 * @param {{ x: number, y: number }} [pad]
 */
export function buildRightMouthRuntimeSnapshot(profile, calibration, pad) {
  const cal = loadRightMouthLabCalibration(calibration)
  const normalizedProfile = profile || {}

  const bindings = {}
  let servoAId = null
  let servoBId = null
  for (const b of normalizedProfile.bindings || []) {
    if (b?.controlId !== "mouth_corner_r" || b.enabled === false) {
      continue
    }
    if (b.channel === CHANNEL_X || b.channel === CHANNEL_Y) {
      bindings[`mouth_corner_r_${b.channel}`] = {
        bindingId: b.bindingId,
        servoId: b.servoId,
        neutralPwm: b.neutralPwm,
        pwmPerUnit: b.pwmPerUnit,
        invert: b.invert,
        enabled: b.enabled,
      }
      if (b.channel === CHANNEL_X) {
        servoAId = Number(b.servoId)
      }
      if (b.channel === CHANNEL_Y) {
        servoBId = Number(b.servoId)
      }
    }
  }
  const readyForIk = Number.isFinite(servoAId) && Number.isFinite(servoBId)

  return {
    version: RIGHT_MOUTH_RUNTIME_SNAPSHOT_VERSION,
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
      maxStepDeg: 1.0,
      filterAlpha: 0.25,
      servoTimeMs: cal.servoTimeMs,
      sendIntervalMs: cal.livePadDriveIntervalMs,
    },
    profileBindings: bindings,
    servoAId,
    servoBId,
    readyForIk,
    skipReason: readyForIk ? "" : "mouth_corner_r.x/y 绑定未就绪",
    pad: pad ? { x: Number(pad.x), y: Number(pad.y) } : null,
  }
}

export function loadRightMouthRuntimeBaseline() {
  try {
    const raw = localStorage.getItem(RIGHT_MOUTH_RUNTIME_BASELINE_KEY)
    if (!raw) {
      return null
    }
    const data = JSON.parse(raw)
    if (!data || typeof data !== "object") {
      return null
    }
    return data
  } catch {
    return null
  }
}

/**
 * @param {object} snapshot
 */
export function saveRightMouthRuntimeBaseline(snapshot) {
  const payload = {
    ...snapshot,
    version: RIGHT_MOUTH_RUNTIME_BASELINE_KEY,
    savedAt: snapshot?.savedAt || new Date().toISOString(),
  }
  localStorage.setItem(RIGHT_MOUTH_RUNTIME_BASELINE_KEY, JSON.stringify(payload))
  notifyBaselineChanged()
  return payload
}

export function reloadRightMouthRuntimeBaseline() {
  const data = loadRightMouthRuntimeBaseline()
  notifyBaselineChanged()
  return data
}

export function clearRightMouthRuntimeBaseline() {
  localStorage.removeItem(RIGHT_MOUTH_RUNTIME_BASELINE_KEY)
  notifyBaselineChanged()
}

export function hasRightMouthRuntimeBaseline() {
  return Boolean(loadRightMouthRuntimeBaseline())
}
