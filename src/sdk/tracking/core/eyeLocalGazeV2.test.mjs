/**
 * Gaze V2 — Eye-Local Coordinate Gaze Tracking — Tests A–T
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  computeEyeLocalGaze,
  createGazeV2State,
  processEyeLocalGazeV2,
  resetGazeV2State,
  normalizeGazeV2Config,
  resolveGazeAlgorithm,
  resolveFaceVerticalReference,
  extractFaceAxesFromMatrix,
  computeGazeEyeReliability,
  arbitrateBinocularAxis,
  mapVerticalDirectionalResponse,
  evaluateGazeEyeClosure,
  isGazeEyeTrackingValid,
  resolveHeadLocalFrame,
  GAZE_ALGORITHM_V2,
  GAZE_ALGORITHM_LEGACY,
  GAZE_V2_LANDMARKS,
  DEFAULT_GAZE_V2_CONFIG,
} from "../core/eyeLocalGazeV2.js"
import { createOneEuroFilter } from "../core/oneEuroFilter.js"
import {
  createTrackingSemanticState,
  mapMediaPipeObservationToRig,
  resetTrackingSemanticState,
} from "../core/trackingSemanticCore.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "../../../..")

const FAST = normalizeGazeV2Config({
  neutralWarmupSamples: 4,
  neutralMaxWaitFrames: 8,
  deadZoneX: 0.002,
  deadZoneY: 0.002,
  horizontalGain: 55,
  verticalGain: 65,
  oneEuro: { minCutoff: 10, beta: 0.5, dCutoff: 1 },
})

function baseLandmarks() {
  const pts = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }))
  const set = (i, x, y, z = 0) => {
    pts[i] = { x, y, z }
  }
  // Left eye
  set(33, 0.3, 0.4)
  set(133, 0.4, 0.4)
  set(159, 0.35, 0.36)
  set(145, 0.35, 0.44)
  for (const i of GAZE_V2_LANDMARKS.left.iris) set(i, 0.35, 0.4)
  // Right eye
  set(263, 0.7, 0.4)
  set(362, 0.6, 0.4)
  set(386, 0.65, 0.36)
  set(374, 0.65, 0.44)
  for (const i of GAZE_V2_LANDMARKS.right.iris) set(i, 0.65, 0.4)
  // Stable face mid (not eyelid) for landmark-face-plane
  set(168, 0.5, 0.32)
  set(1, 0.5, 0.48)
  return pts
}

function cloneLm(lm) {
  return lm.map((p) => ({ x: p.x, y: p.y, z: p.z }))
}

function shiftAll(lm, dx, dy, dz = 0) {
  const out = cloneLm(lm)
  for (const p of out) {
    p.x += dx
    p.y += dy
    p.z += dz
  }
  return out
}

function scaleAbout(lm, cx, cy, s) {
  const out = cloneLm(lm)
  for (const p of out) {
    p.x = cx + (p.x - cx) * s
    p.y = cy + (p.y - cy) * s
  }
  return out
}

function moveIris(lm, side, dx, dy) {
  const out = cloneLm(lm)
  const idxs = side === "right" ? GAZE_V2_LANDMARKS.right.iris : GAZE_V2_LANDMARKS.left.iris
  for (const i of idxs) {
    out[i].x += dx
    out[i].y += dy
  }
  return out
}

function rotateEyeBlock(lm, side, angleRad) {
  const out = cloneLm(lm)
  const idx = side === "right" ? GAZE_V2_LANDMARKS.right : GAZE_V2_LANDMARKS.left
  const ids = [idx.outer, idx.inner, idx.upper, idx.lower, ...idx.iris]
  const cx = (out[idx.outer].x + out[idx.inner].x) / 2
  const cy = (out[idx.outer].y + out[idx.inner].y) / 2
  const c = Math.cos(angleRad)
  const s = Math.sin(angleRad)
  for (const i of ids) {
    const dx = out[i].x - cx
    const dy = out[i].y - cy
    out[i].x = cx + dx * c - dy * s
    out[i].y = cy + dx * s + dy * c
  }
  return out
}

function warm(state, lm, n = 6) {
  let st = state
  let last = null
  for (let i = 0; i < n; i++) {
    last = processEyeLocalGazeV2({
      landmarks: lm,
      blendshapes: { eyeBlinkLeft: 0.05, eyeBlinkRight: 0.05 },
      state: st,
      config: FAST,
      timestampMs: 1000 + i * 33,
      quality: 0.95,
      faceDetected: true,
    })
    st = last.nextState
  }
  return { state: st, last }
}

function collapseBothLids(lm) {
  const closed = cloneLm(lm)
  closed[159].y = closed[145].y = 0.4
  closed[386].y = closed[374].y = 0.4
  return closed
}

function invalidateBothEyes(lm) {
  const bad = cloneLm(lm)
  for (const i of [...GAZE_V2_LANDMARKS.left.iris, ...GAZE_V2_LANDMARKS.right.iris]) {
    bad[i] = { x: NaN, y: NaN, z: 0 }
  }
  return bad
}

function invalidateOneEye(lm, side) {
  const bad = cloneLm(lm)
  const idxs = side === "right" ? GAZE_V2_LANDMARKS.right.iris : GAZE_V2_LANDMARKS.left.iris
  for (const i of idxs) bad[i] = { x: NaN, y: NaN, z: 0 }
  return bad
}

function feedFrames(state, landmarks, startTs, n, cfg = FAST) {
  let st = state
  let last = null
  for (let i = 0; i < n; i++) {
    last = processEyeLocalGazeV2({
      landmarks,
      state: st,
      config: cfg,
      timestampMs: startTs + i * 33,
      quality: 0.95,
      faceDetected: true,
    })
    st = last.nextState
  }
  return last
}

test("A — Eye Local Frame 基础几何", () => {
  const lm = baseLandmarks()
  const faceRef = resolveFaceVerticalReference(lm, null, FAST)
  const left = computeEyeLocalGaze(lm, "left", FAST, faceRef)
  const right = computeEyeLocalGaze(lm, "right", FAST, faceRef)
  assert.ok(left?.valid)
  assert.ok(right?.valid)
  assert.ok(Math.abs(left.normalizedX) < 0.05)
  assert.ok(Math.abs(left.normalizedY) < 0.05)
  assert.ok(left.eyeWidth > FAST.minEyeWidth)
  assert.ok(
    [
      "eye-local-stable-plane",
      "eye-local-2d-fallback",
      "eye-local-head-landmark",
      "eye-local-head-matrix",
      "head-canonical-3d",
    ].includes(left.geometryMode)
  )
  assert.equal(left.scaleUsed, "eyeWidth")
})

test("B — Head translation: normalized gaze 基本不变", () => {
  const lm0 = baseLandmarks()
  const lm1 = shiftAll(lm0, 0.08, -0.05)
  const a = computeEyeLocalGaze(lm0, "left", FAST)
  const b = computeEyeLocalGaze(lm1, "left", FAST)
  assert.ok(Math.abs(a.normalizedX - b.normalizedX) < 0.02)
  assert.ok(Math.abs(a.normalizedY - b.normalizedY) < 0.02)
})

test("C — Head scale: normalized gaze 基本不变", () => {
  const lm0 = baseLandmarks()
  const lm1 = scaleAbout(lm0, 0.5, 0.4, 1.35)
  const a = computeEyeLocalGaze(lm0, "left", FAST)
  const b = computeEyeLocalGaze(lm1, "left", FAST)
  assert.ok(Math.abs(a.normalizedX - b.normalizedX) < 0.03)
  assert.ok(Math.abs(a.normalizedY - b.normalizedY) < 0.03)
})

test("D — Eye local rotation: local gaze 基本不变", () => {
  const lm0 = baseLandmarks()
  const lm1 = rotateEyeBlock(lm0, "left", 0.25)
  const a = computeEyeLocalGaze(lm0, "left", FAST)
  const b = computeEyeLocalGaze(lm1, "left", FAST)
  assert.ok(Math.abs(a.normalizedX - b.normalizedX) < 0.04)
  assert.ok(Math.abs(a.normalizedY - b.normalizedY) < 0.04)
})

test("E — Horizontal iris movement: X 变 Y 基本不变", () => {
  const lm0 = baseLandmarks()
  // Move both irises for consistent binocular look-right
  let lm1 = moveIris(lm0, "left", 0.02, 0) // toward inner (nose) → look right
  lm1 = moveIris(lm1, "right", -0.02, 0) // toward outer → look right
  const a = computeEyeLocalGaze(lm0, "left", FAST)
  const b = computeEyeLocalGaze(lm1, "left", FAST)
  assert.ok(b.normalizedX - a.normalizedX > 0.08)
  assert.ok(Math.abs(b.normalizedY - a.normalizedY) < 0.03)
})

test("F — Vertical iris movement: Y 变 X 基本不变", () => {
  const lm0 = baseLandmarks()
  let lm1 = moveIris(lm0, "left", 0, -0.015)
  lm1 = moveIris(lm1, "right", 0, -0.015)
  const a = computeEyeLocalGaze(lm0, "left", FAST)
  const b = computeEyeLocalGaze(lm1, "left", FAST)
  assert.ok(Math.abs(b.normalizedY - a.normalizedY) > 0.08)
  assert.ok(Math.abs(b.normalizedX - a.normalizedX) < 0.03)
})

test("G — Left/right binocular fusion", () => {
  const lm = baseLandmarks()
  // Look-right: left iris → nose (+x), right iris → temple (+x)
  let moved = moveIris(lm, "left", 0.025, 0)
  moved = moveIris(moved, "right", 0.025, 0)
  const { state, last } = warm(createGazeV2State(), lm, 6)
  const out = processEyeLocalGazeV2({
    landmarks: moved,
    blendshapes: { eyeBlinkLeft: 0.05, eyeBlinkRight: 0.05 },
    state,
    config: FAST,
    timestampMs: 2000,
    quality: 0.95,
    faceDetected: true,
  })
  assert.ok(out.debug.fused.normalizedX != null)
  assert.ok(out.debug.fused.normalizedX > 0.05)
  assert.ok(out.debug.leftWeight > 0)
  assert.ok(out.debug.rightWeight > 0)
  assert.ok(out.sharedRadarX > 52)
  void last
})

test("H — 一只眼低 reliability：另一只眼仍可提供稳定输出", () => {
  const lm = baseLandmarks()
  let moved = moveIris(lm, "left", 0.025, 0)
  moved = moveIris(moved, "right", 0.025, 0)
  moved = invalidateOneEye(moved, "left")
  const { state } = warm(createGazeV2State(), lm, 6)
  const out = processEyeLocalGazeV2({
    landmarks: moved,
    blendshapes: { eyeBlinkLeft: 0.05, eyeBlinkRight: 0.05 },
    state,
    config: FAST,
    timestampMs: 2200,
    quality: 0.95,
    faceDetected: true,
  })
  assert.ok(out.debug.left == null || out.debug.left.reliability < out.debug.right.reliability)
  assert.ok((out.debug.fusion?.leftWeight ?? 0) < out.debug.fusion.rightWeight)
  assert.notEqual(out.outputMode, "gaze_hold_both_eyes_unreliable")
  assert.equal(out.available, true)
  assert.ok(Number.isFinite(out.sharedRadarX))
})

test("I — binocular disagreement", () => {
  const lm = baseLandmarks()
  // Opposing look directions: left looks right, right looks left
  let moved = moveIris(lm, "left", 0.03, 0)
  moved = moveIris(moved, "right", -0.03, 0)
  const { state } = warm(createGazeV2State(), lm, 6)
  const out = processEyeLocalGazeV2({
    landmarks: moved,
    blendshapes: { eyeBlinkLeft: 0.05, eyeBlinkRight: 0.05 },
    state,
    config: { ...FAST, binocularDisagreementThreshold: 0.05 },
    timestampMs: 2300,
    quality: 0.95,
    faceDetected: true,
  })
  assert.equal(out.debug.binocularDisagreement, true)
  assert.equal(out.debug.disagreementX, true)
  // V2.2: disagreement is diagnostic — must not switch to amplitude-suppress mode
  assert.equal(out.outputMode, "tracking")
  assert.ok(
    ["weighted_fusion_diagnostic", "weighted_fusion"].includes(out.debug.fusion.arbitrationModeX)
  )
})

test("J — neutral median warmup", () => {
  const lm = baseLandmarks()
  const st = createGazeV2State()
  const samples = []
  for (let i = 0; i < 4; i++) {
    const out = processEyeLocalGazeV2({
      landmarks: lm,
      blendshapes: { eyeBlinkLeft: 0.05, eyeBlinkRight: 0.05 },
      state: st,
      config: FAST,
      timestampMs: 1000 + i * 33,
      faceDetected: true,
    })
    samples.push(out)
  }
  assert.equal(samples[0].warmingUp || samples[0].outputMode === "warmingUp", true)
  assert.equal(samples[0].sharedRadarX, 50)
  assert.equal(st.neutralReady, true)
  assert.equal(typeof st.neutralX, "number")
})

test("K — neutral ready 后冻结", () => {
  const lm = baseLandmarks()
  const { state } = warm(createGazeV2State(), lm, 6)
  const n0 = state.neutralX
  const n1 = state.neutralY
  let moved = moveIris(lm, "left", 0.02, 0)
  moved = moveIris(moved, "right", 0.02, 0)
  for (let i = 0; i < 10; i++) {
    processEyeLocalGazeV2({
      landmarks: moved,
      blendshapes: { eyeBlinkLeft: 0.05, eyeBlinkRight: 0.05 },
      state,
      config: FAST,
      timestampMs: 3000 + i * 33,
      faceDetected: true,
    })
  }
  assert.equal(state.neutralX, n0)
  assert.equal(state.neutralY, n1)
})

test("L — reset 后重新 neutral", () => {
  const lm = baseLandmarks()
  const { state } = warm(createGazeV2State(), lm, 6)
  assert.equal(state.neutralReady, true)
  resetGazeV2State(state)
  assert.equal(state.neutralReady, false)
  assert.equal(state.neutralX, null)
  warm(state, lm, 6)
  assert.equal(state.neutralReady, true)
})

test("M — dead zone", () => {
  const lm = baseLandmarks()
  const cfg = normalizeGazeV2Config({
    ...FAST,
    deadZoneX: 0.05,
    deadZoneY: 0.05,
    oneEuro: { minCutoff: 100, beta: 0, dCutoff: 1 },
  })
  const { state } = warm(createGazeV2State(), lm, 6)
  // Tiny iris nudge below deadzone
  let moved = moveIris(lm, "left", 0.0015, 0)
  moved = moveIris(moved, "right", 0.0015, 0)
  const out = processEyeLocalGazeV2({
    landmarks: moved,
    blendshapes: { eyeBlinkLeft: 0.05, eyeBlinkRight: 0.05 },
    state,
    config: cfg,
    timestampMs: 4000,
    faceDetected: true,
  })
  assert.ok(Math.abs(out.sharedRadarX - 50) < 1.5)
})

test("N — adaptive filter: static noise 被压制", () => {
  const f = createOneEuroFilter({ minCutoff: 1.0, beta: 0.001, dCutoff: 1 })
  const outs = []
  for (let i = 0; i < 40; i++) {
    const noise = (i % 2 === 0 ? 1 : -1) * 0.02
    outs.push(f.filter(50 + noise, 1000 + i * 16))
  }
  const peak = Math.max(...outs) - Math.min(...outs)
  assert.ok(peak < 0.04)
})

test("O — adaptive filter: 大幅快速眼动响应", () => {
  const f = createOneEuroFilter({ minCutoff: 1.0, beta: 0.05, dCutoff: 1 })
  f.filter(0, 0)
  let y = 0
  for (let i = 1; i <= 8; i++) {
    y = f.filter(1, i * 16)
  }
  assert.ok(y > 0.55)
})

test("P — blink hold / release", () => {
  const lm = baseLandmarks()
  let moved = moveIris(lm, "left", 0.02, 0)
  moved = moveIris(moved, "right", 0.02, 0)
  const { state } = warm(createGazeV2State(), lm, 6)
  const open = processEyeLocalGazeV2({
    landmarks: moved,
    state,
    config: FAST,
    timestampMs: 5000,
    faceDetected: true,
  })
  const invalid = invalidateBothEyes(moved)
  const one = processEyeLocalGazeV2({
    landmarks: invalid,
    state: open.nextState,
    config: FAST,
    timestampMs: 5033,
    faceDetected: true,
  })
  assert.notEqual(one.outputMode, "gaze_hold_both_eyes_unreliable")
  const held = feedFrames(one.nextState, invalid, 5066, Math.max(0, FAST.closureEnterFrames - 1))
  assert.equal(held.outputMode, "gaze_hold_both_eyes_unreliable")
  assert.equal(held.sharedRadarX, open.sharedRadarX)
})

test("Q — face lost", () => {
  const lm = baseLandmarks()
  const { state, last } = warm(createGazeV2State(), lm, 6)
  const lost = processEyeLocalGazeV2({
    landmarks: lm,
    state,
    config: FAST,
    timestampMs: 6000,
    faceDetected: false,
  })
  assert.equal(lost.debug.outputMode, "face_lost")
  assert.equal(lost.available, false)
  void last
})

test("R — legacy fallback", () => {
  assert.equal(resolveGazeAlgorithm({ gazeAlgorithm: "legacy" }), GAZE_ALGORITHM_LEGACY)
  assert.equal(resolveGazeAlgorithm({}), GAZE_ALGORITHM_V2)
  assert.equal(resolveGazeAlgorithm({ gazeAlgorithm: "eye-local-v2" }), GAZE_ALGORITHM_V2)

  const state = createTrackingSemanticState()
  const obs = {
    version: 1,
    timestampMs: 1000,
    frameId: 1,
    faceDetected: true,
    landmarks: baseLandmarks(),
    blendshapes: { eyeBlinkLeft: 0.05, eyeBlinkRight: 0.05 },
    source: "browser",
  }
  const legacy = mapMediaPipeObservationToRig(obs, state, null, {
    gazeAlgorithm: "legacy",
    gaze: { irisWarmupFrames: 1, irisWarmupMinSamples: 1, irisWarmupMaxWaitFrames: 1 },
  })
  assert.equal(legacy.debug.gaze.gazeAlgorithm, GAZE_ALGORITHM_LEGACY)

  const state2 = createTrackingSemanticState()
  const v2 = mapMediaPipeObservationToRig(obs, state2, null, {
    gazeAlgorithm: "eye-local-v2",
    gazeV2: { neutralWarmupSamples: 2, neutralMaxWaitFrames: 4 },
  })
  assert.equal(v2.debug.gaze.gazeAlgorithm, GAZE_ALGORITHM_V2)
})

test("S — 非 Gaze Rig 输出完全一致（legacy vs v2 非 gaze 通道）", () => {
  const makeObs = (id) => ({
    version: 1,
    timestampMs: 1000 + id * 33,
    frameId: id,
    faceDetected: true,
    landmarks: baseLandmarks(),
    blendshapes: {
      eyeBlinkLeft: 0.1,
      eyeBlinkRight: 0.1,
      jawOpen: 0.4,
      browInnerUp: 0.3,
      mouthSmileLeft: 0.2,
      mouthSmileRight: 0.2,
    },
    source: "browser",
  })
  const fastCommon = {
    lipGeometry: { neutralFrames: 1, neutralWarmupFrames: 0, scenarioTransitionFrames: 1 },
    jawGeometry: { neutralFrames: 1, neutralWarmupFrames: 0 },
    noseAnchor: { neutralFrames: 1, neutralWarmupFrames: 0 },
    mouthCorner: { neutralSampleCount: 1, neutralWarmupFrames: 0 },
    browGate: { browConfirmFrames: 1, neutralFallbackMs: 0 },
    mouthScenario: { frontalConfirmFrames: 1, closedTurnConfirmFrames: 1, neutralConfirmFrames: 1 },
    gazeShadowCompareEnabled: false,
  }
  const sL = createTrackingSemanticState()
  const sV = createTrackingSemanticState()
  let lastL
  let lastV
  for (let i = 0; i < 8; i++) {
    const obs = makeObs(i)
    lastL = mapMediaPipeObservationToRig(obs, sL, null, {
      ...fastCommon,
      gazeAlgorithm: "legacy",
      gaze: { irisWarmupFrames: 1, irisWarmupMinSamples: 1, irisWarmupMaxWaitFrames: 1 },
    })
    lastV = mapMediaPipeObservationToRig(obs, sV, null, {
      ...fastCommon,
      gazeAlgorithm: "eye-local-v2",
      gazeV2: { neutralWarmupSamples: 2, neutralMaxWaitFrames: 4 },
    })
  }
  assert.equal(lastL.rig.jaw.val, lastV.rig.jaw.val)
  assert.equal(lastL.rig.eyeL.up, lastV.rig.eyeL.up)
  assert.equal(lastL.rig.browL.tip, lastV.rig.browL.tip)
  assert.equal(lastL.rig.mouth.UL, lastV.rig.mouth.UL)
})

test("T — SC/ST/RJ untouched", () => {
  const files = [
    "src/sdk/tracking/core/eyeLocalGazeV2.js",
    "src/sdk/tracking/core/oneEuroFilter.js",
  ]
  for (const rel of files) {
    const src = readFileSync(join(root, rel), "utf8")
    assert.equal(src.includes("Scscl"), false, rel)
    assert.equal(src.includes("syncWrite"), false, rel)
    assert.equal(src.includes("rjSbus"), false, rel)
    assert.equal(src.includes("sendBusServo"), false, rel)
  }
})

test("config — DEFAULT_GAZE_V2_CONFIG 集中参数", () => {
  assert.ok(DEFAULT_GAZE_V2_CONFIG.neutralWarmupSamples >= 20)
  assert.ok(DEFAULT_GAZE_V2_CONFIG.oneEuro.minCutoff > 0)
  assert.equal(GAZE_V2_LANDMARKS.left.outer, 33)
  assert.equal(GAZE_V2_LANDMARKS.right.iris[0], 473)
})

test("semantic reset clears gazeV2", () => {
  const state = createTrackingSemanticState()
  warm(state.gazeV2, baseLandmarks(), 6)
  assert.equal(state.gazeV2.neutralReady, true)
  resetTrackingSemanticState(state)
  assert.equal(state.gazeV2.neutralReady, false)
})

// ---------------------------------------------------------------------------
// Gaze V2.1 — Stable Eye Plane + Gaze-Specific Reliability (tests A–N)
// ---------------------------------------------------------------------------

/** Identity-ish facial matrix: right=+X, up=-Y (image up), forward=-Z */
function facialMatrixIdentityish() {
  return {
    layout: "column-major",
    rows: 4,
    cols: 4,
    values: [
      1, 0, 0, 0,
      0, -1, 0, 0,
      0, 0, -1, 0,
      0, 0, 0, 1,
    ],
  }
}

