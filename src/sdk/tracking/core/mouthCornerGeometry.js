/**
 * Mouth Corner Geometry V2 — port of tools/tracking_service/mouth_corner_geometry.py
 * Default model: landmark-2d-v2 (JSON). diagonal-v1 kept for smile fallback.
 */

import { clampPct, safeFloat } from "./trackingMath.js"
import { cloneDeepPlain, readPoint3, v3Dot, v3Norm, v3Normalize, v3Sub } from "./geomMath.js"

export const MODEL_DIAGONAL_V1 = "diagonal-v1"
export const MODEL_LANDMARK_2D_V2 = "landmark-2d-v2"
export const MODEL_VERSION = "mouth-corner-geometry-v2"

const DEFAULT_MOUTH_CORNER = Object.freeze({
  model: MODEL_LANDMARK_2D_V2,
  landmarkIndices: Object.freeze({ left: 61, right: 291 }),
  stableAnchorIndices: Object.freeze({
    noseTip: 1,
    chin: 152,
    leftEyeOuter: 33,
    rightEyeOuter: 263,
  }),
  use3d: true,
  minFaceScale: 0.02,
  sourceMirror: false,
  neutralSampleCount: 30,
  neutralWarmupFrames: 8,
  minQuality: 0.5,
  inputRangeX: 0.08,
  inputRangeY: 0.08,
  outputSpanX: 35.0,
  outputSpanY: 35.0,
  deadzoneX: 0.012,
  deadzoneY: 0.012,
  holdLastValidFrames: 4,
  decayToCenterFrames: 12,
  requireLipJawNeutral: false,
  rejectOnHeadMotion: false,
  maxMouthMotionForNeutral: null,
  diagonalSmileScaleX: 0.35,
  diagonalSmileScaleY: 0.25,
})

const BOOL_KEYS = new Set(["use3d", "sourceMirror", "requireLipJawNeutral", "rejectOnHeadMotion"])

export function createMouthCornerState(sessionId = null) {
  return {
    sessionId,
    neutralReady: false,
    neutralSampleCount: 0,
    neutralWarmupCount: 0,
    neutralLeftX: null,
    neutralLeftY: null,
    neutralRightX: null,
    neutralRightY: null,
    _samplesLeftX: [],
    _samplesLeftY: [],
    _samplesRightX: [],
    _samplesRightY: [],
    lastValid: null,
    invalidFrameCount: 0,
    holdFrameCount: 0,
    modelVersion: MODEL_VERSION,
  }
}

export function resetMouthCornerState(state, sessionId = null) {
  const fresh = createMouthCornerState(sessionId ?? state?.sessionId ?? null)
  if (state && typeof state === "object") {
    for (const k of Object.keys(state)) delete state[k]
    Object.assign(state, createMouthCornerState(sessionId ?? fresh.sessionId))
    return state
  }
  return fresh
}

export function startMouthCornerNeutralCalibration(state, reason = "manual") {
  if (!state || typeof state !== "object") return
  const sid = state.sessionId
  resetMouthCornerState(state, sid)
  state.calibrateReason = String(reason)
}

