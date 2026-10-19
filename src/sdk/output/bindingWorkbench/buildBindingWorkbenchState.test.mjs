/**
 * 防止 light 诊断掏空 / 实时下发无输出 的回归。
 */
import assert from "node:assert/strict"
import test from "node:test"
import { normalizeFaceRigProfile } from "../../../core/faceRigProfile.js"
import { createInitialEliteRig } from "../../../core/faceDofMapper.js"
import { createBrowTipFivebarState } from "../../kinematics/browTipFivebar.js"
import { buildBindingWorkbenchState } from "./buildBindingWorkbenchState.js"

function fakeProfiles(n = 28) {
  return Array.from({ length: n }, (_, i) => {
    const id = i + 1
    return {
      actuatorKey: `servo_${id}`,
      busServoId: id,
      protocol: "scs",
      enabled: true,
      installedCenter: 512,
      logicalMin: 0,
      logicalMax: 1000,
    }
  })
}

test("light=true 仍必须产出 finalServoOutputs（下发热路径）", () => {
  const profile = normalizeFaceRigProfile({})
  const rig = createInitialEliteRig()
  const state = buildBindingWorkbenchState({
    previewRigFrame: rig,
    bindingConfig: profile,
    configs: [],
    mapFaceRigToPoseOptions: {
      leftBrowTipFivebarState: createBrowTipFivebarState(),
      rightBrowTipFivebarState: createBrowTipFivebarState(),
    },
    outputMode: "bus-servo",
    driveArmed: true,
    busSerialConnected: true,
    actuatorProfiles: fakeProfiles(),
    light: true,
  })
  assert.ok(state.finalServoOutputs.length > 0, "light 不得清空 finalServoOutputs")
  assert.equal(state.bindingAnalysis?.light, true)
  assert.equal(state.bindingAnalysis?.activeBindings?.length, 0)
})

test("light=false UI 诊断必须有 activeBindings", () => {
  const profile = normalizeFaceRigProfile({})
  const state = buildBindingWorkbenchState({
    previewRigFrame: createInitialEliteRig(),
    bindingConfig: profile,
    configs: [],
    outputMode: "bus-servo",
    actuatorProfiles: fakeProfiles(),
    light: false,
  })
  assert.ok(state.bindingAnalysis.activeBindings.length > 0)
  assert.ok(state.finalServoOutputs.length > 0)
})

test("reset 中位 rig 仍可构建下发输出", () => {
  const profile = normalizeFaceRigProfile({})
  let rig = createInitialEliteRig()
  rig = {
    ...rig,
    browL: { ...rig.browL, x: 40, y: -30 },
    jaw: { ...rig.jaw, val: 20 },
  }
  const moved = buildBindingWorkbenchState({
    previewRigFrame: rig,
    bindingConfig: profile,
    actuatorProfiles: fakeProfiles(),
    light: true,
  })
  assert.ok(moved.finalServoOutputs.length > 0)

  const reset = buildBindingWorkbenchState({
    previewRigFrame: createInitialEliteRig(),
    bindingConfig: profile,
    actuatorProfiles: fakeProfiles(),
    light: true,
  })
  assert.ok(reset.finalServoOutputs.length > 0)
  assert.ok(reset.busBuilt?.commands?.length > 0, "中位也必须能生成 bus 命令")
})
