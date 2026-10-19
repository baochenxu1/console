/**
 * Provider-independent MediaPipe Observation → FaceDEV Rig semantic core.
 *
 * Baseline: tools/tracking_service/mediapipe_to_rig.py and its formal helpers.
 * This module deliberately has no DOM, React, Worker, WebSocket or servo dependency.
 */

import { createInitialEliteRig, normalizeEliteRig } from "../../../core/faceDofMapper.js"
import { normalizeTrackingSemanticConfig } from "./trackingSemanticConfig.js"
import {
  computeIrisOnlyGazeShadow,
  createIrisGazeState,
  resolveGazeShadowCompareEnabled,
} from "./gazeShadowCompare.js"
import {
  createGazeV2State,
  processEyeLocalGazeV2,
  resolveGazeAlgorithm,
  GAZE_ALGORITHM_V2,
  GAZE_ALGORITHM_LEGACY,
} from "./eyeLocalGazeV2.js"

const LIP_KEYS = ["upperL", "upperR", "lowerL", "lowerR"]
const BROW_KEYS = [
  "browInner",
  "browOuterLeft",
  "browOuterRight",
  "browLeftTip",
  "browLeftMid",
  "browLeftTail",
  "browRightTip",
  "browRightMid",
  "browRightTail",
  "browLeft",
  "browRight",
]

function finite(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, finite(value, lo)))
}

function clamp100(value) {
  return clamp(value, -100, 100)
}

function clampPct(value) {
  return clamp(value, 0, 100)
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function vecSub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function vecDot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function vecNorm(v) {
  return Math.sqrt(Math.max(1e-12, vecDot(v, v)))
}

function vecNormalize(v) {
  const n = vecNorm(v)
  return n < 1e-9 ? null : [v[0] / n, v[1] / n, v[2] / n]
}

function averagePoints(points) {
  const valid = points.filter(Boolean)
  if (!valid.length) return null
  const sum = valid.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]], [0, 0, 0])
  return sum.map((n) => n / valid.length)
}

function point(landmarks, index) {
  const p = Array.isArray(landmarks) ? landmarks[index] : null
  if (!p) return null
  const x = Number(p.x)
  const y = Number(p.y)
  const z = Number(p.z)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return [x, y, Number.isFinite(z) ? z : 0]
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return 0
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function deadzoneUnipolar(value, threshold = 0.03) {
  const x = Math.max(0, finite(value))
  if (x < threshold) return 0
  return clamp((x - threshold) / Math.max(1e-6, 1 - threshold), 0, 1)
}

function semanticStrength(value, threshold, gain = 1) {
  return clampPct(deadzoneUnipolar(value, threshold) * 100 * finite(gain, 1))
}

function softDeadzone(value, deadzone, knee) {
  const sign = value < 0 ? -1 : 1
  const mag = Math.abs(value)
  if (mag <= deadzone) return 0
  const shifted = mag - deadzone
  if (knee <= 1e-9 || shifted >= knee) return sign * shifted
  const t = shifted / knee
  return sign * shifted * t * (2 - t)
}

function createAxis4(value = 0) {
  return { upperL: value, upperR: value, lowerL: value, lowerR: value }
}

function createNeutralAccumulator() {
  return { upperL: 0, upperR: 0, lowerL: 0, lowerR: 0, rollDeg: 0, yawProxy: 0, pitchProxy: 0, faceScale: 0 }
}

function createLipState() {
  return {
    neutralReady: false,
    warmupCount: 0,
    neutralCount: 0,
    neutralSum: createNeutralAccumulator(),
    neutral: createNeutralAccumulator(),
    prev: createAxis4(),
    lastScenario: "neutral_still",
    transitionFrom: createAxis4(),
    transitionCount: 0,
  }
}

function createJawState() {
  return {
    neutralReady: false,
    warmupCount: 0,
    neutralCount: 0,
    neutralSum: { aperture: 0, lowerInnerY: 0, lowerLipCenterY: 0, rollDeg: 0, yawProxy: 0, pitchProxy: 0, faceScale: 0 },
    neutral: { aperture: 0, lowerInnerY: 0, lowerLipCenterY: 0, rollDeg: 0, yawProxy: 0, pitchProxy: 0, faceScale: 0 },
    prev: 0,
    lockedToZero: true,
  }
}

function createNoseState() {
  return {
    neutralReady: false,
    warmupCount: 0,
    neutralCount: 0,
    sum: { x: 0, y: 0, z: 0, scale: 0, vx: 0, vy: 0, vz: 0 },
    neutral: { center: [0, 0, 0], scale: 0, vector: [0, 0, 0] },
  }
}

function createCornerState() {
  return {
    neutralReady: false,
    warmupCount: 0,
    neutralCount: 0,
    sum: { lx: 0, ly: 0, rx: 0, ry: 0 },
    neutral: { lx: 0, ly: 0, rx: 0, ry: 0 },
    lastValid: { sideL: { x: 50, y: 50 }, sideR: { x: 50, y: 50 } },
    missingFrames: 0,
  }
}

function createBrowState() {
  return {
    explicitCount: 0,
    explicitActive: false,
    neutralWaitStartMs: null,
    prev: Object.fromEntries(BROW_KEYS.map((k) => [k, 0])),
  }
}

function createGazeState() {
  return {
    warmupFrames: 0,
    samplesX: [],
    samplesY: [],
    neutralReady: false,
    neutralX: 0,
    neutralY: 0,
    previousNormX: 0,
    previousNormY: 0,
    emittedX: 50,
    emittedY: 50,
    lastValid: null,
    missingCount: 0,
    blinkFrozen: false,
    blinkFrames: 0,
    blinkReleaseCount: 0,
  }
}

export function createTrackingSemanticState() {
  return {
    version: 1,
    lip: createLipState(),
    jaw: createJawState(),
    nose: createNoseState(),
    corner: createCornerState(),
    brow: createBrowState(),
    gaze: createGazeState(),
    /** Gaze V2 independent state */
    gazeV2: createGazeV2State(),
    /** Independent iris-only shadow state — never shared with processGaze. */
    shadowGaze: createIrisGazeState(),
    scenario: { current: "neutral_still", candidate: null, count: 0, mouthHold: 0 },
    lastRig: null,
    faceLostFrames: 0,
  }
}

export function resetTrackingSemanticState(state) {
  const fresh = createTrackingSemanticState()
  if (state && typeof state === "object") {
    for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, fresh)
    return state
  }
  return fresh
}

export function estimateObservationQuality(observation) {
  if (!observation?.faceDetected) return 0
  const explicit = [
    observation.facePresenceConfidence,
    observation.trackingConfidence,
    observation.faceDetectionConfidence,
  ].filter((v) => v != null && Number.isFinite(Number(v)))
  if (explicit.length) return clamp(Math.min(...explicit.map(Number)), 0, 1)
  const count = Object.values(observation.blendshapes || {}).filter((v) => Number.isFinite(Number(v))).length
  if (count >= 48) return 0.96
  if (count >= 35) return 0.93
  if (count >= 12) return 0.88
  if (count > 0) return 0.82
  return 0.8
}

function createNeutralRig() {
  return normalizeEliteRig(createInitialEliteRig())
}