export function normalizeMouthCornerConfig(raw, { sectionPresent = true } = {}) {
  const base = {
    ...DEFAULT_MOUTH_CORNER,
    landmarkIndices: { ...DEFAULT_MOUTH_CORNER.landmarkIndices },
    stableAnchorIndices: { ...DEFAULT_MOUTH_CORNER.stableAnchorIndices },
  }
  if (!sectionPresent) {
    base.model = MODEL_DIAGONAL_V1
    return base
  }
  if (!raw || typeof raw !== "object") return base
  for (const [k, v] of Object.entries(DEFAULT_MOUTH_CORNER)) {
    if (k === "landmarkIndices") {
      const arr = raw[k]
      if (arr && typeof arr === "object" && !Array.isArray(arr)) {
        base[k] = {
          left: Math.trunc(safeFloat(arr.left, v.left)),
          right: Math.trunc(safeFloat(arr.right, v.right)),
        }
      } else if (Array.isArray(arr) && arr.length >= 2) {
        base[k] = { left: Math.trunc(arr[0]), right: Math.trunc(arr[1]) }
      } else {
        base[k] = { ...v }
      }
    } else if (k === "stableAnchorIndices") {
      const arr = raw[k]
      if (arr && typeof arr === "object" && !Array.isArray(arr)) {
        const out = { ...v }
        for (const ak of Object.keys(v)) out[ak] = Math.trunc(safeFloat(arr[ak], v[ak]))
        base[k] = out
      } else {
        base[k] = { ...v }
      }
    } else if (k === "model") {
      const m = String(raw[k] != null ? raw[k] : v).trim()
      base[k] = m === MODEL_DIAGONAL_V1 || m === MODEL_LANDMARK_2D_V2 ? m : MODEL_DIAGONAL_V1
    } else if (k === "maxMouthMotionForNeutral") {
      if (!(k in raw) || raw[k] == null) base[k] = null
      else base[k] = safeFloat(raw[k], 0)
    } else if (BOOL_KEYS.has(k)) {
      base[k] = raw[k] == null ? Boolean(v) : Boolean(raw[k])
    } else if (typeof v === "number") {
      base[k] = safeFloat(raw[k], v)
    } else {
      base[k] = raw[k] == null ? v : raw[k]
    }
  }
  if (!("model" in raw)) base.model = MODEL_DIAGONAL_V1
  return base
}

function resolveCornerCfg(config) {
  if (config && typeof config === "object" && config.mouthCorner && typeof config.mouthCorner === "object") {
    return normalizeMouthCornerConfig(config.mouthCorner, { sectionPresent: true })
  }
  if (config && typeof config === "object" && ("model" in config || "landmarkIndices" in config)) {
    return normalizeMouthCornerConfig(config, { sectionPresent: true })
  }
  return normalizeMouthCornerConfig(null, { sectionPresent: true })
}

function median(vals) {
  if (!vals || !vals.length) return null
  const s = vals.map((v) => Number(v)).sort((a, b) => a - b)
  const n = s.length
  const mid = Math.trunc(n / 2)
  if (n % 2) return s[mid]
  return 0.5 * (s[mid - 1] + s[mid])
}

export function extractRawMouthCornerObservation(landmarks, cfg) {
  const mc = resolveCornerCfg(cfg)
  const li = Math.trunc(mc.landmarkIndices.left)
  const ri = Math.trunc(mc.landmarkIndices.right)
  const left = landmarks != null ? readPoint3(landmarks, li) : null
  const right = landmarks != null ? readPoint3(landmarks, ri) : null
  if (!left || !right) {
    return {
      available: false,
      left: { x: null, y: null },
      right: { x: null, y: null },
      landmarkIndices: { left: li, right: ri },
      landmarkCount: 0,
      rejectReason: "landmarks-missing",
    }
  }
  let lx = left[0]
  let ly = left[1]
  let rx = right[0]
  let ry = right[1]
  if (mc.sourceMirror) {
    ;[lx, ly, rx, ry] = [rx, ry, lx, ly]
  }
  return {
    available: true,
    left: { x: lx, y: ly },
    right: { x: rx, y: ry },
    landmarkIndices: { left: Math.trunc(mc.landmarkIndices.left), right: Math.trunc(mc.landmarkIndices.right) },
    landmarkCount: 2,
    rejectReason: null,
  }
}

