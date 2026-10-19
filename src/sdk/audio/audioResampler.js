/**
 * 流式线性插值重采样。跨 block 保持 fractional read position。
 */

export function createLinearResampler(inputRate, outputRate = 16000) {
  const from = Number(inputRate)
  const to = Number(outputRate)
  if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to) || to <= 0) {
    throw new Error(`非法采样率：${inputRate} → ${outputRate}`)
  }
  /** 每产生 1 个输出样本，在输入时间轴上前进的样本数。 */
  const ratio = from / to
  /** @type {number[]} */
  let buffer = []
  let readPos = 0

  /**
   * @param {ArrayLike<number>} input
   * @returns {Float32Array}
   */
  function process(input) {
    const block = input || []
    for (let i = 0; i < block.length; i += 1) {
      buffer.push(Number(block[i]) || 0)
    }
    if (buffer.length < 2) return new Float32Array(0)

    const out = []
    while (true) {
      const index = Math.floor(readPos)
      const next = index + 1
      if (next >= buffer.length) break
      const frac = readPos - index
      const s0 = buffer[index]
      const s1 = buffer[next]
      out.push(s0 + (s1 - s0) * frac)
      readPos += ratio
    }
    const maxDrop = Math.max(0, buffer.length - 1)
    const drop = Math.min(Math.floor(readPos), maxDrop)
    if (drop > 0) {
      buffer = buffer.slice(drop)
      readPos -= drop
    }
    return Float32Array.from(out)
  }

  function reset() {
    buffer = []
    readPos = 0
  }

  function pendingInputSamples() {
    return buffer.length
  }

  return {
    inputRate: from,
    outputRate: to,
    ratio,
    process,
    reset,
    pendingInputSamples,
  }
}
