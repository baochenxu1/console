/**
 * 24 kHz PCM 播放队列。采样相位在块边界上连续，播放速度由输出采样率决定。
 * consumed 统计的是被音频线程消费的 24 kHz 源样本，不是 AudioContext 输出样本。
 */

export const XINQI_SOURCE_RATE = 24000
export const PLAYBACK_PROGRESS_STRIDE = 6000

export function decodePcm16leBase64(base64) {
  if (typeof base64 !== "string" || base64.length === 0 || base64.length > 2_800_000) {
    return { ok: false, error: "invalid-pcm" }
  }
  let bytes
  if (typeof Buffer !== "undefined") {
    bytes = Buffer.from(base64, "base64")
  } else {
    let binary = ""
    try {
      binary = atob(base64)
    } catch {
      return { ok: false, error: "invalid-pcm" }
    }
    bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  }
  if (!bytes.byteLength || bytes.byteLength % 2 || bytes.byteLength > 2 * 1024 * 1024) {
    return { ok: false, error: "invalid-pcm" }
  }
  const samples = new Float32Array(bytes.byteLength / 2)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getInt16(i * 2, true) / 32768
  }
  return { ok: true, samples }
}

export class PCMQueue {
  constructor(outputRate, { sourceRate = XINQI_SOURCE_RATE, bufferMs = 240, maxSeconds = 35 } = {}) {
    if (outputRate < 8000 || outputRate > 192000 || sourceRate !== XINQI_SOURCE_RATE) {
      throw new Error("Invalid PCM rate")
    }
    this.ratio = sourceRate / outputRate
    this.sourceRate = sourceRate
    this.outputRate = outputRate
    this.ring = new Float32Array(sourceRate * maxSeconds)
    this.fadeSamples = Math.ceil(outputRate * 0.005)
    this.target = Math.ceil(sourceRate * bufferMs / 1000)
    this.read = 0
    this.count = 0
    this.phase = 0
    this.waiting = true
    this.gain = 0
    this.finished = false
    this.drained = false
    this.last = 0
    this.underruns = 0
    this.consumed = 0
    this.stopValue = 0
    this.stopRemaining = 0
  }

  append(samples) {
    if (this.finished) throw new Error("PCM stream already finished")
    if (samples.length + this.count > this.ring.length) throw new Error("语音播放积压，已停止本轮回复。")
    for (let i = 0; i < samples.length; i += 1) {
      this.ring[(this.read + this.count + i) % this.ring.length] = samples[i]
    }
    this.count += samples.length
  }

  finish() {
    this.finished = true
  }

  stop() {
    this.count = 0
    this.phase = 0
    this.waiting = true
    this.finished = true
    this.stopValue = this.last
    this.stopRemaining = this.fadeSamples
  }

  render(output) {
    output.fill(0)
    let started = false
    let underrun = false
    let drained = false
    for (let i = 0; i < output.length; i += 1) {
      if (this.stopRemaining > 0) {
        output[i] = this.stopValue * (--this.stopRemaining / this.fadeSamples)
        this.last = output[i]
        continue
      }
      if (this.waiting) {
        if (this.count >= this.target || (this.finished && this.count > 0)) {
          this.waiting = false
          this.gain = 0
          started = true
        } else break
      }
      if (!this.count) {
        this.waiting = true
        if (!this.finished) {
          this.underruns += 1
          underrun = true
          this.target = Math.min(9600, this.target + 1920)
        }
        break
      }
      const a = this.ring[this.read]
      const b = this.ring[(this.read + Math.min(1, this.count - 1)) % this.ring.length]
      const edgeGain = Math.min(1, Math.max(0, this.count - this.phase - this.ratio) / (this.fadeSamples * this.ratio))
      this.gain = Math.min(1, this.gain + 1 / this.fadeSamples, edgeGain)
      output[i] = (a + (b - a) * this.phase) * this.gain * 0.9
      this.last = output[i]
      this.phase += this.ratio
      const advance = Math.min(this.count, Math.floor(this.phase + 1e-9))
      this.phase -= advance
      this.read = (this.read + advance) % this.ring.length
      this.count -= advance
      this.consumed += advance
    }
    if (this.finished && !this.count && !this.stopRemaining && !this.drained) {
      this.drained = true
      this.last = 0
      drained = true
    }
    return { started, underrun, drained }
  }
}

export function createPlaybackHolder(outputRate, queueOptions) {
  return {
    outputRate,
    queue: new PCMQueue(outputRate, queueOptions),
    id: null,
    reported: 0,
  }
}

export function handlePlaybackCommand(holder, message) {
  if (message.type === "begin") {
    const last = holder.queue.last
    holder.queue = new PCMQueue(holder.outputRate, { maxSeconds: holder.maxSeconds || 35 })
    holder.queue.stopValue = last
    holder.queue.stopRemaining = holder.queue.fadeSamples
    holder.id = message.id
    holder.reported = 0
    return
  }
  if (message.id !== holder.id) return
  if (message.type === "append") holder.queue.append(message.samples)
  if (message.type === "finish") holder.queue.finish()
  if (message.type === "stop") holder.queue.stop()
}

export function collectPlaybackNotices(holder, renderState) {
  const notices = []
  if (holder.id && (holder.queue.consumed - holder.reported >= PLAYBACK_PROGRESS_STRIDE || renderState.drained)) {
    holder.reported = holder.queue.consumed
    notices.push({ type: "progress", id: holder.id, samples: holder.reported })
  }
  if (renderState.started) notices.push({ type: "started", id: holder.id })
  if (renderState.underrun) notices.push({ type: "buffering", id: holder.id, count: holder.queue.underruns })
  if (renderState.drained) notices.push({ type: "drained", id: holder.id })
  return notices
}

