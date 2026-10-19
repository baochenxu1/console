/**
 * Browser Live Semantic Contract — Tests A–L
 * 覆盖：blendshape schema、landmark index、mirror convention、L/R 语义、
 * semantic runtime lifecycle、timestamp、neutral warm-up、parity、SC/ST/RJ。
 */
import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  analyzeObservationBlendshapes,
  FORMAL_BLENDSHAPE_KEYS,
  mediaPipeResultToCanonicalObservation,
} from "../core/canonicalObservation.js"
import { createTrackingSemanticRuntime } from "../core/trackingSemanticCore.js"
import {
  CAMERA_COORDINATE_CONVENTION,
  mirrorNormalizedLandmarksX,
} from "./browserCameraCoordinateConvention.js"
import {
  buildBrowserLiveObservationSample,
  normalizeBrowserFaceLandmarkerResult,
  normalizeFaceLandmarks,
} from "./browserTrackingNormalizer.js"
import { createMonotonicTimestampGuard } from "./latestFrameGate.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

function neutralLandmarks() {
  const pts = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }))
  const set = (i, x, y, z = 0) => {
    pts[i] = { x, y, z }
  }
  set(61, 0.4, 0.55)
  set(291, 0.6, 0.55)
  set(1, 0.5, 0.4)
  set(152, 0.5, 0.75)
  for (const i of [4, 5, 6, 195, 197]) set(i, 0.5, 0.44 + (i % 3) * 0.002)
  set(33, 0.38, 0.45)
  set(133, 0.46, 0.45)
  set(159, 0.42, 0.43)
  set(145, 0.42, 0.47)
  set(263, 0.62, 0.45)
  set(362, 0.54, 0.45)
  set(386, 0.58, 0.43)
  set(374, 0.58, 0.47)
  for (const i of [468, 469, 470, 471, 472]) set(i, 0.42, 0.45)
  for (const i of [473, 474, 475, 476, 477]) set(i, 0.58, 0.45)
  for (const i of [40, 80, 81]) set(i, 0.46, 0.53)
  for (const i of [270, 310, 311]) set(i, 0.54, 0.53)
  for (const i of [91, 88, 178]) set(i, 0.46, 0.57)
  for (const i of [321, 318, 402]) set(i, 0.54, 0.57)
  set(13, 0.5, 0.535)
  set(14, 0.5, 0.565)
  set(17, 0.5, 0.57)
  set(87, 0.48, 0.57)
  set(317, 0.52, 0.57)
  return pts
}

function fastConfig() {
  return {
    lipGeometry: { neutralFrames: 1, neutralWarmupFrames: 0, scenarioTransitionFrames: 1 },
    jawGeometry: { neutralFrames: 1, neutralWarmupFrames: 0 },
    noseAnchor: { neutralFrames: 1, neutralWarmupFrames: 0 },
    mouthCorner: { neutralSampleCount: 1, neutralWarmupFrames: 0 },
    browGate: { browConfirmFrames: 1, neutralFallbackMs: 0 },
    gaze: { irisWarmupFrames: 1, irisWarmupMinSamples: 1, irisWarmupMaxWaitFrames: 1 },
    mouthScenario: { frontalConfirmFrames: 1, closedTurnConfirmFrames: 1, neutralConfirmFrames: 1 },
  }
}

function makeCategories(overrides = {}) {
  const base = {
    eyeBlinkLeft: 0.1,
    eyeBlinkRight: 0.1,
    browOuterUpLeft: 0.05,
    browOuterUpRight: 0.05,
    mouthSmileLeft: 0.05,
    mouthSmileRight: 0.05,
    jawOpen: 0.05,
  }
  Object.assign(base, overrides)
  return Object.entries(base).map(([categoryName, score], index) => ({
    index,
    categoryName,
    displayName: categoryName,
    score,
  }))
}

function makeMpResult(blendOverrides = {}) {
  return {
    faceLandmarks: [neutralLandmarks()],
    faceBlendshapes: [{ categories: makeCategories(blendOverrides) }],
    facialTransformationMatrixes: [{ data: Array.from({ length: 16 }, (_, i) => i) }],
  }
}

test("A — Browser 1.0.1 blendshape categories → canonical key/score", () => {
  const cats = [
    { index: 9, categoryName: "eyeBlinkLeft", score: 0.91 },
    { index: 10, categoryName: "eyeBlinkRight", score: 0.12 },
    { index: 99, categoryName: "someExtraKey", score: 0.4 },
  ]
  const analysis = analyzeObservationBlendshapes(cats)
  assert.equal(analysis.blendshapes.eyeBlinkLeft, 0.91)
  assert.equal(analysis.blendshapes.eyeBlinkRight, 0.12)
  assert.equal(analysis.blendshapes.someExtraKey, 0.4)
  assert.ok(analysis.usedCategoryName)
  assert.ok(analysis.unknownBlendshapeKeys.includes("someExtraKey"))
  assert.ok(analysis.missingExpectedBlendshapeKeys.includes("jawOpen"))
  assert.equal(analysis.blendshapes["9"], undefined)
})

