import { useRef } from "react"
import PreviewViewportPlaceholder from "./PreviewViewportPlaceholder.jsx"
import VideoStatusHud from "./VideoStatusHud.jsx"
import { useCameraMjpegPreview } from "./useCameraMjpegPreview.js"
import { useVideoFrameDebug } from "./useVideoFrameDebug.js"
import { DEFAULT_WS_CAMERA } from "../../trackingPreview/trackingPreviewConstants.js"
import { useVideoPreviewPlayback } from "./useVideoPreviewPlayback.js"
import VideoPreviewPlaybackBar from "./VideoPreviewPlaybackBar.jsx"

/**
 * @param {object} props
 */
export default function VideoPreviewPanel({
  trackingEnabled,
  trackingStatus = {},
  lastFrame = null,
  onVideoFrameDebugChange,
  onStart,
  onStop,
  defaultVideos = [],
  selectedVideoId = "",
  onVideoSelect,
  videoSwitchBusy = false,
  sourceState = null,
  uploadedVideos = [],
  sendTrackingControl,
  stopBusy = false,
  diagnosticRecording = false,
  autoRecordOnStart = false,
  showWsUrl = false,
  wsUrlDraft = "",
  onWsUrlChange,
  onApplyWs,
  wsUrl = DEFAULT_WS_CAMERA,
}) {
  const st = trackingStatus
  const wsConnected = Boolean(st.running || st.wsOpen)
  const wsError = Boolean(st.error)
  const videoEnded = Boolean(st.videoEnded)

  const mjpeg = useCameraMjpegPreview({
    trackingEnabled,
    wsUrl: wsUrl || wsUrlDraft || DEFAULT_WS_CAMERA,
  })

  const imgRef = useRef(null)
  const viewportRef = useRef(null)

  const trackingDebug = lastFrame?.debug?.trackingDebug ?? null
  const measureActive = Boolean(trackingEnabled && (mjpeg.showStream || trackingDebug))

  useVideoFrameDebug(
    imgRef,
    viewportRef,
    trackingDebug,
    measureActive,
    onVideoFrameDebugChange
  )

  const playback = useVideoPreviewPlayback({
    wsUrl: wsUrl || wsUrlDraft || DEFAULT_WS_CAMERA,
    sourceState: sourceState ?? {},
    defaultVideos,
    uploadedVideos,
    lastFrame,
    trackingEnabled,
    videoEnded,
    sendTrackingControl,
    fallbackVideoId: selectedVideoId,
    selectedVideoId,
  })

  const activeLabel = videoEnded
    ? "Video · ended"
    : wsError
      ? "Connection error"
      : mjpeg.showStream
        ? "Video · MJPEG"
        : mjpeg.streamFailed
          ? "Tracking · MJPEG 未就绪"
          : st.faceDetected
            ? "Tracking · face detected"
            : "Tracking · no face"

  const emptyHint = mjpeg.streamFailed
    ? "MJPEG 未就绪：请确认 Python 已用 --source video --video-path 启动"
    : trackingEnabled
      ? "WebSocket video tracking · MJPEG preview"
      : "Start 连接 ws://127.0.0.1:8766/tracking（需 Python video 模式）"

  const handleStartClick = () => {
    playback.primeAudioFromUserGesture?.()
    onStart?.()
  }

  return (
    <>
      <PreviewViewportPlaceholder
        variant="video"
        emptyTitle={trackingEnabled ? "Connecting video preview…" : "Video tracking idle"}
        emptyHint={emptyHint}
        active={trackingEnabled && wsConnected && !wsError && !videoEnded}
        activeLabel={activeLabel}
        statusHud={<VideoStatusHud status={st} />}
      >
        <div className="tp-video-viewport-wrap" ref={viewportRef}>
          {mjpeg.showStream ? (
            <img
              ref={imgRef}
              className="tp-camera-mjpeg"
              src={mjpeg.streamSrc}
              alt="Video MJPEG preview"
              onError={mjpeg.onStreamError}
              onLoad={mjpeg.onStreamLoad}
            />
          ) : null}
          <VideoPreviewPlaybackBar
            playback={playback}
            disabled={videoSwitchBusy || stopBusy}
            overlay
          />
        </div>
      </PreviewViewportPlaceholder>

      <div className="tp-source-toolbar">
        <button
          type="button"
          className="tp-btn-start"
          disabled={trackingEnabled}
          title={
            autoRecordOnStart
              ? "Start tracking and auto-record diagnostic (full video)"
              : "Start tracking (diagnostic mode off)"
          }
          onClick={handleStartClick}
        >
          Start
        </button>
        <button
          type="button"
          className="tp-btn-stop"
          disabled={!trackingEnabled || stopBusy}
          onClick={onStop}
        >
          Stop
        </button>
        {diagnosticRecording ? (
          <span className="tp-diagnostic-rec-badge" title="Diagnostic recording">
            REC
          </span>
        ) : null}
        {defaultVideos.length > 0 ? (
          <label className="tp-video-select">
            Video{" "}
            <select
              className="tp-select tp-select--sm"
              value={selectedVideoId ?? ""}
              disabled={videoSwitchBusy || stopBusy}
              onChange={(e) => onVideoSelect?.(e.target.value)}
              aria-label="Default video file"
            >
              {defaultVideos.map((v) => (
                <option key={String(v.id)} value={String(v.id)}>
                  {String(v.label || v.id)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {showWsUrl ? (
        <div className="tp-ws-dev">
          <span className="tp-ws-dev-label">WebSocket</span>
          <div className="tp-ws-dev-row">
            <input
              type="text"
              className="tp-ws-input"
              value={wsUrlDraft}
              spellCheck={false}
              onChange={(e) => onWsUrlChange?.(e.target.value)}
            />
            <button type="button" className="tp-btn-stop tp-btn-stop--sm" onClick={onApplyWs}>
              应用
            </button>
          </div>
        </div>
      ) : null}
    </>
  )
}
