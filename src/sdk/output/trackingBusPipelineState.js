import { createActuatorSafetyState } from "./actuatorOutputSafety.js"
import { createUpperFaceTwitchGuardState } from "./upperFaceTwitchGuard.js"

/** @typedef {{ ownerId: string, consumerType: string, safetyState: ReturnType<typeof createActuatorSafetyState>, realSafetyState?: ReturnType<typeof createActuatorSafetyState>, twitchGuardState?: ReturnType<typeof createUpperFaceTwitchGuardState> }} TrackingBusPipelineState */

/** @type {TrackingBusPipelineState | null} */
let recorderPipelineState = null

/** @type {TrackingBusPipelineState | null} */
let devicePipelineState = null

/**
 * @param {{ ownerId?: string, consumerType?: string }} [meta]
 * @returns {TrackingBusPipelineState}
 */
export function createTrackingBusPipelineState(meta = null) {
  const ownerId = meta?.ownerId || "unknown"
  const consumerType = meta?.consumerType || "unknown"
  return {
    ownerId,
    consumerType,
    safetyState: createActuatorSafetyState({ ownerId, consumerType }),
  }
}

export function resetTrackingDiagnosticPipelineState() {
  recorderPipelineState = createTrackingBusPipelineState({
    ownerId: "recorder-dry-run",
    consumerType: "diagnostic-recorder",
  })
  return recorderPipelineState
}

export function getTrackingDiagnosticPipelineState() {
  if (!recorderPipelineState) {
    resetTrackingDiagnosticPipelineState()
  }
  return recorderPipelineState
}

export function resetDeviceBusPipelineState() {
  devicePipelineState = {
    ...createTrackingBusPipelineState({
      ownerId: "device-drive-dry-run",
      consumerType: "device-preview",
    }),
    realSafetyState: createActuatorSafetyState({
      ownerId: "device-drive-real",
      consumerType: "real-device-send",
    }),
    twitchGuardState: createUpperFaceTwitchGuardState(),
  }
  return devicePipelineState
}

export function getDeviceBusPipelineState() {
  if (!devicePipelineState) {
    resetDeviceBusPipelineState()
  }
  return devicePipelineState
}
