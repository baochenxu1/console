/**
 * SlcanStreamFramer — arbitrary ASCII/byte chunks → complete SLCAN lines.
 * Split by CR (0x0D) ONLY. Does not decode CanFrame (that is SlcanCodec).
 */

/**
 * @returns {{
 *   feed: (chunk: Uint8Array|string|ArrayBuffer|ArrayBufferView) => string[],
 *   clear: () => void,
 *   pending: () => string,
 * }}
 */
export function createSlcanStreamFramer() {
  let buffer = ""

  function chunkToString(chunk) {
    if (chunk == null) return ""
    if (typeof chunk === "string") return chunk
    if (chunk instanceof Uint8Array) {
      return new TextDecoder().decode(chunk)
    }
    if (ArrayBuffer.isView(chunk)) {
      return new TextDecoder().decode(
        new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      )
    }
    if (chunk instanceof ArrayBuffer) {
      return new TextDecoder().decode(new Uint8Array(chunk))
    }
    return String(chunk)
  }

  return {
    /**
     * Feed a chunk; return zero or more complete lines (CR stripped, no LF split).
     * @param {Uint8Array|string|ArrayBuffer|ArrayBufferView} chunk
     * @returns {string[]}
     */
    feed(chunk) {
      buffer += chunkToString(chunk)
      const lines = []
      // Split on CR only; leave incomplete tail in buffer.
      for (;;) {
        const idx = buffer.indexOf("\r")
        if (idx < 0) break
        lines.push(buffer.slice(0, idx))
        buffer = buffer.slice(idx + 1)
      }
      return lines
    },

    clear() {
      buffer = ""
    },

    /** Incomplete trailing bytes (no CR yet), for diagnostics. */
    pending() {
      return buffer
    },
  }
}
