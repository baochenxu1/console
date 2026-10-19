/**
 * Jaw 节点 Binding：jaw_A / jaw_D（IK 输出 qA/qD）。
 *
 * 旧 Direct：jaw/value → 多舵机（常见 8 + 15）、jaw/lateral → 舵机（常见 28）。
 * 升级后：语义 jaw.{value,lateral} 仅作 2DOF 目标；执行器绑定只挂在 jaw_A / jaw_D。
 *
 * 默认 ID 约定（无独立机械铭牌证据时的迁移保序，非机构审计结论）：
 *   历史 createDefaultBindings 顺序 jaw/value→8 再 →15 ⇒ jaw_A=8，jaw_D=15。
 * 迁移时优先保留用户 profile 中的实际 Servo ID。
 */

import {
  CHANNEL_VALUE,
  normalizeBinding,
  normalizeControl,
  rangeForControlId,
} from "../../core/faceRigProfile.js"

export const JAW_NODE_BINDING_VERSION = "1"

/** 迁移保序默认：与旧默认 bindings 行序一致 */
export const JAW_A_DEFAULT_SERVO_ID = 8
export const JAW_D_DEFAULT_SERVO_ID = 15

export const JAW_NODE_CONTROLS = Object.freeze({
  jaw_A: Object.freeze({
    label: "下颌 · A 节点（qA）",
    node: "A",
    servoId: JAW_A_DEFAULT_SERVO_ID,
  }),
  jaw_D: Object.freeze({
    label: "下颌 · D 节点（qD）",
    node: "D",
    servoId: JAW_D_DEFAULT_SERVO_ID,
  }),
})

function makeNodeBinding(controlId, servoId) {
  const range = rangeForControlId(controlId)
  return normalizeBinding({
    bindingId: `bind_jaw_node_${controlId}_${servoId}`,
    controlId,
    channel: CHANNEL_VALUE,
    enabled: true,
    servoId: Number(servoId),
    curve: "linear",
    rangeMode: "full",
    neutralPwm: range.neutral,
    positiveTargetPwm: range.pos,
    negativeTargetPwm: range.neg,
  })
}

export function ensureJawNodeControls(controls) {
  let list = Array.isArray(controls) ? [...controls] : []
  const have = new Set(list.map((c) => c?.controlId))
  for (const [controlId, meta] of Object.entries(JAW_NODE_CONTROLS)) {
    if (have.has(controlId)) continue
    list.push(
      normalizeControl({
        controlId,
        label: meta.label,
        channels: { value: { mode: "signed100" } },
      })
    )
  }
  return list
}

function takeJawValueBindings(bindings) {
  return (bindings || []).filter(
    (b) => b?.controlId === "jaw" && b.channel === CHANNEL_VALUE && b.enabled !== false
  )
}

/**
 * 旧 jaw/value 双绑 → jaw_A / jaw_D，保留原 Servo ID。
 * 排序：先按 binding 出现序，再按 servoId，稳定映射第一路→A、第二路→D。
 */
export function patchJawNodeBindings(bindings) {
  let list = Array.isArray(bindings) ? [...bindings] : []

  const existingA = list.find(
    (b) => b?.controlId === "jaw_A" && b.channel === CHANNEL_VALUE && b.enabled !== false
  )
  const existingD = list.find(
    (b) => b?.controlId === "jaw_D" && b.channel === CHANNEL_VALUE && b.enabled !== false
  )

  const legacyValue = takeJawValueBindings(list)
  const sortedLegacy = [...legacyValue].sort((a, b) => {
    const sa = Number(a.servoId)
    const sb = Number(b.servoId)
    if (Number.isFinite(sa) && Number.isFinite(sb) && sa !== sb) return sa - sb
    return 0
  })

  let servoA = existingA ? Number(existingA.servoId) : null
  let servoD = existingD ? Number(existingD.servoId) : null

  if (!Number.isFinite(servoA) && sortedLegacy[0]) {
    servoA = Number(sortedLegacy[0].servoId)
  }
  if (!Number.isFinite(servoD) && sortedLegacy[1]) {
    servoD = Number(sortedLegacy[1].servoId)
  } else if (!Number.isFinite(servoD) && sortedLegacy[0] && sortedLegacy.length === 1) {
    /* 仅一路旧绑定：保留为 A，D 用默认（若与 A 冲突则跳过强制） */
    servoD = JAW_D_DEFAULT_SERVO_ID === servoA ? null : JAW_D_DEFAULT_SERVO_ID
  }

  if (!Number.isFinite(servoA)) servoA = JAW_A_DEFAULT_SERVO_ID
  if (!Number.isFinite(servoD)) servoD = JAW_D_DEFAULT_SERVO_ID
  if (servoA === servoD) {
    servoD = servoA === JAW_A_DEFAULT_SERVO_ID ? JAW_D_DEFAULT_SERVO_ID : JAW_A_DEFAULT_SERVO_ID
  }

  /* 移除旧 jaw 直接舵机绑定（value + lateral） */
  list = list.filter((b) => b?.controlId !== "jaw")

  const upsert = (controlId, servoId, prev) => {
    const next = makeNodeBinding(controlId, servoId)
    if (prev) {
      const hasCustomTargets =
        Number.isFinite(Number(prev.positiveTargetPwm)) ||
        Number.isFinite(Number(prev.negativeTargetPwm)) ||
        Number.isFinite(Number(prev.neutralPwm))
      return normalizeBinding({
        ...next,
        bindingId: prev.bindingId || next.bindingId,
        neutralPwm: prev.neutralPwm ?? next.neutralPwm,
        positiveTargetPwm: prev.positiveTargetPwm ?? next.positiveTargetPwm,
        negativeTargetPwm: prev.negativeTargetPwm ?? next.negativeTargetPwm,
        rangeMode: prev.rangeMode || (hasCustomTargets ? "custom" : next.rangeMode),
      })
    }
    return next
  }

  list = list.filter((b) => b?.controlId !== "jaw_A" && b?.controlId !== "jaw_D")
  list.push(upsert("jaw_A", servoA, existingA || sortedLegacy[0] || null))
  list.push(upsert("jaw_D", servoD, existingD || sortedLegacy[1] || null))

  return list
}

export function migrateJawNodeBindings(profileSlice = {}) {
  const controls = ensureJawNodeControls(profileSlice.controls)
  const bindings = patchJawNodeBindings(profileSlice.bindings)
  return { controls, bindings }
}

export function profileNeedsJawNodeBindingPatch(profile) {
  if (!profile || profile.jawNodeBindingVersion === JAW_NODE_BINDING_VERSION) {
    return false
  }
  return true
}
