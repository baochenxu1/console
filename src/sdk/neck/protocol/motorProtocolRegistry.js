/**
 * Motor protocol registry — select adapter by profile.motorProtocol.type.
 * Unknown types → UNSUPPORTED_MOTOR_PROTOCOL (never fall back to BM_HMD).
 */

import { BM_HMD_PROTOCOL_TYPE } from "./bmHmdProtocol.js"
import { createBmHmdProtocolAdapter } from "./bmHmdProtocolAdapter.js"
import {
  createFakeMotorProtocolAdapter,
  FAKE_MOTOR_PROTOCOL_TYPE,
} from "./fakeMotorProtocol.js"
import {
  assertMotorProtocolAdapter,
  MotorProtocolError,
  validateProtocolTransportCompatibility,
} from "./motorProtocol.js"
import { normalizeTransportConfig } from "../transport/transportProfile.js"

export const SUPPORTED_MOTOR_PROTOCOL_TYPES = Object.freeze([
  BM_HMD_PROTOCOL_TYPE,
  FAKE_MOTOR_PROTOCOL_TYPE,
  "fake", // alias
])

/**
 * @param {object} [profile] NeckRuntimeProfile or { motorProtocol, transport }
 */
export function createMotorProtocolAdapter(profile = {}) {
  const type = String(
    profile?.motorProtocol?.type ||
      profile?.type ||
      BM_HMD_PROTOCOL_TYPE
  ).toLowerCase()

  let adapter
  if (type === BM_HMD_PROTOCOL_TYPE || type === "bm_hmd") {
    adapter = createBmHmdProtocolAdapter(profile)
  } else if (type === FAKE_MOTOR_PROTOCOL_TYPE || type === "fake") {
    adapter = createFakeMotorProtocolAdapter(profile)
  } else {
    throw new MotorProtocolError(
      `unsupported motor protocol type: ${type}`,
      "UNSUPPORTED_MOTOR_PROTOCOL"
    )
  }

  assertMotorProtocolAdapter(adapter)

  // Compatibility gate when transport is present on the profile
  if (profile?.transport) {
    const transport = normalizeTransportConfig(profile.transport)
    validateProtocolTransportCompatibility({
      motorProtocol: profile.motorProtocol || { type: adapter.type, version: adapter.version },
      transport,
      capabilities: adapter.capabilities,
      adapter,
    })
  }

  return adapter
}

/**
 * Preferred registry lookup alias (R4 worker/runtime).
 * Same as createMotorProtocolAdapter — keeps Fake classic selectable via profile.
 * @param {object} [profile]
 */
export function getMotorProtocolAdapter(profile = {}) {
  return createMotorProtocolAdapter(profile)
}
