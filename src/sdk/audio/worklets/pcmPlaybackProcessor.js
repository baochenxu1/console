import { collectPlaybackNotices, handlePlaybackCommand, PCMQueue } from "../pcmPlaybackQueue.js"

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.holder = {
      outputRate: sampleRate,
      queue: new PCMQueue(sampleRate),
      id: null,
      reported: 0,
    }
    this.port.onmessage = ({ data }) => {
      try {
        handlePlaybackCommand(this.holder, data)
      } catch (error) {
        if (this.holder.id) handlePlaybackCommand(this.holder, { type: "stop", id: this.holder.id })
        this.port.postMessage({ type: "error", id: this.holder.id, message: error?.message || "playback failed" })
      }
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0]?.[0]
    if (!output) return true
    const renderState = this.holder.queue.render(output)
    const notices = collectPlaybackNotices(this.holder, renderState)
    for (const notice of notices) this.port.postMessage(notice)
    return true
  }
}

registerProcessor("playback-processor", PlaybackProcessor)
