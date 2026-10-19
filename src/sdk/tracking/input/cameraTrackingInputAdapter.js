/**
 * 浏览器侧 camera 输入 → TrackingInputFrame。
 * Phase 0 主路径在 Python OpenCV；此类供后续浏览器本地 MediaPipe 或测试使用。
 */

/** @typedef {import("./trackingInputFrame.js").TrackingInputFrame} TrackingInputFrame */
/** @typedef {import("./trackingInputFrame.js").TrackingInputSource} TrackingInputSource */

export class CameraTrackingInputAdapter {
  /** @type {number} */
  #sourceSeq = 0
  /** @type {number} */
  #frameIndex = 0

  /**
   * @param {string} [sourceId]
   */
  constructor(sourceId = "camera-default") {
    /** @type {string} */
    this.sourceId = String(sourceId || "camera-default")
  }

  /**
   * @param {HTMLVideoElement | HTMLCanvasElement} image
   * @param {number} [timestampMs]
   * @returns {TrackingInputFrame}
   */
  nextFrame(image, timestampMs) {
    const now =
      timestampMs ??
      (typeof performance !== "undefined" ? performance.now() : Date.now())

    this.#sourceSeq += 1
    this.#frameIndex += 1

    return {
      sourceType: "camera",
      sourceId: this.sourceId,
      sourceSeq: this.#sourceSeq,
      frameIndex: this.#frameIndex,
      timestampMs: now,
      image,
    }
  }

  /**
   * @param {string} [reason]
   */
  reset(reason) {
    void reason
    this.#sourceSeq = 0
    this.#frameIndex = 0
  }
}

/**
 * @param {HTMLVideoElement | HTMLCanvasElement} image
 * @param {object} [options]
 * @param {string} [options.sourceId]
 * @param {number} [options.timestampMs]
 * @param {number} [options.sourceSeq]
 * @param {number} [options.frameIndex]
 * @returns {TrackingInputFrame}
 */
export function createCameraTrackingInputFrame(
  image,
  { sourceId = "camera-default", timestampMs, sourceSeq, frameIndex } = {},
) {
  const now =
    timestampMs ??
    (typeof performance !== "undefined" ? performance.now() : Date.now())
  return {
    sourceType: "camera",
    sourceId: String(sourceId),
    sourceSeq: Number.isFinite(Number(sourceSeq)) ? Number(sourceSeq) : 1,
    frameIndex: Number.isFinite(Number(frameIndex)) ? Number(frameIndex) : 1,
    timestampMs: now,
    image,
  }
}
