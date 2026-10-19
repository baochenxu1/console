import { buildBusOutputDebug, formatBusCommandsPreview } from "../output/adapters/busServoOutputAdapter.js"
import { runTrackingBusPipeline } from "../output/trackingBusPipeline.js"

/**
 * Bus Servo Dry Run：finalServoOutputs → bus commands → light slew safety（不写串口）。
 */
export function buildTrackingBusDryRunResult({
  finalServoOutputs = [],
  actuatorProfiles,
  safetyState = null,
  nowMs = Date.now(),
  eyeReleasing = false,
  frameSeq = null,
  pipelineState = null,
} = {}) {
  const pipeline = runTrackingBusPipeline({
    finalServoOutputs,
    actuatorProfiles,
    safetyState,
    nowMs,
    eyeReleasing,
    frameSeq,
    commitMeta: { sourceSeq: frameSeq },
  })

  const built = pipeline.built
  const warnings = []
  for (const s of built.skipped) {
    if (s.reason === "profile-not-found" || s.reason === "not-found") {
      warnings.push(`${s.actuatorKey ?? `L${s.legacyServoIndex}`}: profile-not-found`)
    }
  }

  if (built.summary.commandCount === 0) {
    warnings.push("Bus Servo: commandCount=0，finalServoOutputs 为空或 profile 全部跳过")
  }

  const busOutputDebug = buildBusOutputDebug({ ...built, commands: pipeline.commands }, finalServoOutputs)

  return {
    busCommands: pipeline.commands,
    sentCommands: pipeline.commands,
    skipped: built.skipped,
    summary: {
      ...built.summary,
      sentCommandCount: pipeline.commands.length,
    },
    busOutputDebug,
    finalServoOutputs,
    commandPreview: pipeline.commandPreview || formatBusCommandsPreview(pipeline.commands),
    warnings,
    pwmOutputCount: finalServoOutputs.length,
    safetyState: pipeline.safetyState,
    pipelineStateDebug: pipelineState
      ? {
          ownerId: pipelineState.ownerId,
          consumerType: pipelineState.consumerType,
          frameSeq,
          stateCommitCount: pipeline.safetyState?.stateCommitCount ?? 0,
        }
      : null,
  }
}
