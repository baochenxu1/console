/**
 * VoiceSession：编排 Capture + AudioRuntime + VoiceProvider。
 * Provider 不直接访问 Mic。
 * 启动顺序：Capture → Meter → Provider CONNECTED → Runtime → RUNNING。
 */

import { AUDIO_CHANNEL_MODES } from "../audio/audioCapture.js"
import { startAudioCapture, stopAudioCapture, attachTrackEnded } from "../audio/audioCapture.js"
import { createAudioMeter } from "../audio/audioMeter.js"
import { createVoiceAudioRuntime, VOICE_AUDIO_FORMAT } from "../audio/audioRuntime.js"
import { createVoiceOutputRuntime } from "../audio/voiceOutputRuntime.js"
import { XINQI_SOURCE_RATE } from "../audio/pcmPlaybackQueue.js"
import { AUDIO_ERROR_CODES } from "../audio/audioErrors.js"
import { defaultNow } from "./browserApi.js"
import { createVoiceProvider } from "./voiceProviderRegistry.js"
import { VOICE_PROVIDER_EVENTS, VOICE_PROVIDER_STATES } from "./voiceProvider.js"

export const VOICE_SESSION_STATES = Object.freeze({
  IDLE: "IDLE",
  STARTING: "STARTING",
  RUNNING: "RUNNING",
  STOPPING: "STOPPING",
  ERROR: "ERROR",
})

function errorMessageOf(value, fallback = "未知错误") {
  if (value == null) return fallback
  if (typeof value === "string") return value
  if (value instanceof Error) return value.message || fallback
  if (typeof value?.message === "string") return value.message
  return String(value)
}

