/**
 * Pure UI enable / conflict helpers for Neck multi-backend panel (R3.1).
 * No React — unit-testable.
 */

import {
  HARDWARE_BACKEND_CONFLICT,
  NECK_HARDWARE_BACKEND,
  checkHardwareBackendConflict,
  normalizeNeckHardwareBackend,
} from "./neckHardwareBackend.js"

export const BROWSER_MOTOR_CONTROL_R4_HINT =
  "Browser Runtime R4: Worker 100Hz + Enable/Disable (Serial on main thread)"

export const BROWSER_MOTOR_CONTROL_R4_HINT_ZH =
  "Browser Runtime R4：Dedicated Worker 100Hz + Enable/Disable（串口保留主线程）"

/**
 * Human status label for Browser CAN transport FSM.
 * @param {string|null|undefined} state
 * @param {{ supported?: boolean, capabilityState?: string }} [opts]
 */
export function formatBrowserCanStatusLabel(state, opts = {}) {
  if (opts.supported === false || opts.capabilityState === "UNSUPPORTED" || opts.capabilityState === "INSECURE_CONTEXT") {
    return "Unsupported"
  }
  const s = String(state || "CLOSED").toUpperCase()
  switch (s) {
    case "READY":
      return "Ready"
    case "OPENING":
    case "PORT_OPEN":
    case "SLCAN_INITIALIZING":
      return "Opening"
    case "ERROR":
    case "DISCONNECTED":
      return "Error"
    case "CLOSING":
      return "Closing"
    case "CLOSED":
    default:
      return "Disconnected"
  }
}

/**
 * @param {{
 *   backend?: string,
 *   bridgeHardwareConnected?: boolean,
 *   browserSlcanReady?: boolean,
 *   browserTransportState?: string,
 * }} status
 */
export function getBackendSwitchConflict(status = {}) {
  const backend = normalizeNeckHardwareBackend(status.backend)
  const conflict = checkHardwareBackendConflict({
    browserSlcanReady: status.browserSlcanReady,
    browserTransportState: status.browserTransportState,
    bridgeHardwareConnected: status.bridgeHardwareConnected,
  })
  if (conflict.conflict) {
    return conflict
  }

  // Soft gate when selecting Browser CAN while Bridge HW still connected (before browser READY).
  if (backend === NECK_HARDWARE_BACKEND.BROWSER_SLCAN && status.bridgeHardwareConnected) {
    return {
      conflict: true,
      code: HARDWARE_BACKEND_CONFLICT,
      message: "Disconnect Luvia hardware backend first.",
      blockBrowserOpen: true,
      blockBridgeHardware: false,
    }
  }

  // Soft gate when selecting Luvia while Browser CAN still READY.
  if (backend === NECK_HARDWARE_BACKEND.LUVIA_BRIDGE) {
    const browserReady =
      status.browserSlcanReady === true ||
      String(status.browserTransportState || "").toUpperCase() === "READY"
    if (browserReady) {
      return {
        conflict: true,
        code: HARDWARE_BACKEND_CONFLICT,
        message: "Close Browser CAN transport first.",
        blockBrowserOpen: false,
        blockBridgeHardware: true,
      }
    }
  }

  return {
    conflict: false,
    code: null,
    message: null,
    blockBrowserOpen: false,
    blockBridgeHardware: false,
  }
}

/**
 * Select CAN Adapter button enabled?
 */
export function canSelectBrowserCanAdapter({
  backend,
  webSerialSupported,
  transportState,
  disabled,
  bridgeHardwareConnected,
} = {}) {
  if (disabled) return false
  if (normalizeNeckHardwareBackend(backend) !== NECK_HARDWARE_BACKEND.BROWSER_SLCAN) return false
  if (!webSerialSupported) return false
  if (bridgeHardwareConnected) return false
  const s = String(transportState || "CLOSED").toUpperCase()
  if (s === "OPENING" || s === "PORT_OPEN" || s === "SLCAN_INITIALIZING" || s === "READY") {
    return false
  }
  return true
}

/**
 * Open button enabled?
 */
