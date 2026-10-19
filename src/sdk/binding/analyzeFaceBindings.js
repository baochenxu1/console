import {
  STANDARD_CENTER_PWM,
} from "../../core/servoConfig.js"
import { legacyServoIndexToActuatorKey } from "../output/actuatorKeys.js"

function bindingChannelKey(b) {
  return `${b.controlId}.${b.channel}`
}

function actuatorKeyForBinding(b) {
  return b.actuatorKey || legacyServoIndexToActuatorKey(b.servoId)
}

/**
 * 面部绑定配置诊断（导入 / 工作台）。
 * @param {object} profile normalize 后的 FaceRigProfile
 */
export function analyzeFaceBindings(profile) {
  const controls = profile?.controls || []
  const bindings = profile?.bindings || []
  const ignoredControls = new Set(profile?.ignoredControls || [])

  const controlIds = new Set(controls.map((c) => c.controlId))
  const activeBindings = bindings.filter((b) => b.enabled !== false)
  const disabledBindings = bindings.filter((b) => b.enabled === false)

  const activeByControlChannel = new Map()
  const activeByActuator = new Map()
  const duplicateActiveControls = []
  const duplicateActiveActuators = []
  const non1500Neutrals = []
  const warnings = []
  const errors = []

  for (const b of activeBindings) {
    if (!b.actuatorKey) {
      errors.push(`${bindingChannelKey(b)}: actuator-key-missing`)
    }
    if (!controlIds.has(b.controlId)) {
      errors.push(`${bindingChannelKey(b)}: control-not-found`)
    }

    const cc = bindingChannelKey(b)
    if (activeByControlChannel.has(cc)) {
      duplicateActiveControls.push(cc)
    } else {
      activeByControlChannel.set(cc, b)
    }

    const ak = actuatorKeyForBinding(b)
    if (activeByActuator.has(ak)) {
      duplicateActiveActuators.push(ak)
    } else {
      activeByActuator.set(ak, b)
    }

    if (Number(b.positiveTargetPwm) === Number(b.negativeTargetPwm)) {
      errors.push(
        `${bindingChannelKey(b)}→${ak}: 正负目标相同 (${b.positiveTargetPwm})，控件双向同向`
      )
    }

    if (Number(b.neutralPwm) !== STANDARD_CENTER_PWM) {
      non1500Neutrals.push({
        actuatorKey: ak,
        legacyServoIndex: b.legacyServoIndex ?? b.servoId,
        controlId: b.controlId,
        channel: b.channel,
        neutralPwm: b.neutralPwm,
        migratedFromNeutralPwm: b.migratedFromNeutralPwm ?? null,
      })
    }

    if (b.controlId === "tongue" || Number(b.servoId) === 11) {
      warnings.push(`tongue / ${ak} 处于启用状态（舌头暂未配置时可禁用）`)
    }
  }

  const boundControlIds = new Set(activeBindings.map((b) => b.controlId))
  const missingControls = controls
    .map((c) => c.controlId)
    .filter((id) => !boundControlIds.has(id) && !ignoredControls.has(id))

  for (const id of missingControls) {
    warnings.push(`${id}: unbound`)
  }

  const activeActuatorKeys = [...activeByActuator.keys()].sort()
  const activeLegacyIndices = activeActuatorKeys
    .map((k) => Number(String(k).replace(/^servo_/, "")))
    .filter(Number.isFinite)

  const leftFaceRange = []
  for (let i = 14; i <= 23; i += 1) {
    if (!activeLegacyIndices.includes(i)) {
      leftFaceRange.push(i)
    }
  }
  if (leftFaceRange.length) {
    warnings.push(
      `左脸 14~23 无 active binding: ${leftFaceRange.map((i) => `servo_${i}`).join(", ")}`
    )
  }

  if (non1500Neutrals.length) {
    warnings.push(
      `non1500 neutral（Bus 模式建议迁移）: ${non1500Neutrals.map((n) => n.actuatorKey).join(", ")}`
    )
  }

  if (profile?.busSemanticsMigratedAt) {
    warnings.push(`已于 ${profile.busSemanticsMigratedAt} 迁移为 Bus 绑定语义`)
  }

  return {
    activeBindings,
    disabledBindings,
    missingControls,
    ignoredControls: [...ignoredControls],
    duplicateActiveControls: [...new Set(duplicateActiveControls)],
    duplicateActiveActuators: [...new Set(duplicateActiveActuators)],
    non1500Neutrals,
    activeActuatorKeys,
    activeLegacyIndices,
    leftFaceMissingActuators: leftFaceRange.map((i) => legacyServoIndexToActuatorKey(i)),
    warnings: [...new Set(warnings)],
    errors: [...new Set(errors)],
  }
}
