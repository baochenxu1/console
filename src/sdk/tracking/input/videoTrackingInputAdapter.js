/**
 * 浏览器侧 video 输入 adapter 占位（Phase 1 主路径在 Python OpenCV）。
 * 后续本地文件 / HTMLVideoElement 帧流可在此实现。
 */

/** @typedef {import("./trackingInputFrame.js").TrackingInputFrame} TrackingInputFrame */

export class VideoTrackingInputAdapter {
  /**
   * @param {string} sourceId
   * @param {number} [playbackRate]
   */
  constructor(sourceId, playbackRate = 1.0) {
    this.sourceId = String(sourceId || "video-unknown")
    this.playbackRate = Number(playbackRate) || 1.0
    this.#sourceSeq = 0
    this.#seekEpoch = 0
  }

  /** @type {number} */
  #sourceSeq = 0
  /** @type {number} */
  #seekEpoch = 0

  /**
   * @param {HTMLVideoElement | HTMLCanvasElement} image
   * @param {object} timing
   * @param {number} timing.videoTimeMs
   * @param {number} timing.frameIndex
   * @returns {TrackingInputFrame}
   */
  nextFrame(image, { videoTimeMs, frameIndex }) {
    const vtm = Number(videoTimeMs) || 0
    this.#sourceSeq += 1
    return {
      sourceType: "video",
      sourceId: this.sourceId,
      sourceSeq: this.#sourceSeq,
      frameIndex: Number(frameIndex) || this.#sourceSeq - 1,
      timestampMs: vtm,
      videoTimeMs: vtm,
      playbackRate: this.playbackRate,
      paused: false,
      seeking: false,
      seekEpoch: this.#seekEpoch,
      image,
    }
  }

  /** @param {number} _videoTimeMs */
  seek(_videoTimeMs) {
    this.#seekEpoch += 1
  }

  reset() {
    this.#sourceSeq = 0
    this.#seekEpoch = 0
  }
}
