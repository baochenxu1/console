/**
 * Lip Landmark Geometry Driver — port of tools/tracking_service/lip_geometry.py
 * Default-path: pose-aware Y → geo delta → pre-gate → scenario gate → stabilize → mix → global scale.
 */

import {
  avgPoint3,
  buildMouthPoseFrame,
  cloneDeepPlain,
  evaluateMouthPoseGate,
  getLandmarkXy,
  mergeNumericConfig,
  readPoint3,
} from "./geomMath.js"
import { blendshapeLipSignedDeltas } from "./mouthBlendFallback.js"
import { normalizeMappingConfig } from "./mappingConfig.js"
import { clamp, clampSigned100, safeFloat } from "./trackingMath.js"

const LIP_KEYS = ["upperL", "upperR", "lowerL", "lowerR"]

const DEFAULT_LIP_GEOMETRY = Object.freeze({
  enabled: true,
  neutralFrames: 30,
  neutralWarmupFrames: 8,
  minMouthWidth: 0.03,
  autoNeutralOnStart: true,
  requireNeutralReadyForOutput: true,
  neutralMaxJaw: 8,
  neutralMaxJawOpen: 8,
  neutralMaxSmile: 12,
  neutralMaxSideOffset: 10,
  neutralMaxLipDelta: 8,
  neutralMaxLipVelocity: 3,
  neutralStableFrames: 10,
  neutralTrackMinQuality: 0.5,
  driftCorrectionEnabled: true,
  driftCorrectionAlpha: 0.015,
  driftCorrectionMaxStep: 0.0008,
  driftCorrectionStartAfterMs: 1500,
  upperGain: 1000,
  lowerGain: 1000,
  upperSign: 1,
  lowerSign: 1,
  deadzone: 2.0,
  softDeadzoneKnee: 6.0,
  smallMotionBoostEnabled: true,
  smallMotionThreshold: 18,
  smallMotionBoost: 1.2,
  largeMotionThreshold: 45,
  leftGain: 1.0,
  rightGain: 1.0,
  upperRightGain: 1.15,
  lowerRightGain: 1.15,
  snapToZero: 0.6,
  alphaSlow: 0.32,
  alphaFast: 0.86,
  fastDelta: 7,
  outputHoldDeadband: 1.0,
  outputReleaseThreshold: 2.0,
  maxStepPerFrame: 24,
  scenarioTransitionFrames: 10,
  maxLipControlAbsDefault: 100,
  smallJawOpenNormThreshold: 0.01,
  mediumJawOpenNormThreshold: 0.02,
  maxLipControlAbsTinyJaw: 22,
  maxLipControlAbsSmallJaw: 30,
  openCloseReleaseJawOpenNorm: 0.012,
  openCloseReleaseMouthScoreMax: 25,
  openCloseReleaseMaxLipControlAbs: 28,
  openCloseFastReleaseMaxStep: 50,
  openCloseFastReleaseAlpha: 0.96,
  lipGlobalScale: 0.52,
  lipFinalAbsLimit: 38,
  minOutputDelta: 0,
  stableHoldFrames: 0,
  blendshapeMix: 0.06,
  useApertureForLip: false,
  useJawForLip: false,
  removeJawFromLip: false,
  jawToUpperCompensation: 0.18,
  jawToLowerCompensation: 0.35,
  reAddJawToLip: false,
  jawToUpperLipGain: 0.1,
  jawToLowerLipGain: 0.18,
  crossTalkSuppressionEnabled: false,
  poseAwareFrameEnabled: true,
  poseGateEnabled: true,
  maxYawProxyDelta: 0.1,
  maxPitchProxyDelta: 0.1,
  maxRollDeltaDeg: 12,
  maxFaceScaleDelta: 0.18,
  poseMotionSuppressScale: 0.2,
  poseGateZeroWhenNoMouthMotion: true,
  poseGateMouthMotionThreshold: 6.0,
  poseGateOutputClamp: 12,
  use3dLocalCoordinate: true,
  closedHeadTurnLockEnabled: true,
  headMotionYawThreshold: 0.02,
  headMotionPitchThreshold: 0.035,
  headMotionRollThresholdDeg: 4.0,
  headMotionScaleThreshold: 0.02,
  closedHeadTurnJawAbsMax: 8.0,
  closedHeadTurnUseLipAbsAsVeto: false,
  closedHeadTurnLipVetoAbsMax: 35.0,
  closedHeadTurnUseApertureEvidence: true,
  closedHeadTurnApertureDeltaMax: 0.018,
  closedHeadTurnUseBlendshapeEvidence: true,
  closedHeadTurnMouthOpenMax: 12.0,
  closedHeadTurnJawOpenMax: 12.0,
  closedHeadTurnSmileMax: 18.0,
  closedHeadTurnUseCornerEvidence: true,
  closedHeadTurnCornerOffsetMax: 18.0,
  closedHeadTurnOutputClamp: 0.0,
  closedHeadTurnResetPrev: true,
  closedHeadTurnRequirePoseMotion: true,
  frontalMouthMotionThreshold: 4.0,
  neutralThreshold: 2.0,
  crossTalkRatio: 1.8,
  crossTalkPassiveMax: 12,
  crossTalkAttenuation: 0.25,
  upperLeftIndices: Object.freeze([40, 80, 81]),
  upperRightIndices: Object.freeze([270, 310, 311]),
  lowerLeftIndices: Object.freeze([91, 88, 178]),
  lowerRightIndices: Object.freeze([321, 318, 402]),
  leftCornerIndex: 61,
  rightCornerIndex: 291,
  chinIndex: 152,
})

function axis4Zero() {
  return { upperL: 0, upperR: 0, lowerL: 0, lowerR: 0 }
}

function axis4Copy(src) {
  if (!src || typeof src !== "object") return axis4Zero()
  const out = axis4Zero()
  for (const k of LIP_KEYS) out[k] = safeFloat(src[k], 0)
  return out
}

export function createLipGeometryState() {
  const z = axis4Zero()
  const pz = { rollDeg: 0, yawProxy: 0, pitchProxy: 0, faceScale: 0 }
  return {
    neutral_ready: false,
    neutral_mode: "idle",
    neutral_count: 0,
    neutral_warmup_count: 0,
    neutral_sum: { ...z, ...pz },
    neutral: { ...z, ...pz },
    prev: { ...z },
    prev_raw: { ...z },
    locked_to_zero: { upperL: true, upperR: true, lowerL: true, lowerR: true },
    last_calibrated_at: 0,
    last_drift_update_at: 0,
    neutral_stable_count: 0,
    force_recalibrate: false,
    auto_calibrate_requested: false,
    last_debug: {},
    drift_hold_reason: "",
  }
}

export function resetLipGeometryState(state) {
  if (state && typeof state === "object") {
    for (const k of Object.keys(state)) delete state[k]
    Object.assign(state, createLipGeometryState())
    return state
  }
  return createLipGeometryState()
}

export function startLipNeutralCalibration(state, reason = "manual") {
  if (!state || typeof state !== "object") return
  resetLipGeometryState(state)
  const auto = ["startCameraTracking", "autoLipNeutralOnStart", "auto_start", "mouthNeutral"]
  state.neutral_mode = auto.includes(String(reason)) ? "auto_start" : "manual"
  state.auto_calibrate_requested = state.neutral_mode === "auto_start"
  state.neutral_ready = false
}

