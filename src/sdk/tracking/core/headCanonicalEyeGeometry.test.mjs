/**
 * Head-Canonical Eye Geometry — Gaze V2.6 tests (perspective-aware)
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  landmarkNormalizedToMetricCamera,
  extractHeadRotationFromFacialMatrix,
  applyInverseHeadRotation,
  computeHeadCanonicalEyeGaze,
  computeLegacyCameraSpaceEyeGaze,
  resolveHeadCanonicalContext,
  DEFAULT_INFERENCE_WIDTH,
  DEFAULT_INFERENCE_HEIGHT,
} from "./headCanonicalEyeGeometry.js"
import {
  computeEyeLocalGaze,
  processEyeLocalGazeV2,
  createGazeV2State,
  GAZE_V2_LANDMARKS,
  normalizeGazeV2Config,
} from "./eyeLocalGazeV2.js"

const W = 640
const H = 480
const FAST = normalizeGazeV2Config({
  neutralWarmupSamples: 4,
  neutralMaxWaitFrames: 8,
  deadZoneX: 0.002,
  deadZoneY: 0.002,
  oneEuro: { minCutoff: 10, beta: 0.5, dCutoff: 1 },
  defaultImageWidth: W,
  defaultImageHeight: H,
})

function facialMatrixFromRotation(R, tx = 0, ty = 0, tz = 0) {
  const [r, u, f] = R
  return {
    layout: "column-major",
    values: [
      r[0], r[1], r[2], 0,
      u[0], u[1], u[2], 0,
      f[0], f[1], f[2], 0,
      tx, ty, tz, 1,
    ],
  }
}

function rotY(deg) {
  const c = Math.cos((deg * Math.PI) / 180)
  const s = Math.sin((deg * Math.PI) / 180)
  return [
    [c, 0, s],
    [0, 1, 0],
    [-s, 0, c],
  ]
}

function rotX(deg) {
  const c = Math.cos((deg * Math.PI) / 180)
  const s = Math.sin((deg * Math.PI) / 180)
  return [
    [1, 0, 0],
    [0, c, -s],
    [0, s, c],
  ]
}

function rotZ(deg) {
  const c = Math.cos((deg * Math.PI) / 180)
  const s = Math.sin((deg * Math.PI) / 180)
  return [
    [c, -s, 0],
    [s, c, 0],
    [0, 0, 1],
  ]
}

function matMul3(A, B) {
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j]
    }
  }
  return out
}

function matVec3(M, v) {
  return [
    M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
    M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
    M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
  ]
}

function add3(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

function sub3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function scale3(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s]
}

/** Perspective project head-space point → MediaPipe normalized landmark. */
function projectHeadPointToLandmark(pHead, headRotDeg, cameraDist = 0.35, irisGazeOffset = null, isIris = false) {
  const Ry = rotY(headRotDeg.yaw || 0)
  const Rx = rotX(headRotDeg.pitch || 0)
  const Rz = rotZ(headRotDeg.roll || 0)
  const R = matMul3(matMul3(Rz, Rx), Ry)
  const right = [R[0][0], R[1][0], R[2][0]]
  const up = [R[0][1], R[1][1], R[2][1]]
  const forward = [R[0][2], R[1][2], R[2][2]]

  const p = isIris && irisGazeOffset ? add3(pHead, irisGazeOffset) : pHead
  const cam = add3(matVec3(R, p), [0, 0, cameraDist])
  const depth = Math.max(0.05, -cam[2])
  const fx = 0.9
  const fy = 0.9 * (H / W)
  const x = 0.5 + (fx * cam[0]) / depth
  const y = 0.5 + (fy * cam[1]) / depth
  const z = (cam[2] - cameraDist) / W * W
  return { x, y, z: z / W, right, up, forward }
}

