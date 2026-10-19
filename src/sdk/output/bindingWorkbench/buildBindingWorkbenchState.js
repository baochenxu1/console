import {
  buildBusCommandsFromFinalOutputs,
  formatBusCommandsPreview,
} from "../adapters/busServoOutputAdapter.js"
import { enrichFinalServoOutputsForPreview } from "../enrichFinalServoOutputs.js"
import { loadActuatorProfiles } from "../loadActuatorProfiles.js"
import { OUTPUT_MODES } from "../../trackingPreview/trackingPreviewConstants.js"
import { analyzeFaceBindings } from "../../binding/analyzeFaceBindings.js"
import { analyzeActuatorProfiles } from "../analyzeActuatorProfiles.js"
import { evaluateBusCommandsPortGate } from "../../servoAdapters/busServo/resolveBusTransport.js"
import { buildFinalServoOutputsForBindingWorkbench } from "./buildFinalServoOutputsForBindingWorkbench.js"
import { evaluateBindingOutputGates } from "./evaluateBindingOutputGates.js"

/**
 * 绑定工作台完整输出状态（诊断 + dry-run adapter 结果）。
 *
 * light=true：跳过绑定/profile 分析以减负（仅下发热路径）。
 * 注意：light stub 的 activeBindings 为空，禁止用于 UI 诊断面板。
 */
export function buildBindingWorkbenchState({
  previewRigFrame,
  bindingConfig,
  configs = [],
  mapFaceRigToPoseOptions,
  selectedBinding = null,
  testMode = null,
  outputMode = "preview",
  driveArmed = false,
  busSerialConnected = false,
  busFamilyLabel = "",
  actuatorProfiles: actuatorProfilesIn = null,
  timeMs = 40,
  sourceType = "manual",
  /** 拖动/实时下发：跳过绑定分析，减主线程占用。UI 诊断必须传 false。 */
  light = false,
} = {}) {
  void timeMs

  const bundle = actuatorProfilesIn
    ? { actuatorProfiles: actuatorProfilesIn, allowRealSend: actuatorProfilesIn.length > 0 }
    : loadActuatorProfiles()

  const finalServoOutputs = buildFinalServoOutputsForBindingWorkbench({
    previewRigFrame,
    bindingConfig,
    configs,
    mapFaceRigToPoseOptions,
    selectedBinding,
    testMode,
    sourceType,
  })

  const bindingAnalysis = light
    ? {
        activeBindings: [],
        disabledBindings: [],
        missingControls: [],
        ignoredControls: [],
        duplicateActiveControls: [],
        duplicateActiveActuators: [],
        non1500Neutrals: [],
        activeActuatorKeys: [],
        activeLegacyIndices: [],
        leftFaceMissingActuators: [],
        warnings: [],
        errors: [],
        light: true,
      }
    : analyzeFaceBindings(bindingConfig)
  const actuatorProfileAnalysis = light
    ? {
        profileCount: bundle.actuatorProfiles?.length ?? 0,
        mismatchCount: 0,
        mismatches: [],
        warnings: [],
        errors: [],
        aligned: true,
        light: true,
      }
    : analyzeActuatorProfiles(bundle.actuatorProfiles)

  const enrichedOutputs = enrichFinalServoOutputsForPreview(
    finalServoOutputs,
    bundle.actuatorProfiles
  )

  const busBuilt = buildBusCommandsFromFinalOutputs(
    finalServoOutputs,
    bundle.actuatorProfiles
  )

  const gatesBase = evaluateBindingOutputGates({
    driveArmed,
    outputMode,
    busSerialConnected,
    busFamilyLabel,
    profilesReady: bundle.allowRealSend,
    finalOutputCount: finalServoOutputs.length,
  })

  let gates = gatesBase
  if (gatesBase.canSend && busBuilt.commands?.length) {
    const portGate = evaluateBusCommandsPortGate(busBuilt.commands)
    if (!portGate.ok) {
      gates = {
        ...gatesBase,
        canSend: false,
        note: portGate.reason,
        reason: "bus-port-gate",
      }
    }
  }

  const isBus =
    outputMode === OUTPUT_MODES.BUS_SERVO ||
    outputMode === "bus-servo" ||
    outputMode === "pwm" // 历史值：按总线预览

  const adapterPreview = isBus
    ? {
        mode: "bus",
        commandPreview: formatBusCommandsPreview(busBuilt.commands),
        commands: busBuilt.commands,
        skipped: busBuilt.skipped,
        summary: busBuilt.summary,
      }
    : {
        mode: "preview",
        commandPreview: formatBusCommandsPreview(busBuilt.commands),
        commands: busBuilt.commands,
        skipped: busBuilt.skipped,
        summary: busBuilt.summary,
      }

  return {
    finalServoOutputs,
    enrichedOutputs,
    adapterPreview,
    busBuilt,
    /** @deprecated 兼容旧 UI；等同 commandPreview */
    pwmCommand: adapterPreview.commandPreview,
    gates,
    bindingAnalysis,
    actuatorProfileAnalysis,
    actuatorProfiles: bundle.actuatorProfiles,
    profilesReady: bundle.allowRealSend,
    profileSource: bundle.source,
  }
}