export function buildFaceLocalCornerFrame(landmarks, cfg) {
  const anchors = cfg?.stableAnchorIndices || DEFAULT_MOUTH_CORNER.stableAnchorIndices
  const ni = Math.trunc(anchors.noseTip ?? 1)
  const ci = Math.trunc(anchors.chin ?? 152)
  let lei = Math.trunc(anchors.leftEyeOuter ?? 33)
  let rei = Math.trunc(anchors.rightEyeOuter ?? 263)
  if (cfg?.sourceMirror) {
    const tmp = lei
    lei = rei
    rei = tmp
  }
  let nose = readPoint3(landmarks, ni)
  let chin = readPoint3(landmarks, ci)
  let le = readPoint3(landmarks, lei)
  let re = readPoint3(landmarks, rei)
  if (!nose || !chin || !le || !re) {
    return { ok: false, error: "stable-anchors-missing", faceFrame: null }
  }
  if (!cfg?.use3d) {
    nose = [nose[0], nose[1], 0]
    chin = [chin[0], chin[1], 0]
    le = [le[0], le[1], 0]
    re = [re[0], re[1], 0]
  }
  const xAxis = v3Normalize(v3Sub(re, le))
  if (!xAxis) return { ok: false, error: "x-axis-invalid", faceFrame: null }
  const faceDown = v3Normalize(v3Sub(chin, nose))
  if (!faceDown) return { ok: false, error: "face-down-invalid", faceFrame: null }
  const proj = v3Dot(faceDown, xAxis)
  let yAxis = v3Normalize([
    faceDown[0] - proj * xAxis[0],
    faceDown[1] - proj * xAxis[1],
    faceDown[2] - proj * xAxis[2],
  ])
  if (!yAxis) return { ok: false, error: "y-axis-invalid", faceFrame: null }
  if (v3Dot(yAxis, v3Sub(chin, nose)) < 0) yAxis = [-yAxis[0], -yAxis[1], -yAxis[2]]
  const scale = v3Norm(v3Sub(re, le))
  const minS = Math.max(1e-6, safeFloat(cfg?.minFaceScale, 0.02))
  if (scale < minS) {
    return { ok: false, error: "face-scale-too-small", faceFrame: null, scale }
  }
  const faceFrame = {
    originX: nose[0],
    originY: nose[1],
    axisXX: xAxis[0],
    axisXY: xAxis[1],
    axisYX: yAxis[0],
    axisYY: yAxis[1],
    scale,
  }
  const projectXy = (point) => {
    const d = v3Sub(point, nose)
    return [v3Dot(d, xAxis) / scale, v3Dot(d, yAxis) / scale]
  }
  return { ok: true, error: "", faceFrame, project: projectXy, origin3: nose, xAxis, yAxis, scale }
}

export function buildCanonicalMouthCornerObservation(
  landmarks,
  cfg,
  { rawObs = null, headMotionActive = false, trackingQuality = null } = {},
) {
  const mc = resolveCornerCfg(cfg)
  const raw = rawObs || extractRawMouthCornerObservation(landmarks, mc)
  const empty = {
    available: false,
    faceFrame: null,
    left: { canonicalX: null, canonicalY: null },
    right: { canonicalX: null, canonicalY: null },
    quality: {
      faceScaleValid: false,
      poseValid: false,
      headMotionActive: Boolean(headMotionActive),
      confidence: 0,
      rejectReason: "unavailable",
    },
  }
  if (!raw.available) {
    empty.quality.rejectReason = raw.rejectReason || "landmarks-missing"
    return empty
  }
  const frame = buildFaceLocalCornerFrame(landmarks, mc)
  if (!frame.ok) {
    empty.quality.rejectReason = frame.error || "frame-invalid"
    return empty
  }
  let li = Math.trunc(mc.landmarkIndices.left)
  let ri = Math.trunc(mc.landmarkIndices.right)
  if (mc.sourceMirror) {
    const tmp = li
    li = ri
    ri = tmp
  }
  const leftP = readPoint3(landmarks, li)
  const rightP = readPoint3(landmarks, ri)
  if (!leftP || !rightP) {
    empty.quality.rejectReason = "landmarks-missing"
    return empty
  }
  const [lcx, lcy] = frame.project(leftP)
  const [rcx, rcy] = frame.project(rightP)
  const q = safeFloat(trackingQuality, 1)
  const minQ = safeFloat(mc.minQuality, 0.5)
  let reject = null
  let poseValid = true
  if (q < minQ) {
    reject = "low-quality"
    poseValid = false
  }
  if (mc.rejectOnHeadMotion && headMotionActive) {
    reject = "head-motion"
    poseValid = false
  }
  const available = reject == null
  return {
    available,
    faceFrame: frame.faceFrame,
    left: { canonicalX: lcx, canonicalY: lcy },
    right: { canonicalX: rcx, canonicalY: rcy },
    quality: {
      faceScaleValid: true,
      poseValid,
      headMotionActive: Boolean(headMotionActive),
      confidence: available ? q : 0,
      rejectReason: reject,
    },
  }
}

