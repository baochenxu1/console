import { useEffect, useState } from "react"
import { pickExtendedAdapterFields } from "./useTrackingAdapterController.js"

/** @typedef {import("../tracking/trackingTypes.js").TrackingAdapter} TrackingAdapterLike */

function fallbackTrackingStatus() {
  return {
    running: false,
    source: "none",
    faceDetected: false,
    fps: 0,
    rxFps: 0,
    pythonFps: /** @type {number | null} */ (null),
    receivedFrameCount: 0,
    lastFrameReceivedAt: 0,
    quality: 0,
    lastFrameAt: 0,
    error: null,
    rawWsFps: 0,
    parsedFrameFps: 0,
    callbackFps: 0,
    receivedMessageCount: 0,
    parsedFrameCount: 0,
    callbackFrameCount: 0,
    lastFrameSeq: /** @type {number | null} */ (null),
    skippedFrameCount: 0,
    lastParseMs: /** @type {number | null} */ (null),
    lastNormalizeMs: /** @type {number | null} */ (null),
    lastCallbackMs: /** @type {number | null} */ (null),
    avgPayloadBytes: 0,
    lastPayloadBytes: /** @type {number | null} */ (null),
    lastClientReceiveAtMs: /** @type {number | null} */ (null),
    lastServerSentAtMs: /** @type {number | null} */ (null),
    estimatedNetworkDelayMs: /** @type {number | null} */ (null),
  }
}

/**
 * @param {object} props
 * @param {TrackingAdapterLike} props.adapter
 * @param {boolean} props.trackingEnabled
 * @param {(enabled: boolean) => void} props.onTrackingEnabledChange
 * @param {boolean} props.driveRigEnabled
 * @param {(enabled: boolean) => void} props.onDriveRigEnabledChange
 * @param {(frame: import("../tracking/trackingTypes.js").RigFrame) => void} props.onFrame — 宿主在收到 RigFrame 时更新校准 / Rig；仅 `trackingEnabled` 时挂载。
 * @param {string} props.trackingWsUrl
 * @param {(url: string) => void} props.onTrackingWsUrlChange
 * @param {(() => void) | undefined} props.onReplaceWithWebSocketAdapter  — `createWebSocketTrackingAdapter({ url })` 并替换当前连接
 * @param {(() => void) | undefined} props.onTrackingClear
 * @param {(() => void) | undefined} props.onResetTrackingState — 清空前端校准平滑状态并重置面控为中性；不停止 WS、不下发舵机。
 * @param {import("../tracking/trackingTypes.js").RigFrame["debug"] | null | undefined} [props.trackingDebug]
 * @param {boolean} [props.showMediaPipeDebug] — 为 false 时隐藏 MediaPipe Debug 折叠区（表情编排页等）。
 * @param {boolean} [props.showResetStateHint] — 为 false 时隐藏「重置追踪状态」说明段落。
 * @param {boolean} [props.showAdapterStatusRow] — 为 false 时隐藏 source / running / face / fps / quality / error / last 一行（映射预览等默认开启）。
 * @param {boolean} [props.compactLayout] — 为 true 时合并 Tracking/Drive 与 WS URL 到一行并收紧间距（表情编排页）。
 * @param {{ uiDebugFps?: number | null; driveRigFps?: number | null; servoSendFps?: number | null } | undefined} [props.trackingLayerFps]
 * @param {boolean} [props.realtimePreviewActive] — 实时预览开启时才有 Servo FPS 统计与串口诊断。
 * @param {string} [props.lowLatencyHint] — 低延迟 / 与关键帧区分的说明（可选）
 */