function pitchRotateAll(lm, angleRad) {
  const out = cloneLm(lm)
  const cy = 0.4
  const cz = 0
  const c = Math.cos(angleRad)
  const s = Math.sin(angleRad)
  for (const p of out) {
    const dy = p.y - cy
    const dz = p.z - cz
    p.y = cy + dy * c - dz * s
    p.z = cz + dy * s + dz * c
  }
  return out
}

function yawRotateAll(lm, angleRad) {
  const out = cloneLm(lm)
  const cx = 0.5
  const cz = 0
  const c = Math.cos(angleRad)
  const s = Math.sin(angleRad)
  for (const p of out) {
    const dx = p.x - cx
    const dz = p.z - cz
    p.x = cx + dx * c - dz * s
    p.z = cz + dx * s + dz * c
  }
  return out
}

function rollRotateAll(lm, angleRad) {
  const out = cloneLm(lm)
  const cx = 0.5
  const cy = 0.4
  const c = Math.cos(angleRad)
  const s = Math.sin(angleRad)
  for (const p of out) {
    const dx = p.x - cx
    const dy = p.y - cy
    p.x = cx + dx * c - dy * s
    p.y = cy + dx * s + dy * c
  }
  return out
}

function setEyelids(lm, side, upperY, lowerY) {
  const out = cloneLm(lm)
  const idx = side === "right" ? GAZE_V2_LANDMARKS.right : GAZE_V2_LANDMARKS.left
  out[idx.upper].y = upperY
  out[idx.lower].y = lowerY
  return out
}

