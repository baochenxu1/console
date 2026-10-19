import { useMemo } from "react"
import { OUTPUT_MODES, DEVICE_DRIVE_DEFAULTS, DIAGNOSTIC_MODES, DIAGNOSTIC_MODE_LABELS } from "../../trackingPreview/trackingPreviewConstants.js"

/**
 * Tracking Preview 右下角 Developer Debug（精简版：Diagnostic 录制 + 必要开关）。
 */
export default function TrackingPreviewDeveloperDebug({
  className = "",
  lastFrame,
  wsUrlDraft,
  status,
  onSetLipNeutral,
  cameraRunning = false,
  deviceDriveDebug = null,
  outputMode = OUTPUT_MODES.BUS_SERVO,
  browDebug = null,
  bypassBrowGate = false,
  onBypassBrowGateChange,
  bypassEyeRelease = false,
  onBypassEyeReleaseChange,
  diagnosticRecorder = null,
  diagnosticMode = DEVICE_DRIVE_DEFAULTS.diagnosticMode,
  onDiagnosticModeChange,
  dryRunResult = null,
  frontendOverlayMode = null,
  roiFaceScale = null,
  videoDiagnosticStartMs = 3000,
  videoSourceTuningEnabled = true,
  onVideoSourceTuningEnabledChange,
  busServoTxMode = DEVICE_DRIVE_DEFAULTS.busServoTxMode,
  onBusServoTxModeChange,
}) {
  const inputSource = lastFrame?.debug?.inputSource ?? null
  const trackingDebug = lastFrame?.debug?.trackingDebug ?? null
  const isVideo = inputSource?.sourceType === "video"
  const browserLive = lastFrame?.debug?.browserLiveSample ?? null
  const browserSemanticPeek = lastFrame?.debug?.browserSemanticPeek ?? null
  const blendDiag = lastFrame?.debug?.blendshapeDiagnostics ?? null
  const isBrowserFrame = lastFrame?.source === "mediapipe-web" || inputSource?.runtime === "browser"

  const trackingPeek = useMemo(() => {
    if (!trackingDebug) return null
    const lm = trackingDebug.selectedLandmarks || {}
    const keys = ["noseTip", "leftMouthCorner", "rightMouthCorner"]
    const pts = {}
    for (const k of keys) {
      if (lm[k]) pts[k] = { px: lm[k].px, py: lm[k].py }
    }
    const featureBox = trackingDebug.selectedFeatureBox ?? trackingDebug.faceBox
    const fullFaceBox = trackingDebug.fullFaceBox
    return {
      faceDetected: trackingDebug.faceDetected,
      frameWidth: trackingDebug.frameWidth,
      frameHeight: trackingDebug.frameHeight,
      selectedFeatureBox: featureBox
        ? {
            centerXPx: featureBox.centerXPx,
            centerYPx: featureBox.centerYPx,
            widthPx: featureBox.widthPx,
            heightPx: featureBox.heightPx,
          }
        : null,
      fullFaceBox: fullFaceBox
        ? {
            centerXPx: fullFaceBox.centerXPx,
            centerYPx: fullFaceBox.centerYPx,
            widthPx: fullFaceBox.widthPx,
            heightPx: fullFaceBox.heightPx,
          }
        : null,
      faceSize: trackingDebug.faceSize ?? null,
      samplePoints: pts,
      headMotion: trackingDebug.headMotion ?? null,
      previewOverlay: trackingDebug.previewOverlay ?? null,
      frontendOverlayMode: frontendOverlayMode ?? null,
      faceScale: trackingDebug.faceScale ?? roiFaceScale ?? null,
    }
  }, [trackingDebug, frontendOverlayMode, roiFaceScale])

  return (
    <details className={`tracking-preview-dev-debug tp-dev-debug${className ? ` ${className}` : ""}`}>
      <summary>Developer Debug</summary>
      <div className="tracking-preview-dev-debug-body">
        <p className="tp-dev-debug-status">
          WS {status?.running ? "connected" : "idle"} · source {inputSource?.sourceType ?? "—"}
          {isVideo && inputSource?.videoMode ? ` · ${inputSource.videoMode}` : ""}
          {inputSource?.sourceSeq != null ? ` · seq ${inputSource.sourceSeq}` : ""}
        </p>

        {cameraRunning && typeof onSetLipNeutral === "function" ? (
          <p className="tp-dev-debug-row">
            <button type="button" className="tp-btn tp-btn--secondary tp-btn--sm" onClick={onSetLipNeutral}>
              Set Mouth Neutral
            </button>
          </p>
        ) : null}

        <div className="tp-diagnostic-recorder-block">
          <h4 className="tp-diagnostic-recorder-title">Tracking Diagnostic</h4>
          <p className="tp-dev-debug-row">
            <label>
              Mode{" "}
              <select
                className="tp-select"
                value={diagnosticMode}
                onChange={(e) => onDiagnosticModeChange?.(e.target.value)}
              >
                {Object.entries(DIAGNOSTIC_MODE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </p>
          <p className="tp-dev-debug-row">
            <label>
              Video Source Tuning{" "}
              <select
                className="tp-select"
                value={videoSourceTuningEnabled ? "on" : "off"}
                onChange={(e) => onVideoSourceTuningEnabledChange?.(e.target.value === "on")}
              >
                <option value="on">On (video only)</option>
                <option value="off">Off (A/B baseline)</option>
              </select>
            </label>
          </p>
          <p className="tp-dev-debug-actions">
            <button
              type="button"
              className="tp-btn tp-btn--primary tp-btn--sm"
              disabled={
                !cameraRunning ||
                diagnosticRecorder?.status?.recording ||
                diagnosticMode === DIAGNOSTIC_MODES.OFF
              }
              onClick={() =>
                diagnosticRecorder?.startRecording({
                  durationMs: 5000,
                  diagnosticMode,
                  videoSourceTuningEnabled,
                  ...(isVideo ? { videoStartMs: videoDiagnosticStartMs } : {}),
                })
              }
            >
              Record 5s
            </button>
            <button
              type="button"
              className="tp-btn tp-btn--secondary tp-btn--sm"
              disabled={
                !cameraRunning ||
                diagnosticRecorder?.status?.recording ||
                diagnosticMode === DIAGNOSTIC_MODES.OFF
              }
              onClick={() =>
                diagnosticRecorder?.startRecording({
                  durationMs: 10000,
                  diagnosticMode,
                  videoSourceTuningEnabled,
                  ...(isVideo ? { videoStartMs: videoDiagnosticStartMs } : {}),
                })
              }
            >
              Record 10s
            </button>
            <button
              type="button"
              className="tp-btn tp-btn--secondary tp-btn--sm"
              disabled={!diagnosticRecorder?.status?.recording}
              onClick={() => diagnosticRecorder?.stopRecording()}
            >
              Stop
            </button>
            <button
              type="button"
              className="tp-btn tp-btn--secondary tp-btn--sm"
              disabled={!diagnosticRecorder?.status?.hasExport}
              onClick={() => {
                diagnosticRecorder?.exportLast().catch((e) => {
                  window.alert(e?.message || String(e))
                })
              }}
            >
              Export
            </button>
          </p>
          {diagnosticRecorder?.exportError ? (
            <p className="hint tp-warn">export: {diagnosticRecorder.exportError}</p>
          ) : null}
          <p className="hint tp-dev-debug-meta">
            Record 5s/10s 需先 Start Tracking；结束后自动下载。frames 为 0 表示未采到帧。
          </p>
          <p className="hint tp-dev-debug-meta">
            rec {diagnosticRecorder?.status?.recording ? "yes" : "no"} · frames{" "}
            {diagnosticRecorder?.status?.frameCount ?? 0} ·{" "}
            {Math.round((diagnosticRecorder?.status?.elapsedMs || 0) / 100) / 10}s
            {dryRunResult?.finalServoOutputs?.length
              ? ` · bind ${dryRunResult.finalServoOutputs.length}`
              : ""}
          </p>
        </div>

        {isBrowserFrame && (browserLive || browserSemanticPeek) ? (
          <details className="tp-dev-debug-details" open>
            <summary>Browser Observation</summary>
            <pre className="tracking-preview-json">
              {JSON.stringify(
                {
                  face: lastFrame?.faceDetected ? "yes" : "no",
                  timestamp: browserLive?.timestampMs ?? lastFrame?.timestampMs,
                  landmarks: browserLive?.landmarkCount ?? lastFrame?.debug?.landmarkCount,
                  blendshapes: browserLive?.rawCategoryCount,
                  convention: browserLive?.cameraCoordinateConvention,
                  previewCssMirror: browserLive?.previewCssMirror,
                  inferenceFlipHorizontal: browserLive?.inferenceFlipHorizontal,
                  video: {
                    w: browserLive?.videoWidth,
                    h: browserLive?.videoHeight,
                  },
                  rawKeys: browserLive?.blendshapeKeyScores,
                  semantic: browserSemanticPeek,
                  unknownBlendshapeKeys: blendDiag?.unknownBlendshapeKeys ?? browserLive?.unknownBlendshapeKeys,
                  missingExpectedBlendshapeKeys:
                    blendDiag?.missingExpectedBlendshapeKeys ??
                    browserLive?.missingExpectedBlendshapeKeys,
                },
                null,
                2
              )}
            </pre>
          </details>
        ) : null}

        {isVideo && trackingPeek?.faceScale ? (
          <details className="tp-dev-debug-details" open>
            <summary>ROI faceScale（当前帧）</summary>
            <pre className="tracking-preview-json">
              {JSON.stringify(trackingPeek.faceScale, null, 2)}
            </pre>
          </details>
        ) : null}

        {isVideo && trackingPeek ? (
          <details className="tp-dev-debug-details">
            <summary>Video trackingDebug（当前帧）</summary>
            <pre className="tracking-preview-json">{JSON.stringify(trackingPeek, null, 2)}</pre>
          </details>
        ) : null}

        <p className="hint tp-dev-debug-toggles">
          <label>
            <input
              type="checkbox"
              checked={Boolean(bypassBrowGate)}
              onChange={(e) => onBypassBrowGateChange?.(e.target.checked)}
            />
            Bypass Brow Gate
          </label>
          <label>
            <input
              type="checkbox"
              checked={Boolean(bypassEyeRelease)}
              onChange={(e) => onBypassEyeReleaseChange?.(e.target.checked)}
            />
            Bypass Eye Release
          </label>
        </p>

        <details className="tp-dev-debug-details">
          <summary>Bus Servo（Device Drive）</summary>
          <p className="tp-dev-debug-row">
            <select
              className="tp-select"
              value={busServoTxMode}
              onChange={(e) => onBusServoTxModeChange?.(e.target.value)}
            >
              <option value="single-write">single-write</option>
              <option value="hybrid">hybrid</option>
              <option value="sync-write">sync-write</option>
            </select>
          </p>
          <p className="hint tp-dev-debug-meta">
            send {deviceDriveDebug?.realSendFps ?? "—"} fps · write{" "}
            {deviceDriveDebug?.serialWriteDebug?.writeDurationMs ?? "—"}ms · tx{" "}
            {deviceDriveDebug?.busServoTxMode ?? busServoTxMode}
            {outputMode ? ` · ${outputMode}` : ""}
          </p>
        </details>

        <details className="tp-dev-debug-details">
          <summary>Connection</summary>
          <p className="hint">{wsUrlDraft || "—"}</p>
        </details>

        {browDebug || lastFrame?.debug?.browGate ? (
          <details className="tp-dev-debug-details">
            <summary>Brow gate（折叠）</summary>
            <pre className="tracking-preview-json">
              {JSON.stringify(browDebug || lastFrame?.debug?.browGate, null, 2)}
            </pre>
          </details>
        ) : null}
      </div>
    </details>
  )
}
