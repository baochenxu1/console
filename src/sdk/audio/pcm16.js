/**
 * Float32 [-1, 1] → PCM signed 16-bit little-endian。
 */

export function clampFloatSample(sample) {
  const value = Number(sample) || 0
  if (value > 1) return 1
  if (value < -1) return -1
  return value
}

/** 单样本 → Int16（负端 -32768，正端 32767）。 */
export function floatSampleToInt16(sample) {
  const clamped = clampFloatSample(sample)
  if (clamped < 0) return Math.round(clamped * 32768)
  return Math.round(clamped * 32767)
}

/**
 * @param {ArrayLike<number>} samples
 * @returns {Int16Array}
 */
export function floatToPcm16(samples) {
  const length = samples?.length || 0
  const out = new Int16Array(length)
  for (let i = 0; i < length; i += 1) {
    out[i] = floatSampleToInt16(samples[i])
  }
  return out
}

/**
 * 明确写出 little-endian 字节（不依赖宿主 endian）。
 * @param {ArrayLike<number>} samples Float32
 * @returns {ArrayBuffer}
 */
export function floatToPcm16leBuffer(samples) {
  const length = samples?.length || 0
  const buffer = new ArrayBuffer(length * 2)
  const view = new DataView(buffer)
  for (let i = 0; i < length; i += 1) {
    view.setInt16(i * 2, floatSampleToInt16(samples[i]), true)
  }
  return buffer
}

export function readPcm16leSample(buffer, index = 0) {
  const view = new DataView(buffer)
  return view.getInt16(index * 2, true)
}