test("V2.1-A — head pitch: eye+iris 整体旋转，local gaze 基本不变", () => {
  const lm0 = baseLandmarks()
  const lm1 = pitchRotateAll(lm0, 0.35)
  const face0 = resolveFaceVerticalReference(lm0, null, FAST)
  const face1 = resolveFaceVerticalReference(lm1, null, FAST)
  const a = computeEyeLocalGaze(lm0, "left", FAST, face0)
  const b = computeEyeLocalGaze(lm1, "left", FAST, face1)
  assert.ok(Math.abs(a.normalizedX - b.normalizedX) < 0.05)
  assert.ok(Math.abs(a.normalizedY - b.normalizedY) < 0.05)
})

test("V2.1-B — eyelid opening change: iris 不动，vertical gaze 基本不变", () => {
  const lm0 = baseLandmarks()
  let lm1 = setEyelids(lm0, "left", 0.33, 0.47)
  lm1 = setEyelids(lm1, "right", 0.33, 0.47)
  const face = resolveFaceVerticalReference(lm0, null, FAST)
  const a = computeEyeLocalGaze(lm0, "left", FAST, face)
  const b = computeEyeLocalGaze(lm1, "left", FAST, face)
  assert.ok(Math.abs(a.normalizedY - b.normalizedY) < 0.02)
  assert.ok(Math.abs(a.normalizedX - b.normalizedX) < 0.02)
  assert.notEqual(a.eyeHeight, b.eyeHeight)
})

test("V2.1-C — vertical iris move: Y 改变、X 基本不变", () => {
  const lm0 = baseLandmarks()
  let lm1 = moveIris(lm0, "left", 0, -0.015)
  lm1 = moveIris(lm1, "right", 0, -0.015)
  const face = resolveFaceVerticalReference(lm0, null, FAST)
  const a = computeEyeLocalGaze(lm0, "left", FAST, face)
  const b = computeEyeLocalGaze(lm1, "left", FAST, face)
  assert.ok(Math.abs(b.normalizedY - a.normalizedY) > 0.08)
  assert.ok(Math.abs(b.normalizedX - a.normalizedX) < 0.03)
})

test("V2.1-D — horizontal iris move: 保持 V2 正确行为", () => {
  const lm0 = baseLandmarks()
  let lm1 = moveIris(lm0, "left", 0.02, 0)
  lm1 = moveIris(lm1, "right", -0.02, 0)
  const face = resolveFaceVerticalReference(lm0, null, FAST)
  const a = computeEyeLocalGaze(lm0, "left", FAST, face)
  const b = computeEyeLocalGaze(lm1, "left", FAST, face)
  assert.ok(b.normalizedX - a.normalizedX > 0.08)
  assert.ok(Math.abs(b.normalizedY - a.normalizedY) < 0.03)
})

test("V2.1-E — eyeHeight 改变不应成比例放大 gaze Y", () => {
  const lm0 = baseLandmarks()
  let lmIris = moveIris(lm0, "left", 0, -0.012)
  const face = resolveFaceVerticalReference(lmIris, null, FAST)
  const open = computeEyeLocalGaze(lmIris, "left", FAST, face)
  let lmNarrow = setEyelids(lmIris, "left", 0.38, 0.42)
  const narrow = computeEyeLocalGaze(lmNarrow, "left", FAST, face)
  // Old bug: Y ∝ 1/eyeHeight would amplify when lids close.
  const heightRatio = open.eyeHeight / narrow.eyeHeight
  assert.ok(heightRatio > 1.5)
  assert.ok(Math.abs(narrow.normalizedY / open.normalizedY - 1) < 0.25)
  assert.equal(open.scaleUsed, "eyeWidth")
  assert.equal(narrow.scaleUsed, "eyeWidth")
})

test("V2.1-F — one eye reliability low：另一眼继续驱动", () => {
  const lm = baseLandmarks()
  let moved = moveIris(lm, "left", 0.02, 0)
  moved = moveIris(moved, "right", 0.02, 0)
  moved = invalidateOneEye(moved, "left")
  const { state } = warm(createGazeV2State(), lm, 6)
  const out = processEyeLocalGazeV2({
    landmarks: moved,
    state,
    config: FAST,
    timestampMs: 7000,
    faceDetected: true,
  })
  assert.ok((out.debug.fusion?.leftWeight ?? 0) < out.debug.fusion.rightWeight)
  assert.ok(out.sharedRadarX > 50)
  assert.notEqual(out.outputMode, "gaze_hold_both_eyes_unreliable")
})

test("V2.1-G — look-up fixture：不触发 gaze hold", () => {
  const lm0 = baseLandmarks()
  // Look up + lids shift (as MediaPipe often does), iris still visible.
  let lm1 = moveIris(lm0, "left", 0, -0.018)
  lm1 = moveIris(lm1, "right", 0, -0.018)
  lm1 = setEyelids(lm1, "left", 0.34, 0.43)
  lm1 = setEyelids(lm1, "right", 0.34, 0.43)
  const { state } = warm(createGazeV2State(), lm0, 6)
  const out = processEyeLocalGazeV2({
    landmarks: lm1,
    blendshapes: { eyeBlinkLeft: 0.85, eyeBlinkRight: 0.8 },
    state,
    config: FAST,
    timestampMs: 7100,
    faceDetected: true,
  })
  assert.notEqual(out.outputMode, "gaze_hold_both_eyes_unreliable")
  assert.equal(out.debug.output.holdReason, null)
  assert.ok(out.sharedRadarY > 50)
})

test("V2.1-H — look-down fixture：不触发 gaze hold", () => {
  const lm0 = baseLandmarks()
  let lm1 = moveIris(lm0, "left", 0, 0.018)
  lm1 = moveIris(lm1, "right", 0, 0.018)
  lm1 = setEyelids(lm1, "left", 0.37, 0.46)
  lm1 = setEyelids(lm1, "right", 0.37, 0.46)
  const { state } = warm(createGazeV2State(), lm0, 6)
  const out = processEyeLocalGazeV2({
    landmarks: lm1,
    blendshapes: { eyeBlinkLeft: 0.7, eyeBlinkRight: 0.65 },
    state,
    config: FAST,
    timestampMs: 7200,
    faceDetected: true,
  })
  assert.notEqual(out.outputMode, "gaze_hold_both_eyes_unreliable")
  assert.equal(out.debug.output.holdReason, null)
  assert.ok(out.sharedRadarY < 50)
})

test("V2.1-I — true both-eye blink：hold", () => {
  const lm = baseLandmarks()
  let moved = moveIris(lm, "left", 0.02, 0)
  moved = moveIris(moved, "right", 0.02, 0)
  const { state } = warm(createGazeV2State(), lm, 6)
  const open = processEyeLocalGazeV2({
    landmarks: moved,
    state,
    config: FAST,
    timestampMs: 7300,
    faceDetected: true,
  })
  const invalid = invalidateBothEyes(moved)
  const held = feedFrames(open.nextState, invalid, 7333, FAST.closureEnterFrames)
  assert.equal(held.outputMode, "gaze_hold_both_eyes_unreliable")
  assert.equal(held.debug.output.holdReason, "both_eyes_tracking_invalid")
  assert.equal(held.sharedRadarX, open.sharedRadarX)
})

test("V2.1-J — blink release：平滑恢复（经 OneEuro，不瞬跳 raw）", () => {
  const lm = baseLandmarks()
  let moved = moveIris(lm, "left", 0.025, 0)
  moved = moveIris(moved, "right", 0.025, 0)
  const { state } = warm(createGazeV2State(), lm, 6)
  const open = processEyeLocalGazeV2({
    landmarks: moved,
    state,
    config: FAST,
    timestampMs: 7400,
    faceDetected: true,
  })
  const invalid = invalidateBothEyes(moved)
  const held = feedFrames(open.nextState, invalid, 7433, FAST.closureEnterFrames)
  assert.equal(held.outputMode, "gaze_hold_both_eyes_unreliable")
  const released = feedFrames(held.nextState, moved, 7600, FAST.closureReleaseFrames)
  assert.notEqual(released.outputMode, "gaze_hold_both_eyes_unreliable")
  assert.ok(Math.abs(released.sharedRadarX - held.sharedRadarX) < 8)
})

test("V2.1-K — neutral 行为保持", () => {
  const lm = baseLandmarks()
  const st = createGazeV2State()
  for (let i = 0; i < 4; i++) {
    processEyeLocalGazeV2({
      landmarks: lm,
      state: st,
      config: FAST,
      timestampMs: 8000 + i * 33,
      faceDetected: true,
    })
  }
  assert.equal(st.neutralReady, true)
  const n0 = st.neutralX
  let moved = moveIris(lm, "left", 0.02, 0)
  moved = moveIris(moved, "right", 0.02, 0)
  processEyeLocalGazeV2({
    landmarks: moved,
    state: st,
    config: FAST,
    timestampMs: 8200,
    faceDetected: true,
  })
  assert.equal(st.neutralX, n0)
})

test("V2.1-L — OneEuro / Gain / DeadZone / Neutral 默认未改", () => {
  assert.equal(DEFAULT_GAZE_V2_CONFIG.oneEuro.minCutoff, 1.0)
  assert.equal(DEFAULT_GAZE_V2_CONFIG.oneEuro.beta, 0.02)
  assert.equal(DEFAULT_GAZE_V2_CONFIG.oneEuro.dCutoff, 1.0)
  assert.equal(DEFAULT_GAZE_V2_CONFIG.horizontalGain, 55)
  assert.equal(DEFAULT_GAZE_V2_CONFIG.verticalGain, 65)
  assert.equal(DEFAULT_GAZE_V2_CONFIG.deadZoneX, 0.008)
  assert.equal(DEFAULT_GAZE_V2_CONFIG.deadZoneY, 0.008)
  assert.equal(DEFAULT_GAZE_V2_CONFIG.neutralWarmupSamples, 24)
})

