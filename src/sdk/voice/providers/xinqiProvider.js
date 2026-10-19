/**
 * Xinqi Streaming Voice Provider。
 * 消费标准 20 ms AudioFrame，聚合为 3200 B 后经 FaceDEV Gateway 发送。
 * 输出音频交给 VoiceSession / VoiceOutputRuntime，这里只转发事件和真实 playback ACK。
 */

import { validateAudioFrame } from "../../audio/audioFrame.js"
import { AUDIO_ERROR_CODES } from "../../audio/audioErrors.js"
import {
  VOICE_PROVIDER_EVENTS,
  VOICE_PROVIDER_STATES,
  createEventBus,
} from "../voiceProvider.js"
import { defaultFetch, defaultNow } from "../browserApi.js"
import { createXinqiChunkAggregator } from "./xinqiChunkAggregator.js"
import {
  XINQI_BACKPRESSURE_BYTES,
  XINQI_CHUNK_BYTES,
  XINQI_CHUNK_DURATION_MS,
  XINQI_PROVIDER_ERROR_CODES,
  mapXinqiServerMessage,
} from "./xinqiProtocol.js"

const READY_TIMEOUT_MS = 8000

function defaultSessionUrl() {
  return "/api/voice/xinqi/session"
}

function defaultRealtimeUrl(gatewaySessionId) {
  const proto = globalThis.location?.protocol === "https:" ? "wss:" : "ws:"
  const host = globalThis.location?.host || "localhost"
  return `${proto}//${host}/api/voice/xinqi/realtime?session=${encodeURIComponent(gatewaySessionId)}`
}