function buildMouthPoseFrame(landmarks, cfg) {
  const left = point(landmarks, cfg.leftCornerIndex ?? 61)
  const right = point(landmarks, cfg.rightCornerIndex ?? 291)
  const nose = point(landmarks, cfg.noseTipIndex ?? 1)
  const chin = point(landmarks, cfg.chinIndex ?? 152)
  if (!left || !right || !nose || !chin) return { ok: false, error: "key-landmarks-missing" }
  const center = [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2, (left[2] + right[2]) / 2]
  const xAxis = vecNormalize(vecSub(right, left))
  const faceDown = vecNormalize(vecSub(chin, nose))
  if (!xAxis || !faceDown) return { ok: false, error: "axis-invalid" }
  const projection = vecDot(faceDown, xAxis)
  let yAxis = vecNormalize([
    faceDown[0] - projection * xAxis[0],
    faceDown[1] - projection * xAxis[1],
    faceDown[2] - projection * xAxis[2],
  ])
  if (!yAxis) return { ok: false, error: "y-axis-invalid" }
  if (vecDot(yAxis, vecSub(chin, center)) < 0) yAxis = yAxis.map((v) => -v)
  const width = vecNorm(vecSub(right, left))
  if (width < finite(cfg.minMouthWidth, 0.03)) return { ok: false, error: "mouth-width-too-small", mouthWidth: width }
  const projectY = (p) => vecDot(vecSub(p, center), yAxis) / Math.max(1e-6, width)
  return {
    ok: true,
    mouthCenter: center,
    mouthWidth: width,
    xAxis,
    yAxis,
    projectY,
    coordinateMode: Math.abs(left[2]) + Math.abs(right[2]) + Math.abs(nose[2]) + Math.abs(chin[2]) < 1e-6 ? "2d_fallback" : "3d",
    pose: {
      yawProxy: (vecNorm(vecSub(nose, right)) - vecNorm(vecSub(nose, left))) / Math.max(1e-6, width),
      pitchProxy: vecNorm(vecSub(chin, center)) / Math.max(1e-6, width),
      rollDeg: (Math.atan2(right[1] - left[1], right[0] - left[0]) * 180) / Math.PI,
      faceScale: width,
    },
  }
}

function evaluatePoseGate(pose, neutral, cfg) {
  const yawDelta = Math.abs(finite(pose.yawProxy) - finite(neutral.yawProxy))
  const pitchDelta = Math.abs(finite(pose.pitchProxy) - finite(neutral.pitchProxy))
  const rollDelta = Math.abs(finite(pose.rollDeg) - finite(neutral.rollDeg))
  const baseScale = Math.max(1e-6, finite(neutral.faceScale, 1))
  const scaleDelta = Math.abs(finite(pose.faceScale, baseScale) - baseScale) / baseScale
  const reasons = []
  if (yawDelta > finite(cfg.maxYawProxyDelta, 0.1)) reasons.push("yaw")
  if (pitchDelta > finite(cfg.maxPitchProxyDelta, 0.1)) reasons.push("pitch")
  if (rollDelta > finite(cfg.maxRollDeltaDeg, 12)) reasons.push("roll")
  if (scaleDelta > finite(cfg.maxFaceScaleDelta, 0.18)) reasons.push("scale")
  return { active: cfg.poseGateEnabled !== false && reasons.length > 0, reasons, yawDelta, pitchDelta, rollDelta, scaleDelta }
}

function processNoseAnchor(landmarks, state, cfg) {
  const tip = point(landmarks, cfg.noseTipIndex ?? 1)
  const bridge = averagePoints((cfg.noseBridgeIndices || [4, 5, 6, 195, 197]).map((i) => point(landmarks, i)))
  if (!tip || !bridge) return { enabled: cfg.enabled !== false, ok: false, neutralReady: state.neutralReady, motionActive: false, motionScore: 0 }
  const center = [(tip[0] + bridge[0]) / 2, (tip[1] + bridge[1]) / 2, (tip[2] + bridge[2]) / 2]
  const vector = vecSub(tip, bridge)
  const scale = vecNorm(vector)
  if (scale < finite(cfg.minNoseScale, 0.005)) return { enabled: true, ok: false, neutralReady: state.neutralReady, motionActive: false, motionScore: 0 }

  if (!state.neutralReady) {
    if (state.warmupCount < Math.max(0, Math.floor(finite(cfg.neutralWarmupFrames, 8)))) {
      state.warmupCount += 1
    } else {
      state.sum.x += center[0]
      state.sum.y += center[1]
      state.sum.z += center[2]
      state.sum.scale += scale
      state.sum.vx += vector[0]
      state.sum.vy += vector[1]
      state.sum.vz += vector[2]
      state.neutralCount += 1
      if (state.neutralCount >= Math.max(1, Math.floor(finite(cfg.neutralFrames, 30)))) {
        const n = state.neutralCount
        state.neutral = {
          center: [state.sum.x / n, state.sum.y / n, state.sum.z / n],
          scale: Math.max(1e-6, state.sum.scale / n),
          vector: [state.sum.vx / n, state.sum.vy / n, state.sum.vz / n],
        }
        state.neutralReady = true
      }
    }
  }

  let positionDelta = 0
  let scaleDelta = 0
  let vectorDelta = 0
  if (state.neutralReady) {
    const base = state.neutral
    const d = vecSub(center, base.center)
    positionDelta = Math.max(Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2])) / Math.max(1e-6, base.scale)
    scaleDelta = Math.abs(scale - base.scale) / Math.max(1e-6, base.scale)
    const a = vecNormalize(vector)
    const b = vecNormalize(base.vector)
    vectorDelta = a && b ? Math.sqrt(Math.max(0, 2 - 2 * clamp(vecDot(a, b), -1, 1))) : 0
  }
  const motionScore = state.neutralReady ? Math.max(positionDelta, scaleDelta, vectorDelta) : 0
  const motionActive = state.neutralReady && (
    positionDelta > finite(cfg.positionThreshold, 0.1)
    || scaleDelta > finite(cfg.scaleThreshold, 0.08)
    || vectorDelta > finite(cfg.vectorThreshold, 0.12)
  )
  return {
    enabled: cfg.enabled !== false,
    ok: true,
    coordinateMode: "3d",
    center: { x: center[0], y: center[1], z: center[2] },
    scale,
    vector: { x: vector[0], y: vector[1], z: vector[2] },
    neutralReady: state.neutralReady,
    neutralCount: state.neutralCount,
    delta: { position: positionDelta, scale: scaleDelta, vector: vectorDelta },
    motionScore,
    motionActive,
  }
}

function buildCornerFrame(landmarks, cfg) {
  const left = point(landmarks, cfg.leftIndex ?? 61)
  const right = point(landmarks, cfg.rightIndex ?? 291)
  const eyeL = point(landmarks, cfg.leftEyeOuterIndex ?? 33)
  const eyeR = point(landmarks, cfg.rightEyeOuterIndex ?? 263)
  const nose = point(landmarks, cfg.noseTipIndex ?? 1)
  const chin = point(landmarks, cfg.chinIndex ?? 152)
  if (!left || !right || !eyeL || !eyeR || !nose || !chin) return null
  // Python 正式 landmark-2d-v2：origin 固定为 nose tip；眼外角只定义 X/scale。
  const origin = [...nose]
  const xAxis = vecNormalize(vecSub(eyeR, eyeL))
  if (!xAxis) return null
  const down = vecNormalize(vecSub(chin, nose))
  if (!down) return null
  const proj = vecDot(down, xAxis)
  let yAxis = vecNormalize([down[0] - proj * xAxis[0], down[1] - proj * xAxis[1], down[2] - proj * xAxis[2]])
  if (!yAxis) return null
  if (vecDot(yAxis, vecSub(chin, origin)) < 0) yAxis = yAxis.map((v) => -v)
  const scale = vecNorm(vecSub(eyeR, eyeL))
  if (scale < finite(cfg.minFaceScale, 0.02)) return null
  const local = (p) => {
    const rel = vecSub(p, origin)
    return { x: vecDot(rel, xAxis) / scale, y: vecDot(rel, yAxis) / scale }
  }
  const l = local(left)
  const r = local(right)
  return { lx: l.x, ly: l.y, rx: r.x, ry: r.y, scale }
}

function axisToPad(delta, range, span, deadzone) {
  const v = Math.abs(delta) <= deadzone ? 0 : delta - Math.sign(delta) * deadzone
  return clamp((v / Math.max(1e-6, range)) * span, -span, span)
}

