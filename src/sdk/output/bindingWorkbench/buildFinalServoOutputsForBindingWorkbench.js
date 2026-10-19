import {
  actuatorKeyToLegacyIndex,
  legacyServoIndexToActuatorKey,
} from "../actuatorKeys.js"
import { reconcileBindingActuatorFields } from "../../binding/bindingActuatorFields.js"
import { buildFinalServoOutputsFromBindings } from "../buildFinalServoOutputsFromBindings.js"
import { applySelectedBindingTestPose } from "./bindingWorkbenchRig.js"

/**
 * 面部绑定工作台：统一入口，内部仍调用 buildFinalServoOutputsFromBindings。
 *
 * @param {object} params
 * @param {object} params.previewRigFrame elite rig
 * @param {object} params.bindingConfig FaceRigProfile
 * @param {object[]} [params.configs]
 * @param {object} [params.mapFaceRigToPoseOptions]
 * @param {object} [params.selectedBinding]
 * @param {'center'|'positive'|'negative'|null} [params.testMode]
 * @param {import('../finalServoOutputTypes.js').FinalServoSourceType} [params.sourceType]
 */
export function buildFinalServoOutputsForBindingWorkbench({
  previewRigFrame,
  bindingConfig,
  configs = [],
  mapFaceRigToPoseOptions,
  selectedBinding = null,
  testMode = null,
  sourceType = "manual",
} = {}) {
  if (!previewRigFrame || typeof previewRigFrame !== "object") {
    return []
  }

  let rig = previewRigFrame
  if (testMode && selectedBinding) {
    rig = applySelectedBindingTestPose(rig, bindingConfig, selectedBinding, testMode)
  }

  const outputs = buildFinalServoOutputsFromBindings({
    profile: bindingConfig,
    rig,
    configs,
    sourceType,
    mapFaceRigToPoseOptions,
    debugTrace: true,
  })

  if (testMode && selectedBinding) {
    const reconciled = reconcileBindingActuatorFields(selectedBinding)
    const actuatorKey =
      reconciled.actuatorKey ||
      legacyServoIndexToActuatorKey(reconciled.servoId)
    const legacyIdx = actuatorKeyToLegacyIndex(actuatorKey) ?? reconciled.servoId
    return outputs.filter(
      (o) =>
        o.actuatorKey === actuatorKey ||
        o.bindingId === selectedBinding.bindingId ||
        o.legacyServoIndex === legacyIdx
    )
  }

  return outputs
}
