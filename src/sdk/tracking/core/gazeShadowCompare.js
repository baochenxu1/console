/**
 * Gaze Algorithm Shadow Compare — irisGaze.js as diagnostic-only shadow.
 * Does not write Rig / Binding / Device Drive. Does not mutate official processGaze state.
 */

import {
  applyIrisOnlyGaze,
  createIrisGazeState,
  resetIrisGazeState,
  IRIS_ONLY_MODE,
} from "./irisGaze.js"

export const GAZE_SHADOW_ALGORITHM = "iris-only"

/**
 * Phase 1 default: enabled.
 * Disable via:
 *   globalThis.GAZE_SHADOW_COMPARE_ENABLED = false
 *   process.env.GAZE_SHADOW_COMPARE_ENABLED = "0"
 *   options.enabled = false / config.gazeShadowCompareEnabled = false
 */
export function resolveGazeShadowCompareEnabled(override) {
  if (override === true || override === false) return override
  try {
    if (typeof globalThis !== "undefined") {
      if (globalThis.GAZE_SHADOW_COMPARE_ENABLED === false) return false
      if (globalThis.GAZE_SHADOW_COMPARE_ENABLED === true) return true
    }
  } catch {
    //
  }
  try {
    if (typeof process !== "undefined" && process.env?.GAZE_SHADOW_COMPARE_ENABLED === "0") {
      return false
    }
  } catch {
    //
  }
  return true
}

function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now()
}

function numOrNull(v, digits = 5) {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  const f = 10 ** digits
  return Math.round(n * f) / f
}

function boolOrNull(v) {
  if (v === true) return true
  if (v === false) return false
  return null
}

/**
 * Map irisGaze apply result → unified debug.gaze.shadow schema.
 * Missing → null (never invent 0).
 */
export function adaptIrisGazeToShadowDiagnostic(applyResult) {
  const dbg = applyResult?.gazeDebug && typeof applyResult.gazeDebug === "object" ? applyResult.gazeDebug : {}
  const sr = applyResult?.sharedRadar && typeof applyResult.sharedRadar === "object" ? applyResult.sharedRadar : {}

  let neutralReady = boolOrNull(dbg.irisInitReady)
  if (neutralReady == null && dbg.outputMode === "iris_warmup") {
    neutralReady = false
  }

  return {
    available: boolOrNull(dbg.available),
    algorithm: GAZE_SHADOW_ALGORITHM,
    irisMode: IRIS_ONLY_MODE,
    rawX: numOrNull(dbg.irisLocalX),
    rawY: numOrNull(dbg.irisLocalY),
    normalizedX: numOrNull(dbg.irisXNorm),
    normalizedY: numOrNull(dbg.irisYNorm),
    neutralX: numOrNull(dbg.irisBaselineLocalX),
    neutralY: numOrNull(dbg.irisBaselineLocalY),
    neutralReady,
    candidateSharedRadarX: numOrNull(dbg.candidateSharedRadarX, 2),
    candidateSharedRadarY: numOrNull(dbg.candidateSharedRadarY, 2),
    emittedSharedRadarX: numOrNull(
      dbg.emittedSharedRadarX != null ? dbg.emittedSharedRadarX : sr.x,
      2
    ),
    emittedSharedRadarY: numOrNull(
      dbg.emittedSharedRadarY != null ? dbg.emittedSharedRadarY : sr.y,
      2
    ),
    outputMode: dbg.outputMode != null && String(dbg.outputMode) !== "" ? String(dbg.outputMode) : null,
  }
}

/**
 * Run iris-only shadow on the same landmarks/blendshapes as official gaze.
 * @returns {{ shadow: object, nextState: object, shadowGazeComputeMs: number }}
 */
export function computeIrisOnlyGazeShadow({
  landmarks,
  blendshapes,
  state,
  config,
  faceDetected,
  timestampMs,
} = {}) {
  const started = nowMs()
  const result = applyIrisOnlyGaze({
    landmarks,
    blendshapes,
    state,
    config,
    faceDetected,
    timestampMs,
  })
  const shadowGazeComputeMs = Math.max(0, nowMs() - started)
  return {
    shadow: adaptIrisGazeToShadowDiagnostic(result),
    nextState: result.nextState,
    shadowGazeComputeMs,
  }
}

export { createIrisGazeState, resetIrisGazeState }
