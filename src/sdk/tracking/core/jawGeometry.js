/**
 * Jaw Geometry V3 — port of tools/tracking_service/jaw_geometry.py
 * Default-path: pose frame → aperture/inner/center deltas → curve → scenario gate → stabilize.
 */

import {
  avgPoint3,
  buildMouthPoseFrame,
  cloneDeepPlain,
  evaluateMouthPoseGate,
  mergeNumericConfig,
  readPoint3,
  v3Norm,
  v3Sub,
} from "./geomMath.js"
import { isLipNeutralCandidate } from "./lipGeometry.js"
import { clamp, clampSigned100, safeFloat, semanticStrengthBase } from "./trackingMath.js"

const DEFAULT_JAW_GEOMETRY = Object.freeze({
  enabled: true,
  neutralFrames: 30,
  neutralWarmupFrames: 8,
  minMouthWidth: 0.03,
  neutralTrackMinQuality: 0.5,
  neutralMaxJawBlend: 8,
  neutralMaxSmile: 12,
  neutralMaxSideOffset: 10,
  jawOutputSign: -1,
  use3dLocalCoordinate: true,
  useChinAsPrimary: false,
  chinWeight: 0,
  apertureGain: 920,
  lowerInnerGain: 520,
  lowerLipCenterGain: 280,
  blendshapeMix: 0.08,
  apertureWeight: 0.5,
  lowerInnerWeight: 0.35,
  lowerLipCenterWeight: 0.15,
  upperLipOpenCompensation: 0.55,
  poseGateEnabled: true,
  maxYawProxyDelta: 0.1,
  maxPitchProxyDelta: 0.1,
  maxRollDeltaDeg: 12,
  maxFaceScaleDelta: 0.18,
  poseMotionSuppressScale: 0.25,
  deadzone: 2.0,
  snapToZero: 2.0,
  alphaSlow: 0.3,
  alphaFast: 0.96,
  fastDelta: 5.0,
  maxStepPerFrame: 22,
  outputHoldDeadband: 1.4,
  outputReleaseThreshold: 2.6,
  inputDeadzone: 2.0,
  smallEnd: 18,
  midEnd: 60,
  largeEnd: 110,
  smallOutput: 12,
  midOutput: 65,
  maxOutput: 105,
  curvePowerSmall: 1.15,
  curvePowerMid: 1.45,
  curvePowerLarge: 1.1,
  openSlewLimit: 20,
  closeSlewLimit: 24,
  smallOpenSlewLimit: 12,
  largeOpenSlewLimit: 28,
  alphaOpen: 0.48,
  alphaClose: 0.62,
  curveDeadzoneInput: 2.0,
  curveSmallKneeInput: 12.0,
  curveSmallOutput: 8.5,
  curveFullInput: 38.0,
  curveMaxOutput: 108.0,
  closedHeadTurnResetPrev: true,
  jawBlendshapeName: "jawOpen",
  leftCornerIndex: 61,
  rightCornerIndex: 291,
  upperInnerIndex: 13,
  lowerInnerIndex: 14,
  upperOuterIndex: 0,
  lowerOuterIndex: 17,
  chinIndex: 152,
  noseTipIndex: 1,
  foreheadIndex: 10,
  lowerLipCenterIndices: Object.freeze([14, 17, 87, 317]),
})

function zeroNeutral() {
  return {
    aperture: 0,
    lowerInnerY: 0,
    lowerLipCenterY: 0,
    poseRollDeg: 0,
    poseYawProxy: 0,
    posePitchProxy: 0,
    faceScale: 0,
  }
}

export function createJawGeometryState() {
  return {
    neutral_ready: false,
    neutral_mode: "idle",
    neutral_count: 0,
    neutral_warmup_count: 0,
    neutral_sum: zeroNeutral(),
    neutral: zeroNeutral(),
    prev: 0,
    locked_to_zero: true,
    last_calibrated_at: 0,
    last_debug: {},
  }
}

export function resetJawGeometryState(state) {
  const fresh = createJawGeometryState()
  if (state && typeof state === "object") {
    for (const k of Object.keys(state)) delete state[k]
    Object.assign(state, createJawGeometryState())
    return state
  }
  return fresh
}

