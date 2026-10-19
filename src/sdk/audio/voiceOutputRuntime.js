/**
 * 浏览器播放运行时。XinqiProvider 不碰 AudioContext。
 * 进度样本来自 Playback Worklet 实际消费的 24 kHz 源样本。
 */

import {
  composePlaybackWorkletSource,
  createPlaybackEngine,
  decodePcm16leBase64,
  XINQI_SOURCE_RATE,
} from "./pcmPlaybackQueue.js"

export const PLAYBACK_STATES = Object.freeze({
  Idle: "Idle",
  Buffering: "Buffering",
  Playing: "Playing",
  Completed: "Completed",
  Interrupted: "Interrupted",
  Error: "Error",
})

/**
 * 读取 Worklet 源码。拒绝依赖 fetch(data:)（CSP / 部分浏览器不可靠）；
 * 生产构建必须把 processor/queue 发成独立 HTTP 资产。
 */
export async function readPlaybackWorkletModuleText(moduleUrl, fetchImpl = globalThis.fetch) {
  const href = String(moduleUrl?.href || moduleUrl || "")
  if (!href) throw new Error("无法加载播放 AudioWorklet。")
  if (href.startsWith("data:")) {
    throw new Error("播放 AudioWorklet 被内联为 data: URL，生产构建无效。")
  }
  if (typeof fetchImpl !== "function") throw new Error("无法加载播放 AudioWorklet。")
  const response = await fetchImpl(href)
  if (!response?.ok) throw new Error("无法加载播放 AudioWorklet。")
  return response.text()
}

