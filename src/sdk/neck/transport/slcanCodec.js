/**
 * CANable 2.0 style SLCAN ASCII encode/decode (transport codec, no serial I/O).
 * Port of Luvia protocol/slcan_ascii.py + open sequence constants.
 *
 * Knows ONLY CanFrame ↔ SLCAN line. Must NOT import motor protocol adapters.
 */

import { createCanFrame } from "../protocol/canFrame.js"

export class SlcanCodecError extends Error {
  constructor(message, code = "SLCAN_CODEC_ERROR") {
    super(message)
    this.name = "SlcanCodecError"
    this.code = code
  }
}

/** CAN FD DLC code → length (python-can CAN_FD_DLC) */
const FD_DLC_LEN = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64]
const LEN_TO_FD_DLC = new Map(FD_DLC_LEN.map((len, i) => [len, i]))

export const SLCAN_OPEN_SEQUENCE = Object.freeze(["C", "S8", "Y5", "M0", "A1", "O"])

export function lenToFdDlcCode(length) {
  if (!LEN_TO_FD_DLC.has(length)) {
    throw new SlcanCodecError(`unsupported FD length ${length}`, "FD_DLC")
  }
  return LEN_TO_FD_DLC.get(length)
}

/**
 * Encode one SLCAN ASCII command (without CR).
 * @param {{ arbitrationId: number, data: Uint8Array, isExtendedId?: boolean, isFd?: boolean, brs?: boolean, isRemote?: boolean }} frame
 * @returns {string}
 */
export function encodeSlcanAscii(frame) {
  const arb = Number(frame.arbitrationId)
  const data = frame.data instanceof Uint8Array ? frame.data : new Uint8Array(frame.data || [])
  const ext = Boolean(frame.isExtendedId)
  const isFd = Boolean(frame.isFd)
  const brs = Boolean(frame.brs ?? frame.bitrateSwitch)
  const hex = (() => {
    let s = ""
    for (let i = 0; i < data.length; i++) s += data[i].toString(16).toUpperCase().padStart(2, "0")
    return s
  })()

  if (isFd) {
    const dlcCode = lenToFdDlcCode(data.length)
    const prefix = brs ? (ext ? "B" : "b") : ext ? "D" : "d"
    if (ext) return `${prefix}${arb.toString(16).toUpperCase().padStart(8, "0")}${dlcCode.toString(16).toUpperCase()}${hex}`
    return `${prefix}${arb.toString(16).toUpperCase().padStart(3, "0")}${dlcCode.toString(16).toUpperCase()}${hex}`
  }

  if (frame.isRemote) {
    const prefix = ext ? "R" : "r"
    return ext
      ? `${prefix}${arb.toString(16).toUpperCase().padStart(8, "0")}${data.length}`
      : `${prefix}${arb.toString(16).toUpperCase().padStart(3, "0")}${data.length}`
  }
  const prefix = ext ? "T" : "t"
  if (ext) {
    return `${prefix}${arb.toString(16).toUpperCase().padStart(8, "0")}${data.length}${hex}`
  }
  return `${prefix}${arb.toString(16).toUpperCase().padStart(3, "0")}${data.length}${hex}`
}

/** Transport-codec alias: CanFrame → wire string */
export function encodeFrame(frame) {
  return encodeSlcanAscii(frame)
}

/**
 * Parse one SLCAN ASCII line (CR/LF stripped).
 * FD: d/D no-BRS, b/B BRS (parse-only for production TX).
 * Classic: t/T.
 */
