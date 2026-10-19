/**
 * Neck hardware backend selection helpers.
 * Default remains Luvia Bridge; browser SLCAN is development / experimental.
 */

export const NECK_HARDWARE_BACKEND = Object.freeze({
  LUVIA_BRIDGE: "luvia-bridge",
  BROWSER_SLCAN: "browser-slcan",
})

export const HARDWARE_BACKEND_CONFLICT = "HARDWARE_BACKEND_CONFLICT"

/** Active backend must be fully idle before switching (R4.2). */
export const BACKEND_ACTIVE = "BACKEND_ACTIVE"

/**
 * @param {string} [value]
 * @returns {"luvia-bridge"|"browser-slcan"}
 */
export function normalizeNeckHardwareBackend(value) {
  const v = String(value || NECK_HARDWARE_BACKEND.LUVIA_BRIDGE).toLowerCase()
  if (v === NECK_HARDWARE_BACKEND.BROWSER_SLCAN || v === "browser" || v === "webserial") {
    return NECK_HARDWARE_BACKEND.BROWSER_SLCAN
  }
  return NECK_HARDWARE_BACKEND.LUVIA_BRIDGE
}

/**
 * Detect simultaneous active backends (must not share the same COM/CANable).
 *
 * @param {{
 *   browserSlcanReady?: boolean,
 *   browserTransportState?: string,
 *   bridgeHardwareConnected?: boolean,
 * }} status
 * @returns {{ conflict: boolean, code: string|null, message: string|null }}
 */
export function checkHardwareBackendConflict(status = {}) {
  const browserReady =
    status.browserSlcanReady === true ||
    String(status.browserTransportState || "").toUpperCase() === "READY"
  const bridgeHw = Boolean(status.bridgeHardwareConnected)

  if (browserReady && bridgeHw) {
    return {
      conflict: true,
      code: HARDWARE_BACKEND_CONFLICT,
      message:
        "Browser SLCAN READY and Luvia Bridge hardware connected at the same time — close one backend before using the other",
    }
  }
  return { conflict: false, code: null, message: null }
}

/**
 * Browser CAN considered "active" — must Disable/Close before switching away.
 * @param {{
 *   transportState?: string,
 *   slcanReady?: boolean,
 *   runtimeEnabled?: boolean,
 *   calibrating?: boolean,
 *   estop?: boolean,
 * }} status
 */
export function isBrowserBackendActive(status = {}) {
  const s = String(status.transportState || "CLOSED").toUpperCase()
  if (s && s !== "CLOSED") return true
  if (status.slcanReady === true) return true
  if (status.runtimeEnabled === true) return true
  if (status.calibrating === true) return true
  if (status.estop === true) return true
  return false
}

/**
 * Luvia Bridge considered "active" — hardware connected.
 * @param {{ hardwareConnected?: boolean, sessionActive?: boolean }} status
 */
export function isLuviaBackendActive(status = {}) {
  return Boolean(status.hardwareConnected)
}

/**
 * Hard gate: refuse backend switch while the current backend is still active.
 * Does not auto-teardown — user must Disable / Close / Disconnect first.
 *
 * @param {{
 *   from?: string,
 *   to?: string,
 *   backend?: string,
 *   browserTransportState?: string,
 *   browserSlcanReady?: boolean,
 *   browserRuntimeEnabled?: boolean,
 *   browserCalibrating?: boolean,
 *   browserEstop?: boolean,
 *   bridgeHardwareConnected?: boolean,
 *   bridgeSessionActive?: boolean,
 * }} status
 * @returns {{ ok: boolean, code: string|null, message: string|null }}
 */
export function canSwitchNeckHardwareBackend(status = {}) {
  const from = normalizeNeckHardwareBackend(status.from ?? status.backend)
  const to = normalizeNeckHardwareBackend(status.to)
  if (from === to) {
    return { ok: true, code: null, message: null }
  }

  if (from === NECK_HARDWARE_BACKEND.BROWSER_SLCAN) {
    if (
      isBrowserBackendActive({
        transportState: status.browserTransportState,
        slcanReady: status.browserSlcanReady,
        runtimeEnabled: status.browserRuntimeEnabled,
        calibrating: status.browserCalibrating,
        estop: status.browserEstop,
      })
    ) {
      return {
        ok: false,
        code: BACKEND_ACTIVE,
        message:
          "Browser CAN still active — Disable motors and Close transport before switching backend.",
      }
    }
  }

  if (from === NECK_HARDWARE_BACKEND.LUVIA_BRIDGE) {
    if (
      isLuviaBackendActive({
        hardwareConnected: status.bridgeHardwareConnected,
        sessionActive: status.bridgeSessionActive,
      })
    ) {
      return {
        ok: false,
        code: BACKEND_ACTIVE,
        message: "Luvia hardware still connected — Disconnect Hardware before switching backend.",
      }
    }
  }

  return { ok: true, code: null, message: null }
}

/**
 * Default backend for FaceDEV Character hardware path.
 */
export function getDefaultNeckHardwareBackend() {
  return NECK_HARDWARE_BACKEND.LUVIA_BRIDGE
}