export function startJawNeutralCalibration(state, reason = "manual") {
  if (!state || typeof state !== "object") return
  resetJawGeometryState(state)
  const auto = ["startCameraTracking", "autoLipNeutralOnStart", "auto_start", "mouthNeutral"]
  state.neutral_mode = auto.includes(String(reason)) ? "auto_start" : "manual"
  state.neutral_ready = false
}

export function normalizeJawGeometryConfig(raw) {
  const defaults = {
    ...DEFAULT_JAW_GEOMETRY,
    lowerLipCenterIndices: DEFAULT_JAW_GEOMETRY.lowerLipCenterIndices.slice(),
  }
  return mergeNumericConfig(defaults, raw && typeof raw === "object" ? raw : null)
}

function resolveJawCfg(config) {
  if (config && typeof config === "object" && config.jawGeometry) {
    return normalizeJawGeometryConfig(config.jawGeometry)
  }
  if (config && typeof config === "object" && "apertureGain" in config) {
    return normalizeJawGeometryConfig(config)
  }
  return normalizeJawGeometryConfig(null)
}

function applyCurve(xIn, jg) {
  const x = Math.max(0, Number(xIn))
  const dz = Math.max(0, safeFloat(jg.inputDeadzone ?? jg.curveDeadzoneInput, 2))
  const smallEnd = Math.max(dz + 1e-6, safeFloat(jg.smallEnd, 18))
  const midEnd = Math.max(smallEnd + 1e-6, safeFloat(jg.midEnd, 55))
  const largeEnd = Math.max(midEnd + 1e-6, safeFloat(jg.largeEnd, 100))
  const smallO = Math.max(0, safeFloat(jg.smallOutput, 12))
  const midO = Math.max(smallO, safeFloat(jg.midOutput, 55))
  const maxO = Math.max(midO, safeFloat(jg.maxOutput ?? jg.curveMaxOutput, 88))
  const pSmall = Math.max(0.1, safeFloat(jg.curvePowerSmall, 1.2))
  const pMid = Math.max(0.1, safeFloat(jg.curvePowerMid, 1.6))
  const pLarge = Math.max(0.1, safeFloat(jg.curvePowerLarge, 1.1))
  let y
  let segment
  if (x <= dz) {
    y = 0
    segment = "deadzone"
  } else if (x <= smallEnd) {
    const t = (x - dz) / (smallEnd - dz)
    y = smallO * t ** pSmall
    segment = "small"
  } else if (x <= midEnd) {
    const t = (x - smallEnd) / (midEnd - smallEnd)
    y = smallO + (midO - smallO) * t ** pMid
    segment = "mid"
  } else {
    const t = clamp((x - midEnd) / (largeEnd - midEnd), 0, 1)
    y = midO + (maxO - midO) * t ** pLarge
    segment = "large"
  }
  y = clamp(y, 0, maxO)
  return [
    y,
    {
      rawInput: x,
      afterDeadzone: x <= dz ? 0 : x,
      afterCurve: y,
      segment,
      inputDeadzone: dz,
      smallEnd,
      midEnd,
      largeEnd,
      smallOutput: smallO,
      midOutput: midO,
      maxOutput: maxO,
    },
  ]
}

function pickJawSlewLimit(target, prev, jg) {
  const targetAbs = Math.abs(Number(target))
  const prevAbs = Math.abs(Number(prev))
  const openSlew = Math.max(1e-6, safeFloat(jg.openSlewLimit, 10))
  const closeSlew = Math.max(1e-6, safeFloat(jg.closeSlewLimit, 14))
  const smallOpen = Math.max(1e-6, safeFloat(jg.smallOpenSlewLimit, 5))
  const largeOpen = Math.max(1e-6, safeFloat(jg.largeOpenSlewLimit, 12))
  if (targetAbs < 15) return smallOpen
  if (targetAbs > prevAbs) return targetAbs >= 55 ? largeOpen : openSlew
  return closeSlew
}

