import { CHANNEL_VALUE } from "../../core/faceRigProfile.js"
import {
  BROW_L_D_SERVO_ID,
  BROW_L_F_SERVO_ID,
  BROW_R_D_SERVO_ID,
  BROW_R_F_SERVO_ID,
} from "./browTipDualBindingDefaults.js"
import { filterJawBindingsForInspector } from "./jawBindingUi.js"

/**
 * 眉尖绑定按运动学节点，不按 XY：
 *   右眉：F → brow_r_F → ID1；D → brow_r_D → ID2
 *   左眉：F → brow_l_F → ID24；D → brow_l_D → ID23
 *
 * 禁止：横向→执行器B、纵向→执行器A，或任何 XY→单舵机映射。
 */

/** 绑定检视用节点通道（不是 pad 的 x/y） */
export const BROW_TIP_BIND_CHANNEL_F = "F"
export const BROW_TIP_BIND_CHANNEL_D = "D"
/** @deprecated 左/右已统一为 F/D */
export const BROW_TIP_BIND_CHANNEL_A = "tip_a"
/** @deprecated */
export const BROW_TIP_BIND_CHANNEL_B = "tip_b"

export function isBrowTipSemanticControlId(controlId) {
  return controlId === "brow_l_tip" || controlId === "brow_r_tip"
}

export function isBrowTipActuatorControlId(controlId) {
  return (
    controlId === "brow_r_F" ||
    controlId === "brow_r_D" ||
    controlId === "brow_l_F" ||
    controlId === "brow_l_D" ||
    controlId === "brow_r_tip_a" ||
    controlId === "brow_r_tip_b" ||
    controlId === "brow_l_tip_a" ||
    controlId === "brow_l_tip_b"
  )
}

export function browTipSidePrefix(controlId) {
  if (String(controlId || "").startsWith("brow_r")) return "brow_r"
  return "brow_l"
}

/**
 * @returns {{
 *   semanticControlId: string,
 *   primaryId: string,
 *   secondaryId: string,
 *   primaryChannel: string,
 *   secondaryChannel: string,
 *   labels: { primary: string, secondary: string },
 *   defaultServoPrimary: number,
 *   defaultServoSecondary: number,
 * } | null}
 */
export function browTipActuatorPair(semanticOrActuatorId) {
  const id = String(semanticOrActuatorId || "")
  if (
    id === "brow_r_tip" ||
    id === "brow_r_F" ||
    id === "brow_r_D" ||
    id.startsWith("brow_r_tip_")
  ) {
    return {
      semanticControlId: "brow_r_tip",
      primaryId: "brow_r_F",
      secondaryId: "brow_r_D",
      primaryChannel: BROW_TIP_BIND_CHANNEL_F,
      secondaryChannel: BROW_TIP_BIND_CHANNEL_D,
      labels: {
        primary: "F → ID1（内侧 / qF）",
        secondary: "D → ID2（外侧 / qD）",
      },
      defaultServoPrimary: BROW_R_F_SERVO_ID,
      defaultServoSecondary: BROW_R_D_SERVO_ID,
    }
  }
  if (
    id === "brow_l_tip" ||
    id === "brow_l_F" ||
    id === "brow_l_D" ||
    id.startsWith("brow_l_tip_")
  ) {
    return {
      semanticControlId: "brow_l_tip",
      primaryId: "brow_l_F",
      secondaryId: "brow_l_D",
      primaryChannel: BROW_TIP_BIND_CHANNEL_F,
      secondaryChannel: BROW_TIP_BIND_CHANNEL_D,
      labels: {
        primary: "F → ID24（内侧 / qF）",
        secondary: "D → ID23（外侧 / qD）",
      },
      defaultServoPrimary: BROW_L_F_SERVO_ID,
      defaultServoSecondary: BROW_L_D_SERVO_ID,
    }
  }
  return null
}

