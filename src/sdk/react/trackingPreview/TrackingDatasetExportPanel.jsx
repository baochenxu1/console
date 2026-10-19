import { useCallback, useMemo, useState } from "react"

const DURATION_PRESETS = [
  { id: "5s", label: "5s", ms: 5000 },
  { id: "10s", label: "10s", ms: 10000 },
  { id: "manual", label: "Manual", ms: 0 },
]

/**
 * Tracking Preview — Dataset Export panel (Phase 3.1).
 */
export default function TrackingDatasetExportPanel({
  className = "",
  datasetRecorder,
  sourceType = "idle",
  previewOnlyForced = false,
  trackingLive = false,
  browserLocalMode = false,
  videoSourceTuningEnabled = true,
}) {
  const [durationPreset, setDurationPreset] = useState("5s")
  const [includeLandmarks, setIncludeLandmarks] = useState(false)
  const [includeBlendshapes, setIncludeBlendshapes] = useState(true)
  const [includeRawTrackingSignals, setIncludeRawTrackingSignals] = useState(true)
  const [includeTunedRig, setIncludeTunedRig] = useState(true)
  const [includePreviewCommand, setIncludePreviewCommand] = useState(true)
  const [busy, setBusy] = useState(false)

  const durationMs = useMemo(() => {
    const preset = DURATION_PRESETS.find((p) => p.id === durationPreset)
    return preset?.ms ?? 5000
  }, [durationPreset])

  const datasetTypeLabel = useMemo(() => {
    if (sourceType === "camera") return "Camera Reference Tracking"
    if (sourceType === "uploaded-video") return "Teacher Uploaded Video Tracking"
    if (sourceType === "video") return "Teacher Video Tracking"
    return "—"
  }, [sourceType])

  const recording = Boolean(datasetRecorder?.status?.recording)
  const sessionId = datasetRecorder?.status?.sessionId
  const frameCount = datasetRecorder?.status?.frameCount ?? 0
  const lastResult = datasetRecorder?.status?.lastResult
  const downloadSessionId = sessionId || lastResult?.sessionId

  const handleStart = useCallback(async () => {
    if (!datasetRecorder?.startRecording) return
    setBusy(true)
    try {
      datasetRecorder.setOptions?.({
        durationMs,
        includeLandmarks,
        includeBlendshapes,
        includeRawTrackingSignals,
        includeTunedRig,
        includePreviewCommand,
      })
      await datasetRecorder.startRecording({
        durationMs,
        includeLandmarks,
        includeBlendshapes,
        includeRawTrackingSignals,
        includeTunedRig,
        includePreviewCommand,
      })
    } catch {
      /* surfaced via actionError */
    } finally {
      setBusy(false)
    }
  }, [
    datasetRecorder,
    durationMs,
    includeLandmarks,
    includeBlendshapes,
    includeRawTrackingSignals,
    includeTunedRig,
    includePreviewCommand,
  ])

  const handleStop = useCallback(async () => {
    if (!datasetRecorder?.stopRecording) return
    setBusy(true)
    try {
      await datasetRecorder.stopRecording()
    } catch {
      /* surfaced via actionError */
    } finally {
      setBusy(false)
    }
  }, [datasetRecorder])

  const idleBlocked = sourceType === "idle"
  const trackingBlocked = !trackingLive && !recording

  return (
    <section className={`tp-dataset-export${className ? ` ${className}` : ""}`}>
      <header className="tp-dataset-export__header">
        <h3 className="tp-dataset-export__title">Dataset Export</h3>
        <span className="tp-dataset-export__schema">
          tracking-dataset-v1 · {browserLocalMode ? "Browser 本地" : "Python"} · gzip default
        </span>
      </header>

      <div className="tp-dataset-export__grid">
        <label className="tp-dataset-export__field">
          <span>Dataset Type</span>
          <strong>{datasetTypeLabel}</strong>
        </label>

        <label className="tp-dataset-export__field">
          <span>Duration</span>
          <select
            value={durationPreset}
            disabled={recording || busy}
            onChange={(e) => setDurationPreset(e.target.value)}
          >
            {DURATION_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <label className="tp-dataset-export__check">
          <input
            type="checkbox"
            checked={includeLandmarks}
            disabled={recording || busy}
            onChange={(e) => setIncludeLandmarks(e.target.checked)}
          />
          <span>Include Landmarks</span>
        </label>

        <label className="tp-dataset-export__check">
          <input
            type="checkbox"
            checked={includeBlendshapes}
            disabled={recording || busy}
            onChange={(e) => setIncludeBlendshapes(e.target.checked)}
          />
          <span>Include Blendshapes</span>
        </label>

        <label className="tp-dataset-export__check">
          <input
            type="checkbox"
            checked={includeRawTrackingSignals}
            disabled={recording || busy}
            onChange={(e) => setIncludeRawTrackingSignals(e.target.checked)}
          />
          <span>Include Raw Tracking Signals</span>
        </label>

        <label className="tp-dataset-export__check">
          <input
            type="checkbox"
            checked={includeTunedRig}
            disabled={recording || busy}
            onChange={(e) => setIncludeTunedRig(e.target.checked)}
          />
          <span>Include Tuned Rig</span>
        </label>

        <label className="tp-dataset-export__check">
          <input
            type="checkbox"
            checked={includePreviewCommand}
            disabled={recording || busy}
            onChange={(e) => setIncludePreviewCommand(e.target.checked)}
          />
          <span>Include Preview Command</span>
        </label>
      </div>

      <div className="tp-dataset-export__status">
        {idleBlocked ? (
          <span className="tp-dataset-export__warn">Source idle — switch Camera or Video first</span>
        ) : null}
        {!idleBlocked && trackingBlocked ? (
          <span className="tp-dataset-export__warn">
            请先 Start Tracking（Model READY）再开始 Dataset 录制
          </span>
        ) : null}
        {browserLocalMode ? (
          <span className="tp-dataset-export__hint">Browser 模式：本地内存录制，无需 Python 8766</span>
        ) : null}
        {previewOnlyForced ? (
          <span className="tp-dataset-export__safe">Preview-only safety enforced</span>
        ) : null}
        {sourceType === "video" && videoSourceTuningEnabled ? (
          <span>Video Source Tuning: On</span>
        ) : null}
        {sourceType === "uploaded-video" && videoSourceTuningEnabled ? (
          <span>Uploaded Video · Tuning: On</span>
        ) : null}
        <span className="tp-dataset-export__hint">
          30fps 高质量采集；已默认 gzip 压缩。10 分钟视频未压缩约 50MB，gzip 后通常明显更小。不建议无目标长时间录制。
        </span>
        {recording ? (
          <span>
            Recording {sessionId} — {frameCount} frames
          </span>
        ) : lastResult ? (
          <span>
            Last export: {lastResult.sessionId} — {lastResult.frameCount} frames
          </span>
        ) : null}
        {datasetRecorder?.actionError ? (
          <span className="tp-dataset-export__error">{datasetRecorder.actionError}</span>
        ) : null}
      </div>

      <div className="tp-dataset-export__actions">
        <button
          type="button"
          className="tp-dataset-export__btn tp-dataset-export__btn--primary"
          disabled={busy || recording || idleBlocked || trackingBlocked}
          onClick={handleStart}
        >
          Start Recording
        </button>
        <button
          type="button"
          className="tp-dataset-export__btn"
          disabled={busy || !recording}
          onClick={handleStop}
        >
          Stop Recording
        </button>
        {downloadSessionId ? (
          <>
            <a
              className="tp-dataset-export__btn tp-dataset-export__btn--link"
              href={datasetRecorder.buildDownloadUrl(downloadSessionId, "metadata")}
              download={browserLocalMode ? `${downloadSessionId}.metadata.json` : undefined}
            >
              Download Metadata
            </a>
            <a
              className="tp-dataset-export__btn tp-dataset-export__btn--link"
              href={datasetRecorder.buildDownloadUrl(downloadSessionId, "frames")}
              download={
                browserLocalMode
                  ? `${downloadSessionId}.frames.jsonl${lastResult?.exportCompression === "gzip" ? ".gz" : ""}`
                  : undefined
              }
            >
              Download Frames (.jsonl.gz)
            </a>
          </>
        ) : null}
      </div>
    </section>
  )
}
