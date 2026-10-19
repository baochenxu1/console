import {
  BINDING_RANGE_MODE_CUSTOM,
  CURVE_LINEAR,
  bindingWithRestoredEndpointsVsNeutral,
  normalizeBinding,
  normalizeFaceRigProfile,
  rangeForControlId,
} from "../../core/faceRigProfile.js"
import { SERVO_COUNT } from "../../core/servoConfig.js"
import { clampNumber, toInt } from "../../utils/clamp.js"

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 选一个未被占用的舵机号。
 * 硬约束：永不返回 ≤0（总线协议与 isForbiddenBusId 均会跳过 ID0）。
 */
export function pickUnusedServoId(bindings, preferred = 1) {
  const used = new Set(
    (bindings || [])
      .map((b) => Number(b?.servoId))
      .filter((n) => Number.isFinite(n))
  )
  const maxId = Math.max(1, SERVO_COUNT - 1)
  const start = clampNumber(toInt(preferred, 1), 1, maxId)
  for (let i = 0; i < maxId; i += 1) {
    const id = ((start - 1 + i) % maxId) + 1
    if (!used.has(id)) return id
  }
  return start
}

/**
 * 新增绑定时优先选用：preferred → 已有 actuator profile 的总线号 → 其它空闲号(≥1)。
 * @param {Array} bindings
 * @param {number|null} preferred
 * @param {number[]} availableBusIds 来自 loadActuatorProfiles 的 busServoId 列表
 */