function processMouthCorners(landmarks, state, cfg, quality) {
  const frame = buildCornerFrame(landmarks, cfg)
  if (!frame || quality < finite(cfg.minQuality, 0.5)) {
    state.missingFrames += 1
    if (state.missingFrames <= finite(cfg.holdLastValidFrames, 4)) return { ...clone(state.lastValid), debug: { valid: false, heldLastValid: true } }
    const decayFrames = Math.max(1, finite(cfg.decayToCenterFrames, 12))
    const t = clamp((state.missingFrames - finite(cfg.holdLastValidFrames, 4)) / decayFrames, 0, 1)
    const lerp = (v) => v + (50 - v) * t
    return {
      sideL: { x: lerp(state.lastValid.sideL.x), y: lerp(state.lastValid.sideL.y) },
      sideR: { x: lerp(state.lastValid.sideR.x), y: lerp(state.lastValid.sideR.y) },
      debug: { valid: false, decaying: true },
    }
  }
  state.missingFrames = 0
  if (!state.neutralReady) {
    if (state.warmupCount < Math.max(0, Math.floor(finite(cfg.neutralWarmupFrames, 8)))) state.warmupCount += 1
    else {
      state.sum.lx += frame.lx
      state.sum.ly += frame.ly
      state.sum.rx += frame.rx
      state.sum.ry += frame.ry
      state.neutralCount += 1
      if (state.neutralCount >= Math.max(1, Math.floor(finite(cfg.neutralSampleCount, 30)))) {
        const n = state.neutralCount
        state.neutral = { lx: state.sum.lx / n, ly: state.sum.ly / n, rx: state.sum.rx / n, ry: state.sum.ry / n }
        state.neutralReady = true
      }
    }
  }
  if (!state.neutralReady) return { sideL: { x: 50, y: 50 }, sideR: { x: 50, y: 50 }, debug: { valid: true, neutralReady: false } }
  const n = state.neutral
  const dxL = axisToPad(frame.lx - n.lx, finite(cfg.inputRangeX, 0.08), finite(cfg.outputSpanX, 35), finite(cfg.deadzoneX, 0.012))
  const dyL = axisToPad(frame.ly - n.ly, finite(cfg.inputRangeY, 0.08), finite(cfg.outputSpanY, 35), finite(cfg.deadzoneY, 0.012))
  const dxR = axisToPad(frame.rx - n.rx, finite(cfg.inputRangeX, 0.08), finite(cfg.outputSpanX, 35), finite(cfg.deadzoneX, 0.012))
  const dyR = axisToPad(frame.ry - n.ry, finite(cfg.inputRangeY, 0.08), finite(cfg.outputSpanY, 35), finite(cfg.deadzoneY, 0.012))
  const output = {
    sideL: { x: clampPct(50 + dxL), y: clampPct(50 + dyL) },
    sideR: { x: clampPct(50 + dxR), y: clampPct(50 + dyR) },
    debug: { valid: true, neutralReady: true, canonical: frame, delta: { dxL, dyL, dxR, dyR }, model: "landmark-2d-v2" },
  }
  state.lastValid = { sideL: { ...output.sideL }, sideR: { ...output.sideR } }
  return output
}

function eyeLocalIris(landmarks, innerIndex, outerIndex, upperIndex, lowerIndex, irisIndices) {
  const inner = point(landmarks, innerIndex)
  const outer = point(landmarks, outerIndex)
  const upper = point(landmarks, upperIndex)
  const lower = point(landmarks, lowerIndex)
  const iris = averagePoints(irisIndices.map((i) => point(landmarks, i)))
  if (!inner || !outer || !upper || !lower || !iris) return null
  const hx = outer[0] - inner[0]
  const hy = outer[1] - inner[1]
  const width = Math.hypot(hx, hy)
  if (width < 1e-6) return null
  const ux = hx / width
  const uy = hy / width
  let vx = -uy
  let vy = ux
  const center = [(inner[0] + outer[0]) / 2, (inner[1] + outer[1]) / 2]
  if ((upper[0] - center[0]) * vx + (upper[1] - center[1]) * vy < 0) {
    vx = -vx
    vy = -vy
  }
  const dx = iris[0] - center[0]
  const dy = iris[1] - center[1]
  return { x: (dx * ux + dy * uy) / (width / 2), y: (dx * vx + dy * vy) / (width * 0.32), width }
}

function softNorm(value, gain, knee) {
  const x = finite(value) * finite(gain, 1)
  const abs = Math.abs(x)
  return Math.sign(x) * (abs / Math.max(1e-6, knee + abs))
}

/** Diagnostic-only snapshot from gaze state. Does not alter production math. */
function gazeNeutralDiagnostic(state) {
  return {
    neutralReady: Boolean(state.neutralReady),
    // Before ready, initial 0 is not a measured neutral — export null.
    neutralX: state.neutralReady ? state.neutralX : null,
    neutralY: state.neutralReady ? state.neutralY : null,
    neutralSampleCount: Array.isArray(state.samplesX) ? state.samplesX.length : 0,
  }
}

/**
 * Attach Browser gaze intermediate diagnostic fields without changing sharedRadar math.
 * Reuses existing keys when present; does not invent Python iris* fields.
 */
function withGazeDiagnosticFields(result, state, extras = {}) {
  const neu = gazeNeutralDiagnostic(state)
  const out = {
    ...result,
    ...neu,
    ...extras,
  }
  if (out.emittedSharedRadarX == null && Number.isFinite(Number(out.sharedRadarX))) {
    out.emittedSharedRadarX = out.sharedRadarX
  }
  if (out.emittedSharedRadarY == null && Number.isFinite(Number(out.sharedRadarY))) {
    out.emittedSharedRadarY = out.sharedRadarY
  }
  return out
}