export function createVoiceSession({
  onStateChange,
  onStats,
  onEvent,
  onLevel,
  onTranscript,
  now = defaultNow,
} = {}) {
  let state = VOICE_SESSION_STATES.IDLE
  let generation = 0
  let stream = null
  let track = null
  let detachEnded = null
  let meter = null
  let runtime = null
  let provider = null
  let meterTimer = null
  let statsTimer = null
  let lastError = null
  let startStage = "idle"
  let events = []
  let sessionStartedAt = 0
  let activeChannelMode = AUDIO_CHANNEL_MODES.mono
  let activeProviderId = "mock"
  let trackSettings = null
  let partialText = ""
  let finalHistory = []
  let assistantDraft = ""
  let conversation = []
  let xinqiTrace = []
  let outputRuntime = null
  let outputSinkId = ""
  let providerFailureHandled = false
  /** @type {{ kind: string, detail: string, at: number } | null} */
  let transcriptStatus = null

  function setState(next) {
    state = next
    onStateChange?.(state)
  }

  function pushEvent(type, detail = {}) {
    const item = {
      type,
      at: now(),
      ...detail,
    }
    events = [...events.slice(-39), item]
    onEvent?.(item)
  }

  function clearTimers() {
    if (meterTimer != null) {
      clearInterval(meterTimer)
      meterTimer = null
    }
    if (statsTimer != null) {
      clearInterval(statsTimer)
      statsTimer = null
    }
  }

  function snapshotStats() {
    const runtimeStats = runtime?.getStats?.() || {}
    const providerStats = provider?.getStats?.() || {}
    return {
      sessionState: state,
      providerState: provider?.getState?.() || VOICE_PROVIDER_STATES.IDLE,
      providerId: activeProviderId,
      channelMode: activeChannelMode,
      inputSampleRate: runtimeStats.inputSampleRate ?? null,
      outputSampleRate: VOICE_AUDIO_FORMAT.sampleRate,
      encoding: VOICE_AUDIO_FORMAT.encoding,
      channels: VOICE_AUDIO_FORMAT.channels,
      frameDurationMs: VOICE_AUDIO_FORMAT.frameDurationMs,
      samplesPerFrame: VOICE_AUDIO_FORMAT.samplesPerFrame,
      bytesPerFrame: VOICE_AUDIO_FORMAT.bytesPerFrame,
      framesGenerated: runtimeStats.framesGenerated || 0,
      framesSent: runtimeStats.framesSent || 0,
      bytesSent: runtimeStats.bytesSent || 0,
      droppedFrames: runtimeStats.droppedFrames || 0,
      invalidFrames: providerStats.invalidFrames || 0,
      providerFramesReceived: providerStats.framesReceived || 0,
      providerBytesReceived: providerStats.bytesReceived || 0,
      providerAudioChunksSent: providerStats.audioChunksSent || 0,
      providerBytesSent: providerStats.providerBytesSent || 0,
      pendingAudioFrames: providerStats.pendingAudioFrames || 0,
      wsMessagesRx: providerStats.wsMessagesRx || 0,
      partialTranscripts: providerStats.partialTranscripts || 0,
      finalTranscripts: providerStats.finalTranscripts || 0,
      lastAudioSendAt: providerStats.lastAudioSendAt ?? null,
      lastTranscriptAt: providerStats.lastTranscriptAt ?? null,
      authState: providerStats.authState || (activeProviderId === "mock" ? "NOT_REQUIRED" : "NONE"),
      streamingState: providerStats.streamingState
        || (activeProviderId === "mock"
          ? (state === VOICE_SESSION_STATES.RUNNING ? "ACTIVE" : "DISCONNECTED")
          : "DISCONNECTED"),
      wsState: providerStats.wsState || "N/A",
      closeCode: providerStats.closeCode ?? null,
      closeReason: providerStats.closeReason || "",
      lastEventType: providerStats.lastEventType || null,
      speechModel: providerStats.speechModel || null,
      languageCodes: providerStats.languageCodes || null,
      chunkDurationMs: providerStats.chunkDurationMs || null,
      chunkBytes: providerStats.chunkBytes || null,
      partialText,
      finalHistory,
      assistantDraft,
      conversation,
      xinqiTrace,
      transcriptStatus,
      playbackState: outputRuntime?.getState?.().state || "Idle",
      playbackError: outputRuntime?.getState?.().error || "",
      playbackOutputSampleRate: outputRuntime?.getState?.().outputSampleRate ?? null,
      playbackSourceSampleRate: outputRuntime ? XINQI_SOURCE_RATE : null,
      playbackChunks: outputRuntime?.getState?.().chunks || 0,
      playbackSamplesReceived: outputRuntime?.getState?.().samplesReceived || 0,
      playbackSamplesPlayed: outputRuntime?.getState?.().samplesPlayed || 0,
      playbackQueuedMs: outputRuntime?.getState?.().queuedMs || 0,
      playbackUnderruns: outputRuntime?.getState?.().underruns || 0,
      playbackProgressSent: providerStats.playbackProgressSent || 0,
      playbackDoneSent: providerStats.playbackDoneSent || 0,
      playbackTurnId: outputRuntime?.getState?.().turnId || "",
      audioContextState: outputRuntime?.getState?.().contextState || "none",
      workletState: outputRuntime?.getState?.().workletState || "idle",
      outputDeviceId: outputRuntime?.getState?.().outputDeviceId || "(default)",
      sinkFallback: Boolean(outputRuntime?.getState?.().sinkFallback),
      assistantTextDone: providerStats.assistantTextDone || 0,
      browserAudioEvents: providerStats.audioEvents || 0,
      browserAudioDone: providerStats.audioDoneEvents || 0,
      browserAudioDroppedTurnMismatch: providerStats.audioDroppedTurnMismatch || 0,
      turnDoneEvents: providerStats.turnDoneEvents || 0,
      xinqiOutputTrace: {
        turnId: outputRuntime?.getState?.().turnId || providerStats.activeTurnId || "",
        assistantTextDone: providerStats.assistantTextDone || 0,
        browserAudioEventsRx: providerStats.audioEvents || 0,
        browserAudioDoneRx: providerStats.audioDoneEvents || 0,
        audioDroppedTurnMismatch: providerStats.audioDroppedTurnMismatch || 0,
        audioChunksDecoded: outputRuntime?.getState?.().chunks || 0,
        pcmSamplesReceived: outputRuntime?.getState?.().samplesReceived || 0,
        pcmSamplesPlayed: outputRuntime?.getState?.().samplesPlayed || 0,
        queuedMs: outputRuntime?.getState?.().queuedMs || 0,
        audioContextState: outputRuntime?.getState?.().contextState || "none",
        workletState: outputRuntime?.getState?.().workletState || "idle",
        outputDevice: outputRuntime?.getState?.().outputDeviceId || "(default)",
        playbackState: outputRuntime?.getState?.().state || "Idle",
        playbackError: outputRuntime?.getState?.().error || "",
        audioDoneReceived: providerStats.audioDoneEvents || 0,
        playbackProgressSent: providerStats.playbackProgressSent || 0,
        playbackDoneSent: providerStats.playbackDoneSent || 0,
        turnDoneReceived: providerStats.turnDoneEvents || 0,
      },
      closeCode: providerStats.closeCode ?? null,
      closeReason: providerStats.closeReason || "",
      closeSide: providerStats.closeSide || "",
      closeInitiator: providerStats.closeInitiator || "",
      closeWasClean: providerStats.closeWasClean,
      cleanupReason: providerStats.cleanupReason || "",
      connectionMs: providerStats.connectionMs ?? null,
      startStage,
      durationMs: sessionStartedAt ? Math.max(0, now() - sessionStartedAt) : 0,
      trackSettings,
      lastError,
      events,
    }
  }

  function publishStats() {
    onStats?.(snapshotStats())
  }

  function handlePlaybackAck(ack) {
    const playback = outputRuntime?.getState?.() || {}
    if (ack?.type === "playback.progress") {
      provider?.reportPlaybackProgress?.({
        turnId: ack.id,
        samples: ack.samples,
        received: playback.samplesReceived,
      })
    } else if (ack?.type === "playback.done") {
      provider?.reportPlaybackDone?.({ turnId: ack.id })
    }
    publishStats()
  }

  function ensureOutputRuntime(sinkId = "") {
    if (outputRuntime && outputSinkId === sinkId) return outputRuntime
    outputSinkId = sinkId
    outputRuntime = createVoiceOutputRuntime({
      sinkId,
      onAck: handlePlaybackAck,
      onState: () => publishStats(),
    })
    return outputRuntime
  }

  function primeOutput({ sinkId = "" } = {}) {
    const nextSink = sinkId || ""
    if (outputRuntime && outputSinkId === nextSink) return outputRuntime.prime()
    const previous = outputRuntime
    outputRuntime = null
    outputSinkId = ""
    previous?.close?.()
    const runtimeOutput = ensureOutputRuntime(nextSink)
    return runtimeOutput.prime()
  }

  function bindProviderEvents(activeProvider) {
    activeProvider.onEvent(VOICE_PROVIDER_EVENTS.connected, () => {
      providerFailureHandled = false
      pushEvent("PROVIDER_CONNECTED")
      publishStats()
    })
    activeProvider.onEvent(VOICE_PROVIDER_EVENTS.disconnected, (payload) => {
      outputRuntime?.interrupt?.()
      pushEvent("PROVIDER_DISCONNECTED", {
        unexpected: Boolean(payload?.unexpected),
        closeSide: payload?.closeSide || "",
        closeCode: payload?.closeCode ?? null,
        closeReason: payload?.closeReason || "",
      })
      publishStats()
      if (payload?.unexpected && !providerFailureHandled && state === VOICE_SESSION_STATES.RUNNING) {
        providerFailureHandled = true
        void stop({
          reason: payload?.closeReason || payload?.closeSide || "PROVIDER_DISCONNECTED",
          asError: true,
          quickProvider: true,
        })
      }
    })
    activeProvider.onEvent(VOICE_PROVIDER_EVENTS.error, (payload) => {
      lastError = {
        code: payload?.code,
        message: payload?.message,
        closeSide: payload?.closeSide,
        closeCode: payload?.closeCode,
        closeReason: payload?.closeReason,
        connectionMs: payload?.connectionMs,
        expectedBytes: payload?.expectedBytes,
        actualBytes: payload?.actualBytes,
        dataType: payload?.dataType,
        stage: payload?.stage,
      }
      pushEvent("PROVIDER_ERROR", {
        code: payload?.code,
        message: payload?.message,
        closeSide: payload?.closeSide,
        closeCode: payload?.closeCode,
        closeReason: payload?.closeReason,
      })
      publishStats()
      if (!providerFailureHandled && state === VOICE_SESSION_STATES.RUNNING) {
        providerFailureHandled = true
        outputRuntime?.interrupt?.()
        void stop({
          reason: payload?.code || "PROVIDER_ERROR",
          asError: true,
          quickProvider: true,
        })
      }
    })
    activeProvider.onEvent(VOICE_PROVIDER_EVENTS.transcriptPartial, (payload) => {
      if (state !== VOICE_SESSION_STATES.RUNNING && state !== VOICE_SESSION_STATES.STARTING) return
      const text = String(payload?.text || "")
      partialText = text
      if (!text) {
        transcriptStatus = {
          kind: "empty_partial",
          detail: "识别未形成正式消息：收到空的 transcript.partial。",
          at: now(),
        }
      } else {
        transcriptStatus = {
          kind: "partial",
          detail: "正在识别（临时文字，尚未成为正式用户消息）。",
          at: now(),
        }
      }
      onTranscript?.({ kind: "partial", ...payload })
      pushEvent("TRANSCRIPT_PARTIAL")
      publishStats()
    })
    activeProvider.onEvent(VOICE_PROVIDER_EVENTS.transcriptFinal, (payload) => {
      const text = String(payload?.text || "").trim()
      if (text) {
        finalHistory = [
          ...finalHistory.slice(-49),
          {
            text,
            role: "user",
            at: payload?.timestampMs ?? now(),
            wallClock: Date.now(),
          },
        ]
        conversation = [
          ...conversation.slice(-79),
          { role: "user", text, status: "done", wallClock: Date.now() },
        ]
        transcriptStatus = {
          kind: "user",
          detail: "已形成正式用户消息。",
          at: now(),
        }
      }
      // 仅清空临时 partial；已入库的正式用户消息保留。
      partialText = ""
      onTranscript?.({ kind: "final", ...payload })
      pushEvent("TRANSCRIPT_FINAL")
      publishStats()
    })
    activeProvider.onEvent(VOICE_PROVIDER_EVENTS.assistantStart, (payload) => {
      assistantDraft = ""
      outputRuntime?.begin?.(payload?.turnId)
      pushEvent("ASSISTANT_START", { turnId: payload?.turnId || null })
      publishStats()
    })
    activeProvider.onEvent(VOICE_PROVIDER_EVENTS.assistantDelta, (payload) => {
      assistantDraft += String(payload?.text || "")
      pushEvent("ASSISTANT_DELTA")
      publishStats()
    })
    activeProvider.onEvent(VOICE_PROVIDER_EVENTS.trace, (payload) => {
      const at = Number(payload?.at) || now()
      const envState = String(payload?.environmentState || "")
      if (envState === "ignored") {
        transcriptStatus = {
          kind: "environment_ignored",
          detail: `本段语音未提交：环境交互判断未放行${payload?.environmentTarget ? `（${payload.environmentTarget}）` : ""}${payload?.environmentReason ? ` · ${payload.environmentReason}` : ""}`,
          at,
        }
      } else if (envState === "accepted") {
        transcriptStatus = {
          kind: "environment_accepted",
          detail: "环境交互判断已放行，等待正式用户消息。",
          at,
        }
      } else if (envState === "checking") {
        transcriptStatus = {
          kind: "environment_checking",
          detail: "环境交互判断中。",
          at,
        }
      } else if (String(payload?.type || "") === "ws.close" || payload?.error) {
        if (transcriptStatus?.kind === "partial" || transcriptStatus?.kind === "environment_checking") {
          transcriptStatus = {
            kind: "incomplete_disconnect",
            detail: "识别未形成正式消息：连接在提交前断开。",
            at,
          }
        }
      }
      xinqiTrace = [
        ...xinqiTrace.slice(-99),
        {
          type: String(payload?.type || "unknown"),
          at,
          relativeMs: sessionStartedAt ? Math.max(0, Math.round(at - sessionStartedAt)) : 0,
          turnId: payload?.turnId || "",
          environmentState: envState,
          environmentTarget: payload?.environmentTarget || "",
          environmentReason: payload?.environmentReason || "",
          partialLength: payload?.partialLength ?? null,
          finalLength: payload?.finalLength ?? null,
          frames: payload?.frames ?? 0,
          chunks: payload?.chunks ?? 0,
          dropped: payload?.dropped ?? 0,
          invalid: payload?.invalid ?? 0,
          error: payload?.error || "",
          closeSide: payload?.closeSide || "",
          closeCode: payload?.closeCode ?? null,
          closeReason: payload?.closeReason || "",
          cleanupReason: payload?.cleanupReason || "",
          connectionMs: payload?.connectionMs ?? null,
        },
      ]
      publishStats()
    })
    activeProvider.onEvent(VOICE_PROVIDER_EVENTS.assistantTextDone, (payload) => {
      const text = String(payload?.text || assistantDraft || "").trim()
      if (text) {
        conversation = [
          ...conversation.slice(-79),
          { role: "assistant", text, status: "text_done", wallClock: Date.now(), turnId: payload?.turnId || null },
        ]
      }
      assistantDraft = ""
      pushEvent("ASSISTANT_TEXT_DONE", { turnId: payload?.turnId || null })
      publishStats()
    })
    activeProvider.onEvent(VOICE_PROVIDER_EVENTS.audioDelta, (payload) => {
      outputRuntime?.appendBase64?.(payload?.turnId, payload?.data, payload?.sampleRate)
      pushEvent("AUDIO_DELTA", { turnId: payload?.turnId || null })
      publishStats()
    })
    activeProvider.onEvent(VOICE_PROVIDER_EVENTS.audioDone, (payload) => {
      outputRuntime?.finish?.(payload?.turnId)
      pushEvent("AUDIO_DONE", { turnId: payload?.turnId || null })
      publishStats()
    })
    activeProvider.onEvent(VOICE_PROVIDER_EVENTS.turnInterrupted, (payload) => {
      outputRuntime?.interrupt?.(payload?.turnId)
      pushEvent("TURN_INTERRUPTED", { turnId: payload?.turnId || null })
      publishStats()
    })
    activeProvider.onEvent(VOICE_PROVIDER_EVENTS.turnDone, (payload) => {
      pushEvent("TURN_DONE", { turnId: payload?.turnId || null })
      publishStats()
    })
  }

  async function hardCleanup({ quickProvider = false } = {}) {
    clearTimers()
    detachEnded?.()
    detachEnded = null
    if (runtime) {
      await runtime.stop().catch(() => {})
      runtime = null
    }
    if (meter) {
      await meter.close().catch(() => {})
      meter = null
    }
    if (provider) {
      await provider.disconnect({ quick: quickProvider }).catch(() => {})
      provider = null
    }
    stopAudioCapture(stream)
    stream = null
    track = null
    trackSettings = null
    sessionStartedAt = 0
  }

  async function closeOutput() {
    const current = outputRuntime
    outputRuntime = null
    outputSinkId = ""
    if (current) await current.close().catch(() => {})
  }

  async function start({
    deviceId,
    channelMode = AUDIO_CHANNEL_MODES.mono,
    providerId = "mock",
    outputDeviceId = "",
    providerOptions = null,
  } = {}) {
    if (state === VOICE_SESSION_STATES.STARTING || state === VOICE_SESSION_STATES.RUNNING) {
      return { ok: false, code: AUDIO_ERROR_CODES.VoiceSessionStartFailed, error: "会话已在进行" }
    }
    if (state === VOICE_SESSION_STATES.STOPPING) {
      return { ok: false, code: AUDIO_ERROR_CODES.VoiceSessionStartFailed, error: "会话正在停止" }
    }
    const gen = ++generation
    lastError = null
    events = []
    partialText = ""
    finalHistory = []
    assistantDraft = ""
    conversation = []
    xinqiTrace = []
    transcriptStatus = null
    providerFailureHandled = false
    startStage = "device"
    activeChannelMode = channelMode
    activeProviderId = providerId || "mock"
    setState(VOICE_SESSION_STATES.STARTING)
    pushEvent("SESSION_START", { providerId: activeProviderId, channelMode: activeChannelMode })

    try {
      if ((providerId || "mock") === "xinqi") {
        primeOutput({ sinkId: outputDeviceId || outputSinkId || "" })
        startStage = "output"
        const playbackReady = await outputRuntime.start()
        if (!playbackReady.ok) {
          lastError = {
            code: playbackReady.code || "OUTPUT_SUSPENDED",
            message: playbackReady.error || "音频输出未就绪。",
            stage: "output",
          }
          pushEvent("OUTPUT_ERROR", lastError)
          setState(VOICE_SESSION_STATES.ERROR)
          publishStats()
          await closeOutput()
          return {
            ok: false,
            code: lastError.code,
            error: lastError,
            message: lastError.message,
          }
        }
      } else {
        await closeOutput()
      }
      await hardCleanup()
      if (gen !== generation) return { ok: false, error: "cancelled" }

      startStage = "capture"
      const capture = await startAudioCapture({
        deviceId,
        channelMode: activeChannelMode,
      })
      if (!capture.ok) {
        lastError = {
          code: capture.code,
          message: capture.message,
          stage: startStage,
        }
        setState(VOICE_SESSION_STATES.ERROR)
        pushEvent("ERROR", lastError)
        return capture
      }
      stream = capture.stream
      track = capture.track
      trackSettings = capture.settings

      detachEnded = attachTrackEnded(track, () => {
        void stop({ reason: AUDIO_ERROR_CODES.DeviceDisconnected, asError: true })
      })

      startStage = "meter"
      meter = createAudioMeter({
        stream,
        actualChannelCount: capture.actualChannels || 1,
      })
      if (meter.ok) {
        await meter.resume()
        meterTimer = setInterval(() => {
          onLevel?.(meter.readLevel())
        }, 120)
      } else {
        meter = null
      }

      const usesToken = activeProviderId === "assemblyai" || activeProviderId === "deepgram"
      startStage = usesToken ? "provider_token" : "provider_connect"
      provider = createVoiceProvider(activeProviderId, providerOptions || {})
      bindProviderEvents(provider)
      const connected = await provider.connect()
      if (!connected.ok) {
        const tokenFailed = connected.code === "TOKEN_FETCH_FAILED"
          || connected.code === "DEEPGRAM_TOKEN_FAILED"
        startStage = usesToken && tokenFailed
          ? "provider_token"
          : "provider_connect"
        const message = errorMessageOf(connected.error || connected.message, "Provider 连接失败")
        const err = new Error(message, { cause: connected.cause || connected.error })
        err.code = connected.code || AUDIO_ERROR_CODES.VoiceProviderConnectFailed
        err.stage = startStage
        err.stack = connected.stack || err.stack
        throw err
      }
      startStage = "provider_connect"

      if (gen !== generation) {
        await hardCleanup()
        return { ok: false, error: "cancelled" }
      }

      startStage = "audio_runtime"
      runtime = createVoiceAudioRuntime({
        stream,
        now,
        onFrame: (frame) => {
          const result = provider?.sendAudio?.(frame)
          if (result && result.ok === false) {
            // invalid / send fail counted in provider
          }
        },
        onError: (payload) => {
          lastError = payload
          pushEvent("RUNTIME_ERROR", payload)
        },
      })
      if (!runtime.ok) {
        const err = new Error(errorMessageOf(runtime.error, "AudioRuntime 创建失败"))
        err.code = runtime.code || AUDIO_ERROR_CODES.AudioRuntimeStartFailed
        err.stage = startStage
        throw err
      }
      startStage = "audio_context"
      const started = await runtime.start()
      if (!started.ok) {
        const err = new Error(errorMessageOf(started.error, "AudioRuntime 启动失败"), {
          cause: started.error instanceof Error ? started.error : undefined,
        })
        err.code = started.code || AUDIO_ERROR_CODES.AudioRuntimeStartFailed
        err.stage = startStage
        if (started.error?.stack) err.stack = started.error.stack
        throw err
      }

      if (gen !== generation) {
        await hardCleanup()
        return { ok: false, error: "cancelled" }
      }

      startStage = "running"
      sessionStartedAt = now()
      setState(VOICE_SESSION_STATES.RUNNING)
      pushEvent("AUDIO_FLOW_START", {
        inputSampleRate: started.inputSampleRate,
        outputSampleRate: started.outputSampleRate,
      })
      statsTimer = setInterval(() => publishStats(), 200)
      publishStats()
      return {
        ok: true,
        inputSampleRate: started.inputSampleRate,
        outputSampleRate: started.outputSampleRate,
        trackSettings,
      }
    } catch (error) {
      console.error("[voiceSession] start failed", {
        stage: error?.stage || startStage,
        code: error?.code,
        message: error?.message,
        error,
        cause: error?.cause,
        stack: error?.stack,
      })
      console.error("[voiceSession] start failed at stage:", error?.stage || startStage, error)
      lastError = {
        code: error?.code || AUDIO_ERROR_CODES.VoiceSessionStartFailed,
        message: errorMessageOf(error, "VoiceSession 启动失败"),
        stage: error?.stage || startStage,
        stack: error?.stack,
        cause: error?.cause,
      }
      await closeOutput()
      await hardCleanup()
      setState(VOICE_SESSION_STATES.ERROR)
      pushEvent("ERROR", lastError)
      publishStats()
      return { ok: false, ...lastError, error }
    }
  }

  async function stop({ reason = "manual", asError = false, quickProvider = false } = {}) {
    if (state === VOICE_SESSION_STATES.IDLE && !stream && !runtime && !provider && !outputRuntime) {
      return { ok: true, state }
    }
    if (state === VOICE_SESSION_STATES.STOPPING) {
      return { ok: true, state }
    }
    generation += 1
    setState(VOICE_SESSION_STATES.STOPPING)
    pushEvent("SESSION_STOP", { reason })
    await closeOutput()
    await hardCleanup({
      quickProvider: quickProvider || reason === "unmount" || reason === "pagehide",
    })
    if (asError || reason === AUDIO_ERROR_CODES.DeviceDisconnected) {
      partialText = ""
      lastError = {
        code: reason === AUDIO_ERROR_CODES.DeviceDisconnected
          ? AUDIO_ERROR_CODES.DeviceDisconnected
          : reason,
        message: reason === AUDIO_ERROR_CODES.DeviceDisconnected
          ? "当前麦克风轨道已结束（可能被拔出或系统释放）。"
          : String(reason),
      }
      setState(VOICE_SESSION_STATES.ERROR)
      pushEvent("ERROR", lastError)
    } else {
      setState(VOICE_SESSION_STATES.IDLE)
      startStage = "idle"
    }
    publishStats()
    return { ok: true, state, reason }
  }

  return {
    start,
    stop,
    primeOutput,
    getState: () => state,
    getStats: snapshotStats,
    getEvents: () => events,
    getLastError: () => lastError,
    getStartStage: () => startStage,
  }
}