export function normalizeLipGeometryConfig(raw) {
  const defaults = {
    ...DEFAULT_LIP_GEOMETRY,
    upperLeftIndices: DEFAULT_LIP_GEOMETRY.upperLeftIndices.slice(),
    upperRightIndices: DEFAULT_LIP_GEOMETRY.upperRightIndices.slice(),
    lowerLeftIndices: DEFAULT_LIP_GEOMETRY.lowerLeftIndices.slice(),
    lowerRightIndices: DEFAULT_LIP_GEOMETRY.lowerRightIndices.slice(),
  }
  return mergeNumericConfig(defaults, raw && typeof raw === "object" ? raw : null)
}

function resolveLipCfg(config) {
  if (config && typeof config === "object" && config.lipGeometry) {
    return normalizeLipGeometryConfig(config.lipGeometry)
  }
  if (config && typeof config === "object" && "upperGain" in config) {
    return normalizeLipGeometryConfig(config)
  }
  return normalizeLipGeometryConfig(null)
}

function cfgMaxJaw(lg) {
  if (lg && "neutralMaxJaw" in lg) return safeFloat(lg.neutralMaxJaw, 8)
  return safeFloat(lg?.neutralMaxJawOpen, 8)
}

export function isLipNeutralCandidate(frameInfo, lg) {
  if (!frameInfo?.face_detected) return false
  if (safeFloat(frameInfo.quality, 0) < safeFloat(lg?.neutralTrackMinQuality, 0.5)) return false
  const minW = Math.max(1e-6, safeFloat(lg?.minMouthWidth, 0.03))
  if (safeFloat(frameInfo.mouth_width, 0) < minW) return false
  if (Math.abs(safeFloat(frameInfo.jaw_val, 0)) > cfgMaxJaw(lg)) return false
  const maxSmile = safeFloat(lg?.neutralMaxSmile, 12)
  if (Math.max(Math.abs(safeFloat(frameInfo.smile_l, 0)), Math.abs(safeFloat(frameInfo.smile_r, 0))) > maxSmile) {
    return false
  }
  const maxSide = safeFloat(lg?.neutralMaxSideOffset, 10)
  for (const k of ["side_l_x", "side_l_y", "side_r_x", "side_r_y"]) {
    if (Math.abs(safeFloat(frameInfo[k], 50) - 50) > maxSide) return false
  }
  return true
}

function softDeadzoneSmooth(x, dz, knee) {
  const ax = Math.abs(Number(x))
  if (ax <= dz) return 0
  const y = ax - dz
  const k = Math.max(Number(knee), 1e-6)
  const smooth = y < k ? (y * y) / (2 * k) : y - k / 2
  return Math.sign(Number(x)) * smooth || (Number(x) < 0 ? -smooth : smooth)
}

function applySmallMotionBoost(x, lg) {
  if (lg.smallMotionBoostEnabled === false) return Number(x)
  const ax = Math.abs(Number(x))
  if (ax <= 0) return 0
  const smallThr = Math.max(1e-6, safeFloat(lg.smallMotionThreshold, 18))
  const largeThr = Math.max(smallThr + 1e-6, safeFloat(lg.largeMotionThreshold, 45))
  const boost = Math.max(1, safeFloat(lg.smallMotionBoost, 1.2))
  if (ax >= largeThr) return Number(x)
  if (ax <= smallThr) return Number(x) * boost
  const t = (ax - smallThr) / (largeThr - smallThr)
  return Number(x) * (boost + (1 - boost) * t)
}

function lipChannelGain(key, lg) {
  const leftG = safeFloat(lg.leftGain, 1)
  const rightG = safeFloat(lg.rightGain, 1)
  if (key === "upperL") return leftG
  if (key === "upperR") return rightG * safeFloat(lg.upperRightGain, 1)
  if (key === "lowerL") return leftG
  if (key === "lowerR") return rightG * safeFloat(lg.lowerRightGain, 1)
  return 1
}

function processLipPreGatePipeline(deltaRaw, lg) {
  const dz = Math.max(0, safeFloat(lg.deadzone, 2))
  const knee = Math.max(1e-6, safeFloat(lg.softDeadzoneKnee, 6))
  const afterGain = axis4Zero()
  const afterDz = axis4Zero()
  const afterBoost = axis4Zero()
  for (const k of LIP_KEYS) {
    let v = safeFloat(deltaRaw[k], 0)
    v = softDeadzoneSmooth(v, dz, knee)
    afterDz[k] = v
    v = applySmallMotionBoost(v, lg)
    afterBoost[k] = v
    afterGain[k] = v * lipChannelGain(k, lg)
  }
  return [
    afterGain,
    { raw: axis4Copy(deltaRaw), afterSoftDeadzone: afterDz, afterSmallMotionBoost: afterBoost, afterGain: { ...afterGain } },
  ]
}

function lipSignFromConfig(lg, key, fallback = 1) {
  const s = safeFloat(lg[key], fallback)
  if (Math.abs(s) < 1e-9) return fallback
  return s > 0 ? 1 : -1
}

function geoDeltaRaw(neutralY, currentY, gain, sign) {
  return clampSigned100(sign * (neutralY - currentY) * gain)
}

function buildMouthFrame2d(landmarks, lg) {
  const lc = Math.trunc(lg.leftCornerIndex ?? 61)
  const rc = Math.trunc(lg.rightCornerIndex ?? 291)
  const chinI = Math.trunc(lg.chinIndex ?? 152)
  const cornerL = getLandmarkXy(landmarks, lc)
  const cornerR = getLandmarkXy(landmarks, rc)
  const chin = getLandmarkXy(landmarks, chinI)
  if (!cornerL || !cornerR || !chin) return { frame: null, mouthWidth: 0 }
  const mouthCenter = [(cornerL[0] + cornerR[0]) * 0.5, (cornerL[1] + cornerR[1]) * 0.5]
  const dx = cornerR[0] - cornerL[0]
  const dy = cornerR[1] - cornerL[1]
  const n = Math.hypot(dx, dy)
  if (n < 1e-9) return { frame: null, mouthWidth: 0 }
  let xAxis = [dx / n, dy / n]
  let yAxis = [-xAxis[1], xAxis[0]]
  const chinRel = [chin[0] - mouthCenter[0], chin[1] - mouthCenter[1]]
  if (yAxis[0] * chinRel[0] + yAxis[1] * chinRel[1] < 0) yAxis = [-yAxis[0], -yAxis[1]]
  const yAxisTowardChin = yAxis[0] * chinRel[0] + yAxis[1] * chinRel[1] > 0
  const mouthWidth = n
  const minW = Math.max(1e-6, safeFloat(lg.minMouthWidth, 0.03))
  if (mouthWidth < minW) return { frame: null, mouthWidth }
  const projectY = (point) => {
    const px = point[0] - mouthCenter[0]
    const py = point[1] - mouthCenter[1]
    return (px * yAxis[0] + py * yAxis[1]) / mouthWidth
  }
  return {
    frame: { mouthCenter, xAxis, yAxis, yAxisTowardChin, projectY },
    mouthWidth,
  }
}