function processGaze(landmarks, blend, state, cfg) {
  const left = eyeLocalIris(landmarks, 133, 33, 159, 145, [468, 469, 470, 471, 472])
  const right = eyeLocalIris(landmarks, 362, 263, 386, 374, [473, 474, 475, 476, 477])
  const validEyes = [left, right].filter((v) => v && v.width >= finite(cfg.irisMinEyeWidth, 0.003) && v.width <= finite(cfg.irisMaxEyeWidth, 0.5))
  const blink = Math.max(finite(blend.eyeBlinkLeft), finite(blend.eyeBlinkRight))
  if (cfg.freezeOnBlink !== false) {
    if (!state.blinkFrozen && blink >= finite(cfg.blinkFreezeEnterThreshold, 0.48)) {
      state.blinkFrozen = true
      state.blinkFrames = 0
      state.blinkReleaseCount = 0
    } else if (state.blinkFrozen) {
      state.blinkFrames += 1
      if (blink <= finite(cfg.blinkFreezeReleaseThreshold, 0.38)) state.blinkReleaseCount += 1
      else state.blinkReleaseCount = 0
      if (state.blinkReleaseCount >= Math.max(1, Math.floor(finite(cfg.blinkFreezeReleaseHoldFrames, 3))) || state.blinkFrames >= finite(cfg.blinkFreezeMaxFrames, 10)) {
        state.blinkFrozen = false
        state.blinkReleaseCount = 0
      }
    }
  }
  if (!validEyes.length) {
    state.missingCount += 1
    if (state.lastValid && state.missingCount <= finite(cfg.irisMissingHoldFrames, 10)) {
      return withGazeDiagnosticFields(
        { ...state.lastValid, available: false, heldLastValid: true },
        state,
        { outputMode: "heldLastValid" }
      )
    }
    state.emittedX += (50 - state.emittedX) * finite(cfg.irisMissingDecayLerp, 0.05)
    state.emittedY += (50 - state.emittedY) * finite(cfg.irisMissingDecayLerp, 0.05)
    return withGazeDiagnosticFields(
      {
        available: false,
        sharedRadarX: state.emittedX,
        sharedRadarY: state.emittedY,
        frozenByBlink: state.blinkFrozen,
        outputMode: "unavailable",
      },
      state
    )
  }
  state.missingCount = 0
  // 左右眼局部水平轴互为镜像；正式 Python 路线使用 binocular difference，
  // 不能直接平均，否则真实同向 gaze 会相互抵消。
  const rawX = left && right ? (right.x - left.x) * 0.5 : finite(validEyes[0]?.x)
  const rawY = left && right ? (right.y - left.y) * 0.5 : finite(validEyes[0]?.y)
  if (!state.neutralReady) {
    state.warmupFrames += 1
    if (!state.blinkFrozen) {
      state.samplesX.push(rawX)
      state.samplesY.push(rawY)
    }
    if (state.samplesX.length >= finite(cfg.irisWarmupMinSamples, 12) && (state.warmupFrames >= finite(cfg.irisWarmupFrames, 20) || state.warmupFrames >= finite(cfg.irisWarmupMaxWaitFrames, 45))) {
      state.neutralX = median(state.samplesX)
      state.neutralY = median(state.samplesY)
      state.neutralReady = true
    }
    return withGazeDiagnosticFields(
      {
        available: true,
        warmingUp: true,
        sharedRadarX: 50,
        sharedRadarY: 50,
        rawX,
        rawY,
        frozenByBlink: state.blinkFrozen,
        candidateSharedRadarX: 50,
        candidateSharedRadarY: 50,
        outputMode: "warmingUp",
      },
      state
    )
  }
  if (state.blinkFrozen) {
    return withGazeDiagnosticFields(
      {
        ...(state.lastValid || { sharedRadarX: state.emittedX, sharedRadarY: state.emittedY }),
        available: true,
        frozenByBlink: true,
        outputMode: "frozenByBlink",
      },
      state
    )
  }
  const dx = rawX - state.neutralX
  const dy = rawY - state.neutralY
  let normX = Math.abs(dx) < finite(cfg.irisLocalDriveDeadzoneX, 0.012) ? 0 : softNorm(dx, finite(cfg.irisXGain, 5), finite(cfg.irisSoftNormKneeX, 0.22))
  const yGain = dy < 0 ? finite(cfg.irisYGainUp, 5) : finite(cfg.irisYGainDown, 13)
  let normY = Math.abs(dy) < finite(cfg.irisLocalDriveDeadzoneY, 0.007) ? 0 : softNorm(dy, yGain, finite(cfg.irisSoftNormKneeY, 0.18))
  const maxDelta = finite(cfg.irisMaxDeltaNormPerFrame, 0.18)
  normX = clamp(normX, state.previousNormX - maxDelta, state.previousNormX + maxDelta)
  normY = clamp(normY, state.previousNormY - maxDelta, state.previousNormY + maxDelta)
  const alpha = clamp(finite(cfg.irisEmaAlpha, 0.58), 0, 1)
  normX = state.previousNormX + (normX - state.previousNormX) * alpha
  normY = state.previousNormY + (normY - state.previousNormY) * alpha
  state.previousNormX = normX
  state.previousNormY = normY
  const candidateX = clampPct(50 + normX * finite(cfg.irisOutputSpanX, 18))
  const candidateY = clampPct(50 + normY * finite(cfg.irisOutputSpanY, 20))
  const maxStep = finite(cfg.irisMaxStepSharedRadar, 10)
  state.emittedX = clamp(candidateX, state.emittedX - maxStep, state.emittedX + maxStep)
  state.emittedY = clamp(candidateY, state.emittedY - maxStep, state.emittedY + maxStep)
  const result = withGazeDiagnosticFields(
    {
      available: true,
      stable: true,
      rawX,
      rawY,
      eyeLookX: normX,
      eyeLookY: normY,
      sharedRadarX: state.emittedX,
      sharedRadarY: state.emittedY,
      candidateSharedRadarX: candidateX,
      candidateSharedRadarY: candidateY,
      emittedSharedRadarX: state.emittedX,
      emittedSharedRadarY: state.emittedY,
      frozenByBlink: false,
      outputMode: "stable",
    },
    state
  )
  state.lastValid = result
  return result
}

function mapBaseBlendshapes(blend, cfg) {
  const neutral = cfg.neutral
  const gains = cfg.gains
  const eye = cfg.eye
  const blinkL = semanticStrength(finite(blend.eyeBlinkLeft) - finite(neutral.eyeBlinkLeft), finite(cfg.deadzone.blink, 0.03), gains.blinkLeft)
  const blinkR = semanticStrength(finite(blend.eyeBlinkRight) - finite(neutral.eyeBlinkRight), finite(cfg.deadzone.blink, 0.03), gains.blinkRight)
  const wideL = eye.useEyeWide ? Math.max(0, finite(blend.eyeWideLeft) - finite(neutral.eyeWideLeft)) * finite(eye.eyeWideScale, 30) : 0
  const wideR = eye.useEyeWide ? Math.max(0, finite(blend.eyeWideRight) - finite(neutral.eyeWideRight)) * finite(eye.eyeWideScale, 30) : 0
  const biasL = finite(eye.openBiasLeft, 20)
  const biasR = finite(eye.openBiasRight, 20)
  const smileL = semanticStrength(finite(blend.mouthSmileLeft) - finite(neutral.mouthSmileLeft), finite(cfg.deadzone.smile, 0.03), gains.smileLeft)
  const smileR = semanticStrength(finite(blend.mouthSmileRight) - finite(neutral.mouthSmileRight), finite(cfg.deadzone.smile, 0.03), gains.smileRight)
  const inner = semanticStrength(Math.max(0, finite(blend.browInnerUp) - finite(neutral.browInnerUp)), finite(cfg.deadzone.brow, 0.03), gains.browInner)
  const outerL = semanticStrength(Math.max(0, finite(blend.browOuterUpLeft) - finite(neutral.browOuterUpLeft)), finite(cfg.deadzone.brow, 0.03), gains.browOuterLeft)
  const outerR = semanticStrength(Math.max(0, finite(blend.browOuterUpRight) - finite(neutral.browOuterUpRight)), finite(cfg.deadzone.brow, 0.03), gains.browOuterRight)
  const tipL = clampPct(inner * finite(gains.browTipLeft, 1))
  const tipR = clampPct(inner * finite(gains.browTipRight, 1))
  const tailL = clampPct(outerL * finite(gains.browTailLeft, 1))
  const tailR = clampPct(outerR * finite(gains.browTailRight, 1))
  const midL = clampPct(inner * finite(cfg.brow.midInnerWeight, 0.4) + outerL * finite(cfg.brow.midOuterWeight, 0.6))
  const midR = clampPct(inner * finite(cfg.brow.midInnerWeight, 0.4) + outerR * finite(cfg.brow.midOuterWeight, 0.6))
  const mapping = {
    blinkLeft: blinkL,
    blinkRight: blinkR,
    eyeOpenBiasLeft: biasL,
    eyeOpenBiasRight: biasR,
    eyeLUp: clamp100(biasL - blinkL + wideL),
    eyeLLo: clamp100(blinkL * finite(eye.lowerLidCloseRatio, 0.5) - biasL * finite(eye.lowerLidOpenRatio, 0.25)),
    eyeRUp: clamp100(biasR - blinkR + wideR),
    eyeRLo: clamp100(blinkR * finite(eye.lowerLidCloseRatio, 0.5) - biasR * finite(eye.lowerLidOpenRatio, 0.25)),
    smileLeft: smileL,
    smileRight: smileR,
    browInner: inner,
    browOuterLeft: outerL,
    browOuterRight: outerR,
    browLeftTip: tipL,
    browLeftMid: midL,
    browLeftTail: tailL,
    browRightTip: tipR,
    browRightMid: midR,
    browRightTail: tailR,
    browLeft: midL,
    browRight: midR,
    mouthPucker: clampPct(Math.max(0, finite(blend.mouthPucker) - finite(neutral.mouthPucker)) * 100),
    mouthFunnel: clampPct(Math.max(0, finite(blend.mouthFunnel) - finite(neutral.mouthFunnel)) * 100),
  }
  return mapping
}