function neutralCollectOk({
  canonical,
  faceDetected,
  lipNeutralReady,
  jawNeutralReady,
  headMotionActive,
  mouthMotionScore,
  cfg,
}) {
  if (!faceDetected) return [false, "no-face"]
  const left = canonical?.left || {}
  const right = canonical?.right || {}
  const hasGeom = left.canonicalX != null && right.canonicalX != null
  if (!hasGeom) return [false, canonical?.quality?.rejectReason || "canonical-unavailable"]
  if (cfg.rejectOnHeadMotion && headMotionActive) return [false, "head-motion"]
  if (cfg.requireLipJawNeutral && !(lipNeutralReady && jawNeutralReady)) return [false, "lip-jaw-neutral-pending"]
  const maxMouth = cfg.maxMouthMotionForNeutral
  if (maxMouth != null && Number(maxMouth) >= 0 && mouthMotionScore > Number(maxMouth)) {
    return [false, "mouth-motion"]
  }
  return [true, null]
}

export function updateMouthCornerNeutral(
  state,
  canonical,
  cfg,
  {
    faceDetected = true,
    lipNeutralReady = true,
    jawNeutralReady = true,
    headMotionActive = false,
    mouthMotionScore = 0,
  } = {},
) {
  const st = state && typeof state === "object" ? state : createMouthCornerState()
  const [ok, reason] = neutralCollectOk({
    canonical,
    faceDetected,
    lipNeutralReady,
    jawNeutralReady,
    headMotionActive,
    mouthMotionScore,
    cfg,
  })
  const warmup = Math.trunc(safeFloat(cfg.neutralWarmupFrames, 8))
  const need = Math.trunc(safeFloat(cfg.neutralSampleCount, 30))
  if (st.neutralReady) {
    return {
      ready: true,
      sampleCount: Math.trunc(st.neutralSampleCount || 0),
      skipReason: null,
      leftX: st.neutralLeftX,
      leftY: st.neutralLeftY,
      rightX: st.neutralRightX,
      rightY: st.neutralRightY,
    }
  }
  if (!ok) {
    return {
      ready: false,
      sampleCount: Math.trunc(st.neutralSampleCount || 0),
      skipReason: reason,
      leftX: null,
      leftY: null,
      rightX: null,
      rightY: null,
    }
  }
  const wu = Math.trunc(st.neutralWarmupCount || 0)
  if (wu < warmup) {
    st.neutralWarmupCount = wu + 1
    return {
      ready: false,
      sampleCount: Math.trunc(st.neutralSampleCount || 0),
      skipReason: "warmup",
      leftX: null,
      leftY: null,
      rightX: null,
      rightY: null,
    }
  }
  const left = canonical.left || {}
  const right = canonical.right || {}
  if (!Array.isArray(st._samplesLeftX)) st._samplesLeftX = []
  if (!Array.isArray(st._samplesLeftY)) st._samplesLeftY = []
  if (!Array.isArray(st._samplesRightX)) st._samplesRightX = []
  if (!Array.isArray(st._samplesRightY)) st._samplesRightY = []
  st._samplesLeftX.push(Number(left.canonicalX))
  st._samplesLeftY.push(Number(left.canonicalY))
  st._samplesRightX.push(Number(right.canonicalX))
  st._samplesRightY.push(Number(right.canonicalY))
  for (const key of ["_samplesLeftX", "_samplesLeftY", "_samplesRightX", "_samplesRightY"]) {
    const buf = st[key]
    if (buf.length > need * 2) st[key] = buf.slice(-need)
  }
  const n = Math.min(st._samplesLeftX.length, st._samplesLeftY.length, st._samplesRightX.length, st._samplesRightY.length)
  st.neutralSampleCount = n
  if (n >= need) {
    st.neutralLeftX = median(st._samplesLeftX.slice(-need))
    st.neutralLeftY = median(st._samplesLeftY.slice(-need))
    st.neutralRightX = median(st._samplesRightX.slice(-need))
    st.neutralRightY = median(st._samplesRightY.slice(-need))
    st.neutralReady = true
    st._samplesLeftX = []
    st._samplesLeftY = []
    st._samplesRightX = []
    st._samplesRightY = []
  }
  return {
    ready: Boolean(st.neutralReady),
    sampleCount: Math.trunc(st.neutralSampleCount || 0),
    skipReason: st.neutralReady ? null : "collecting",
    leftX: st.neutralLeftX,
    leftY: st.neutralLeftY,
    rightX: st.neutralRightX,
    rightY: st.neutralRightY,
  }
}

