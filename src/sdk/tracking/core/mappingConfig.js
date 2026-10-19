/**
 * MediaPipe → Rig mapping defaults and normalize.
 * Defaults embedded from tools/tracking_service/mediapipe_mapping.default.json.
 */

import { safeFloat } from "./trackingMath.js"

const DEFAULT_NEUTRAL = Object.freeze({
  jawOpen: 0,
  eyeBlinkLeft: 0,
  eyeBlinkRight: 0,
  eyeWideLeft: 0,
  eyeWideRight: 0,
  mouthSmileLeft: 0,
  mouthSmileRight: 0,
  mouthUpperUpLeft: 0,
  mouthUpperUpRight: 0,
  mouthLowerDownLeft: 0,
  mouthLowerDownRight: 0,
  mouthPucker: 0,
  mouthFunnel: 0,
  browInnerUp: 0,
  browOuterUpLeft: 0,
  browOuterUpRight: 0,
  eyeLookX: 0,
  eyeLookY: 0,
})

const DEFAULT_GAINS = Object.freeze({
  jaw: 1.18,
  blinkLeft: 1.0,
  blinkRight: 1.0,
  smileLeft: 1.0,
  smileRight: 1.0,
  browLeft: 1.0,
  browRight: 1.0,
  browInner: 1.0,
  browOuterLeft: 1.0,
  browOuterRight: 1.0,
  eyeLookX: 1.0,
  eyeLookY: 1.0,
  eyeOpenLeft: 1.0,
  eyeOpenRight: 1.0,
  browTipLeft: 1.0,
  browTipRight: 1.0,
  browTailLeft: 1.0,
  browTailRight: 1.0,
  upperLipLeft: 1.0,
  upperLipRight: 1.0,
  lowerLipLeft: 1.0,
  lowerLipRight: 1.0,
})

const DEFAULT_INVERT = Object.freeze({
  jaw: true,
  blinkLeft: false,
  blinkRight: false,
  smileLeft: false,
  smileRight: false,
  browLeft: false,
  browRight: false,
  browInner: false,
  browOuterLeft: false,
  browOuterRight: false,
  eyeLookX: false,
  eyeLookY: false,
  eyeOpenLeft: false,
  eyeOpenRight: false,
  browTipLeft: false,
  browTipRight: false,
  browTailLeft: false,
  browTailRight: false,
  upperLipLeft: false,
  upperLipRight: false,
  lowerLipLeft: false,
  lowerLipRight: false,
})

const DEFAULT_DEADZONE = Object.freeze({
  jaw: 0.03,
  blink: 0.03,
  smile: 0.03,
  brow: 0.03,
  eyeLook: 0.03,
  eyeLookX: 0.02,
  eyeLookY: 0.032,
  eyeOpen: 0.03,
  lip: 0.03,
})

const DEFAULT_LIMITS = Object.freeze({
  jaw: Object.freeze([0, 100]),
  blink: Object.freeze([0, 100]),
  smile: Object.freeze([0, 100]),
  brow: Object.freeze([0, 100]),
  browPoint: Object.freeze([0, 100]),
  eyeLookX: Object.freeze([30, 70]),
  eyeLookY: Object.freeze([30, 70]),
  eyeOpen: Object.freeze([-100, 100]),
  lip: Object.freeze([0, 100]),
})

const DEFAULT_EYE = Object.freeze({
  openBiasLeft: 20,
  openBiasRight: 20,
  lowerLidOpenRatio: 0.25,
  lowerLidCloseRatio: 0.5,
  useEyeWide: false,
  eyeWideScale: 30,
})

const DEFAULT_BROW = Object.freeze({
  midInnerWeight: 0.4,
  midOuterWeight: 0.6,
  leftTipChannel: "tip",
  leftTailChannel: "tail",
  rightTipChannel: "tip",
  rightTailChannel: "tail",
})

const DEFAULT_BROW_GATE = Object.freeze({
  enabled: true,
  lockOnHeadMotionLikely: true,
  suppressDuringMouthMotion: true,
  browMinQuality: 0.5,
  browHeadMotionScoreThreshold: 0.08,
  browMouthMotionScoreThreshold: 3.5,
  browRawOnThreshold: 14.0,
  browRawStrongThreshold: 24.0,
  browRawOffThreshold: 6.0,
  browConfirmFrames: 4,
  allowExplicitBrowDuringLipArtifact: true,
  allowExplicitBrowDuringMildHeadMotion: true,
  lockBrowOnImmediateArtifactOnlyWhenWeak: true,
  mouthMotionSuppressScale: 0.15,
  headMotionSuppressScale: 0.25,
  neutralFallbackMs: 2000,
  snapToZero: 2.5,
  outputDeadband: 5.0,
  resetPrevOnLock: true,
})

