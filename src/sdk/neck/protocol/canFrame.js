/**
 * Browser CAN Frame semantic model (R2).
 * Internal truth is Uint8Array data — hex only for debug/fixture/display.
 */

export class CanFrameError extends Error {
  constructor(message, code = "CAN_FRAME_ERROR") {
    super(message)
    this.name = "CanFrameError"
    this.code = code
  }
}

/**
 * @param {Uint8Array|number[]|ArrayBuffer} data
 * @returns {string} uppercase hex without separators
 */
export function dataToHex(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  let out = ""
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).toUpperCase().padStart(2, "0")
  }
  return out
}

/**
 * @param {string} hex
 * @returns {Uint8Array}
 */
export function hexToData(hex) {
  const s = String(hex || "")
    .replace(/\s+/g, "")
    .toUpperCase()
  if (s.length % 2 !== 0) {
    throw new CanFrameError(`hex length must be even: ${s.length}`, "INVALID_HEX")
  }
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16)
    if (!Number.isFinite(byte)) {
      throw new CanFrameError(`invalid hex at ${i * 2}`, "INVALID_HEX")
    }
    out[i] = byte
  }
  return out
}

/**
 * @param {{
 *   arbitrationId: number,
 *   data: Uint8Array|number[],
 *   isExtendedId?: boolean,
 *   isFd?: boolean,
 *   brs?: boolean,
 * }} opts
 */
export function createCanFrame({
  arbitrationId,
  data,
  isExtendedId = false,
  isFd = true,
  brs = false,
} = {}) {
  const id = Number(arbitrationId)
  if (!Number.isInteger(id) || id < 0) {
    throw new CanFrameError(`invalid arbitrationId: ${arbitrationId}`, "INVALID_ARB_ID")
  }
  const bytes = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data || [])
  return {
    arbitrationId: id,
    isExtendedId: Boolean(isExtendedId),
    isFd: Boolean(isFd),
    brs: Boolean(brs),
    data: bytes,
  }
}

/**
 * Production neck TX contract: CAN FD, no BRS.
 * @param {object} frame
 */
export function assertProductionNeckTxFrame(frame) {
  if (!frame || typeof frame !== "object") {
    throw new CanFrameError("missing CanFrame", "INVALID_FRAME")
  }
  if (frame.isFd !== true) {
    throw new CanFrameError("production neck TX requires isFd=true", "FD_REQUIRED")
  }
  if (frame.brs === true) {
    throw new CanFrameError("production neck TX requires brs=false", "BRS_FORBIDDEN")
  }
  return frame
}
