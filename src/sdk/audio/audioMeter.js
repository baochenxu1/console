/**
 * 最小实时音量 + USB 通道诊断。
 * Mono：MediaStreamSource → Analyser
 * Stereo：Source → ChannelSplitter(2) → Analyser0 / Analyser1
 * 不做 downmix 后再假装拆通道。
 */

const LOW_SIGNAL_RMS = 0.005
const NEAR_IDENTICAL_CORR = 0.995
const LOW_DIFFERENCE = 0.02

export function byteTimeDomainToFloatSamples(values) {
  const length = values?.length || 0
  const out = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    out[i] = (values[i] - 128) / 128
  }
  return out
}

/** @deprecated 兼容旧名；新代码用 calculateRms + byteTimeDomainToFloatSamples */
export function computeRmsFromTimeDomain(values) {
  return calculateRms(byteTimeDomainToFloatSamples(values))
}

export function computePeakFromTimeDomain(values) {
  return calculatePeak(byteTimeDomainToFloatSamples(values))
}

export function calculateRms(samples) {
  if (!samples?.length) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Number(samples[i]) || 0
    sum += sample * sample
  }
  return Math.sqrt(sum / samples.length)
}

export function calculatePeak(samples) {
  if (!samples?.length) return 0
  let peak = 0
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.abs(Number(samples[i]) || 0)
    if (sample > peak) peak = sample
  }
  return peak
}

/**
 * Pearson correlation。静音 / 零方差时返回 null（调用方显示 N/A 或 LOW_SIGNAL）。
 */
export function calculateCorrelation(left, right) {
  const n = Math.min(left?.length || 0, right?.length || 0)
  if (n < 2) return null
  let sumX = 0
  let sumY = 0
  for (let i = 0; i < n; i += 1) {
    sumX += Number(left[i]) || 0
    sumY += Number(right[i]) || 0
  }
  const meanX = sumX / n
  const meanY = sumY / n
  let num = 0
  let denX = 0
  let denY = 0
  for (let i = 0; i < n; i += 1) {
    const dx = (Number(left[i]) || 0) - meanX
    const dy = (Number(right[i]) || 0) - meanY
    num += dx * dy
    denX += dx * dx
    denY += dy * dy
  }
  if (denX <= 1e-12 || denY <= 1e-12) return null
  const corr = num / Math.sqrt(denX * denY)
  if (!Number.isFinite(corr)) return null
  return Math.max(-1, Math.min(1, corr))
}

/** mean(|ch0 - ch1|)，样本应为 [-1, 1]。 */
export function calculateChannelDifference(left, right) {
  const n = Math.min(left?.length || 0, right?.length || 0)
  if (!n) return null
  let sum = 0
  for (let i = 0; i < n; i += 1) {
    sum += Math.abs((Number(left[i]) || 0) - (Number(right[i]) || 0))
  }
  return sum / n
}

export function buildChannelDiagnosticHint({
  actualChannels,
  rms0,
  rms1,
  correlation,
  difference,
} = {}) {
  const channels = Number(actualChannels)
  if (!Number.isFinite(channels) || channels < 1) {
    return "Waiting for actual channelCount from track.getSettings()."
  }
  if (channels === 1) {
    return "Browser is currently receiving a mono stream."
  }
  const left = Number(rms0) || 0
  const right = Number(rms1) || 0
  const lowLeft = left < LOW_SIGNAL_RMS
  const lowRight = right < LOW_SIGNAL_RMS
  if (lowLeft !== lowRight) {
    return "One logical channel has significantly lower signal level."
  }
  if (correlation == null || difference == null || (lowLeft && lowRight)) {
    return "Stereo logical channels are present, but signal is too low for a stable comparison."
  }
  if (correlation > NEAR_IDENTICAL_CORR && difference < LOW_DIFFERENCE) {
    return "CH0 and CH1 are nearly identical. The USB stream may contain duplicated audio rather than independent microphone channels."
  }
  return "CH0 and CH1 contain measurably different signals."
}

function createAnalyser(context) {
  const analyser = context.createAnalyser()
  analyser.fftSize = 2048
  analyser.smoothingTimeConstant = 0.8
  return analyser
}

function readFloatTimeDomain(analyser, byteBuffer, floatBuffer) {
  if (typeof analyser.getFloatTimeDomainData === "function") {
    analyser.getFloatTimeDomainData(floatBuffer)
    return floatBuffer
  }
  analyser.getByteTimeDomainData(byteBuffer)
  const converted = byteTimeDomainToFloatSamples(byteBuffer)
  floatBuffer.set(converted)
  return floatBuffer
}

