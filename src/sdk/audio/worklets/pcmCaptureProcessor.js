/**
 * AudioWorklet：从 input 取 Float32，downmix 为 mono，发给主线程。
 * 不做网络、不做 Provider。
 */

class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true
    const channel0 = input[0]
    if (!channel0 || channel0.length === 0) return true
    const frames = channel0.length
    const channels = input.length
    const mono = new Float32Array(frames)
    if (channels === 1) {
      mono.set(channel0)
    } else {
      for (let i = 0; i < frames; i += 1) {
        let sum = 0
        for (let c = 0; c < channels; c += 1) {
          const lane = input[c]
          sum += lane ? lane[i] || 0 : 0
        }
        mono[i] = sum / channels
      }
    }
    this.port.postMessage({ type: "pcm", samples: mono, channels }, [mono.buffer])
    return true
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor)
