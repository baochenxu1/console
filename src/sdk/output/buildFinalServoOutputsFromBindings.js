import {
  mapFaceRigToPose,
  rigValuesFromEliteRig,
} from "../../core/faceDofMapper.js"
import { normalizeFaceRigProfile } from "../../core/faceRigProfile.js"
import { getServoConfig, logicalToActualPwm } from "../../core/servoConfig.js"
import { traceFinalServoOutputs } from "../binding/bindingActuatorFields.js"
import { createRightMouthCornerFivebarState } from "../kinematics/mouthCornerFivebar.js"
import { buildMapFaceRigToPoseOptionsFromMouthRuntimes } from "../kinematics/mouthFiveBarRuntimeOptions.js"
import { legacyServoIndexToActuatorKey, actuatorKeyToLegacyIndex } from "./actuatorKeys.js"
import { pwmToLogical } from "./pwmLogicalConvert.js"

const _finalOutputsRightFiveBarState = createRightMouthCornerFivebarState()
const _finalOutputsLeftFiveBarState = createRightMouthCornerFivebarState()

function defaultMapFaceRigToPoseOptions() {
  return buildMapFaceRigToPoseOptionsFromMouthRuntimes({
    rightState: _finalOutputsRightFiveBarState,
    leftState: _finalOutputsLeftFiveBarState,
  })
}

function resolveBindingActuatorKey(binding) {
  const actuatorKey =
    binding?.actuatorKey ||
    (Number.isFinite(Number(binding?.legacyServoIndex))
      ? legacyServoIndexToActuatorKey(binding.legacyServoIndex)
      : Number.isFinite(Number(binding?.servoId))
        ? legacyServoIndexToActuatorKey(binding.servoId)
        : null)

  if (!actuatorKey) {
    return { ok: false, reason: "actuator-key-missing", actuatorKey: null }
  }

  const legacyFromKey = actuatorKeyToLegacyIndex(actuatorKey)
  const legacyServoIndex = Number.isFinite(legacyFromKey)
    ? legacyFromKey
    : Number(binding?.legacyServoIndex ?? binding?.servoId)

  if (!Number.isFinite(legacyServoIndex)) {
    return { ok: false, reason: "legacy-index-missing", actuatorKey }
  }

  return { ok: true, actuatorKey, legacyServoIndex, reason: null }
}

function readControlValueFromRig(rigValues, controlId, channel) {
  const node = rigValues?.[controlId]
  if (!node || typeof node !== "object") {
    return null
  }
  const ch = String(channel || "value")
  if (ch === "value" && Number.isFinite(Number(node.value))) {
    return Number(node.value)
  }
  if (ch === "x" && Number.isFinite(Number(node.x))) {
    return Number(node.x)
  }
  if (ch === "y" && Number.isFinite(Number(node.y))) {
    return Number(node.y)
  }
  const v = node[ch]
  return Number.isFinite(Number(v)) ? Number(v) : null
}

function indexActiveBindingsByActuatorKey(bindings) {
  const map = new Map()
  for (const b of bindings || []) {
    if (b?.enabled === false) {
      continue
    }
    // 新结构：tongue 不下发（即使旧 profile 误开 enabled）
    if (b?.controlId === "tongue") {
      continue
    }
    const resolved = resolveBindingActuatorKey(b)
    if (!resolved.ok) {
      continue
    }
    if (!map.has(resolved.actuatorKey)) {
      map.set(resolved.actuatorKey, [])
    }
    map.get(resolved.actuatorKey).push({ binding: b, ...resolved })
  }
  return map
}

/**
 * Face Binding Resolver：Face Rig → finalServoOutputs[]（actuatorKey 为主键）。
 */