export default function FaceTrackingPanel({
  adapter,
  trackingEnabled,
  onTrackingEnabledChange,
  driveRigEnabled,
  onDriveRigEnabledChange,
  onFrame,
  trackingWsUrl,
  onTrackingWsUrlChange,
  onReplaceWithWebSocketAdapter,
  onTrackingClear,
  onResetTrackingState,
  trackingDebug,
  showMediaPipeDebug = true,
  showResetStateHint = true,
  showAdapterStatusRow = true,
  compactLayout = false,
  trackingLayerFps,
  realtimePreviewActive = false,
  lowLatencyHint,
}) {
  const [status, setStatus] = useState(() => adapter?.getStatus?.() ?? fallbackTrackingStatus())

  useEffect(() => {
    const tick = () => {
      try {
        const raw = adapter?.getStatus?.() ?? {}
        const base = fallbackTrackingStatus()
        setStatus({
          ...base,
          running: Boolean(raw.running),
          source: typeof raw.source === "string" ? raw.source : base.source,
          faceDetected: Boolean(raw.faceDetected),
          fps: Number.isFinite(Number(raw.fps)) ? Number(raw.fps) : 0,
          rxFps: Number.isFinite(Number(raw.rxFps))
            ? Number(raw.rxFps)
            : Number.isFinite(Number(raw.fps))
              ? Number(raw.fps)
              : 0,
          pythonFps:
            raw.pythonFps != null && Number.isFinite(Number(raw.pythonFps))
              ? Number(raw.pythonFps)
              : null,
          receivedFrameCount: Number.isFinite(Number(raw.receivedFrameCount))
            ? Number(raw.receivedFrameCount)
            : 0,
          lastFrameReceivedAt: Number.isFinite(Number(raw.lastFrameReceivedAt))
            ? Number(raw.lastFrameReceivedAt)
            : 0,
          quality: Number.isFinite(Number(raw.quality)) ? Number(raw.quality) : 0,
          lastFrameAt: Number.isFinite(Number(raw.lastFrameAt)) ? Number(raw.lastFrameAt) : 0,
          error: raw.error != null ? String(raw.error) : null,
          ...pickExtendedAdapterFields(raw),
        })
      } catch {
        setStatus((prev) => ({ ...prev, error: "读取 getStatus() 失败" }))
      }
    }
    tick()
    const id = window.setInterval(tick, 140)
    return () => window.clearInterval(id)
  }, [adapter])

  useEffect(() => {
    if (!trackingEnabled || !onFrame || !adapter?.onFrame) {
      return undefined
    }
    adapter.onFrame(onFrame)
    return () => adapter.offFrame?.(onFrame)
  }, [adapter, trackingEnabled, onFrame])

  const lastAtText =
    status.lastFrameReceivedAt > 0
      ? new Date(status.lastFrameReceivedAt).toLocaleTimeString(undefined, {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          fractionalSecondDigits: 3,
        })
      : status.lastFrameAt > 0
        ? new Date(status.lastFrameAt).toLocaleTimeString(undefined, {
            hour12: false,
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            fractionalSecondDigits: 3,
          })
        : "—"

  const blend = trackingDebug?.blendshapes
  const mapv = trackingDebug?.mapping
  const gaze = trackingDebug?.gaze
  const perf = trackingDebug?.performance
  const debugMissing = trackingDebug == null || typeof trackingDebug !== "object"
  const hasBlend = !debugMissing && blend && typeof blend === "object" && Object.keys(blend).length > 0
  const hasMap = !debugMissing && mapv && typeof mapv === "object" && Object.keys(mapv).length > 0
  const hasGazeInfo = !debugMissing && gaze && typeof gaze === "object"
  const hasPerf =
    !debugMissing &&
    perf &&
    typeof perf === "object" &&
    (perf.fps != null ||
      perf.generatedFrameFps != null ||
      perf.broadcastSuccessFps != null ||
      perf.broadcastFps != null ||
      perf.broadcastFrameSeq != null ||
      perf.captureMs != null ||
      perf.capReadMs != null ||
      perf.preprocessMs != null ||
      perf.sleepMs != null ||
      perf.totalPeriodMs != null ||
      perf.targetIntervalMs != null ||
      perf.inferenceMs != null ||
      perf.mappingMs != null ||
      perf.broadcastMs != null ||
      perf.loopMs != null)
  const hasDebug = Boolean(hasBlend || hasMap || hasGazeInfo || hasPerf)

  const fmt2 = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(2) : "—")
  const fmtPerf = (v) =>
    v == null || Number.isNaN(Number(v)) ? "—" : Number.isFinite(Number(v)) ? Number(v).toFixed(2) : String(v)
  const fmtGazeOpt = (v) =>
    v == null || v === "" || Number.isNaN(Number(v))
      ? "—"
      : Number.isFinite(Number(v))
        ? Number(v).toFixed(2)
        : String(v)

  const fmtDashFps = (v) =>
    v != null && Number.isFinite(Number(v)) ? String(Math.round(Number(v))) : "-"

  const perfPyRaw =
    perf && typeof perf === "object" && perf.generatedFrameFps != null && Number.isFinite(Number(perf.generatedFrameFps))
      ? Number(perf.generatedFrameFps)
      : perf && typeof perf === "object" && perf.fps != null && Number.isFinite(Number(perf.fps))
        ? Number(perf.fps)
        : null
  const pythonFpsDisplay =
    perfPyRaw != null ? perfPyRaw : status.pythonFps != null ? Number(status.pythonFps) : null

  const broadcastFpsDisplay =
    perf && typeof perf === "object" && perf.broadcastSuccessFps != null && Number.isFinite(Number(perf.broadcastSuccessFps))
      ? Number(perf.broadcastSuccessFps)
      : perf && typeof perf === "object" && perf.broadcastFps != null && Number.isFinite(Number(perf.broadcastFps))
        ? Number(perf.broadcastFps)
        : null

  const rxFpsDisplay = Number.isFinite(status.rxFps)
    ? status.rxFps
    : Number.isFinite(status.fps)
      ? status.fps
      : null
  const rawWsFpsDisplay = Number.isFinite(status.rawWsFps) ? status.rawWsFps : null
  const parsedFpsDisplay = Number.isFinite(status.parsedFrameFps) ? status.parsedFrameFps : null
  const callbackFpsDisplay = Number.isFinite(status.callbackFps) ? status.callbackFps : null
  const uiFpsDisplay = trackingLayerFps?.uiDebugFps
  const driveFpsDisplay = driveRigEnabled ? trackingLayerFps?.driveRigFps : null
  const servoFpsDisplay = trackingLayerFps?.servoSendFps

  const fmtPayloadLine = () => {
    const a = status.avgPayloadBytes
    const l = status.lastPayloadBytes
    if ((!Number.isFinite(Number(a)) || Number(a) <= 0) && (l == null || !Number.isFinite(Number(l)))) {
      return "-"
    }
    const as = Number.isFinite(Number(a)) && Number(a) > 0 ? `${Math.round(Number(a))}` : "—"
    const ls = l != null && Number.isFinite(Number(l)) ? `${Math.round(Number(l))}` : "—"
    return `${as} / ${ls} B`
  }
  const fmtMsDash = (v) =>
    v != null && Number.isFinite(Number(v)) ? `${Number(v).toFixed(2)}ms` : "-"
  const fmtDelayDash = (v) =>
    v != null && Number.isFinite(Number(v)) ? `${Math.round(Number(v))}ms` : "-"

  const RX_DIAG_MIN = 10
  const RX_RATIO = 0.55

  const diagHints = []
  if (pythonFpsDisplay != null && pythonFpsDisplay > 0 && pythonFpsDisplay < 10) {
    diagHints.push("Python FPS 低：多为 MediaPipe / 摄像头 / 推理瓶颈。")
  }
  if (
    pythonFpsDisplay != null &&
    pythonFpsDisplay >= RX_DIAG_MIN &&
    broadcastFpsDisplay != null &&
    broadcastFpsDisplay > 0 &&
    broadcastFpsDisplay < pythonFpsDisplay * RX_RATIO
  ) {
    diagHints.push(
      "Python FPS 高但 Broadcast FPS 明显偏低：Python loop 快，WebSocket broadcast 或序列化偏慢。",
    )
  }
  if (
    broadcastFpsDisplay != null &&
    broadcastFpsDisplay >= RX_DIAG_MIN &&
    rawWsFpsDisplay != null &&
    rawWsFpsDisplay > 0 &&
    rawWsFpsDisplay < broadcastFpsDisplay * RX_RATIO
  ) {
    diagHints.push(
      "Broadcast FPS 高但 Raw WS FPS 明显偏低：浏览器接收、网络传输或主线程调度有瓶颈。",
    )
  }
  if (
    rawWsFpsDisplay != null &&
    rawWsFpsDisplay >= RX_DIAG_MIN &&
    parsedFpsDisplay != null &&
    parsedFpsDisplay > 0 &&
    parsedFpsDisplay < rawWsFpsDisplay * RX_RATIO
  ) {
    diagHints.push("Raw WS FPS 高但 Parsed FPS 明显偏低：JSON.parse 或消息筛选偏慢。")
  }
  if (
    parsedFpsDisplay != null &&
    parsedFpsDisplay >= RX_DIAG_MIN &&
    callbackFpsDisplay != null &&
    callbackFpsDisplay > 0 &&
    callbackFpsDisplay < parsedFpsDisplay * RX_RATIO
  ) {
    diagHints.push("Parsed FPS 高但 Callback FPS 明显偏低：normalizeRigFrameMessage 或 onFrame 回调偏慢。")
  }
  const parseMs = status.lastParseMs
  const payloadAvg = status.avgPayloadBytes
  if (
    Number.isFinite(Number(payloadAvg)) &&
    Number(payloadAvg) > 12000 &&
    parseMs != null &&
    Number.isFinite(Number(parseMs)) &&
    Number(parseMs) > 1.5
  ) {
    diagHints.push("Payload 较大且 parse 耗时高：可尝试服务端 --payload compact。")
  }
  if (rxFpsDisplay != null && rxFpsDisplay >= 10 && uiFpsDisplay != null && uiFpsDisplay < rxFpsDisplay * 0.45) {
    diagHints.push("RX（Parsed）FPS 高但 UI FPS 低：仅为 Debug 显示降频，不影响接收。")
  }
  if (
    driveRigEnabled &&
    rxFpsDisplay != null &&
    rxFpsDisplay >= 10 &&
    driveFpsDisplay != null &&
    driveFpsDisplay < rxFpsDisplay * 0.45
  ) {
    diagHints.push("RX FPS 高但 Drive FPS 低：多为 Drive Rig / React 面控更新瓶颈。")
  }
  if (
    realtimePreviewActive &&
    driveRigEnabled &&
    driveFpsDisplay != null &&
    driveFpsDisplay >= 6 &&
    servoFpsDisplay != null &&
    servoFpsDisplay > 0 &&
    servoFpsDisplay < driveFpsDisplay * 0.45
  ) {
    diagHints.push("Drive FPS 高但 Servo FPS 低：多为 WebSerial / 串口下发瓶颈。")
  }

  return (
    <div
      className={`sdk-face-tracking-panel${compactLayout ? " sdk-face-tracking-panel--compact" : ""}`}
      aria-label="面部追踪输入"
    >
      {compactLayout ? (
        <div className="sdk-face-tracking-panel-row sdk-face-tracking-panel-meta-row">
          <label className="sdk-face-tracking-toggle">
            <input
              type="checkbox"
              checked={trackingEnabled}
              onChange={(e) => onTrackingEnabledChange(e.target.checked)}
            />
            Tracking
          </label>
          <label className="sdk-face-tracking-toggle">
            <input
              type="checkbox"
              checked={driveRigEnabled}
              onChange={(e) => onDriveRigEnabledChange(e.target.checked)}
            />
            Drive Rig
          </label>
          <label className="sdk-face-tracking-ws-url-label sdk-face-tracking-ws-url-label--grow">
            <span className="sdk-face-tracking-ws-url-title">WS URL</span>
            <input
              type="text"
              className="sdk-face-tracking-ws-url-input"
              value={trackingWsUrl}
              spellCheck={false}
              onChange={(e) => onTrackingWsUrlChange(e.target.value)}
              placeholder="ws://127.0.0.1:8766/tracking"
            />
          </label>
        </div>
      ) : (
        <>
          <div className="sdk-face-tracking-panel-row sdk-face-tracking-panel-controls">
            <label className="sdk-face-tracking-toggle">
              <input
                type="checkbox"
                checked={trackingEnabled}
                onChange={(e) => onTrackingEnabledChange(e.target.checked)}
              />
              Tracking
            </label>
            <label className="sdk-face-tracking-toggle">
              <input
                type="checkbox"
                checked={driveRigEnabled}
                onChange={(e) => onDriveRigEnabledChange(e.target.checked)}
              />
              Drive Rig
            </label>
          </div>

          <div className="sdk-face-tracking-panel-row sdk-face-tracking-ws-row">
            <label className="sdk-face-tracking-ws-url-label">
              <span className="sdk-face-tracking-ws-url-title">WS URL</span>
              <input
                type="text"
                className="sdk-face-tracking-ws-url-input"
                value={trackingWsUrl}
                spellCheck={false}
                onChange={(e) => onTrackingWsUrlChange(e.target.value)}
                placeholder="ws://127.0.0.1:8766/tracking"
              />
            </label>
          </div>
        </>
      )}

      <div className="sdk-face-tracking-panel-row sdk-face-tracking-buttons-row">
        <div className="sdk-face-tracking-buttons">
          <button
            type="button"
            className="btn-secondary btn-tiny"
            onClick={() => {
              adapter.start?.()
              onTrackingEnabledChange(true)
            }}
          >
            启动追踪
          </button>
          <button
            type="button"
            className="btn-secondary btn-tiny"
            onClick={() => {
              adapter.stop?.()
              onTrackingEnabledChange(false)
            }}
          >
            停止追踪
          </button>
          {onReplaceWithWebSocketAdapter ? (
            <button type="button" className="btn-secondary btn-tiny" onClick={() => onReplaceWithWebSocketAdapter()}>
              应用 WebSocket
            </button>
          ) : null}
          <button
            type="button"
            className="btn-secondary btn-tiny"
            onClick={() => {
              adapter.stop?.()
              adapter.clearState?.()
              onTrackingClear?.()
              onTrackingEnabledChange(false)
            }}
          >
            清空追踪状态
          </button>
          {onResetTrackingState ? (
            <button
              type="button"
              className="btn-secondary btn-tiny"
              title="用于清空平滑残留，建议每次记录新动作前点击一次。"
              onClick={() => onResetTrackingState()}
            >
              重置追踪状态
            </button>
          ) : null}
        </div>
      </div>

      {lowLatencyHint ? <p className="hint sdk-face-tracking-latency-hint">{lowLatencyHint}</p> : null}

      {onResetTrackingState && showResetStateHint ? (
        <p className="hint sdk-face-tracking-reset-state-hint">
          「重置追踪状态」用于清空平滑残留，建议每次记录新动作前点击一次。
        </p>
      ) : null}

      {showAdapterStatusRow ? (
      <div className="sdk-face-tracking-panel-row sdk-face-tracking-panel-stats" aria-live="polite">
        <span title="数据源">source: {String(status.source)}</span>
        <span title="正在运行">running: {status.running ? "yes" : "no"}</span>
        <span title="检测到面部">face: {status.faceDetected ? "yes" : "no"}</span>
        <span title="WebSocket 已解析 tracking.rigFrame 的速率（与 RX 同口径）">
          parsed: {Number.isFinite(status.parsedFrameFps) ? status.parsedFrameFps : Number.isFinite(status.fps) ? status.fps : 0}
        </span>
        <span title="置信度">
          quality: {typeof status.quality === "number" ? status.quality.toFixed(2) : "0"}
        </span>
        <span title={status.error ?? ""}>{status.error ? `error: ${status.error}` : "error: —"}</span>
        <span className="sdk-face-tracking-panel-updated">last: {lastAtText}</span>
      </div>
      ) : null}

      <div
        className="sdk-face-tracking-panel-row sdk-face-tracking-panel-fps-layers"
        aria-label="Tracking FPS 分层"
      >
        <span title="Python debug.performance.fps（loop）">Python: {fmtDashFps(pythonFpsDisplay)}</span>
        <span title="服务端实际 broadcast 帧率（debug.performance.broadcastFps，滞后约一帧）">
          Broadcast: {fmtDashFps(broadcastFpsDisplay)}
        </span>
        <span title="WebSocket onmessage 频率">RawWS: {fmtDashFps(rawWsFpsDisplay)}</span>
        <span title="JSON.parse 后有效 rigFrame">Parsed: {fmtDashFps(parsedFpsDisplay)}</span>
        <span title="onFrame 回调完成频率">Callback: {fmtDashFps(callbackFpsDisplay)}</span>
        <span title="与 Parsed 同口径（兼容旧字段）">RX: {fmtDashFps(rxFpsDisplay)}</span>
        <span title="Drive Rig 开启时 rig 更新速率">Drive: {fmtDashFps(driveFpsDisplay)}</span>
        <span title="实时预览开启时 WebSerial 成功下发次数">Servo: {fmtDashFps(servoFpsDisplay)}</span>
        <span title="Debug 面板刷新（宿主降频）">UI: {fmtDashFps(uiFpsDisplay)}</span>
      </div>

      <div
        className="sdk-face-tracking-panel-row sdk-face-tracking-panel-rx-metrics"
        aria-label="WebSocket 接收链路指标"
      >
        <span title="滑窗平均 / 上一帧 event.data 长度">Payload: {fmtPayloadLine()}</span>
        <span title="上一帧 JSON.parse">Parse: {fmtMsDash(status.lastParseMs)}</span>
        <span title="上一帧 normalizeRigFrameMessage">Normalize: {fmtMsDash(status.lastNormalizeMs)}</span>
        <span title="上一帧 listeners 回调总耗时">CallbackCost: {fmtMsDash(status.lastCallbackMs)}</span>
        <span title="Date.now() − serverSentAtMs">Delay: {fmtDelayDash(status.estimatedNetworkDelayMs)}</span>
        <span title="服务端 frameSeq">seq: {status.lastFrameSeq != null ? String(status.lastFrameSeq) : "-"}</span>
        <span title="frameSeq 跳号累计">skip: {status.skippedFrameCount > 0 ? String(status.skippedFrameCount) : "-"}</span>
      </div>

      {diagHints.length > 0 ? (
        <ul className="sdk-face-tracking-fps-diag-hints hint">
          {diagHints.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      ) : null}

      {showMediaPipeDebug ? (
      <details className="sdk-face-tracking-debug">
        <summary className="sdk-face-tracking-debug-summary">MediaPipe Debug</summary>
        {!hasDebug ? (
          <p className="sdk-face-tracking-debug-empty hint">暂无 debug 数据</p>
        ) : (
          <div className="sdk-face-tracking-debug-grid">
            {hasBlend ? (
              <div className="sdk-face-tracking-debug-col">
                <div className="sdk-face-tracking-debug-title">blendshapes</div>
                <div className="sdk-face-tracking-debug-subtitle">Eye</div>
                <ul className="sdk-face-tracking-debug-list">
                  <li>eyeBlinkLeft: {fmt2(blend.eyeBlinkLeft)}</li>
                  <li>eyeBlinkRight: {fmt2(blend.eyeBlinkRight)}</li>
                  <li>eyeWideLeft: {fmt2(blend.eyeWideLeft)}</li>
                  <li>eyeWideRight: {fmt2(blend.eyeWideRight)}</li>
                </ul>
                <div className="sdk-face-tracking-debug-subtitle">Jaw / Smile</div>
                <ul className="sdk-face-tracking-debug-list">
                  <li>jawOpen: {fmt2(blend.jawOpen)}</li>
                  <li>mouthSmileLeft: {fmt2(blend.mouthSmileLeft)}</li>
                  <li>mouthSmileRight: {fmt2(blend.mouthSmileRight)}</li>
                </ul>
                <div className="sdk-face-tracking-debug-subtitle">Brow</div>
                <ul className="sdk-face-tracking-debug-list">
                  <li>browInnerUp: {fmt2(blend.browInnerUp)}</li>
                  <li>browOuterUpLeft: {fmt2(blend.browOuterUpLeft)}</li>
                  <li>browOuterUpRight: {fmt2(blend.browOuterUpRight)}</li>
                </ul>
                <div className="sdk-face-tracking-debug-subtitle">Lip</div>
                <ul className="sdk-face-tracking-debug-list">
                  <li>mouthUpperUpLeft: {fmt2(blend.mouthUpperUpLeft)}</li>
                  <li>mouthUpperUpRight: {fmt2(blend.mouthUpperUpRight)}</li>
                  <li>mouthLowerDownLeft: {fmt2(blend.mouthLowerDownLeft)}</li>
                  <li>mouthLowerDownRight: {fmt2(blend.mouthLowerDownRight)}</li>
                  <li>mouthPucker: {fmt2(blend.mouthPucker)}</li>
                  <li>mouthFunnel: {fmt2(blend.mouthFunnel)}</li>
                </ul>
              </div>
            ) : null}
            {hasMap ? (
              <div className="sdk-face-tracking-debug-col">
                <div className="sdk-face-tracking-debug-title">mapping</div>
                <div className="sdk-face-tracking-debug-subtitle">Eye</div>
                <ul className="sdk-face-tracking-debug-list">
                  <li>blinkLeft: {fmt2(mapv.blinkLeft)}</li>
                  <li>blinkRight: {fmt2(mapv.blinkRight)}</li>
                  <li>eyeOpenBiasLeft: {fmt2(mapv.eyeOpenBiasLeft)}</li>
                  <li>eyeOpenBiasRight: {fmt2(mapv.eyeOpenBiasRight)}</li>
                  <li>eyeLUp: {fmt2(mapv.eyeLUp)}</li>
                  <li>eyeLLo: {fmt2(mapv.eyeLLo)}</li>
                  <li>eyeRUp: {fmt2(mapv.eyeRUp)}</li>
                  <li>eyeRLo: {fmt2(mapv.eyeRLo)}</li>
                </ul>
                <div className="sdk-face-tracking-debug-subtitle">Jaw / Smile</div>
                <ul className="sdk-face-tracking-debug-list">
                  <li>jaw: {fmt2(mapv.jaw)}</li>
                  <li>smileLeft: {fmt2(mapv.smileLeft)}</li>
                  <li>smileRight: {fmt2(mapv.smileRight)}</li>
                </ul>
                <div className="sdk-face-tracking-debug-subtitle">Brow</div>
                <ul className="sdk-face-tracking-debug-list">
                  <li>browInner: {fmt2(mapv.browInner)}</li>
                  <li>browOuterLeft: {fmt2(mapv.browOuterLeft)}</li>
                  <li>browOuterRight: {fmt2(mapv.browOuterRight)}</li>
                  <li>browLeftTip: {fmt2(mapv.browLeftTip)}</li>
                  <li>browLeftMid: {fmt2(mapv.browLeftMid)}</li>
                  <li>browLeftTail: {fmt2(mapv.browLeftTail)}</li>
                  <li>browRightTip: {fmt2(mapv.browRightTip)}</li>
                  <li>browRightMid: {fmt2(mapv.browRightMid)}</li>
                  <li>browRightTail: {fmt2(mapv.browRightTail)}</li>
                  <li>browLeft: {fmt2(mapv.browLeft)}</li>
                  <li>browRight: {fmt2(mapv.browRight)}</li>
                </ul>
                <div className="sdk-face-tracking-debug-subtitle">Lip</div>
                <ul className="sdk-face-tracking-debug-list">
                  <li>upperLipLeft: {fmt2(mapv.upperLipLeft)}</li>
                  <li>upperLipRight: {fmt2(mapv.upperLipRight)}</li>
                  <li>lowerLipLeft: {fmt2(mapv.lowerLipLeft)}</li>
                  <li>lowerLipRight: {fmt2(mapv.lowerLipRight)}</li>
                  <li>mouthPucker: {fmt2(mapv.mouthPucker)}</li>
                  <li>mouthFunnel: {fmt2(mapv.mouthFunnel)}</li>
                </ul>
                <div className="sdk-face-tracking-debug-subtitle">Gaze → rig</div>
                <ul className="sdk-face-tracking-debug-list">
                  {Number.isFinite(Number(mapv.sharedRadarX)) ? (
                    <li>sharedRadarX: {fmt2(mapv.sharedRadarX)}</li>
                  ) : null}
                  {Number.isFinite(Number(mapv.sharedRadarY)) ? (
                    <li>sharedRadarY: {fmt2(mapv.sharedRadarY)}</li>
                  ) : null}
                </ul>
              </div>
            ) : (
              <div className="sdk-face-tracking-debug-col">
                <div className="sdk-face-tracking-debug-title">mapping</div>
                <p className="sdk-face-tracking-debug-empty hint">暂无数据</p>
              </div>
            )}
            <div className="sdk-face-tracking-debug-col">
              <div className="sdk-face-tracking-debug-title">gaze</div>
              {hasGazeInfo && gaze ? (
                <>
                  <ul className="sdk-face-tracking-debug-list">
                    <li>available: {gaze.available ? "true" : "false"}</li>
                    <li>stable: {gaze.stable != null ? (gaze.stable ? "true" : "false") : "—"}</li>
                    <li>irisReliable: {gaze.irisReliable != null ? (gaze.irisReliable ? "true" : "false") : "—"}</li>
                    <li>frozenByBlink: {gaze.frozenByBlink ? "true" : "false"}</li>
                    <li>heldLastValid: {gaze.heldLastValid ? "true" : "false"}</li>
                    <li>limitedByMaxStep: {gaze.limitedByMaxStep ? "true" : "false"}</li>
                    <li>freezeReason: {gaze.freezeReason != null && gaze.freezeReason !== "" ? String(gaze.freezeReason) : "—"}</li>
                    <li>candidateSharedRadarX: {fmtGazeOpt(gaze.candidateSharedRadarX)}</li>
                    <li>candidateSharedRadarY: {fmtGazeOpt(gaze.candidateSharedRadarY)}</li>
                    <li>emittedSharedRadarX: {fmt2(gaze.emittedSharedRadarX)}</li>
                    <li>emittedSharedRadarY: {fmt2(gaze.emittedSharedRadarY)}</li>
                    <li>lastValidSharedRadarX: {fmtGazeOpt(gaze.lastValidSharedRadarX)}</li>
                    <li>lastValidSharedRadarY: {fmtGazeOpt(gaze.lastValidSharedRadarY)}</li>
                    <li>leftEyeHalfWidth: {fmtGazeOpt(gaze.leftEyeHalfWidth)}</li>
                    <li>leftEyeHalfHeight: {fmtGazeOpt(gaze.leftEyeHalfHeight)}</li>
                    <li>rightEyeHalfWidth: {fmtGazeOpt(gaze.rightEyeHalfWidth)}</li>
                    <li>rightEyeHalfHeight: {fmtGazeOpt(gaze.rightEyeHalfHeight)}</li>
                    <li>eyeBlinkLeftRaw: {fmt2(gaze.eyeBlinkLeftRaw)}</li>
                    <li>eyeBlinkRightRaw: {fmt2(gaze.eyeBlinkRightRaw)}</li>
                    <li>blinkLeftMapping: {fmt2(gaze.blinkLeftMapping)}</li>
                    <li>blinkRightMapping: {fmt2(gaze.blinkRightMapping)}</li>
                    <li>eyeLookX: {fmt2(gaze.eyeLookX)}</li>
                    <li>eyeLookY: {fmt2(gaze.eyeLookY)}</li>
                    <li>sharedRadarX: {fmt2(gaze.sharedRadarX)}</li>
                    <li>sharedRadarY: {fmt2(gaze.sharedRadarY)}</li>
                    <li>leftEyeX: {fmt2(gaze.leftEyeX)}</li>
                    <li>leftEyeY: {fmt2(gaze.leftEyeY)}</li>
                    <li>rightEyeX: {fmt2(gaze.rightEyeX)}</li>
                    <li>rightEyeY: {fmt2(gaze.rightEyeY)}</li>
                  </ul>
                  {hasMap ? (
                    <ul className="sdk-face-tracking-debug-list sdk-face-tracking-debug-gaze-mapping">
                      <li>mapping.sharedRadarX: {fmt2(mapv.sharedRadarX)}</li>
                      <li>mapping.sharedRadarY: {fmt2(mapv.sharedRadarY)}</li>
                    </ul>
                  ) : null}
                </>
              ) : (
                <p className="sdk-face-tracking-debug-empty hint">暂无 gaze 数据</p>
              )}
            </div>
            {hasPerf ? (
              <div className="sdk-face-tracking-debug-col">
                <div className="sdk-face-tracking-debug-title">performance</div>
                <ul className="sdk-face-tracking-debug-list">
                  <li>fps: {fmtPerf(perf.fps)}</li>
                  <li>generatedFrameFps: {fmtPerf(perf.generatedFrameFps)}</li>
                  <li>broadcastSuccessFps: {fmtPerf(perf.broadcastSuccessFps)}</li>
                  <li>broadcastAttemptFps: {fmtPerf(perf.broadcastAttemptFps)}</li>
                  <li>jsonEncodeFps: {fmtPerf(perf.jsonEncodeFps)}</li>
                  <li>captureFps: {fmtPerf(perf.captureFps)}</li>
                  <li>inferenceFps: {fmtPerf(perf.inferenceFps)}</li>
                  <li>mappingFps: {fmtPerf(perf.mappingFps)}</li>
                  <li>perClientSendFps: {fmtPerf(perf.perClientSendFps)}</li>
                  <li>clientCount: {perf.clientCount != null ? String(perf.clientCount) : "—"}</li>
                  <li>broadcastFps: {fmtPerf(perf.broadcastFps)}</li>
                  <li>broadcastFrameSeq: {perf.broadcastFrameSeq != null ? String(perf.broadcastFrameSeq) : "—"}</li>
                  <li>capReadMs: {fmtPerf(perf.capReadMs)}</li>
                  <li>preprocessMs: {fmtPerf(perf.preprocessMs)}</li>
                  <li>captureMs（读+预处理）: {fmtPerf(perf.captureMs)}</li>
                  <li>sleepMs: {fmtPerf(perf.sleepMs)}</li>
                  <li>totalPeriodMs: {fmtPerf(perf.totalPeriodMs)}</li>
                  <li>targetIntervalMs: {fmtPerf(perf.targetIntervalMs)}</li>
                  <li>encodeMs: {fmtPerf(perf.encodeMs)}</li>
                  <li>inferenceMs: {fmtPerf(perf.inferenceMs)}</li>
                  <li>mappingMs: {fmtPerf(perf.mappingMs)}</li>
                  <li>broadcastMs: {fmtPerf(perf.broadcastMs)}</li>
                  <li>loopMs: {fmtPerf(perf.loopMs)}</li>
                </ul>
                <p className="hint sdk-face-tracking-perf-note">
                  transport 类 FPS（broadcastSuccessFps、jsonEncodeFps 等）与 jsonEncodeMs / broadcastMs / loopMs
                  为上一泵周期测得；generatedFrameFps 与 fps 为当前帧生成滑窗。
                </p>
              </div>
            ) : (
              <div className="sdk-face-tracking-debug-col">
                <div className="sdk-face-tracking-debug-title">performance</div>
                <p className="sdk-face-tracking-debug-empty hint">暂无性能数据</p>
              </div>
            )}
          </div>
        )}
      </details>
      ) : null}
    </div>
  )
}
