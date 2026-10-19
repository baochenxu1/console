import { CHANNEL_VALUE, CHANNEL_LATERAL } from "../../core/faceRigProfile.js"
import {
  JAW_A_DEFAULT_SERVO_ID,
  JAW_D_DEFAULT_SERVO_ID,
} from "./jawNodeBindingDefaults.js"

/**
 * 下颌绑定按运动学节点，不按 value/lateral 直绑舵机：
 *   jaw_A ← qA（默认 ID8）
 *   jaw_D ← qD（默认 ID15）
 *
 * UI 开合/左右只改语义 jaw.{value,lateral}，经 Jaw 3D IK 后写节点。
 */

export const JAW_BIND_CHANNEL_A = "A"
export const JAW_BIND_CHANNEL_D = "D"

export function isJawSemanticControlId(controlId) {
  return controlId === "jaw"
}

export function isJawActuatorControlId(controlId) {
  return controlId === "jaw_A" || controlId === "jaw_D"
}

export function jawActuatorPair(controlId) {
  const id = String(controlId || "")
  if (id === "jaw" || id === "jaw_A" || id === "jaw_D") {
    return {
      semanticControlId: "jaw",
      primaryId: "jaw_A",
      secondaryId: "jaw_D",
      primaryChannel: JAW_BIND_CHANNEL_A,
      secondaryChannel: JAW_BIND_CHANNEL_D,
      labels: {
        primary: "A → jaw_A（qA）",
        secondary: "D → jaw_D（qD）",
      },
      defaultServoPrimary: JAW_A_DEFAULT_SERVO_ID,
      defaultServoSecondary: JAW_D_DEFAULT_SERVO_ID,
    }
  }
  return null
}

export function resolveJawBindControlId(selectedControlId, selectedChannel) {
  if (isJawActuatorControlId(selectedControlId)) {
    return selectedControlId
  }
  const pair = jawActuatorPair(selectedControlId)
  if (!pair) return null
  const ch = String(selectedChannel || "")
  if (
    ch === pair.secondaryChannel ||
    ch === pair.secondaryId ||
    ch === "D" ||
    ch === CHANNEL_LATERAL ||
    ch === "lateral"
  ) {
    return pair.secondaryId
  }
  return pair.primaryId
}

/**
 * @returns {{
 *   hostControlId: string,
 *   hostChannel: string,
 *   isJawSemantic: boolean,
 *   isJawBinding: boolean,
 *   primaryId: string | null,
 *   secondaryId: string | null,
 *   bindChannel: string | null,
 *   expectedServoId: number | null,
 *   pair: ReturnType<typeof jawActuatorPair>,
 * }}
 */
export function resolveJawBindingHost(selectedControlId, selectedChannel) {
  const pair = jawActuatorPair(selectedControlId)
  if (!pair && !isJawActuatorControlId(selectedControlId)) {
    return {
      hostControlId: selectedControlId,
      hostChannel: selectedChannel || CHANNEL_VALUE,
      isJawSemantic: false,
      isJawBinding: false,
      primaryId: null,
      secondaryId: null,
      bindChannel: null,
      expectedServoId: null,
      pair: null,
    }
  }
  const p = pair || jawActuatorPair(selectedControlId)
  const hostControlId = resolveJawBindControlId(selectedControlId, selectedChannel)
  const isSecondary = hostControlId === p.secondaryId
  return {
    hostControlId,
    hostChannel: CHANNEL_VALUE,
    isJawSemantic: isJawSemanticControlId(selectedControlId),
    isJawBinding: true,
    primaryId: p.primaryId,
    secondaryId: p.secondaryId,
    bindChannel: isSecondary ? p.secondaryChannel : p.primaryChannel,
    expectedServoId: isSecondary ? p.defaultServoSecondary : p.defaultServoPrimary,
    pair: p,
  }
}

export function resolveJawAddTarget(bindings, selectedControlId, selectedChannel) {
  const host = resolveJawBindingHost(selectedControlId, selectedChannel)
  if (!host.isJawBinding || !host.hostControlId) return null
  const list = Array.isArray(bindings) ? bindings : []
  const exists = list.some(
    (b) =>
      b?.controlId === host.hostControlId &&
      b.channel === CHANNEL_VALUE &&
      b.enabled !== false
  )
  if (exists) return null
  return {
    controlId: host.hostControlId,
    channel: CHANNEL_VALUE,
    servoId: host.expectedServoId,
    label:
      host.bindChannel === host.pair?.secondaryChannel
        ? host.pair.labels.secondary
        : host.pair.labels.primary,
  }
}

export function filterJawBindingsForInspector(bindings, selectedControlId, selectedChannel) {
  const list = Array.isArray(bindings) ? bindings : []
  const host = resolveJawBindingHost(selectedControlId, selectedChannel)
  if (host.isJawBinding && host.hostControlId) {
    return list.filter(
      (b) => b.controlId === host.hostControlId && b.channel === CHANNEL_VALUE
    )
  }
  return null
}