function buildSyntheticFaceLandmarks({
  headRot = { yaw: 0, pitch: 0, roll: 0 },
  gazeOffset = [0, 0, 0],
  headTranslate = [0, 0, 0],
} = {}) {
  const pts = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }))
  const set = (i, x, y, z) => {
    pts[i] = { x, y, z }
  }

  const faceMidHead = [0, -0.04, 0]
  const leftOuterH = [-0.08, 0, 0.02]
  const leftInnerH = [0.02, 0, 0.02]
  const rightOuterH = [0.08, 0, 0.02]
  const rightInnerH = [-0.02, 0, 0.02]
  const leftIrisH = [0, 0, 0.02]
  const rightIrisH = [0, 0, 0.02]
  // Neutral iris = geometric eye center (avoid false horizontal bias at center gaze).
  leftIrisH[0] = (leftOuterH[0] + leftInnerH[0]) / 2
  rightIrisH[0] = (rightOuterH[0] + rightInnerH[0]) / 2

  let right, up, forward
  const proj = (pH, isIris = false) => {
    const lm = projectHeadPointToLandmark(add3(pH, headTranslate), headRot, 0.35, gazeOffset, isIris)
    right = lm.right
    up = lm.up
    forward = lm.forward
    return lm
  }

  const mid = proj(faceMidHead)
  const lo = proj(leftOuterH)
  const li = proj(leftInnerH)
  const ro = proj(rightOuterH)
  const ri = proj(rightInnerH)
  const lIris = proj(leftIrisH, true)
  const rIris = proj(rightIrisH, true)

  set(GAZE_V2_LANDMARKS.faceMid, mid.x, mid.y, mid.z)
  set(1, mid.x, mid.y + 0.08, mid.z)
  set(GAZE_V2_LANDMARKS.left.outer, lo.x, lo.y, lo.z)
  set(GAZE_V2_LANDMARKS.left.inner, li.x, li.y, li.z)
  set(GAZE_V2_LANDMARKS.right.outer, ro.x, ro.y, ro.z)
  set(GAZE_V2_LANDMARKS.right.inner, ri.x, ri.y, ri.z)
  for (const i of GAZE_V2_LANDMARKS.left.iris) set(i, lIris.x, lIris.y, lIris.z)
  for (const i of GAZE_V2_LANDMARKS.right.iris) set(i, rIris.x, rIris.y, rIris.z)
  set(GAZE_V2_LANDMARKS.left.upper, (lo.x + li.x) / 2, (lo.y + li.y) / 2 - 0.015, (lo.z + li.z) / 2)
  set(GAZE_V2_LANDMARKS.left.lower, (lo.x + li.x) / 2, (lo.y + li.y) / 2 + 0.015, (lo.z + li.z) / 2)
  set(GAZE_V2_LANDMARKS.right.upper, (ro.x + ri.x) / 2, (ro.y + ri.y) / 2 - 0.015, (ro.z + ri.z) / 2)
  set(GAZE_V2_LANDMARKS.right.lower, (ro.x + ri.x) / 2, (ro.y + ri.y) / 2 + 0.015, (ro.z + ri.z) / 2)

  const matrix = facialMatrixFromRotation([right, up, forward])
  return { landmarks: pts, matrix }
}

function warm(state, lm, matrix, n = 6) {
  let st = state
  for (let i = 0; i < n; i++) {
    const out = processEyeLocalGazeV2({
      landmarks: lm,
      facialTransformationMatrix: matrix,
      imageWidth: W,
      imageHeight: H,
      state: st,
      config: FAST,
      timestampMs: 1000 + i * 33,
      faceDetected: true,
    })
    st = out.nextState
  }
  return st
}

test("A — Matrix contract: column-major, no implicit transpose", () => {
  const m = facialMatrixFromRotation([
    [1, 0, 0],
    [0, -1, 0],
    [0, 0, -1],
  ])
  const rot = extractHeadRotationFromFacialMatrix(m)
  assert.ok(rot?.valid)
  assert.ok(Math.abs(rot.right[0] - 1) < 1e-6)
  assert.ok(Math.abs(rot.up[1] + 1) < 1e-6)
})

test("B — Inverse rotation: R^T · R · v ≈ v", () => {
  const m = facialMatrixFromRotation([
    [0.866, 0, 0.5],
    [0, 1, 0],
    [-0.5, 0, 0.866],
  ])
  const rot = extractHeadRotationFromFacialMatrix(m)
  const v = [0.1, -0.02, 0.05]
  const head = applyInverseHeadRotation(v, rot)
  const back = [
    rot.right[0] * head[0] + rot.up[0] * head[1] + rot.forward[0] * head[2],
    rot.right[1] * head[0] + rot.up[1] * head[1] + rot.forward[1] * head[2],
    rot.right[2] * head[0] + rot.up[2] * head[1] + rot.forward[2] * head[2],
  ]
  assert.ok(Math.abs(back[0] - v[0]) < 1e-5)
  assert.ok(Math.abs(back[1] - v[1]) < 1e-5)
  assert.ok(Math.abs(back[2] - v[2]) < 1e-5)
})

