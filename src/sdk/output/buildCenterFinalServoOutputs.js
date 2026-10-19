import { createInitialEliteRig } from "../../core/faceDofMapper.js"
import { normalizeFaceRigProfile } from "../../core/faceRigProfile.js"
import { createRightMouthCornerFivebarState } from "../kinematics/mouthCornerFivebar.js"
import { buildMapFaceRigToPoseOptionsFromMouthRuntimes } from "../kinematics/mouthFiveBarRuntimeOptions.js"
import { buildFinalServoOutputsFromBindings } from "./buildFinalServoOutputsFromBindings.js"
import { LOGICAL_CENTER } from "./finalServoOutputTypes.js"
import { logicalToPwm } from "./pwmLogicalConvert.js"

/**
 * Stop / 回中：对活跃 actuator 生成 logical 500。
 * @param {string[] | { actuatorKey: string }[]} activeActuators
 */
export function buildCenterFinalServoOutputs(activeActuators) {
  const list = Array.isArray(activeActuators) ? activeActuators : []
  const keys = list.map((item) =>
    typeof item === "string" ? item : item?.actuatorKey
  ).filter(Boolean)

  return keys.map((actuatorKey) => ({
    actuatorKey,
    legacyServoIndex: Number(String(actuatorKey).replace(/^servo_/, "")) || undefined,
    logicalValue: LOGICAL_CENTER,
    pwmValue: logicalToPwm(LOGICAL_CENTER),
    sourceType: "center",
    enabled: true,
  }))
}

/**
 * 从 binding 配置收集所有启用 binding 的 actuatorKey（回中用）。
 */
export function listActuatorKeysFromBindings(profile) {
  const keys = new Set()
  for (const b of profile?.bindings || []) {
    if (b?.enabled === false) {
      continue
    }
    const sid = Number(b.servoId)
    if (Number.isFinite(sid)) {
      keys.add(`servo_${sid}`)
    }
    if (b.actuatorKey) {
      keys.add(String(b.actuatorKey))
    }
  }
  return [...keys]
}

/**
 * 与绑定页「工作台中位 / rig 50-50」一致：走 mapFaceRigToPose + 五杆 runtime + profile binding。
 * @param {object} params
 */
export function buildProfileNeutralFinalServoOutputs({ profile, configs = [] } = {}) {
  const profileN = normalizeFaceRigProfile(profile || {})
  const rightState = createRightMouthCornerFivebarState()
  const leftState = createRightMouthCornerFivebarState()
  const mapOpts = buildMapFaceRigToPoseOptionsFromMouthRuntimes({
    rightState,
    leftState,
  })
  return buildFinalServoOutputsFromBindings({
    profile: profileN,
    rig: createInitialEliteRig(),
    configs,
    sourceType: "profile-neutral",
    mapFaceRigToPoseOptions: mapOpts,
  })
}
