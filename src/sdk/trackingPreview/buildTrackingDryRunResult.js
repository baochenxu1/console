import { buildBindingOutputDiagnostics } from "../binding/bindingDiagnostics.js"
import { buildFinalServoOutputsFromBindings } from "../output/buildFinalServoOutputsFromBindings.js"
import { loadActuatorProfiles } from "../output/loadActuatorProfiles.js"
import { buildTrackingBusDryRunResult } from "./buildTrackingBusDryRunResult.js"
import { getTrackingDiagnosticPipelineState } from "../output/trackingBusPipelineState.js"
import { DEVICE_DRIVE_DEFAULTS, OUTPUT_MODES } from "./trackingPreviewConstants.js"

const EMPTY = {
  logicalPose: {},
  actualPose: {},
  commandPreview: "",
  warnings: [],
  diagnostics: null,
  finalServoOutputs: [],
}

/**
 * Dry Run：logicalPose / actualPose / 总线命令预览，不写串口。
 * @param {object} params
 */
export function buildTrackingDryRunResult({
  profile,
  rig,
  configs = [],
  timeMs = DEVICE_DRIVE_DEFAULTS.servoTimeMs,
  outputMode = OUTPUT_MODES.BUS_SERVO,
  actuatorProfiles = null,
  mapFaceRigToPoseOptions,
  sourceFrameIndex = null,
  sourceTimestampMs = null,
  busPipelineState = null,
  eyeReleasing = false,
} = {}) {
  void timeMs
  void outputMode

  const frameSeq = Number.isFinite(Number(sourceFrameIndex)) ? Number(sourceFrameIndex) : null
  if (!rig || typeof rig !== "object") {
    return { ...EMPTY }
  }

  const diagnostics = buildBindingOutputDiagnostics({
    profile,
    rig,
    configs,
    mapFaceRigToPoseOptions,
  })

  const logicalPose = diagnostics.logicalPose || {}
  const actualPose = diagnostics.actualPose || {}

  const finalServoOutputs = buildFinalServoOutputsFromBindings({
    profile,
    rig,
    configs,
    sourceType: "tracking",
    mapFaceRigToPoseOptions,
    sourceFrameIndex,
    sourceTimestampMs,
  })

  const warnings = [
    ...(diagnostics.warnings || []),
    ...(diagnostics.mapWarnings || []),
  ]

  const profiles = actuatorProfiles ?? loadActuatorProfiles().actuatorProfiles
  const pipeline = busPipelineState || getTrackingDiagnosticPipelineState()
  const busDryRun = buildTrackingBusDryRunResult({
    finalServoOutputs,
    actuatorProfiles: profiles,
    safetyState: pipeline.safetyState,
    nowMs: sourceTimestampMs ?? Date.now(),
    eyeReleasing,
    frameSeq,
    pipelineState: pipeline,
  })
  warnings.push(...(busDryRun.warnings || []))

  return {
    logicalPose,
    actualPose,
    commandPreview: busDryRun?.commandPreview || "",
    warnings,
    diagnostics,
    busDryRun,
    finalServoOutputs,
    /** @deprecated 使用 finalServoOutputs */
    pwmOutputs: finalServoOutputs,
    outputMode: OUTPUT_MODES.BUS_SERVO,
    frameSeq,
  }
}