export function decodeSlcanAscii(line) {
  const s = String(line ?? "").replace(/[\r\n]+$/g, "").replace(/^\r|\n/g, "")
  const cleaned = s.replace(/^[\r\n]+|[\r\n]+$/g, "")
  if (!cleaned) {
    throw new SlcanCodecError("empty SLCAN line", "EMPTY_SLCAN")
  }
  const kind = cleaned[0]
  const rest = cleaned.slice(1)

  function parseStdFd(body, brs) {
    if (body.length < 4) throw new SlcanCodecError("FD std frame too short", "SHORT_SLCAN")
    const arb = Number.parseInt(body.slice(0, 3), 16)
    const dlcCode = Number.parseInt(body[3], 16)
    if (!(dlcCode >= 0 && dlcCode < FD_DLC_LEN.length)) {
      throw new SlcanCodecError(`bad FD dlc code ${dlcCode}`, "FD_DLC")
    }
    const length = FD_DLC_LEN[dlcCode]
    const hexdata = body.slice(4, 4 + length * 2)
    if (hexdata.length !== length * 2) {
      throw new SlcanCodecError("FD std data length mismatch", "DLC_MISMATCH")
    }
    return createCanFrame({
      arbitrationId: arb,
      data: hexToBytes(hexdata),
      isExtendedId: false,
      isFd: true,
      brs,
    })
  }

  function parseExtFd(body, brs) {
    if (body.length < 9) throw new SlcanCodecError("FD ext frame too short", "SHORT_SLCAN")
    const arb = Number.parseInt(body.slice(0, 8), 16)
    const dlcCode = Number.parseInt(body[8], 16)
    const length = FD_DLC_LEN[dlcCode]
    const hexdata = body.slice(9, 9 + length * 2)
    if (hexdata.length !== length * 2) {
      throw new SlcanCodecError("FD ext data length mismatch", "DLC_MISMATCH")
    }
    return createCanFrame({
      arbitrationId: arb,
      data: hexToBytes(hexdata),
      isExtendedId: true,
      isFd: true,
      brs,
    })
  }

  if (kind === "b") return parseStdFd(rest, true)
  if (kind === "B") return parseExtFd(rest, true)
  if (kind === "d") return parseStdFd(rest, false)
  if (kind === "D") return parseExtFd(rest, false)
  if (kind === "t") {
    const arb = Number.parseInt(rest.slice(0, 3), 16)
    const dlc = Number.parseInt(rest[3], 16)
    const data = hexToBytes(rest.slice(4, 4 + dlc * 2))
    return createCanFrame({ arbitrationId: arb, data, isExtendedId: false, isFd: false, brs: false })
  }
  if (kind === "T") {
    const arb = Number.parseInt(rest.slice(0, 8), 16)
    const dlc = Number.parseInt(rest[8], 16)
    const data = hexToBytes(rest.slice(9, 9 + dlc * 2))
    return createCanFrame({ arbitrationId: arb, data, isExtendedId: true, isFd: false, brs: false })
  }
  throw new SlcanCodecError(`unsupported SLCAN type '${kind}'`, "UNSUPPORTED_SLCAN")
}

/** Transport-codec alias: wire string → CanFrame */
export function decodeFrame(line) {
  return decodeSlcanAscii(line)
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/**
 * Frozen open sequence for 1 Mbps arb / 5 Mbps data (S8/Y5).
 * @param {{ withCr?: boolean }} [opts]
 * @returns {string[]}
 */
export function buildSlcanOpenSequence({ withCr = false } = {}) {
  const seq = [...SLCAN_OPEN_SEQUENCE]
  if (withCr) return seq.map((c) => `${c}\r`)
  return seq
}

/** Alias matching transport naming */
export function buildInitSequence(nominalBitrate = 1_000_000, dataBitrate = 5_000_000) {
  if (nominalBitrate !== 1_000_000 || dataBitrate !== 5_000_000) {
    throw new SlcanCodecError(
      `unsupported bitrate pair arb=${nominalBitrate} data=${dataBitrate}`,
      "BITRATE"
    )
  }
  return buildSlcanOpenSequence({ withCr: false })
}

/**
 * Resolve a transport codec object from transport profile.
 * @param {{ type?: string }|null|undefined} transport
 */
export function createTransportCodec(transport = null) {
  const type = String(transport?.type || "slcan")
  if (type !== "slcan") {
    throw new SlcanCodecError(`unsupported transport type: ${type}`, "UNSUPPORTED_TRANSPORT")
  }
  return Object.freeze({
    type: "slcan",
    encodeFrame,
    decodeFrame,
    encodeSlcanAscii,
    decodeSlcanAscii,
    buildSlcanOpenSequence,
  })
}