function isLipDriftUpdateAllowed({ st, lg, frameInfo, deltaSmooth, nowMs }) {
  if (lg.driftCorrectionEnabled === false) return [false, "disabled"]
  if (!st.neutral_ready) return [false, "not-ready"]
  const lastCal = safeFloat(st.last_calibrated_at, 0)
  if (lastCal <= 0 || nowMs - lastCal < safeFloat(lg.driftCorrectionStartAfterMs, 1500)) {
    return [false, "warmup-after-calibration"]
  }
  if (!isLipNeutralCandidate(frameInfo, lg)) return [false, "not-neutral-candidate"]
  const maxDelta = safeFloat(lg.neutralMaxLipDelta, 8)
  for (const k of LIP_KEYS) {
    if (Math.abs(safeFloat(deltaSmooth[k], 0)) > maxDelta) return [false, "lip-delta-active"]
  }
  const prevS = st.prev && typeof st.prev === "object" ? st.prev : {}
  const maxVel = safeFloat(lg.neutralMaxLipVelocity, 3)
  for (const k of LIP_KEYS) {
    if (Math.abs(safeFloat(deltaSmooth[k], 0) - safeFloat(prevS[k], 0)) > maxVel) return [false, "lip-velocity-high"]
  }
  const needStable = Math.max(1, Math.trunc(lg.neutralStableFrames ?? 10))
  if (Math.trunc(st.neutral_stable_count || 0) < needStable) return [false, "stabilizing"]
  return [true, "ok"]
}

function applyDriftCorrection(st, lg, currentY, nowMs) {
  const alpha = safeFloat(lg.driftCorrectionAlpha, 0.015)
  const maxStep = safeFloat(lg.driftCorrectionMaxStep, 0.0008)
  const neu = st.neutral
  const steps = axis4Zero()
  for (const k of LIP_KEYS) {
    const err = Number(currentY[k]) - Number(neu[k])
    const step = clamp(alpha * err, -maxStep, maxStep)
    neu[k] = Number(neu[k]) + step
    steps[k] = step
  }
  st.last_drift_update_at = nowMs
  return steps
}

function jawOpenNorm(blend, neutral) {
  return Math.abs(safeFloat(blend?.jawOpen, 0) - safeFloat(neutral?.jawOpen, 0))
}

function resolveMaxLipControlAbs(jawNorm, lg, { openCloseGuardActive, rawMouthScore }) {
  let maxAbs = safeFloat(lg.maxLipControlAbsDefault, 100)
  const dbg = { jawOpenNorm: jawNorm }
  const tiny = safeFloat(lg.smallJawOpenNormThreshold, 0.01)
  const mild = safeFloat(lg.mediumJawOpenNormThreshold, 0.02)
  if (jawNorm < tiny) {
    maxAbs = Math.min(maxAbs, safeFloat(lg.maxLipControlAbsTinyJaw, 12))
    dbg.tinyJawCap = true
  } else if (jawNorm < mild) {
    maxAbs = Math.min(maxAbs, safeFloat(lg.maxLipControlAbsSmallJaw, 20))
    dbg.smallJawCap = true
  }
  const ocJaw = safeFloat(lg.openCloseReleaseJawOpenNorm, 0.012)
  const ocScore = safeFloat(lg.openCloseReleaseMouthScoreMax, 25)
  if (openCloseGuardActive && jawNorm < ocJaw && rawMouthScore < ocScore) {
    maxAbs = Math.min(maxAbs, safeFloat(lg.openCloseReleaseMaxLipControlAbs, 15))
    dbg.openCloseFastRelease = true
  } else if (openCloseGuardActive && jawNorm < safeFloat(lg.mediumJawOpenNormThreshold, 0.02)) {
    maxAbs = Math.min(maxAbs, safeFloat(lg.openCloseReleaseMaxLipControlAbs, 15))
    dbg.openCloseGuardCap = true
  }
  dbg.maxLipControlAbs = maxAbs
  return [maxAbs, dbg]
}

function maybeArmOpenCloseFastRelease(st, lg, { jawNorm, openCloseGuardActive, rawMouthScore }) {
  const ocJaw = safeFloat(lg.openCloseReleaseJawOpenNorm, 0.012)
  const ocScore = safeFloat(lg.openCloseReleaseMouthScoreMax, 25)
  const active = Boolean(openCloseGuardActive && jawNorm < ocJaw && rawMouthScore < ocScore)
  const wasActive = Boolean(st.oc_fast_release_was_active)
  st.fast_release_lip = active
  if (active && !wasActive) {
    st.prev = axis4Zero()
    st.prev_raw = axis4Zero()
    for (const k of LIP_KEYS) st.locked_to_zero[k] = false
  } else if (active) {
    for (const k of LIP_KEYS) st.locked_to_zero[k] = false
  }
  st.oc_fast_release_was_active = active
  return active
}

function capLipChannels(delta, maxAbs) {
  const cap = Math.max(0, Number(maxAbs))
  const out = axis4Zero()
  for (const k of LIP_KEYS) out[k] = clamp(Number(delta[k]), -cap, cap)
  return out
}

function finalizeMouthRigWrite(rigWrite, lg) {
  const scale = clamp(safeFloat(lg.lipGlobalScale, 0.52), 0.05, 1)
  const limit = Math.max(1, safeFloat(lg.lipFinalAbsLimit, 45))
  return {
    UL: clamp(safeFloat(rigWrite.upperL, 0) * scale, -limit, limit),
    UR: clamp(safeFloat(rigWrite.upperR, 0) * scale, -limit, limit),
    LL: clamp(safeFloat(rigWrite.lowerL, 0) * scale, -limit, limit),
    LR: clamp(safeFloat(rigWrite.lowerR, 0) * scale, -limit, limit),
  }
}

function stabilizeLipChannel(key, raw, st, lg) {
  const prev = safeFloat(st.prev?.[key], 0)
  const prevRaw = safeFloat(st.prev_raw?.[key], 0)
  let locked = Boolean(st.locked_to_zero?.[key] ?? true)
  let dz = Math.max(0, safeFloat(lg.deadzone, 1))
  const snap = Math.max(0, safeFloat(lg.snapToZero, 0.6))
  const holdDb = Math.max(0, safeFloat(lg.outputHoldDeadband, 1.2))
  const releaseThr = Math.max(holdDb, safeFloat(lg.outputReleaseThreshold, 2.2))
  let alphaSlow = clamp(safeFloat(lg.alphaSlow, 0.32), 0, 1)
  let alphaFast = clamp(safeFloat(lg.alphaFast, 0.82), 0, 1)
  const fastDelta = Math.max(1e-6, safeFloat(lg.fastDelta, 10))
  let maxStep = Math.max(1e-6, safeFloat(lg.maxStepPerFrame, 18))
  const fastRelease = Boolean(st.fast_release_lip)
  if (fastRelease) {
    locked = false
    maxStep = Math.max(maxStep, safeFloat(lg.openCloseFastReleaseMaxStep, 28))
    alphaSlow = clamp(safeFloat(lg.openCloseFastReleaseAlpha, 0.88), 0, 1)
    alphaFast = alphaSlow
  }
  const rawAdj = Math.abs(raw) < dz ? 0 : Number(raw)
  let target
  if (fastRelease) target = 0
  else if (locked) {
    if (Math.abs(rawAdj) >= releaseThr) {
      locked = false
      target = rawAdj
    } else target = 0
  } else if (Math.abs(rawAdj) < holdDb) {
    locked = true
    target = 0
  } else target = rawAdj
  const deltaMag = Math.abs(target - prev)
  const t = Math.min(1, deltaMag / fastDelta)
  const alpha = alphaSlow + (alphaFast - alphaSlow) * t
  let y = prev + alpha * (target - prev)
  const step = clamp(y - prev, -maxStep, maxStep)
  y = prev + step
  if (Math.abs(y) < snap) {
    y = 0
    locked = true
  }
  const minOd = Math.max(0, safeFloat(lg.minOutputDelta, 0))
  if (minOd > 0 && Math.abs(y - prev) < minOd) y = prev
  const velocity = Math.abs(rawAdj - prevRaw)
  st.prev[key] = y
  st.prev_raw[key] = rawAdj
  st.locked_to_zero[key] = locked
  return [y, { locked, raw: rawAdj, smooth: y, velocity, alpha }]
}