export function pickPreferredBindingServoId(bindings, preferred = null, availableBusIds = []) {
  const used = new Set(
    (bindings || [])
      .map((b) => Number(b?.servoId))
      .filter((n) => Number.isFinite(n))
  )
  const preferredId = preferred == null ? NaN : Number(preferred)
  if (Number.isFinite(preferredId) && preferredId > 0 && !used.has(preferredId)) {
    return preferredId
  }
  const profileIds = [
    ...new Set(
      (availableBusIds || [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0)
    ),
  ].sort((a, b) => a - b)
  for (const id of profileIds) {
    if (!used.has(id)) return id
  }
  return pickUnusedServoId(bindings, 1)
}

function patchBinding(bindingId, patch, binding) {
  const forcesCustom =
    Object.prototype.hasOwnProperty.call(patch, "positiveTargetPwm") ||
    Object.prototype.hasOwnProperty.call(patch, "negativeTargetPwm") ||
    Object.prototype.hasOwnProperty.call(patch, "neutralPwm")
  const nextPatch = forcesCustom ? { ...patch, rangeMode: BINDING_RANGE_MODE_CUSTOM } : patch
  return normalizeBinding({ ...binding, ...nextPatch })
}

export function addBinding(profile, binding) {
  const p = normalizeFaceRigProfile(profile)
  const nextBinding = normalizeBinding({
    bindingId: binding?.bindingId || uid("bind"),
    ...binding,
  })
  return normalizeFaceRigProfile({
    ...p,
    bindings: [...(p.bindings || []), nextBinding],
    updatedAt: new Date().toISOString(),
  })
}

export function updateBinding(profile, bindingId, patch) {
  const p = normalizeFaceRigProfile(profile)
  const nextBindings = (p.bindings || []).map((b) =>
    b.bindingId === bindingId ? patchBinding(bindingId, patch, b) : b
  )
  return normalizeFaceRigProfile({
    ...p,
    bindings: nextBindings,
    updatedAt: new Date().toISOString(),
  })
}

export function deleteBinding(profile, bindingId) {
  const p = normalizeFaceRigProfile(profile)
  return normalizeFaceRigProfile({
    ...p,
    bindings: (p.bindings || []).filter((b) => b.bindingId !== bindingId),
    updatedAt: new Date().toISOString(),
  })
}

/** 一键清空全部绑定（保留 controls / 迁移版本标记，不回填默认绑定） */
export function clearAllBindings(profile) {
  const p = normalizeFaceRigProfile(profile)
  return normalizeFaceRigProfile({
    ...p,
    bindings: [],
    updatedAt: new Date().toISOString(),
  })
}

export function duplicateBinding(profile, bindingId) {
  const p = normalizeFaceRigProfile(profile)
  const idx = p.bindings.findIndex((b) => b.bindingId === bindingId)
  if (idx < 0) {
    return p
  }
  const b = p.bindings[idx]
  const copy = normalizeBinding({
    ...b,
    bindingId: uid("bind"),
  })
  const next = [...p.bindings]
  next.splice(idx + 1, 0, copy)
  return normalizeFaceRigProfile({
    ...p,
    bindings: next,
    updatedAt: new Date().toISOString(),
  })
}

function pickServoForReversedCopy(bindings, sourceBindingId) {
  const b = bindings.find((x) => x.bindingId === sourceBindingId)
  if (!b) {
    return 1
  }
  const used = new Set(
    (bindings || []).map((x) => Number(x.servoId)).filter((n) => Number.isFinite(n))
  )
  const maxId = Math.max(1, SERVO_COUNT - 1)
  const start = clampNumber(toInt(b.servoId, 1), 1, maxId)
  for (let i = 0; i < maxId; i += 1) {
    const id = ((start - 1 + i) % maxId) + 1
    if (!used.has(id) && id !== Number(b.servoId)) {
      return id
    }
  }
  return pickUnusedServoId(bindings, start === maxId ? 1 : start + 1)
}

export function duplicateBindingAsReverse(profile, bindingId) {
  const p = normalizeFaceRigProfile(profile)
  const idx = p.bindings.findIndex((b) => b.bindingId === bindingId)
  if (idx < 0) {
    return p
  }
  const b = p.bindings[idx]
  const servoId = pickServoForReversedCopy(p.bindings, bindingId)
  const copy = normalizeBinding({
    bindingId: uid("bind"),
    controlId: b.controlId,
    channel: b.channel,
    servoId,
    neutralPwm: b.neutralPwm,
    positiveTargetPwm: b.positiveTargetPwm,
    negativeTargetPwm: b.negativeTargetPwm,
    invert: !b.invert,
    weight: b.weight,
    curve: b.curve,
    enabled: true,
    rangeMode: b.rangeMode,
  })
  const next = [...p.bindings]
  next.splice(idx + 1, 0, copy)
  return normalizeFaceRigProfile({
    ...p,
    bindings: next,
    updatedAt: new Date().toISOString(),
  })
}

export function reverseBinding(profile, bindingId) {
  const p = normalizeFaceRigProfile(profile)
  const nextBindings = (p.bindings || []).map((b) =>
    b.bindingId === bindingId
      ? normalizeBinding({
          ...b,
          invert: !b.invert,
        })
      : b
  )
  return normalizeFaceRigProfile({
    ...p,
    bindings: nextBindings,
    updatedAt: new Date().toISOString(),
  })
}

export function setBindingDirection(profile, bindingId, invert) {
  return updateBinding(profile, bindingId, { invert: Boolean(invert) })
}

export function restoreBindingFullRange(profile, bindingId) {
  const p = normalizeFaceRigProfile(profile)
  const nextBindings = (p.bindings || []).map((b) =>
    b.bindingId === bindingId ? bindingWithRestoredEndpointsVsNeutral(b) : b
  )
  return normalizeFaceRigProfile({
    ...p,
    bindings: nextBindings,
    updatedAt: new Date().toISOString(),
  })
}

function logicalFromContributions(bindingId, contributions) {
  const c = contributions.find((x) => x && x.bindingId === bindingId)
  const lm = c?.logicalPwm
  return Number.isFinite(lm) ? lm : null
}

export function setBindingNeutralFromContribution(profile, bindingId, contributions) {
  const lm = logicalFromContributions(bindingId, contributions)
  if (!Number.isFinite(lm)) {
    return normalizeFaceRigProfile(profile)
  }
  return updateBinding(profile, bindingId, {
    neutralPwm: Math.round(lm),
    rangeMode: BINDING_RANGE_MODE_CUSTOM,
  })
}

export function setBindingPositiveFromContribution(profile, bindingId, contributions) {
  const lm = logicalFromContributions(bindingId, contributions)
  if (!Number.isFinite(lm)) {
    return normalizeFaceRigProfile(profile)
  }
  return updateBinding(profile, bindingId, {
    positiveTargetPwm: Math.round(lm),
    rangeMode: BINDING_RANGE_MODE_CUSTOM,
  })
}

export function setBindingNegativeFromContribution(profile, bindingId, contributions) {
  const lm = logicalFromContributions(bindingId, contributions)
  if (!Number.isFinite(lm)) {
    return normalizeFaceRigProfile(profile)
  }
  return updateBinding(profile, bindingId, {
    negativeTargetPwm: Math.round(lm),
    rangeMode: BINDING_RANGE_MODE_CUSTOM,
  })
}

/** 在当前控件新增一条默认绑定（与检视器逻辑一致）：需传入 controlId、channel */
export function addBindingForControlChannel(profile, controlId, channel, options = {}) {
  const p = normalizeFaceRigProfile(profile)
  const { neutral, pos, neg } = rangeForControlId(controlId)
  const availableBusIds = Array.isArray(options.availableBusIds) ? options.availableBusIds : []
  const servoId = pickPreferredBindingServoId(
    p.bindings,
    options.preferredServoId ?? null,
    availableBusIds
  )
  return addBinding(profile, {
    controlId,
    channel,
    servoId,
    neutralPwm: neutral,
    positiveTargetPwm: pos,
    negativeTargetPwm: neg,
    weight: 1,
    curve: CURVE_LINEAR,
    enabled: true,
    rangeMode: undefined,
    ...options.bindingOverrides,
  })
}
