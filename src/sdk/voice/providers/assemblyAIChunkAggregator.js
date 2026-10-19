/**
 * AssemblyAI Provider 侧音频聚合：20 ms AudioFrame → 100 ms WS binary chunk。
 * 不修改 AudioFrame / Runtime。
 */

import { VOICE_AUDIO_FORMAT } from "../../audio/audioFrame.js"

export const ASSEMBLYAI_CHUNK_DURATION_MS = 100
export const ASSEMBLYAI_FRAMES_PER_CHUNK = Math.round(
  ASSEMBLYAI_CHUNK_DURATION_MS / VOICE_AUDIO_FORMAT.frameDurationMs,
) // 5
export const ASSEMBLYAI_CHUNK_BYTES = ASSEMBLYAI_FRAMES_PER_CHUNK * VOICE_AUDIO_FORMAT.bytesPerFrame // 3200

export function createAssemblyAIChunkAggregator({
  framesPerChunk = ASSEMBLYAI_FRAMES_PER_CHUNK,
  bytesPerFrame = VOICE_AUDIO_FORMAT.bytesPerFrame,
} = {}) {
  const targetBytes = framesPerChunk * bytesPerFrame
  /** @type {Uint8Array[]} */
  let parts = []
  let pendingBytes = 0
  let pendingFrames = 0
  let chunksEmitted = 0

  function reset() {
    parts = []
    pendingBytes = 0
    pendingFrames = 0
  }

  /**
   * @param {ArrayBuffer|Uint8Array} data
   * @returns {ArrayBuffer[]}
   */
  function push(data) {
    if (!data) return []
    const bytes = data instanceof Uint8Array
      ? data
      : new Uint8Array(data)
    if (!bytes.byteLength) return []
    parts.push(bytes)
    pendingBytes += bytes.byteLength
    pendingFrames += 1
    const out = []
    while (pendingBytes >= targetBytes) {
      out.push(takeBytes(targetBytes))
      chunksEmitted += 1
    }
    return out
  }

  function takeBytes(count) {
    const buffer = new Uint8Array(count)
    let offset = 0
    while (offset < count && parts.length) {
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
    pendingBytes = Math.max(0, pendingBytes - count)
    pendingFrames = Math.floor(pendingBytes / bytesPerFrame)
    return buffer.buffer
  }

  /** Stop 时 flush 剩余合法音频（即使不足 100 ms）。 */
  function flush() {
    if (pendingBytes <= 0) return null
    const buffer = takeBytes(pendingBytes)
    if (buffer.byteLength > 0) chunksEmitted += 1
    reset()
    return buffer.byteLength > 0 ? buffer : null
  }

  function getState() {
    return {
      pendingBytes,
      pendingFrames,
      chunksEmitted,
      targetBytes,
      chunkDurationMs: framesPerChunk * VOICE_AUDIO_FORMAT.frameDurationMs,
    }
  }

  return {
    push,
    flush,
    reset,
    getState,
    targetBytes,
    framesPerChunk,
  }
}