function stabilize(raw, st, jg) {
  const prev = safeFloat(st.prev, 0)
  let locked = Boolean(st.locked_to_zero ?? true)
  const hold = Math.max(0, safeFloat(jg.outputHoldDeadband, 1.4))
  const release = Math.max(hold, safeFloat(jg.outputReleaseThreshold, 2.6))
  const snap = Math.max(0, safeFloat(jg.snapToZero, 2))
  const dz = Math.max(0, safeFloat(jg.deadzone, 2))
  const alphaOpen = clamp(safeFloat(jg.alphaOpen, 0.38), 0, 1)
  const alphaClose = clamp(safeFloat(jg.alphaClose, 0.55), 0, 1)
  const adj = Math.abs(raw) < dz ? 0 : Number(raw)
  let target
  if (locked) {
    if (Math.abs(adj) >= release) {
      locked = false
      target = adj
    } else {
      target = 0
    }
  } else if (Math.abs(adj) < hold) {
    locked = true
    target = 0
  } else {
    target = adj
  }
  const opening = Math.abs(target) >= Math.abs(prev)
  const alpha = opening ? alphaOpen : alphaClose
  let smooth = prev + alpha * (target - prev)
  const maxStep = pickJawSlewLimit(target, prev, jg)
  const step = clamp(smooth - prev, -maxStep, maxStep)
  const clipped = Math.abs(smooth - prev - step) > 1e-9
  smooth = prev + step
  if (Math.abs(smooth) < snap) {
    smooth = 0
    locked = true
  }
  st.prev = smooth
  st.locked_to_zero = Boolean(locked)
  return [
    smooth,
    {
      raw: Number(raw),
      target,
      smooth,
      alpha,
      effectiveStep: step,
      slewLimit: maxStep,
      slewDelta: step,
      slewClipped: clipped,
      lockedToZero: Boolean(locked),
    },
  ]
}

function neutralDbg(st) {
  return {
    mode: String(st.neutral_mode || "idle"),
    neutralReady: Boolean(st.neutral_ready),
    neutralCount: Math.trunc(st.neutral_count || 0),
    neutralWarmupCount: Math.trunc(st.neutral_warmup_count || 0),
    lastCalibratedAt: safeFloat(st.last_calibrated_at, 0),
  }
}

function jawBlendshape(blend, cfg, jg) {
  const name = jg.jawBlendshapeName || "jawOpen"
  const dzJ = safeFloat(cfg?.deadzone?.jaw, 0.03)
  const gain = safeFloat(cfg?.gains?.jaw, 1)
  const neu = safeFloat(cfg?.neutral?.[name], 0)
  return semanticStrengthBase(safeFloat(blend?.[name], 0) - neu, {
    deadzoneThr: dzJ,
    gain,
    limLo: 0,
    limHi: 100,
  })
}

function computeJawComponents(landmarks, frame, jg) {
  const ui = Math.trunc(jg.upperInnerIndex ?? 13)
  const loi = Math.trunc(jg.lowerInnerIndex ?? 14)
  const up = readPoint3(landmarks, ui)
  const lo = readPoint3(landmarks, loi)
  const lowerCenter = avgPoint3(landmarks, jg.lowerLipCenterIndices || [14, 17, 87, 317])
  if (!up || !lo || !lowerCenter) return null
  const py = frame.projectY
  return {
    upperY: py(up),
    lowerInnerY: py(lo),
    lowerCenterY: py(lowerCenter),
    aperture: py(lo) - py(up),
  }
}

function jawInputFromDeltas(aperture, lowerInnerY, lowerCenterY, n, jg) {
  const apertureDelta = Math.max(0, aperture - safeFloat(n.aperture, 0))
  const lowerInnerDelta = Math.max(0, lowerInnerY - safeFloat(n.lowerInnerY, 0))
  const lowerCenterDelta = Math.max(0, lowerCenterY - safeFloat(n.lowerLipCenterY, 0))
  const upperOpen = Math.max(0, safeFloat(n.lowerInnerY, 0) - lowerInnerY)
  const jawAperture = apertureDelta * safeFloat(jg.apertureGain, 620)
  const jawLowerInner = lowerInnerDelta * safeFloat(jg.lowerInnerGain, 520)
  const jawLowerCenter = lowerCenterDelta * safeFloat(jg.lowerLipCenterGain, 280)
  const jawApComp = Math.max(0, jawAperture - upperOpen * safeFloat(jg.upperLipOpenCompensation, 0.55))
  const jawInput =
    safeFloat(jg.apertureWeight, 0.5) * jawApComp +
    safeFloat(jg.lowerInnerWeight, 0.35) * jawLowerInner +
    safeFloat(jg.lowerLipCenterWeight, 0.15) * jawLowerCenter
  return { jawInput, jawAperture, jawLowerInner, jawLowerCenter, jawApComp }
}

