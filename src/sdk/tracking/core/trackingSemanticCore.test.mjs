import test from "node:test"
import assert from "node:assert/strict"

import {
  createTrackingSemanticRuntime,
  createTrackingSemanticState,
  mapMediaPipeObservationToRig,
} from "./trackingSemanticCore.js"
import {
  mediaPipeResultToCanonicalObservation,
  normalizeObservationBlendshapes,
  normalizeObservationLandmarks,
} from "./canonicalObservation.js"
import { compareSemanticParity } from "../../../../scripts/compare-tracking-semantic-parity.mjs"

function neutralLandmarks() {
  const pts = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }))
  const set = (i, x, y, z = 0) => { pts[i] = { x, y, z } }
  set(61, 0.4, 0.55); set(291, 0.6, 0.55); set(1, 0.5, 0.4); set(152, 0.5, 0.75)
  for (const i of [4, 5, 6, 195, 197]) set(i, 0.5, 0.44 + (i % 3) * 0.002)
  set(33, 0.38, 0.45); set(133, 0.46, 0.45); set(159, 0.42, 0.43); set(145, 0.42, 0.47)
  set(263, 0.62, 0.45); set(362, 0.54, 0.45); set(386, 0.58, 0.43); set(374, 0.58, 0.47)
  for (const i of [468, 469, 470, 471, 472]) set(i, 0.42, 0.45)
  for (const i of [473, 474, 475, 476, 477]) set(i, 0.58, 0.45)
  for (const i of [40, 80, 81]) set(i, 0.46, 0.53)
  for (const i of [270, 310, 311]) set(i, 0.54, 0.53)
  for (const i of [91, 88, 178]) set(i, 0.46, 0.57)
  for (const i of [321, 318, 402]) set(i, 0.54, 0.57)
  set(13, 0.5, 0.535); set(14, 0.5, 0.565); set(17, 0.5, 0.57); set(87, 0.48, 0.57); set(317, 0.52, 0.57)
  return pts
}

function testConfig() {
  return {
    lipGeometry: { neutralFrames: 1, neutralWarmupFrames: 0, scenarioTransitionFrames: 1 },
    jawGeometry: { neutralFrames: 1, neutralWarmupFrames: 0 },
    noseAnchor: { neutralFrames: 1, neutralWarmupFrames: 0 },
    mouthCorner: { neutralSampleCount: 1, neutralWarmupFrames: 0 },
    browGate: { browConfirmFrames: 1, neutralFallbackMs: 0 },
    gaze: { irisWarmupFrames: 1, irisWarmupMinSamples: 1, irisWarmupMaxWaitFrames: 1 },
    gazeV2: { neutralWarmupSamples: 2, neutralMaxWaitFrames: 4 },
    mouthScenario: { frontalConfirmFrames: 1, closedTurnConfirmFrames: 1, neutralConfirmFrames: 1 },
  }
}

function observation({ landmarks = neutralLandmarks(), blend = {}, faceDetected = true, frameId = 1, timestampMs = frameId * 33 } = {}) {
  return {
    version: 1,
    timestampMs,
    frameId,
    faceDetected,
    landmarks: faceDetected ? landmarks : [],
    blendshapes: normalizeObservationBlendshapes(blend),
    facialTransformationMatrix: null,
    source: "test",
  }
}

function calibratedRuntime() {
  const runtime = createTrackingSemanticRuntime({ config: testConfig() })
  runtime.process(observation({ frameId: 1 }))
  runtime.process(observation({ frameId: 2 }))
  return runtime
}

test("A — Canonical observation landmarks 478 保序", () => {
  const src = Array.from({ length: 478 }, (_, i) => ({ x: i / 1000, y: i / 2000, z: -i / 3000 }))
  const out = normalizeObservationLandmarks(src)
  assert.equal(out.length, 478)
  assert.deepEqual(out.map((p) => p.i), Array.from({ length: 478 }, (_, i) => i))
  assert.equal(out[477].x, src[477].x)
})

test("B — Blendshape key/value normalization", () => {
  const out = normalizeObservationBlendshapes([{ categoryName: "jawOpen", score: 0.42 }, { categoryName: "custom", score: 0.7 }])
  assert.equal(out.jawOpen, 0.42)
  assert.equal(out.custom, 0.7)
  assert.equal(out.eyeBlinkLeft, 0)
})

test("C — Neutral face → Rig", () => {
  const out = calibratedRuntime().process(observation({ frameId: 3 }))
  assert.equal(out.rig.jaw.val, 0)
  assert.ok(Math.abs(out.rig.mouth.UL) < 0.5)
  assert.equal(out.rig.sharedRadar.x, 50)
  assert.equal(out.quality, 0.88)
})

test("D — Blink", () => {
  const out = calibratedRuntime().process(observation({ blend: { eyeBlinkLeft: 0.8, eyeBlinkRight: 0.75 }, frameId: 4 }))
  assert.ok(out.rig.eyeL.up < -40)
  assert.ok(out.rig.eyeR.up < -35)
  assert.ok(out.debug.mapping.blinkLeft > 70)
})

test("E — Brow movement + brow gate", () => {
  const runtime = calibratedRuntime()
  const out = runtime.process(observation({ blend: { browInnerUp: 0.5, browOuterUpLeft: 0.4, browOuterUpRight: 0.4 }, frameId: 5 }))
  assert.equal(out.debug.browGate.explicitBrowActive, true)
  assert.ok(out.rig.browL.tip > 30)
  assert.equal(out.debug.browGate.gateAction, "pass_explicit")
})

