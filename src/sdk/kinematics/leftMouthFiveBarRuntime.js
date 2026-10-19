import { getDefaultRightMouthRuntimeParams, sanitizeMouthBaselineBindingOverride } from "./rightMouthFiveBarRuntime.js"
import { getDefaultMouthCornerPadFlip } from "./mouthCornerFivebar.js"
import { getMouthCornerLabSide } from "./mouthCornerFiveBarLabConfig.js"
import { loadMouthLabCalibration } from "./mouthCornerFiveBarLab.js"

export const LEFT_MOUTH_RUNTIME_BASELINE_KEY = "facedev.leftMouthFivebar.runtimeBaseline.v1"
export const LEFT_MOUTH_BASELINE_CHANGED_EVENT = "facedev:leftMouthFivebarBaselineChanged"

function notifyBaselineChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(LEFT_MOUTH_BASELINE_CHANGED_EVENT))
  }
}

function loadStoredLeftMouthLabCalibration() {
  try {
    const key = getMouthCornerLabSide("left").calibStorageKey
    const raw = localStorage.getItem(key)
    if (!raw) {
      return loadMouthLabCalibration("left", {})
    }
    return loadMouthLabCalibration("left", JSON.parse(raw))
  } catch {
    return loadMouthLabCalibration("left", {})
  }
}

function loadLeftMouthLabCalibrationForRuntime(baseline) {
  const embedded = loadMouthLabCalibration("left", baseline?.calibration ?? baseline?.runtime ?? {})
  const live = loadStoredLeftMouthLabCalibration()
  return loadMouthLabCalibration("left", { ...embedded, ...live })
}

function buildLeftRuntimeParamsFromCalibration(defaults, cal, rtSlice = {}) {
  const d = getMouthCornerLabSide("left").defaultCalibration
  return {
    ...defaults,
    ...getDefaultMouthCornerPadFlip("left"),
    Kx: cal.Kx ?? rtSlice.Kx ?? defaults.Kx,
    Ky: cal.Ky ?? rtSlice.Ky ?? defaults.Ky,
    /* 方向语义以冻结表为准，忽略 localStorage 旧 xSign/ySign/flip/rotate，避免刷新仍上下反 */
    xSign: d.xSign ?? 1,
    ySign: d.ySign ?? -1,
    qSignA: cal.qSignA ?? rtSlice.qSignA ?? d.qSignA ?? 1,
    qSignB: cal.qSignB ?? rtSlice.qSignB ?? d.qSignB ?? 1,
    qGainA: cal.qGainA ?? rtSlice.qGainA ?? d.qGainA ?? 1,
    qGainB: cal.qGainB ?? rtSlice.qGainB ?? d.qGainB ?? 1,
    servoSwap: cal.servoSwap ?? rtSlice.servoSwap ?? false,
    flipPadX: Boolean(d.flipPadX),
    flipPadY: Boolean(d.flipPadY),
    padRotateCcwDeg: d.padRotateCcwDeg ?? 90,
    leftMouthCornerPadFlipX: Boolean(d.flipPadX),
    leftMouthCornerPadFlipY: Boolean(d.flipPadY),
    leftMouthCornerPadRotateCcwDeg: d.padRotateCcwDeg ?? 90,
    neutralPwmA: cal.neutralPwmA ?? rtSlice.neutralPwmA ?? d.neutralPwmA ?? null,
    neutralPwmB: cal.neutralPwmB ?? rtSlice.neutralPwmB ?? d.neutralPwmB ?? null,
    padXCenter: defaults.padXCenter,
    padYCenter: defaults.padYCenter,
    maxStepDeg: rtSlice.maxStepDeg ?? 1.0,
    filterAlpha: rtSlice.filterAlpha ?? 0.25,
  }
}

/** 正式链路 / Lab 共用：左嘴角 FiveBar runtime。 */
export function getLeftMouthFiveBarRuntime() {
  const defaults = getDefaultRightMouthRuntimeParams()
  const baseline = loadLeftMouthRuntimeBaseline()

  if (!baseline) {
    const cal = loadStoredLeftMouthLabCalibration()
    return {
      enabled: true,
      source: /** @type {const} */ ("default"),
      loaded: false,
      calibration: cal,
      params: buildLeftRuntimeParamsFromCalibration(defaults, cal),
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

  const cal = loadLeftMouthLabCalibrationForRuntime(baseline)
  const rtSlice = baseline.runtime && typeof baseline.runtime === "object" ? baseline.runtime : {}

  const params = buildLeftRuntimeParamsFromCalibration(defaults, cal, rtSlice)

  return {
    enabled: rtSlice.enabled !== false,
    source: /** @type {const} */ ("runtimeBaseline"),
    loaded: true,
    calibration: cal,
    params,
    runtime: {
      outputMode: rtSlice.runtimeOutputMode || "static-target",
      servoTimeMs: cal.servoTimeMs ?? 40,
      sendIntervalMs: cal.livePadDriveIntervalMs ?? 40,
    },
    bindingOverride: sanitizeMouthBaselineBindingOverride(baseline, "left"),
    version: baseline.version || LEFT_MOUTH_RUNTIME_BASELINE_KEY,
    savedAt: baseline.savedAt || null,
    servoAId: baseline.servoAId ?? null,
    servoBId: baseline.servoBId ?? null,
  }
}

export function loadLeftMouthRuntimeBaseline() {
  try {
    const raw = localStorage.getItem(LEFT_MOUTH_RUNTIME_BASELINE_KEY)
    if (!raw) {
      return null
    }
    const data = JSON.parse(raw)
    return data && typeof data === "object" ? data : null
  } catch {
    return null
  }
}

export function saveLeftMouthRuntimeBaseline(snapshot) {
  const payload = {
    ...snapshot,
    version: LEFT_MOUTH_RUNTIME_BASELINE_KEY,
    savedAt: snapshot?.savedAt || new Date().toISOString(),
  }
  localStorage.setItem(LEFT_MOUTH_RUNTIME_BASELINE_KEY, JSON.stringify(payload))
  notifyBaselineChanged()
  return payload
}

export function reloadLeftMouthRuntimeBaseline() {
  const data = loadLeftMouthRuntimeBaseline()
  notifyBaselineChanged()
  return data
}

export function clearLeftMouthRuntimeBaseline() {
  localStorage.removeItem(LEFT_MOUTH_RUNTIME_BASELINE_KEY)
  notifyBaselineChanged()
}

export function hasLeftMouthRuntimeBaseline() {
  return Boolean(loadLeftMouthRuntimeBaseline())
}