/**
 * @returns {{ jaw:{val:number}, mapping: object, debug: object, nextState: object }}
 */
export function applyJawGeometryDrive({
  landmarks,
  blendshapes = {},
  config,
  state,
  mapping: mappingIn,
  rig: rigIn,
  quality = 0,
  faceDetected = true,
  timestampMs = null,
  lipNeutralReady = true,
  noseMotion = null,
  finalScenario = null,
  headMotionOutputScale = null,
} = {}) {
  const jg = resolveJawCfg(config)
  const st = cloneDeepPlain(state && typeof state === "object" ? state : createJawGeometryState())
  if (!st.neutral_sum) st.neutral_sum = zeroNeutral()
  if (!st.neutral) st.neutral = zeroNeutral()
  const mapping = mappingIn && typeof mappingIn === "object" ? { ...mappingIn } : {}
  const rig = rigIn && typeof rigIn === "object" ? cloneDeepPlain(rigIn) : { jaw: { val: 0 }, mouth: {} }
  if (!rig.jaw) rig.jaw = { val: 0 }

  const nowMs = timestampMs != null ? Number(timestampMs) : Date.now()
  const jawSign = safeFloat(jg.jawOutputSign, -1) < 0 ? -1 : 1
  const jawBs = jawBlendshape(blendshapes, config, jg)
  const frame =
    Array.isArray(landmarks) && landmarks.length
      ? buildMouthPoseFrame(landmarks, jg)
      : { ok: false, error: "no-landmarks", coordinateMode: "invalid", mouthWidth: 0 }
  const mouthWidth = safeFloat(frame.mouthWidth, 0)
  const coordMode = String(frame.coordinateMode || "invalid")

  const baseDbg = {
    enabled: jg.enabled !== false,
    neutralReady: Boolean(st.neutral_ready),
    neutralCount: Math.trunc(st.neutral_count || 0),
    coordinateMode: coordMode,
    pose: { rollDeg: 0, yawProxy: 0, pitchProxy: 0, faceScale: 0 },
    poseNeutral: { rollDeg: 0, yawProxy: 0, pitchProxy: 0, faceScale: 0 },
    poseGate: {
      active: false,
      reasons: [],
      yawDelta: 0,
      pitchDelta: 0,
      rollDelta: 0,
      scaleDelta: 0,
      poseMotionSuppressScale: safeFloat(jg.poseMotionSuppressScale, 0.25),
    },
    current: { aperture: 0, lowerInnerY: 0, lowerLipCenterY: 0 },
    neutral: { aperture: 0, lowerInnerY: 0, lowerLipCenterY: 0 },
    components: {
      jawAperture: 0,
      jawApertureCompensated: 0,
      jawLowerInner: 0,
      jawLowerLipCenter: 0,
      jawBlendshape: jawBs,
      jawChin: 0,
    },
    weights: {
      apertureWeight: safeFloat(jg.apertureWeight, 0.5),
      lowerInnerWeight: safeFloat(jg.lowerInnerWeight, 0.35),
      lowerLipCenterWeight: safeFloat(jg.lowerLipCenterWeight, 0.15),
      chinWeight: safeFloat(jg.chinWeight, 0),
      blendshapeMix: safeFloat(jg.blendshapeMix, 0.08),
    },
    curve: {},
    stabilizer: {},
    raw: 0,
    curved: 0,
    jawSignedRaw: 0,
    jawSmooth: 0,
    rigWrite: { jaw: 0 },
    semanticOpen: 0,
    signConvention: { internalOpenPositive: true, jawOutputSign: jawSign, rigOpenNegative: jawSign < 0 },
    neutralState: neutralDbg(st),
    mouthScenario: "unknown",
    noseAnchorMotion: false,
    oldMouthPoseHeadMotionActive: false,
    gateDecision: {
      frontalPassThrough: false,
      closedHeadTurnLockApplied: false,
      poseGateSuppressionApplied: false,
      reason: "init",
    },
    noseAnchor: noseMotion && typeof noseMotion === "object" ? { ...noseMotion } : {},
    skipped: "",
  }

  const finishZero = (skipped) => {
    rig.jaw.val = 0
    mapping.jaw = 0
    baseDbg.skipped = skipped
    st.last_debug = baseDbg
    return { jaw: { val: 0 }, mapping, debug: baseDbg, nextState: st, rig }
  }

  if (jg.enabled === false) return finishZero("jawGeometry-disabled")
  if (!Array.isArray(landmarks) || !frame.ok) return finishZero("mouth-frame-invalid")

  const li = Math.trunc(jg.leftCornerIndex ?? 61)
  const ri = Math.trunc(jg.rightCornerIndex ?? 291)
  const ci = Math.trunc(jg.chinIndex ?? 152)
  const ni = Math.trunc(jg.noseTipIndex ?? 1)
  const l = readPoint3(landmarks, li)
  const r = readPoint3(landmarks, ri)
  const chinPt = readPoint3(landmarks, ci)
  const nose = readPoint3(landmarks, ni)
  const pts = computeJawComponents(landmarks, frame, jg)
  if (!l || !r || !chinPt || !nose || !pts) return finishZero("landmark-missing")

  const { lowerInnerY, lowerCenterY, aperture } = pts
  const chinY = frame.projectY(chinPt)
  const mouthCenter = frame.mouthCenter
  const faceScale = mouthWidth
  const yaw = (v3Norm(v3Sub(nose, r)) - v3Norm(v3Sub(nose, l))) / Math.max(1e-6, mouthWidth)
  const pitch = v3Norm(v3Sub(chinPt, mouthCenter)) / Math.max(1e-6, mouthWidth)
  const roll = (Math.atan2(r[1] - l[1], r[0] - l[0]) * 180) / Math.PI
  baseDbg.pose = { rollDeg: roll, yawProxy: yaw, pitchProxy: pitch, faceScale }

  if (!faceDetected || Number(quality) < safeFloat(jg.neutralTrackMinQuality, 0.5)) {
    return finishZero("waiting-stable-face")
  }

  const fi = {
    face_detected: true,
    quality: Number(quality),
    mouth_width: mouthWidth,
    jaw_val: Math.abs(jawBs),
    smile_l: safeFloat(mapping.smileLeft, 0),
    smile_r: safeFloat(mapping.smileRight, 0),
    side_l_x: safeFloat(rig?.mouth?.sideL?.x, 50),
    side_l_y: safeFloat(rig?.mouth?.sideL?.y, 50),
    side_r_x: safeFloat(rig?.mouth?.sideR?.x, 50),
    side_r_y: safeFloat(rig?.mouth?.sideR?.y, 50),
  }
  const candidate = isLipNeutralCandidate(fi, {
    neutralTrackMinQuality: jg.neutralTrackMinQuality,
    minMouthWidth: jg.minMouthWidth,
    neutralMaxJaw: jg.neutralMaxJawBlend,
    neutralMaxSmile: jg.neutralMaxSmile,
    neutralMaxSideOffset: jg.neutralMaxSideOffset,
  })

  if (!st.neutral_ready) {
    if (candidate) {
      const wc = Math.trunc(st.neutral_warmup_count || 0)
      const needW = Math.max(0, Math.trunc(jg.neutralWarmupFrames ?? 8))
      if (wc < needW) {
        st.neutral_warmup_count = wc + 1
      } else {
        const ns = st.neutral_sum
        ns.aperture += aperture
        ns.lowerInnerY += lowerInnerY
        ns.lowerLipCenterY += lowerCenterY
        ns.poseRollDeg += roll
        ns.poseYawProxy += yaw
        ns.posePitchProxy += pitch
        ns.faceScale += faceScale
        st.neutral_count = Math.trunc(st.neutral_count || 0) + 1
        if (Math.trunc(st.neutral_count) >= Math.max(1, Math.trunc(jg.neutralFrames ?? 30))) {
          const nc = Number(st.neutral_count)
          st.neutral = {
            aperture: ns.aperture / nc,
            lowerInnerY: ns.lowerInnerY / nc,
            lowerLipCenterY: ns.lowerLipCenterY / nc,
            poseRollDeg: ns.poseRollDeg / nc,
            poseYawProxy: ns.poseYawProxy / nc,
            posePitchProxy: ns.posePitchProxy / nc,
            faceScale: Math.max(1e-6, ns.faceScale / nc),
          }
          st.neutral_ready = true
          st.neutral_mode = "ready"
          st.last_calibrated_at = nowMs
          st.prev = 0
          st.locked_to_zero = true
        }
      }
    }
    baseDbg.neutralState = neutralDbg(st)
    return finishZero("jaw-neutral-calibrating")
  }

  if (!lipNeutralReady) return finishZero("lip-neutral-wait")

  const n = st.neutral
  baseDbg.neutral = {
    aperture: Number(n.aperture),
    lowerInnerY: Number(n.lowerInnerY),
    lowerLipCenterY: Number(n.lowerLipCenterY),
  }
  baseDbg.poseNeutral = {
    rollDeg: Number(n.poseRollDeg),
    yawProxy: Number(n.poseYawProxy),
    pitchProxy: Number(n.posePitchProxy),
    faceScale: Number(n.faceScale),
  }
  baseDbg.current = { aperture, lowerInnerY, lowerLipCenterY: lowerCenterY }

  const comps = jawInputFromDeltas(aperture, lowerInnerY, lowerCenterY, n, jg)
  let jawInput = comps.jawInput
  const jawChin = Math.max(
    0,
    (chinY - (Number(n.lowerInnerY) + 0.5 * Number(n.aperture))) * safeFloat(jg.lowerLipCenterGain, 280),
  )
  if (jg.useChinAsPrimary) jawInput += safeFloat(jg.chinWeight, 0) * jawChin

  const poseGateDbg = evaluateMouthPoseGate(
    { yawProxy: yaw, pitchProxy: pitch, rollDeg: roll, faceScale },
    {
      yawProxy: n.poseYawProxy,
      pitchProxy: n.posePitchProxy,
      rollDeg: n.poseRollDeg,
      faceScale: n.faceScale,
    },
    jg,
  )
  const poseGate = Boolean(poseGateDbg.active)

  const noseDbg = noseMotion && typeof noseMotion === "object" ? noseMotion : {}
  const noseReady = Boolean(noseDbg.neutralReady)
  const noseEnabled =
    Boolean(noseDbg.enabled ?? true) && Boolean(Object.keys(noseDbg).length) && "motionActive" in noseDbg
  const noseAnchorMotion = noseEnabled && noseReady ? Boolean(noseDbg.motionActive) : false
  const headMotionActive = noseEnabled && noseReady ? noseAnchorMotion : poseGate

  const mix = clamp(safeFloat(jg.blendshapeMix, 0.08), 0, 1)
  const jawInputFull = jawInput * (1 - mix) + Math.max(0, jawBs) * mix
  const [afterCurveFull] = applyCurve(jawInputFull, jg)

  let mouthScenario
  if (finalScenario != null) {
    mouthScenario = String(finalScenario)
  } else {
    const msc = config?.mouthScenario && typeof config.mouthScenario === "object" ? config.mouthScenario : {}
    const frontalThr = Math.max(0, safeFloat(msc.frontalMouthMotionThreshold, 4))
    const neutralThr = Math.max(0, safeFloat(msc.neutralThreshold, 2))
    if (!headMotionActive && afterCurveFull < neutralThr) mouthScenario = "neutral_still"
    else if (headMotionActive && afterCurveFull < frontalThr) mouthScenario = "closed_head_turn"
    else if (!headMotionActive && afterCurveFull >= frontalThr) mouthScenario = "frontal_mouth_motion"
    else mouthScenario = "unknown"
  }

  const suppressScale = clamp(safeFloat(jg.poseMotionSuppressScale, 0.25), 0, 1)
  let gateReason = "normal-flow"
  let poseGateSuppressionApplied = false
  let gateScale = 1
  if (mouthScenario === "closed_head_turn") {
    jawInput = 0
    if (jg.closedHeadTurnResetPrev !== false) {
      st.prev = 0
      st.locked_to_zero = true
    }
    gateReason = "closed-head-turn-zero"
    gateScale = 0
  } else if (mouthScenario === "frontal_mouth_motion") {
    gateReason = "frontal-pass-through"
  } else if (mouthScenario === "head_motion_mouth_motion") {
    const msc = config?.mouthScenario && typeof config.mouthScenario === "object" ? config.mouthScenario : {}
    const hmScale =
      headMotionOutputScale != null
        ? clamp(Number(headMotionOutputScale), 0, 1)
        : clamp(safeFloat(msc.headMotionMouthJawScale ?? msc.headMotionJawSuppressScale, 0.85), 0, 1)
    jawInput *= hmScale
    gateScale = hmScale
    poseGateSuppressionApplied = true
    gateReason = "head-motion-mouth-motion"
  } else if (mouthScenario === "neutral_still") {
    gateReason = "neutral-still"
  } else {
    jawInput *= suppressScale
    gateScale = suppressScale
    poseGateSuppressionApplied = true
    gateReason = "unknown-conservative"
  }

  jawInput = jawInput * (1 - mix) + Math.max(0, jawBs) * mix
  const combinedInput = jawInput
  const [afterCurve, curveDbg] = applyCurve(jawInput, jg)
  const gateDecision = {
    finalScenario: String(mouthScenario),
    frontalPassThrough: mouthScenario === "frontal_mouth_motion",
    closedHeadTurnApplied: mouthScenario === "closed_head_turn",
    closedHeadTurnLockApplied: mouthScenario === "closed_head_turn",
    poseGateSuppressionApplied,
    reason: gateReason,
  }
  const jawSignedRaw = clampSigned100(jawSign * afterCurve)
  const [jawSmooth, stabDbg] = stabilize(jawSignedRaw, st, jg)
  const jawVal = clampSigned100(jawSmooth)
  rig.jaw.val = jawVal
  mapping.jaw = jawVal

  Object.assign(baseDbg, {
    gate: { scenario: String(mouthScenario), scale: gateScale, reason: gateReason },
    slew: {
      limit: safeFloat(stabDbg.slewLimit, 0),
      delta: safeFloat(stabDbg.slewDelta ?? stabDbg.effectiveStep, 0),
      clipped: Boolean(stabDbg.slewClipped),
    },
    components: {
      aperture: comps.jawAperture,
      lowerLip: comps.jawLowerInner,
      blendshape: jawBs,
      chin: jawChin,
      combined: combinedInput,
      jawAperture: comps.jawAperture,
      jawApertureCompensated: comps.jawApComp,
      jawLowerInner: comps.jawLowerInner,
      jawLowerLipCenter: comps.jawLowerCenter,
      jawBlendshape: jawBs,
      jawChin,
    },
    curve: { ...curveDbg, target: afterCurve, afterSlew: jawSmooth, final: jawVal },
    raw: combinedInput,
    curved: afterCurve,
    neutralReady: true,
    neutralState: neutralDbg(st),
    poseGate: poseGateDbg,
    jawSignedRaw,
    jawSmooth,
    semanticOpen: Math.max(0, afterCurve),
    stabilizer: stabDbg,
    rigWrite: { jaw: jawVal },
    mouthScenario: String(mouthScenario),
    noseAnchorMotion,
    oldMouthPoseHeadMotionActive: poseGate,
    gateDecision,
    afterCurveFull,
    noseAnchor: { ...noseDbg },
  })
  st.last_debug = baseDbg
  return { jaw: { val: jawVal }, mapping, debug: baseDbg, nextState: st, rig }
}