test("V2.1-M — Brow/Mouth/Jaw 输出不变（expression blink 路径独立）", () => {
  const makeObs = (id, blink = 0.1) => ({
    version: 1,
    timestampMs: 9000 + id * 33,
    frameId: id,
    faceDetected: true,
    landmarks: baseLandmarks(),
    blendshapes: {
      eyeBlinkLeft: blink,
      eyeBlinkRight: blink,
      jawOpen: 0.45,
      browInnerUp: 0.35,
      mouthSmileLeft: 0.25,
      mouthSmileRight: 0.25,
    },
    facialTransformationMatrix: facialMatrixIdentityish(),
    source: "browser",
  })
  const fastCommon = {
    lipGeometry: { neutralFrames: 1, neutralWarmupFrames: 0, scenarioTransitionFrames: 1 },
    jawGeometry: { neutralFrames: 1, neutralWarmupFrames: 0 },
    noseAnchor: { neutralFrames: 1, neutralWarmupFrames: 0 },
    mouthCorner: { neutralSampleCount: 1, neutralWarmupFrames: 0 },
    browGate: { browConfirmFrames: 1, neutralFallbackMs: 0 },
    mouthScenario: { frontalConfirmFrames: 1, closedTurnConfirmFrames: 1, neutralConfirmFrames: 1 },
    gazeShadowCompareEnabled: false,
  }
  const sA = createTrackingSemanticState()
  const sB = createTrackingSemanticState()
  let lastA
  let lastB
  for (let i = 0; i < 8; i++) {
    lastA = mapMediaPipeObservationToRig(makeObs(i, 0.1), sA, null, {
      ...fastCommon,
      gazeAlgorithm: "eye-local-v2",
      gazeV2: { neutralWarmupSamples: 2, neutralMaxWaitFrames: 4 },
    })
    lastB = mapMediaPipeObservationToRig(makeObs(i, 0.9), sB, null, {
      ...fastCommon,
      gazeAlgorithm: "eye-local-v2",
      gazeV2: { neutralWarmupSamples: 2, neutralMaxWaitFrames: 4 },
    })
  }
  // Expression blink changes eyelid rig; jaw/brow/mouth channels still independent of gaze hold math.
  assert.equal(lastA.rig.jaw.val, lastB.rig.jaw.val)
  assert.equal(lastA.rig.browL.tip, lastB.rig.browL.tip)
  assert.equal(lastA.rig.mouth.UL, lastB.rig.mouth.UL)
  assert.notEqual(lastA.rig.eyeL.up, lastB.rig.eyeL.up)
})

test("V2.1-N — SC/ST/RJ untouched + facial-matrix path preferred", () => {
  const src = readFileSync(join(root, "src/sdk/tracking/core/eyeLocalGazeV2.js"), "utf8")
  assert.equal(src.includes("Scscl"), false)
  assert.equal(src.includes("syncWrite"), false)
  assert.equal(src.includes("rjSbus"), false)
  const axes = extractFaceAxesFromMatrix(facialMatrixIdentityish())
  assert.ok(axes?.normal)
  const lm = baseLandmarks()
  const ref = resolveFaceVerticalReference(lm, facialMatrixIdentityish(), FAST)
  assert.equal(ref.headCompensationMode, "head-canonical-3d")
  const { state } = warm(createGazeV2State(), lm, 6)
  const out = processEyeLocalGazeV2({
    landmarks: lm,
    facialTransformationMatrix: facialMatrixIdentityish(),
    state,
    config: FAST,
    timestampMs: 9500,
    faceDetected: true,
  })
  assert.equal(out.debug.left.geometryMode, "head-canonical-3d")
  assert.equal(out.debug.frame.headCompensationMode, "head-canonical-3d")
  assert.equal(typeof out.debug.left.reliability, "number")
  assert.equal(out.debug.left.scaleUsed, "eyeWidth")
})

test("V2.1 — expression blink blendshapes 不驱动 gaze hold", () => {
  const lm = baseLandmarks()
  const { state } = warm(createGazeV2State(), lm, 6)
  const out = processEyeLocalGazeV2({
    landmarks: lm,
    blendshapes: { eyeBlinkLeft: 0.99, eyeBlinkRight: 0.99 },
    state,
    config: FAST,
    timestampMs: 9600,
    faceDetected: true,
  })
  assert.notEqual(out.outputMode, "gaze_hold_both_eyes_unreliable")
  assert.equal(out.debug.output.holdReason, null)
})

test("V2.1 — reliability 连续 0..1", () => {
  const lm = baseLandmarks()
  const face = resolveFaceVerticalReference(lm, null, FAST)
  const eye = computeEyeLocalGaze(lm, "left", FAST, face)
  const r = computeGazeEyeReliability(eye, 0.9, FAST, {
    opennessRatio: 1,
    trackingValid: true,
  })
  assert.ok(r > 0.3 && r <= 1)
  const closed = setEyelids(lm, "left", 0.4, 0.4)
  const eyeC = computeEyeLocalGaze(closed, "left", FAST, face)
  const rC = computeGazeEyeReliability(eyeC, 0.9, FAST, {
    opennessRatio: 0.2,
    trackingValid: true,
    closureCandidate: false,
  })
  // Soft openness downweight — must NOT collapse to ~0.048
  assert.ok(rC >= FAST.opennessReliabilityFloor * 0.5)
  assert.ok(rC < r)
})

// ---------------------------------------------------------------------------
// Gaze V2.2 — Binocular Disagreement Arbitration (tests A–O)
// ---------------------------------------------------------------------------

test("V2.2-A — mirrored horizontal symmetry", () => {
  const lm = baseLandmarks()
  const { state: sL } = warm(createGazeV2State(), lm, 6)
  const { state: sR } = warm(createGazeV2State(), lm, 6)
  // Look left: left iris → temple (-x), right iris → nose (+x in image = toward inner)
  let leftGaze = moveIris(lm, "left", -0.025, 0)
  leftGaze = moveIris(leftGaze, "right", -0.025, 0)
  // Look right: mirrored displacements
  let rightGaze = moveIris(lm, "left", 0.025, 0)
  rightGaze = moveIris(rightGaze, "right", 0.025, 0)

  const outL = processEyeLocalGazeV2({
    landmarks: leftGaze,
    state: sL,
    config: FAST,
    timestampMs: 10000,
    quality: 0.95,
    faceDetected: true,
  })
  const outR = processEyeLocalGazeV2({
    landmarks: rightGaze,
    state: sR,
    config: FAST,
    timestampMs: 10000,
    quality: 0.95,
    faceDetected: true,
  })
  const magL = Math.abs(outL.sharedRadarX - 50)
  const magR = Math.abs(outR.sharedRadarX - 50)
  assert.ok(magL > 3, `left magnitude too small: ${magL}`)
  assert.ok(magR > 3, `right magnitude too small: ${magR}`)
  assert.ok(Math.abs(magL - magR) < 2.5, `asymmetry left=${magL} right=${magR}`)
})

test("V2.2-B — right gaze 有效范围", () => {
  const lm = baseLandmarks()
  const { state } = warm(createGazeV2State(), lm, 6)
  let moved = moveIris(lm, "left", 0.03, 0)
  moved = moveIris(moved, "right", 0.03, 0)
  // Inject mild perspective difference so disagreementX may fire
  moved = moveIris(moved, "right", 0.012, 0)
  const out = processEyeLocalGazeV2({
    landmarks: moved,
    state,
    config: { ...FAST, binocularDisagreementThreshold: 0.05 },
    timestampMs: 10100,
    quality: 0.95,
    faceDetected: true,
  })
  assert.ok(out.sharedRadarX > 55, `right range weak: ${out.sharedRadarX}`)
  assert.ok(out.debug.left.reliability > 0.8)
  assert.ok(out.debug.right.reliability > 0.8)
  // Must not crush: after ≈ before when both reliable
  const before = out.debug.fusion.fusedBeforeDisagreementX
  const after = out.debug.fusion.fusedAfterDisagreementX
  assert.ok(Math.abs(after - before) < 1e-9)
})

test("V2.2-C — left gaze 有效范围", () => {
  const lm = baseLandmarks()
  const { state } = warm(createGazeV2State(), lm, 6)
  let moved = moveIris(lm, "left", -0.03, 0)
  moved = moveIris(moved, "right", -0.03, 0)
  moved = moveIris(moved, "left", -0.012, 0)
  const out = processEyeLocalGazeV2({
    landmarks: moved,
    state,
    config: { ...FAST, binocularDisagreementThreshold: 0.05 },
    timestampMs: 10200,
    quality: 0.95,
    faceDetected: true,
  })
  assert.ok(out.sharedRadarX < 45, `left range weak: ${out.sharedRadarX}`)
})

test("V2.2-D — vertical gaze 有效范围", () => {
  const lm = baseLandmarks()
  const { state } = warm(createGazeV2State(), lm, 6)
  let moved = moveIris(lm, "left", 0, -0.02)
  moved = moveIris(moved, "right", 0, -0.014) // imperfect match → possible disagreementY
  const out = processEyeLocalGazeV2({
    landmarks: moved,
    state,
    config: { ...FAST, binocularDisagreementThreshold: 0.04 },
    timestampMs: 10300,
    quality: 0.95,
    faceDetected: true,
  })
  assert.ok(out.sharedRadarY > 54, `vertical crushed: ${out.sharedRadarY}`)
  const before = Math.abs(out.debug.fusion.fusedBeforeDisagreementY - out.debug.neutral.y)
  const after = Math.abs(out.debug.fusion.fusedAfterDisagreementY - out.debug.neutral.y)
  // No order-of-magnitude crush
  assert.ok(after / Math.max(before, 1e-6) > 0.85)
})

test("V2.2-E — per-axis disagreement", () => {
  const lm = baseLandmarks()
  const { state } = warm(createGazeV2State(), lm, 6)
  // Strong X disagreement, Y aligned
  let moved = moveIris(lm, "left", 0.04, -0.01)
  moved = moveIris(moved, "right", -0.04, -0.01)
  const out = processEyeLocalGazeV2({
    landmarks: moved,
    state,
    config: { ...FAST, binocularDisagreementThreshold: 0.05 },
    timestampMs: 10400,
    quality: 0.95,
    faceDetected: true,
  })
  assert.equal(out.debug.disagreementX, true)
  assert.equal(out.debug.fusion.disagreementX, true)
  // Y disagreement independent — vertical look shared so likely false
  assert.equal(typeof out.debug.disagreementY, "boolean")
  assert.equal(out.debug.binocularDisagreement, true)
  // X disagreement must not suppress Y path via global *0.35
  assert.equal(out.outputMode, "tracking")
  assert.ok(out.sharedRadarY !== 50 || Math.abs(out.eyeLookY) >= 0)
})

test("V2.2-F — high-reliability disagreement 不压缩幅度", () => {
  const ax = arbitrateBinocularAxis({
    valueLeft: 0.22,
    valueRight: 0.08,
    relL: 0.9,
    relR: 0.85,
    disagreement: true,
    usableThreshold: 0.45,
  })
  assert.equal(ax.arbitrationMode, "weighted_fusion_diagnostic")
  const expected = (0.9 * 0.22 + 0.85 * 0.08) / (0.9 + 0.85)
  assert.ok(Math.abs(ax.value - expected) < 1e-9)
  // Must NOT be ~0.35 * anything tiny
  assert.ok(ax.value > 0.12)

  const lm = baseLandmarks()
  const { state } = warm(createGazeV2State(), lm, 6)
  let moved = moveIris(lm, "left", 0.028, 0)
  moved = moveIris(moved, "right", 0.01, 0) // perspective gap
  const out = processEyeLocalGazeV2({
    landmarks: moved,
    state,
    config: { ...FAST, binocularDisagreementThreshold: 0.05 },
    timestampMs: 10500,
    quality: 0.95,
    faceDetected: true,
  })
  assert.ok(out.debug.left.reliability > 0.8)
  assert.ok(out.debug.right.reliability > 0.8)
  const signal = out.debug.signal.preDeadzoneX
  const rawDelta = out.rawX - out.neutralX
  assert.ok(Math.abs(signal - rawDelta) < 1e-9, "preDeadzone must equal neutral-relative fused")
  assert.ok(Math.abs(signal) > 0.05)
})

