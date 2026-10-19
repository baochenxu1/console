/**
 * Voice Audio Runtime：
 * MediaStream → AudioWorklet (mono Float32)
 * → streaming resampler → 16 kHz
 * → frame accumulator → PCM16LE AudioFrame
 *
 * Provider 不在这里访问 Mic。
 */

import { createLinearResampler } from "./audioResampler.js"
import { floatToPcm16leBuffer } from "./pcm16.js"
import {
  VOICE_AUDIO_FORMAT,
  createAudioFrameAccumulator,
} from "./audioFrame.js"
import { AUDIO_ERROR_CODES } from "./audioErrors.js"

export { VOICE_AUDIO_FORMAT }

const PROCESSOR_NAME = "pcm-capture-processor"

function defaultNow() {
  if (typeof globalThis.performance?.now === "function") {
    return globalThis.performance.now()
  }
  return Date.now()
}

function workletModuleUrl() {
  return new URL("./worklets/pcmCaptureProcessor.js", import.meta.url)
}

export function createVoiceAudioRuntime({
  stream,
  onFrame,
  onError,
  now = defaultNow,
  AudioContextCtor = typeof window !== "undefined"
    ? (window.AudioContext || window.webkitAudioContext)
    : null,
} = {}) {
  if (!stream) {
    return { ok: false, code: AUDIO_ERROR_CODES.AudioRuntimeStartFailed, error: "缺少 MediaStream" }
  }
  if (!AudioContextCtor) {
    return { ok: false, code: AUDIO_ERROR_CODES.AudioWorkletUnsupported, error: "当前环境不支持 AudioContext" }
  }

  let closed = false
  let context = null
  let source = null
  let workletNode = null
  let resampler = null
  let accumulator = null
  const stats = {
    inputSampleRate: null,
    outputSampleRate: VOICE_AUDIO_FORMAT.sampleRate,
    encoding: VOICE_AUDIO_FORMAT.encoding,
    channels: VOICE_AUDIO_FORMAT.channels,
    frameDurationMs: VOICE_AUDIO_FORMAT.frameDurationMs,
    samplesPerFrame: VOICE_AUDIO_FORMAT.samplesPerFrame,
    bytesPerFrame: VOICE_AUDIO_FORMAT.bytesPerFrame,
    framesGenerated: 0,
    framesSent: 0,
    bytesSent: 0,
    droppedFrames: 0,
    invalidFrames: 0,
    startedAt: 0,
  }

  function emitError(code, error) {
    onError?.({ code, error, message: error?.message || String(error || code) })
  }

  function handleSamples(samples) {
    if (closed || !resampler || !accumulator) return
    const resampled = resampler.process(samples)
    const frames = accumulator.push(resampled)
    for (const frame of frames) {
      stats.framesGenerated += 1
      try {
        onFrame?.(frame)
        stats.framesSent += 1
        stats.bytesSent += frame.byteLength || 0
      } catch (error) {
        stats.droppedFrames += 1
        console.error("[audioRuntime] onFrame failed", error)
        emitError(AUDIO_ERROR_CODES.AudioRuntimeProcessingError, error)
      }
    }
  }

  async function start() {
    if (closed) {
      return { ok: false, code: AUDIO_ERROR_CODES.AudioRuntimeStartFailed, error: "Runtime 已关闭" }
    }
    // 禁止读取 AudioContext.prototype.audioWorklet：
    // Chromium 上 audioWorklet getter 要求 receiver 是真实实例，否则 Illegal invocation。
    try {
      context = new AudioContextCtor()
      const worklet = context.audioWorklet
      if (!worklet || typeof worklet.addModule !== "function") {
        await context.close().catch(() => {})
        context = null
        return {
          ok: false,
          code: AUDIO_ERROR_CODES.AudioWorkletUnsupported,
          error: "当前浏览器不支持 AudioWorklet",
        }
      }
      await worklet.addModule(workletModuleUrl())
      source = context.createMediaStreamSource(stream)
      workletNode = new AudioWorkletNode(context, PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      })
      workletNode.port.onmessage = (event) => {
        if (closed) return
        const payload = event.data
        if (payload?.type !== "pcm" || !payload.samples) return
        try {
          handleSamples(payload.samples)
        } catch (error) {
          console.error("[audioRuntime] processing error", error)
          emitError(AUDIO_ERROR_CODES.AudioRuntimeProcessingError, error)
        }
      }
      workletNode.onprocessorerror = (event) => {
        console.error("[audioRuntime] processor error", event)
        emitError(AUDIO_ERROR_CODES.AudioRuntimeProcessingError, event)
      }
      source.connect(workletNode)
      // 不连接到 destination，避免反馈。
      if (context.state === "suspended") {
        await context.resume()
      }
      stats.inputSampleRate = context.sampleRate
      resampler = createLinearResampler(context.sampleRate, VOICE_AUDIO_FORMAT.sampleRate)
      accumulator = createAudioFrameAccumulator({
        encodePcm16le: floatToPcm16leBuffer,
        now,
      })
      stats.startedAt = now()
      return {
        ok: true,
        inputSampleRate: context.sampleRate,
        outputSampleRate: VOICE_AUDIO_FORMAT.sampleRate,
      }
    } catch (error) {
      console.error("[audioRuntime] start failed", error)
      await stop()
      const code = String(error?.message || "").includes("addModule")
        || String(error?.name || "").includes("NotSupported")
        ? AUDIO_ERROR_CODES.AudioWorkletLoadFailed
        : AUDIO_ERROR_CODES.AudioRuntimeStartFailed
      return { ok: false, code, error }
    }
  }

  async function stop() {
    closed = true
    if (workletNode) {
      try {
        workletNode.port.onmessage = null
        workletNode.disconnect()
      } catch {
        /* ignore */
      }
      workletNode = null
    }
    if (source) {
      try {
        source.disconnect()
      } catch {
        /* ignore */
      }
      source = null
    }
    if (context) {
      try {
        await context.close()
      } catch {
        /* ignore */
      }
      context = null
    }
    resampler?.reset?.()
    accumulator?.reset?.()
    resampler = null
    accumulator = null
  }

  function getStats() {
    return { ...stats }
  }

  function getContext() {
    return context
  }

  return {
    ok: true,
    start,
    stop,
    getStats,
    getContext,
  }
}
