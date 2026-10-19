/**
 * FaceDEV Voice Input v1 AudioFrame。
 */

function defaultNow() {
  if (typeof globalThis.performance?.now === "function") {
    return globalThis.performance.now()
  }
  return Date.now()
}

export const VOICE_AUDIO_FORMAT = Object.freeze({
  sampleRate: 16000,
  channels: 1,
  encoding: "pcm_s16le",
  frameDurationMs: 20,
  samplesPerFrame: 320,
  bytesPerFrame: 640,
})

/**
 * @param {object} params
 */
export function createAudioFrame({
  sequence,
  timestampMs,
  data,
  sampleRate = VOICE_AUDIO_FORMAT.sampleRate,
  channels = VOICE_AUDIO_FORMAT.channels,
  encoding = VOICE_AUDIO_FORMAT.encoding,
  frameDurationMs = VOICE_AUDIO_FORMAT.frameDurationMs,
  samples = VOICE_AUDIO_FORMAT.samplesPerFrame,
} = {}) {
  const buffer = data instanceof ArrayBuffer
    ? data
    : data?.buffer
      ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
      : null
  return {
    sequence: Number(sequence) || 0,
    timestampMs: Number(timestampMs) || 0,
    sampleRate,
    channels,
    encoding,
    frameDurationMs,
    samples,
    data: buffer,
    byteLength: buffer ? buffer.byteLength : 0,
  }
}

export function validateAudioFrame(frame) {
  if (!frame || typeof frame !== "object") {
    return { ok: false, reason: "missing", message: "AudioFrame 缺失" }
  }
  if (frame.sampleRate !== VOICE_AUDIO_FORMAT.sampleRate) {
    return { ok: false, reason: "sampleRate", message: `sampleRate 必须是 ${VOICE_AUDIO_FORMAT.sampleRate}` }
  }
  if (frame.channels !== VOICE_AUDIO_FORMAT.channels) {
    return { ok: false, reason: "channels", message: "channels 必须是 1" }
  }
  if (frame.encoding !== VOICE_AUDIO_FORMAT.encoding) {
    return { ok: false, reason: "encoding", message: "encoding 必须是 pcm_s16le" }
  }
  if (frame.samples !== VOICE_AUDIO_FORMAT.samplesPerFrame) {
    return { ok: false, reason: "samples", message: `samples 必须是 ${VOICE_AUDIO_FORMAT.samplesPerFrame}` }
  }
  if (!frame.data || frame.data.byteLength !== VOICE_AUDIO_FORMAT.bytesPerFrame) {
    return { ok: false, reason: "bytes", message: `byteLength 必须是 ${VOICE_AUDIO_FORMAT.bytesPerFrame}` }
  }
  if (!Number.isFinite(Number(frame.sequence))) {
    return { ok: false, reason: "sequence", message: "sequence 无效" }
  }
  return { ok: true }
}

/**
 * 累计 resampled Float32，满 320 样本生成一帧 PCM16LE。
 */
export function createAudioFrameAccumulator({
  samplesPerFrame = VOICE_AUDIO_FORMAT.samplesPerFrame,
  encodePcm16le,
  now = defaultNow,
} = {}) {
  if (typeof encodePcm16le !== "function") {
    throw new Error("encodePcm16le 必需")
  }
  let pending = new Float32Array(0)
  let sequence = 0

  function push(samples) {
    const incoming = samples instanceof Float32Array ? samples : Float32Array.from(samples || [])
    if (!incoming.length) return []
    const merged = new Float32Array(pending.length + incoming.length)
    merged.set(pending, 0)
    merged.set(incoming, pending.length)
    const frames = []
    let offset = 0
    while (offset + samplesPerFrame <= merged.length) {
      const slice = merged.subarray(offset, offset + samplesPerFrame)
      sequence += 1
      const data = encodePcm16le(slice)
      frames.push(createAudioFrame({
        sequence,
        timestampMs: now(),
        data,
        samples: samplesPerFrame,
      }))
      offset += samplesPerFrame
    }
    pending = merged.slice(offset)
    return frames
  }

  function reset() {
    pending = new Float32Array(0)
    sequence = 0
  }

  function pendingSamples() {
    return pending.length
  }

  function nextSequence() {
    return sequence + 1
  }

  return { push, reset, pendingSamples, nextSequence, get sequence() { return sequence } }
}