export function computeNeutralRelativeDelta(canonical, state) {
  if (!state || !state.neutralReady || !canonical?.available) {
    return { leftDx: null, leftDy: null, rightDx: null, rightDy: null, ready: false }
  }
  const left = canonical.left || {}
  const right = canonical.right || {}
  return {
    leftDx: Number(left.canonicalX) - Number(state.neutralLeftX),
    leftDy: Number(left.canonicalY) - Number(state.neutralLeftY),
    rightDx: Number(right.canonicalX) - Number(state.neutralRightX),
    rightDy: Number(right.canonicalY) - Number(state.neutralRightY),
    ready: true,
  }
}

function normalizeAxis(value, inputRange, deadzone) {
  const r = Math.max(1e-9, Math.abs(safeFloat(inputRange, 0.08)))
  const dz = Math.max(0, safeFloat(deadzone, 0))
  const v = safeFloat(value, 0)
  if (Math.abs(v) <= dz) return 0
  const sign = v > 0 ? 1 : -1
  const mag = (Math.abs(v) - dz) / r
  return Math.max(-1, Math.min(1, sign * mag))
}

export function projectMouthCornersDiagonalV1(smileLeft, smileRight, cfg) {
  const mc = cfg || DEFAULT_MOUTH_CORNER
  const sx = safeFloat(mc.diagonalSmileScaleX, 0.35)
  const sy = safeFloat(mc.diagonalSmileScaleY, 0.25)
  const sL = safeFloat(smileLeft, 0)
  const sR = safeFloat(smileRight, 0)
  return {
    sideL: { x: clampPct(50 - sL * sx), y: clampPct(50 - sL * sy) },
    sideR: { x: clampPct(50 + sR * sx), y: clampPct(50 - sR * sy) },
    normalized: { leftX: null, leftY: null, rightX: null, rightY: null },
  }
}

export function projectMouthCornersLandmark2dV2(delta, cfg) {
  const rx = safeFloat(cfg.inputRangeX, 0.08)
  const ry = safeFloat(cfg.inputRangeY, 0.08)
  const ox = safeFloat(cfg.outputSpanX, 35)
  const oy = safeFloat(cfg.outputSpanY, 35)
  const dzx = safeFloat(cfg.deadzoneX, 0.012)
  const dzy = safeFloat(cfg.deadzoneY, 0.012)
  const { leftDx: ldx, leftDy: ldy, rightDx: rdx, rightDy: rdy } = delta || {}
  if (ldx == null || ldy == null || rdx == null || rdy == null) {
    return {
      sideL: { x: 50, y: 50 },
      sideR: { x: 50, y: 50 },
      normalized: { leftX: null, leftY: null, rightX: null, rightY: null },
      neutralNotReady: true,
    }
  }
  const nLx = normalizeAxis(ldx, rx, dzx)
  const nLy = normalizeAxis(ldy, ry, dzy)
  const nRx = normalizeAxis(rdx, rx, dzx)
  const nRy = normalizeAxis(rdy, ry, dzy)
  return {
    sideL: { x: clampPct(50 + nLx * ox), y: clampPct(50 + nLy * oy) },
    sideR: { x: clampPct(50 + nRx * ox), y: clampPct(50 + nRy * oy) },
    normalized: { leftX: nLx, leftY: nLy, rightX: nRx, rightY: nRy },
    neutralNotReady: false,
  }
}