function applyScenarioGateBlend(st, target, mouthScenario, lg) {
  const frames = Math.max(1, Math.trunc(safeFloat(lg.scenarioTransitionFrames, 10)))
  const prevScenario = String(st.gate_scenario || mouthScenario)
  const scenarioChanged = mouthScenario !== prevScenario
  if (scenarioChanged) {
    st.gate_scenario_from = { ...(st.gate_scenario_out || st.prev || axis4Zero()) }
    st.gate_scenario_blend_idx = 0
    st.gate_scenario = mouthScenario
  }
  const idx = Math.trunc(st.gate_scenario_blend_idx ?? frames)
  let blended
  let blending
  if (idx < frames) {
    const fromOut = st.gate_scenario_from || axis4Zero()
    const t = (idx + 1) / frames
    st.gate_scenario_blend_idx = idx + 1
    blended = axis4Zero()
    for (const k of LIP_KEYS) {
      blended[k] = safeFloat(fromOut[k], 0) + (Number(target[k]) - safeFloat(fromOut[k], 0)) * t
    }
    blending = true
  } else {
    blended = { ...target }
    blending = false
  }
  st.gate_scenario_out = { ...blended }
  return [
    blended,
    {
      scenario: String(mouthScenario),
      prevScenario,
      scenarioChanged,
      blendIndex: Math.trunc(st.gate_scenario_blend_idx ?? frames),
      blendFrames: frames,
      blending,
    },
  ]
}

function stabilizeAllChannels(deltaRaw, st, lg) {
  const smooth = axis4Zero()
  const stabilizer = { lockedToZero: {}, raw: {}, smooth: {}, velocity: {}, alpha: {} }
  for (const k of LIP_KEYS) {
    const [y, ch] = stabilizeLipChannel(k, Number(deltaRaw[k]), st, lg)
    smooth[k] = y
    stabilizer.lockedToZero[k] = ch.locked
    stabilizer.raw[k] = ch.raw
    stabilizer.smooth[k] = ch.smooth
    stabilizer.velocity[k] = ch.velocity
    stabilizer.alpha[k] = ch.alpha
  }
  return [smooth, stabilizer]
}

function applyLipCrossTalk(d, lg) {
  if (!lg.crossTalkSuppressionEnabled) return [{ ...d }, { suppressedUpper: false, suppressedLower: false }]
  const ratio = Math.max(1.001, safeFloat(lg.crossTalkRatio, 1.8))
  const passiveMax = Math.max(0, safeFloat(lg.crossTalkPassiveMax, 12))
  const atten = clamp(safeFloat(lg.crossTalkAttenuation, 0.25), 0, 1)
  const upperMag = Math.max(Math.abs(d.upperL), Math.abs(d.upperR))
  const lowerMag = Math.max(Math.abs(d.lowerL), Math.abs(d.lowerR))
  const out = { ...d }
  let suppressedUpper = false
  let suppressedLower = false
  if (upperMag > lowerMag * ratio && lowerMag < passiveMax) {
    out.lowerL *= atten
    out.lowerR *= atten
    suppressedLower = true
  }
  if (lowerMag > upperMag * ratio && upperMag < passiveMax) {
    out.upperL *= atten
    out.upperR *= atten
    suppressedUpper = true
  }
  return [out, { suppressedUpper, suppressedLower, upperMag, lowerMag, ratio }]
}

function processNeutralCalibration(st, lg, { currentY, pose, candidate, nowMs }) {
  if (st.neutral_ready) return [false, false, "ready"]
  const warmupNeed = Math.max(0, Math.trunc(lg.neutralWarmupFrames ?? 8))
  const nFrames = Math.max(1, Math.trunc(lg.neutralFrames ?? 30))
  if (!candidate) {
    st.neutral_stable_count = 0
    return [true, false, "waiting-stable-mouth"]
  }
  const wc = Math.trunc(st.neutral_warmup_count || 0)
  if (wc < warmupNeed) {
    st.neutral_warmup_count = wc + 1
    return [true, false, "warmup"]
  }
  const ns = st.neutral_sum
  for (const k of LIP_KEYS) ns[k] += currentY[k]
  ns.rollDeg += safeFloat(pose.rollDeg, 0)
  ns.yawProxy += safeFloat(pose.yawProxy, 0)
  ns.pitchProxy += safeFloat(pose.pitchProxy, 0)
  ns.faceScale += safeFloat(pose.faceScale, 0)
  const nc = Math.trunc(st.neutral_count || 0) + 1
  st.neutral_count = nc
  if (nc < nFrames) return [true, false, "calibrating"]
  const avgScale = ns.faceScale / nc
  st.neutral = {
    upperL: ns.upperL / nc,
    upperR: ns.upperR / nc,
    lowerL: ns.lowerL / nc,
    lowerR: ns.lowerR / nc,
    rollDeg: ns.rollDeg / nc,
    yawProxy: ns.yawProxy / nc,
    pitchProxy: ns.pitchProxy / nc,
    faceScale: avgScale > 1e-6 ? avgScale : 1,
  }
  st.neutral_ready = true
  st.neutral_mode = "ready"
  st.prev = axis4Zero()
  st.prev_raw = axis4Zero()
  st.locked_to_zero = { upperL: true, upperR: true, lowerL: true, lowerR: true }
  st.last_calibrated_at = nowMs
  st.neutral_stable_count = 0
  st.auto_calibrate_requested = false
  return [false, true, "just-completed"]
}

function zeroLipOutputs(mouth, mapping) {
  mouth.UL = 0
  mouth.UR = 0
  mouth.LL = 0
  mouth.LR = 0
  mapping.lipGeoUpperL = 0
  mapping.lipGeoUpperR = 0
  mapping.lipGeoLowerL = 0
  mapping.lipGeoLowerR = 0
  mapping.upperLipLeft = 0
  mapping.upperLipRight = 0
  mapping.lowerLipLeft = 0
  mapping.lowerLipRight = 0
}

