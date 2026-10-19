/**
 * AssemblyAI Streaming Voice Provider（v3）。
 * 仅消费标准 AudioFrame；内部聚合 100 ms 后 binary send。
 */

import { validateAudioFrame } from "../../audio/audioFrame.js"
import { AUDIO_ERROR_CODES } from "../../audio/audioErrors.js"
import {
  VOICE_PROVIDER_EVENTS,
  VOICE_PROVIDER_STATES,
  createEventBus,
} from "../voiceProvider.js"
import { defaultNow } from "../browserApi.js"
import { fetchVoiceTemporaryToken } from "../voiceTokenClient.js"
import {
  createAssemblyAIChunkAggregator,
  ASSEMBLYAI_CHUNK_DURATION_MS,
  ASSEMBLYAI_CHUNK_BYTES,
} from "./assemblyAIChunkAggregator.js"
import {
  ASSEMBLYAI_PROVIDER_ERROR_CODES,
  ASSEMBLYAI_SPEECH_MODEL,
  ASSEMBLYAI_LANGUAGE_CODES,
  buildAssemblyAIWebSocketUrl,
  mapAssemblyAIServerMessage,
  redactWebSocketUrl,
} from "./assemblyAIProtocol.js"

const TERMINATE_TIMEOUT_MS = 1500

