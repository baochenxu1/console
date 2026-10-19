import {
  buildBusCommandsFromFinalOutputs,
  formatBusCommandsPreview,
} from "./adapters/busServoOutputAdapter.js"
import {
  commitActuatorSafetyStates,
  createActuatorSafetyState,
} from "./actuatorOutputSafety.js"

export { createActuatorSafetyState }

/**
 * finalServoOutputs → bus commands → light slew safety（每帧全量，无 scheduler）。
 *
 * 串口负载优化：Device Drive 默认 sync-write（见 sendBusServoFrameSyncWrite）。
 */
export function runTrackingBusPipeline({
  finalServoOutputs = [],
  actuatorProfiles,
  safetyState = null,
  nowMs = Date.now(),
  eyeReleasing = false,
  frameSeq = null,
  commitMeta = null,
} = {}) {
  const safety = safetyState || createActuatorSafetyState()

  const built = buildBusCommandsFromFinalOutputs(finalServoOutputs, actuatorProfiles, {
    safetyState: safety,
    eyeReleasing,
    frameSeq,
  })

  commitActuatorSafetyStates(safety, built.commands, nowMs, commitMeta)

  return {
    built,
    commands: built.commands,
    sentCommands: built.commands,
    safetyState: safety,
    commandPreview: formatBusCommandsPreview(built.commands),
  }
}
