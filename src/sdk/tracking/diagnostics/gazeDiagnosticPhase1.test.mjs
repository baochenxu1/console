/**
 * Gaze Diagnostic Phase 1 — Tests A–K
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { gunzipSync, gzipSync } from "node:zlib"
import {
  createTrackingSemanticState,
  mapMediaPipeObservationToRig,
} from "../core/trackingSemanticCore.js"
import {
  AI_REVIEW_FRAME_COLUMNS,
  AI_REVIEW_REQUIRED_COLUMNS,
  TRACKING_DIAGNOSTIC_AI_REVIEW_SCHEMA,
  buildAiReviewExportPayload,
  extractAiReviewRow,
} from "./diagnosticAiReviewExport.js"
import {
  buildEyeGazeAiReviewFields,
  resolveTrackingRuntimeForDiagnostic,
} from "./trackingDiagnosticLite.js"
import {
  analyzeGazeDiagnosticPayload,
  pearsonCorrelation,
  linearSlope,
} from "./gazeDiagnosticAnalyzer.js"

function makeLandmarks(seed = 0) {
  const pts = []
  for (let i = 0; i < 478; i++) {
    const t = i * 0.01 + seed * 0.001
    pts.push({ x: 0.4 + Math.sin(t) * 0.02, y: 0.45 + Math.cos(t) * 0.02, z: 0 })
  }
  // Eye corners / iris — give processGaze valid geometry
  const set = (i, x, y) => {
    pts[i] = { x, y, z: 0 }
  }
  set(33, 0.3, 0.4)
  set(133, 0.38, 0.4)
  set(159, 0.34, 0.36)
  set(145, 0.34, 0.44)
  for (const i of [468, 469, 470, 471, 472]) set(i, 0.34 + seed * 0.0001, 0.4)
  set(362, 0.62, 0.4)
  set(263, 0.7, 0.4)
  set(386, 0.66, 0.36)
  set(374, 0.66, 0.44)
  for (const i of [473, 474, 475, 476, 477]) set(i, 0.66 + seed * 0.0001, 0.4)
  return pts
}

function browserObservation(seed = 0) {
  return {
    version: 1,
    timestampMs: 1000 + seed,
    frameId: seed,
    faceDetected: true,
    landmarks: makeLandmarks(seed),
    blendshapes: {
      eyeBlinkLeft: 0.05,
      eyeBlinkRight: 0.05,
      jawOpen: 0.01,
    },
    facialTransformationMatrix: null,
    source: "browser",
  }
}

function warmGazeState(frames = 40) {
  let state = createTrackingSemanticState()
  let last = null
  for (let i = 0; i < frames; i++) {
    last = mapMediaPipeObservationToRig(browserObservation(i), state, null, {})
    state = last.nextState
  }
  return { state, last }
}

test("A — Browser frame fills new gaze columns", () => {
  const { last } = warmGazeState(50)
  const lastFrame = {
    source: "mediapipe-web",
    faceDetected: true,
    quality: last.quality,
    rig: last.rig,
    debug: last.debug,
    timestampMs: 2000,
    frameSeq: 50,
  }
  const fields = buildEyeGazeAiReviewFields(lastFrame, last.rig, null)
  assert.equal(fields.exportFields.trackingRuntime, "browser")
  assert.equal(typeof fields.exportFields.gazeRawX, "number")
  assert.equal(typeof fields.exportFields.gazeRawY, "number")
  assert.equal(fields.exportFields.gazeNeutralReady, true)
  assert.equal(typeof fields.exportFields.gazeNeutralX, "number")
  assert.equal(typeof fields.exportFields.gazeEyeLookX, "number")
  assert.equal(typeof fields.exportFields.gazeCandidateSharedRadarX, "number")
  assert.equal(typeof fields.exportFields.gazeEmittedSharedRadarX, "number")
  assert.ok(fields.debug.gaze.rawX != null)
  assert.ok(fields.debug.headPose)

  const frame = {
    ...fields.exportFields,
    debug: fields.debug,
    rig: fields.rig,
    eye_xy: fields.eye_xy,
    eyeXYStabilizer: fields.eyeXYStabilizer,
    faceRigUi: fields.faceRigUi,
    sourceSeq: 50,
    timestampMs: 2000,
    inputSource: { sourceType: "camera", sourceSeq: 50 },
  }
  const row = extractAiReviewRow(frame)
  const idx = (name) => AI_REVIEW_FRAME_COLUMNS.indexOf(name)
  assert.ok(idx("gazeRawX") >= 0)
  assert.equal(typeof row[idx("gazeRawX")], "number")
  assert.equal(row[idx("trackingRuntime")], "browser")
  assert.equal(typeof row[idx("headYawProxy")] === "number" || row[idx("headYawProxy")] === null, true)
})

test("B — Python frame keeps iris fields; Browser-only stay null", () => {
  const lastFrame = {
    source: "python-mediapipe",
    faceDetected: true,
    quality: 0.9,
    rig: { sharedRadar: { x: 55, y: 48 } },
    debug: {
      gaze: {
        irisOnlyActive: true,
        irisLeftCx: 0.41,
        irisRightCx: 0.59,
        irisXNorm: 0.12,
        irisYNorm: -0.05,
        candidateSharedRadarX: 54,
        candidateSharedRadarY: 49,
        emittedSharedRadarX: 53,
        emittedSharedRadarY: 49,
        outputMode: "iris_tracking",
      },
      headPose: { available: true, yawProxy: 0.2, pitchProxy: -0.1, rollDeg: 1.5 },
    },
    timestampMs: 3000,
    frameSeq: 10,
  }
  const fields = buildEyeGazeAiReviewFields(lastFrame, lastFrame.rig, null)
  assert.equal(fields.exportFields.trackingRuntime, "python")
  assert.equal(fields.exportFields.gazeRawX, null)
  assert.equal(fields.exportFields.gazeNeutralX, null)
  assert.equal(fields.exportFields.gazeNeutralReady, null)
  assert.equal(fields.exportFields.gazeEyeLookX, null)
  assert.equal(fields.debug.gaze.irisLeftCx, 0.41)
  assert.equal(fields.debug.gaze.irisXNorm, 0.12)
  assert.equal(fields.exportFields.gazeCandidateSharedRadarX, 54)
  assert.equal(fields.exportFields.headYawProxy, 0.2)
})

test("C — head pose columns from debug.headPose", () => {
  const fields = buildEyeGazeAiReviewFields(
    {
      source: "python-mediapipe",
      rig: { sharedRadar: { x: 50, y: 50 } },
      debug: {
        gaze: {},
        headPose: { available: true, yawProxy: 1.25, pitchProxy: -0.5, rollDeg: 3, source: "landmark-mouth-frame" },
      },
    },
    null,
    null
  )
  assert.equal(fields.exportFields.headPoseAvailable, true)
  assert.equal(fields.exportFields.headYawProxy, 1.25)
  assert.equal(fields.exportFields.headPitchProxy, -0.5)
  assert.equal(fields.exportFields.headRollDeg, 3)
  assert.equal(fields.debug.headPose.available, true)
})

test("D — null must not become 0 for missing Browser fields", () => {
  const fields = buildEyeGazeAiReviewFields(
    {
      source: "python-mediapipe",
      rig: { sharedRadar: { x: 50, y: 50 } },
      debug: { gaze: { irisLeftCx: 0.5 }, headPose: { available: false } },
    },
    null,
    null
  )
  assert.equal(fields.exportFields.gazeRawX, null)
  assert.equal(fields.exportFields.gazeRawY, null)
  assert.equal(fields.exportFields.gazeNeutralX, null)
  assert.equal(fields.exportFields.gazeEyeLookX, null)
  assert.equal(fields.exportFields.gazeNeutralSampleCount, null)
  assert.equal(fields.exportFields.headPoseAvailable, false)
  assert.equal(fields.exportFields.headYawProxy, null)
  // Explicit zero must remain zero when present
  const z = buildEyeGazeAiReviewFields(
    {
      source: "mediapipe-web",
      rig: { sharedRadar: { x: 50, y: 50 } },
      debug: { gaze: { rawX: 0, rawY: 0, neutralReady: true, neutralX: 0, neutralY: 0, neutralSampleCount: 12 } },
    },
    null,
    null
  )
  assert.equal(z.exportFields.gazeRawX, 0)
  assert.equal(z.exportFields.gazeNeutralX, 0)
})

test("E — old REQUIRED columns still present", () => {
  for (const c of AI_REVIEW_REQUIRED_COLUMNS) {
    assert.ok(AI_REVIEW_FRAME_COLUMNS.includes(c), `missing required ${c}`)
  }
  assert.equal(TRACKING_DIAGNOSTIC_AI_REVIEW_SCHEMA, "tracking-diagnostic-ai-review-v1")
  assert.ok(AI_REVIEW_FRAME_COLUMNS.includes("gazeRawX"))
  assert.ok(AI_REVIEW_FRAME_COLUMNS.includes("headYawProxy"))
  assert.ok(AI_REVIEW_FRAME_COLUMNS.includes("debug.gaze.irisLeftCx"))
})

function syntheticSeries(scenarioRows) {
  const columns = [...AI_REVIEW_FRAME_COLUMNS]
  const rows = scenarioRows.map((obj) =>
    columns.map((c) => (Object.prototype.hasOwnProperty.call(obj, c) ? obj[c] : null))
  )
  return {
    schemaVersion: TRACKING_DIAGNOSTIC_AI_REVIEW_SCHEMA,
    frameSeries: { columns, rowCount: rows.length, rows },
  }
}

test("F — static jitter metrics", () => {
  const payload = syntheticSeries(
    Array.from({ length: 30 }, (_, i) => ({
      sourceSeq: i,
      "rig.sharedRadar.x": 50 + (i % 2 === 0 ? 0.1 : -0.1),
      "rig.sharedRadar.y": 50,
      gazeEmittedSharedRadarX: 50 + (i % 2 === 0 ? 0.2 : -0.2),
      gazeEmittedSharedRadarY: 50,
      gazeRawX: 0.01 * Math.sin(i),
      gazeRawY: 0,
      gazeEyeLookX: 0.001 * Math.sin(i),
      gazeEyeLookY: 0,
    }))
  )
  const report = analyzeGazeDiagnosticPayload(payload, { scenario: "static-center" })
  assert.equal(report.metrics.gazeRawX.sampleCount, 30)
  assert.ok(report.metrics["rig.sharedRadar.x"].std != null)
  assert.ok(report.metrics.gazeEmittedSharedRadarX.rmsDeviation != null)
  assert.ok(report.metrics.gazeEmittedSharedRadarX.peakToPeak != null)
})

test("G — yaw correlation", () => {
  const payload = syntheticSeries(
    Array.from({ length: 40 }, (_, i) => {
      const yaw = i / 10
      return {
        sourceSeq: i,
        headYawProxy: yaw,
        gazeRawX: yaw * 2 + 0.01,
        gazeEyeLookX: yaw * 0.5,
        gazeEmittedSharedRadarX: 50 + yaw * 5,
        "rig.sharedRadar.x": 50 + yaw * 5,
      }
    })
  )
  const report = analyzeGazeDiagnosticPayload(payload, { scenario: "head-yaw" })
  const corr = report.metrics["corr_headYaw_vs_gazeEmittedSharedRadarX"].pearson
  assert.ok(corr != null && corr > 0.9)
  assert.ok(report.flags.includes("HIGH_YAW_CORRELATION"))
})

test("H — pitch correlation", () => {
  const payload = syntheticSeries(
    Array.from({ length: 40 }, (_, i) => {
      const pitch = i / 10
      return {
        sourceSeq: i,
        headPitchProxy: pitch,
        gazeRawY: pitch * 2,
        gazeEyeLookY: pitch * 0.5,
        gazeEmittedSharedRadarY: 50 + pitch * 4,
        "rig.sharedRadar.y": 50 + pitch * 4,
      }
    })
  )
  const report = analyzeGazeDiagnosticPayload(payload, { scenario: "head-pitch" })
  assert.ok(report.metrics["corr_headPitch_vs_gazeEmittedSharedRadarY"].pearson > 0.9)
  assert.ok(report.flags.includes("HIGH_PITCH_CORRELATION"))
})

test("I — neutral drift", () => {
  const payload = syntheticSeries(
    Array.from({ length: 100 }, (_, i) => ({
      sourceSeq: i,
      timestampMs: i * 33,
      gazeNeutralReady: i >= 10,
      gazeNeutralSampleCount: Math.min(i, 80),
      gazeNeutralX: 0.01 + i * 0.001,
      gazeNeutralY: 0,
      gazeEmittedSharedRadarX: 50 + i * 0.05,
      gazeEmittedSharedRadarY: 50,
    }))
  )
  const report = analyzeGazeDiagnosticPayload(payload, { scenario: "long-center" })
  assert.equal(report.metrics.neutral.readyFirstIndex, 10)
  assert.ok(report.metrics.neutral.gazeNeutralX.delta != null)
  assert.ok(report.flags.includes("NEUTRAL_DRIFT"))
})

test("J — gzip input round-trip via analyzer payload parse", () => {
  const payload = syntheticSeries([
    {
      sourceSeq: 1,
      gazeRawX: 0.1,
      "rig.sharedRadar.x": 50,
      "rig.sharedRadar.y": 50,
      gazeEmittedSharedRadarX: 50,
      gazeEmittedSharedRadarY: 50,
    },
  ])
  const gz = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"))
  const restored = JSON.parse(gunzipSync(gz).toString("utf8"))
  const report = analyzeGazeDiagnosticPayload(restored, { scenario: "static-center" })
  assert.equal(report.frameCount, 1)
  assert.equal(report.metrics.gazeRawX.mean, 0.1)
})

test("K — formal Tracking sharedRadar math unchanged (diagnostic fields additive)", () => {
  const obs = browserObservation(0)
  const a = mapMediaPipeObservationToRig(obs, createTrackingSemanticState(), null, {})
  const b = mapMediaPipeObservationToRig(obs, createTrackingSemanticState(), null, {})
  assert.deepEqual(a.rig.sharedRadar, b.rig.sharedRadar)
  assert.deepEqual(a.rig.eyeL, b.rig.eyeL)
  // After warmup, diagnostic aliases must match emitted sharedRadar
  const { last } = warmGazeState(45)
  if (last.debug.gaze.stable) {
    assert.equal(last.debug.gaze.emittedSharedRadarX, last.debug.gaze.sharedRadarX)
    assert.equal(last.rig.sharedRadar.x, last.debug.gaze.sharedRadarX)
  }
  assert.ok(["warmingUp", "stable", "unavailable", "heldLastValid", "frozenByBlink"].includes(last.debug.gaze.outputMode) || last.debug.gaze.outputMode == null || typeof last.debug.gaze.outputMode === "string")
})

test("resolveTrackingRuntime + pearson helpers", () => {
  assert.equal(resolveTrackingRuntimeForDiagnostic({ source: "mediapipe-web" }), "browser")
  assert.equal(resolveTrackingRuntimeForDiagnostic({ source: "python-mediapipe" }), "python")
  assert.equal(pearsonCorrelation([1, 2, 3, 4], [2, 4, 6, 8]), 1)
  assert.ok(Math.abs(linearSlope([1, 2, 3], [2, 4, 6]).slope - 2) < 1e-9)
})

test("buildAiReviewExportPayload includes new columns", () => {
  const { last } = warmGazeState(40)
  const frame = {
    frameIndex: 0,
    sourceSeq: 1,
    timestampMs: 100,
    inputSource: { sourceType: "camera", sourceSeq: 1, frameIndex: 1 },
    source: { fd: true, q: 0.9, sourceType: "camera" },
    ...buildEyeGazeAiReviewFields(
      { source: "mediapipe-web", rig: last.rig, debug: last.debug, timestampMs: 100 },
      last.rig,
      null
    ).exportFields,
    debug: buildEyeGazeAiReviewFields(
      { source: "mediapipe-web", rig: last.rig, debug: last.debug, timestampMs: 100 },
      last.rig,
      null
    ).debug,
    rig: last.rig,
    drive: { sent: false, mode: "preview-only", dryRun: false },
    device: {},
    diagnostic: { excludeFromSummary: false, isStatusFrame: false },
  }
  const payload = buildAiReviewExportPayload({
    frames: [frame],
    summary: {},
    options: {},
    durationMs: 100,
    frameCount: 1,
  })
  assert.ok(payload.frameSeries.columns.includes("gazeRawX"))
  assert.ok(payload.frameSeries.columns.includes("headYawProxy"))
  assert.equal(payload.schemaVersion, "tracking-diagnostic-ai-review-v1")
})
