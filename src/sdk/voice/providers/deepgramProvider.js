/**
 * Deepgram Streaming Voice Provider（Listen v1 / Nova-3）。
 * 直接发送标准 20 ms AudioFrame binary；不修改 Audio Runtime。
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
  DEEPGRAM_PROVIDER_ERROR_CODES,
  DEEPGRAM_SPEECH_MODEL,
  DEEPGRAM_LANGUAGE_CODES,
  DEEPGRAM_CHUNK_DURATION_MS,
  DEEPGRAM_CHUNK_BYTES,
  buildDeepgramWebSocketUrl,
  buildDeepgramWebSocketProtocols,
  redactDeepgramWebSocketUrl,
  mapDeepgramServerMessage,
  joinTranscriptSegments,
  composeCurrentTranscript,
} from "./deepgramProtocol.js"

const FINALIZE_TIMEOUT_MS = 1500

export function createDeepgramProvider({
  fetchToken = fetchVoiceTemporaryToken,
  WebSocketCtor = typeof WebSocket !== "undefined" ? WebSocket : null,
  now = defaultNow,
  finalizeTimeoutMs = FINALIZE_TIMEOUT_MS,
} = {}) {
  const bus = createEventBus()
  let state = VOICE_PROVIDER_STATES.IDLE
  let ws = null
  let generation = 0
  let intentionalClose = false
  /** @type {string[]} */
  let finalSegmentBuffer = []
  let finalizeWaiter = null
  let closeWaiter = null

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
    speechModel: DEEPGRAM_SPEECH_MODEL,
    languageCodes: [...DEEPGRAM_LANGUAGE_CODES],
    chunkDurationMs: DEEPGRAM_CHUNK_DURATION_MS,
    chunkBytes: DEEPGRAM_CHUNK_BYTES,
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
      provider: "deepgram",
      ...detail,
    })
  }

  function emitPartial(text, timestampMs, rawType, raw) {
    const value = String(text || "")
    if (!value) return
    stats.partialTranscripts += 1
    stats.lastTranscriptAt = timestampMs
    bus.emit(VOICE_PROVIDER_EVENTS.transcriptPartial, {
      text: value,
      timestampMs,
      provider: "deepgram",
      rawType,
      raw,
    })
  }

  function emitFinal(text, timestampMs, rawType, raw) {
    const value = String(text || "")
    if (!value) return
    stats.finalTranscripts += 1
    stats.lastTranscriptAt = timestampMs
    bus.emit(VOICE_PROVIDER_EVENTS.transcriptFinal, {
      text: value,
      timestampMs,
      provider: "deepgram",
      rawType,
      raw,
    })
  }

  function flushFinalBuffer(timestampMs, rawType, raw) {
    const utterance = joinTranscriptSegments(finalSegmentBuffer)
    finalSegmentBuffer = []
    if (utterance) {
      emitFinal(utterance, timestampMs, rawType, raw)
    }
    if (finalizeWaiter) {
      finalizeWaiter.resolve()
      finalizeWaiter = null
    }
    return utterance
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
      console.error("[deepgramProvider] send failed", error)
      fail(DEEPGRAM_PROVIDER_ERROR_CODES.StreamingError, "WebSocket 发送音频失败")
      return false
    }
  }

  function sendJson(payload) {
    if (!ws || ws.readyState !== 1) return false
    try {
      ws.send(JSON.stringify(payload))
      return true
    } catch (error) {
      console.error("[deepgramProvider] json send failed", payload?.type, error)
      return false
    }
  }

  function handleResults(mapped) {
    const { text, isFinal, speechFinal, fromFinalize, timestampMs, rawType, raw } = mapped

    if (!isFinal) {
      if (text) {
        emitPartial(
          composeCurrentTranscript(finalSegmentBuffer, text),
          timestampMs,
          rawType,
          raw,
        )
      }
      return
    }

    if (text) {
      finalSegmentBuffer.push(text)
    }

    if (speechFinal || fromFinalize) {
      flushFinalBuffer(timestampMs, rawType, raw)
      return
    }

    // is_final=true, speech_final=false：仅缓冲稳定段，用 partial 展示累计前缀
    const stable = joinTranscriptSegments(finalSegmentBuffer)
    if (stable) {
      emitPartial(stable, timestampMs, rawType, raw)
    }
  }

  function handleServerText(text) {
    stats.wsMessagesRx += 1
    const mapped = mapDeepgramServerMessage(text, now)
    if (!mapped.ok) {
      fail(mapped.code, mapped.message, { reason: mapped.reason })
      return
    }
    stats.lastEventType = mapped.rawType || mapped.kind

    if (mapped.kind === "results") {
      handleResults(mapped)
      return
    }
    if (mapped.kind === "metadata" || mapped.kind === "speech_started") {
      return
    }
    if (mapped.kind === "utterance_end") {
      if (finalSegmentBuffer.length > 0) {
        flushFinalBuffer(mapped.timestampMs, mapped.rawType, mapped.raw)
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
      console.info("[deepgramProvider] ws open")
      openResolver?.({ ok: true })
    }

    socket.onmessage = (event) => {
      if (gen !== generation) return
      if (typeof event.data === "string") {
        handleServerText(event.data)
      }
    }

    socket.onerror = (event) => {
      if (gen !== generation) return
      console.error("[deepgramProvider] ws error", {
        wsState: stats.wsState,
        readyState: socket.readyState,
        type: event?.type,
      })
      openResolver?.({
        ok: false,
        code: DEEPGRAM_PROVIDER_ERROR_CODES.WebSocketConnectFailed,
        message: "WebSocket 连接失败",
      })
    }

    socket.onclose = (event) => {
      stats.wsState = "CLOSED"
      stats.closeCode = event?.code ?? null
      stats.closeReason = String(event?.reason || "")
      stats.closeWasClean = Boolean(event?.wasClean)
      console.info(
        "[deepgramProvider] ws close",
        stats.closeCode,
        stats.closeReason || "(no reason)",
        "clean=",
        stats.closeWasClean,
      )
      if (closeWaiter) {
        closeWaiter.resolve()
        closeWaiter = null
      }
      if (finalizeWaiter) {
        finalizeWaiter.resolve()
        finalizeWaiter = null
      }
      if (intentionalClose || state === VOICE_PROVIDER_STATES.DISCONNECTING) {
        setStreaming("DISCONNECTED")
        return
      }
      if (state === VOICE_PROVIDER_STATES.CONNECTED || state === VOICE_PROVIDER_STATES.CONNECTING) {
        setStreaming("ERROR")
        setState(VOICE_PROVIDER_STATES.ERROR)
        fail(
          DEEPGRAM_PROVIDER_ERROR_CODES.WebSocketClosed,
          `WebSocket 已关闭（code=${stats.closeCode}）`,
          { closeCode: stats.closeCode, wasClean: stats.closeWasClean },
        )
        bus.emit(VOICE_PROVIDER_EVENTS.disconnected, { provider: "deepgram", reason: "close" })
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
          code: DEEPGRAM_PROVIDER_ERROR_CODES.WebSocketConnectFailed,
          message: "WebSocket 连接超时",
        })
      }, timeoutMs)

      wireSocket(socket, gen, finish)
      if (socket.readyState === 1) {
        finish({ ok: true })
      }
    })
  }

  function waitWithTimeout(assignWaiter, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }
      assignWaiter({ resolve: finish })
      setTimeout(finish, timeoutMs)
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
        code: DEEPGRAM_PROVIDER_ERROR_CODES.WebSocketConnectFailed,
        error: "当前环境不支持 WebSocket",
      }
    }

    const gen = ++generation
    intentionalClose = false
    finalSegmentBuffer = []
    setState(VOICE_PROVIDER_STATES.CONNECTING)
    stats.authState = "REQUESTING"
    setStreaming("CONNECTING")
    stats.framesReceived = 0
    stats.bytesReceived = 0
    stats.invalidFrames = 0
    stats.audioChunksSent = 0
    stats.providerBytesSent = 0
    stats.pendingAudioFrames = 0
    stats.wsMessagesRx = 0
    stats.partialTranscripts = 0
    stats.finalTranscripts = 0
    stats.closeCode = null
    stats.closeReason = ""
    stats.closeWasClean = null
    stats.lastEventType = null

    try {
      const tokenResult = await fetchToken({ provider: "deepgram" })
      if (gen !== generation) return { ok: false, error: "cancelled" }
      if (!tokenResult.ok) {
        stats.authState = "ERROR"
        setState(VOICE_PROVIDER_STATES.ERROR)
        setStreaming("ERROR")
        fail(
          tokenResult.code || DEEPGRAM_PROVIDER_ERROR_CODES.TokenFetchFailed,
          tokenResult.message || "Token 获取失败",
        )
        return {
          ok: false,
          code: DEEPGRAM_PROVIDER_ERROR_CODES.TokenFetchFailed,
          error: tokenResult.message,
        }
      }
      stats.authState = "TEMP_TOKEN"

      const wsUrl = buildDeepgramWebSocketUrl()
      const protocols = buildDeepgramWebSocketProtocols(tokenResult.token)
      console.info("[deepgramProvider] connecting", redactDeepgramWebSocketUrl(wsUrl))
      const socket = new WebSocketCtor(wsUrl, protocols)
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
      bus.emit(VOICE_PROVIDER_EVENTS.connected, { provider: "deepgram" })
      return { ok: true, state }
    } catch (error) {
      console.error("[deepgramProvider] connect failed", error)
      stats.authState = "ERROR"
      setState(VOICE_PROVIDER_STATES.ERROR)
      setStreaming("ERROR")
      fail(
        DEEPGRAM_PROVIDER_ERROR_CODES.WebSocketConnectFailed,
        error?.message || "Deepgram 连接失败",
      )
      return {
        ok: false,
        code: DEEPGRAM_PROVIDER_ERROR_CODES.WebSocketConnectFailed,
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
    const sent = sendBinary(frame.data)
    return { ok: sent, chunksSent: sent ? 1 : 0 }
  }

  async function disconnect({ quick = false } = {}) {
    generation += 1
    intentionalClose = true
    if (state === VOICE_PROVIDER_STATES.IDLE && !ws) {
      finalSegmentBuffer = []
      return { ok: true, state }
    }
    setState(VOICE_PROVIDER_STATES.DISCONNECTING)
    setStreaming("DISCONNECTING")

    const timeoutBudget = quick ? 200 : finalizeTimeoutMs
    let timedOut = false

    try {
      if (ws && ws.readyState === 1) {
        sendJson({ type: "Finalize" })
        if (!quick) {
          const before = Date.now()
          await waitWithTimeout((waiter) => {
            finalizeWaiter = waiter
          }, timeoutBudget)
          if (Date.now() - before >= timeoutBudget - 5 && finalSegmentBuffer.length > 0) {
            timedOut = true
          }
        }

        if (finalSegmentBuffer.length > 0) {
          if (timedOut) {
            fail(
              DEEPGRAM_PROVIDER_ERROR_CODES.FinalizeTimeout,
              "等待 Finalize 超时，强制关闭。",
            )
          }
          flushFinalBuffer(now(), "Finalize", { forced: timedOut })
        }

        sendJson({ type: "CloseStream" })
        if (!quick) {
          await waitWithTimeout((waiter) => {
            closeWaiter = waiter
          }, Math.min(800, timeoutBudget))
        }
      } else if (finalSegmentBuffer.length > 0) {
        flushFinalBuffer(now(), "disconnect", { forced: true })
      }
    } finally {
      finalizeWaiter = null
      closeWaiter = null
      finalSegmentBuffer = []
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
      bus.emit(VOICE_PROVIDER_EVENTS.disconnected, { provider: "deepgram" })
    }
    return { ok: true, state }
  }

  return {
    id: "deepgram",
    label: "Deepgram",
    connect,
    sendAudio,
    disconnect,
    onEvent: bus.on,
    getState: () => state,
    getStats: () => ({
      ...stats,
      languageCodes: [...stats.languageCodes],
      finalSegmentBufferLength: finalSegmentBuffer.length,
    }),
  }
}
