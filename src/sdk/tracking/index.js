export { TRACKING_FRAME_TYPE, createEmptyRigFrame } from "./trackingTypes.js"
export { normalizeEliteRig, normalizeRigFrameMessage, coerceToRigFrame } from "./trackingMapper.js"
export {
  normalizeInputSource,
  resolveInputSourceFromRigFrame,
  isVideoTrackingInput,
} from "./input/trackingInputFrame.js"
export {
  CameraTrackingInputAdapter,
  createCameraTrackingInputFrame,
} from "./input/cameraTrackingInputAdapter.js"
export { VideoTrackingInputAdapter } from "./input/videoTrackingInputAdapter.js"
export {
  processTrackingInputFrame,
  processTrackingRigFrame,
  attachInputSourceToRigFrame,
} from "./processTrackingFrame.js"
export { createWebSocketTrackingAdapter } from "./createWebSocketTrackingAdapter.js"
export {
  TRACKING_BACKEND_BROWSER,
  TRACKING_BACKEND_PYTHON,
  TRACKING_BACKEND_STORAGE_KEY,
  resolveTrackingBackend,
  persistTrackingBackend,
  createBrowserTrackingAdapter,
  normalizeBrowserFaceLandmarkerResult,
  mediaPipeResultToCanonicalObservation,
  createTrackingSemanticState,
  resetTrackingSemanticState,
  mapMediaPipeObservationToRig,
  createTrackingSemanticRuntime,
  createLatestFrameGate,
  createMonotonicTimestampGuard,
} from "./browser/index.js"
export {
  createDefaultTrackingCalibration,
  applyTrackingCalibration,
  isIrisOnlyGaze,
  resetTrackingEyeReleaseState,
} from "./trackingCalibration.js"
export {
  DEFAULT_EYE_CALIBRATION,
  createEyeTrackState,
  snapshotEyeReleaseState,
  snapshotEyeBalanceGains,
  applyDirectionalEyeGain,
  resolveBalanceGains,
  stabilizeEyeSide,
  eyeBlinkProxy,
} from "./eyeReleaseStabilizer.js"
export {
  EYE_BALANCE_CALIBRATION_DEFAULTS,
  createEyeBalanceCalibrationSession,
  appendEyeBalanceCalibrationFrame,
  finishEyeBalanceCalibrationSession,
  calculateEyeBalanceFromFrames,
} from "./diagnostics/eyeBalanceCalibration.js"
export {
  buildBrowDebugFromFrame,
  applyBrowGateBypass,
  buildBrowRawFromGateBefore,
  resolveBrowFromRigPayload,
  resolveBrowFromFrameDebug,
  resolveRuntimeBrowSource,
  mergeBrowChannelsFromDebug,
  injectFrameDebugBrowIntoRig,
  applyRuntimeBrowToRigIfGatePass,
  isBrowGatePassAction,
  applyUpperFaceMicroJitterFilter,
  DEFAULT_BROW_MICRO_JITTER,
  DEFAULT_EYE_MICRO_JITTER,
  buildBrowPipelineConsistency,
} from "./browDebugNormalize.js"
export {
  TRACKING_DIAGNOSTIC_SCHEMA,
  buildTrackingDiagnosticFrame,
  startTrackingDiagnosticRecording,
  appendTrackingDiagnosticFrame,
  appendDiagnosticSample,
  stopTrackingDiagnosticRecording,
  exportTrackingDiagnosticRecording,
  downloadTrackingDiagnosticRecording,
  getTrackingDiagnosticRecorderStatus,
  subscribeTrackingDiagnosticRecorder,
  extractSelectedLandmarks,
  refreshTrackingDiagnosticSnapshots,
} from "./diagnostics/trackingDiagnosticRecorder.js"
export {
  buildCompactDiagnosticFrame,
  buildCompactDiagnosticSample,
} from "./diagnostics/trackingDiagnosticLite.js"
export {
  TRACKING_DIAGNOSTIC_AI_REVIEW_SCHEMA,
  DIAGNOSTIC_EXPORT_MODES,
  AI_REVIEW_FRAME_COLUMNS,
  AI_REVIEW_REQUIRED_COLUMNS,
  buildAiReviewExportPayload,
  buildAiReviewFrameSeries,
  buildAiReviewEventSamples,
  validateAiReviewExportPayload,
} from "./diagnostics/diagnosticAiReviewExport.js"
export {
  analyzeGazeDiagnosticPayload,
  formatGazeAnalysisReport,
  buildCurrentVsShadowComparison,
  GAZE_ANALYZE_SCENARIOS,
  pearsonCorrelation,
  linearSlope,
} from "./diagnostics/gazeDiagnosticAnalyzer.js"
export {
  resolveGazeShadowCompareEnabled,
  adaptIrisGazeToShadowDiagnostic,
  computeIrisOnlyGazeShadow,
  createIrisGazeState,
  resetIrisGazeState,
  GAZE_SHADOW_ALGORITHM,
} from "./core/gazeShadowCompare.js"
export {
  processEyeLocalGazeV2,
  computeEyeLocalGaze,
  createGazeV2State,
  resetGazeV2State,
  normalizeGazeV2Config,
  resolveGazeAlgorithm,
  resolveFaceVerticalReference,
  resolveHeadLocalFrame,
  estimateHeadPoseDegFromAxes,
  extractFaceAxesFromMatrix,
  extractFaceNormalFromLandmarks,
  computeGazeEyeReliability,
  evaluateGazeEyeClosure,
  isGazeEyeTrackingValid,
  mapVerticalDirectionalResponse,
  arbitrateBinocularAxis,
  GAZE_ALGORITHM_V2,
  GAZE_ALGORITHM_LEGACY,
  GAZE_V2_LANDMARKS,
  DEFAULT_GAZE_V2_CONFIG,
} from "./core/eyeLocalGazeV2.js"
export {
  landmarkNormalizedToMetricCamera,
  extractHeadRotationFromFacialMatrix,
  applyInverseHeadRotation,
  computeHeadCanonicalEyeGaze,
  computeLegacyCameraSpaceEyeGaze,
  resolveHeadCanonicalContext,
  DEFAULT_INFERENCE_WIDTH,
  DEFAULT_INFERENCE_HEIGHT,
} from "./core/headCanonicalEyeGeometry.js"
export { createOneEuroFilter, createOneEuroFilter2D } from "./core/oneEuroFilter.js"
export {
  buildBindingProfileSnapshot,
  buildActuatorProfileSnapshot,
} from "./diagnostics/diagnosticProfileSnapshots.js"
export {
  buildVideoNeutralSnapshot,
  canSetNeutralFromFrame,
  applyVideoNeutralToFrame,
  subtractRigBaseline,
  buildVideoNeutralFrameDiagnostic,
  buildRawTrackingSignals,
  resetTrackingTemporalState,
  buildVideoNeutralCalibrationSummary,
  buildVideoNeutralEffectSummary,
} from "./videoNeutralCalibration.js"
export {
  buildMappingGainAnalysis,
  buildVideoNeutralEffectP90,
  buildVideoTrackingDiagnosis,
} from "./diagnostics/mappingGainAnalyzer.js"
export {
  resolveTrackingSourceContext,
  isVideoTrackingSourceContext,
} from "./input/trackingSourceContext.js"
export {
  DEFAULT_VIDEO_SOURCE_TUNING,
  applyVideoSourceTuningToFrame,
  buildVideoSourceTuningEffectSummary,
  buildVideoSourceTuningShadow,
  buildVideoSourceTuningShadowCompareSummary,
  buildJawOutputSourceAnalysis,
  buildJawOutputSourcesTrace,
  isVideoSourceFrame,
  normalizeVideoBrowInnerUp,
  resolveMouthScoreSaturationThreshold,
  softLimitSigned,
  softLimitEyeOutput,
} from "./videoSourceTuning.js"
