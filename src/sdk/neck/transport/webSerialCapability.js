/**
 * Web Serial capability detection (navigator.serial + secure context).
 * No polyfill for Safari / Firefox — Chromium desktop is the product target.
 */

export const WEB_SERIAL_CAPABILITY = Object.freeze({
  SUPPORTED: "SUPPORTED",
  UNSUPPORTED: "UNSUPPORTED",
  INSECURE_CONTEXT: "INSECURE_CONTEXT",
  NO_NAVIGATOR: "NO_NAVIGATOR",
})

/**
 * @param {{
 *   navigator?: { serial?: unknown } | null,
 *   isSecureContext?: boolean,
 * } } [env]
 */
export function detectWebSerialCapability(env = {}) {
  const nav =
    env.navigator !== undefined
      ? env.navigator
      : typeof globalThis !== "undefined"
        ? globalThis.navigator
        : undefined
  const isSecure =
    env.isSecureContext !== undefined
      ? Boolean(env.isSecureContext)
      : typeof globalThis !== "undefined"
        ? Boolean(globalThis.isSecureContext)
        : false

  if (nav == null) {
    return Object.freeze({
      state: WEB_SERIAL_CAPABILITY.NO_NAVIGATOR,
      supported: false,
      hasSerial: false,
      isSecureContext: isSecure,
      message: "navigator unavailable",
    })
  }

  if (!isSecure) {
    return Object.freeze({
      state: WEB_SERIAL_CAPABILITY.INSECURE_CONTEXT,
      supported: false,
      hasSerial: Boolean(nav.serial),
      isSecureContext: false,
      message: "Web Serial requires a secure context (HTTPS or localhost)",
    })
  }

  if (!nav.serial) {
    return Object.freeze({
      state: WEB_SERIAL_CAPABILITY.UNSUPPORTED,
      supported: false,
      hasSerial: false,
      isSecureContext: true,
      message: "Web Serial API unsupported in this browser",
    })
  }

  return Object.freeze({
    state: WEB_SERIAL_CAPABILITY.SUPPORTED,
    supported: true,
    hasSerial: true,
    isSecureContext: true,
    message: "Web Serial available",
  })
}

/**
 * Convenience boolean for UI gating.
 */
export function isWebSerialSupported(env) {
  return detectWebSerialCapability(env).supported
}