function centerPad() {
  return { sideL: { x: 50, y: 50 }, sideR: { x: 50, y: 50 } }
}

function lerpPad(a, t) {
  const lerp = (v) => clampPct(50 + (safeFloat(v, 50) - 50) * t)
  return {
    sideL: { x: lerp(a.sideL.x), y: lerp(a.sideL.y) },
    sideR: { x: lerp(a.sideR.x), y: lerp(a.sideR.y) },
  }
}

/**
 * @returns {{ sideL:{x:number,y:number}, sideR:{x:number,y:number}, debug: object, nextState: object }}
 */
export function applyMouthCornerGeometry({
  landmarks,
  config,
  state,
  smileLeft = 0,
  smileRight = 0,
  headMotionActive = false,
  trackingQuality = null,
  faceDetected = true,
  lipNeutralReady = true,
  jawNeutralReady = true,
  mouthMotionScore = 0,
} = {}) {
  const mc = resolveCornerCfg(config)
  const st = cloneDeepPlain(state && typeof state === "object" ? state : createMouthCornerState())
  const model = String(mc.model || MODEL_DIAGONAL_V1)
  const legacyEv = Math.max(safeFloat(smileLeft, 0) * 0.35, safeFloat(smileRight, 0) * 0.35)
  const debugBase = {
    model,
    raw: { leftX: null, leftY: null, rightX: null, rightY: null },
    canonical: { leftX: null, leftY: null, rightX: null, rightY: null },
    neutral: { ready: false, sampleCount: 0, leftX: null, leftY: null, rightX: null, rightY: null },
    delta: { leftDx: null, leftDy: null, rightDx: null, rightDy: null },
    normalized: { leftX: null, leftY: null, rightX: null, rightY: null },
    output: centerPad(),
    quality: {
      available: false,
      confidence: null,
      poseValid: false,
      faceScaleValid: false,
      headMotionActive: Boolean(headMotionActive),
      heldLastValid: false,
      rejectReason: null,
    },
    evidence: {
      legacySmileCornerEvidence: legacyEv,
      canonicalCornerMotionEvidence: null,
      scenarioCornerEvidenceSource: "legacy-smile-v1",
    },
  }

  const wrap = (sideL, sideR, extra = {}) => ({
    sideL,
    sideR,
    legacySmileCornerEvidence: legacyEv,
    canonicalCornerMotionEvidence: extra.canonicalCornerMotionEvidence ?? 0,
    scenarioCornerEvidenceSource: "legacy-smile-v1",
    debug: debugBase,
    nextState: st,
  })

  if (model === MODEL_DIAGONAL_V1) {
    const proj = projectMouthCornersDiagonalV1(smileLeft, smileRight, mc)
    debugBase.output = { sideL: proj.sideL, sideR: proj.sideR }
    debugBase.quality.available = true
    debugBase.quality.poseValid = true
    debugBase.quality.confidence = 1
    return wrap(proj.sideL, proj.sideR, { canonicalCornerMotionEvidence: 0 })
  }

  const raw = extractRawMouthCornerObservation(landmarks, mc)
  if (raw.available) {
    debugBase.raw = {
      leftX: raw.left.x,
      leftY: raw.left.y,
      rightX: raw.right.x,
      rightY: raw.right.y,
    }
  }
  const canonical = buildCanonicalMouthCornerObservation(landmarks, mc, {
    rawObs: raw,
    headMotionActive,
    trackingQuality,
  })
  const q = canonical.quality || {}
  Object.assign(debugBase.quality, {
    available: Boolean(canonical.available),
    confidence: q.confidence,
    poseValid: q.poseValid,
    faceScaleValid: q.faceScaleValid,
    headMotionActive: q.headMotionActive,
    rejectReason: q.rejectReason,
  })
  if (canonical.left?.canonicalX != null) {
    debugBase.canonical = {
      leftX: canonical.left.canonicalX,
      leftY: canonical.left.canonicalY,
      rightX: canonical.right.canonicalX,
      rightY: canonical.right.canonicalY,
    }
  }

  const neutInfo = updateMouthCornerNeutral(st, canonical, mc, {
    faceDetected,
    lipNeutralReady,
    jawNeutralReady,
    headMotionActive,
    mouthMotionScore,
  })
  debugBase.neutral = {
    ready: Boolean(neutInfo.ready),
    sampleCount: Math.trunc(neutInfo.sampleCount || 0),
    leftX: neutInfo.leftX,
    leftY: neutInfo.leftY,
    rightX: neutInfo.rightX,
    rightY: neutInfo.rightY,
  }

  const delta = computeNeutralRelativeDelta(canonical, st)
  debugBase.delta = {
    leftDx: delta.leftDx,
    leftDy: delta.leftDy,
    rightDx: delta.rightDx,
    rightDy: delta.rightDy,
  }
  let canonEv = 0
  if (delta.ready) {
    canonEv =
      Math.max(
        Math.abs(safeFloat(delta.leftDx, 0)),
        Math.abs(safeFloat(delta.leftDy, 0)),
        Math.abs(safeFloat(delta.rightDx, 0)),
        Math.abs(safeFloat(delta.rightDy, 0)),
      ) * 100
  }
  debugBase.evidence.canonicalCornerMotionEvidence = canonEv

  const holdN = Math.trunc(safeFloat(mc.holdLastValidFrames, 4))
  const decayN = Math.trunc(safeFloat(mc.decayToCenterFrames, 12))
  const useFresh = Boolean(canonical.available) && Boolean(st.neutralReady) && Boolean(delta.ready)
  if (useFresh) {
    const proj = projectMouthCornersLandmark2dV2(delta, mc)
    const pad = { sideL: proj.sideL, sideR: proj.sideR }
    debugBase.normalized = proj.normalized || debugBase.normalized
    st.lastValid = { sideL: { ...pad.sideL }, sideR: { ...pad.sideR } }
    st.invalidFrameCount = 0
    st.holdFrameCount = 0
    debugBase.output = pad
    debugBase.quality.heldLastValid = false
    return wrap(pad.sideL, pad.sideR, { canonicalCornerMotionEvidence: canonEv })
  }

  if (!st.neutralReady) {
    debugBase.quality.rejectReason = debugBase.quality.rejectReason || "neutral-not-ready"
    debugBase.output = centerPad()
    return wrap({ x: 50, y: 50 }, { x: 50, y: 50 }, { canonicalCornerMotionEvidence: canonEv })
  }

  const inv = Math.trunc(st.invalidFrameCount || 0) + 1
  st.invalidFrameCount = inv
  const last = st.lastValid
  if (last && inv <= holdN) {
    debugBase.quality.heldLastValid = true
    debugBase.output = { sideL: { ...last.sideL }, sideR: { ...last.sideR } }
    return wrap({ ...last.sideL }, { ...last.sideR }, { canonicalCornerMotionEvidence: canonEv })
  }
  if (last && inv <= holdN + decayN) {
    const t = 1 - (inv - holdN) / Math.max(1, decayN)
    const pad = lerpPad(last, t)
    debugBase.quality.heldLastValid = true
    debugBase.output = pad
    return wrap(pad.sideL, pad.sideR, { canonicalCornerMotionEvidence: canonEv })
  }

  debugBase.output = centerPad()
  return wrap({ x: 50, y: 50 }, { x: 50, y: 50 }, { canonicalCornerMotionEvidence: canonEv })
}
