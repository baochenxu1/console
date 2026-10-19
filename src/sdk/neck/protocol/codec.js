/**
 * Binary codec helpers — explicit int16 range checks (no silent bitwise wrap).
 */

export class CodecError extends Error {
  constructor(message, code = "CODEC_ERROR") {
    super(message)
    this.name = "CodecError"
    this.code = code
  }
}

const I16_MIN = -0x8000
const I16_MAX = 0x7fff
const U16_MAX = 0xffff
const U32_MAX = 0xffffffff

/** Round half away from zero (matches Luvia math.floor(x+0.5) / ceil(x-0.5)). */
export function roundHalfAwayFromZero(x) {
  const v = Number(x)
  if (!Number.isFinite(v)) {
    throw new CodecError(`non-finite value: ${x}`, "NON_FINITE")
  }
  if (v >= 0) return Math.floor(v + 0.5)
  return Math.ceil(v - 0.5)
}

export function assertI16(value) {
  const v = Number(value)
  if (!Number.isInteger(v) || v < I16_MIN || v > I16_MAX) {
    throw new CodecError(`i16 out of range: ${value}`, "I16_RANGE")
  }
  return v
}

export function assertU16(value) {
  const v = Number(value)
  if (!Number.isInteger(v) || v < 0 || v > U16_MAX) {
    throw new CodecError(`u16 out of range: ${value}`, "U16_RANGE")
  }
  return v
}

export function assertU32(value) {
  const v = Number(value)
  if (!Number.isInteger(v) || v < 0 || v > U32_MAX) {
    throw new CodecError(`u32 out of range: ${value}`, "U32_RANGE")
  }
  return v
}

export function i16FromU16(raw) {
  const u = assertU16(raw)
  return u >= 0x8000 ? u - 0x10000 : u
}

/** @returns {Uint8Array} length 2 */
export function packI16Be(value) {
  const v = assertI16(value)
  const u = v < 0 ? v + 0x10000 : v
  return new Uint8Array([(u >> 8) & 0xff, u & 0xff])
}

export function unpackI16Be(data, offset = 0) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (offset + 2 > bytes.length) {
    throw new CodecError("i16 unpack past end", "SHORT_BUFFER")
  }
  const u = ((bytes[offset] & 0xff) << 8) | (bytes[offset + 1] & 0xff)
  return i16FromU16(u)
}

/** @returns {Uint8Array} length 2 */
export function packU16Be(value) {
  const v = assertU16(value)
  return new Uint8Array([(v >> 8) & 0xff, v & 0xff])
}

export function unpackU16Be(data, offset = 0) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (offset + 2 > bytes.length) {
    throw new CodecError("u16 unpack past end", "SHORT_BUFFER")
  }
  return ((bytes[offset] & 0xff) << 8) | (bytes[offset + 1] & 0xff)
}

/** @returns {Uint8Array} length 4 — little-endian (HW-confirmed for param write) */
export function packU32Le(value) {
  const v = assertU32(value)
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff])
}

export function unpackU32Le(data, offset = 0) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (offset + 4 > bytes.length) {
    throw new CodecError("u32 unpack past end", "SHORT_BUFFER")
  }
  return (
    (bytes[offset] & 0xff) |
    ((bytes[offset + 1] & 0xff) << 8) |
    ((bytes[offset + 2] & 0xff) << 16) |
    ((bytes[offset + 3] & 0xff) << 24)
  ) >>> 0
}