export function createAssemblyAIProvider({
  fetchToken = fetchVoiceTemporaryToken,
  WebSocketCtor = typeof WebSocket !== "undefined" ? WebSocket : null,
  now = defaultNow,
  terminateTimeoutMs = TERMINATE_TIMEOUT_MS,
} = {}) {
  const bus = createEventBus()
  let state = VOICE_PROVIDER_STATES.IDLE
  let ws = null
  let aggregator = null
  let generation = 0
  let terminateWaiter = null
  let intentionalClose = false

  const stats = {
    framesReceived: 0,
    bytesReceived: 0,
    invalidFrames: 0,
    audioChunksSent: 0,
    providerBytesSent: 0,
    pendingAudioFrames: 0,
    wsMessagesRx: 0,
    partialTranscripts: 0,
    finalTranscripts: 0,
    lastAudioSendAt: null,
    lastTranscriptAt: null,
    authState: "NONE",
    streamingState: "DISCONNECTED",
    wsState: "CLOSED",
    closeCode: null,
    closeReason: "",
    closeWasClean: null,
    lastEventType: null,
    speechModel: ASSEMBLYAI_SPEECH_MODEL,
    languageCodes: [...ASSEMBLYAI_LANGUAGE_CODES],
    chunkDurationMs: ASSEMBLYAI_CHUNK_DURATION_MS,
    chunkBytes: ASSEMBLYAI_CHUNK_BYTES,
  }

  function setState(next) {
    state = next
  }

  function setStreaming(next) {
    stats.streamingState = next
  }

  function fail(code, message, detail = {}) {
    stats.lastEventType = "error"
    bus.emit(VOICE_PROVIDER_EVENTS.error, {
      code,
      message,
      provider: "assemblyai",
      ...detail,
    })
  }

  function syncPending() {
    const agg = aggregator?.getState?.() || {}
    stats.pendingAudioFrames = agg.pendingFrames || 0
  }

  function sendBinary(buffer) {
    if (!ws || ws.readyState !== 1 || !buffer) return false
    try {
      ws.send(buffer)
      stats.audioChunksSent += 1
      stats.providerBytesSent += buffer.byteLength || 0
      stats.lastAudioSendAt = now()
      return true
    } catch (error) {
      console.error("[assemblyAIProvider] send failed", error)
      fail(ASSEMBLYAI_PROVIDER_ERROR_CODES.StreamingError, "WebSocket 发送音频失败")
      return false
    }
  }

  function handleServerText(text) {
    stats.wsMessagesRx += 1
    const mapped = mapAssemblyAIServerMessage(text, now)
    if (!mapped.ok) {
      fail(mapped.code, mapped.message, { reason: mapped.reason })
      return
    }
    stats.lastEventType = mapped.rawType || mapped.kind
    if (mapped.kind === "begin") {
      setStreaming("ACTIVE")
      return
    }
    if (mapped.kind === "transcript_partial" || mapped.kind === "transcript_final") {
      stats.lastTranscriptAt = mapped.timestampMs
      if (mapped.kind === "transcript_partial") stats.partialTranscripts += 1
      else stats.finalTranscripts += 1
      bus.emit(mapped.event, {
        text: mapped.text,
        timestampMs: mapped.timestampMs,
        provider: "assemblyai",
        rawType: mapped.rawType,
        raw: mapped.raw,
      })
      return
    }
    if (mapped.kind === "termination") {
      setStreaming("DISCONNECTED")
      if (terminateWaiter) {
        terminateWaiter.resolve()
        terminateWaiter = null
      }
    }
  }

  function clearSocketHandlers(socket) {
    if (!socket) return
    socket.onopen = null
    socket.onmessage = null
    socket.onerror = null
    socket.onclose = null
  }

  function wireSocket(socket, gen, openResolver) {
    ws = socket
    stats.wsState = "CONNECTING"
    setStreaming("CONNECTING")

    socket.onopen = () => {
      if (gen !== generation) return
      stats.wsState = "OPEN"
      console.info("[assemblyAIProvider] ws open")
      openResolver?.({ ok: true })
    }

    socket.onmessage = (event) => {
      if (gen !== generation) return
      if (typeof event.data === "string") {
        handleServerText(event.data)
      }
    }

    socket.onerror = () => {
      if (gen !== generation) return
      console.error("[assemblyAIProvider] ws error")
      openResolver?.({
        ok: false,
        code: ASSEMBLYAI_PROVIDER_ERROR_CODES.WebSocketConnectFailed,
        message: "WebSocket 连接失败",
      })
    }

    socket.onclose = (event) => {
      stats.wsState = "CLOSED"
      stats.closeCode = event?.code ?? null
      stats.closeReason = String(event?.reason || "")
      stats.closeWasClean = Boolean(event?.wasClean)
      console.info(
        "[assemblyAIProvider] ws close",
        stats.closeCode,
        stats.closeReason || "(no reason)",
        "clean=",
        stats.closeWasClean,
      )
      if (terminateWaiter) {
        terminateWaiter.resolve()
        terminateWaiter = null
      }
      if (intentionalClose || state === VOICE_PROVIDER_STATES.DISCONNECTING) {
        setStreaming("DISCONNECTED")
        return
      }
      if (state === VOICE_PROVIDER_STATES.CONNECTED || state === VOICE_PROVIDER_STATES.CONNECTING) {
        setStreaming("ERROR")
        setState(VOICE_PROVIDER_STATES.ERROR)
        fail(
          ASSEMBLYAI_PROVIDER_ERROR_CODES.WebSocketClosed,
          `WebSocket 已关闭（code=${stats.closeCode}）`,
          { closeCode: stats.closeCode, wasClean: stats.closeWasClean },
        )
        bus.emit(VOICE_PROVIDER_EVENTS.disconnected, { provider: "assemblyai", reason: "close" })
      }
    }
  }

  function waitForOpen(socket, gen, timeoutMs = 8000) {
    return new Promise((resolve) => {
      let settled = false
      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const timer = setTimeout(() => {
        finish({
          ok: false,
          code: ASSEMBLYAI_PROVIDER_ERROR_CODES.WebSocketConnectFailed,
          message: "WebSocket 连接超时",
        })
      }, timeoutMs)

      wireSocket(socket, gen, finish)
      if (socket.readyState === 1) {
        finish({ ok: true })
      }
    })
  }

  async function connect() {
    if (state === VOICE_PROVIDER_STATES.CONNECTED) return { ok: true, state }
    if (state === VOICE_PROVIDER_STATES.CONNECTING) {
      return { ok: false, code: AUDIO_ERROR_CODES.VoiceProviderConnectFailed, error: "正在连接" }
    }
    if (!WebSocketCtor) {
      return {
        ok: false,
        code: ASSEMBLYAI_PROVIDER_ERROR_CODES.WebSocketConnectFailed,
        error: "当前环境不支持 WebSocket",
      }
    }

    const gen = ++generation
    intentionalClose = false
    setState(VOICE_PROVIDER_STATES.CONNECTING)
    stats.authState = "REQUESTING"
    setStreaming("CONNECTING")
    aggregator = createAssemblyAIChunkAggregator()
    stats.framesReceived = 0
    stats.bytesReceived = 0
    stats.invalidFrames = 0
    stats.audioChunksSent = 0
    stats.providerBytesSent = 0
    stats.wsMessagesRx = 0
    stats.partialTranscripts = 0
    stats.finalTranscripts = 0
    stats.closeCode = null
    stats.closeReason = ""
    stats.closeWasClean = null
    stats.lastEventType = null

    try {
      const tokenResult = await fetchToken({ provider: "assemblyai" })
      if (gen !== generation) return { ok: false, error: "cancelled" }
      if (!tokenResult.ok) {
        stats.authState = "ERROR"
        setState(VOICE_PROVIDER_STATES.ERROR)
        setStreaming("ERROR")
        fail(
          tokenResult.code || ASSEMBLYAI_PROVIDER_ERROR_CODES.TokenFetchFailed,
          tokenResult.message || "Token 获取失败",
        )
        return {
          ok: false,
          code: ASSEMBLYAI_PROVIDER_ERROR_CODES.TokenFetchFailed,
          error: tokenResult.message,
        }
      }
      stats.authState = "TEMP_TOKEN"

      const wsUrl = buildAssemblyAIWebSocketUrl({ token: tokenResult.token })
      console.info("[assemblyAIProvider] connecting", redactWebSocketUrl(wsUrl))
      const socket = new WebSocketCtor(wsUrl)
      if ("binaryType" in socket) socket.binaryType = "arraybuffer"

      const opened = await waitForOpen(socket, gen)
      if (gen !== generation) {
        try { socket.close() } catch { /* ignore */ }
        return { ok: false, error: "cancelled" }
      }
      if (!opened.ok) {
        stats.authState = "ERROR"
        setState(VOICE_PROVIDER_STATES.ERROR)
        setStreaming("ERROR")
        clearSocketHandlers(socket)
        try { socket.close() } catch { /* ignore */ }
        ws = null
        fail(opened.code, opened.message)
        return { ok: false, code: opened.code, error: opened.message }
      }

      setState(VOICE_PROVIDER_STATES.CONNECTED)
      setStreaming("ACTIVE")
      bus.emit(VOICE_PROVIDER_EVENTS.connected, { provider: "assemblyai" })
      return { ok: true, state }
    } catch (error) {
      console.error("[assemblyAIProvider] connect failed", error)
      stats.authState = "ERROR"
      setState(VOICE_PROVIDER_STATES.ERROR)
      setStreaming("ERROR")
      fail(
        ASSEMBLYAI_PROVIDER_ERROR_CODES.WebSocketConnectFailed,
        error?.message || "AssemblyAI 连接失败",
      )
      return {
        ok: false,
        code: ASSEMBLYAI_PROVIDER_ERROR_CODES.WebSocketConnectFailed,
        error: error?.message || String(error),
        cause: error,
        stack: error?.stack,
      }
    }
  }

  function sendAudio(frame) {
    if (state !== VOICE_PROVIDER_STATES.CONNECTED) {
      return { ok: false, code: AUDIO_ERROR_CODES.VoiceProviderSendFailed, error: "Provider 未连接" }
    }
    const validated = validateAudioFrame(frame)
    if (!validated.ok) {
      stats.invalidFrames += 1
      fail(AUDIO_ERROR_CODES.VoiceProviderSendFailed, validated.message, { reason: validated.reason })
      return { ok: false, ...validated }
    }
    stats.framesReceived += 1
    stats.bytesReceived += frame.byteLength || 0
    const chunks = aggregator.push(frame.data)
    for (const chunk of chunks) {
      sendBinary(chunk)
    }
    syncPending()
    return { ok: true, chunksSent: chunks.length }
  }

  function waitForTermination(timeoutMs) {
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }
      terminateWaiter = { resolve: finish }
      setTimeout(() => {
        if (terminateWaiter?.resolve === finish) {
          terminateWaiter = null
          fail(
            ASSEMBLYAI_PROVIDER_ERROR_CODES.ProviderTerminateTimeout,
            "等待 Termination 超时，强制关闭。",
          )
        }
        finish()
      }, timeoutMs)
    })
  }

  async function disconnect({ quick = false } = {}) {
    generation += 1
    intentionalClose = true
    if (state === VOICE_PROVIDER_STATES.IDLE && !ws) {
      aggregator?.reset?.()
      return { ok: true, state }
    }
    setState(VOICE_PROVIDER_STATES.DISCONNECTING)
    setStreaming("DISCONNECTING")

    try {
      const tail = aggregator?.flush?.()
      if (tail && ws && ws.readyState === 1) {
        sendBinary(tail)
      }
      if (ws && ws.readyState === 1) {
        try {
          ws.send(JSON.stringify({ type: "Terminate" }))
        } catch (error) {
          console.error("[assemblyAIProvider] Terminate send failed", error)
        }
        if (!quick) {
          await waitForTermination(terminateTimeoutMs)
        }
      }
    } finally {
      aggregator?.reset?.()
      aggregator = null
      syncPending()
      const socket = ws
      ws = null
      if (socket) {
        clearSocketHandlers(socket)
        if (socket.readyState < 2) {
          try { socket.close() } catch { /* ignore */ }
        }
      }
      stats.authState = "NONE"
      stats.wsState = "CLOSED"
      setStreaming("DISCONNECTED")
      setState(VOICE_PROVIDER_STATES.IDLE)
      bus.emit(VOICE_PROVIDER_EVENTS.disconnected, { provider: "assemblyai" })
    }
    return { ok: true, state }
  }

  return {
    id: "assemblyai",
    label: "AssemblyAI",
    connect,
    sendAudio,
    disconnect,
    onEvent: bus.on,
    getState: () => state,
    getStats: () => {
      syncPending()
      return { ...stats, languageCodes: [...stats.languageCodes] }
    },
  }
}