test("C — Metric scaling: z uses image width", () => {
  const p = landmarkNormalizedToMetricCamera([0.5, 0.5, 0.01], W, H)
  assert.ok(Math.abs(p[0] - W * 0.5) < 1e-6)
  assert.ok(Math.abs(p[1] - H * 0.5) < 1e-6)
  assert.ok(Math.abs(p[2] - 0.01 * W) < 1e-6)
})

test("D — Perspective yaw invariance: fixed gaze, canonical stable", () => {
  const gazes = []
  for (const yaw of [-30, -15, 0, 15, 30]) {
    const { landmarks, matrix } = buildSyntheticFaceLandmarks({ headRot: { yaw, pitch: 0, roll: 0 } })
    const st = warm(createGazeV2State(), landmarks, matrix, 6)
    const out = processEyeLocalGazeV2({
      landmarks,
      facialTransformationMatrix: matrix,
      imageWidth: W,
      imageHeight: H,
      state: st,
      config: FAST,
      timestampMs: 5000,
      faceDetected: true,
    })
    gazes.push({
      x: out.debug.fused.normalizedX,
      y: out.debug.fused.normalizedY,
      legacyX: out.debug.headCompensation.legacyLocalFusedX,
    })
  }
  const xs = gazes.map((g) => g.x).filter(Number.isFinite)
  const ys = gazes.map((g) => g.y).filter(Number.isFinite)
  const std = (arr) => {
    const m = arr.reduce((a, b) => a + b, 0) / arr.length
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length)
  }
  assert.ok(std(xs) < 0.04, `canonical yaw stdX=${std(xs)}`)
  assert.ok(std(ys) < 0.04, `canonical yaw stdY=${std(ys)}`)
})

test("E — Perspective pitch invariance", () => {
  const ys = []
  for (const pitch of [-20, -10, 0, 10, 20]) {
    const { landmarks, matrix } = buildSyntheticFaceLandmarks({ headRot: { yaw: 0, pitch, roll: 0 } })
    const st = warm(createGazeV2State(), landmarks, matrix, 6)
    const out = processEyeLocalGazeV2({
      landmarks,
      facialTransformationMatrix: matrix,
      imageWidth: W,
      imageHeight: H,
      state: st,
      config: FAST,
      timestampMs: 6000,
      faceDetected: true,
    })
    ys.push(out.debug.fused.normalizedY)
  }
  const m = ys.reduce((a, b) => a + b, 0) / ys.length
  const std = Math.sqrt(ys.reduce((s, v) => s + (v - m) ** 2, 0) / ys.length)
  assert.ok(std < 0.05, `pitch stdY=${std}`)
})

test("F — Head translation invariance", () => {
  const vals = []
  for (const tx of [-0.05, 0, 0.05]) {
    for (const ty of [-0.04, 0, 0.04]) {
      const { landmarks, matrix } = buildSyntheticFaceLandmarks({
        headTranslate: [tx, ty, 0],
      })
      const ctx = resolveHeadCanonicalContext(landmarks, matrix, W, H)
      const L = computeHeadCanonicalEyeGaze({ landmarks, side: "left", facialMatrix: matrix, imageWidth: W, imageHeight: H })
      assert.ok(L.available)
      vals.push(L.canonicalX, L.canonicalY)
    }
  }
  const xs = vals.filter((_, i) => i % 2 === 0)
  const std = Math.sqrt(xs.reduce((s, v) => s + (v - xs.reduce((a, b) => a + b, 0) / xs.length) ** 2, 0) / xs.length)
  assert.ok(std < 0.03)
})

test("G — Head scale/distance: eyeWidth normalization", () => {
  const { landmarks, matrix } = buildSyntheticFaceLandmarks({})
  const L = computeHeadCanonicalEyeGaze({ landmarks, side: "left", facialMatrix: matrix, imageWidth: W, imageHeight: H })
  assert.ok(L.available)
  assert.ok(L.eyeWidth > 0.01)
})

test("H — Active horizontal gaze preserved", () => {
  const center = buildSyntheticFaceLandmarks({})
  const withGaze = buildSyntheticFaceLandmarks({ gazeOffset: [0.018, 0, 0] })
  const st = warm(createGazeV2State(), center.landmarks, center.matrix, 6)
  const out = processEyeLocalGazeV2({
    landmarks: withGaze.landmarks,
    facialTransformationMatrix: withGaze.matrix,
    imageWidth: W,
    imageHeight: H,
    state: st,
    config: FAST,
    timestampMs: 7000,
    faceDetected: true,
  })
  assert.ok(out.sharedRadarX > 52, `radarX=${out.sharedRadarX}`)
})