function isNeutralCandidate(mapping, blend, quality, cfg) {
  return quality >= finite(cfg.neutralTrackMinQuality, 0.5)
    && Math.abs(finite(blend.jawOpen) * 100) <= finite(cfg.neutralMaxJaw ?? cfg.neutralMaxJawBlend, 8)
    && Math.max(Math.abs(mapping.smileLeft), Math.abs(mapping.smileRight)) <= finite(cfg.neutralMaxSmile, 12)
}

function updateLipNeutral(state, current, pose, candidate, cfg) {
  if (state.neutralReady || !candidate) return false
  if (state.warmupCount < Math.max(0, Math.floor(finite(cfg.neutralWarmupFrames, 8)))) {
    state.warmupCount += 1
    return false
  }
  for (const key of LIP_KEYS) state.neutralSum[key] += current[key]
  state.neutralSum.rollDeg += pose.rollDeg
  state.neutralSum.yawProxy += pose.yawProxy
  state.neutralSum.pitchProxy += pose.pitchProxy
  state.neutralSum.faceScale += pose.faceScale
  state.neutralCount += 1
  if (state.neutralCount >= Math.max(1, Math.floor(finite(cfg.neutralFrames, 30)))) {
    const n = state.neutralCount
    for (const key of [...LIP_KEYS, "rollDeg", "yawProxy", "pitchProxy", "faceScale"]) state.neutral[key] = state.neutralSum[key] / n
    state.neutralReady = true
    state.prev = createAxis4()
    return true
  }
  return false
}

function processLipGeometry(landmarks, blend, mapping, state, cfg, scenario, quality, poseFrame) {
  const zero = createAxis4()
  if (cfg.enabled === false || !poseFrame?.ok) return { values: zero, raw: zero, neutralReady: state.neutralReady, skipped: cfg.enabled === false ? "lipGeometry-disabled" : "mouth-frame-invalid" }
  const avg = (indices) => averagePoints((indices || []).map((i) => point(landmarks, i)))
  const points = {
    upperL: avg(cfg.upperLeftIndices),
    upperR: avg(cfg.upperRightIndices),
    lowerL: avg(cfg.lowerLeftIndices),
    lowerR: avg(cfg.lowerRightIndices),
  }
  if (Object.values(points).some((p) => !p)) return { values: zero, raw: zero, neutralReady: state.neutralReady, skipped: "lip-points-missing" }
  const current = Object.fromEntries(LIP_KEYS.map((k) => [k, poseFrame.projectY(points[k])]))
  const candidate = isNeutralCandidate(mapping, blend, quality, cfg)
  const justReady = updateLipNeutral(state, current, poseFrame.pose, candidate, cfg)
  if (!state.neutralReady || justReady) return { values: zero, raw: zero, current, neutralReady: state.neutralReady, skipped: justReady ? "neutral-just-completed" : "neutral-calibrating" }
  const raw = {
    upperL: clamp100((state.neutral.upperL - current.upperL) * finite(cfg.upperGain, 1000) * Math.sign(finite(cfg.upperSign, 1) || 1)),
    upperR: clamp100((state.neutral.upperR - current.upperR) * finite(cfg.upperGain, 1000) * Math.sign(finite(cfg.upperSign, 1) || 1)),
    lowerL: clamp100((state.neutral.lowerL - current.lowerL) * finite(cfg.lowerGain, 1000) * Math.sign(finite(cfg.lowerSign, 1) || 1)),
    lowerR: clamp100((state.neutral.lowerR - current.lowerR) * finite(cfg.lowerGain, 1000) * Math.sign(finite(cfg.lowerSign, 1) || 1)),
  }
  const pipeline = {}
  for (const key of LIP_KEYS) {
    let value = softDeadzone(raw[key], finite(cfg.deadzone, 2), finite(cfg.softDeadzoneKnee, 6))
    if (cfg.smallMotionBoostEnabled && Math.abs(value) < finite(cfg.smallMotionThreshold, 18)) value *= finite(cfg.smallMotionBoost, 1.2)
    pipeline[key] = clamp100(value)
  }
  const poseGate = evaluatePoseGate(poseFrame.pose, state.neutral, cfg)
  let gated = { ...pipeline }
  if (scenario === "closed_head_turn") gated = createAxis4(finite(cfg.closedHeadTurnOutputClamp, 0))
  else if (scenario === "head_motion_mouth_motion") for (const key of LIP_KEYS) gated[key] *= 0.95
  else if (scenario !== "frontal_mouth_motion" && scenario !== "neutral_still") {
    for (const key of LIP_KEYS) gated[key] = clamp(gated[key] * finite(cfg.poseMotionSuppressScale, 0.2), -finite(cfg.poseGateOutputClamp, 12), finite(cfg.poseGateOutputClamp, 12))
  }
  if (scenario !== state.lastScenario) {
    state.transitionFrom = { ...state.prev }
    state.transitionCount = 0
    state.lastScenario = scenario
  }
  const transitionFrames = Math.max(1, Math.floor(finite(cfg.scenarioTransitionFrames, 10)))
  if (state.transitionCount < transitionFrames) {
    state.transitionCount += 1
    const t = state.transitionCount / transitionFrames
    for (const key of LIP_KEYS) gated[key] = state.transitionFrom[key] + (gated[key] - state.transitionFrom[key]) * t
  }
  const jawOpenNorm = Math.max(0, finite(blend.jawOpen) - finite(cfg.neutral?.jawOpen))
  let capAbs = finite(cfg.maxLipControlAbsDefault, 100)
  if (jawOpenNorm <= finite(cfg.smallJawOpenNormThreshold, 0.01)) capAbs = finite(cfg.maxLipControlAbsTinyJaw, 22)
  else if (jawOpenNorm <= finite(cfg.mediumJawOpenNormThreshold, 0.02)) capAbs = finite(cfg.maxLipControlAbsSmallJaw, 30)
  const smooth = {}
  for (const key of LIP_KEYS) {
    const target = clamp(gated[key], -capAbs, capAbs)
    const prev = state.prev[key]
    const alpha = Math.abs(target - prev) >= finite(cfg.fastDelta, 7) ? finite(cfg.alphaFast, 0.86) : finite(cfg.alphaSlow, 0.32)
    let value = prev + (target - prev) * alpha
    value = clamp(value, prev - finite(cfg.maxStepPerFrame, 24), prev + finite(cfg.maxStepPerFrame, 24))
    if (Math.abs(value) < finite(cfg.snapToZero, 0.6)) value = 0
    state.prev[key] = value
    smooth[key] = value
  }
  const blendTerm = {
    upperL: semanticStrength(blend.mouthUpperUpLeft, 0.03, 1),
    upperR: semanticStrength(blend.mouthUpperUpRight, 0.03, 1),
    lowerL: -semanticStrength(blend.mouthLowerDownLeft, 0.03, 1),
    lowerR: -semanticStrength(blend.mouthLowerDownRight, 0.03, 1),
  }
  const mix = clamp(finite(cfg.blendshapeMix, 0.06), 0, 1)
  const globalScale = finite(cfg.lipGlobalScale, 0.52)
  const finalLimit = finite(cfg.lipFinalAbsLimit, 38)
  const values = {}
  for (const key of LIP_KEYS) values[key] = clamp((smooth[key] * (1 - mix) + blendTerm[key] * mix) * globalScale, -finalLimit, finalLimit)
  return { values, raw, smooth, current, neutralReady: true, pose: poseFrame.pose, poseGate, scenario, skipped: "" }
}

function jawCurve(value, cfg) {
  const x = Math.max(0, value - finite(cfg.inputDeadzone, 2))
  const smallEnd = finite(cfg.smallEnd, 18)
  const midEnd = finite(cfg.midEnd, 60)
  const largeEnd = finite(cfg.largeEnd, 110)
  if (x <= smallEnd) return finite(cfg.smallOutput, 12) * Math.pow(x / Math.max(1e-6, smallEnd), finite(cfg.curvePowerSmall, 1.15))
  if (x <= midEnd) {
    const t = (x - smallEnd) / Math.max(1e-6, midEnd - smallEnd)
    return finite(cfg.smallOutput, 12) + (finite(cfg.midOutput, 65) - finite(cfg.smallOutput, 12)) * Math.pow(t, finite(cfg.curvePowerMid, 1.45))
  }
  const t = clamp((x - midEnd) / Math.max(1e-6, largeEnd - midEnd), 0, 1)
  return finite(cfg.midOutput, 65) + (finite(cfg.maxOutput, 105) - finite(cfg.midOutput, 65)) * Math.pow(t, finite(cfg.curvePowerLarge, 1.1))
}