/** 将检视选中态解析为唯一执行器 controlId（一通道一 ID）。 */
export function resolveBrowTipBindControlId(selectedControlId, selectedChannel) {
  if (isBrowTipActuatorControlId(selectedControlId)) {
    if (selectedControlId === "brow_r_tip_b") return "brow_r_F"
    if (selectedControlId === "brow_r_tip_a") return "brow_r_D"
    if (selectedControlId === "brow_l_tip_b") return "brow_l_F"
    if (selectedControlId === "brow_l_tip_a") return "brow_l_D"
    return selectedControlId
  }
  const pair = browTipActuatorPair(selectedControlId)
  if (!pair) return null
  const ch = String(selectedChannel || "")
  /* tip_a ≡ D（secondary）；tip_b ≡ F（primary） */
  if (
    ch === pair.secondaryChannel ||
    ch === pair.secondaryId ||
    ch === "D" ||
    ch === "tip_a" ||
    ch === "A"
  ) {
    return pair.secondaryId
  }
  /* 默认 F；x/y 不当作执行器映射 */
  return pair.primaryId
}

/**
 * @deprecated 已废除 XY→执行器映射。
 */
export function browTipActuatorControlIdForChannel(_semanticControlId, _channel) {
  return null
}

/**
 * @returns {{
 *   hostControlId: string,
 *   hostChannel: string,
 *   isBrowTipSemantic: boolean,
 *   isBrowTipBinding: boolean,
 *   actuatorAId: string | null,
 *   actuatorBId: string | null,
 *   primaryId: string | null,
 *   secondaryId: string | null,
 *   bindChannel: string | null,
 *   expectedServoId: number | null,
 *   pair: ReturnType<typeof browTipActuatorPair>,
 * }}
 */
export function resolveBrowTipBindingHost(selectedControlId, selectedChannel) {
  const pair = browTipActuatorPair(selectedControlId)
  if (!pair && !isBrowTipActuatorControlId(selectedControlId)) {
    return {
      hostControlId: selectedControlId,
      hostChannel: selectedChannel || CHANNEL_VALUE,
      isBrowTipSemantic: false,
      isBrowTipBinding: false,
      actuatorAId: null,
      actuatorBId: null,
      primaryId: null,
      secondaryId: null,
      bindChannel: null,
      expectedServoId: null,
      pair: null,
    }
  }
  const p = pair || browTipActuatorPair(selectedControlId)
  const hostControlId = resolveBrowTipBindControlId(selectedControlId, selectedChannel)
  const isSecondary = hostControlId === p.secondaryId
  return {
    hostControlId,
    hostChannel: CHANNEL_VALUE,
    isBrowTipSemantic: isBrowTipSemanticControlId(selectedControlId),
    isBrowTipBinding: true,
    actuatorAId: p.primaryId,
    actuatorBId: p.secondaryId,
    primaryId: p.primaryId,
    secondaryId: p.secondaryId,
    bindChannel: isSecondary ? p.secondaryChannel : p.primaryChannel,
    expectedServoId: isSecondary ? p.defaultServoSecondary : p.defaultServoPrimary,
    pair: p,
  }
}

/**
 * 当前 F/D 通道的新增目标；已有则返回 null。
 */
export function resolveBrowTipAddTarget(bindings, selectedControlId, selectedChannel) {
  const host = resolveBrowTipBindingHost(selectedControlId, selectedChannel)
  if (!host.isBrowTipBinding || !host.hostControlId) return null
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

/** 检视列表：眉尖 F/D、下颌 A/D，或普通 control+channel。 */
export function filterBindingsForInspector(bindings, selectedControlId, selectedChannel) {
  const jawList = filterJawBindingsForInspector(bindings, selectedControlId, selectedChannel)
  if (jawList) return jawList

  const list = Array.isArray(bindings) ? bindings : []
  const host = resolveBrowTipBindingHost(selectedControlId, selectedChannel)
  if (host.isBrowTipBinding && host.hostControlId) {
    return list.filter(
      (b) => b.controlId === host.hostControlId && b.channel === CHANNEL_VALUE
    )
  }
  return list.filter(
    (b) => b.controlId === selectedControlId && b.channel === selectedChannel
  )
}