function frameInfoFromRig({ rig, mapping, blend, mouthWidth, quality, faceDetected }) {
  const mouth = rig?.mouth && typeof rig.mouth === "object" ? rig.mouth : {}
  const sideL = mouth.sideL && typeof mouth.sideL === "object" ? mouth.sideL : {}
  const sideR = mouth.sideR && typeof mouth.sideR === "object" ? mouth.sideR : {}
  return {
    face_detected: Boolean(faceDetected),
    quality: Number(quality),
    mouth_width: Number(mouthWidth),
    jaw_val: safeFloat(rig?.jaw?.val, 0),
    smile_l: safeFloat(mapping?.smileLeft, 0),
    smile_r: safeFloat(mapping?.smileRight, 0),
    side_l_x: safeFloat(sideL.x, 50),
    side_l_y: safeFloat(sideL.y, 50),
    side_r_x: safeFloat(sideR.x, 50),
    side_r_y: safeFloat(sideR.y, 50),
    blend_jaw: safeFloat(blend?.jawOpen, 0),
  }
}

/**
 * @returns {{ mouth:{UL:number,UR:number,LL:number,LR:number}, mapping: object, debug: object, nextState: object, skipped: string }}
 */
export function applyLipGeometryDrive({
  landmarks,
  blendshapes = {},
  config,
  state,
  mapping: mappingIn,
  rig: rigIn,
  quality = 0,
  faceDetected = true,
  timestampMs = null,
  noseMotion = null,
  finalScenario = null,
  headMotionOutputScale = null,
  openCloseGuardActive = false,
  rawMouthScore = 0,
} = {}) {
  const mapCfg = normalizeMappingConfig(config)
  const lg = resolveLipCfg(config)
  const st = cloneDeepPlain(state && typeof state === "object" ? state : createLipGeometryState())
  if (!st.prev) st.prev = axis4Zero()
  if (!st.prev_raw) st.prev_raw = axis4Zero()
  if (!st.locked_to_zero) st.locked_to_zero = { upperL: true, upperR: true, lowerL: true, lowerR: true }
  if (!st.neutral) st.neutral = { ...axis4Zero(), rollDeg: 0, yawProxy: 0, pitchProxy: 0, faceScale: 0 }
  if (!st.neutral_sum) st.neutral_sum = { ...st.neutral }

  const mapping = mappingIn && typeof mappingIn === "object" ? { ...mappingIn } : {}
  const rig = rigIn && typeof rigIn === "object" ? cloneDeepPlain(rigIn) : { mouth: {}, jaw: { val: 0 } }
  if (!rig.mouth) rig.mouth = {}
  const mouth = rig.mouth
  const nowMs = timestampMs != null ? Number(timestampMs) : Date.now()
  const lipOn = mapCfg.lip?.enabled !== false
  const upperSign = lipSignFromConfig(lg, "upperSign", 1)
  const lowerSign = lipSignFromConfig(lg, "lowerSign", 1)
  const requireReady = lg.requireNeutralReadyForOutput !== false
  const blendTermSrc = blendshapeLipSignedDeltas(blendshapes, mapCfg)
  const blendTerm = {
    upperL: blendTermSrc.UL,
    upperR: blendTermSrc.UR,
    lowerL: blendTermSrc.LL,
    lowerR: blendTermSrc.LR,
  }

  const finish = (skipped, extra = {}) => {
    const dbg = {
      enabled: lg.enabled !== false,
      skipped: skipped || "",
      mouthWidth: extra.mouthWidth || 0,
      coordinateMode: extra.coordinateMode || "unknown",
      mouthScenario: extra.mouthScenario || "unknown",
      gateDecision: extra.gateDecision || { reason: skipped || "init" },
      deltaRaw: extra.deltaRaw || axis4Zero(),
      deltaSmooth: extra.deltaSmooth || axis4Zero(),
      rigWrite: extra.rigWrite || axis4Zero(),
      blendshapeTerm: blendTerm,
      neutralReady: Boolean(st.neutral_ready),
      neutralCount: Math.trunc(st.neutral_count || 0),
      noseAnchor: noseMotion && typeof noseMotion === "object" ? { ...noseMotion } : {},
      ...extra,
    }
    st.last_debug = dbg
    return {
      mouth: { UL: mouth.UL || 0, UR: mouth.UR || 0, LL: mouth.LL || 0, LR: mouth.LR || 0 },
      mapping,
      debug: dbg,
      nextState: st,
      skipped: skipped || "",
      rig,
    }
  }

  if (!lipOn) {
    zeroLipOutputs(mouth, mapping)
    return finish("lip-disabled")
  }
  if (lg.enabled === false) {
    mouth.UL = blendTerm.upperL
    mouth.UR = blendTerm.upperR
    mouth.LL = blendTerm.lowerL
    mouth.LR = blendTerm.lowerR
    mapping.upperLipLeft = blendTerm.upperL
    mapping.upperLipRight = blendTerm.upperR
    mapping.lowerLipLeft = blendTerm.lowerL
    mapping.lowerLipRight = blendTerm.lowerR
    return finish("lipGeometry-disabled", { rigWrite: blendTerm })
  }
  if (!Array.isArray(landmarks) || !landmarks.length) {
    zeroLipOutputs(mouth, mapping)
    return finish("no-landmarks")
  }

  let frame
  let mouthWidth
  let coordinateMode
  let currentPose
  let yAxisTowardChin
  if (lg.poseAwareFrameEnabled !== false) {
    const pf = buildMouthPoseFrame(landmarks, lg)
    if (pf.ok) {
      frame = pf
      mouthWidth = safeFloat(pf.mouthWidth, 0)
      coordinateMode = String(pf.coordinateMode || "unknown")
      currentPose = { ...(pf.pose || {}) }
      yAxisTowardChin = Boolean(pf.yAxisTowardChin)
    }
  }
  if (!frame) {
    const fb = buildMouthFrame2d(landmarks, lg)
    frame = fb.frame
    mouthWidth = fb.mouthWidth
    coordinateMode = "2d_fallback"
    yAxisTowardChin = Boolean(frame?.yAxisTowardChin)
    currentPose = { rollDeg: 0, yawProxy: 0, pitchProxy: 0, faceScale: Number(mouthWidth) }
  }
  if (!frame) {
    zeroLipOutputs(mouth, mapping)
    return finish("mouth-frame-invalid", { mouthWidth, coordinateMode, pose: currentPose })
  }

  const py = frame.projectY
  const upperLPt = avgPoint3(landmarks, lg.upperLeftIndices)
  const upperRPt = avgPoint3(landmarks, lg.upperRightIndices)
  const lowerLPt = avgPoint3(landmarks, lg.lowerLeftIndices)
  const lowerRPt = avgPoint3(landmarks, lg.lowerRightIndices)
  if (!upperLPt || !upperRPt || !lowerLPt || !lowerRPt) {
    zeroLipOutputs(mouth, mapping)
    return finish("lip-points-missing", { mouthWidth, coordinateMode, pose: currentPose })
  }
  const currentY = {
    upperL: py(upperLPt),
    upperR: py(upperRPt),
    lowerL: py(lowerLPt),
    lowerR: py(lowerRPt),
  }
  const jgc = config?.jawGeometry && typeof config.jawGeometry === "object" ? config.jawGeometry : {}
  const upperInnerPt = readPoint3(landmarks, Math.trunc(jgc.upperInnerIndex ?? 13))
  const lowerInnerPt = readPoint3(landmarks, Math.trunc(jgc.lowerInnerIndex ?? 14))
  let apertureCurrent = null
  let upperInnerY = null
  let lowerInnerY = null
  if (upperInnerPt && lowerInnerPt) {
    upperInnerY = py(upperInnerPt)
    lowerInnerY = py(lowerInnerPt)
    apertureCurrent = lowerInnerY - upperInnerY
  }

  const frameInfo = frameInfoFromRig({
    rig,
    mapping,
    blend: blendshapes,
    mouthWidth,
    quality,
    faceDetected,
  })
  const candidate = isLipNeutralCandidate(frameInfo, lg)
  const [stillCal, justDone, calHint] = processNeutralCalibration(st, lg, {
    currentY,
    pose: currentPose,
    candidate,
    nowMs,
  })
  const neuY = st.neutral_ready ? axis4Copy(st.neutral) : axis4Zero()
  const poseNeutral = {
    rollDeg: safeFloat(st.neutral?.rollDeg, 0),
    yawProxy: safeFloat(st.neutral?.yawProxy, 0),
    pitchProxy: safeFloat(st.neutral?.pitchProxy, 0),
    faceScale: safeFloat(st.neutral?.faceScale, 0),
  }

  if (stillCal || justDone || (requireReady && !st.neutral_ready)) {
    zeroLipOutputs(mouth, mapping)
    const skip = stillCal ? "neutral-calibrating" : justDone ? "neutral-just-completed" : "neutral-not-ready"
    return finish(`${skip}:${calHint}`, {
      mouthWidth,
      currentY,
      neutralY: neuY,
      coordinateMode,
      pose: currentPose,
      poseNeutral,
    })
  }

  let neu = st.neutral
  const upperGain = safeFloat(lg.upperGain, 900)
  const lowerGain = safeFloat(lg.lowerGain, 900)
  const prevSmooth = axis4Copy(st.prev)
  if (isLipNeutralCandidate(frameInfo, lg)) st.neutral_stable_count = Math.trunc(st.neutral_stable_count || 0) + 1
  else {
    st.neutral_stable_count = 0
    st.drift_hold_reason = "not-neutral-candidate"
  }

  let poseGate = evaluateMouthPoseGate(currentPose, poseNeutral, lg)
  let driftAllowed
  let driftReason
  if (poseGate.active) {
    driftAllowed = false
    driftReason = "pose-gate-active"
  } else {
    ;[driftAllowed, driftReason] = isLipDriftUpdateAllowed({
      st,
      lg,
      frameInfo,
      deltaSmooth: prevSmooth,
      nowMs,
    })
  }
  const driftDbg = {
    enabled: lg.driftCorrectionEnabled !== false,
    allowed: driftAllowed,
    updated: false,
    reason: driftReason,
    stepUpperL: 0,
    stepUpperR: 0,
    stepLowerL: 0,
    stepLowerR: 0,
  }
  if (driftAllowed) {
    const steps = applyDriftCorrection(st, lg, currentY, nowMs)
    driftDbg.updated = true
    driftDbg.stepUpperL = steps.upperL
    driftDbg.stepUpperR = steps.upperR
    driftDbg.stepLowerL = steps.lowerL
    driftDbg.stepLowerR = steps.lowerR
    neu = st.neutral
  }

  const deltaRaw = {
    upperL: geoDeltaRaw(neu.upperL, currentY.upperL, upperGain, upperSign),
    upperR: geoDeltaRaw(neu.upperR, currentY.upperR, upperGain, upperSign),
    lowerL: geoDeltaRaw(neu.lowerL, currentY.lowerL, lowerGain, lowerSign),
    lowerR: geoDeltaRaw(neu.lowerR, currentY.lowerR, lowerGain, lowerSign),
  }
  const [deltaAfterGain, lipPipeline] = processLipPreGatePipeline(deltaRaw, lg)
  let deltaAfterPoseGate = { ...deltaAfterGain }
  const mouthMotionEvidence = Math.max(
    Math.abs(deltaRaw.upperL),
    Math.abs(deltaRaw.upperR),
    Math.abs(deltaRaw.lowerL),
    Math.abs(deltaRaw.lowerR),
  )
  const jawAbs = Math.abs(safeFloat(rig.jaw?.val, 0))
  const yawDelta = Math.abs(safeFloat(poseGate.yawDelta, 0))
  const pitchDelta = Math.abs(safeFloat(poseGate.pitchDelta, 0))
  const rollDelta = Math.abs(safeFloat(poseGate.rollDelta, 0))
  const scaleDelta = Math.abs(safeFloat(poseGate.scaleDelta, 0))
  const oldMouthPoseHeadMotionActive =
    yawDelta > safeFloat(lg.headMotionYawThreshold, 0.025) ||
    pitchDelta > safeFloat(lg.headMotionPitchThreshold, 0.045) ||
    rollDelta > safeFloat(lg.headMotionRollThresholdDeg, 5) ||
    scaleDelta > safeFloat(lg.headMotionScaleThreshold, 0.025)

  const noseDbg = noseMotion && typeof noseMotion === "object" ? noseMotion : {}
  const noseReady = Boolean(noseDbg.neutralReady)
  const noseEnabled = Boolean(noseDbg.enabled ?? true) && Boolean(Object.keys(noseDbg).length) && "motionActive" in noseDbg
  const noseAnchorMotion = noseEnabled && noseReady ? Boolean(noseDbg.motionActive) : false
  const headMotionActive = noseEnabled && noseReady ? noseAnchorMotion : oldMouthPoseHeadMotionActive

  const apertureAvailable = apertureCurrent != null && neu && "aperture" in neu
  const apertureDeltaAbs = apertureAvailable ? Math.abs(apertureCurrent - safeFloat(neu.aperture, 0)) : null
  const useApertureEvidence = lg.closedHeadTurnUseApertureEvidence !== false
  const apThr = safeFloat(lg.closedHeadTurnApertureDeltaMax, 0.018)
  const apertureOk = !useApertureEvidence || !apertureAvailable || safeFloat(apertureDeltaAbs, 0) < apThr

  const mouthOpenAvailable = blendshapes && "mouthOpen" in blendshapes
  const mouthOpenBs = mouthOpenAvailable
    ? Math.abs((safeFloat(blendshapes.mouthOpen, 0) - safeFloat(mapCfg.neutral.mouthOpen, 0)) * 100)
    : 0
  const jawOpenBs = Math.abs((safeFloat(blendshapes.jawOpen, 0) - safeFloat(mapCfg.neutral.jawOpen, 0)) * 100)
  const smileAbs = Math.max(Math.abs(safeFloat(mapping.smileLeft, 0)), Math.abs(safeFloat(mapping.smileRight, 0)))
  const useBlendEvidence = lg.closedHeadTurnUseBlendshapeEvidence !== false
  const mouthOpenThr = safeFloat(lg.closedHeadTurnMouthOpenMax, 12)
  const jawOpenThr = safeFloat(lg.closedHeadTurnJawOpenMax, 12)
  const smileThr = safeFloat(lg.closedHeadTurnSmileMax, 18)
  const blendshapeAvailable =
    mouthOpenAvailable || "jawOpen" in (blendshapes || {}) || "smileLeft" in mapping || "smileRight" in mapping
  const blendshapeOk =
    !useBlendEvidence ||
    !blendshapeAvailable ||
    ((!mouthOpenAvailable || mouthOpenBs < mouthOpenThr) && jawOpenBs < jawOpenThr && smileAbs < smileThr)

  const sideL = mouth.sideL && typeof mouth.sideL === "object" ? mouth.sideL : null
  const sideR = mouth.sideR && typeof mouth.sideR === "object" ? mouth.sideR : null
  const cornerAvailable = sideL != null && sideR != null
  let cornerOffsetAbs = 0
  if (cornerAvailable) {
    cornerOffsetAbs = Math.max(
      Math.abs(safeFloat(sideL.x, 50) - 50),
      Math.abs(safeFloat(sideL.y, 50) - 50),
      Math.abs(safeFloat(sideR.x, 50) - 50),
      Math.abs(safeFloat(sideR.y, 50) - 50),
    )
  }
  const useCornerEvidence = lg.closedHeadTurnUseCornerEvidence !== false
  const cornerThr = safeFloat(lg.closedHeadTurnCornerOffsetMax, 18)
  const cornerOk = !useCornerEvidence || !cornerAvailable || cornerOffsetAbs < cornerThr
  let closedMouthLike =
    jawAbs < safeFloat(lg.closedHeadTurnJawAbsMax, 8) && apertureOk && blendshapeOk && cornerOk
  const lipVetoOn = Boolean(lg.closedHeadTurnUseLipAbsAsVeto)
  const lipVetoTriggered = lipVetoOn && mouthMotionEvidence > safeFloat(lg.closedHeadTurnLipVetoAbsMax, 35)
  if (lipVetoTriggered) closedMouthLike = false

  const apertureDeltaScaled = safeFloat(apertureDeltaAbs, 0) * 300
  const mouthMotionScore = Math.max(
    mouthMotionEvidence,
    jawAbs,
    apertureDeltaScaled,
    mouthOpenBs,
    jawOpenBs,
    cornerOffsetAbs,
  )

  let mouthScenario
  if (finalScenario != null) mouthScenario = String(finalScenario)
  else {
    const msc = config?.mouthScenario && typeof config.mouthScenario === "object" ? config.mouthScenario : {}
    const frontalThr = Math.max(
      0,
      safeFloat(msc.frontalMouthMotionThreshold ?? lg.frontalMouthMotionThreshold, 4),
    )
    const neutralThr = Math.max(0, safeFloat(msc.neutralThreshold ?? lg.neutralThreshold, 2))
    if (!headMotionActive && mouthMotionScore < neutralThr) mouthScenario = "neutral_still"
    else if (headMotionActive && mouthMotionScore < frontalThr) mouthScenario = "closed_head_turn"
    else if (!headMotionActive && mouthMotionScore >= frontalThr) mouthScenario = "frontal_mouth_motion"
    else mouthScenario = "unknown"
  }

  const closedHeadLockActive =
    lg.closedHeadTurnLockEnabled !== false && Boolean(st.neutral_ready) && mouthScenario === "closed_head_turn"

  let poseSuppressedLip = false
  let gateDecision
  if (closedHeadLockActive) {
    const zeroVal = safeFloat(lg.closedHeadTurnOutputClamp, 0)
    deltaAfterPoseGate = { upperL: zeroVal, upperR: zeroVal, lowerL: zeroVal, lowerR: zeroVal }
    if (lg.closedHeadTurnResetPrev !== false) {
      st.prev = axis4Zero()
      st.prev_raw = axis4Zero()
    }
    for (const k of LIP_KEYS) st.locked_to_zero[k] = true
    driftDbg.allowed = false
    driftDbg.reason = "closed-head-turn-lock"
    gateDecision = {
      finalScenario: String(mouthScenario),
      closedHeadTurnLockApplied: true,
      poseGateSuppressionApplied: false,
      frontalPassThrough: false,
      reason: "closed-head-turn-lock",
    }
  } else if (mouthScenario === "frontal_mouth_motion") {
    deltaAfterPoseGate = { ...deltaAfterGain }
    gateDecision = {
      finalScenario: String(mouthScenario),
      closedHeadTurnLockApplied: false,
      poseGateSuppressionApplied: false,
      frontalPassThrough: true,
      reason: "frontal-pass-through",
    }
  } else if (mouthScenario === "head_motion_mouth_motion") {
    const msc = config?.mouthScenario && typeof config.mouthScenario === "object" ? config.mouthScenario : {}
    const hmScale =
      headMotionOutputScale != null
        ? clamp(Number(headMotionOutputScale), 0, 1)
        : clamp(safeFloat(msc.headMotionMouthLipScale ?? msc.headMotionLipSuppressScale, 0.95), 0, 1)
    deltaAfterPoseGate = {}
    for (const k of LIP_KEYS) deltaAfterPoseGate[k] = Number(deltaAfterGain[k]) * hmScale
    poseSuppressedLip = true
    gateDecision = {
      finalScenario: String(mouthScenario),
      closedHeadTurnLockApplied: false,
      poseGateSuppressionApplied: true,
      frontalPassThrough: false,
      headMotionMouthSuppressScale: hmScale,
      openCloseGuardScale: headMotionOutputScale != null,
      reason: "head-motion-mouth-motion",
    }
  } else if (mouthScenario === "neutral_still") {
    deltaAfterPoseGate = { ...deltaAfterGain }
    gateDecision = {
      finalScenario: String(mouthScenario),
      closedHeadTurnLockApplied: false,
      poseGateSuppressionApplied: false,
      frontalPassThrough: false,
      reason: "neutral-still",
    }
  } else {
    const suppressScale = clamp(safeFloat(lg.poseMotionSuppressScale, 0.2), 0, 1)
    const clampAbs = Math.max(0, safeFloat(lg.poseGateOutputClamp, 5))
    deltaAfterPoseGate = {}
    for (const k of LIP_KEYS) {
      deltaAfterPoseGate[k] = clamp(Number(deltaAfterGain[k]) * suppressScale, -clampAbs, clampAbs)
    }
    poseSuppressedLip = true
    gateDecision = {
      finalScenario: String(mouthScenario),
      closedHeadTurnLockApplied: false,
      poseGateSuppressionApplied: true,
      frontalPassThrough: false,
      reason: "unknown-conservative",
    }
  }
  poseGate = { ...poseGate, suppressedLip: poseSuppressedLip, mouthMotionEvidence }

  const [gated, scenarioBlendDbg] = applyScenarioGateBlend(st, deltaAfterPoseGate, mouthScenario, lg)
  deltaAfterPoseGate = gated
  gateDecision = { ...gateDecision, scenarioBlend: scenarioBlendDbg }
  lipPipeline.afterGate = { ...deltaAfterPoseGate }

  let deltaGeo = { ...deltaAfterPoseGate }
  const jNorm = jawOpenNorm(blendshapes, mapCfg.neutral)
  const ocFastRelease = maybeArmOpenCloseFastRelease(st, lg, {
    jawNorm: jNorm,
    openCloseGuardActive: Boolean(openCloseGuardActive),
    rawMouthScore: Number(rawMouthScore),
  })
  const [maxLipCtrl, lipCapDbg] = resolveMaxLipControlAbs(jNorm, lg, {
    openCloseGuardActive: Boolean(openCloseGuardActive),
    rawMouthScore: Number(rawMouthScore),
  })
  deltaGeo = capLipChannels(deltaGeo, maxLipCtrl)
  const [deltaXtalk, xtDbg] = applyLipCrossTalk(deltaGeo, lg)
  const lgStab = { ...lg, deadzone: 0 }
  let [deltaSmooth, stabilizer] = stabilizeAllChannels(deltaXtalk, st, lgStab)
  deltaSmooth = capLipChannels(deltaSmooth, maxLipCtrl)
  st.fast_release_lip = false
  lipPipeline.afterSmooth = { ...deltaSmooth }
  lipPipeline.final = { ...deltaSmooth }
  lipPipeline.lipControlCap = { ...lipCapDbg, openCloseFastReleaseActive: Boolean(ocFastRelease) }

  const mix = clamp(safeFloat(lg.blendshapeMix, 0.08), 0, 1)
  const wGeo = 1 - mix
  const rigWriteRaw = {
    upperL: clampSigned100(deltaSmooth.upperL * wGeo + blendTerm.upperL * mix),
    upperR: clampSigned100(deltaSmooth.upperR * wGeo + blendTerm.upperR * mix),
    lowerL: clampSigned100(deltaSmooth.lowerL * wGeo + blendTerm.lowerL * mix),
    lowerR: clampSigned100(deltaSmooth.lowerR * wGeo + blendTerm.lowerR * mix),
  }
  const rigWriteFinal = finalizeMouthRigWrite(rigWriteRaw, lg)
  mouth.UL = rigWriteFinal.UL
  mouth.UR = rigWriteFinal.UR
  mouth.LL = rigWriteFinal.LL
  mouth.LR = rigWriteFinal.LR
  mapping.lipGeoUpperL = deltaSmooth.upperL
  mapping.lipGeoUpperR = deltaSmooth.upperR
  mapping.lipGeoLowerL = deltaSmooth.lowerL
  mapping.lipGeoLowerR = deltaSmooth.lowerR
  mapping.upperLipLeft = mouth.UL
  mapping.upperLipRight = mouth.UR
  mapping.lowerLipLeft = mouth.LL
  mapping.lowerLipRight = mouth.LR

  const rigWrite = { upperL: mouth.UL, upperR: mouth.UR, lowerL: mouth.LL, lowerR: mouth.LR }
  return finish("", {
    mouthWidth,
    currentY,
    neutralY: axis4Copy(neu),
    deltaRaw,
    deltaAfterPoseGate,
    deltaSmooth,
    rigWrite,
    coordinateMode,
    pose: currentPose,
    poseNeutral,
    poseGate,
    mouthScenario,
    gateDecision,
    driftCorrection: driftDbg,
    stabilizer,
    crossTalk: xtDbg,
    lipPipeline,
    yAxisTowardChin,
    closedMouthLike,
    lipVetoTriggered,
    mouthMotionScore,
    upperInnerY,
    lowerInnerY,
    apertureCurrent,
  })
}