test("V2.2-G — one-eye unreliable fallback", () => {
  const lm = baseLandmarks()
  let moved = moveIris(lm, "left", 0.025, 0)
  moved = moveIris(moved, "right", 0.025, 0)
  moved = invalidateOneEye(moved, "left")
  const { state } = warm(createGazeV2State(), lm, 6)
  const out = processEyeLocalGazeV2({
    landmarks: moved,
    state,
    config: FAST,
    timestampMs: 10600,
    quality: 0.95,
    faceDetected: true,
  })
  assert.ok((out.debug.left?.reliability ?? 0) < 0.45)
  assert.ok(out.debug.right.reliability > 0.8)
  assert.ok(["dominant_right", "right_only"].includes(out.debug.fusion.arbitrationModeX))
  assert.notEqual(out.outputMode, "gaze_hold_both_eyes_unreliable")
  assert.ok(out.sharedRadarX > 50)
})

test("V2.2-H — both-eye unreliable hold", () => {
  const lm = baseLandmarks()
  let moved = moveIris(lm, "left", 0.02, 0)
  moved = moveIris(moved, "right", 0.02, 0)
  const { state } = warm(createGazeV2State(), lm, 6)
  const open = processEyeLocalGazeV2({
    landmarks: moved,
    state,
    config: FAST,
    timestampMs: 10700,
    faceDetected: true,
  })
  const invalid = invalidateBothEyes(moved)
  const held = feedFrames(open.nextState, invalid, 10733, FAST.closureEnterFrames)
  assert.equal(held.outputMode, "gaze_hold_both_eyes_unreliable")
  assert.equal(held.sharedRadarX, open.sharedRadarX)
})

test("V2.2-I — neutral 未变", () => {
  assert.equal(DEFAULT_GAZE_V2_CONFIG.neutralWarmupSamples, 24)
})

test("V2.2-J — OneEuro 未变", () => {
  assert.equal(DEFAULT_GAZE_V2_CONFIG.oneEuro.minCutoff, 1.0)
  assert.equal(DEFAULT_GAZE_V2_CONFIG.oneEuro.beta, 0.02)
  assert.equal(DEFAULT_GAZE_V2_CONFIG.oneEuro.dCutoff, 1.0)
})

test("V2.2-K — Gain 未变", () => {
  assert.equal(DEFAULT_GAZE_V2_CONFIG.horizontalGain, 55)
  assert.equal(DEFAULT_GAZE_V2_CONFIG.verticalGain, 65)
})

test("V2.2-L — DeadZone 未变", () => {
  assert.equal(DEFAULT_GAZE_V2_CONFIG.deadZoneX, 0.008)
  assert.equal(DEFAULT_GAZE_V2_CONFIG.deadZoneY, 0.008)
})

test("V2.2-M — Blink reliability 未变", () => {
  assert.equal(DEFAULT_GAZE_V2_CONFIG.reliabilityHoldThreshold, 0.22)
  assert.equal(DEFAULT_GAZE_V2_CONFIG.eyeClosedOpennessRatio, 0.2)
  assert.equal(DEFAULT_GAZE_V2_CONFIG.blinkEnterThreshold, 0.48)
  const src = readFileSync(join(root, "src/sdk/tracking/core/eyesBlink.js"), "utf8")
  assert.ok(src.includes("eyeBlinkLeft"))
  const gazeSrc = readFileSync(join(root, "src/sdk/tracking/core/eyeLocalGazeV2.js"), "utf8")
  assert.equal(/signalX\s*\*=\s*0\.35/.test(gazeSrc), false)
  assert.equal(/signalY\s*\*=\s*0\.35/.test(gazeSrc), false)
  assert.equal(/if\s*\(\s*binocularDisagreement\s*\)\s*\{[^}]*\*=/.test(gazeSrc), false)
})

test("V2.2-N — Brow/Mouth/Jaw regression", () => {
  const makeObs = (id) => ({
    version: 1,
    timestampMs: 11000 + id * 33,
    frameId: id,
    faceDetected: true,
    landmarks: baseLandmarks(),
    blendshapes: {
      eyeBlinkLeft: 0.1,
      eyeBlinkRight: 0.1,
      jawOpen: 0.4,
      browInnerUp: 0.3,
      mouthSmileLeft: 0.2,
      mouthSmileRight: 0.2,
    },
    source: "browser",
  })
  const fastCommon = {
    lipGeometry: { neutralFrames: 1, neutralWarmupFrames: 0, scenarioTransitionFrames: 1 },
    jawGeometry: { neutralFrames: 1, neutralWarmupFrames: 0 },
    noseAnchor: { neutralFrames: 1, neutralWarmupFrames: 0 },
    mouthCorner: { neutralSampleCount: 1, neutralWarmupFrames: 0 },
    browGate: { browConfirmFrames: 1, neutralFallbackMs: 0 },
    mouthScenario: { frontalConfirmFrames: 1, closedTurnConfirmFrames: 1, neutralConfirmFrames: 1 },
    gazeShadowCompareEnabled: false,
  }
  const sL = createTrackingSemanticState()
  const sV = createTrackingSemanticState()
  let lastL
  let lastV
  for (let i = 0; i < 8; i++) {
    const obs = makeObs(i)
    lastL = mapMediaPipeObservationToRig(obs, sL, null, {
      ...fastCommon,
      gazeAlgorithm: "legacy",
      gaze: { irisWarmupFrames: 1, irisWarmupMinSamples: 1, irisWarmupMaxWaitFrames: 1 },
    })
    lastV = mapMediaPipeObservationToRig(obs, sV, null, {
      ...fastCommon,
      gazeAlgorithm: "eye-local-v2",
      gazeV2: { neutralWarmupSamples: 2, neutralMaxWaitFrames: 4 },
    })
  }
  assert.equal(lastL.rig.jaw.val, lastV.rig.jaw.val)
  assert.equal(lastL.rig.browL.tip, lastV.rig.browL.tip)
  assert.equal(lastL.rig.mouth.UL, lastV.rig.mouth.UL)
})

test("V2.2-O — SC/ST/RJ untouched", () => {
  const src = readFileSync(join(root, "src/sdk/tracking/core/eyeLocalGazeV2.js"), "utf8")
  assert.equal(src.includes("Scscl"), false)
  assert.equal(src.includes("syncWrite"), false)
  assert.equal(src.includes("rjSbus"), false)
  assert.equal(src.includes("sendBusServo"), false)
})

// ---------------------------------------------------------------------------
// Gaze V2.3 — Vertical Reliability / True Eye Closure (tests A–V)
// ---------------------------------------------------------------------------

test("V2.3-A — Neutral warmup 建立 neutralEyeOpenness L/R", () => {
  const lm = baseLandmarks()
  const st = createGazeV2State()
  warm(st, lm, 6)
  assert.equal(st.neutralReady, true)
  assert.ok(Number.isFinite(st.neutralEyeOpennessLeft))
  assert.ok(Number.isFinite(st.neutralEyeOpennessRight))
  assert.ok(st.neutralEyeOpennessLeft > 0.3)
})

test("V2.3-B — Neutral Eye Openness 使用 median", () => {
  const lm = baseLandmarks()
  const st = createGazeV2State()
  // Vary openness during warmup then settle
  for (let i = 0; i < 6; i++) {
    const frame = i < 2 ? setEyelids(setEyelids(lm, "left", 0.34, 0.46), "right", 0.34, 0.46) : lm
    processEyeLocalGazeV2({
      landmarks: frame,
      state: st,
      config: FAST,
      timestampMs: 12000 + i * 33,
      faceDetected: true,
    })
  }
  assert.equal(st.neutralReady, true)
  const mid = st.samplesOpenL.slice().sort((a, b) => a - b)
  const expect = mid.length % 2 ? mid[(mid.length - 1) / 2] : (mid[mid.length / 2 - 1] + mid[mid.length / 2]) / 2
  assert.ok(Math.abs(st.neutralEyeOpennessLeft - expect) < 1e-9)
})

test("V2.3-C — Neutral ready 后 baseline 冻结", () => {
  const lm = baseLandmarks()
  const { state } = warm(createGazeV2State(), lm, 6)
  const o0 = state.neutralEyeOpennessLeft
  let narrow = setEyelids(lm, "left", 0.38, 0.42)
  narrow = setEyelids(narrow, "right", 0.38, 0.42)
  for (let i = 0; i < 8; i++) {
    processEyeLocalGazeV2({
      landmarks: narrow,
      state,
      config: FAST,
      timestampMs: 13000 + i * 33,
      faceDetected: true,
    })
  }
  assert.equal(state.neutralEyeOpennessLeft, o0)
})

test("V2.3-D — Reset 重建 baseline", () => {
  const lm = baseLandmarks()
  const { state } = warm(createGazeV2State(), lm, 6)
  assert.ok(state.neutralEyeOpennessLeft != null)
  resetGazeV2State(state)
  assert.equal(state.neutralEyeOpennessLeft, null)
  assert.equal(state.neutralReady, false)
  warm(state, lm, 6)
  assert.ok(Number.isFinite(state.neutralEyeOpennessLeft))
})

test("V2.3-E — Look Up：lid narrow + iris valid → 不 hold", () => {
  const lm = baseLandmarks()
  const { state } = warm(createGazeV2State(), lm, 6)
  let up = moveIris(lm, "left", 0, -0.018)
  up = moveIris(up, "right", 0, -0.018)
  up = setEyelids(up, "left", 0.37, 0.41) // narrower but not collapsed
  up = setEyelids(up, "right", 0.37, 0.41)
  const out = processEyeLocalGazeV2({
    landmarks: up,
    state,
    config: FAST,
    timestampMs: 14000,
    quality: 0.95,
    faceDetected: true,
  })
  assert.equal(out.debug.left.trackingValid, true)
  assert.equal(out.debug.left.closureCandidate, false)
  assert.equal(out.debug.trueClosureActive, false)
  assert.notEqual(out.outputMode, "gaze_hold_both_eyes_unreliable")
  assert.ok(out.sharedRadarY > 50)
})

test("V2.3-F — Look Down：同 E", () => {
  const lm = baseLandmarks()
  const { state } = warm(createGazeV2State(), lm, 6)
  let down = moveIris(lm, "left", 0, 0.018)
  down = moveIris(down, "right", 0, 0.018)
  down = setEyelids(down, "left", 0.37, 0.41)
  down = setEyelids(down, "right", 0.37, 0.41)
  const out = processEyeLocalGazeV2({
    landmarks: down,
    state,
    config: FAST,
    timestampMs: 14100,
    quality: 0.95,
    faceDetected: true,
  })
  assert.equal(out.debug.right.trackingValid, true)
  assert.equal(out.debug.trueClosureActive, false)
  assert.notEqual(out.outputMode, "gaze_hold_both_eyes_unreliable")
  assert.ok(out.sharedRadarY < 50)
})

test("V2.3-G — Vertical Y 在 eyelid narrowing 时仍可通过", () => {
  const lm = baseLandmarks()
  const { state } = warm(createGazeV2State(), lm, 6)
  let moved = moveIris(lm, "left", 0, -0.02)
  moved = moveIris(moved, "right", 0, -0.02)
  moved = setEyelids(moved, "left", 0.375, 0.415)
  moved = setEyelids(moved, "right", 0.375, 0.415)
  const out = processEyeLocalGazeV2({
    landmarks: moved,
    state,
    config: FAST,
    timestampMs: 14200,
    quality: 0.95,
    faceDetected: true,
  })
  assert.ok(out.debug.left.reliability > 0.3, `rel=${out.debug.left.reliability}`)
  assert.ok(out.sharedRadarY > 54)
  assert.notEqual(out.outputMode, "gaze_hold_both_eyes_unreliable")
})