/**
 * 用真实 render 推进源样本计数。progress 只在被消费且不超过已接收样本时发出。
 */
export function createPlaybackEngine({ outputRate = 48000, maxSeconds = 35, onAck = () => {} } = {}) {
  const holder = createPlaybackHolder(outputRate, { maxSeconds })
  holder.maxSeconds = maxSeconds
  let received = 0
  let played = 0
  let upstreamDone = false
  let interrupted = false
  let doneSent = false
  let state = "Idle"
  let underruns = 0
  let chunks = 0
  let closed = false
  let error = ""

  function snapshot() {
    const queued = Math.max(0, received - played)
    return {
      state,
      outputSampleRate: outputRate,
      sourceSampleRate: XINQI_SOURCE_RATE,
      chunks,
      samplesReceived: received,
      samplesPlayed: played,
      queuedMs: Math.round((queued / XINQI_SOURCE_RATE) * 1000),
      underruns,
      turnId: holder.id || "",
      error,
      doneSent,
      interrupted,
      closed,
    }
  }

  function begin(id) {
    if (closed) return { ok: false, reason: "closed" }
    handlePlaybackCommand(holder, { type: "begin", id })
    received = 0
    played = 0
    upstreamDone = false
    interrupted = false
    doneSent = false
    error = ""
    state = "Buffering"
    return { ok: true }
  }

  function appendSamples(id, samples) {
    if (closed || interrupted || id !== holder.id) return { ok: false, reason: "stale-turn" }
    if (!samples?.length) return { ok: false, reason: "empty" }
    try {
      handlePlaybackCommand(holder, { type: "append", id, samples })
    } catch (err) {
      error = err?.message || "overflow"
      state = "Error"
      interrupted = true
      handlePlaybackCommand(holder, { type: "stop", id: holder.id })
      return { ok: false, reason: "overflow" }
    }
    received += samples.length
    chunks += 1
    return { ok: true, received }
  }

  function appendBase64(id, base64, sampleRate = XINQI_SOURCE_RATE) {
    if (sampleRate !== XINQI_SOURCE_RATE) return { ok: false, reason: "sample-rate" }
    const decoded = decodePcm16leBase64(base64)
    if (!decoded.ok) return { ok: false, reason: decoded.error }
    return appendSamples(id, decoded.samples)
  }

  function acceptProgress(notice) {
    if (interrupted || notice.id !== holder.id) return { ok: false, reason: "stale-turn" }
    const samples = notice.samples
    if (!Number.isSafeInteger(samples) || samples <= played) return { ok: false, reason: "not-monotonic" }
    if (samples > received) return { ok: false, reason: "ahead-of-received" }
    played = samples
    onAck({ type: "playback.progress", id: notice.id, samples })
    return { ok: true }
  }

  function acceptDrained(notice) {
    if (interrupted || notice.id !== holder.id || doneSent) return { ok: false, reason: "stale-turn" }
    if (!upstreamDone) return { ok: true, done: false }
    doneSent = true
    state = "Completed"
    onAck({ type: "playback.done", id: notice.id })
    return { ok: true, done: true }
  }

  function render(outputLength = 128) {
    const output = new Float32Array(outputLength)
    if (closed) return { output, notices: [], ...snapshot() }
    const renderState = holder.queue.render(output)
    const notices = collectPlaybackNotices(holder, renderState)
    for (const notice of notices) {
      if (notice.type === "progress") acceptProgress(notice)
      if (notice.type === "started" && !interrupted) state = "Playing"
      if (notice.type === "buffering") {
        underruns = notice.count
        if (!interrupted && state !== "Completed") state = "Buffering"
      }
      if (notice.type === "drained") acceptDrained(notice)
    }
    return { output, notices, ...snapshot() }
  }

  function finish(id) {
    if (interrupted || id !== holder.id) return { ok: false, reason: "stale-turn" }
    handlePlaybackCommand(holder, { type: "finish", id })
    upstreamDone = true
    if (holder.queue.drained && !doneSent) {
      acceptDrained({ type: "drained", id })
    }
    return { ok: true }
  }

  function interrupt(id) {
    if (id && holder.id && id !== holder.id) return { ok: false, reason: "stale-turn" }
    interrupted = true
    doneSent = false
    state = "Interrupted"
    if (holder.id) handlePlaybackCommand(holder, { type: "stop", id: holder.id })
    holder.id = null
    return { ok: true }
  }

  function stop() {
    interrupted = true
    state = holder.id || played ? "Interrupted" : "Idle"
    if (holder.id) handlePlaybackCommand(holder, { type: "stop", id: holder.id })
    holder.id = null
    return { ok: true }
  }

  function close() {
    stop()
    closed = true
    state = "Idle"
    return { ok: true }
  }

  return {
    begin,
    appendSamples,
    appendBase64,
    render,
    finish,
    interrupt,
    stop,
    close,
    acceptProgress,
    acceptDrained,
    getState: snapshot,
  }
}

export function composePlaybackWorkletSource(queueSource, processorSource) {
  const queue = String(queueSource).replace(/^\s*export\s+/gm, "")
  const processor = String(processorSource).replace(/import\s+\{[^}]+\}\s+from\s+["'][^"']+["']\s*;?/g, "")
  return `${queue}\n${processor}`
}