function updateJawNeutral(state, sample, pose, candidate, cfg) {
  if (state.neutralReady || !candidate) return false
  if (state.warmupCount < Math.max(0, Math.floor(finite(cfg.neutralWarmupFrames, 8)))) {
    state.warmupCount += 1
    return false
  }
  for (const key of ["aperture", "lowerInnerY", "lowerLipCenterY"]) state.neutralSum[key] += sample[key]
  state.neutralSum.rollDeg += pose.rollDeg
  state.neutralSum.yawProxy += pose.yawProxy
  state.neutralSum.pitchProxy += pose.pitchProxy
  state.neutralSum.faceScale += pose.faceScale
  state.neutralCount += 1
  if (state.neutralCount >= Math.max(1, Math.floor(finite(cfg.neutralFrames, 30)))) {
    const n = state.neutralCount
    for (const key of Object.keys(state.neutralSum)) state.neutral[key] = state.neutralSum[key] / n
    state.neutralReady = true
    state.prev = 0
    return true
  }
  return false
}

function processJawGeometry(landmarks, blend, mapping, state, cfg, scenario, quality, poseFrame) {
  if (cfg.enabled === false || !poseFrame?.ok) return { value: 0, semanticOpen: 0, neutralReady: state.neutralReady, skipped: cfg.enabled === false ? "jawGeometry-disabled" : "mouth-frame-invalid" }
  const upper = point(landmarks, cfg.upperInnerIndex ?? 13)
  const lower = point(landmarks, cfg.lowerInnerIndex ?? 14)
  const lowerCenter = averagePoints((cfg.lowerLipCenterIndices || [14, 17, 87, 317]).map((i) => point(landmarks, i)))
  if (!upper || !lower || !lowerCenter) return { value: 0, semanticOpen: 0, neutralReady: state.neutralReady, skipped: "landmark-missing" }
  const upperY = poseFrame.projectY(upper)
  const lowerY = poseFrame.projectY(lower)
  const lowerCenterY = poseFrame.projectY(lowerCenter)
  const sample = { aperture: lowerY - upperY, lowerInnerY: lowerY, lowerLipCenterY: lowerCenterY }
  const candidate = isNeutralCandidate(mapping, blend, quality, cfg)
  const justReady = updateJawNeutral(state, sample, poseFrame.pose, candidate, cfg)
  if (!state.neutralReady || justReady) return { value: 0, semanticOpen: 0, neutralReady: state.neutralReady, skipped: justReady ? "neutral-just-completed" : "jaw-neutral-calibrating" }
  const n = state.neutral
  const apertureDelta = Math.max(0, sample.aperture - n.aperture)
  const lowerInnerDelta = Math.max(0, sample.lowerInnerY - n.lowerInnerY)
  const lowerCenterDelta = Math.max(0, sample.lowerLipCenterY - n.lowerLipCenterY)
  const upperOpen = Math.max(0, n.lowerInnerY - sample.lowerInnerY)
  const aperture = apertureDelta * finite(cfg.apertureGain, 920)
  const lowerInner = lowerInnerDelta * finite(cfg.lowerInnerGain, 520)
  const lowerLip = lowerCenterDelta * finite(cfg.lowerLipCenterGain, 280)
  const apertureComp = Math.max(0, aperture - upperOpen * finite(cfg.upperLipOpenCompensation, 0.55))
  let input = finite(cfg.apertureWeight, 0.5) * apertureComp + finite(cfg.lowerInnerWeight, 0.35) * lowerInner + finite(cfg.lowerLipCenterWeight, 0.15) * lowerLip
  const jawBlend = semanticStrength(finite(blend.jawOpen), 0.03, 1.18)
  const mix = clamp(finite(cfg.blendshapeMix, 0.08), 0, 1)
  if (scenario === "closed_head_turn") input = 0
  else if (scenario === "head_motion_mouth_motion") input *= 0.85
  else if (scenario !== "frontal_mouth_motion" && scenario !== "neutral_still") input *= finite(cfg.poseMotionSuppressScale, 0.25)
  input = input * (1 - mix) + jawBlend * mix
  const semanticOpen = jawCurve(input, cfg)
  // Match Python jaw_geometry._stabilize: deadzone → hold/release lock → alpha → slew.
  const signedRaw = clamp100(Math.sign(finite(cfg.jawOutputSign, -1) || -1) * semanticOpen)
  const dz = Math.max(0, finite(cfg.deadzone, 2))
  const hold = Math.max(0, finite(cfg.outputHoldDeadband, 1.4))
  const release = Math.max(hold, finite(cfg.outputReleaseThreshold, 2.6))
  const snap = Math.max(0, finite(cfg.snapToZero, 2))
  const adj = Math.abs(signedRaw) < dz ? 0 : signedRaw
  let locked = state.lockedToZero !== false
  let target = 0
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
  const prev = finite(state.prev)
  const opening = Math.abs(target) >= Math.abs(prev)
  const alpha = opening
    ? clamp(finite(cfg.alphaOpen, 0.48), 0, 1)
    : clamp(finite(cfg.alphaClose, 0.62), 0, 1)
  const smooth = prev + alpha * (target - prev)
  const slew = opening
    ? Math.abs(target) >= 55
      ? finite(cfg.largeOpenSlewLimit, 28)
      : Math.abs(target) < 15
        ? finite(cfg.smallOpenSlewLimit, 12)
        : finite(cfg.openSlewLimit, 20)
    : finite(cfg.closeSlewLimit, 24)
  let value = prev + clamp(smooth - prev, -slew, slew)
  if (Math.abs(value) < snap) {
    value = 0
    locked = true
  }
  state.prev = value
  state.lockedToZero = locked
  return { value: clamp100(value), semanticOpen, neutralReady: true, raw: input, components: { aperture, apertureComp, lowerInner, lowerLip, jawBlend }, poseGate: evaluatePoseGate(poseFrame.pose, n, cfg), scenario, skipped: "" }
}

function classifyMouthScenario(state, mouthScore, headScore, cfg, neutralReady, commit = true) {
  // The mapper needs a provisional scenario before lip/jaw geometry is known.
  // Evaluate that provisional branch against a copy so one camera frame advances
  // hysteresis/hold counters exactly once, matching the Python state machine.
  if (!commit) {
    return classifyMouthScenario({ ...state }, mouthScore, headScore, cfg, neutralReady, true)
  }
  const mouthOn = finite(cfg.mouthOnThreshold, 3.5)
  const mouthOff = finite(cfg.mouthOffThreshold, 1.5)
  const headOn = finite(cfg.headOnThreshold, 0.12)
  const headOff = finite(cfg.headOffThreshold, 0.08)
  const current = state.current || "neutral_still"
  const directMouthActive = mouthScore >= mouthOn || (current.includes("mouth_motion") && mouthScore > mouthOff)
  if (directMouthActive) state.mouthHold = Math.max(0, Math.floor(finite(cfg.openCloseHoldFrames, 8)))
  else if (state.mouthHold > 0) state.mouthHold -= 1
  const mouthActive = directMouthActive || state.mouthHold > 0
  const headActive = headScore >= headOn || ((current === "closed_head_turn" || current === "head_motion_mouth_motion") && headScore > headOff)
  let candidate = "neutral_still"
  if (headActive && mouthActive) candidate = cfg.preferMouthMotionOverHeadMotion !== false ? "frontal_mouth_motion" : "head_motion_mouth_motion"
  else if (headActive) candidate = "closed_head_turn"
  else if (mouthActive) candidate = "frontal_mouth_motion"
  if (!neutralReady) candidate = "neutral_still"
  const required = candidate === "frontal_mouth_motion"
    ? Math.max(1, Math.floor(finite(cfg.frontalConfirmFrames, 2)))
    : candidate === "closed_head_turn" || candidate === "head_motion_mouth_motion"
      ? Math.max(1, Math.floor(finite(cfg.closedTurnConfirmFrames, 3)))
      : Math.max(1, Math.floor(finite(cfg.neutralConfirmFrames, 5)))
  if (candidate === current) {
    state.candidate = null
    state.count = 0
  } else if (state.candidate === candidate) {
    state.count += 1
    if (state.count >= required) {
      state.current = candidate
      state.candidate = null
      state.count = 0
    }
  } else {
    if (required <= 1) {
      state.current = candidate
      state.candidate = null
      state.count = 0
    } else {
      state.candidate = candidate
      state.count = 1
    }
  }
  return { finalScenario: state.current, candidateScenario: candidate, candidateCount: state.count, requiredConfirmFrames: required, rawMouthActive: mouthActive, headMotionActive: headActive, rawMouthScore: mouthScore, headMotionScore: headScore }
}

