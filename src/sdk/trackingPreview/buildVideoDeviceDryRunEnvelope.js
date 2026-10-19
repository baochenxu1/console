import { buildBusOutputDebug } from "../output/adapters/busServoOutputAdapter.js"
import { commitActuatorSafetyStates } from "../output/actuatorOutputSafety.js"
import {
  applyUpperFaceTwitchGuardToCommands,
  commitUpperFaceTwitchGuardState,
  DEFAULT_TRACKING_UPPER_FACE_TWITCH_GUARD,
} from "../output/upperFaceTwitchGuard.js"
import { buildTrackingDryRunResult } from "./buildTrackingDryRunResult.js"
import { DEVICE_DRIVE_DEFAULTS, OUTPUT_MODES } from "./trackingPreviewConstants.js"
import {
  summarizeSafetyFromCommands,
  summarizeTwitchFromDebug,
} from "./deviceDriveDiagnostics.js"
import { VIDEO_DEVICE_DRY_RUN_BLOCKED_REASON } from "./videoDeviceDryRunConstants.js"

function applyLipRigDeadbandToRig(rig, defs) {
  if (!rig || typeof rig !== "object") {
    return { rig, applied: false }
  }
  const thr = Math.max(0, Number(defs?.lipRigDeadband) || 0)
  if (thr <= 0) {
    return { rig, applied: false }
  }
  const out = { ...rig, mouth: rig.mouth ? { ...rig.mouth } : {} }
  let applied = false
  for (const ch of ["UL", "UR", "LL", "LR"]) {
    const v = Number(out.mouth?.[ch])
    if (!Number.isFinite(v)) continue
    if (Math.abs(v) < thr) {
      out.mouth[ch] = 0
      applied = true
    }
  }
  return { rig: out, applied }
}

/**
 * Video / uploaded-video 单帧 device dry-run（binding + safety + twitch guard，不写串口）。
 */
export function buildVideoDeviceDryRunEnvelope({
  profile,
  rig,
  configs = [],
  outputMode = OUTPUT_MODES.BUS_SERVO,
  actuatorProfiles = [],
  pipelineState = null,
  frameSeq = null,
  timestampMs = null,
  eyeReleasing = false,
  mapFaceRigToPoseOptions = null,
  twitchGuardState = null,
} = {}) {
  void outputMode

  const deadbandRigResult = applyLipRigDeadbandToRig(rig, DEVICE_DRIVE_DEFAULTS)
  const rigForBind = deadbandRigResult.rig

  const dryRunResult = buildTrackingDryRunResult({
    profile,
    rig: rigForBind,
    configs,
    outputMode: OUTPUT_MODES.BUS_SERVO,
    actuatorProfiles,
    mapFaceRigToPoseOptions,
    sourceFrameIndex: frameSeq,
    sourceTimestampMs: timestampMs ?? Date.now(),
    busPipelineState: pipelineState,
    eyeReleasing,
  })

  const finalOutputs = dryRunResult.finalServoOutputs || []
  let busCommands = dryRunResult.busDryRun?.busCommands || []
  let twitchGuardDebug = null

  if (busCommands.length && twitchGuardState) {
    const twitch = applyUpperFaceTwitchGuardToCommands(
      busCommands,
      twitchGuardState,
      DEFAULT_TRACKING_UPPER_FACE_TWITCH_GUARD
    )
    busCommands = twitch.commands
    twitchGuardDebug = twitch.debug
    commitUpperFaceTwitchGuardState(twitchGuardState, busCommands, frameSeq)
  }

  if (pipelineState?.safetyState && busCommands.length) {
    commitActuatorSafetyStates(pipelineState.safetyState, busCommands, timestampMs ?? Date.now(), {
      sourceSeq: frameSeq,
    })
  }

  const safety = summarizeSafetyFromCommands(busCommands)
  const twitch = summarizeTwitchFromDebug(
    twitchGuardDebug?.upperFaceTwitchGuard || [],
    twitchGuardDebug?.frameSpikeDebug
  )

  const commandPreview = dryRunResult.commandPreview || ""

  const busOutputDebug = busCommands.length
    ? buildBusOutputDebug(
        {
          commands: busCommands,
          skipped: dryRunResult.busDryRun?.skipped || [],
          summary: dryRunResult.busDryRun?.summary || {},
        },
        finalOutputs
      )
    : null

  return {
    dryRunResult: {
      ...dryRunResult,
      finalServoOutputs: finalOutputs,
      busDryRun: dryRunResult.busDryRun
        ? { ...dryRunResult.busDryRun, busCommands, sentCommands: busCommands }
        : null,
      commandPreview,
    },
    finalServoOutputs: finalOutputs,
    busCommands,
    commandPreview,
    lipRigDeadbandApplied: deadbandRigResult.applied,
    actuatorDiagnostics: {
      safetyLimitedCountByRole: safety.safetyLimitedCountByRole,
      twitchGuardActionCountByRole: twitch.twitchGuardActionCountByRole,
      limitedActuatorRank: [
        ...(safety.limitedActuators || []),
        ...(twitch.limitedActuators || []),
      ].slice(0, 12),
    },
    busOutputDebug,
    device: {
      sent: false,
      dryRun: true,
      mode: "dry-run",
      blockedReason: VIDEO_DEVICE_DRY_RUN_BLOCKED_REASON,
      outputMode: OUTPUT_MODES.BUS_SERVO,
      commandCount: busCommands.length || (commandPreview ? 1 : 0),
      packetCount: 0,
    },
    frameSeq,
  }
}
