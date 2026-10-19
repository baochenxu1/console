/**
 * Xinqi Provider 侧音频聚合：5 × 20 ms / 640 B → 100 ms / 3200 B。
 * 不足一整块的尾音丢弃，不补静音，不修改 PCM。
 */

import { VOICE_AUDIO_FORMAT } from "../../audio/audioFrame.js"

export const XINQI_CHUNK_DURATION_MS = 100
export const XINQI_FRAMES_PER_CHUNK = 5
export const XINQI_CHUNK_BYTES = XINQI_FRAMES_PER_CHUNK * VOICE_AUDIO_FORMAT.bytesPerFrame
export const XINQI_MAX_PENDING_FRAMES = 25

export function createXinqiChunkAggregator({
  framesPerChunk = XINQI_FRAMES_PER_CHUNK,
  bytesPerFrame = VOICE_AUDIO_FORMAT.bytesPerFrame,
  maxPendingFrames = XINQI_MAX_PENDING_FRAMES,
} = {}) {
  const targetBytes = framesPerChunk * bytesPerFrame
  /** @type {Uint8Array[]} */
  let parts = []
  let pendingBytes = 0
  let pendingFrames = 0
  let droppedFrames = 0

  function reset() {
    parts = []
    pendingBytes = 0
    pendingFrames = 0
  }

  /**
   * @param {ArrayBuffer|Uint8Array} data
   * @returns {{ chunks: ArrayBuffer[], dropped: number }}
   */
  function push(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data || new ArrayBuffer(0))
    if (bytes.byteLength !== bytesPerFrame) {
      droppedFrames += 1
      return { chunks: [], dropped: 1, reason: "frame_bytes" }
    }
    if (pendingFrames >= maxPendingFrames) {
      droppedFrames += 1
      return { chunks: [], dropped: 1, reason: "queue_full" }
    }
    parts.push(bytes)
    pendingBytes += bytes.byteLength
    pendingFrames += 1
    const chunks = []
    while (pendingBytes >= targetBytes) {
      chunks.push(takeExact(targetBytes))
    }
    return { chunks, dropped: 0 }
  }

  function takeExact(count) {
    const buffer = new Uint8Array(count)
    let offset = 0
    while (offset < count) {
      const head = parts[0]
      const need = count - offset
      if (head.byteLength <= need) {
        buffer.set(head, offset)
        offset += head.byteLength
        parts.shift()
      } else {
        buffer.set(head.subarray(0, need), offset)
        parts[0] = head.subarray(need)
        offset += need
      }
    }
    pendingBytes -= count
    pendingFrames = Math.floor(pendingBytes / bytesPerFrame)
    return buffer.buffer
  }

  /** 断开时丢弃不足 3200 B 的尾块。 */
  function discardTail() {
    const dropped = pendingFrames
    droppedFrames += dropped
    reset()
    return dropped
  }

  function getState() {
    return {
      pendingBytes,
      pendingFrames,
      droppedFrames,
      targetBytes,
      chunkDurationMs: XINQI_CHUNK_DURATION_MS,
    }
  }

  return { push, discardTail, reset, getState, targetBytes }
}