function applyBrowGate(raw, state, cfg, context) {
  const absMax = Math.max(...BROW_KEYS.map((k) => Math.abs(finite(raw[k]))))
  const qualityOk = context.quality >= finite(cfg.browMinQuality, 0.5)
  if (qualityOk && absMax >= finite(cfg.browRawOnThreshold, 14)) state.explicitCount += 1
  else if (absMax <= finite(cfg.browRawOffThreshold, 6)) state.explicitCount = 0
  state.explicitActive = state.explicitCount >= Math.max(1, Math.floor(finite(cfg.browConfirmFrames, 4)))
  const neutralReady = context.neutralReady
  if (!neutralReady && state.neutralWaitStartMs == null) state.neutralWaitStartMs = context.timestampMs
  const fallback = !neutralReady && context.timestampMs - finite(state.neutralWaitStartMs, context.timestampMs) >= finite(cfg.neutralFallbackMs, 2000)
  const effectiveReady = neutralReady || fallback
  const headLock = cfg.lockOnHeadMotionLikely !== false && context.scenario === "closed_head_turn"
  const headMild = context.headScore >= finite(cfg.browHeadMotionScoreThreshold, 0.08) || context.scenario === "head_motion_mouth_motion"
  const mouthMotion = context.mouthScore >= finite(cfg.browMouthMotionScoreThreshold, 3.5) || context.scenario.includes("mouth_motion")
  let locked = false
  let scale = 1
  let gateAction = "normal"
  if (cfg.enabled === false) gateAction = "disabled"
  else if (!effectiveReady || !qualityOk) {
    locked = true
    gateAction = "lock_zero"
  } else if (headLock && !state.explicitActive) {
    locked = true
    gateAction = "lock_zero"
  } else if (headLock || headMild) {
    const veryStrong = absMax >= finite(cfg.browRawStrongThreshold, 24) && state.explicitActive
    scale = veryStrong && cfg.allowExplicitBrowDuringMildHeadMotion !== false ? 1 : finite(cfg.headMotionSuppressScale, 0.25)
    gateAction = veryStrong ? "pass_explicit" : "suppress_head"
  } else if (mouthMotion && !state.explicitActive && cfg.suppressDuringMouthMotion !== false) {
    scale = finite(cfg.mouthMotionSuppressScale, 0.15)
    gateAction = "suppress_mouth"
  } else if (state.explicitActive) {
    if (absMax >= finite(cfg.browRawStrongThreshold, 24)) {
      scale = 1
      gateAction = "pass_explicit"
    } else {
      scale = Math.max(finite(cfg.mouthMotionSuppressScale, 0.15), finite(cfg.headMotionSuppressScale, 0.25), 0.55)
      gateAction = "pass_explicit_attenuated"
    }
  }
  const out = {}
  for (const key of BROW_KEYS) {
    let value = locked ? 0 : finite(raw[key]) * scale
    if (Math.abs(value) < finite(cfg.outputDeadband, 5)) value = 0
    if (Math.abs(value) < finite(cfg.snapToZero, 2.5) && Math.abs(finite(state.prev[key])) < finite(cfg.snapToZero, 2.5)) value = 0
    state.prev[key] = value
    out[key] = value
  }
  return { values: out, debug: { enabled: cfg.enabled !== false, neutralReady: effectiveReady, neutralReadyRaw: neutralReady, neutralFallback: fallback, browAbsMax: absMax, explicitBrowActive: state.explicitActive, explicitBrowCount: state.explicitCount, gateAction, outputScale: scale, headMotionLikely: headLock || headMild, mouthMotionLikely: mouthMotion, before: raw, after: out } }
}

function emaRig(previous, current, alpha) {
  if (!previous) return clone(current)
  const visit = (a, b) => {
    if (typeof b === "number") return finite(a, b) + (b - finite(a, b)) * alpha
    if (!b || typeof b !== "object" || Array.isArray(b)) return b
    return Object.fromEntries(Object.entries(b).map(([key, value]) => [key, visit(a?.[key], value)]))
  }
  return visit(previous, current)
}

/**
 * @param {import("./canonicalObservation.js").CanonicalMediaPipeObservation|object} observation
 * @param {ReturnType<createTrackingSemanticState>} previousState
 * @param {object|null} calibration reserved provider-independent calibration overlay
 * @param {object} config
 */