export function computeJawRawEvidence({ landmarks, blendshapes = {}, config, state } = {}) {
  const jg = resolveJawCfg(config)
  const st = state && typeof state === "object" ? state : {}
  const jawBs = jawBlendshape(blendshapes, config, jg)
  const out = { jawInputAbs: 0, jawScore: 0, apertureAbs: 0, available: { jaw: false, aperture: false } }
  if (!st.neutral_ready) return out
  if (!Array.isArray(landmarks)) return out
  const f = buildMouthPoseFrame(landmarks, jg)
  if (!f.ok) return out
  const pts = computeJawComponents(landmarks, f, jg)
  if (!pts) return out
  const n = st.neutral || {}
  const comps = jawInputFromDeltas(pts.aperture, pts.lowerInnerY, pts.lowerCenterY, n, jg)
  const mix = clamp(safeFloat(jg.blendshapeMix, 0.08), 0, 1)
  const jawInputFull = comps.jawInput * (1 - mix) + Math.max(0, jawBs) * mix
  const [afterCurveFull] = applyCurve(jawInputFull, jg)
  return {
    jawInputAbs: Math.abs(comps.jawInput),
    jawScore: Math.abs(afterCurveFull),
    apertureAbs: Math.abs(pts.aperture - safeFloat(n.aperture, 0)),
    available: { jaw: true, aperture: true },
    mouthWidth: safeFloat(f.mouthWidth, 0),
  }
}