export function computeLipRawEvidence({ landmarks, config, state } = {}) {
  const lg = resolveLipCfg(config)
  const st = state && typeof state === "object" ? state : {}
  const out = {
    lipAbsMax: 0,
    available: { lip: false },
    pose: { rollDeg: 0, yawProxy: 0, pitchProxy: 0, faceScale: 0 },
    poseNeutral: { rollDeg: 0, yawProxy: 0, pitchProxy: 0, faceScale: 0 },
    mouthPoseMotionScore: 0,
  }
  if (!st.neutral_ready) return out
  if (!Array.isArray(landmarks)) return out
  let frame
  let currentPose
  if (lg.poseAwareFrameEnabled !== false) {
    const pf = buildMouthPoseFrame(landmarks, lg)
    if (pf.ok) {
      frame = pf
      currentPose = { ...(pf.pose || {}) }
    }
  }
  if (!frame) {
    const fb = buildMouthFrame2d(landmarks, lg)
    frame = fb.frame
    currentPose = { rollDeg: 0, yawProxy: 0, pitchProxy: 0, faceScale: Number(fb.mouthWidth || 0) }
  }
  if (!frame) return out
  const py = frame.projectY
  const upperLPt = avgPoint3(landmarks, lg.upperLeftIndices)
  const upperRPt = avgPoint3(landmarks, lg.upperRightIndices)
  const lowerLPt = avgPoint3(landmarks, lg.lowerLeftIndices)
  const lowerRPt = avgPoint3(landmarks, lg.lowerRightIndices)
  if (!upperLPt || !upperRPt || !lowerLPt || !lowerRPt) return out
  const currentY = {
    upperL: py(upperLPt),
    upperR: py(upperRPt),
    lowerL: py(lowerLPt),
    lowerR: py(lowerRPt),
  }
  const neu = st.neutral || {}
  const upperGain = safeFloat(lg.upperGain, 900)
  const lowerGain = safeFloat(lg.lowerGain, 900)
  const upperSign = lipSignFromConfig(lg, "upperSign", 1)
  const lowerSign = lipSignFromConfig(lg, "lowerSign", 1)
  const deltaRaw = {
    upperL: geoDeltaRaw(safeFloat(neu.upperL, 0), currentY.upperL, upperGain, upperSign),
    upperR: geoDeltaRaw(safeFloat(neu.upperR, 0), currentY.upperR, upperGain, upperSign),
    lowerL: geoDeltaRaw(safeFloat(neu.lowerL, 0), currentY.lowerL, lowerGain, lowerSign),
    lowerR: geoDeltaRaw(safeFloat(neu.lowerR, 0), currentY.lowerR, lowerGain, lowerSign),
  }
  const lipAbsMax = Math.max(
    Math.abs(deltaRaw.upperL),
    Math.abs(deltaRaw.upperR),
    Math.abs(deltaRaw.lowerL),
    Math.abs(deltaRaw.lowerR),
  )
  const poseNeutral = {
    rollDeg: safeFloat(neu.rollDeg, 0),
    yawProxy: safeFloat(neu.yawProxy, 0),
    pitchProxy: safeFloat(neu.pitchProxy, 0),
    faceScale: safeFloat(neu.faceScale, 0),
  }
  const ns = Math.max(1e-6, safeFloat(poseNeutral.faceScale, 1))
  const mouthPoseMotionScore = Math.max(
    Math.abs(safeFloat(currentPose.yawProxy, 0) - poseNeutral.yawProxy),
    Math.abs(safeFloat(currentPose.pitchProxy, 0) - poseNeutral.pitchProxy),
    Math.abs(safeFloat(currentPose.faceScale, ns) - ns) / ns,
    Math.abs(safeFloat(currentPose.rollDeg, 0) - poseNeutral.rollDeg) / 40,
  )
  return {
    lipAbsMax,
    deltaRaw,
    available: { lip: true },
    pose: currentPose,
    poseNeutral,
    mouthPoseMotionScore,
  }
}
