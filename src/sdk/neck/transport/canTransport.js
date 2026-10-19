/**
 * CanTransport contract — physical / mock CAN I/O boundary for R3+.
 *
 * Semantic methods:
 *   open() / close()
 *   sendFrame(CanFrame)
 *   onFrame(callback) → unsubscribe
 *   getState()
 *
 * R2.1 does NOT implement Web Serial. Only MockCanTransport is provided.
 */

export class CanTransportError extends Error {
  constructor(message, code = "CAN_TRANSPORT_ERROR") {
    super(message)
    this.name = "CanTransportError"
    this.code = code
  }
}

const REQUIRED = Object.freeze(["open", "close", "sendFrame", "onFrame", "getState"])

/**
 * @param {unknown} transport
 */
export function assertCanTransport(transport) {
  if (!transport || typeof transport !== "object") {
    throw new CanTransportError("missing CanTransport", "INVALID_TRANSPORT")
  }
  for (const method of REQUIRED) {
    if (typeof transport[method] !== "function") {
      throw new CanTransportError(
        `CanTransport.${method} must be a function`,
        "INVALID_TRANSPORT"
      )
    }
  }
  return transport
}

/**
 * Document-only contract descriptor (for tests / docs).
 */
export const CAN_TRANSPORT_CONTRACT = Object.freeze({
  methods: REQUIRED,
  description:
    "Physical or mock CAN transport. R3 will add WebSerialSlcanTransport implementing this contract without importing BM_HMD.",
})