export function createAudioMeter({
  stream,
  actualChannelCount = 1,
  AudioContextCtor = typeof window !== "undefined"
    ? (window.AudioContext || window.webkitAudioContext)
    : null,
} = {}) {
  if (!stream) return { ok: false, error: "缺少 MediaStream" }
  if (!AudioContextCtor) return { ok: false, error: "当前环境不支持 AudioContext" }

  let closed = false
  const channels = Math.max(1, Math.floor(Number(actualChannelCount) || 1))
  const stereo = channels >= 2
  const context = new AudioContextCtor()
  const source = context.createMediaStreamSource(stream)
  const mixAnalyser = createAnalyser(context)
  source.connect(mixAnalyser)

  let splitter = null
  let analyser0 = null
  let analyser1 = null
  if (stereo) {
    splitter = context.createChannelSplitter(2)
    analyser0 = createAnalyser(context)
    analyser1 = createAnalyser(context)
    source.connect(splitter)
    splitter.connect(analyser0, 0)
    splitter.connect(analyser1, 1)
  }

  const mixByte = new Uint8Array(mixAnalyser.fftSize)
  const mixFloat = new Float32Array(mixAnalyser.fftSize)
  const ch0Float = stereo ? new Float32Array(analyser0.fftSize) : null
  const ch1Float = stereo ? new Float32Array(analyser1.fftSize) : null
  const ch0Byte = stereo ? new Uint8Array(analyser0.fftSize) : null
  const ch1Byte = stereo ? new Uint8Array(analyser1.fftSize) : null

  function readLevel() {
    if (closed) {
      return {
        rms: 0,
        peak: 0,
        actualChannels: channels,
        stereo: false,
        rms0: 0,
        rms1: null,
        peak0: 0,
        peak1: null,
        correlation: null,
        difference: null,
        correlationLabel: "N/A",
        differenceLabel: "N/A",
        hint: buildChannelDiagnosticHint({ actualChannels: channels }),
      }
    }
    readFloatTimeDomain(mixAnalyser, mixByte, mixFloat)
    const rms = calculateRms(mixFloat)
    const peak = calculatePeak(mixFloat)
    if (!stereo) {
      return {
        rms,
        peak,
        actualChannels: channels,
        stereo: false,
        rms0: rms,
        rms1: null,
        peak0: peak,
        peak1: null,
        correlation: null,
        difference: null,
        correlationLabel: "N/A",
        differenceLabel: "N/A",
        hint: buildChannelDiagnosticHint({ actualChannels: 1, rms0: rms }),
      }
    }
    readFloatTimeDomain(analyser0, ch0Byte, ch0Float)
    readFloatTimeDomain(analyser1, ch1Byte, ch1Float)
    const rms0 = calculateRms(ch0Float)
    const rms1 = calculateRms(ch1Float)
    const peak0 = calculatePeak(ch0Float)
    const peak1 = calculatePeak(ch1Float)
    const correlation = calculateCorrelation(ch0Float, ch1Float)
    const difference = calculateChannelDifference(ch0Float, ch1Float)
    const lowSignal = rms0 < LOW_SIGNAL_RMS && rms1 < LOW_SIGNAL_RMS
    return {
      rms,
      peak,
      actualChannels: channels,
      stereo: true,
      rms0,
      rms1,
      peak0,
      peak1,
      correlation,
      difference,
      correlationLabel: correlation == null ? (lowSignal ? "LOW_SIGNAL" : "N/A") : correlation.toFixed(4),
      differenceLabel: difference == null ? "N/A" : difference.toFixed(4),
      hint: buildChannelDiagnosticHint({
        actualChannels: channels,
        rms0,
        rms1,
        correlation,
        difference,
      }),
    }
  }

  async function resume() {
    if (closed) return
    if (context.state === "suspended") {
      try {
        await context.resume()
      } catch {
        /* ignore */
      }
    }
  }

  async function close() {
    if (closed) return
    closed = true
    const nodes = [source, mixAnalyser, splitter, analyser0, analyser1].filter(Boolean)
    for (const node of nodes) {
      try {
        node.disconnect()
      } catch {
        /* ignore */
      }
    }
    try {
      await context.close()
    } catch {
      /* ignore */
    }
  }

  return {
    ok: true,
    context,
    stereo,
    actualChannels: channels,
    readLevel,
    resume,
    close,
    getSampleRate: () => context.sampleRate,
    getState: () => context.state,
  }
}