export async function loadPlaybackWorklet(audioWorklet, fetchImpl = globalThis.fetch) {
  const queueUrl = new URL("./pcmPlaybackQueue.js", import.meta.url)
  const processorUrl = new URL("./worklets/pcmPlaybackProcessor.js", import.meta.url)
  const [queueText, processorText] = await Promise.all([
    readPlaybackWorkletModuleText(queueUrl, fetchImpl),
    readPlaybackWorkletModuleText(processorUrl, fetchImpl),
  ])
  const source = composePlaybackWorkletSource(queueText, processorText)
  const blob = new Blob([source], { type: "text/javascript" })
  const url = URL.createObjectURL(blob)
  try {
    await audioWorklet.addModule(url)
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function createVoiceOutputRuntime({
  AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext,
  sinkId = "",
  onAck = () => {},
  onState = () => {},
  fetchImpl,
  engineFactory = createPlaybackEngine,
} = {}) {
  let context = null
  let node = null
  let engine = null
  let started = false
  let playbackError = ""
  let workletState = "idle"
  let activeSinkId = ""
  let sinkFallback = false

  function publish(extra = {}) {
    onState?.({
      ...(engine?.getState?.() || { state: PLAYBACK_STATES.Idle }),
      error: playbackError,
      contextState: context?.state || "none",
      workletState,
      outputDeviceId: activeSinkId || "(default)",
      sinkFallback,
      ...extra,
    })
  }

  function fail(code, message) {
    playbackError = message
    workletState = code === "OUTPUT_WORKLET_FAILED" ? "failed" : workletState
    publish({ state: PLAYBACK_STATES.Error, error: message, code })
    return { ok: false, code, error: message }
  }

  function prime() {
    if (context) return { ok: true }
    if (!AudioContextCtor) return { ok: false, error: "当前环境没有 AudioContext。" }
    context = new AudioContextCtor({ latencyHint: "interactive" })
    if (context.state === "suspended" && context.resume) {
      const pending = context.resume()
      if (pending && typeof pending.catch === "function") pending.catch(() => {})
    }
    return { ok: true }
  }

  function onWorkletMessage(data) {
    if (!engine || !data) return
    if (data.type === "error") {
      playbackError = data.message || "播放失败"
      engine.interrupt(data.id)
      publish({ state: PLAYBACK_STATES.Error, error: playbackError })
      return
    }
    const current = engine.getState().turnId
    if (!current || data.id !== current) return
    if (data.type === "progress") engine.acceptProgress(data)
    if (data.type === "drained") engine.acceptDrained(data)
    if (data.type === "buffering") publish({ state: PLAYBACK_STATES.Buffering, underruns: data.count })
    else if (data.type === "started") publish({ state: PLAYBACK_STATES.Playing })
    else publish()
  }

  async function applySinkId(preferred) {
    activeSinkId = ""
    sinkFallback = false
    const requested = String(preferred || "")
    if (!requested) return { ok: true }
    if (typeof context.setSinkId !== "function") {
      return { ok: false, code: "OUTPUT_DEVICE_UNAVAILABLE", error: "当前浏览器不能切换音频输出设备。" }
    }
    try {
      await context.setSinkId(requested)
      activeSinkId = requested
      return { ok: true }
    } catch {
      try {
        await context.setSinkId("")
        activeSinkId = ""
        sinkFallback = true
        return { ok: true, fallback: true }
      } catch {
        return { ok: false, code: "OUTPUT_DEVICE_UNAVAILABLE", error: "所选输出设备不可用，且无法回退到默认设备。" }
      }
    }
  }

  async function start() {
    if (!AudioContextCtor) return fail("OUTPUT_UNSUPPORTED", "当前环境没有 AudioContext。")
    if (!context) prime()
    try {
      if (context.state === "suspended" && context.resume) await context.resume()
    } catch {
      return fail("OUTPUT_SUSPENDED", "浏览器阻止了音频播放，请再次点击「连接并开始」。")
    }
    if (context.state === "suspended") {
      return fail("OUTPUT_SUSPENDED", "浏览器阻止了音频播放，请再次点击「连接并开始」。")
    }
    const outputRate = Number(context.sampleRate) || 0
    if (outputRate < 8000) return fail("OUTPUT_DEVICE_UNAVAILABLE", "输出设备采样率不可用。")
    const sinkResult = await applySinkId(sinkId)
    if (!sinkResult.ok) return fail(sinkResult.code, sinkResult.error)
    engine = engineFactory({ outputRate, onAck })
    if (!context.audioWorklet?.addModule) {
      return fail("OUTPUT_WORKLET_FAILED", "当前环境没有 AudioWorklet。")
    }
    workletState = "loading"
    try {
      await loadPlaybackWorklet(context.audioWorklet, fetchImpl)
      node = new AudioWorkletNode(context, "playback-processor", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      })
      node.connect(context.destination)
      node.port.onmessage = (event) => onWorkletMessage(event.data)
      workletState = "ready"
    } catch (error) {
      workletState = "failed"
      return fail("OUTPUT_WORKLET_FAILED", error?.message || "播放 Worklet 加载失败。")
    }
    started = true
    playbackError = ""
    publish()
    return {
      ok: true,
      outputSampleRate: outputRate,
      sourceSampleRate: XINQI_SOURCE_RATE,
      sinkFallback,
    }
  }

  function requireEngine() {
    if (!engine || !started) return null
    return engine
  }

  function begin(id) {
    const active = requireEngine()
    if (!active) return { ok: false, reason: "not-started" }
    const result = active.begin(id)
    node?.port.postMessage({ type: "begin", id })
    publish()
    return result
  }

  function appendBase64(id, base64, sampleRate = XINQI_SOURCE_RATE) {
    const active = requireEngine()
    if (!active) return { ok: false, reason: "not-started" }
    const decoded = decodePcm16leBase64(base64)
    if (!decoded.ok || sampleRate !== XINQI_SOURCE_RATE) return { ok: false, reason: "invalid-pcm" }
    const result = active.appendSamples(id, decoded.samples)
    if (result.ok && node) {
      const copy = new Float32Array(decoded.samples)
      node.port.postMessage({ type: "append", id, samples: copy }, [copy.buffer])
    }
    publish()
    return result
  }

  function finish(id) {
    const active = requireEngine()
    if (!active) return { ok: false, reason: "not-started" }
    const result = active.finish(id)
    node?.port.postMessage({ type: "finish", id })
    publish()
    return result
  }

  function interrupt(id) {
    const active = requireEngine()
    if (!active) return { ok: false, reason: "not-started" }
    const current = active.getState().turnId
    if (current) node?.port.postMessage({ type: "stop", id: current })
    const result = active.interrupt(id)
    publish()
    return result
  }

  function stop() {
    const current = engine?.getState?.().turnId
    if (current) node?.port.postMessage({ type: "stop", id: current })
    const result = engine?.stop?.() || { ok: true }
    publish()
    return result
  }

  async function close() {
    stop()
    if (node) {
      try { node.port.onmessage = null } catch { /* ignore */ }
      try { node.disconnect() } catch { /* ignore */ }
      node = null
    }
    if (context && context.state !== "closed") {
      try { await context.close() } catch { /* ignore */ }
    }
    context = null
    started = false
    playbackError = ""
    publish({ state: PLAYBACK_STATES.Idle, error: "" })
    return { ok: true }
  }

  return {
    prime,
    start,
    begin,
    appendBase64,
    finish,
    interrupt,
    stop,
    close,
    getState: () => ({
      ...(engine?.getState?.() || {
        state: playbackError ? PLAYBACK_STATES.Error : PLAYBACK_STATES.Idle,
        outputSampleRate: context?.sampleRate || null,
        sourceSampleRate: XINQI_SOURCE_RATE,
        chunks: 0,
        samplesReceived: 0,
        samplesPlayed: 0,
        queuedMs: 0,
        underruns: 0,
        turnId: "",
        doneSent: false,
      }),
      error: playbackError,
      contextState: context?.state || "none",
      workletState,
      outputDeviceId: activeSinkId || "(default)",
      sinkFallback,
      started,
    }),
  }
}
