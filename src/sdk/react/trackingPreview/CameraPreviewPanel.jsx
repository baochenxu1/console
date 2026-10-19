import { useEffect, useRef } from "react"
import PreviewViewportPlaceholder from "./PreviewViewportPlaceholder.jsx"
import VideoStatusHud from "./VideoStatusHud.jsx"
import TrackingSourceIdleGuide from "./TrackingSourceIdleGuide.jsx"
import { useCameraMjpegPreview } from "./useCameraMjpegPreview.js"
import { DEFAULT_WS_CAMERA } from "../../trackingPreview/trackingPreviewConstants.js"

function IconPlay() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden>
      <path d="M3 2.5v9l8-4.5-8-4.5z" />
    </svg>
  )
}

function IconStop() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden>
      <rect x="3" y="3" width="8" height="8" rx="1" />
    </svg>
  )
}

/**
 * @param {object} props
 * @param {"python"|"browser"} [props.previewBackend]
 */
export default function CameraPreviewPanel({
  trackingEnabled,
  trackingStatus = {},
  cameraSourceState = {},
  gazeDebug = null,
  onStart,
  onStop,
  onPickCamera,
  diagnosticRecording = false,
  autoRecordOnStart = false,
  showWsUrl = false,
  wsUrlDraft = "",
  onWsUrlChange,
  onApplyWs,
  wsUrl = DEFAULT_WS_CAMERA,
  previewBackend = "python",
  onBrowserVideoElement = null,
  browserLifecycle = null,
  browserMetrics = null,
}) {
  void gazeDebug
  const isBrowser = previewBackend === "browser"
  const browserVideoRef = useRef(/** @type {HTMLVideoElement | null} */ (null))
  const st = trackingStatus
  const wsConnected = isBrowser ? Boolean(st.running || trackingEnabled) : Boolean(st.running || st.wsOpen)
  const wsError = Boolean(st.error)

  useEffect(() => {
    if (!isBrowser) return undefined
    onBrowserVideoElement?.(browserVideoRef.current)
    return () => onBrowserVideoElement?.(null)
  }, [isBrowser, onBrowserVideoElement, trackingEnabled])

  const switching = Boolean(cameraSourceState.switching)
  const switchTarget = cameraSourceState.switchTarget ?? null
  // Browser Idle 必须保留 16:9 预览框 + IdleGuide；勿强制伪装成 camera。
  const sourceType = isBrowser
    ? cameraSourceState.sourceType === "idle"
      ? "idle"
      : "camera"
    : cameraSourceState.sourceType ?? "idle"
  const sourceStatus = isBrowser
    ? trackingEnabled
      ? "running"
      : sourceType === "camera"
        ? "ready"
        : "idle"
    : cameraSourceState.status ?? "idle"
  const sourceError = cameraSourceState.error ? String(cameraSourceState.error) : ""

  const isCameraContext =
    sourceType === "camera" || switchTarget === "camera"

  const cameraBackendReady =
    (isBrowser && isCameraContext) ||
    (isCameraContext && sourceType === "camera" && sourceStatus === "running" && !switching)

  const streamUrl = wsUrl || wsUrlDraft || DEFAULT_WS_CAMERA
  const streamActive = !isBrowser && (cameraBackendReady || trackingEnabled)

  const mjpeg = useCameraMjpegPreview({
    previewActive: streamActive,
    wsUrl: streamUrl,
  })

  const cameraPreviewReady = isBrowser
    ? isCameraContext
    : cameraBackendReady && mjpeg.streamLoaded && !mjpeg.streamFailed

  const needsSourceSelect = !isCameraContext && !trackingEnabled && !switching

  const isPreparing =
    !isBrowser &&
    !trackingEnabled &&
    isCameraContext &&
    (!cameraBackendReady || (cameraBackendReady && !mjpeg.streamLoaded && !mjpeg.streamFailed))

  const isLiveConnecting =
    !isBrowser && trackingEnabled && mjpeg.showStream && !mjpeg.streamLoaded && !mjpeg.streamFailed

  const browserLoading =
    isBrowser &&
    isCameraContext &&
    !trackingEnabled &&
    (browserLifecycle === "LOADING_RUNTIME" || browserLifecycle === "LOADING_MODEL")

  const canStart = isBrowser
    ? isCameraContext && !trackingEnabled
    : cameraPreviewReady && !trackingEnabled && !mjpeg.streamFailed

  const activeLabel = isBrowser
    ? trackingEnabled
      ? st.faceDetected
        ? "Browser · face detected"
        : "Browser · no face"
      : browserLoading
        ? "Browser · loading model"
        : isCameraContext
          ? "Browser · ready"
          : "Browser · idle"
    : trackingEnabled && !wsConnected
      ? "Connecting…"
      : trackingEnabled && wsError
        ? "WS error"
        : cameraPreviewReady && !trackingEnabled
          ? "Camera · 已就绪"
          : st.faceDetected
            ? "Tracking · face detected"
            : "Tracking · no face"

  let emptyTitle = isBrowser ? "Browser Tracking 输入源待机" : "Tracking 输入源待机"
  let emptyHint = isBrowser
    ? "选择 Source → Camera，再点 Start（无需 Python Service）"
    : ""

  if (isBrowser) {
    if (needsSourceSelect) {
      emptyTitle = "Browser Tracking 输入源待机"
      emptyHint = "选择 Source → Camera，再点 Start（无需 Python Service）"
    } else if (browserLoading) {
      emptyTitle = "正在加载 MediaPipe…"
      emptyHint =
        browserLifecycle === "LOADING_MODEL" ? "加载 face_landmarker.task" : "加载 WASM runtime"
    } else if (st.error || browserLifecycle === "ERROR") {
      emptyTitle = "Browser Tracking 错误"
      const code = st.modelErrorCode ? `[${st.modelErrorCode}] ` : ""
      emptyHint = `${code}${st.modelErrorMessage || st.error || "Model ERROR"}`
    } else if (trackingEnabled) {
      emptyTitle = "Browser Tracking 运行中"
      emptyHint = browserMetrics
        ? `inf ${browserMetrics.inferenceFps ?? 0} fps · ${Math.round(browserMetrics.inferenceMsAvg || 0)} ms · drop ${browserMetrics.droppedFrames ?? 0}`
        : ""
    } else if (isCameraContext) {
      emptyTitle = "Browser MediaPipe 就绪"
      emptyHint = "点击 Start 授权摄像头并开始本机推理"
    }
  } else if (!isCameraContext && !trackingEnabled) {
    emptyTitle = "Tracking 输入源待机"
    emptyHint = ""
  } else if (switching && switchTarget === "camera") {
    emptyTitle = "正在打开摄像头…"
    emptyHint = "后端正在初始化设备，请稍候"
  } else if (sourceError || (sourceType === "camera" && sourceStatus === "error")) {
    emptyTitle = "摄像头打开失败"
    emptyHint = sourceError || "请检查设备是否被占用或已连接"
  } else if (isPreparing) {
    emptyTitle = "摄像头初始化中…"
    emptyHint = "就绪后即可点击 Start"
  } else if (mjpeg.streamFailed) {
    emptyTitle = "预览加载失败"
    emptyHint =
      "MJPEG 未就绪：请确认 Python 已启动（http://127.0.0.1:8767/preview.mjpg）"
  } else if (cameraPreviewReady && !trackingEnabled) {
    emptyTitle = "摄像头已就绪"
    emptyHint = "点击 Start 开始实时预览"
  } else if (isLiveConnecting) {
    emptyTitle = "正在连接预览…"
    emptyHint = "WebSocket tracking 已启动"
  } else if (trackingEnabled) {
    emptyTitle = "Connecting camera preview…"
    emptyHint = "WebSocket tracking · MJPEG preview"
  }

  const startTitle = trackingEnabled
    ? "Tracking 运行中"
    : isBrowser
      ? needsSourceSelect
        ? "请先在顶部 Source 选择 Camera"
        : "Start browser camera tracking"
      : switching && switchTarget === "camera"
        ? "正在打开摄像头，请稍候"
        : needsSourceSelect
          ? "请先在顶部 Source 选择模式；Camera 需选择设备"
          : isPreparing
            ? "等待摄像头就绪"
            : mjpeg.streamFailed
              ? "预览未就绪，无法 Start"
              : autoRecordOnStart
                ? "Start tracking and auto-record diagnostic (5s)"
                : "Start camera tracking"

  return (
    <>
      {!isBrowser && streamActive && !trackingEnabled ? (
        <img
          className="tp-camera-mjpeg-probe"
          src={mjpeg.streamSrc}
          alt=""
          aria-hidden
          onError={mjpeg.onStreamError}
          onLoad={mjpeg.onStreamLoad}
        />
      ) : null}

      <PreviewViewportPlaceholder
        variant="camera"
        emptyTitle={emptyTitle}
        emptyHint={emptyHint}
        active={trackingEnabled && wsConnected && !wsError}
        activeLabel={activeLabel}
        statusHud={trackingEnabled ? <VideoStatusHud status={st} /> : null}
      >
        {isBrowser ? (
          <video
            ref={browserVideoRef}
            className="tp-camera-mjpeg tp-camera-browser-video"
            playsInline
            muted
            autoPlay
          />
        ) : null}
        {!isBrowser && trackingEnabled && mjpeg.showStream ? (
          <img
            className="tp-camera-mjpeg"
            src={mjpeg.streamSrc}
            alt="Camera MJPEG preview"
            onError={mjpeg.onStreamError}
            onLoad={mjpeg.onStreamLoad}
          />
        ) : null}
        {!isBrowser && cameraPreviewReady && !trackingEnabled ? (
          <div className="tp-viewport-ready-state" role="status" aria-live="polite">
            <span className="tp-viewport-ready-icon" aria-hidden>
              ✓
            </span>
            <p className="tp-viewport-ready-title">摄像头已就绪</p>
            <p className="tp-viewport-empty-hint">点击 Start 开始实时预览</p>
          </div>
        ) : null}
        {isBrowser && isCameraContext && !trackingEnabled && !browserLoading ? (
          <div className="tp-viewport-ready-state" role="status" aria-live="polite">
            <span className="tp-viewport-ready-icon" aria-hidden>
              ✓
            </span>
            <p className="tp-viewport-ready-title">Browser MediaPipe 就绪</p>
            <p className="tp-viewport-empty-hint">点击 Start 授权摄像头并开始本机推理</p>
          </div>
        ) : null}
        {isPreparing || browserLoading ? (
          <div className="tp-viewport-preparing" role="status" aria-live="polite">
            <span className="tp-viewport-preparing-spinner" aria-hidden />
            <p className="tp-viewport-preparing-title">{emptyTitle}</p>
            <p className="tp-viewport-empty-hint">{emptyHint}</p>
          </div>
        ) : null}
        {isLiveConnecting ? (
          <div className="tp-viewport-preparing" role="status" aria-live="polite">
            <span className="tp-viewport-preparing-spinner" aria-hidden />
            <p className="tp-viewport-preparing-title">{emptyTitle}</p>
            <p className="tp-viewport-empty-hint">{emptyHint}</p>
          </div>
        ) : null}
        {needsSourceSelect ? (
          <div className="tp-viewport-preparing tp-viewport-preparing--idle" role="status">
            <TrackingSourceIdleGuide
              title={emptyTitle}
              note={
                isBrowser
                  ? "Browser Runtime：先选 Source → Camera，再点 Start。Video/Upload 需切换 Python Runtime。"
                  : "Camera 需先选择设备，确认后才会打开摄像头。"
              }
            />
          </div>
        ) : null}
      </PreviewViewportPlaceholder>

      {isBrowser && browserLifecycle === "ERROR" ? (
        <div className="tp-camera-active-bar" aria-label="Browser model error">
          <span>
            Model: ERROR
            {st.modelErrorCode ? ` · ${st.modelErrorCode}` : ""}
            {st.modelErrorMessage || st.error
              ? ` · Reason: ${st.modelErrorMessage || st.error}`
              : ""}
          </span>
        </div>
      ) : null}

      {isBrowser && browserMetrics && browserLifecycle !== "ERROR" ? (
        <div className="tp-camera-active-bar" aria-label="Browser tracking metrics">
          <span>
            Runtime: Browser · FPS {browserMetrics.inferenceFps ?? 0} · infer{" "}
            {Math.round(browserMetrics.inferenceMsLatest || 0)}ms · drop{" "}
            {browserMetrics.droppedFrames ?? 0}
          </span>
        </div>
      ) : null}

      {!isBrowser && sourceType === "camera" && !needsSourceSelect && !isPreparing && onPickCamera ? (
        <div className="tp-camera-active-bar">
          <span>
            {cameraSourceState.cameraLabel ?? "Camera"} · {cameraSourceState.cameraWidth ?? "?"}x
            {cameraSourceState.cameraHeight ?? "?"} @ {cameraSourceState.cameraFps ?? "?"}fps
          </span>
          <button type="button" className="tp-camera-pick-btn tp-camera-pick-btn--sm" onClick={onPickCamera}>
            更换摄像头
          </button>
        </div>
      ) : null}

      <div className="tp-source-toolbar">
        <button
          type="button"
          className="tp-btn-start"
          disabled={trackingEnabled || !canStart}
          title={startTitle}
          onClick={onStart}
        >
          <IconPlay />
          Start
        </button>
        <button type="button" className="tp-btn-stop" disabled={!trackingEnabled} onClick={onStop}>
          <IconStop />
          Stop
        </button>
        {diagnosticRecording ? (
          <span className="tp-diagnostic-rec-badge" title="Diagnostic recording">
            REC
          </span>
        ) : null}
      </div>

      {showWsUrl && !isBrowser ? (
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