test("B — landmark 478 index preservation", () => {
  const raw = neutralLandmarks()
  raw[33] = { x: 0.33, y: 0.44, z: -0.01 }
  raw[263] = { x: 0.66, y: 0.45, z: -0.02 }
  const out = normalizeFaceLandmarks(raw)
  assert.equal(out.length, 478)
  for (let i = 0; i < 478; i += 1) {
    assert.equal(out[i].i, i)
    assert.equal(out[i].x, Number(raw[i].x) || 0)
    assert.equal(out[i].y, Number(raw[i].y) || 0)
  }
  assert.equal(out[33].x, 0.33)
  assert.equal(out[263].x, 0.66)
})

test("C — camera coordinate / mirror convention", () => {
  assert.equal(CAMERA_COORDINATE_CONVENTION.pythonCameraFlipHorizontal, true)
  assert.equal(CAMERA_COORDINATE_CONVENTION.browserInferenceFlipHorizontal, true)
  assert.equal(CAMERA_COORDINATE_CONVENTION.id, "subject-left-is-image-left")

  const mirroredSelfie = neutralLandmarks()
  mirroredSelfie[33] = { x: 0.7, y: 0.4, z: 0 }
  mirroredSelfie[263] = { x: 0.3, y: 0.4, z: 0 }
  const corrected = mirrorNormalizedLandmarksX(mirroredSelfie)
  assert.ok(corrected[33].x < corrected[263].x)

  const provider = readFileSync(join(__dirname, "browserFaceLandmarkerProvider.js"), "utf8")
  assert.match(provider, /createBrowserInferenceImageBitmap/)
  assert.match(provider, /browserInferenceFlipHorizontal/)
})

test("D — left/right eye semantics (blink keys → Rig)", () => {
  const runtime = createTrackingSemanticRuntime({ config: fastConfig() })
  for (let i = 0; i < 4; i += 1) {
    runtime.process(
      mediaPipeResultToCanonicalObservation(makeMpResult(), {
        timestampMs: i * 33,
        frameId: i,
        source: "browser",
      })
    )
  }
  const left = normalizeBrowserFaceLandmarkerResult(makeMpResult({ eyeBlinkLeft: 0.95, eyeBlinkRight: 0.05 }), {
    captureTimestamp: 2000,
    frameSeq: 100,
    semanticRuntime: runtime,
  })
  const right = normalizeBrowserFaceLandmarkerResult(makeMpResult({ eyeBlinkLeft: 0.05, eyeBlinkRight: 0.95 }), {
    captureTimestamp: 2033,
    frameSeq: 101,
    semanticRuntime: runtime,
  })
  const leftUpL = Number(left.rig.eyeL.up)
  const leftUpR = Number(left.rig.eyeR.up)
  const rightUpL = Number(right.rig.eyeL.up)
  const rightUpR = Number(right.rig.eyeR.up)
  assert.ok(Number.isFinite(leftUpL) && Number.isFinite(leftUpR))
  assert.ok(leftUpL < leftUpR, `left blink: eyeL.up=${leftUpL} should be < eyeR.up=${leftUpR}`)
  assert.ok(rightUpR < rightUpL, `right blink: eyeR.up=${rightUpR} should be < eyeL.up=${rightUpL}`)
  assert.equal(left.debug.browserLiveSample.blendshapeKeyScores.eyeBlinkLeft, 0.95)
  assert.equal(right.debug.browserLiveSample.blendshapeKeyScores.eyeBlinkRight, 0.95)
})

test("E — left/right brow semantics", () => {
  const a = analyzeObservationBlendshapes(makeCategories({ browOuterUpLeft: 0.9, browOuterUpRight: 0.05 }))
  const b = analyzeObservationBlendshapes(makeCategories({ browOuterUpLeft: 0.05, browOuterUpRight: 0.9 }))
  assert.equal(a.blendshapes.browOuterUpLeft, 0.9)
  assert.equal(b.blendshapes.browOuterUpRight, 0.9)
  assert.notEqual(a.blendshapes.browOuterUpLeft, b.blendshapes.browOuterUpLeft)
})

test("F — left/right mouth corner semantics", () => {
  const a = analyzeObservationBlendshapes(makeCategories({ mouthSmileLeft: 0.85, mouthSmileRight: 0.05 }))
  const b = analyzeObservationBlendshapes(makeCategories({ mouthSmileLeft: 0.05, mouthSmileRight: 0.85 }))
  assert.equal(a.blendshapes.mouthSmileLeft, 0.85)
  assert.equal(b.blendshapes.mouthSmileRight, 0.85)
})