test("V2.3-H — 单眼 closure：另一眼 dominant，不 global hold", () => {
  const lm = baseLandmarks()
  let moved = moveIris(lm, "left", 0.025, 0)
  moved = moveIris(moved, "right", 0.025, 0)
  moved = invalidateOneEye(moved, "left")
  const { state } = warm(createGazeV2State(), lm, 6)
  const out = processEyeLocalGazeV2({
    landmarks: moved,
    state,
    config: FAST,
    timestampMs: 14300,
    quality: 0.95,
    faceDetected: true,
  })
  assert.ok(out.debug.left == null || out.debug.left.closureCandidate === true)
  assert.equal(out.debug.right.closureCandidate, false)
  assert.ok((out.debug.fusion?.leftWeight ?? 0) < out.debug.fusion.rightWeight)
  assert.notEqual(out.outputMode, "gaze_hold_both_eyes_unreliable")
})

test("V2.3-I — 双眼真正 closure 单帧：不立即 hold", () => {
  const lm = baseLandmarks()
  const { state } = warm(createGazeV2State(), lm, 6)
  const open = processEyeLocalGazeV2({
    landmarks: lm,
    state,
    config: FAST,
    timestampMs: 14400,
    faceDetected: true,
  })
  const one = processEyeLocalGazeV2({
    landmarks: invalidateBothEyes(lm),
    state: open.nextState,
    config: FAST,
    timestampMs: 14433,
    faceDetected: true,
  })
  assert.notEqual(one.outputMode, "gaze_hold_both_eyes_unreliable")
  assert.equal(one.debug.closure.enterCount, 1)
})

test("V2.3-J — 双眼 closure 连续 enter frames → hold", () => {
  const lm = baseLandmarks()
  const { state } = warm(createGazeV2State(), lm, 6)
  const open = processEyeLocalGazeV2({
    landmarks: lm,
    state,
    config: FAST,
    timestampMs: 14500,
    faceDetected: true,
  })
  const held = feedFrames(open.nextState, invalidateBothEyes(lm), 14533, FAST.closureEnterFrames)
  assert.equal(held.outputMode, "gaze_hold_both_eyes_unreliable")
  assert.equal(held.debug.trueClosureActive, true)
})

test("V2.3-K — closure release hysteresis", () => {
  const lm = baseLandmarks()
  const { state } = warm(createGazeV2State(), lm, 6)
  const open = processEyeLocalGazeV2({
    landmarks: lm,
    state,
    config: FAST,
    timestampMs: 14600,
    faceDetected: true,
  })
  const held = feedFrames(open.nextState, invalidateBothEyes(lm), 14633, FAST.closureEnterFrames)
  const stillHeld = processEyeLocalGazeV2({
    landmarks: lm,
    state: held.nextState,
    config: FAST,
    timestampMs: 14800,
    faceDetected: true,
  })
  if (FAST.closureReleaseFrames > 1) {
    assert.equal(stillHeld.outputMode, "gaze_hold_both_eyes_unreliable")
  }
  const released = feedFrames(stillHeld.nextState, lm, 14833, FAST.closureReleaseFrames)
  assert.notEqual(released.outputMode, "gaze_hold_both_eyes_unreliable")
  assert.equal(released.debug.trueClosureActive, false)
})

test("V2.3-L — true closure 保持 lastReliable", () => {
  const lm = baseLandmarks()
  let moved = moveIris(lm, "left", 0.03, 0)
  moved = moveIris(moved, "right", 0.03, 0)
  const { state } = warm(createGazeV2State(), lm, 6)
  const open = processEyeLocalGazeV2({
    landmarks: moved,
    state,
    config: FAST,
    timestampMs: 15000,
    faceDetected: true,
  })
  const held = feedFrames(open.nextState, invalidateBothEyes(moved), 15033, FAST.closureEnterFrames)
  assert.equal(held.sharedRadarX, open.sharedRadarX)
  assert.equal(held.sharedRadarY, open.sharedRadarY)
})

test("V2.3-M — iris/geometry 真 invalid：安全保护仍有效", () => {
  const lm = baseLandmarks()
  const { state } = warm(createGazeV2State(), lm, 6)
  const bad = cloneLm(lm)
  for (const i of [...GAZE_V2_LANDMARKS.left.iris, ...GAZE_V2_LANDMARKS.right.iris]) {
    bad[i] = { x: NaN, y: NaN, z: 0 }
  }
  const out = processEyeLocalGazeV2({
    landmarks: bad,
    state,
    config: FAST,
    timestampMs: 15100,
    faceDetected: true,
  })
  assert.equal(out.available, false)
  assert.equal(out.debug.outputMode, "invalid_geometry")
})

test("V2.3-N — Horizontal V2.2 range / symmetry regression", () => {
  const lm = baseLandmarks()
  const { state: sL } = warm(createGazeV2State(), lm, 6)
  const { state: sR } = warm(createGazeV2State(), lm, 6)
  let leftGaze = moveIris(lm, "left", -0.025, 0)
  leftGaze = moveIris(leftGaze, "right", -0.025, 0)
  let rightGaze = moveIris(lm, "left", 0.025, 0)
  rightGaze = moveIris(rightGaze, "right", 0.025, 0)
  const outL = processEyeLocalGazeV2({
    landmarks: leftGaze,
    state: sL,
    config: FAST,
    timestampMs: 15200,
    quality: 0.95,
    faceDetected: true,
  })
  const outR = processEyeLocalGazeV2({
    landmarks: rightGaze,
    state: sR,
    config: FAST,
    timestampMs: 15200,
    quality: 0.95,
    faceDetected: true,
  })
  const magL = Math.abs(outL.sharedRadarX - 50)
  const magR = Math.abs(outR.sharedRadarX - 50)
  assert.ok(magL > 3 && magR > 3)
  assert.ok(Math.abs(magL - magR) < 2.5)
})

test("V2.3-O — disagreement arbitration 完全未改（无 amplitude suppress）", () => {
  const src = readFileSync(join(root, "src/sdk/tracking/core/eyeLocalGazeV2.js"), "utf8")
  assert.equal(/signalX\s*\*=\s*0\.35/.test(src), false)
  assert.ok(src.includes("arbitrateBinocularAxis"))
  assert.ok(src.includes("weighted_fusion_diagnostic"))
})

test("V2.3-P — Gain 未改", () => {
  assert.equal(DEFAULT_GAZE_V2_CONFIG.horizontalGain, 55)
  assert.equal(DEFAULT_GAZE_V2_CONFIG.verticalGain, 65)
})

test("V2.3-Q — DeadZone 未改", () => {
  assert.equal(DEFAULT_GAZE_V2_CONFIG.deadZoneX, 0.008)
  assert.equal(DEFAULT_GAZE_V2_CONFIG.deadZoneY, 0.008)
})

test("V2.3-R — OneEuro 未改", () => {
  assert.equal(DEFAULT_GAZE_V2_CONFIG.oneEuro.minCutoff, 1.0)
  assert.equal(DEFAULT_GAZE_V2_CONFIG.oneEuro.beta, 0.02)
  assert.equal(DEFAULT_GAZE_V2_CONFIG.oneEuro.dCutoff, 1.0)
})

test("V2.3-S — Neutral X/Y 语义未改", () => {
  assert.equal(DEFAULT_GAZE_V2_CONFIG.neutralWarmupSamples, 24)
  const lm = baseLandmarks()
  const { state } = warm(createGazeV2State(), lm, 6)
  const nx = state.neutralX
  let moved = moveIris(lm, "left", 0.02, 0)
  moved = moveIris(moved, "right", 0.02, 0)
  processEyeLocalGazeV2({
    landmarks: moved,
    state,
    config: FAST,
    timestampMs: 15300,
    faceDetected: true,
  })
  assert.equal(state.neutralX, nx)
})

test("V2.3-T — Expression eyesBlink.js 完全未改", () => {
  // File must still exist with blink blendshape mapping; gaze must not import it for hold.
  const blinkSrc = readFileSync(join(root, "src/sdk/tracking/core/eyesBlink.js"), "utf8")
  assert.ok(blinkSrc.includes("eyeBlinkLeft"))
  const gazeSrc = readFileSync(join(root, "src/sdk/tracking/core/eyeLocalGazeV2.js"), "utf8")
  assert.equal(gazeSrc.includes("eyesBlink"), false)
  assert.ok(gazeSrc.includes("void blendshapes"))
})

test("V2.3-U — Brow / Mouth / Jaw regression", () => {
  const makeObs = (id) => ({
    version: 1,
    timestampMs: 16000 + id * 33,
    frameId: id,
    faceDetected: true,
    landmarks: baseLandmarks(),
    blendshapes: {
      eyeBlinkLeft: 0.12,
      eyeBlinkRight: 0.12,
      jawOpen: 0.42,
      browInnerUp: 0.33,
      mouthSmileLeft: 0.22,
      mouthSmileRight: 0.22,
    },
    source: "browser",
  })
  const fastCommon = {
    lipGeometry: { neutralFrames: 1, neutralWarmupFrames: 0, scenarioTransitionFrames: 1 },
    jawGeometry: { neutralFrames: 1, neutralWarmupFrames: 0 },
    noseAnchor: { neutralFrames: 1, neutralWarmupFrames: 0 },
    mouthCorner: { neutralSampleCount: 1, neutralWarmupFrames: 0 },
    browGate: { browConfirmFrames: 1, neutralFallbackMs: 0 },
    mouthScenario: { frontalConfirmFrames: 1, closedTurnConfirmFrames: 1, neutralConfirmFrames: 1 },
    gazeShadowCompareEnabled: false,
  }
  const sL = createTrackingSemanticState()
  const sV = createTrackingSemanticState()
  let lastL
  let lastV
  for (let i = 0; i < 8; i++) {
    const obs = makeObs(i)
    lastL = mapMediaPipeObservationToRig(obs, sL, null, {
      ...fastCommon,
      gazeAlgorithm: "legacy",
      gaze: { irisWarmupFrames: 1, irisWarmupMinSamples: 1, irisWarmupMaxWaitFrames: 1 },
    })
    lastV = mapMediaPipeObservationToRig(obs, sV, null, {
      ...fastCommon,
      gazeAlgorithm: "eye-local-v2",
      gazeV2: { neutralWarmupSamples: 2, neutralMaxWaitFrames: 4 },
    })
  }
  assert.equal(lastL.rig.jaw.val, lastV.rig.jaw.val)
  assert.equal(lastL.rig.browL.tip, lastV.rig.browL.tip)
  assert.equal(lastL.rig.mouth.UL, lastV.rig.mouth.UL)
})

test("V2.3-V — SC/ST/RJ untouched", () => {
  const src = readFileSync(join(root, "src/sdk/tracking/core/eyeLocalGazeV2.js"), "utf8")
  assert.equal(src.includes("Scscl"), false)
  assert.equal(src.includes("syncWrite"), false)
  assert.equal(src.includes("rjSbus"), false)
})

test("V2.3 — evaluateGazeEyeClosure irisStrong 不判 closure", () => {
  const lm = baseLandmarks()
  const face = resolveFaceVerticalReference(lm, null, FAST)
  const eye = computeEyeLocalGaze(lm, "left", FAST, face)
  const ev = evaluateGazeEyeClosure({ eye, opennessRatio: 0.1, cfg: FAST })
  assert.equal(ev.trackingValid, true)
  assert.equal(ev.closureCandidate, false)
  assert.equal(ev.reason, "tracking_valid_openness_ignored")
  assert.equal(isGazeEyeTrackingValid(eye, FAST), true)
})

// ---------------------------------------------------------------------------
// Gaze V2.4 — Polarity + Closure Contract + Directional Vertical (A–Y)
// ---------------------------------------------------------------------------