test("I — Active vertical gaze preserved", () => {
  const center = buildSyntheticFaceLandmarks({})
  const withGaze = buildSyntheticFaceLandmarks({ gazeOffset: [0, 0.018, 0] })
  const st = warm(createGazeV2State(), center.landmarks, center.matrix, 6)
  const out = processEyeLocalGazeV2({
    landmarks: withGaze.landmarks,
    facialTransformationMatrix: withGaze.matrix,
    imageWidth: W,
    imageHeight: H,
    state: st,
    config: FAST,
    timestampMs: 7100,
    faceDetected: true,
  })
  assert.ok(out.sharedRadarY > 52, `radarY=${out.sharedRadarY}`)
})

test("J — Head yaw + eye horizontal combination", () => {
  const center = buildSyntheticFaceLandmarks({ headRot: { yaw: 20, pitch: 0, roll: 0 } })
  const withGaze = buildSyntheticFaceLandmarks({
    headRot: { yaw: 20, pitch: 0, roll: 0 },
    gazeOffset: [0.02, 0, 0],
  })
  const st = warm(createGazeV2State(), center.landmarks, center.matrix, 6)
  const out = processEyeLocalGazeV2({
    landmarks: withGaze.landmarks,
    facialTransformationMatrix: withGaze.matrix,
    imageWidth: W,
    imageHeight: H,
    state: st,
    config: FAST,
    timestampMs: 7200,
    faceDetected: true,
  })
  assert.ok(out.sharedRadarX > 52, `radarX=${out.sharedRadarX}`)
})

test("K — Head pitch + eye vertical combination", () => {
  const center = buildSyntheticFaceLandmarks({ headRot: { yaw: 0, pitch: 15, roll: 0 } })
  const withGaze = buildSyntheticFaceLandmarks({
    headRot: { yaw: 0, pitch: 15, roll: 0 },
    gazeOffset: [0, 0.02, 0],
  })
  const st = warm(createGazeV2State(), center.landmarks, center.matrix, 6)
  const out = processEyeLocalGazeV2({
    landmarks: withGaze.landmarks,
    facialTransformationMatrix: withGaze.matrix,
    imageWidth: W,
    imageHeight: H,
    state: st,
    config: FAST,
    timestampMs: 7300,
    faceDetected: true,
  })
  assert.ok(out.sharedRadarY > 52, `radarY=${out.sharedRadarY}`)
})

test("L — Left/right canonical sign consistency", () => {
  const center = buildSyntheticFaceLandmarks({})
  const withGaze = buildSyntheticFaceLandmarks({ gazeOffset: [0.015, 0.012, 0] })
  const L = computeHeadCanonicalEyeGaze({
    landmarks: withGaze.landmarks,
    side: "left",
    facialMatrix: withGaze.matrix,
    imageWidth: W,
    imageHeight: H,
  })
  const R = computeHeadCanonicalEyeGaze({
    landmarks: withGaze.landmarks,
    side: "right",
    facialMatrix: withGaze.matrix,
    imageWidth: W,
    imageHeight: H,
  })
  assert.ok(L.available && R.available)
  assert.ok(L.canonicalX > 0.02 && R.canonicalX > 0.02, `L=${L.canonicalX} R=${R.canonicalX}`)
  assert.ok(L.canonicalY > 0.02 && R.canonicalY > 0.02, `Ly=${L.canonicalY} Ry=${R.canonicalY}`)
})

test("M — Matrix unavailable → eye-local-stable-plane fallback", () => {
  const { landmarks } = buildSyntheticFaceLandmarks({})
  const eye = computeEyeLocalGaze(landmarks, "left", FAST, { facialMatrix: null, imageWidth: W, imageHeight: H })
  assert.equal(eye.geometryMode, "eye-local-stable-plane")
})

test("N — Legacy path leaks more on roll than canonical (synthetic)", () => {
  const canon = []
  const legacy = []
  for (const roll of [-25, 0, 25]) {
    const { landmarks, matrix } = buildSyntheticFaceLandmarks({ headRot: { yaw: 0, pitch: 0, roll } })
    const L = computeHeadCanonicalEyeGaze({ landmarks, side: "left", facialMatrix: matrix, imageWidth: W, imageHeight: H })
    const leg = computeLegacyCameraSpaceEyeGaze(landmarks, "left", [0, 0, -1])
    canon.push(L.canonicalX)
    legacy.push(leg.normalizedX)
  }
  const std = (arr) => {
    const m = arr.reduce((a, b) => a + b, 0) / arr.length
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length)
  }
  assert.ok(std(canon) <= std(legacy) + 0.02)
})
