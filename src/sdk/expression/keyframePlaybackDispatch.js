import { approximateEliteRigFromKeyframePositions } from "../../core/faceDofMapper.js"
import { loadFaceRigProfile, normalizeFaceRigProfile } from "../../core/faceRigProfile.js"
import { createRightMouthCornerFivebarState } from "../kinematics/mouthCornerFivebar.js"
import { buildMapFaceRigToPoseOptionsFromMouthRuntimes } from "../kinematics/mouthFiveBarRuntimeOptions.js"
import { dispatchBindingWorkbenchOutputs } from "../output/bindingWorkbench/dispatchBindingWorkbenchOutputs.js"
import { buildFinalServoOutputsForBindingWorkbench } from "../output/bindingWorkbench/buildFinalServoOutputsForBindingWorkbench.js"
import {
  BINDING_OUTPUT_MODES,
  BINDING_OUTPUT_MODE_STORAGE_KEY,
  normalizeBindingOutputMode,
} from "../output/bindingWorkbench/index.js"
import { loadActuatorProfiles } from "../output/loadActuatorProfiles.js"
import { OUTPUT_MODES } from "../trackingPreview/trackingPreviewConstants.js"
import { isSharedBusWireConnected } from "../servoAdapters/busServo/resolveBusTransport.js"

const _playbackRightFiveBar = createRightMouthCornerFivebarState()
const _playbackLeftFiveBar = createRightMouthCornerFivebarState()

export function resolveKeyframePlaybackOutputMode() {
  try {
    const stored = localStorage.getItem(BINDING_OUTPUT_MODE_STORAGE_KEY)
    if (stored) {
      const mode = normalizeBindingOutputMode(stored)
      if (mode === BINDING_OUTPUT_MODES.BUS_SERVO) {
        return mode
      }
    }
  } catch {
    //
  }
  return BINDING_OUTPUT_MODES.BUS_SERVO
}

function resolveRigFromKeyframe(keyframe, configs) {
  if (keyframe?.rigSnapshot && typeof keyframe.rigSnapshot === "object") {
    return structuredClone(keyframe.rigSnapshot)
  }
  const profile = normalizeFaceRigProfile(loadFaceRigProfile())
  return approximateEliteRigFromKeyframePositions(keyframe?.positions || {}, profile, configs)
}

/**
 * 单关键帧硬件下发（仅 Bus Servo）。
 */
export async function dispatchKeyframeToHardware({
  keyframe,
  configs,
  onCommandPreview,
  signal,
}) {
  if (signal?.aborted) {
    return false
  }

  const timeMs = Math.max(20, Number(keyframe?.durationMs) || 500)

  const profile = normalizeFaceRigProfile(loadFaceRigProfile())
  const mapOpts = buildMapFaceRigToPoseOptionsFromMouthRuntimes({
    rightState: _playbackRightFiveBar,
    leftState: _playbackLeftFiveBar,
  })
  const rig = resolveRigFromKeyframe(keyframe, configs)
  const finalServoOutputs = buildFinalServoOutputsForBindingWorkbench({
    previewRigFrame: rig,
    bindingConfig: profile,
    configs,
    mapFaceRigToPoseOptions: mapOpts,
    sourceType: "manual",
  })

  if (!finalServoOutputs.length) {
    throw new Error("无可下发的 Bus 输出（检查 rigSnapshot / 绑定配置）")
  }

  const bundle = loadActuatorProfiles()
  onCommandPreview?.(`[Bus Servo] ${finalServoOutputs.length} 路 · T=${timeMs} ms`)

  if (signal?.aborted) {
    return false
  }

  const res = await dispatchBindingWorkbenchOutputs({
    finalServoOutputs,
    outputMode: OUTPUT_MODES.BUS_SERVO,
    driveArmed: true,
    configs,
    actuatorProfiles: bundle.actuatorProfiles,
    profilesReady: bundle.allowRealSend,
    timeMs,
    busSerialConnected: isSharedBusWireConnected(),
    openBusIfNeeded: true,
  })

  if (!res.ok) {
    throw new Error(res.error || res.message || "总线舵机下发失败")
  }

  return true
}
