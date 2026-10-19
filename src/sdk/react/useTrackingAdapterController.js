import { useCallback, useEffect, useRef, useState } from "react"
import { createWebSocketTrackingAdapter } from "../tracking/index.js"
import {
  createBrowserTrackingAdapter,
  persistTrackingBackend,
  resolveTrackingBackend,
  TRACKING_BACKEND_BROWSER,
  TRACKING_BACKEND_PYTHON,
} from "../tracking/browser/index.js"
import {
  logMappedFrame,
  logWsReceivedFrame,
  noteWireTrackingFrame,
} from "../trackingPreview/videoDiagnosticExportDebug.js"
import { coerceToRigFrame, normalizeRigFrameMessage } from "../tracking/trackingMapper.js"
import { processTrackingRigFrame } from "../tracking/processTrackingFrame.js"
import { TRACKING_FRAME_TYPE } from "../tracking/trackingTypes.js"

const DEFAULT_WS = "ws://127.0.0.1:8766/tracking"

function fallbackStatus() {
  return {
    running: false,
    source: "none",
    faceDetected: false,
    fps: 0,
    rxFps: 0,
    pythonFps: /** @type {number | null} */ (null),
    rawWsFps: 0,
    parsedFrameFps: 0,
    callbackFps: 0,
    receivedMessageCount: 0,
    receivedFrameCount: 0,
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
    lastFrameReceivedAt: 0,
    uiDebugFps: /** @type {number | null} */ (null),
    quality: 0,
    lastFrameAt: 0,
    error: null,
    modelErrorCode: null,
    modelErrorName: null,
    modelErrorMessage: null,
    modelErrorStack: null,
    wsOpen: false,
    wsConnecting: false,
  }
}

/** @param {Record<string, unknown> | null | undefined} s */
export function pickExtendedAdapterFields(s) {
  if (!s || typeof s !== "object") {
    return {}
  }
  const num = (k, d = 0) => {
    const v = s[k]
    return Number.isFinite(Number(v)) ? Number(v) : d
  }
  const numOrNull = (k) => {
    const v = s[k]
    return v != null && Number.isFinite(Number(v)) ? Number(v) : null
  }
  return {
    rawWsFps: num("rawWsFps", 0),
    parsedFrameFps: num("parsedFrameFps", 0),
    callbackFps: num("callbackFps", 0),
    receivedMessageCount: num("receivedMessageCount", 0),
    receivedFrameCount: num("receivedFrameCount", 0),
    parsedFrameCount: num("parsedFrameCount", 0),
    callbackFrameCount: num("callbackFrameCount", 0),
    lastFrameSeq: numOrNull("lastFrameSeq"),
    skippedFrameCount: num("skippedFrameCount", 0),
    lastParseMs: numOrNull("lastParseMs"),
    lastNormalizeMs: numOrNull("lastNormalizeMs"),
    lastCallbackMs: numOrNull("lastCallbackMs"),
    avgPayloadBytes: num("avgPayloadBytes", 0),
    lastPayloadBytes: numOrNull("lastPayloadBytes"),
    lastClientReceiveAtMs: numOrNull("lastClientReceiveAtMs"),
    lastServerSentAtMs: numOrNull("lastServerSentAtMs"),
    estimatedNetworkDelayMs: numOrNull("estimatedNetworkDelayMs"),
  }
}

function wireReconnect(adapter, trackingEnabledRef, reconnectTimerRef) {
  adapter?.setOnAbnormalClose?.(() => {
    if (!trackingEnabledRef.current) {
      return
    }
    if (reconnectTimerRef.current != null) {
      return
    }
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null
      if (!trackingEnabledRef.current) {
        return
      }
      try {
        adapter?.start?.()
      } catch {
        //
      }
    }, 500)
  })
}

/**
 * 管理 TrackingAdapter（Python WebSocket 或 Browser MediaPipe）、lastFrame 与轮询状态。
 * 任意时刻只允许一个 Active Provider。
 */