const DEFAULT_GAZE = Object.freeze({
  gazeEstimatorMode: "mediapipe_iris_only_v1",
  enabled: true,
  preferIrisLandmarks: true,
  irisInitEnabled: false,
  irisXGain: 5.0,
  irisYGain: 5.0,
  irisYGainUp: 5.0,
  irisYGainDown: 13.0,
  irisYGainDownRatio: 2.6,
  irisWarmupFrames: 20,
  irisWarmupMinSamples: 12,
  irisWarmupMaxWaitFrames: 45,
  irisWarmupMaxHeadPx: 0.35,
  irisSoftNormKnee: 0.22,
  irisSoftNormKneeX: 0.22,
  irisSoftNormKneeY: 0.18,
  irisLocalDriveDeadzone: 0.012,
  irisLocalDriveDeadzoneX: 0.012,
  irisLocalDriveDeadzoneY: 0.007,
  irisQuietRecenterDrive: 0.014,
  irisQuietRecenterAlpha: 0.32,
  irisQuietRecenterAlphaY: 0.42,
  irisQuietBaselineAlpha: 0.006,
  irisQuietBaselineAlphaY: 0.012,
  irisHeadMotionHoldPx: 1.4,
  irisHeadMotionSoftPx: 0.65,
  irisInvertX: false,
  irisInvertY: false,
  irisDeadzoneX: 0.001,
  irisDeadzoneY: 0.001,
  irisOutputSpanX: 18,
  irisOutputSpanY: 20,
  irisEmaAlpha: 0.58,
  irisMaxDeltaNormPerFrame: 0.18,
  irisMaxStepSharedRadar: 10,
  irisMissingHoldFrames: 10,
  irisMissingDecayLerp: 0.05,
  irisMinEyeWidth: 0.003,
  irisMaxEyeWidth: 0.5,
  freezeOnBlink: true,
  blinkFreezeEnterThreshold: 0.48,
  blinkInstantHoldThreshold: 0.42,
  blinkFreezeReleaseThreshold: 0.38,
  blinkFreezeReleaseHoldFrames: 3,
  blinkFreezeMaxFrames: 10,
  blinkReleaseBlendFrames: 2,
  blinkWarmupBlockThreshold: 0.48,
  blinkFreezeThreshold: 0.48,
})

const DEFAULT_LIP = Object.freeze({
  enabled: true,
  upperScale: 100,
  lowerScale: 100,
  puckerEnabled: false,
  funnelEnabled: false,
})

const LIP_BOOL_KEYS = new Set(["enabled", "puckerEnabled", "funnelEnabled"])

const GAZE_BOOL_KEYS = new Set([
  "enabled",
  "preferIrisLandmarks",
  "irisInitEnabled",
  "irisInvertX",
  "irisInvertY",
  "freezeOnBlink",
  "fallbackToNeutral",
  "disableGuardForDebug",
  "autoEyeCenterEnabled",
  "eyeCornerV3ProductionEnabled",
  "eyeCornerV3DebugEnabled",
  "gazeYProductionEnabled",
  "gazeXProductionEnabled",
  "neutralInitEnabled",
  "neutralInitRequireMouthClosed",
  "neutralInitRequireLowMotion",
  "neutralInitFreezeOutput",
  "neutralInitShowPrompt",
  "safeCenterFallbackEnabled",
])

const GAZE_STR_KEYS = new Set(["gazeEstimatorMode", "gazeXProductionMode"])

const EYE_BOOL_KEYS = new Set(["useEyeWide"])

const BROW_STR_KEYS = new Set([
  "leftTipChannel",
  "leftTailChannel",
  "rightTipChannel",
  "rightTailChannel",
])

const BROW_GATE_BOOL_KEYS = new Set([
  "enabled",
  "lockOnHeadMotionLikely",
  "suppressDuringMouthMotion",
  "allowExplicitBrowDuringLipArtifact",
  "allowExplicitBrowDuringMildHeadMotion",
  "lockBrowOnImmediateArtifactOnlyWhenWeak",
  "resetPrevOnLock",
])