export function mapMediaPipeObservationToRig(observation, previousState, calibration = null, config = {}) {
  const started = typeof performance !== "undefined" ? performance.now() : Date.now()
  const state = previousState && typeof previousState === "object" ? previousState : createTrackingSemanticState()
  const cfg = normalizeTrackingSemanticConfig(config)
  const timestampMs = finite(observation?.timestampMs)
  const faceDetected = Boolean(observation?.faceDetected && Array.isArray(observation?.landmarks) && observation.landmarks.length)
  if (!faceDetected) {
    resetTrackingSemanticState(state)
    state.faceLostFrames = 1
    return {
      rig: createNeutralRig(),
      quality: 0,
      debug: { lostTracking: true, headPose: { available: false }, mapping: {}, blendshapes: observation?.blendshapes || {} },
      nextState: state,
      semanticComputeMs: Math.max(0, (typeof performance !== "undefined" ? performance.now() : Date.now()) - started),
    }
  }

  state.faceLostFrames = 0
  const landmarks = observation.landmarks
  const blend = observation.blendshapes || {}
  const quality = estimateObservationQuality(observation)
  const mapping = mapBaseBlendshapes(blend, cfg)
  const poseFrame = buildMouthPoseFrame(landmarks, cfg.lipGeometry)
  const nose = processNoseAnchor(landmarks, state.nose, cfg.noseAnchor)
  const corners = processMouthCorners(landmarks, state.corner, cfg.mouthCorner, quality)
  const provisionalMouthScore = Math.max(
    Math.abs(finite(blend.jawOpen) - finite(cfg.neutral.jawOpen)) * 100,
    Math.abs(finite(blend.mouthOpen) - finite(cfg.neutral.mouthOpen)) * 100,
    mapping.smileLeft,
    mapping.smileRight,
  )
  const neutralReady = state.lip.neutralReady && state.jaw.neutralReady && state.nose.neutralReady
  const scenario = classifyMouthScenario(state.scenario, provisionalMouthScore, finite(nose.motionScore), cfg.mouthScenario, neutralReady, false)
  const jaw = processJawGeometry(landmarks, blend, mapping, state.jaw, cfg.jawGeometry, scenario.finalScenario, quality, poseFrame)
  const lip = processLipGeometry(landmarks, blend, mapping, state.lip, cfg.lipGeometry, scenario.finalScenario, quality, poseFrame)
  const mouthScore = Math.max(provisionalMouthScore, jaw.semanticOpen || 0, ...Object.values(lip.raw || {}).map((v) => Math.abs(v)))
  const scenarioFinal = classifyMouthScenario(state.scenario, mouthScore, finite(nose.motionScore), cfg.mouthScenario, state.lip.neutralReady && state.jaw.neutralReady && state.nose.neutralReady)
  if (scenarioFinal.finalScenario !== scenario.finalScenario) {
    Object.assign(jaw, processJawGeometry(landmarks, blend, mapping, state.jaw, cfg.jawGeometry, scenarioFinal.finalScenario, quality, poseFrame))
    Object.assign(lip, processLipGeometry(landmarks, blend, mapping, state.lip, cfg.lipGeometry, scenarioFinal.finalScenario, quality, poseFrame))
  }
  const brow = applyBrowGate(mapping, state.brow, cfg.browGate, {
    quality,
    timestampMs,
    neutralReady: state.lip.neutralReady && state.jaw.neutralReady && state.nose.neutralReady,
    scenario: scenarioFinal.finalScenario,
    mouthScore,
    headScore: finite(nose.motionScore),
  })
  Object.assign(mapping, brow.values)
  const gazeStarted = typeof performance !== "undefined" ? performance.now() : Date.now()
  const gazeAlgorithm = resolveGazeAlgorithm(cfg)
  let gaze
  if (gazeAlgorithm === GAZE_ALGORITHM_V2) {
    if (!state.gazeV2 || typeof state.gazeV2 !== "object") {
      state.gazeV2 = createGazeV2State()
    }
    const v2 = processEyeLocalGazeV2({
      landmarks,
      blendshapes: blend,
      facialTransformationMatrix: observation.facialTransformationMatrix || null,
      imageWidth: observation.inferenceWidth ?? observation.videoWidth ?? undefined,
      imageHeight: observation.inferenceHeight ?? observation.videoHeight ?? undefined,
      state: state.gazeV2,
      config: cfg.gazeV2,
      timestampMs,
      quality,
      faceDetected: true,
    })
    state.gazeV2 = v2.nextState
    gaze = {
      available: v2.available !== false,
      warmingUp: Boolean(v2.warmingUp),
      stable: Boolean(v2.stable),
      frozenByBlink: Boolean(v2.frozenByBlink),
      sharedRadarX: finite(v2.sharedRadarX, 50),
      sharedRadarY: finite(v2.sharedRadarY, 50),
      rawX: v2.rawX ?? null,
      rawY: v2.rawY ?? null,
      eyeLookX: v2.eyeLookX ?? null,
      eyeLookY: v2.eyeLookY ?? null,
      neutralReady: v2.neutralReady ?? null,
      neutralX: v2.neutralX ?? null,
      neutralY: v2.neutralY ?? null,
      neutralSampleCount: v2.neutralSampleCount ?? null,
      candidateSharedRadarX: v2.candidateSharedRadarX ?? null,
      candidateSharedRadarY: v2.candidateSharedRadarY ?? null,
      emittedSharedRadarX: v2.emittedSharedRadarX ?? null,
      emittedSharedRadarY: v2.emittedSharedRadarY ?? null,
      outputMode: v2.outputMode ?? null,
      gazeAlgorithm: GAZE_ALGORITHM_V2,
      gazeEstimatorMode: GAZE_ALGORITHM_V2,
      v2: v2.debug ?? null,
    }
  } else {
    gaze = processGaze(landmarks, blend, state.gaze, cfg.gaze)
    gaze.gazeAlgorithm = GAZE_ALGORITHM_LEGACY
    gaze.gazeEstimatorMode = gaze.gazeEstimatorMode || "legacy-processGaze"
    gaze.v2 = null
  }
  const currentGazeComputeMs = Math.max(
    0,
    (typeof performance !== "undefined" ? performance.now() : Date.now()) - gazeStarted
  )
  gaze.currentGazeComputeMs = currentGazeComputeMs
  gaze.shadowGazeComputeMs = null
  gaze.shadow = null

  // Shadow only: same landmarks / blend / faceDetected; independent state; never writes mapping/rig.
  if (resolveGazeShadowCompareEnabled(cfg.gazeShadowCompareEnabled)) {
    if (!state.shadowGaze || typeof state.shadowGaze !== "object") {
      state.shadowGaze = createIrisGazeState()
    }
    try {
      const shadowOut = computeIrisOnlyGazeShadow({
        landmarks,
        blendshapes: blend,
        state: state.shadowGaze,
        config: { gaze: cfg.gaze },
        faceDetected: true,
        timestampMs,
      })
      state.shadowGaze = shadowOut.nextState
      gaze.shadow = shadowOut.shadow
      gaze.shadowGazeComputeMs = shadowOut.shadowGazeComputeMs
    } catch {
      gaze.shadow = {
        available: false,
        algorithm: "iris-only",
        rawX: null,
        rawY: null,
        normalizedX: null,
        normalizedY: null,
        neutralX: null,
        neutralY: null,
        neutralReady: null,
        candidateSharedRadarX: null,
        candidateSharedRadarY: null,
        emittedSharedRadarX: null,
        emittedSharedRadarY: null,
        outputMode: "shadow_error",
      }
    }
  }

  mapping.jaw = jaw.value
  mapping.upperLipLeft = lip.values.upperL
  mapping.upperLipRight = lip.values.upperR
  mapping.lowerLipLeft = lip.values.lowerL
  mapping.lowerLipRight = lip.values.lowerR
  mapping.sharedRadarX = finite(gaze.sharedRadarX, 50)
  mapping.sharedRadarY = finite(gaze.sharedRadarY, 50)

  let rig = normalizeEliteRig({
    ...createInitialEliteRig(),
    browL: { tip: brow.values.browLeftTip, mid: brow.values.browLeftMid, tail: brow.values.browLeftTail },
    browR: { tip: brow.values.browRightTip, mid: brow.values.browRightMid, tail: brow.values.browRightTail },
    eyeL: { up: mapping.eyeLUp, lo: mapping.eyeLLo },
    eyeR: { up: mapping.eyeRUp, lo: mapping.eyeRLo },
    sharedRadar: { x: mapping.sharedRadarX, y: mapping.sharedRadarY },
    mouth: {
      UL: lip.values.upperL,
      UR: lip.values.upperR,
      LL: lip.values.lowerL,
      LR: lip.values.lowerR,
      sideL: corners.sideL,
      sideR: corners.sideR,
    },
    jaw: { val: jaw.value },
    tongue: { val: 0 },
  })
  if (cfg.smoothing.enabled) rig = emaRig(state.lastRig, rig, clamp(finite(cfg.smoothing.alpha, 0.6), 0, 1))
  state.lastRig = clone(rig)
  const ended = typeof performance !== "undefined" ? performance.now() : Date.now()
  return {
    rig,
    quality,
    debug: {
      mapping,
      blendshapes: blend,
      headPose: poseFrame?.ok ? { available: true, source: "landmark-mouth-frame", ...poseFrame.pose } : { available: false },
      facialTransformationMatrix: observation.facialTransformationMatrix || null,
      noseAnchor: nose,
      mouthCornerGeometry: corners.debug,
      mouthScenarioClassifier: { ...scenarioFinal, rawMouthScore: mouthScore },
      jawGeometry: jaw,
      lipGeometry: lip,
      mouthDebug: { geometryRaw: lip.raw, final: lip.values, rawMouthScore: mouthScore },
      browGate: brow.debug,
      gaze,
      calibration: calibration ? { applied: false, reason: "reserved-for-provider-independent-overlay" } : null,
    },
    nextState: state,
    semanticComputeMs: Math.max(0, ended - started),
  }
}

export function createTrackingSemanticRuntime(options = {}) {
  let state = createTrackingSemanticState()
  let config = options.config || {}
  let calibration = options.calibration || null
  return {
    process(observation) {
      return mapMediaPipeObservationToRig(observation, state, calibration, config)
    },
    reset() {
      state = createTrackingSemanticState()
    },
    getState() {
      return state
    },
    setConfig(next) {
      config = next || {}
    },
    setCalibration(next) {
      calibration = next || null
    },
  }
}
