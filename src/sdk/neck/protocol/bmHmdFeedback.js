/**
 * BM_HMD feedback decode — DriveFeedback (0x50+id), Telemetry (0x70+id), State (0xA0+id).
 * Do NOT invent temperature or other undocumented fields.
 */

import { unpackI16Be, unpackU16Be } from "./codec.js"
import { ProtocolError } from "./bmHmdProtocol.js"

export const ABS_POS_COUNTS_PER_REV = 4096
export const ABS_POS_ANGLE_PER_COUNT_DEG = 360.0 / ABS_POS_COUNTS_PER_REV

export class FeedbackError extends Error {
  constructor(message, code = "FEEDBACK_ERROR") {
    super(message)
    this.name = "FeedbackError"
    this.code = code
  }
}

export function absoluteRawToDeg(raw) {
  return Number(raw) * ABS_POS_ANGLE_PER_COUNT_DEG
}

function ensureFdFrame(frame) {
  if (!frame || typeof frame !== "object") {
    throw new FeedbackError("missing frame", "INVALID_FRAME")
  }
  if (frame.isExtendedId) {
    throw new FeedbackError("extended id not supported in stage-1 protocol", "EXTENDED_ID")
  }
}

function motorIdFromFeedback(arbId, base) {
  const mid = Number(arbId) - base
  if (!(mid >= 1 && mid <= 8)) {
    throw new FeedbackError(
      `unexpected feedback id 0x${Number(arbId).toString(16).toUpperCase()} for base 0x${base.toString(16).toUpperCase()}`,
      "UNKNOWN_ARB_ID"
    )
  }
  return mid
}

function requireDlc8(frame, kind) {
  const len = frame.data?.length ?? -1
  if (len !== 8) {
    throw new FeedbackError(`${kind} DLC must be 8, got ${len}`, "INVALID_DLC")
  }
}

/**
 * Decode 0x50+id DriveFeedback.
 * @returns {{
 *   motorId: number,
 *   rawSpeedU16: number, rawSpeedI16: number, speedRpm: number,
 *   rawIqU16: number, rawIqI16: number, iqA: number,
 *   rawAbsolutePosition: number, absolutePositionDeg: number,
 *   rawVoltageU16: number, voltageV: number,
 * }}
 */
export function decodeDriveFeedback(frame) {
  ensureFdFrame(frame)
  const motorId = motorIdFromFeedback(frame.arbitrationId, 0x50)
  requireDlc8(frame, "drive feedback")
  const d = frame.data
  const su = unpackU16Be(d, 0)
  const si = unpackI16Be(d, 0)
  const iu = unpackU16Be(d, 2)
  const ii = unpackI16Be(d, 2)
  const absRaw = unpackU16Be(d, 4)
  const vu = unpackU16Be(d, 6)
  return {
    motorId,
    rawSpeedU16: su,
    rawSpeedI16: si,
    speedRpm: si / 10.0,
    rawIqU16: iu,
    rawIqI16: ii,
    iqA: ii / 100.0,
    rawAbsolutePosition: absRaw,
    absolutePositionDeg: absoluteRawToDeg(absRaw),
    rawVoltageU16: vu,
    voltageV: vu / 10.0,
  }
}

/**
 * Decode 0x70+id TelemetryFeedback (default mapping: speed, iq, voltage, abs).
 */
export function decodeTelemetry(frame) {
  ensureFdFrame(frame)
  const motorId = motorIdFromFeedback(frame.arbitrationId, 0x70)
  requireDlc8(frame, "telemetry")
  const d = frame.data
  const uVals = []
  const iVals = []
  for (const off of [0, 2, 4, 6]) {
    const u = unpackU16Be(d, off)
    const i = unpackI16Be(d, off)
    uVals.push(u)
    iVals.push(i)
  }
  const absRaw = uVals[3]
  return {
    motorId,
    rawValuesU16: /** @type {[number,number,number,number]} */ ([uVals[0], uVals[1], uVals[2], uVals[3]]),
    rawValuesI16: /** @type {[number,number,number,number]} */ ([iVals[0], iVals[1], iVals[2], iVals[3]]),
    speedRpm: iVals[0] / 10.0,
    iqA: iVals[1] / 100.0,
    voltageV: uVals[2] / 10.0,
    rawAbsolutePosition: absRaw,
    absolutePositionDeg: absoluteRawToDeg(absRaw),
  }
}

/**
 * Decode 0xA0+id StateFeedback. Do not wait on base 0xA0.
 */
export function decodeState(frame) {
  ensureFdFrame(frame)
  const motorId = motorIdFromFeedback(frame.arbitrationId, 0xa0)
  requireDlc8(frame, "state feedback")
  const d = frame.data
  const cmd = d[2]
  return {
    motorId,
    controlMode: d[1],
    cmd,
    calibrated: d[3] === 1,
    faultCode: d[4],
    warningCode: d[5],
    enabled: cmd === 2,
    // temperature intentionally omitted — not in protocol
  }
}

/**
 * Classify feedback arbitration ID and decode, or throw typed errors.
 */
export function decodeFeedbackFrame(frame) {
  const arb = Number(frame?.arbitrationId)
  if (!Number.isInteger(arb)) {
    throw new FeedbackError("missing arbitrationId", "INVALID_FRAME")
  }
  if (arb >= 0x51 && arb <= 0x58) return { kind: "drive", feedback: decodeDriveFeedback(frame) }
  if (arb >= 0x71 && arb <= 0x78) return { kind: "telemetry", feedback: decodeTelemetry(frame) }
  if (arb >= 0xa1 && arb <= 0xa8) return { kind: "state", feedback: decodeState(frame) }
  throw new FeedbackError(
    `unsupported / unknown feedback arbitration id 0x${arb.toString(16).toUpperCase()}`,
    "UNKNOWN_ARB_ID"
  )
}

// Keep ProtocolError import used for re-export convenience
export { ProtocolError }
