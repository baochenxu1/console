/**
 * Gaze Shadow Compare Phase 1 — Tests A–L
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  createTrackingSemanticState,
  createTrackingSemanticRuntime,
  mapMediaPipeObservationToRig,
  resetTrackingSemanticState,
} from "../core/trackingSemanticCore.js"
import {
  adaptIrisGazeToShadowDiagnostic,
  computeIrisOnlyGazeShadow,
  createIrisGazeState,
  resetIrisGazeState,
  resolveGazeShadowCompareEnabled,
  GAZE_SHADOW_ALGORITHM,
} from "../core/gazeShadowCompare.js"
import { applyIrisOnlyGaze } from "../core/irisGaze.js"
import {
  AI_REVIEW_FRAME_COLUMNS,
  buildAiReviewExportPayload,
} from "./diagnosticAiReviewExport.js"
import { buildEyeGazeAiReviewFields } from "./trackingDiagnosticLite.js"
import {
  analyzeGazeDiagnosticPayload,
  buildCurrentVsShadowComparison,
} from "./gazeDiagnosticAnalyzer.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "../../../..")

const FAST_GAZE = {
  irisWarmupFrames: 1,
  irisWarmupMinSamples: 1,
  irisWarmupMaxWaitFrames: 1,
}

function makeLandmarks(seed = 0) {
  const pts = []
  for (let i = 0; i < 478; i++) {
    const t = i * 0.01 + seed * 0.001
    pts.push({ x: 0.4 + Math.sin(t) * 0.02, y: 0.45 + Math.cos(t) * 0.02, z: 0 })
  }
  const set = (i, x, y) => {
    pts[i] = { x, y, z: 0 }
  }
  set(33, 0.3, 0.4)
  set(133, 0.38, 0.4)
  set(159, 0.34, 0.36)
  set(145, 0.34, 0.44)
  for (const i of [468, 469, 470, 471, 472]) set(i, 0.34 + seed * 0.002, 0.4)
  set(362, 0.62, 0.4)
  set(263, 0.7, 0.4)
  set(386, 0.66, 0.36)
  set(374, 0.66, 0.44)
  for (const i of [473, 474, 475, 476, 477]) set(i, 0.66 + seed * 0.002, 0.4)
  return pts
}

function makeObs(seed = 0, extra = {}) {
  return {
    faceDetected: true,
    timestampMs: 1000 + seed * 33,
    frameId: seed,
    landmarks: makeLandmarks(seed),
    blendshapes: {
      eyeBlinkLeft: 0.05,
      eyeBlinkRight: 0.05,
      jawOpen: 0.02,
      browInnerUp: 0.01,
      ...(extra.blendshapes || {}),
    },
    ...extra,
  }
}

function rigKey(rig) {
  return JSON.stringify({
    sharedRadar: rig?.sharedRadar,
    eyeL: rig?.eyeL,
    eyeR: rig?.eyeR,
    jaw: rig?.jaw,
    mouth: rig?.mouth,
    browL: rig?.browL,
    browR: rig?.browR,
  })
}

test("A — same observation enters current + shadow", () => {
  const state = createTrackingSemanticState()
  const out = mapMediaPipeObservationToRig(makeObs(0), state, null, {
    gaze: FAST_GAZE,
    gazeShadowCompareEnabled: true,
  })
  assert.ok(out.debug.gaze)
  assert.equal(typeof out.debug.gaze.sharedRadarX, "number")
  assert.ok(out.debug.gaze.shadow)
  assert.equal(out.debug.gaze.shadow.algorithm, GAZE_SHADOW_ALGORITHM)
  assert.equal(out.debug.gaze.shadow.available === true || out.debug.gaze.shadow.available === false, true)
})

test("B — shadow state independent of current gaze state", () => {
  const state = createTrackingSemanticState()
  mapMediaPipeObservationToRig(makeObs(0), state, null, {
    gaze: FAST_GAZE,
    gazeShadowCompareEnabled: true,
  })
  const gazeNeutralReady = state.gaze.neutralReady
  const shadowWarmup = state.shadowGaze.iris_warmup_done
  // Advance many frames with different seeds — states must remain separate objects
  for (let i = 1; i < 25; i++) {
    mapMediaPipeObservationToRig(makeObs(i), state, null, {
      gaze: FAST_GAZE,
      gazeShadowCompareEnabled: true,
    })
  }
  assert.notEqual(state.gaze, state.shadowGaze)
  assert.equal("neutralReady" in state.gaze, true)
  assert.equal("iris_warmup_done" in state.shadowGaze, true)
  assert.equal("iris_x_norm" in state.shadowGaze, true)
  assert.equal("emittedX" in state.gaze, true)
  void gazeNeutralReady
  void shadowWarmup
})

test("C — shadow does not modify official rig.sharedRadar", () => {
  const sOn = createTrackingSemanticState()
  const sOff = createTrackingSemanticState()
  const obs = makeObs(3)
  const on = mapMediaPipeObservationToRig(obs, sOn, null, {
    gaze: FAST_GAZE,
    gazeShadowCompareEnabled: true,
  })
  const off = mapMediaPipeObservationToRig(obs, sOff, null, {
    gaze: FAST_GAZE,
    gazeShadowCompareEnabled: false,
  })
  assert.equal(on.rig.sharedRadar.x, off.rig.sharedRadar.x)
  assert.equal(on.rig.sharedRadar.y, off.rig.sharedRadar.y)
  assert.ok(on.debug.gaze.shadow)
  assert.equal(off.debug.gaze.shadow, null)
})

test("D — shadow missing fields → null, not 0", () => {
  const adapted = adaptIrisGazeToShadowDiagnostic({
    gazeDebug: { available: true, outputMode: "iris_warmup" },
    sharedRadar: { x: 50, y: 50 },
  })
  assert.equal(adapted.rawX, null)
  assert.equal(adapted.rawY, null)
  assert.equal(adapted.normalizedX, null)
  assert.equal(adapted.neutralX, null)
  assert.equal(adapted.neutralReady, false)
  assert.notEqual(adapted.rawX, 0)
})

test("E — ai-review shadow columns present and populated", () => {
  for (const col of [
    "gazeShadowAvailable",
    "gazeShadowRawX",
    "gazeShadowRawY",
    "gazeShadowNormalizedX",
    "gazeShadowNormalizedY",
    "gazeShadowNeutralX",
    "gazeShadowNeutralY",
    "gazeShadowNeutralReady",
    "gazeShadowCandidateSharedRadarX",
    "gazeShadowCandidateSharedRadarY",
    "gazeShadowEmittedSharedRadarX",
    "gazeShadowEmittedSharedRadarY",
    "gazeShadowOutputMode",
  ]) {
    assert.ok(AI_REVIEW_FRAME_COLUMNS.includes(col), col)
  }

  const state = createTrackingSemanticState()
  let last = null
  for (let i = 0; i < 30; i++) {
    last = mapMediaPipeObservationToRig(makeObs(i), state, null, {
      gaze: FAST_GAZE,
      gazeShadowCompareEnabled: true,
    })
  }
  const lastFrame = {
    type: "tracking.rigFrame",
    source: "mediapipe-web",
    timestampMs: 2000,
    faceDetected: true,
    rig: last.rig,
    debug: {
      ...last.debug,
      inputSource: { sourceType: "camera", runtime: "browser", sourceSeq: 30 },
    },
  }
  const fields = buildEyeGazeAiReviewFields(lastFrame, last.rig, null)
  assert.equal(fields.exportFields.gazeShadowAvailable, true)
  assert.equal(typeof fields.exportFields.gazeShadowEmittedSharedRadarX, "number")
  assert.ok(fields.debug.gaze.shadow)

  const payload = buildAiReviewExportPayload({
    frames: [
      {
        ...lastFrame,
        ...fields.exportFields,
        sourceSeq: 30,
        timestampMs: 2000,
      },
    ],
    summary: {},
    options: {},
    durationMs: 1000,
    createdAt: new Date().toISOString(),
    frameCount: 1,
    diagnosticMode: "compact",
  })
  assert.ok(payload.frameSeries.columns.includes("gazeShadowEmittedSharedRadarX"))
})

test("F — STATIC current/shadow metrics", () => {
  const columns = [
    "gazeEmittedSharedRadarX",
    "gazeEmittedSharedRadarY",
    "gazeRawX",
    "gazeEyeLookX",
    "gazeShadowEmittedSharedRadarX",
    "gazeShadowEmittedSharedRadarY",
    "gazeShadowRawX",
    "gazeShadowNormalizedX",
  ]
  const rows = []
  for (let i = 0; i < 40; i++) {
    rows.push([
      50 + (i % 2 === 0 ? 0.3 : -0.3),
      50,
      0.01,
      0.02,
      50 + (i % 2 === 0 ? 0.1 : -0.1),
      50.05,
      0.005,
      0.01,
    ])
  }
  const cmp = buildCurrentVsShadowComparison(rows, columns, "static-center")
  assert.ok(cmp.STATIC_CENTER.CURRENT.stdX != null)
  assert.ok(cmp.STATIC_CENTER.SHADOW.stdX != null)
  assert.ok(cmp.STATIC_CENTER.CURRENT.biasX != null)
  assert.ok(["CURRENT_BETTER", "SHADOW_BETTER", "CLOSE"].includes(cmp.verdict.staticStability))
})

test("G — HEAD_YAW dual-algorithm correlation/slope", () => {
  const columns = [
    "headYawProxy",
    "gazeRawX",
    "gazeEyeLookX",
    "gazeEmittedSharedRadarX",
    "gazeShadowRawX",
    "gazeShadowNormalizedX",
    "gazeShadowEmittedSharedRadarX",
  ]
  const rows = []
  for (let i = 0; i < 50; i++) {
    const yaw = Math.sin(i / 5)
    rows.push([
      yaw,
      yaw * 2,
      yaw * 1.5,
      50 + yaw * 8,
      yaw * 0.05 + (i % 7) * 0.001,
      yaw * 0.04,
      50 + yaw * 0.5 + Math.cos(i) * 0.2,
    ])
  }
  const cmp = buildCurrentVsShadowComparison(rows, columns, "head-yaw")
  assert.ok(cmp.HEAD_YAW.CURRENT_YAW_LEAKAGE.emittedX.pearson != null)
  assert.ok(cmp.HEAD_YAW.SHADOW_YAW_LEAKAGE.emittedX.pearson != null)
  assert.ok(cmp.HEAD_YAW.CURRENT_YAW_LEAKAGE.emittedX.slope != null)
  assert.ok(
    Math.abs(cmp.HEAD_YAW.SHADOW_YAW_LEAKAGE.emittedX.slope) <
      Math.abs(cmp.HEAD_YAW.CURRENT_YAW_LEAKAGE.emittedX.slope)
  )
  assert.ok(["CURRENT_BETTER", "SHADOW_BETTER", "CLOSE"].includes(cmp.verdict.yawDecoupling))
  assert.equal(cmp.verdict.yawSlope, "SHADOW_BETTER")
})

test("H — EYE_HORIZONTAL crossTalkRatio", () => {
  const columns = [
    "gazeEmittedSharedRadarX",
    "gazeEmittedSharedRadarY",
    "gazeShadowEmittedSharedRadarX",
    "gazeShadowEmittedSharedRadarY",
  ]
  const rows = []
  for (let i = 0; i < 40; i++) {
    const x = 50 + Math.sin(i / 4) * 10
    rows.push([x, 50 + Math.sin(i / 4) * 6, x, 50 + Math.sin(i / 4) * 1])
  }
  const cmp = buildCurrentVsShadowComparison(rows, columns, "eye-horizontal")
  assert.ok(cmp.EYE_HORIZONTAL.CURRENT.crossTalkRatio > cmp.EYE_HORIZONTAL.SHADOW.crossTalkRatio)
  assert.equal(cmp.verdict.axisDecoupling, "SHADOW_BETTER")
})

test("I — shadow reset lifecycle", () => {
  const state = createTrackingSemanticState()
  for (let i = 0; i < 20; i++) {
    mapMediaPipeObservationToRig(makeObs(i), state, null, {
      gaze: FAST_GAZE,
      gazeShadowCompareEnabled: true,
    })
  }
  assert.equal(state.shadowGaze.iris_warmup_done, true)
  resetTrackingSemanticState(state)
  assert.equal(state.shadowGaze.iris_warmup_done, false)
  assert.equal(state.shadowGaze.iris_x_norm, 0)

  const s2 = createIrisGazeState()
  s2.iris_warmup_done = true
  s2.baseline_lx = 0.1
  resetIrisGazeState(s2)
  assert.equal(s2.iris_warmup_done, false)
})

test("J — Shadow enabled/disabled: official tracking.rigFrame math identical", () => {
  const seeds = [0, 1, 2, 5, 10, 15, 20]
  const onRigs = []
  const offRigs = []
  const sOn = createTrackingSemanticState()
  const sOff = createTrackingSemanticState()
  for (const seed of seeds) {
    const obs = makeObs(seed)
    onRigs.push(
      mapMediaPipeObservationToRig(obs, sOn, null, {
        gaze: FAST_GAZE,
        gazeShadowCompareEnabled: true,
      }).rig
    )
    offRigs.push(
      mapMediaPipeObservationToRig(obs, sOff, null, {
        gaze: FAST_GAZE,
        gazeShadowCompareEnabled: false,
      }).rig
    )
  }
  for (let i = 0; i < seeds.length; i++) {
    assert.equal(rigKey(onRigs[i]), rigKey(offRigs[i]), `seed=${seeds[i]}`)
  }
})

test("K — original gaze diagnostic tests still importable / analyzer works", () => {
  const columns = ["gazeEmittedSharedRadarX", "gazeEmittedSharedRadarY", "sourceSeq"]
  const rows = Array.from({ length: 20 }, (_, i) => [50.1, 49.9, i])
  const report = analyzeGazeDiagnosticPayload(
    {
      frameSeries: { columns, rows },
      summary: {},
    },
    { scenario: "static-center" }
  )
  assert.equal(report.scenario, "static-center")
  assert.ok(report.metrics.gazeEmittedSharedRadarX)
})

test("L — SC/ST/RJ regression: shadow modules protocol-agnostic", () => {
  const files = [
    "src/sdk/tracking/core/gazeShadowCompare.js",
    "src/sdk/tracking/core/irisGaze.js",
  ]
  for (const rel of files) {
    const src = readFileSync(join(root, rel), "utf8")
    assert.equal(src.includes("Scscl"), false, rel)
    assert.equal(src.includes("syncWrite"), false, rel)
    assert.equal(src.includes("rjSbus"), false, rel)
    assert.equal(src.includes("sendBusServo"), false, rel)
  }
})

test("flag — resolveGazeShadowCompareEnabled default on / override off", () => {
  assert.equal(resolveGazeShadowCompareEnabled(), true)
  assert.equal(resolveGazeShadowCompareEnabled(false), false)
  assert.equal(resolveGazeShadowCompareEnabled(true), true)
})

test("computeMs — current/shadow timing fields present when enabled", () => {
  const runtime = createTrackingSemanticRuntime({
    config: { gaze: FAST_GAZE, gazeShadowCompareEnabled: true },
  })
  const out = runtime.process(makeObs(0))
  assert.equal(typeof out.debug.gaze.currentGazeComputeMs, "number")
  assert.equal(typeof out.debug.gaze.shadowGazeComputeMs, "number")
  assert.ok(out.debug.gaze.shadowGazeComputeMs >= 0)
})

test("irisGaze.js — applyIrisOnlyGaze API still usable standalone", () => {
  const state = createIrisGazeState()
  const r = applyIrisOnlyGaze({
    landmarks: makeLandmarks(0),
    blendshapes: { eyeBlinkLeft: 0.05, eyeBlinkRight: 0.05 },
    state,
    faceDetected: true,
  })
  assert.ok(r.sharedRadar)
  assert.ok(r.gazeDebug)
  assert.ok(r.nextState)
  const shadow = computeIrisOnlyGazeShadow({
    landmarks: makeLandmarks(1),
    blendshapes: { eyeBlinkLeft: 0.05, eyeBlinkRight: 0.05 },
    state: r.nextState,
    faceDetected: true,
  })
  assert.equal(shadow.shadow.algorithm, "iris-only")
})