export function createXinqiProvider({
  fetchImpl = defaultFetch,
  WebSocketCtor = typeof WebSocket !== "undefined" ? WebSocket : null,
  now = defaultNow,
  sessionUrl = defaultSessionUrl,
  realtimeUrl = defaultRealtimeUrl,
  sessionHeaders = null,
  readyTimeoutMs = READY_TIMEOUT_MS,
  backpressureBytes = XINQI_BACKPRESSURE_BYTES,
} = {}) {
  const bus = createEventBus()
  let state = VOICE_PROVIDER_STATES.IDLE
  let ws = null
  let aggregator = null
  let generation = 0
  let intentionalClose = false
  let ready = false
  let backpressureNotified = false
  let activeTurnId = null
  let upstreamAudioDone = false
  let playbackDoneForTurn = false
  let lastAckSamples = 0
  let connectedAt = 0
  let lastInboundAt = null
  let closeInitiator = ""
  let closeWasClean = null
  let lastCloseSide = ""
  let lastCleanupReason = ""
  let reportedUnexpectedClose = false

  const stats = {
    framesReceived: 0,
    bytesReceived: 0,
    invalidFrames: 0,
    droppedFrames: 0,
    audioChunksSent: 0,
    providerBytesSent: 0,
    pendingAudioFrames: 0,
    wsMessagesRx: 0,
    partialTranscripts: 0,
    finalTranscripts: 0,
    assistantStarts: 0,
    assistantDeltas: 0,
    assistantTextDone: 0,
    audioEvents: 0,
    audioEncodedBytes: 0,
    audioDoneEvents: 0,
    audioDroppedTurnMismatch: 0,
    turnDoneEvents: 0,
    playbackProgressSent: 0,
    playbackDoneSent: 0,
    playbackAckSent: 0,
    lastAudioSendAt: null,
    lastTranscriptAt: null,
    lastInboundAt: null,
    connectedAt: null,
    connectionMs: null,
    authState: "NONE",
    streamingState: "DISCONNECTED",
    wsState: "CLOSED",
    closeCode: null,
    closeReason: "",
    closeWasClean: null,
    closeInitiator: "",
    closeSide: "",
    cleanupReason: "",
    lastEventType: null,
    activeTurnId: null,
    speechModel: "xinqi",
    languageCodes: ["zh"],
    chunkDurationMs: XINQI_CHUNK_DURATION_MS,
    chunkBytes: XINQI_CHUNK_BYTES,
  }

  function setState(next) {
    state = next
  }

  function fail(code, message, detail = {}) {
    stats.lastEventType = "error"
    bus.emit(VOICE_PROVIDER_EVENTS.error, {
      code,
      message,
      provider: "xinqi",
      ...detail,
    })
  }

  function syncPending() {
    stats.pendingAudioFrames = aggregator?.getState?.().pendingFrames || 0
  }

  function underBackpressure() {
    return Boolean(ws && typeof ws.bufferedAmount === "number" && ws.bufferedAmount > backpressureBytes)
  }

  function sendChunk(buffer) {
    if (!ws || ws.readyState !== 1 || !buffer || state !== VOICE_PROVIDER_STATES.CONNECTED || !ready) {
      return false
    }
    const actualBytes = buffer.byteLength
    if (actualBytes !== XINQI_CHUNK_BYTES) {
      fail(
        XINQI_PROVIDER_ERROR_CODES.InvalidAudioFrame,
        `拒绝发送非 3200 字节音频块（actual=${actualBytes}）。`,
        {
          expectedBytes: XINQI_CHUNK_BYTES,
          actualBytes,
          dataType: buffer.constructor?.name || typeof buffer,
          stage: "provider_send",
        },
      )
      return false
    }
    if (underBackpressure()) {
      if (!backpressureNotified) {
        backpressureNotified = true
        fail(XINQI_PROVIDER_ERROR_CODES.Backpressure, "Xinqi WebSocket 发送积压过高，已丢弃音频帧。")
      }
      return false
    }
    try {
      // 拷贝成独立 ArrayBuffer，避免 view/byteOffset 歧义。
      const exact = buffer instanceof ArrayBuffer
        ? (buffer.byteLength === XINQI_CHUNK_BYTES ? buffer : buffer.slice(0, XINQI_CHUNK_BYTES))
        : Uint8Array.from(new Uint8Array(buffer)).buffer
      if (exact.byteLength !== XINQI_CHUNK_BYTES) {
        fail(
          XINQI_PROVIDER_ERROR_CODES.InvalidAudioFrame,
          `音频块拷贝后长度异常（actual=${exact.byteLength}）。`,
          {
            expectedBytes: XINQI_CHUNK_BYTES,
            actualBytes: exact.byteLength,
            dataType: "ArrayBuffer",
            stage: "provider_send_copy",
          },
        )
        return false
      }
      ws.send(exact)
      stats.audioChunksSent += 1
      stats.providerBytesSent += exact.byteLength
      stats.lastAudioSendAt = now()
      return true
    } catch (error) {
      console.error("[xinqiProvider] send failed", error?.name || error)
      fail(XINQI_PROVIDER_ERROR_CODES.WsConnectFailed, "发送音频失败。")
      return false
    }
  }

  function emitTrace(extra = {}) {
    bus.emit(VOICE_PROVIDER_EVENTS.trace, {
      type: extra.type || stats.lastEventType || "unknown",
      turnId: activeTurnId || extra.turnId || null,
      environmentState: extra.environmentState || "",
      environmentTarget: extra.environmentTarget || "",
      environmentReason: extra.environmentReason || "",
      partialLength: extra.partialLength ?? null,
      finalLength: extra.finalLength ?? null,
      frames: stats.framesReceived,
      chunks: stats.audioChunksSent,
      dropped: stats.droppedFrames,
      invalid: stats.invalidFrames,
      error: extra.error || "",
      closeSide: extra.closeSide || lastCloseSide || "",
      closeCode: extra.closeCode ?? stats.closeCode,
      closeReason: extra.closeReason || stats.closeReason || "",
      cleanupReason: extra.cleanupReason || lastCleanupReason || "",
      connectionMs: extra.connectionMs ?? stats.connectionMs,
      at: now(),
    })
  }

  function handleServerText(text) {
    stats.wsMessagesRx += 1
    lastInboundAt = now()
    stats.lastInboundAt = lastInboundAt
    const mapped = mapXinqiServerMessage(text)
    stats.lastEventType = mapped.rawType || mapped.kind || "error"
    if (mapped.closeSide) lastCloseSide = mapped.closeSide
    if (mapped.cleanupReason) lastCleanupReason = mapped.cleanupReason
    if (mapped.closeCode != null) stats.closeCode = mapped.closeCode
    if (mapped.closeReason) stats.closeReason = mapped.closeReason
    emitTrace({
      type: mapped.rawType || mapped.kind || "unknown",
      turnId: mapped.turnId || null,
      environmentState: mapped.environmentState || "",
      environmentTarget: mapped.environmentTarget || "",
      environmentReason: mapped.environmentReason || "",
      partialLength: mapped.kind === "user_partial" ? String(mapped.text || "").length : null,
      finalLength: mapped.kind === "user_final" || mapped.kind === "assistant_done"
        ? String(mapped.text || "").length
        : null,
      error: mapped.ok ? "" : String(mapped.code || ""),
      closeSide: mapped.closeSide || "",
      closeCode: mapped.closeCode,
      closeReason: mapped.closeReason || "",
      cleanupReason: mapped.cleanupReason || "",
      connectionMs: mapped.connectionMs,
    })
    if (!mapped.ok) {
      setState(VOICE_PROVIDER_STATES.ERROR)
      stats.streamingState = "ERROR"
      if (mapped.kind === "gateway_error" || mapped.kind === "fatal") {
        reportedUnexpectedClose = true
        closeInitiator = mapped.closeSide || (mapped.kind === "fatal" ? "upstream" : "gateway")
        stats.closeInitiator = closeInitiator
        stats.closeSide = mapped.closeSide || closeInitiator
        stats.cleanupReason = mapped.cleanupReason || mapped.code || ""
        if (mapped.connectionMs != null) stats.connectionMs = mapped.connectionMs
      }
      fail(mapped.code, mapped.message, {
        closeSide: mapped.closeSide || closeInitiator,
        closeCode: mapped.closeCode,
        closeReason: mapped.closeReason,
        cleanupReason: mapped.cleanupReason,
        connectionMs: mapped.connectionMs ?? stats.connectionMs,
        turnId: activeTurnId,
        expectedBytes: mapped.expectedBytes,
        actualBytes: mapped.actualBytes,
        dataType: mapped.dataType,
        byteOffset: mapped.byteOffset,
        stage: mapped.stage || "provider",
      })
      return
    }
    if (mapped.kind === "policy" || mapped.kind === "listening" || mapped.kind === "environment" || mapped.kind === "ignored") return
    if (mapped.kind === "warning") return
    if (mapped.kind === "assistant_interrupted") {
      if (!mapped.turnId || mapped.turnId === activeTurnId) {
        activeTurnId = null
        upstreamAudioDone = false
      }
      bus.emit(VOICE_PROVIDER_EVENTS.turnInterrupted, { turnId: mapped.turnId, provider: "xinqi" })
      return
    }
    if (mapped.kind === "turn_done") {
      stats.turnDoneEvents += 1
      bus.emit(VOICE_PROVIDER_EVENTS.turnDone, { turnId: mapped.turnId, provider: "xinqi" })
      return
    }
    if (mapped.kind === "audio_done") {
      stats.audioDoneEvents += 1
      if (mapped.turnId && mapped.turnId === activeTurnId) upstreamAudioDone = true
      bus.emit(VOICE_PROVIDER_EVENTS.audioDone, { turnId: mapped.turnId, provider: "xinqi" })
      return
    }
    if (mapped.kind === "user_partial") {
      stats.partialTranscripts += 1
      stats.lastTranscriptAt = now()
      bus.emit(mapped.event, { text: mapped.text, provider: "xinqi", role: "user", timestampMs: now() })
      return
    }
    if (mapped.kind === "user_final") {
      if (!mapped.text) return
      stats.finalTranscripts += 1
      stats.lastTranscriptAt = now()
      bus.emit(mapped.event, { text: mapped.text, provider: "xinqi", role: "user", timestampMs: now() })
      return
    }
    if (mapped.kind === "assistant_start") {
      stats.assistantStarts += 1
      activeTurnId = mapped.turnId || null
      upstreamAudioDone = false
      playbackDoneForTurn = false
      lastAckSamples = 0
      bus.emit(mapped.event, { turnId: mapped.turnId, provider: "xinqi", timestampMs: now() })
      return
    }
    if (mapped.kind === "assistant_delta") {
      stats.assistantDeltas += 1
      bus.emit(mapped.event, {
        turnId: mapped.turnId,
        text: mapped.text,
        incremental: true,
        provider: "xinqi",
        timestampMs: now(),
      })
      return
    }
    if (mapped.kind === "assistant_done") {
      stats.assistantTextDone += 1
      bus.emit(mapped.event, {
        turnId: mapped.turnId,
        text: mapped.text,
        provider: "xinqi",
        timestampMs: now(),
      })
      return
    }
    if (mapped.kind === "audio") {
      if (!mapped.turnId || mapped.turnId !== activeTurnId) {
        stats.audioDroppedTurnMismatch += 1
        return
      }
      stats.audioEvents += 1
      stats.audioEncodedBytes += mapped.encodedBytes || 0
      bus.emit(VOICE_PROVIDER_EVENTS.audioDelta, {
        turnId: mapped.turnId,
        sampleRate: mapped.sampleRate,
        data: mapped.data,
        provider: "xinqi",
      })
    }
  }

  function sendJson(message) {
    if (!ws || ws.readyState !== 1) return false
    try {
      ws.send(JSON.stringify(message))
      return true
    } catch (error) {
      console.error("[xinqiProvider] control send failed", error?.name || error)
      return false
    }
  }

  function reportPlaybackProgress({ turnId, samples, received } = {}) {
    if (!activeTurnId || turnId !== activeTurnId || playbackDoneForTurn) {
      return { ok: false, reason: "stale-turn" }
    }
    if (!Number.isSafeInteger(samples) || samples <= lastAckSamples) {
      return { ok: false, reason: "not-monotonic" }
    }
    if (!Number.isSafeInteger(received) || samples > received) {
      return { ok: false, reason: "ahead-of-received" }
    }
    if (!sendJson({ type: "playback.progress", id: turnId, samples })) {
      return { ok: false, reason: "socket" }
    }
    lastAckSamples = samples
    stats.playbackProgressSent += 1
    stats.playbackAckSent += 1
    return { ok: true }
  }

  function reportPlaybackDone({ turnId } = {}) {
    if (!activeTurnId || turnId !== activeTurnId || !upstreamAudioDone || playbackDoneForTurn) {
      return { ok: false, reason: "not-ready" }
    }
    if (!sendJson({ type: "playback.done", id: turnId })) return { ok: false, reason: "socket" }
    playbackDoneForTurn = true
    stats.playbackDoneSent += 1
    stats.playbackAckSent += 1
    return { ok: true }
  }

  function clearSocketHandlers(socket) {
    if (!socket) return
    socket.onopen = null
    socket.onmessage = null
    socket.onerror = null
    socket.onclose = null
  }

  async function connect() {
    if (state === VOICE_PROVIDER_STATES.CONNECTED) return { ok: true, state }
    if (!WebSocketCtor) {
      return { ok: false, code: XINQI_PROVIDER_ERROR_CODES.WsConnectFailed, error: "当前环境不支持 WebSocket" }
    }

    const gen = ++generation
    intentionalClose = false
    ready = false
    backpressureNotified = false
    aggregator = createXinqiChunkAggregator()
    setState(VOICE_PROVIDER_STATES.CONNECTING)
    stats.authState = "REQUESTING"
    stats.streamingState = "CONNECTING"
    stats.framesReceived = 0
    stats.bytesReceived = 0
    stats.invalidFrames = 0
    stats.droppedFrames = 0
    stats.audioChunksSent = 0
    stats.providerBytesSent = 0
    stats.wsMessagesRx = 0
    stats.partialTranscripts = 0
    stats.finalTranscripts = 0
    stats.assistantStarts = 0
    stats.assistantDeltas = 0
    stats.assistantTextDone = 0
    stats.audioEvents = 0
    stats.audioEncodedBytes = 0
    stats.playbackProgressSent = 0
    stats.playbackDoneSent = 0
    stats.playbackAckSent = 0
    activeTurnId = null
    upstreamAudioDone = false
    playbackDoneForTurn = false
    lastAckSamples = 0
    connectedAt = 0
    lastInboundAt = null
    closeInitiator = ""
    closeWasClean = null
    lastCloseSide = ""
    lastCleanupReason = ""
    reportedUnexpectedClose = false
    stats.lastInboundAt = null
    stats.connectedAt = null
    stats.connectionMs = null
    stats.closeCode = null
    stats.closeReason = ""
    stats.closeWasClean = null
    stats.closeInitiator = ""
    stats.closeSide = ""
    stats.cleanupReason = ""
    stats.activeTurnId = null

    let response
    try {
      response = await fetchImpl(typeof sessionUrl === "function" ? sessionUrl() : sessionUrl, {
        method: "POST",
        headers: sessionHeaders || { "Content-Type": "application/json", Accept: "application/json" },
        body: "{}",
        cache: "no-store",
      })
    } catch (error) {
      stats.authState = "ERROR"
      setState(VOICE_PROVIDER_STATES.ERROR)
      fail(XINQI_PROVIDER_ERROR_CODES.Unreachable, "无法连接 FaceDEV Xinqi Gateway。")
      return { ok: false, code: XINQI_PROVIDER_ERROR_CODES.Unreachable, error: error?.message || "unreachable", cause: error }
    }
    if (gen !== generation) return { ok: false, error: "cancelled" }

    let data = null
    try { data = await response.json() } catch { data = null }
    if (!response.ok || !data?.gatewaySessionId) {
      const code = data?.error?.code || XINQI_PROVIDER_ERROR_CODES.SessionFailed
      stats.authState = "ERROR"
      setState(VOICE_PROVIDER_STATES.ERROR)
      fail(code, data?.error?.message || "Xinqi Gateway session 失败。")
      return { ok: false, code, error: data?.error?.message || "session failed" }
    }
    stats.authState = "GATEWAY_SESSION"

    const url = realtimeUrl(data.gatewaySessionId)
    console.info("[xinqiProvider] connecting gateway realtime")
    const socket = new WebSocketCtor(url)
    if ("binaryType" in socket) socket.binaryType = "arraybuffer"
    ws = socket
    stats.wsState = "CONNECTING"

    const opened = await new Promise((resolve) => {
      let settled = false
      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const timer = setTimeout(() => {
        finish({ ok: false, code: XINQI_PROVIDER_ERROR_CODES.WsConnectFailed, error: "等待 Xinqi ready 超时" })
      }, readyTimeoutMs)

      socket.onopen = () => {
        if (gen !== generation) return
        stats.wsState = "OPEN"
      }
      socket.onmessage = (event) => {
        if (gen !== generation) return
        if (typeof event.data !== "string") return
        handleServerText(event.data)
        if (!ready && stats.lastEventType === "ready") {
          ready = true
          finish({ ok: true })
        }
      }
      socket.onerror = () => {
        finish({ ok: false, code: XINQI_PROVIDER_ERROR_CODES.WsConnectFailed, error: "Xinqi Gateway WebSocket 连接失败" })
      }
      socket.onclose = (event) => {
        stats.wsState = "CLOSED"
        stats.closeCode = Number.isInteger(event?.code) ? event.code : null
        stats.closeReason = String(event?.reason || "")
        closeWasClean = event?.wasClean === true
        stats.closeWasClean = closeWasClean
        if (connectedAt) stats.connectionMs = Math.max(0, Math.round(now() - connectedAt))
        if (!closeInitiator) {
          closeInitiator = intentionalClose ? "browser" : "unknown"
          stats.closeInitiator = closeInitiator
        }
        if (!lastCloseSide && stats.closeReason) {
          if (stats.closeReason.includes("upstream")) lastCloseSide = "upstream"
          else if (stats.closeReason.includes("browser")) lastCloseSide = "browser"
          else if (stats.closeReason.includes("gateway")) lastCloseSide = "gateway"
          stats.closeSide = lastCloseSide
        }
        emitTrace({
          type: "ws.close",
          error: intentionalClose ? "" : XINQI_PROVIDER_ERROR_CODES.WsClosed,
          closeSide: lastCloseSide || closeInitiator,
          closeCode: stats.closeCode,
          closeReason: stats.closeReason,
          cleanupReason: lastCleanupReason || (intentionalClose ? "intentional" : "socket_close"),
          connectionMs: stats.connectionMs,
        })
        if (!ready) {
          finish({ ok: false, code: XINQI_PROVIDER_ERROR_CODES.WsConnectFailed, error: "Xinqi Gateway WebSocket 已关闭" })
          return
        }
        if (!intentionalClose && (state === VOICE_PROVIDER_STATES.CONNECTED || state === VOICE_PROVIDER_STATES.ERROR)) {
          setState(VOICE_PROVIDER_STATES.ERROR)
          stats.streamingState = "ERROR"
          if (!reportedUnexpectedClose) {
            reportedUnexpectedClose = true
            const detail = [
              lastCloseSide || closeInitiator || "unknown",
              stats.closeCode != null ? `code=${stats.closeCode}` : "",
              stats.closeReason || "no-reason",
            ].filter(Boolean).join(" · ")
            fail(
              XINQI_PROVIDER_ERROR_CODES.WsClosed,
              `Xinqi realtime 连接已关闭（${detail}）。`,
              {
                closeSide: lastCloseSide || closeInitiator,
                closeCode: stats.closeCode,
                closeReason: stats.closeReason,
                closeWasClean,
                connectionMs: stats.connectionMs,
                turnId: activeTurnId,
                lastInboundAt,
                lastAudioSendAt: stats.lastAudioSendAt,
              },
            )
          }
          bus.emit(VOICE_PROVIDER_EVENTS.disconnected, {
            provider: "xinqi",
            reason: "close",
            unexpected: true,
            closeSide: lastCloseSide || closeInitiator,
            closeCode: stats.closeCode,
            closeReason: stats.closeReason,
          })
        }
      }
    })

    if (gen !== generation) {
      try { socket.close() } catch { /* ignore */ }
      return { ok: false, error: "cancelled" }
    }
    if (!opened.ok) {
      stats.authState = "ERROR"
      setState(VOICE_PROVIDER_STATES.ERROR)
      stats.streamingState = "ERROR"
      clearSocketHandlers(socket)
      try { socket.close() } catch { /* ignore */ }
      ws = null
      fail(opened.code, opened.error)
      return opened
    }

    setState(VOICE_PROVIDER_STATES.CONNECTED)
    stats.streamingState = "ACTIVE"
    connectedAt = now()
    stats.connectedAt = connectedAt
    bus.emit(VOICE_PROVIDER_EVENTS.connected, { provider: "xinqi" })
    return { ok: true, state }
  }

  function sendAudio(frame) {
    if (state !== VOICE_PROVIDER_STATES.CONNECTED || !ready) {
      return { ok: false, code: AUDIO_ERROR_CODES.VoiceProviderSendFailed, error: "Provider 未就绪" }
    }
    const validated = validateAudioFrame(frame)
    if (!validated.ok) {
      stats.invalidFrames += 1
      return { ok: false, ...validated }
    }
    const frameBytes = Number(frame.data?.byteLength ?? frame.byteLength ?? 0)
    if (frameBytes !== 640) {
      stats.invalidFrames += 1
      fail(
        XINQI_PROVIDER_ERROR_CODES.InvalidAudioFrame,
        `拒绝直接发送非 640 字节 AudioFrame（actual=${frameBytes}）。`,
        {
          expectedBytes: 640,
          actualBytes: frameBytes,
          dataType: frame.data?.constructor?.name || typeof frame.data,
          stage: "provider_sendAudio",
        },
      )
      return {
        ok: false,
        code: XINQI_PROVIDER_ERROR_CODES.InvalidAudioFrame,
        expectedBytes: 640,
        actualBytes: frameBytes,
      }
    }
    if (underBackpressure()) {
      stats.droppedFrames += 1
      if (!backpressureNotified) {
        backpressureNotified = true
        fail(XINQI_PROVIDER_ERROR_CODES.Backpressure, "Xinqi WebSocket 发送积压过高，已丢弃音频帧。")
      }
      return { ok: false, code: XINQI_PROVIDER_ERROR_CODES.Backpressure, dropped: 1 }
    }

    stats.framesReceived += 1
    stats.bytesReceived += frame.byteLength || 640
    const pushed = aggregator.push(frame.data)
    if (pushed.dropped) stats.droppedFrames += pushed.dropped
    let sent = 0
    for (const chunk of pushed.chunks) {
      if (sendChunk(chunk)) sent += 1
      else stats.droppedFrames += 5
    }
    syncPending()
    return { ok: sent > 0 || pushed.chunks.length === 0, chunksSent: sent }
  }

  async function disconnect() {
    generation += 1
    intentionalClose = true
    const tail = aggregator?.discardTail?.() || 0
    stats.droppedFrames += tail
    syncPending()
    const socket = ws
    ws = null
    aggregator = null
    ready = false
    activeTurnId = null
    upstreamAudioDone = false
    playbackDoneForTurn = false
    if (socket) {
      clearSocketHandlers(socket)
      if (socket.readyState < 2) {
        try { socket.close() } catch { /* ignore */ }
      }
    }
    stats.authState = "NONE"
    stats.wsState = "CLOSED"
    stats.streamingState = "DISCONNECTED"
    stats.pendingAudioFrames = 0
    setState(VOICE_PROVIDER_STATES.IDLE)
    bus.emit(VOICE_PROVIDER_EVENTS.disconnected, { provider: "xinqi" })
    return { ok: true, state }
  }

  return {
    id: "xinqi",
    label: "Xinqi",
    connect,
    sendAudio,
    reportPlaybackProgress,
    reportPlaybackDone,
    getCapabilities: () => ({ playback: true }),
    disconnect,
    onEvent: bus.on,
    getState: () => state,
    getStats: () => {
      syncPending()
      stats.activeTurnId = activeTurnId
      if (connectedAt && stats.wsState === "OPEN") {
        stats.connectionMs = Math.max(0, Math.round(now() - connectedAt))
      }
      return { ...stats }
    },
  }
}