function clonePlain(obj) {
  if (Array.isArray(obj)) return obj.map((x) => x)
  if (obj && typeof obj === "object") {
    const out = {}
    for (const [k, v] of Object.entries(obj)) {
      out[k] = Array.isArray(v) ? v.slice() : v
    }
    return out
  }
  return obj
}

function mergeNumericSection(base, raw, defaults) {
  if (!raw || typeof raw !== "object") return
  for (const [k, v] of Object.entries(defaults)) {
    base[k] = safeFloat(raw[k], v)
  }
}

function mergeBoolSection(base, raw, defaults) {
  if (!raw || typeof raw !== "object") return
  for (const [k, v] of Object.entries(defaults)) {
    base[k] = raw[k] == null ? Boolean(v) : Boolean(raw[k])
  }
}

function mergeLimitPair(rawPair, fallback) {
  if (Array.isArray(rawPair) && rawPair.length >= 2) {
    return [safeFloat(rawPair[0], fallback[0]), safeFloat(rawPair[1], fallback[1])]
  }
  return fallback.slice()
}

function mergeTypedSection(base, raw, defaults, boolKeys, strKeys) {
  if (!raw || typeof raw !== "object") return
  for (const [k, v] of Object.entries(defaults)) {
    if (boolKeys.has(k) || typeof v === "boolean") {
      base[k] = raw[k] == null ? Boolean(v) : Boolean(raw[k])
    } else if (strKeys.has(k) || typeof v === "string") {
      const cand = raw[k]
      base[k] = cand == null || cand === "" ? String(v) : String(cand)
    } else {
      base[k] = safeFloat(raw[k], v)
    }
  }
}

export function createDefaultMappingConfig() {
  const limits = {}
  for (const [k, pair] of Object.entries(DEFAULT_LIMITS)) {
    limits[k] = pair.slice()
  }
  return {
    version: "1.0.0",
    neutral: clonePlain(DEFAULT_NEUTRAL),
    gains: clonePlain(DEFAULT_GAINS),
    invert: clonePlain(DEFAULT_INVERT),
    deadzone: clonePlain(DEFAULT_DEADZONE),
    limits,
    eye: clonePlain(DEFAULT_EYE),
    brow: clonePlain(DEFAULT_BROW),
    browGate: clonePlain(DEFAULT_BROW_GATE),
    gaze: clonePlain(DEFAULT_GAZE),
    lip: clonePlain(DEFAULT_LIP),
  }
}

/**
 * Merge a partial mapping config onto embedded defaults.
 * Unknown top-level sections are ignored (this core only owns listed sections).
 */
export function normalizeMappingConfig(partial) {
  const base = createDefaultMappingConfig()
  if (!partial || typeof partial !== "object") return base

  if (partial.version != null && partial.version !== "") {
    base.version = String(partial.version)
  }

  mergeNumericSection(base.neutral, partial.neutral, DEFAULT_NEUTRAL)
  mergeNumericSection(base.gains, partial.gains, DEFAULT_GAINS)
  mergeBoolSection(base.invert, partial.invert, DEFAULT_INVERT)
  mergeNumericSection(base.deadzone, partial.deadzone, DEFAULT_DEADZONE)

  if (partial.limits && typeof partial.limits === "object") {
    for (const [k, pair] of Object.entries(DEFAULT_LIMITS)) {
      base.limits[k] = mergeLimitPair(partial.limits[k], pair)
    }
  }

  mergeTypedSection(base.eye, partial.eye, DEFAULT_EYE, EYE_BOOL_KEYS, new Set())
  mergeTypedSection(base.brow, partial.brow, DEFAULT_BROW, new Set(), BROW_STR_KEYS)
  mergeTypedSection(base.browGate, partial.browGate, DEFAULT_BROW_GATE, BROW_GATE_BOOL_KEYS, new Set())
  mergeTypedSection(base.gaze, partial.gaze, DEFAULT_GAZE, GAZE_BOOL_KEYS, GAZE_STR_KEYS)
  mergeTypedSection(base.lip, partial.lip, DEFAULT_LIP, LIP_BOOL_KEYS, new Set())

  return base
}