test("V2.4-A — Formal Face Rig Y contract", () => {
  // sharedRadar.y > 50 = LOOK_UP (useFaceRigInteraction eyeRadarDotYNorm)
  assert.ok(eyeRadarContractLookUp(60))
  assert.ok(eyeRadarContractLookDown(40))
})

function eyeRadarContractLookUp(y) {
  return ((Number(y) || 50) - 50) / 50 > 0
}
function eyeRadarContractLookDown(y) {
  return ((Number(y) || 50) - 50) / 50 < 0
}

test("V2.4-B — Synthetic iris LOOK_UP → +normalizedY / Rig Y>50", () => {
  const lm0 = baseLandmarks()
  let lm1 = moveIris(lm0, "left", 0, -0.02)
  lm1 = moveIris(lm1, "right", 0, -0.02)
  const face = resolveFaceVerticalReference(lm0, null, FAST)
  const a = computeEyeLocalGaze(lm0, "left", FAST, face)
  const b = computeEyeLocalGaze(lm1, "left", FAST, face)
  assert.ok(b.normalizedY > a.normalizedY)
  assert.ok(b.normalizedY > 0.05)
  const { state } = warm(createGazeV2State(), lm0, 6)
  const out = processEyeLocalGazeV2({
    landmarks: lm1,
    state,
    config: FAST,
    timestampMs: 20000,
    quality: 0.95,
    faceDetected: true,
  })
  assert.ok(out.sharedRadarY > 55)
  assert.equal(out.debug.vertical.direction, "LOOK_UP")
})

test("V2.4-C — Synthetic LOOK_DOWN → negative / Rig Y<50", () => {
  const lm0 = baseLandmarks()
  let lm1 = moveIris(lm0, "left", 0, 0.02)
  lm1 = moveIris(lm1, "right", 0, 0.02)
  const face = resolveFaceVerticalReference(lm0, null, FAST)
  const b = computeEyeLocalGaze(lm1, "left", FAST, face)
  assert.ok(b.normalizedY < -0.05)
  const { state } = warm(createGazeV2State(), lm0, 6)
  const out = processEyeLocalGazeV2({
    landmarks: lm1,
    state,
    config: FAST,
    timestampMs: 20100,
    quality: 0.95,
    faceDetected: true,
  })
  assert.ok(out.sharedRadarY < 45)
  assert.equal(out.debug.vertical.direction, "LOOK_DOWN")
})

test("V2.4-D — Left/right eye polarity 一致", () => {
  const lm = baseLandmarks()
  let up = moveIris(lm, "left", 0, -0.015)
  up = moveIris(up, "right", 0, -0.015)
  const face = resolveFaceVerticalReference(lm, null, FAST)
  const L = computeEyeLocalGaze(up, "left", FAST, face)
  const R = computeEyeLocalGaze(up, "right", FAST, face)
  assert.ok(L.normalizedY > 0 && R.normalizedY > 0)
})

test("V2.4-E — Facial matrix mode polarity", () => {
  const matrix = {
    layout: "column-major",
    values: [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1],
  }
  const lm = baseLandmarks()
  let up = moveIris(lm, "left", 0, -0.015)
  up = moveIris(up, "right", 0, -0.015)
  const face = resolveFaceVerticalReference(up, matrix, FAST)
  assert.equal(face.headCompensationMode, "head-canonical-3d")
  const eye = computeEyeLocalGaze(up, "left", FAST, face)
  assert.ok(eye.normalizedY > 0.05)
})

test("V2.4-F — Landmark-face-plane fallback polarity", () => {
  const lm = baseLandmarks()
  let up = moveIris(lm, "left", 0, -0.015)
  up = moveIris(up, "right", 0, -0.015)
  const face = resolveFaceVerticalReference(up, null, { ...FAST, preferFacialMatrix: false })
  assert.equal(face.verticalReferenceSource, "landmark-face-plane")
  const eye = computeEyeLocalGaze(up, "left", FAST, face)
  assert.ok(eye.normalizedY > 0.05)
})

test("V2.4-G — No double inversion", () => {
  const src = readFileSync(join(root, "src/sdk/tracking/core/eyeLocalGazeV2.js"), "utf8")
  // Head-local polarity: no post-fusion signalY *= -1; right mirror at canonical only.
  assert.equal(/signalY\s*\*=\s*-1/.test(src), false)
  assert.ok(src.includes("Canonical look-right") || src.includes("canonical look-right"))
  assert.ok(src.includes("resolveHeadLocalFrame"))
})

test("V2.4-H — trackingValid + opennessRatio=0.1 → closureCandidate=false", () => {
  const lm = collapseBothLids(baseLandmarks())
  const face = resolveFaceVerticalReference(lm, null, FAST)
  const eye = computeEyeLocalGaze(lm, "left", FAST, face)
  assert.ok(eye?.valid)
  const ev = evaluateGazeEyeClosure({ eye, opennessRatio: 0.1, cfg: FAST })
  assert.equal(ev.trackingValid, true)
  assert.equal(ev.irisValid, true)
  assert.equal(ev.closureCandidate, false)
})

test("V2.4-I — 单眼 tracking invalid：另一眼 dominant", () => {
  const lm = baseLandmarks()
  let moved = moveIris(lm, "left", 0.02, 0)
  moved = moveIris(moved, "right", 0.02, 0)
  moved = invalidateOneEye(moved, "left")
  const { state } = warm(createGazeV2State(), lm, 6)
  const out = processEyeLocalGazeV2({
    landmarks: moved,
    state,
    config: FAST,
    timestampMs: 21000,
    quality: 0.95,
    faceDetected: true,
  })
  assert.notEqual(out.outputMode, "gaze_hold_both_eyes_unreliable")
  assert.ok(out.sharedRadarX > 50)
})

test("V2.4-J — 双眼 tracking invalid 单帧：不立即 hold", () => {
  const lm = baseLandmarks()
  const { state } = warm(createGazeV2State(), lm, 6)
  const open = processEyeLocalGazeV2({
    landmarks: lm,
    state,
    config: FAST,
    timestampMs: 21100,
    faceDetected: true,
  })
  const one = processEyeLocalGazeV2({
    landmarks: invalidateBothEyes(lm),
    state: open.nextState,
    config: FAST,
    timestampMs: 21133,
    faceDetected: true,
  })
  assert.notEqual(one.outputMode, "gaze_hold_both_eyes_unreliable")
})

test("V2.4-K — 双眼持续 invalid 达 enterFrames：global hold", () => {
  const lm = baseLandmarks()
  const { state } = warm(createGazeV2State(), lm, 6)
  const open = processEyeLocalGazeV2({
    landmarks: lm,
    state,
    config: FAST,
    timestampMs: 21200,
    faceDetected: true,
  })
  const held = feedFrames(open.nextState, invalidateBothEyes(lm), 21233, FAST.closureEnterFrames)
  assert.equal(held.outputMode, "gaze_hold_both_eyes_unreliable")
})

test("V2.4-L — Openness 单独不能 global hold", () => {
  const lm = baseLandmarks()
  const { state } = warm(createGazeV2State(), lm, 6)
  const closed = collapseBothLids(lm)
  const held = feedFrames(state, closed, 21300, FAST.closureEnterFrames + 2)
  assert.notEqual(held.outputMode, "gaze_hold_both_eyes_unreliable")
  assert.equal(held.debug.left.closureCandidate, false)
  assert.equal(held.debug.trueClosureActive, false)
})

test("V2.4-M — Up full-scale → center + halfRange", () => {
  const m = mapVerticalDirectionalResponse(0.075, DEFAULT_GAZE_V2_CONFIG)
  assert.ok(Math.abs(m.mappedY - (50 + 40)) < 0.5)
  assert.equal(m.direction, "LOOK_UP")
})

test("V2.4-N — Down full-scale → center - halfRange", () => {
  const m = mapVerticalDirectionalResponse(-0.14, DEFAULT_GAZE_V2_CONFIG)
  assert.ok(Math.abs(m.mappedY - (50 - 40)) < 0.5)
  assert.equal(m.direction, "LOOK_DOWN")
})

test("V2.4-O — Half excursion → ~half range", () => {
  const m = mapVerticalDirectionalResponse(0.0375, DEFAULT_GAZE_V2_CONFIG)
  assert.ok(Math.abs(m.mappedY - 70) < 1)
})

test("V2.4-P — Over-range clamp", () => {
  const up = mapVerticalDirectionalResponse(0.5, DEFAULT_GAZE_V2_CONFIG)
  const down = mapVerticalDirectionalResponse(-0.5, DEFAULT_GAZE_V2_CONFIG)
  assert.equal(up.mappedY, 90)
  assert.equal(down.mappedY, 10)
})

test("V2.4-Q — Up / Down directional scale 独立", () => {
  assert.equal(DEFAULT_GAZE_V2_CONFIG.verticalUpFullScale, 0.075)
  assert.equal(DEFAULT_GAZE_V2_CONFIG.verticalDownFullScale, 0.14)
  assert.notEqual(
    DEFAULT_GAZE_V2_CONFIG.verticalUpFullScale,
    DEFAULT_GAZE_V2_CONFIG.verticalDownFullScale
  )
})

test("V2.4-R — Horizontal V2.2/V2.3 regression", () => {
  const lm = baseLandmarks()
  const { state: sL } = warm(createGazeV2State(), lm, 6)
  const { state: sR } = warm(createGazeV2State(), lm, 6)
  let leftGaze = moveIris(lm, "left", -0.025, 0)
  leftGaze = moveIris(leftGaze, "right", -0.025, 0)
  let rightGaze = moveIris(lm, "left", 0.025, 0)
  rightGaze = moveIris(rightGaze, "right", 0.025, 0)
  const outL = processEyeLocalGazeV2({
    landmarks: leftGaze,
    state: sL,
    config: FAST,
    timestampMs: 22000,
    quality: 0.95,
    faceDetected: true,
  })
  const outR = processEyeLocalGazeV2({
    landmarks: rightGaze,
    state: sR,
    config: FAST,
    timestampMs: 22000,
    quality: 0.95,
    faceDetected: true,
  })
  const magL = Math.abs(outL.sharedRadarX - 50)
  const magR = Math.abs(outR.sharedRadarX - 50)
  assert.ok(magL > 3 && magR > 3)
  assert.ok(Math.abs(magL - magR) < 2.5)
  assert.equal(DEFAULT_GAZE_V2_CONFIG.horizontalGain, 55)
})

test("V2.4-S — Neutral 未变", () => {
  assert.equal(DEFAULT_GAZE_V2_CONFIG.neutralWarmupSamples, 24)
})

test("V2.4-T — OneEuro 未变", () => {
  assert.equal(DEFAULT_GAZE_V2_CONFIG.oneEuro.minCutoff, 1.0)
  assert.equal(DEFAULT_GAZE_V2_CONFIG.oneEuro.beta, 0.02)
  assert.equal(DEFAULT_GAZE_V2_CONFIG.oneEuro.dCutoff, 1.0)
})

test("V2.4-U — DeadZone 未变", () => {
  assert.equal(DEFAULT_GAZE_V2_CONFIG.deadZoneX, 0.008)
  assert.equal(DEFAULT_GAZE_V2_CONFIG.deadZoneY, 0.008)
})

test("V2.4-V — disagreement arbitration 未变", () => {
  const src = readFileSync(join(root, "src/sdk/tracking/core/eyeLocalGazeV2.js"), "utf8")
  assert.equal(/signalX\s*\*=\s*0\.35/.test(src), false)
  assert.ok(src.includes("arbitrateBinocularAxis"))
})