export function useTrackingAdapterController(options = {}) {
  const defaultWsUrl = typeof options.defaultWsUrl === "string" ? options.defaultWsUrl : DEFAULT_WS
  const initialBackend = resolveTrackingBackend({ backend: options.backend })

  const adapterRef = useRef(null)
  const connectedUrlRef = useRef(defaultWsUrl)
  const trackingEnabledRef = useRef(false)
  const reconnectTimerRef = useRef(/** @type {number | null} */ (null))
  const backendRef = useRef(initialBackend)

  const [trackingEnabled, setTrackingEnabled] = useState(false)
  const [wsUrlDraft, setWsUrlDraft] = useState(defaultWsUrl)
  const [adapterEpoch, setAdapterEpoch] = useState(0)
  const [trackingBackend, setTrackingBackendState] = useState(initialBackend)
  const [browserMetrics, setBrowserMetrics] = useState(/** @type {object | null} */ (null))
  const [lastFrame, setLastFrame] = useState(
    /** @type {import("../tracking/trackingTypes.js").RigFrame | null} */ (null)
  )
  const [status, setStatus] = useState(fallbackStatus)

  const uiFrameCountRef = useRef(0)
  const uiFpsWindowStartRef = useRef(
    typeof performance !== "undefined" ? performance.now() : Date.now()
  )
  const lastComputedUiFpsRef = useRef(/** @type {number | null} */ (null))

  function createAdapterForBackend(backend, wsUrl) {
    if (backend === TRACKING_BACKEND_BROWSER) {
      return createBrowserTrackingAdapter()
    }
    return createWebSocketTrackingAdapter({ url: wsUrl || defaultWsUrl })
  }

  if (!adapterRef.current) {
    adapterRef.current = createAdapterForBackend(initialBackend, defaultWsUrl)
    connectedUrlRef.current = defaultWsUrl
    backendRef.current = initialBackend
    if (initialBackend === TRACKING_BACKEND_PYTHON) {
      wireReconnect(adapterRef.current, trackingEnabledRef, reconnectTimerRef)
    }
  }

  useEffect(() => {
    trackingEnabledRef.current = trackingEnabled
    if (!trackingEnabled && reconnectTimerRef.current != null) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
  }, [trackingEnabled])

  const handleFrame = useCallback((frame) => {
    uiFrameCountRef.current += 1
    const normalized =
      frame?.type === TRACKING_FRAME_TYPE
        ? processTrackingRigFrame(frame)
        : processTrackingRigFrame(normalizeRigFrameMessage(frame) ?? coerceToRigFrame(frame)) ?? null
    if (normalized && typeof normalized === "object") {
      noteWireTrackingFrame(normalized)
      logWsReceivedFrame(normalized)
      logMappedFrame(normalized)
      setLastFrame(normalized)
    } else {
      setLastFrame(null)
    }
  }, [])

  useEffect(() => {
    if (!trackingEnabled) {
      uiFrameCountRef.current = 0
      lastComputedUiFpsRef.current = null
      uiFpsWindowStartRef.current =
        typeof performance !== "undefined" ? performance.now() : Date.now()
    }
  }, [trackingEnabled])

  useEffect(() => {
    const id = window.setInterval(() => {
      try {
        const now =
          typeof performance !== "undefined" ? performance.now() : Date.now()
        if (trackingEnabled) {
          const dtMs = now - uiFpsWindowStartRef.current
          if (dtMs >= 500 && dtMs > 0) {
            lastComputedUiFpsRef.current = Math.round((uiFrameCountRef.current / dtMs) * 1000)
            uiFrameCountRef.current = 0
            uiFpsWindowStartRef.current = now
          }
        } else {
          lastComputedUiFpsRef.current = null
        }

        const s = adapterRef.current?.getStatus?.()
        const isBrowser = backendRef.current === TRACKING_BACKEND_BROWSER
        const wsOpen = isBrowser ? Boolean(s?.running) : Boolean(s?.wsOpen ?? s?.running)
        const wsConnecting = isBrowser ? false : Boolean(s?.wsConnecting)
        if (isBrowser && typeof adapterRef.current?.getMetrics === "function") {
          try {
            setBrowserMetrics(adapterRef.current.getMetrics())
          } catch {
            //
          }
        }
        setStatus(
          s && typeof s === "object"
            ? {
                running: wsOpen || wsConnecting,
                source: typeof s.source === "string" ? s.source : "none",
                faceDetected: Boolean(s.faceDetected),
                fps: Number.isFinite(Number(s.fps)) ? Number(s.fps) : 0,
                rxFps: Number.isFinite(Number(s.rxFps))
                  ? Number(s.rxFps)
                  : Number.isFinite(Number(s.fps))
                    ? Number(s.fps)
                    : 0,
                pythonFps:
                  s.pythonFps != null && Number.isFinite(Number(s.pythonFps))
                    ? Number(s.pythonFps)
                    : null,
                receivedFrameCount: Number.isFinite(Number(s.receivedFrameCount))
                  ? Number(s.receivedFrameCount)
                  : 0,
                lastFrameReceivedAt: Number.isFinite(Number(s.lastFrameReceivedAt))
                  ? Number(s.lastFrameReceivedAt)
                  : 0,
                uiDebugFps: trackingEnabled ? lastComputedUiFpsRef.current : null,
                quality: Number.isFinite(Number(s.quality)) ? Number(s.quality) : 0,
                lastFrameAt: Number.isFinite(Number(s.lastFrameAt)) ? Number(s.lastFrameAt) : 0,
                error: s.error != null ? String(s.error) : null,
                modelErrorCode: s.modelErrorCode != null ? String(s.modelErrorCode) : null,
                modelErrorName: s.modelErrorName != null ? String(s.modelErrorName) : null,
                modelErrorMessage:
                  s.modelErrorMessage != null ? String(s.modelErrorMessage) : null,
                modelErrorStack: s.modelErrorStack != null ? String(s.modelErrorStack) : null,
                wsOpen,
                wsConnecting,
                lifecycle: s.lifecycle != null ? String(s.lifecycle) : null,
                trackingBackend: backendRef.current,
                ...pickExtendedAdapterFields(s),
              }
            : fallbackStatus()
        )
      } catch {
        setStatus(fallbackStatus())
      }
    }, 120)
    return () => window.clearInterval(id)
  }, [adapterEpoch, trackingEnabled])

  useEffect(() => {
    const adapter = adapterRef.current
    if (!adapter || !trackingEnabled) {
      try {
        adapter?.stop?.()
      } catch {
        //
      }
      return undefined
    }

    adapter.onFrame?.(handleFrame)
    adapter.start?.()

    return () => {
      adapter.offFrame?.(handleFrame)
      try {
        adapter.stop?.()
      } catch {
        //
      }
    }
  }, [trackingEnabled, adapterEpoch, handleFrame])

  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current != null) {
        window.clearTimeout(reconnectTimerRef.current)
      }
      const a = adapterRef.current
      if (a) {
        try {
          a.stop?.()
          a.dispose?.()
        } catch {
          //
        }
      }
      adapterRef.current = null
    }
  }, [])

  const replaceWithWebSocket = useCallback(() => {
    if (backendRef.current !== TRACKING_BACKEND_PYTHON) {
      return
    }
    const url = String(wsUrlDraft ?? "").trim() || defaultWsUrl
    if (adapterRef.current?.getUrl?.() === url && adapterRef.current) {
      return
    }
    adapterRef.current?.stop?.()
    adapterRef.current?.dispose?.()
    adapterRef.current = createWebSocketTrackingAdapter({ url })
    connectedUrlRef.current = url
    wireReconnect(adapterRef.current, trackingEnabledRef, reconnectTimerRef)
    setAdapterEpoch((n) => n + 1)
  }, [wsUrlDraft, defaultWsUrl])

  const switchTrackingBackend = useCallback(
    async (nextBackend) => {
      const next = nextBackend === TRACKING_BACKEND_BROWSER ? TRACKING_BACKEND_BROWSER : TRACKING_BACKEND_PYTHON
      if (next === backendRef.current && adapterRef.current) {
        return next
      }
      setTrackingEnabled(false)
      trackingEnabledRef.current = false
      if (reconnectTimerRef.current != null) {
        window.clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      try {
        adapterRef.current?.stop?.()
        adapterRef.current?.stopLocalStream?.()
        adapterRef.current?.dispose?.()
      } catch {
        //
      }
      const url = String(wsUrlDraft ?? "").trim() || defaultWsUrl
      adapterRef.current = createAdapterForBackend(next, url)
      connectedUrlRef.current = url
      backendRef.current = next
      persistTrackingBackend(next)
      setTrackingBackendState(next)
      setLastFrame(null)
      setBrowserMetrics(null)
      if (next === TRACKING_BACKEND_PYTHON) {
        wireReconnect(adapterRef.current, trackingEnabledRef, reconnectTimerRef)
      }
      setAdapterEpoch((n) => n + 1)
      return next
    },
    [wsUrlDraft, defaultWsUrl]
  )

  const clearLastFrame = useCallback(() => {
    setLastFrame(null)
    try {
      adapterRef.current?.clearState?.()
    } catch {
      //
    }
  }, [])

  const sendTrackingControl = useCallback((payload) => {
    try {
      return Boolean(adapterRef.current?.sendControl?.(payload))
    } catch {
      return false
    }
  }, [])

  const setFrameValidator = useCallback((validator) => {
    adapterRef.current?.setFrameValidator?.(validator)
  }, [])

  const setOnSourceChanged = useCallback((handler) => {
    adapterRef.current?.setOnSourceChanged?.(handler)
  }, [])

  const bindBrowserVideoElement = useCallback((el) => {
    adapterRef.current?.setVideoElement?.(el)
  }, [])

  const startBrowserCamera = useCallback(async (constraints) => {
    if (backendRef.current !== TRACKING_BACKEND_BROWSER) {
      throw new Error("startBrowserCamera requires trackingBackend=browser")
    }
    return adapterRef.current?.attachLocalStream?.(constraints)
  }, [])

  const stopBrowserCamera = useCallback(() => {
    if (backendRef.current !== TRACKING_BACKEND_BROWSER) {
      return
    }
    try {
      adapterRef.current?.stop?.()
      adapterRef.current?.stopLocalStream?.()
      adapterRef.current?.bumpSourceGeneration?.("stopBrowserCamera")
      adapterRef.current?.clearState?.()
    } catch {
      //
    }
  }, [])

  return {
    defaultWsUrl,
    adapterRef,
    trackingEnabled,
    setTrackingEnabled,
    wsUrlDraft,
    setWsUrlDraft,
    lastFrame,
    status,
    replaceWithWebSocket,
    clearLastFrame,
    sendTrackingControl,
    setFrameValidator,
    setOnSourceChanged,
    connectedUrl: connectedUrlRef.current,
    trackingBackend,
    switchTrackingBackend,
    browserMetrics,
    bindBrowserVideoElement,
    startBrowserCamera,
    stopBrowserCamera,
  }
}