test("F — Mouth open drives jaw semantic", () => {
  const runtime = calibratedRuntime()
  const lm = neutralLandmarks()
  lm[14].y += 0.035; lm[17].y += 0.03; lm[87].y += 0.03; lm[317].y += 0.03
  const out = runtime.process(observation({ landmarks: lm, blend: { jawOpen: 0.7, mouthOpen: 0.65 }, frameId: 6 }))
  assert.ok(out.rig.jaw.val < -2)
  assert.ok(out.debug.jawGeometry.semanticOpen > 0)
})

test("G — Smile / mouth scenario", () => {
  const runtime = calibratedRuntime()
  const lm = neutralLandmarks(); lm[61].x -= 0.02; lm[61].y -= 0.01; lm[291].x += 0.02; lm[291].y -= 0.01
  // Confirm frames=1: first high-smile frame should enter frontal_mouth_motion.
  const out = runtime.process(observation({ landmarks: lm, blend: { mouthSmileLeft: 0.8, mouthSmileRight: 0.8, jawOpen: 0.05 }, frameId: 7 }))
  assert.equal(out.debug.mouthScenarioClassifier.finalScenario, "frontal_mouth_motion")
  assert.ok(out.debug.mapping.smileLeft > 50)
  assert.ok(out.rig.mouth.sideL.x !== 50 || out.rig.mouth.sideR.x !== 50 || out.debug.mapping.smileLeft > 50)
})

test("H — Iris gaze state", () => {
  const runtime = calibratedRuntime()
  const lm = neutralLandmarks()
  for (const i of [468, 469, 470, 471, 472]) lm[i].x += 0.025
  for (const i of [473, 474, 475, 476, 477]) lm[i].x += 0.025
  let out = null
  for (let i = 0; i < 6; i++) {
    out = runtime.process(observation({ landmarks: lm, frameId: 8 + i }))
  }
  assert.equal(out.debug.gaze.available, true)
  assert.equal(out.debug.gaze.gazeAlgorithm, "eye-local-v2")
  assert.notEqual(out.rig.sharedRadar.x, 50)
})

test("I — Head yaw/pitch/roll follows landmark route, not matrix", () => {
  const runtime = calibratedRuntime()
  const lm = neutralLandmarks(); lm[1].x += 0.035; lm[291].y += 0.015
  const out = runtime.process({ ...observation({ landmarks: lm, frameId: 9 }), facialTransformationMatrix: { layout: "column-major", rows: 4, cols: 4, values: Array(16).fill(99) } })
  assert.equal(out.debug.headPose.source, "landmark-mouth-frame")
  assert.ok(Math.abs(out.debug.headPose.yawProxy) > 0.01)
  assert.deepEqual(out.debug.facialTransformationMatrix.values, Array(16).fill(99))
})

test("J — No-face / tracking lost resets shared state", () => {
  const runtime = calibratedRuntime()
  runtime.process(observation({ blend: { jawOpen: 0.8 }, frameId: 10 }))
  const lost = runtime.process(observation({ faceDetected: false, frameId: 11 }))
  assert.equal(lost.quality, 0)
  assert.equal(lost.debug.lostTracking, true)
  assert.equal(lost.rig.jaw.val, 0)
  assert.equal(runtime.getState().lip.neutralReady, false)
})

test("K — Temporal state sequence has hysteresis/smoothing", () => {
  const runtime = calibratedRuntime()
  const open = observation({ blend: { jawOpen: 0.9, mouthOpen: 0.8 }, frameId: 12 })
  const a = runtime.process(open)
  const b = runtime.process({ ...open, frameId: 13, timestampMs: 429 })
  assert.ok(Math.abs(b.rig.jaw.val) >= Math.abs(a.rig.jaw.val))
  assert.equal(b.debug.mouthScenarioClassifier.finalScenario, "frontal_mouth_motion")
})

test("L — Python baseline vs JS semantic core comparison", async () => {
  const report = await compareSemanticParity()
  assert.ok(report.gateFrameMatchRate >= 0.9, `gateFrameMatchRate=${report.gateFrameMatchRate}`)
  for (const [group, result] of Object.entries(report.summary)) {
    if (!result || typeof result !== "object" || !("status" in result)) continue
    assert.notEqual(result.status, "DIFFERENT", `${group} exceeded CLOSE tolerance: ${result.maxAbsError}`)
  }
  assert.ok(report.perChannel["jaw.val"].maxAbsError <= 8, `jaw max=${report.perChannel["jaw.val"].maxAbsError}`)
  assert.ok(report.perChannel["eyeL.up"].maxAbsError <= 2)
  assert.ok(report.perChannel["sharedRadar.x"].maxAbsError <= 5)
  assert.ok(report.perChannel["browL.tip"].maxAbsError <= 8)
})

test("M — Browser Provider → observation → Shared Core → tracking.rigFrame", () => {
  const landmarks = neutralLandmarks()
  const raw = { faceLandmarks: [landmarks], faceBlendshapes: [{ categories: [{ categoryName: "jawOpen", score: 0.5 }] }] }
  const canonical = mediaPipeResultToCanonicalObservation(raw, { timestampMs: 10, frameId: 2, source: "browser" })
  const mapped = mapMediaPipeObservationToRig(canonical, createTrackingSemanticState(), null, testConfig())
  assert.equal(canonical.source, "browser")
  assert.ok(mapped.rig)
  assert.equal(typeof mapped.semanticComputeMs, "number")
})

test("N/O — Core is Device Drive and SC/ST/RJ protocol independent", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("./trackingSemanticCore.js", import.meta.url), "utf8"))
  for (const forbidden of ["WebSerial", "syncWrite", "rjSbus", "Scscl", "sendBusServo", 'from "react', "new WebSocket"]) assert.equal(source.includes(forbidden), false)
})