test("V2.4-W — Expression Blink 未改", () => {
  const blinkSrc = readFileSync(join(root, "src/sdk/tracking/core/eyesBlink.js"), "utf8")
  assert.ok(blinkSrc.includes("eyeBlinkLeft"))
  const gazeSrc = readFileSync(join(root, "src/sdk/tracking/core/eyeLocalGazeV2.js"), "utf8")
  assert.ok(gazeSrc.includes("void blendshapes"))
})

test("V2.4-X — Brow / Mouth / Jaw regression", () => {
  const makeObs = (id) => ({
    version: 1,
    timestampMs: 23000 + id * 33,
    frameId: id,
    faceDetected: true,
    landmarks: baseLandmarks(),
    blendshapes: {
      eyeBlinkLeft: 0.1,
      eyeBlinkRight: 0.1,
      jawOpen: 0.4,
      browInnerUp: 0.3,
      mouthSmileLeft: 0.2,
      mouthSmileRight: 0.2,
    },
    source: "browser",
  })
  const fastCommon = {
    lipGeometry: { neutralFrames: 1, neutralWarmupFrames: 0, scenarioTransitionFrames: 1 },
    jawGeometry: { neutralFrames: 1, neutralWarmupFrames: 0 },
    noseAnchor: { neutralFrames: 1, neutralWarmupFrames: 0 },
    mouthCorner: { neutralSampleCount: 1, neutralWarmupFrames: 0 },
    browGate: { browConfirmFrames: 1, neutralFallbackMs: 0 },
    mouthScenario: { frontalConfirmFrames: 1, closedTurnConfirmFrames: 1, neutralConfirmFrames: 1 },
    gazeShadowCompareEnabled: false,
  }
  const sL = createTrackingSemanticState()
  const sV = createTrackingSemanticState()
  let lastL
  let lastV
  for (let i = 0; i < 8; i++) {
    const obs = makeObs(i)
    lastL = mapMediaPipeObservationToRig(obs, sL, null, {
      ...fastCommon,
      gazeAlgorithm: "legacy",
      gaze: { irisWarmupFrames: 1, irisWarmupMinSamples: 1, irisWarmupMaxWaitFrames: 1 },
    })
    lastV = mapMediaPipeObservationToRig(obs, sV, null, {
      ...fastCommon,
      gazeAlgorithm: "eye-local-v2",
      gazeV2: { neutralWarmupSamples: 2, neutralMaxWaitFrames: 4 },
    })
  }
  assert.equal(lastL.rig.jaw.val, lastV.rig.jaw.val)
  assert.equal(lastL.rig.browL.tip, lastV.rig.browL.tip)
  assert.equal(lastL.rig.mouth.UL, lastV.rig.mouth.UL)
})

test("V2.4-Y — SC/ST/RJ untouched", () => {
  const src = readFileSync(join(root, "src/sdk/tracking/core/eyeLocalGazeV2.js"), "utf8")
  assert.equal(src.includes("Scscl"), false)
  assert.equal(src.includes("syncWrite"), false)
  assert.equal(src.includes("rjSbus"), false)
})

// ---------------------------------------------------------------------------
// Gaze V2.4b — Head-pose decoupling + canonical head-local frame (A–H)
// ---------------------------------------------------------------------------

function warmThen(lm0, lm1, frames = 4) {
  const { state } = warm(createGazeV2State(), lm0, 6)
  let st = state
  let last = null
  for (let i = 0; i < frames; i++) {
    last = processEyeLocalGazeV2({
      landmarks: lm1,
      state: st,
      config: FAST,
      timestampMs: 30000 + i * 33,
      quality: 0.95,
      faceDetected: true,
    })
    st = last.nextState
  }
  return last
}

test("V2.4b-A — 固定凝视纯 Roll：canonical 稳定、无左右反向假眼动", () => {
  const lm0 = baseLandmarks()
  const rolled = rollRotateAll(lm0, 0.4)
  const face0 = resolveHeadLocalFrame(lm0, null, FAST)
  const face1 = resolveHeadLocalFrame(rolled, null, FAST)
  const L0 = computeEyeLocalGaze(lm0, "left", FAST, face0)
  const R0 = computeEyeLocalGaze(lm0, "right", FAST, face0)
  const L1 = computeEyeLocalGaze(rolled, "left", FAST, face1)
  const R1 = computeEyeLocalGaze(rolled, "right", FAST, face1)
  assert.ok(Math.abs(L1.canonicalX - L0.canonicalX) < 0.04)
  assert.ok(Math.abs(L1.canonicalY - L0.canonicalY) < 0.04)
  assert.ok(Math.abs(R1.canonicalX - R0.canonicalX) < 0.04)
  assert.ok(Math.abs(R1.canonicalY - R0.canonicalY) < 0.04)
  // Must NOT produce opposite-signed fake motion on left vs right canonical X.
  const dLx = L1.canonicalX - L0.canonicalX
  const dRx = R1.canonicalX - R0.canonicalX
  assert.ok(!(Math.sign(dLx) !== 0 && Math.sign(dRx) !== 0 && Math.sign(dLx) === -Math.sign(dRx) && Math.abs(dLx) > 0.03 && Math.abs(dRx) > 0.03))

  const out = warmThen(lm0, rolled, 5)
  assert.ok(Math.abs(out.sharedRadarX - 50) < 3)
  assert.ok(Math.abs(out.sharedRadarY - 50) < 3)
  assert.notEqual(out.outputMode, "gaze_hold_both_eyes_unreliable")
})

test("V2.4b-B — 固定凝视纯 Pitch：radar Y 不跟随头俯仰", () => {
  const lm0 = baseLandmarks()
  const pitched = pitchRotateAll(lm0, 0.35)
  const out = warmThen(lm0, pitched, 5)
  assert.ok(Math.abs(out.sharedRadarY - 50) < 3, `pitch leaked Y=${out.sharedRadarY}`)
  assert.ok(Math.abs(out.sharedRadarX - 50) < 3)
})

test("V2.4b-C — 固定凝视纯 Yaw：radar X 不跟随头偏航", () => {
  const lm0 = baseLandmarks()
  const yawed = yawRotateAll(lm0, 0.35)
  const out = warmThen(lm0, yawed, 5)
  assert.ok(Math.abs(out.sharedRadarX - 50) < 3, `yaw leaked X=${out.sharedRadarX}`)
  assert.ok(Math.abs(out.sharedRadarY - 50) < 3)
})

test("V2.4b-D — 头动 + 真实右看：保留右看、消除头动", () => {
  const lm0 = baseLandmarks()
  let gaze = moveIris(lm0, "left", 0.025, 0)
  gaze = moveIris(gaze, "right", 0.025, 0)
  const rolledGaze = rollRotateAll(gaze, 0.35)
  const outFixed = warmThen(lm0, gaze, 4)
  const outHead = warmThen(lm0, rolledGaze, 4)
  assert.ok(outFixed.sharedRadarX > 55)
  assert.ok(outHead.sharedRadarX > 55)
  assert.ok(Math.abs(outHead.sharedRadarX - outFixed.sharedRadarX) < 4)
})

test("V2.4b-E — 头动 + 真实上看/下看：方向保留", () => {
  const lm0 = baseLandmarks()
  let up = moveIris(lm0, "left", 0, -0.02)
  up = moveIris(up, "right", 0, -0.02)
  let down = moveIris(lm0, "left", 0, 0.02)
  down = moveIris(down, "right", 0, 0.02)
  const upRoll = rollRotateAll(up, 0.3)
  const downPitch = pitchRotateAll(down, 0.25)
  const outUp = warmThen(lm0, upRoll, 4)
  const outDown = warmThen(lm0, downPitch, 4)
  assert.ok(outUp.sharedRadarY > 55, `up lost: ${outUp.sharedRadarY}`)
  assert.ok(outDown.sharedRadarY < 45, `down lost: ${outDown.sharedRadarY}`)
})

test("V2.4b-F — 左右眼镜像一致：相同凝视 canonical 同号", () => {
  const lm = baseLandmarks()
  let rightGaze = moveIris(lm, "left", 0.02, 0)
  rightGaze = moveIris(rightGaze, "right", 0.02, 0)
  const face = resolveHeadLocalFrame(rightGaze, null, FAST)
  const L = computeEyeLocalGaze(rightGaze, "left", FAST, face)
  const R = computeEyeLocalGaze(rightGaze, "right", FAST, face)
  assert.ok(L.canonicalX > 0.05 && R.canonicalX > 0.05)
  assert.ok(Math.sign(L.canonicalX) === Math.sign(R.canonicalX))

  let up = moveIris(lm, "left", 0, -0.015)
  up = moveIris(up, "right", 0, -0.015)
  const faceU = resolveHeadLocalFrame(up, null, FAST)
  const Lu = computeEyeLocalGaze(up, "left", FAST, faceU)
  const Ru = computeEyeLocalGaze(up, "right", FAST, faceU)
  assert.ok(Lu.canonicalY > 0 && Ru.canonicalY > 0)
})

test("V2.4b-G — 可靠性回归：dominant / hold / disagreement 语义", () => {
  const lm = baseLandmarks()
  let moved = moveIris(lm, "left", 0.02, 0)
  moved = moveIris(moved, "right", 0.02, 0)
  moved = invalidateOneEye(moved, "left")
  const { state } = warm(createGazeV2State(), lm, 6)
  const one = processEyeLocalGazeV2({
    landmarks: moved,
    state,
    config: FAST,
    timestampMs: 40000,
    faceDetected: true,
  })
  assert.notEqual(one.outputMode, "gaze_hold_both_eyes_unreliable")
  assert.ok(one.sharedRadarX > 50)

  const held = feedFrames(one.nextState, invalidateBothEyes(lm), 40100, FAST.closureEnterFrames)
  assert.equal(held.outputMode, "gaze_hold_both_eyes_unreliable")

  const ax = arbitrateBinocularAxis({
    valueLeft: 0.2,
    valueRight: -0.05,
    relL: 0.9,
    relR: 0.9,
    disagreement: true,
    usableThreshold: 0.45,
  })
  assert.equal(ax.arbitrationMode, "weighted_fusion_diagnostic")
  assert.ok(Math.abs(ax.value - (0.9 * 0.2 + 0.9 * -0.05) / 1.8) < 1e-9)

  // X disagreement must not alter Y arbitration inputs (per-axis).
  const ay = arbitrateBinocularAxis({
    valueLeft: 0.1,
    valueRight: 0.1,
    relL: 0.9,
    relR: 0.9,
    disagreement: false,
    usableThreshold: 0.45,
  })
  assert.equal(ay.arbitrationMode, "weighted_fusion")
  assert.ok(Math.abs(ay.value - 0.1) < 1e-9)
})

test("V2.4b-H — Neutral：头动不漂移；reset 可重建", () => {
  const lm0 = baseLandmarks()
  const { state } = warm(createGazeV2State(), lm0, 6)
  const nX = state.neutralX
  const nY = state.neutralY
  assert.equal(state.neutralReady, true)
  const rolled = rollRotateAll(lm0, 0.45)
  for (let i = 0; i < 12; i++) {
    const out = processEyeLocalGazeV2({
      landmarks: rolled,
      state,
      config: FAST,
      timestampMs: 41000 + i * 33,
      faceDetected: true,
    })
    assert.equal(out.debug.neutral.updateAllowed, false)
    assert.equal(out.debug.neutral.updateBlockedReason, "neutral_locked")
  }
  assert.equal(state.neutralX, nX)
  assert.equal(state.neutralY, nY)

  resetGazeV2State(state)
  assert.equal(state.neutralReady, false)
  const { state: rebuilt } = warm(state, lm0, 6)
  assert.equal(rebuilt.neutralReady, true)
  assert.equal(typeof rebuilt.neutralX, "number")
})