export function canOpenBrowserSlcan({
  backend,
  webSerialSupported,
  portSelected,
  transportState,
  disabled,
  bridgeHardwareConnected,
} = {}) {
  if (disabled) return false
  if (normalizeNeckHardwareBackend(backend) !== NECK_HARDWARE_BACKEND.BROWSER_SLCAN) return false
  if (!webSerialSupported) return false
  if (!portSelected) return false
  if (bridgeHardwareConnected) return false
  const s = String(transportState || "CLOSED").toUpperCase()
  if (s === "OPENING" || s === "PORT_OPEN" || s === "SLCAN_INITIALIZING" || s === "READY") {
    return false
  }
  return true
}

/**
 * Close button — allow whenever not fully CLOSED (or always when a close handler exists).
 */
export function canCloseBrowserSlcan({ backend, transportState, disabled } = {}) {
  if (disabled) return false
  if (normalizeNeckHardwareBackend(backend) !== NECK_HARDWARE_BACKEND.BROWSER_SLCAN) return false
  const s = String(transportState || "CLOSED").toUpperCase()
  return s !== "CLOSED" && s !== "CLOSING"
}

/**
 * Bridge Connect Hardware blocked when Browser CAN owns the device.
 */
export function canConnectLuviaHardware({
  backend,
  sessionActive,
  hardwareConnected,
  browserSlcanReady,
  browserTransportState,
  disabled,
} = {}) {
  if (disabled) return false
  if (normalizeNeckHardwareBackend(backend) !== NECK_HARDWARE_BACKEND.LUVIA_BRIDGE) return false
  if (!sessionActive || hardwareConnected) return false
  const browserReady =
    browserSlcanReady === true || String(browserTransportState || "").toUpperCase() === "READY"
  if (browserReady) return false
  return true
}

/**
 * R4: motor control available when runtime host is present (caller may pass ready flag).
 * @param {{ runtimeHostReady?: boolean }|boolean} [opts]
 */
export function isBrowserMotorControlAvailable(opts = true) {
  if (typeof opts === "boolean") return opts
  if (opts && typeof opts === "object" && "runtimeHostReady" in opts) {
    return Boolean(opts.runtimeHostReady)
  }
  return true
}

/**
 * Enable Motors button gate (Browser CAN + R4 host).
 */
export function canEnableBrowserMotors({
  backend,
  transportReady,
  profileValid,
  profileReady = true,
  workerReady,
  estop,
  backendConflict,
  calibrating = false,
  disabled,
} = {}) {
  if (disabled) return false
  if (normalizeNeckHardwareBackend(backend) !== NECK_HARDWARE_BACKEND.BROWSER_SLCAN) return false
  if (!transportReady || !profileValid || !profileReady || !workerReady) return false
  if (estop || backendConflict || calibrating) return false
  return true
}

/**
 * Clear ESTOP only when latched.
 */
export function canClearBrowserEstop({
  backend,
  runtimeHostPresent,
  estopLatched,
  transportReady,
  calibrating = false,
  disabled,
} = {}) {
  if (disabled) return false
  if (normalizeNeckHardwareBackend(backend) !== NECK_HARDWARE_BACKEND.BROWSER_SLCAN) return false
  if (!runtimeHostPresent) return false
  if (!estopLatched) return false
  if (!transportReady) return false
  if (calibrating) return false
  return true
}

/**
 * Disable / Hold / Resume / ESTOP when host exists and transport was ready or motors enabled.
 */
export function canBrowserRuntimeControl({
  backend,
  runtimeHostPresent,
  disabled,
  requireEnabled = false,
  enabled = false,
  calibrating = false,
  blockWhileCalibrating = false,
} = {}) {
  if (disabled) return false
  if (normalizeNeckHardwareBackend(backend) !== NECK_HARDWARE_BACKEND.BROWSER_SLCAN) return false
  if (!runtimeHostPresent) return false
  if (requireEnabled && !enabled) return false
  if (blockWhileCalibrating && calibrating) return false
  return true
}

/**
 * Safe Disable only when transport READY + active profile valid.
 */
export function canSendBrowserSafeDisable({
  backend,
  transportState,
  slcanReady,
  profileValid = true,
  disabled,
} = {}) {
  if (disabled) return false
  if (normalizeNeckHardwareBackend(backend) !== NECK_HARDWARE_BACKEND.BROWSER_SLCAN) return false
  if (!profileValid) return false
  return Boolean(slcanReady) || String(transportState || "").toUpperCase() === "READY"
}
