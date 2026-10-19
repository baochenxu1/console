/**
 * Phase 3.1 — Client-side dataset recording session state (frames streamed to backend).
 */

export const TRACKING_DATASET_SCHEMA = "tracking-dataset-v1"

/** @type {TrackingDatasetRecorderState & { lastResult?: object | null }} */
const DEFAULT_STATE = {
  recording: false,
  sessionId: null,
  frameCount: 0,
  sourceType: null,
  sourceEpoch: null,
  datasetType: null,
  options: null,
  error: null,
  lastResult: null,
}

/** @typedef {typeof DEFAULT_STATE} TrackingDatasetRecorderState */

let state = { ...DEFAULT_STATE }
/** @type {Set<(s: TrackingDatasetRecorderState) => void>} */
const listeners = new Set()

function emit() {
  const snap = getTrackingDatasetRecorderStatus()
  for (const fn of listeners) {
    try {
      fn(snap)
    } catch {
      /* ignore */
    }
  }
}

export function getTrackingDatasetRecorderStatus() {
  return {
    ...state,
    options: state.options ? { ...state.options } : null,
    lastResult: state.lastResult ?? null,
  }
}

export function subscribeTrackingDatasetRecorder(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function beginTrackingDatasetSession(meta) {
  state = {
    recording: true,
    sessionId: meta.sessionId,
    frameCount: 0,
    sourceType: meta.sourceType ?? null,
    sourceEpoch: meta.sourceEpoch ?? null,
    datasetType: meta.datasetType ?? null,
    options: meta.options ? { ...meta.options } : null,
    error: null,
  }
  emit()
}

export function incrementTrackingDatasetFrameCount(count = 1) {
  if (!state.recording) return
  state.frameCount += count
  emit()
}

export function endTrackingDatasetSession(result = null) {
  state = {
    ...DEFAULT_STATE,
    sessionId: result?.sessionId ?? state.sessionId,
    frameCount: result?.frameCount ?? state.frameCount,
    sourceType: state.sourceType,
    sourceEpoch: state.sourceEpoch,
    datasetType: state.datasetType,
    lastResult: result,
  }
  emit()
}

export function setTrackingDatasetRecorderError(message) {
  state.error = message || null
  emit()
}

export function resetTrackingDatasetRecorder() {
  state = { ...DEFAULT_STATE }
  emit()
}