test("G — semantic runtime state persists across frames", () => {
  const runtime = createTrackingSemanticRuntime({ config: fastConfig() })
  const s0 = runtime.getState()
  runtime.process(
    mediaPipeResultToCanonicalObservation(makeMpResult(), { timestampMs: 10, frameId: 1, source: "browser" })
  )
  const s1 = runtime.getState()
  runtime.process(
    mediaPipeResultToCanonicalObservation(makeMpResult(), { timestampMs: 43, frameId: 2, source: "browser" })
  )
  const s2 = runtime.getState()
  assert.equal(s0, s1)
  assert.equal(s1, s2)
})

test("H — Stop / restart state reset", () => {
  const runtime = createTrackingSemanticRuntime({ config: fastConfig() })
  for (let i = 0; i < 5; i += 1) {
    runtime.process(
      mediaPipeResultToCanonicalObservation(makeMpResult(), {
        timestampMs: i * 33,
        frameId: i,
        source: "browser",
      })
    )
  }
  const before = runtime.getState()
  assert.equal(before.lip.neutralReady, true)
  runtime.reset()
  const after = runtime.getState()
  assert.notEqual(before, after)
  assert.equal(after.lip.neutralReady, false)
  assert.equal(after.jaw.neutralReady, false)
})

test("I — timestamp monotonic sequence", () => {
  const guard = createMonotonicTimestampGuard(0)
  const seq = [16, 16, 15, 50, Number.NaN, 80]
  const out = seq.map((t) => guard.next(t))
  for (let i = 1; i < out.length; i += 1) {
    assert.ok(out[i] > out[i - 1], `not monotonic at ${i}: ${out}`)
  }
})

test("J — neutral warm-up sequence", () => {
  const rtDefault = createTrackingSemanticRuntime()
  const readyFlags = []
  for (let i = 0; i < 45; i += 1) {
    rtDefault.process(
      mediaPipeResultToCanonicalObservation(makeMpResult(), {
        timestampMs: i * 33,
        frameId: i,
        source: "browser",
      })
    )
    const st = rtDefault.getState()
    readyFlags.push(Boolean(st.lip.neutralReady && st.jaw.neutralReady && st.nose.neutralReady))
  }
  assert.equal(readyFlags[0], false)
  assert.equal(readyFlags[readyFlags.length - 1], true)
})

test("K — Python-equivalent observation vs Browser normalized → Shared Core within tolerance", () => {
  const mp = makeMpResult({ jawOpen: 0.4, eyeBlinkLeft: 0.2, eyeBlinkRight: 0.2 })
  const browserObs = mediaPipeResultToCanonicalObservation(mp, {
    timestampMs: 1000,
    frameId: 1,
    source: "browser",
  })
  const pythonObs = mediaPipeResultToCanonicalObservation(mp, {
    timestampMs: 1000,
    frameId: 1,
    source: "python",
  })
  assert.deepEqual(browserObs.landmarks, pythonObs.landmarks)
  assert.deepEqual(browserObs.blendshapes, pythonObs.blendshapes)

  const rtB = createTrackingSemanticRuntime({ config: fastConfig() })
  const rtP = createTrackingSemanticRuntime({ config: fastConfig() })
  let rigB
  let rigP
  for (let i = 0; i < 6; i += 1) {
    const obsB = { ...browserObs, timestampMs: 1000 + i * 33, frameId: i }
    const obsP = { ...pythonObs, timestampMs: 1000 + i * 33, frameId: i }
    rigB = rtB.process(obsB).rig
    rigP = rtP.process(obsP).rig
  }
  assert.equal(rigB.jaw.val, rigP.jaw.val)
  assert.equal(rigB.eyeL.up, rigP.eyeL.up)
  assert.equal(rigB.eyeR.up, rigP.eyeR.up)
  assert.equal(rigB.browL.tip, rigP.browL.tip)
  assert.equal(rigB.browR.tip, rigP.browR.tip)
})

test("L — SC/ST/RJ regression: browser live semantic layer protocol-free", () => {
  const files = [
    "browserCameraCoordinateConvention.js",
    "browserTrackingNormalizer.js",
    "browserFaceLandmarkerProvider.js",
  ]
  for (const name of files) {
    const src = readFileSync(join(__dirname, name), "utf8")
    assert.equal(src.includes("Scscl"), false)
    assert.equal(src.includes("syncWrite"), false)
    assert.equal(src.includes("rjSbus"), false)
    assert.equal(src.includes("sendBusServo"), false)
  }
  for (const k of FORMAL_BLENDSHAPE_KEYS) {
    assert.equal(typeof k, "string")
  }
})

test("live sample builder exposes mirror + key scores", () => {
  const sample = buildBrowserLiveObservationSample(makeMpResult({ jawOpen: 0.55 }), {
    timestampMs: 42,
    videoWidth: 1280,
    videoHeight: 720,
  })
  assert.equal(sample.inferenceFlipHorizontal, true)
  assert.equal(sample.previewCssMirror, true)
  assert.equal(sample.landmarkCount, 478)
  assert.equal(sample.blendshapeKeyScores.jawOpen, 0.55)
})
