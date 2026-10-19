import { normalizeRigFrameMessage } from "./trackingMapper.js"
import { processTrackingRigFrame } from "./processTrackingFrame.js"
import { TRACKING_FRAME_TYPE } from "./trackingTypes.js"
import {
  noteWireTrackingFrame,
  registerWireTrackingDebugFromPayload,
} from "../trackingPreview/videoDiagnosticExportDebug.js"

/**
 * @param {string | { url: string }} urlOrOptions
 * @returns {import("./trackingTypes.js").TrackingAdapter}
 */
function resolveWsUrl(urlOrOptions) {
  if (typeof urlOrOptions === "string") {
    return urlOrOptions
  }
  if (urlOrOptions && typeof urlOrOptions === "object" && typeof urlOrOptions.url === "string") {
    return urlOrOptions.url
  }
  return ""
}

function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now()
}

function epochMs() {
  return typeof performance !== "undefined" ? Date.now() : Date.now()
}

/**
 * 接收 JSON RigFrame 的 WebSocket 适配器；RX 分层统计在 getStatus() 读取，不触发 React。
 * @param {string | { url: string }} urlOrOptions  — URL 字符串或 `{ url }`（与阶段 2.1 一致）
 */
export function createWebSocketTrackingAdapter(urlOrOptions) {
  const url = resolveWsUrl(urlOrOptions)
  /** @type {Set<(frame: import("./trackingTypes.js").RigFrame) => void>} */
  const listeners = new Set()

  let disposed = false
  /** @type {WebSocket | null} */
  let socket = null

  let running = false
  let intentionalStop = false
  /** @type {(() => void) | null} */
  let onAbnormalClose = null
  let onSourceChanged = null
  /** @type {((frame: import("./trackingTypes.js").RigFrame) => boolean) | null} */
  let frameValidator = null

  let lastFrameAt = 0
  let lastEmittedFaceDetected = false
  let lastEmittedQuality = 0
  /** @type {string | null} */
  let statusError = null
  let lastEmittedSource = "none"

  let rxLastFrameAt = 0
  let receivedFrameCount = 0
  /** @type {number | null} */
  let lastPythonFps = null

  /** --- 500ms 滑窗：Raw / Parsed / Callback FPS --- */
  const WINDOW_MS = 500
  let winStart = nowMs()
  let rawMsgCount = 0
  let parsedFrameCountWindow = 0
  let callbackFrameCountWindow = 0
  let payloadBytesSumWindow = 0
  let payloadBytesNWindow = 0

  let rawWsFpsApprox = 0
  let parsedFrameFpsApprox = 0
  let callbackFpsApprox = 0
  /** 与 parsed 同口径，便于旧字段兼容 */
  let rxFpsApprox = 0
  let avgPayloadBytesApprox = 0

  let receivedMessageCount = 0
  let parsedFrameCountTotal = 0
  let callbackFrameCountTotal = 0

  /** @type {number | null} */
  let lastPayloadBytes = null
  /** @type {number | null} */
  let lastParseMs = null
  /** @type {number | null} */
  let lastNormalizeMs = null
  /** @type {number | null} */
  let lastCallbackMs = null
  /** @type {number | null} */
  let lastClientReceiveAtMs = null
  /** @type {number | null} */
  let lastServerSentAtMs = null
  /** @type {number | null} */
  let estimatedNetworkDelayMs = null

  /** @type {number | null} */
  let lastFrameSeq = null
  let skippedFrameCount = 0

  const rollWindowIfNeeded = (now) => {
    const dt = now - winStart
    if (dt < WINDOW_MS || dt <= 0) {
      return
    }
    rawWsFpsApprox = Math.round((rawMsgCount / dt) * 1000)
    parsedFrameFpsApprox = Math.round((parsedFrameCountWindow / dt) * 1000)
    callbackFpsApprox = Math.round((callbackFrameCountWindow / dt) * 1000)
    rxFpsApprox = parsedFrameFpsApprox
    avgPayloadBytesApprox =
      payloadBytesNWindow > 0 ? Math.round(payloadBytesSumWindow / payloadBytesNWindow) : 0
    rawMsgCount = 0
    parsedFrameCountWindow = 0
    callbackFrameCountWindow = 0
    payloadBytesSumWindow = 0
    payloadBytesNWindow = 0
    winStart = now
  }

  /** @param {string | null} message */
  const setError = (message) => {
    statusError = message
  }

  const touchRxMeta = () => {
    const t = nowMs()
    lastFrameAt = t
    rxLastFrameAt = t
    receivedFrameCount += 1
    rollWindowIfNeeded(t)
  }

  const handleMessage = (/** @type {MessageEvent} */ ev) => {
    const wall = epochMs()
    const tWin = nowMs()
    rawMsgCount += 1
    rollWindowIfNeeded(tWin)

    if (typeof ev.data !== "string") {
      setError("期望 JSON 文本帧")
      return
    }
    const str = ev.data
    lastPayloadBytes = str.length
    payloadBytesSumWindow += str.length
    payloadBytesNWindow += 1
    receivedMessageCount += 1

    const tParse0 = nowMs()
    let data
    try {
      data = JSON.parse(str)
    } catch (e) {
      lastParseMs = nowMs() - tParse0
      setError(e instanceof Error ? e.message : "JSON 解析失败")
      return
    }
    lastParseMs = nowMs() - tParse0

    if (data.type === "tracking.sourceChanged") {
      if (typeof onSourceChanged === "function") {
        try {
          onSourceChanged(data)
        } catch {
          //
        }
      }
      return
    }

    if (data.type !== TRACKING_FRAME_TYPE) {
      return
    }

    registerWireTrackingDebugFromPayload(data)

    const tNorm0 = nowMs()
    const frame = processTrackingRigFrame(normalizeRigFrameMessage(data))
    lastNormalizeMs = nowMs() - tNorm0

    if (!frame) {
      return
    }

    if (typeof frameValidator === "function" && !frameValidator(frame)) {
      return
    }

    noteWireTrackingFrame(frame)
    frame._frontendReceiveTimeMs = nowMs()

    parsedFrameCountWindow += 1
    parsedFrameCountTotal += 1
    rollWindowIfNeeded(nowMs())

    const seq =
      frame.frameSeq != null && Number.isFinite(Number(frame.frameSeq)) ? Number(frame.frameSeq) : null
    if (seq != null) {
      if (lastFrameSeq != null && seq > lastFrameSeq + 1) {
        skippedFrameCount += seq - lastFrameSeq - 1
      }
      lastFrameSeq = seq
    }

    lastClientReceiveAtMs = wall
    if (frame.serverSentAtMs != null && Number.isFinite(Number(frame.serverSentAtMs))) {
      lastServerSentAtMs = Number(frame.serverSentAtMs)
      estimatedNetworkDelayMs = Math.round(wall - lastServerSentAtMs)
    } else {
      lastServerSentAtMs = null
      estimatedNetworkDelayMs = null
    }

    touchRxMeta()

    const pf = frame.debug && typeof frame.debug === "object" && frame.debug.performance
    const genFps = pf && typeof pf === "object" ? pf.generatedFrameFps : null
    const legacyFps = pf && typeof pf === "object" ? pf.fps : null
    const pick =
      typeof genFps === "number" && Number.isFinite(genFps)
        ? genFps
        : typeof legacyFps === "number" && Number.isFinite(legacyFps)
          ? legacyFps
          : null
    lastPythonFps = pick

    lastEmittedFaceDetected = frame.faceDetected
    lastEmittedQuality = frame.quality
    lastEmittedSource = typeof frame.source === "string" ? frame.source : "python-websocket"

    const tCb0 = nowMs()
    for (const cb of listeners) {
      try {
        cb(frame)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    }
    lastCallbackMs = nowMs() - tCb0
    callbackFrameCountWindow += 1
    callbackFrameCountTotal += 1
    rollWindowIfNeeded(nowMs())
  }

  const handleOpen = () => {
    setError(null)
  }

  /** @param {Event} ev */
  const handleError = (ev) => {
    const message =
      ev instanceof ErrorEvent && typeof ev.message === "string" && ev.message
        ? ev.message
        : "WebSocket 错误"
    setError(message)
  }

  /** @param {CloseEvent} ev */
  const handleClose = (ev) => {
    const code = ev && typeof ev.code === "number" ? ev.code : 0
    const reason = ev && typeof ev.reason === "string" ? ev.reason : ""
    running = false
    socket = null

    if (intentionalStop) {
      lastEmittedSource = "none"
      return
    }

    if (code !== 1000 && code !== 1001) {
      const detail = reason ? `${code}: ${reason}` : String(code)
      setError(`WebSocket 已断开 (${detail})`)
    }
    if (typeof onAbnormalClose === "function") {
      try {
        onAbnormalClose()
      } catch {
        //
      }
    }
  }

  const detachSocket = (/** @type {boolean} */ intentional = false) => {
    intentionalStop = intentional
    if (!socket) {
      return
    }
    try {
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        try {
          // 某些浏览器在连接阶段对 close(code, reason) 更严格，改为无参关闭避免 cleanup 抛错。
          socket.close()
        } catch {
          //
        }
      }
    } finally {
      socket = null
      running = false
    }
  }

  const resetMetrics = () => {
    winStart = nowMs()
    rawMsgCount = 0
    parsedFrameCountWindow = 0
    callbackFrameCountWindow = 0
    payloadBytesSumWindow = 0
    payloadBytesNWindow = 0
    rawWsFpsApprox = 0
    parsedFrameFpsApprox = 0
    callbackFpsApprox = 0
    rxFpsApprox = 0
    avgPayloadBytesApprox = 0
    receivedMessageCount = 0
    receivedFrameCount = 0
    parsedFrameCountTotal = 0
    callbackFrameCountTotal = 0
    lastPayloadBytes = null
    lastParseMs = null
    lastNormalizeMs = null
    lastCallbackMs = null
    lastClientReceiveAtMs = null
    lastServerSentAtMs = null
    estimatedNetworkDelayMs = null
    lastFrameSeq = null
    skippedFrameCount = 0
  }

  return {
    start() {
      if (disposed || typeof WebSocket === "undefined") {
        setError(disposed ? "adapter 已释放" : "环境不支持 WebSocket")
        return
      }
      if (!url || typeof url !== "string") {
        setError("WebSocket URL 无效")
        return
      }
      if (running && socket?.readyState === WebSocket.OPEN) {
        return
      }

      detachSocket(false)
      intentionalStop = false
      setError(null)
      running = true
      resetMetrics()
      lastPythonFps = null

      try {
        const ws = new WebSocket(url)
        socket = ws

        ws.onopen = handleOpen
        ws.onmessage = handleMessage
        ws.onerror = handleError
        ws.onclose = handleClose
      } catch (e) {
        running = false
        socket = null
        setError(e instanceof Error ? e.message : String(e))
      }
    },

    stop() {
      try {
        detachSocket(true)
      } catch {
        //
      }
      lastEmittedSource = "none"
    },

    dispose() {
      disposed = true
      try {
        detachSocket(true)
      } catch {
        //
      }
      listeners.clear()
      onAbnormalClose = null
    },

    getUrl() {
      return url
    },

    setOnAbnormalClose(handler) {
      onAbnormalClose = typeof handler === "function" ? handler : null
    },

    setOnSourceChanged(handler) {
      onSourceChanged = typeof handler === "function" ? handler : null
    },

    setFrameValidator(validator) {
      frameValidator = typeof validator === "function" ? validator : null
    },

    isRunning() {
      return !!socket && socket.readyState === WebSocket.OPEN
    },

    onFrame(cb) {
      listeners.add(cb)
    },

    offFrame(cb) {
      listeners.delete(cb)
    },

    clearState() {
      setError(null)
      lastFrameAt = 0
      rxLastFrameAt = 0
      receivedFrameCount = 0
      lastPythonFps = null
      lastEmittedFaceDetected = false
      lastEmittedQuality = 0
      lastEmittedSource = "none"
      resetMetrics()
    },

    /**
     * @param {{ action?: string } & Record<string, unknown>} payload
     * @returns {boolean}
     */
    sendControl(payload) {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return false
      }
      try {
        socket.send(
          JSON.stringify({
            type: "tracking.control",
            ...(payload && typeof payload === "object" ? payload : {}),
          })
        )
        return true
      } catch {
        return false
      }
    },

    getStatus() {
      const ready = socket?.readyState
      const open = ready === WebSocket.OPEN
      const connecting = ready === WebSocket.CONNECTING
      const liveSource =
        open || connecting
          ? lastEmittedSource !== "none"
            ? lastEmittedSource
            : "python-websocket"
          : "none"

      return {
        running: open,
        wsOpen: open,
        wsConnecting: connecting && !open,
        source: liveSource,
        faceDetected: lastEmittedFaceDetected,
        fps: rxFpsApprox,
        rxFps: rxFpsApprox,
        rawWsFps: rawWsFpsApprox,
        parsedFrameFps: parsedFrameFpsApprox,
        callbackFps: callbackFpsApprox,
        pythonFps: lastPythonFps,
        receivedMessageCount,
        receivedFrameCount,
        parsedFrameCount: parsedFrameCountTotal,
        callbackFrameCount: callbackFrameCountTotal,
        lastFrameSeq,
        skippedFrameCount,
        lastParseMs,
        lastNormalizeMs,
        lastCallbackMs,
        avgPayloadBytes: avgPayloadBytesApprox,
        lastPayloadBytes,
        lastClientReceiveAtMs,
        lastServerSentAtMs,
        estimatedNetworkDelayMs,
        lastFrameReceivedAt: rxLastFrameAt,
        quality: lastEmittedQuality,
        lastFrameAt,
        error: statusError,
      }
    },
  }
}
