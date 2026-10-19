/**
 * MotorProtocol Adapter contract (R2.1).
 *
 * Boundary:
 *   MotorCommand  →  MotorProtocolAdapter  →  CanFrame / CanFrame[]
 *   CanFrame      →  decodeFrame          →  MotorFeedback
 *
 * Adapters must NOT emit SLCAN strings. Transport codecs own that step.
 *
 * Required adapter shape:
 * {
 *   type: string,
 *   version: string,
 *   capabilities: {
 *     modes: string[],
 *     maxMotorsPerFrame: number,
 *     supportsFeedback: boolean,
 *     requiresCanFd: boolean,
 *     requiresBrs: boolean,
 *   },
 *   encodePositionCommand(motorCommand): CanFrame | CanFrame[],
 *   encodeEnableCommand(motorIds?): CanFrame | CanFrame[],
 *   encodeDisableCommand(motorIds?): CanFrame | CanFrame[],
 *   encodeControlModeCommand(motorId, mode?): CanFrame | CanFrame[],
 *   decodeFrame(canFrame): { kind, feedback: MotorFeedback } | MotorFeedback,
 * }
 */

export class MotorProtocolError extends Error {
  constructor(message, code = "MOTOR_PROTOCOL_ERROR") {
    super(message)
    this.name = "MotorProtocolError"
    this.code = code
  }
}

const REQUIRED_METHODS = Object.freeze([
  "encodePositionCommand",
  "encodeEnableCommand",
  "encodeDisableCommand",
  "encodeControlModeCommand",
  "decodeFrame",
])

/**
 * Canonical MotorFeedback — adapters fill supported fields; others stay null.
 * @param {object} [partial]
 */
export function createMotorFeedback(partial = {}) {
  const src = partial && typeof partial === "object" ? partial : {}
  return {
    motorId: src.motorId == null ? null : Number(src.motorId),
    position:
      src.position != null
        ? Number(src.position)
        : src.absolutePositionDeg != null
          ? Number(src.absolutePositionDeg)
          : null,
    speed:
      src.speed != null
        ? Number(src.speed)
        : src.speedRpm != null
          ? Number(src.speedRpm)
          : null,
    current:
      src.current != null
        ? Number(src.current)
        : src.iqA != null
          ? Number(src.iqA)
          : null,
    voltage:
      src.voltage != null
        ? Number(src.voltage)
        : src.voltageV != null
          ? Number(src.voltageV)
          : null,
    fault:
      src.fault != null
        ? src.fault
        : src.faultCode != null
          ? src.faultCode
          : null,
    enabled: src.enabled == null ? null : Boolean(src.enabled),
    mode:
      src.mode != null
        ? src.mode
        : src.controlMode != null
          ? src.controlMode
          : null,
    kind: src.kind == null ? null : String(src.kind),
    raw: src.raw == null ? null : src.raw,
  }
}

/**
 * @param {unknown} adapter
 */
export function assertMotorProtocolAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new MotorProtocolError("missing MotorProtocolAdapter", "INVALID_ADAPTER")
  }
  if (typeof adapter.type !== "string" || !adapter.type) {
    throw new MotorProtocolError("adapter.type required", "INVALID_ADAPTER")
  }
  if (typeof adapter.version !== "string" || !adapter.version) {
    throw new MotorProtocolError("adapter.version required", "INVALID_ADAPTER")
  }
  if (!adapter.capabilities || typeof adapter.capabilities !== "object") {
    throw new MotorProtocolError("adapter.capabilities required", "INVALID_ADAPTER")
  }
  const caps = adapter.capabilities
  for (const key of [
    "modes",
    "maxMotorsPerFrame",
    "supportsFeedback",
    "requiresCanFd",
    "requiresBrs",
  ]) {
    if (!(key in caps)) {
      throw new MotorProtocolError(
        `adapter.capabilities.${key} required`,
        "INVALID_ADAPTER"
      )
    }
  }
  if (!Array.isArray(caps.modes)) {
    throw new MotorProtocolError("capabilities.modes must be array", "INVALID_ADAPTER")
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof adapter[method] !== "function") {
      throw new MotorProtocolError(
        `adapter.${method} must be a function`,
        "INVALID_ADAPTER"
      )
    }
  }
  return adapter
}

/**
 * Validate motor protocol capabilities against transport CAN mode.
 *
 * BM_HMD requiresCanFd=true + transport can.mode="classic"
 * → PROTOCOL_TRANSPORT_INCOMPATIBLE (do not claim hardware works).
 *
 * @param {{
 *   motorProtocol?: { type?: string, version?: string },
 *   transport?: { type?: string, can?: { mode?: string, brs?: boolean } },
 *   capabilities?: object,
 *   adapter?: object,
 * }} profileOrArgs
 */
export function validateProtocolTransportCompatibility(profileOrArgs = {}) {
  const profile =
    profileOrArgs && typeof profileOrArgs === "object" ? profileOrArgs : {}
  const caps =
    profile.capabilities ||
    profile.adapter?.capabilities ||
    null
  const transport = profile.transport || {}
  const can = transport.can || {}
  const mode = String(can.mode || (transport.canFd === false ? "classic" : "fd"))

  if (caps?.requiresCanFd === true && mode === "classic") {
    throw new MotorProtocolError(
      `protocol ${profile.motorProtocol?.type || profile.adapter?.type || "?"} requires CAN FD but transport mode=classic`,
      "PROTOCOL_TRANSPORT_INCOMPATIBLE"
    )
  }

  if (caps?.requiresBrs === false && can.brs === true) {
    throw new MotorProtocolError(
      `protocol forbids brs=true but transport.can.brs=true`,
      "PROTOCOL_TRANSPORT_INCOMPATIBLE"
    )
  }

  return true
}