export function buildFinalServoOutputsFromBindings({
  profile,
  rig,
  configs = [],
  sourceType = "tracking",
  mapFaceRigToPoseOptions,
  debugTrace = false,
  sourceFrameIndex = null,
  sourceTimestampMs = null,
} = {}) {
  if (!rig || typeof rig !== "object") {
    return []
  }

  const profileN = normalizeFaceRigProfile(profile || {})
  const rigValues = rigValuesFromEliteRig(rig)
  const mapOpts = mapFaceRigToPoseOptions ?? defaultMapFaceRigToPoseOptions()
  const mapped = mapFaceRigToPose(rigValues, profileN, configs, mapOpts)

  const bindingByActuator = indexActiveBindingsByActuatorKey(profileN.bindings)
  const contribByBindingId = new Map(
    (mapped.contributions || []).map((c) => [c.bindingId, c])
  )
  const cfgList = Array.isArray(configs) ? configs : []
  const outputs = []
  const skipped = []

  for (const [actuatorKey, entries] of bindingByActuator) {
    const primary = entries[0]
    const binding = primary.binding
    /** mapFaceRigToPose 按 binding.servoId 写入 logicalPose，必须用同一索引读取 */
    const poseServoId = Number(binding.servoId)
    const legacyServoIndex = primary.legacyServoIndex
    const sidStr = String(poseServoId)

    if (!Number.isFinite(poseServoId)) {
      skipped.push({
        actuatorKey,
        bindingId: binding?.bindingId,
        reason: "invalid-servo-id",
      })
      continue
    }

    const logicalPoseEntry = mapped.logicalPose?.[sidStr]
    const actualFromMap = mapped.actualPose?.[sidStr]
    const logicalPwm =
      logicalPoseEntry != null && typeof logicalPoseEntry === "object"
        ? logicalPoseEntry.logicalPwm ?? logicalPoseEntry.pwm
        : logicalPoseEntry
    const actualPwmResolved =
      actualFromMap != null && typeof actualFromMap === "object"
        ? actualFromMap.actualPwm ?? actualFromMap.pwm
        : actualFromMap

    if (logicalPwm == null && actualPwmResolved == null) {
      skipped.push({
        actuatorKey,
        bindingId: primary.binding?.bindingId,
        reason: "no-pose-output",
      })
      continue
    }

    const cfg = cfgList.length ? getServoConfig(cfgList, poseServoId) : null
    if (cfg?.enabled === false) {
      skipped.push({
        actuatorKey,
        bindingId: primary.binding?.bindingId,
        reason: "servo-config-disabled",
      })
      continue
    }

    const logicalPwmRounded =
      logicalPwm != null && Number.isFinite(Number(logicalPwm))
        ? Math.round(Number(logicalPwm))
        : null

    /**
     * pwmValue：可给旧 PWM 链路看「经 mechanicalZero 后的实际脉宽」。
     * logicalValue（0~1000）：必须直接来自绑定逻辑 PWM（中位 1500→500）。
     * 若再经 logicalToActualPwm，configs.mechanicalZero / direction 会把中位
     * 偏出 500，Bus SC/ST 就到不了型号默认中位（SC 512 / ST 2048）。
     */
    let pwmValue = actualPwmResolved ?? logicalPwmRounded
    if (logicalPwmRounded != null && cfg) {
      pwmValue = logicalToActualPwm(logicalPwmRounded, cfg).actualPwm
    } else if (pwmValue != null) {
      pwmValue = Math.round(Number(pwmValue))
    }

    if (!Number.isFinite(pwmValue) && logicalPwmRounded == null) {
      skipped.push({
        actuatorKey,
        bindingId: primary.binding?.bindingId,
        reason: "invalid-pwm",
      })
      continue
    }

    const contrib = contribByBindingId.get(binding.bindingId)
    const rawControlValue =
      contrib?.rawChannelValue ??
      readControlValueFromRig(rigValues, binding.controlId, binding.channel)
    const appliedControlValue = rawControlValue
    const filteredControlValue = appliedControlValue
    const logicalFromContrib = contrib?.logicalPwm
    const logicalValueSource =
      logicalPwmRounded != null ? logicalPwmRounded : Math.round(Number(pwmValue))

    outputs.push({
      actuatorKey,
      legacyServoIndex: poseServoId,
      logicalValue: pwmToLogical(logicalValueSource),
      pwmValue: Number.isFinite(pwmValue) ? pwmValue : logicalValueSource,
      sourceChannel: `${binding.controlId}.${binding.channel}`,
      bindingId: binding.bindingId,
      sourceType,
      enabled: true,
      rawControlValue,
      appliedControlValue,
      filteredControlValue,
      /** @deprecated 使用 appliedControlValue */
      controlValue: appliedControlValue,
      sourceFrameIndex,
      sourceTimestampMs,
      neutralPwm: binding.neutralPwm,
      positiveTargetPwm: binding.positiveTargetPwm,
      negativeTargetPwm: binding.negativeTargetPwm,
      invert: Boolean(binding.invert),
      direction: binding.invert ? "reverse" : "forward",
      curve: binding.curve ?? null,
      weight: binding.weight ?? null,
      debug: {
        logicalPwm: logicalPwmRounded,
        logicalPwmFromContribution: logicalFromContrib ?? null,
        actualPwmFromMap: actualFromMap ?? null,
        pwmValueAfterLegacyConvert: Number.isFinite(pwmValue) ? pwmValue : null,
        bindingCount: entries.length,
        servoIdLegacy: binding.servoId,
        rawControlValue,
        appliedControlValue,
        filteredControlValue,
        neutralPwm: binding.neutralPwm,
        positiveTargetPwm: binding.positiveTargetPwm,
        negativeTargetPwm: binding.negativeTargetPwm,
        invert: Boolean(binding.invert),
        direction: binding.invert ? "reverse" : "forward",
        curve: binding.curve ?? null,
        weight: binding.weight ?? null,
        sourceFrameIndex,
        sourceTimestampMs,
      },
    })
  }

  outputs.sort((a, b) => {
    const ai = a.legacyServoIndex ?? 0
    const bi = b.legacyServoIndex ?? 0
    return ai - bi
  })

  if (debugTrace) {
    traceFinalServoOutputs(outputs)
    if (skipped.length) {
      console.info("[FaceBinding:finalOutputs:skipped]", skipped)
    }
  }

  return outputs
}
