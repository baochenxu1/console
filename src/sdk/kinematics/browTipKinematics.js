/**
 * 眉尖 2DOF：Semantic brow.x/y → Five-Bar IK → 节点角 → Binding。
 *
 * 右眉：F = brow_r_F ← qF → ID1；D = brow_r_D ← qD → ID2
 * 左眉：F = brow_l_F ← qF → ID24；D = brow_l_D ← qD → ID23
 * 遗留别名：tip_a ≡ D，tip_b ≡ F。
 */

import { CHANNEL_VALUE } from "../../core/faceRigProfile.js"
import {
  SERVO_LOGICAL_MIN_PWM,
  SERVO_LOGICAL_MAX_PWM,
  getServoConfig,
  logicalToActualPwm,
} from "../../core/servoConfig.js"
import {
  BROW_L_D_SERVO_ID,
  BROW_L_F_SERVO_ID,
  BROW_R_D_SERVO_ID,
  BROW_R_F_SERVO_ID,
} from "../binding/browTipDualBindingDefaults.js"
import {
  createBrowTipFivebarState,
  getDefaultBrowTipFivebarParams,
  normalizeBrowTipSideId,
  solveBrowTipIk,
  browAngleToBindingLogicalPwm,
} from "./browTipFivebar.js"
import {
  createRightBrowFiveBarSyncGroup,
  createLeftBrowFiveBarPairServo,
  getBrowFiveBarPairServoDiagnostics,
  stepBrowFiveBarPairServo,
} from "./rightBrowFiveBarSyncGroup.js"

export const BROW_TIP_SIDE_META = Object.freeze({
  left: Object.freeze({
    sideId: "left",
    label: "左眉尖",
    eliteKey: "browL",
    semanticControlId: "brow_l_tip",
    nodeFControlId: "brow_l_F",
    nodeDControlId: "brow_l_D",
    tipAControlId: "brow_l_tip_a",
    tipBControlId: "brow_l_tip_b",
    expectedServoFId: BROW_L_F_SERVO_ID,
    expectedServoDId: BROW_L_D_SERVO_ID,
  }),
  right: Object.freeze({
    sideId: "right",
    label: "右眉尖",
    eliteKey: "browR",
    semanticControlId: "brow_r_tip",
    nodeFControlId: "brow_r_F",
    nodeDControlId: "brow_r_D",
    tipAControlId: "brow_r_tip_a",
    tipBControlId: "brow_r_tip_b",
    expectedServoFId: BROW_R_F_SERVO_ID,
    expectedServoDId: BROW_R_D_SERVO_ID,
  }),
})

export function getBrowTipSideMeta(sideId = "left") {
  return BROW_TIP_SIDE_META[normalizeBrowTipSideId(sideId)]
}

/**
 * @param {object} [rigValues] flat mapFaceRig values or elite-ish
 * @param {"left"|"right"|string} [sideId]
 */
export function rigValuesForBrowTip(rigValues, sideId = "left") {
  const meta = getBrowTipSideMeta(sideId)
  if (!rigValues || typeof rigValues !== "object") {
    return { x: 0, y: 0 }
  }
  const semantic = rigValues[meta.semanticControlId]
  if (semantic && typeof semantic === "object") {
    const x = Number(semantic.x)
    const y = Number(semantic.y)
    return {
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
    }
  }
  const elite = rigValues[meta.eliteKey]
  if (elite && typeof elite === "object") {
    const x = Number(elite.x)
    const y = Number(elite.y)
    return {
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
    }
  }
  return { x: 0, y: 0 }
}

function findValueBinding(profile, controlId) {
  if (!controlId) return null
  return (
    (profile?.bindings || []).find(
      (b) => b?.controlId === controlId && b.channel === CHANNEL_VALUE && b.enabled !== false
    ) || null
  )
}

/**
 * 优先 brow_*_F / brow_*_D；兼容 tip_b→F、tip_a→D。
 */
function resolveNodeBindings(profile, meta) {
  const bindingF =
    findValueBinding(profile, meta.nodeFControlId) ||
    findValueBinding(profile, meta.tipBControlId)
  const bindingD =
    findValueBinding(profile, meta.nodeDControlId) ||
    findValueBinding(profile, meta.tipAControlId)
  const fKey = bindingF?.controlId || meta.nodeFControlId
  const dKey = bindingD?.controlId || meta.nodeDControlId
  return {
    bindingF,
    bindingD,
    /* 遗留字段：A≡D(qD)，B≡F(qF)，与 tipA_deg/tipB_deg 对齐 */
    bindingA: bindingD,
    bindingB: bindingF,
    nodeFBindingKey: fKey,
    nodeDBindingKey: dKey,
  }
}

function assertFdNotSwapped(servoFId, servoDId, meta) {
  const sideLabel = meta.label || meta.sideId
  const expectedF = meta.expectedServoFId
  const expectedD = meta.expectedServoDId
  const warnings = []
  if (Number.isFinite(servoFId) && Number.isFinite(servoDId) && servoFId === servoDId) {
    warnings.push(`${sideLabel} F/D 不能共用舵机 ID=${servoFId}`)
  }
  if (
    Number.isFinite(expectedF) &&
    Number.isFinite(servoFId) &&
    Number.isFinite(servoDId) &&
    servoFId === expectedD &&
    servoDId === expectedF
  ) {
    warnings.push(
      `${sideLabel} F/D 舵机反置：当前 F→ID${servoFId} D→ID${servoDId}，期望 F→ID${expectedF} D→ID${expectedD}`
    )
  }
  return warnings
}

/**
 * @param {object} profile
 * @param {"left"|"right"|string} [sideId]
 * @param {object} [options]
 */
export function resolveBrowTipKinematics(profile, sideId = "left", options = null) {
  const meta = getBrowTipSideMeta(sideId)
  const nodes = resolveNodeBindings(profile, meta)
  const { bindingF, bindingD, bindingA, bindingB, nodeFBindingKey, nodeDBindingKey } = nodes
  const servoFId = bindingF ? Number(bindingF.servoId) : null
  const servoDId = bindingD ? Number(bindingD.servoId) : null
  const servoAId = bindingA ? Number(bindingA.servoId) : null
  const servoBId = bindingB ? Number(bindingB.servoId) : null

  const userKin = options?.kinematics?.browTipFiveBar || options?.kinematics || {}
  const sideKin =
    (sideId === "right" ? userKin.right : userKin.left) || userKin[meta.sideId] || {}
  const structureKin = userKin.structure || userKin.browFiveBarStructure || {}
  const enabled = sideKin.enabled !== false && userKin.enabled !== false
  const params = {
    ...getDefaultBrowTipFivebarParams(sideId),
    ...structureKin,
    ...(options?.runtimeParams || {}),
    ...sideKin,
    sideId: meta.sideId,
  }

  const readyForIk =
    enabled &&
    bindingF &&
    bindingD &&
    Number.isFinite(servoFId) &&
    Number.isFinite(servoDId) &&
    servoFId !== servoDId

  const fdWarnings = assertFdNotSwapped(servoFId, servoDId, meta)

  let skipReason = ""
  if (!enabled) skipReason = `${meta.label}五杆未启用`
  else if (!bindingF || !bindingD) {
    skipReason = `${meta.label}缺少 ${meta.nodeFControlId} / ${meta.nodeDControlId} 绑定（或 tip_b/tip_a 别名）`
  } else if (!Number.isFinite(servoFId) || !Number.isFinite(servoDId)) {
    skipReason = `${meta.label} F/D 舵机号无效`
  } else if (servoFId === servoDId) skipReason = `${meta.label} F/D 不能共用舵机`

  return {
    sideId: meta.sideId,
    meta,
    enabled,
    readyForIk: Boolean(readyForIk),
    skipReason,
    bindingF,
    bindingD,
    bindingA,
    bindingB,
    servoFId: Number.isFinite(servoFId) ? servoFId : null,
    servoDId: Number.isFinite(servoDId) ? servoDId : null,
    servoAId: Number.isFinite(servoAId) ? servoAId : null,
    servoBId: Number.isFinite(servoBId) ? servoBId : null,
    nodeFBindingKey,
    nodeDBindingKey,
    fdWarnings,
    params,
  }
}

/**
 * @param {object} rigValues
 * @param {ReturnType<typeof resolveBrowTipKinematics>} resolved
 * @param {ReturnType<typeof createBrowTipFivebarState>} [state]
 */
export function computeBrowTipFiveBarIk(rigValues, resolved, state) {
  const pad = rigValuesForBrowTip(rigValues, resolved.sideId)
  const result = solveBrowTipIk({
    browTarget: pad,
    resolved,
    params: resolved.params,
    state: state || createBrowTipFivebarState(),
  })
  const lineage = {
    brow: { x: pad.x, y: pad.y },
    targetA: result.diagnostics?.Asafe || result.diagnostics?.Aworld || null,
    alphaF: result.diagnostics?.thetaFDeg ?? null,
    alphaD: result.diagnostics?.thetaDDeg ?? null,
    qF: result.qFDeg ?? result.tipB_deg,
    qD: result.qDDeg ?? result.tipA_deg,
    F: {
      bindingKey: resolved.nodeFBindingKey,
      servoId: resolved.servoFId,
      logicalPwm: result.pwmF ?? result.pwmB,
    },
    D: {
      bindingKey: resolved.nodeDBindingKey,
      servoId: resolved.servoDId,
      logicalPwm: result.pwmD ?? result.pwmA,
    },
  }

  const diagnostics = {
    ...(result.diagnostics || {}),
    enabled: resolved.enabled,
    readyForIk: resolved.readyForIk,
    overrideNote: result.ok
      ? `${resolved.meta.semanticControlId} (x,y) → fivebar IK → ${resolved.meta.nodeFControlId}(qF)/${resolved.meta.nodeDControlId}(qD)`
      : "",
    ikOk: result.ok,
    ikMessage: result.ok ? "" : result.message || "IK 失败",
    nodeFBindingKey: resolved.nodeFBindingKey,
    nodeDBindingKey: resolved.nodeDBindingKey,
    servoFId: resolved.servoFId,
    servoDId: resolved.servoDId,
    fdWarnings: resolved.fdWarnings || [],
    lineage,
  }
  return {
    ok: result.ok,
    message: result.message,
    pwmA: result.pwmA,
    pwmB: result.pwmB,
    pwmF: result.pwmF,
    pwmD: result.pwmD,
    tipA_deg: result.tipA_deg,
    tipB_deg: result.tipB_deg,
    qFDeg: result.qFDeg,
    qDDeg: result.qDDeg,
    diagnostics,
  }
}

/**
 * 剔除 F/D（或 tip_a/tip_b）线性贡献，改由 IK 写入。
 */
export function contributionExcludedForBrowFiveBar(c, resolved) {
  if (!resolved?.readyForIk) return false
  const meta = resolved.meta || getBrowTipSideMeta(resolved.sideId)
  const actuatorIds = new Set(
    [
      meta.nodeFControlId,
      meta.nodeDControlId,
      meta.tipAControlId,
      meta.tipBControlId,
      resolved.nodeFBindingKey,
      resolved.nodeDBindingKey,
    ].filter(Boolean)
  )
  if (actuatorIds.has(c.controlId) && c.channel === CHANNEL_VALUE) {
    return true
  }
  const sid = Number(c.servoId)
  if (!Number.isFinite(sid)) return false
  return (
    sid === resolved.servoFId ||
    sid === resolved.servoDId ||
    sid === resolved.servoAId ||
    sid === resolved.servoBId
  )
}

/**
 * @param {{
 *   pose: object,
 *   resolved: object,
 *   ikResult: object,
 *   configs?: object[],
 *   browPairServo?: object | null,
 *   browPairServoMode?: string,
 *   browPairServoNowMs?: number,
 *   beginFinalSettle?: boolean,
 *   browPairServoConfig?: object,
 *   rightBrowSyncGroup?: object | null,
 *   rightBrowSyncNowMs?: number,
 *   rightBrowSyncMode?: string,
 *   rightBrowPairServoConfig?: object,
 *   leftBrowSyncGroup?: object | null,
 *   leftBrowSyncNowMs?: number,
 *   leftBrowSyncMode?: string,
 *   leftBrowPairServoConfig?: object,
 * }} args
 */
export function applyBrowTipKinematicsOverrides({
  pose,
  resolved,
  ikResult,
  configs = [],
  browPairServo = null,
  browPairServoMode = null,
  browPairServoNowMs = null,
  beginFinalSettle = false,
  browPairServoConfig = null,
  rightBrowSyncGroup = null,
  rightBrowSyncNowMs = null,
  rightBrowSyncMode = "observe",
  rightBrowPairServoConfig = null,
  leftBrowSyncGroup = null,
  leftBrowSyncNowMs = null,
  leftBrowSyncMode = "observe",
  leftBrowPairServoConfig = null,
} = {}) {
  if (!pose || !resolved?.readyForIk || !ikResult?.ok) return pose
  if (!pose.logicalPose) pose.logicalPose = {}
  if (!pose.actualPose) pose.actualPose = {}
  if (!pose.kinematics) pose.kinematics = {}

  const side = resolved.sideId === "left" ? "left" : "right"
  const pairGroup =
    browPairServo ?? (side === "left" ? leftBrowSyncGroup : rightBrowSyncGroup)
  const pairMode =
    browPairServoMode ??
    (side === "left" ? leftBrowSyncMode : rightBrowSyncMode) ??
    "observe"
  const pairNowMs =
    browPairServoNowMs ?? (side === "left" ? leftBrowSyncNowMs : rightBrowSyncNowMs)
  const pairConfig =
    browPairServoConfig ??
    (side === "left" ? leftBrowPairServoConfig : rightBrowPairServoConfig)

  const servoFId = resolved.servoFId ?? resolved.servoBId
  const servoDId = resolved.servoDId ?? resolved.servoAId
  let qF = Number(ikResult.qFDeg ?? ikResult.tipB_deg)
  let qD = Number(ikResult.qDDeg ?? ikResult.tipA_deg)
  let pwmF = ikResult.pwmF ?? ikResult.pwmB
  let pwmD = ikResult.pwmD ?? ikResult.pwmA
  let syncDiag = null
  let syncAccepted = true

  if (pairGroup) {
    const browPadX = Number(
      ikResult.diagnostics?.brow?.x ?? ikResult.diagnostics?.browTarget?.x ?? ikResult.browTarget?.x
    )
    const browPadY = Number(
      ikResult.diagnostics?.brow?.y ?? ikResult.diagnostics?.browTarget?.y ?? ikResult.browTarget?.y
    )
    const desiredAWorld = ikResult.Aworld || ikResult.diagnostics?.Aworld || null
    const stepped = stepBrowFiveBarPairServo(pairGroup, {
      sideId: side,
      qFTarget: qF,
      qDTarget: qD,
      targetX: browPadX,
      targetY: browPadY,
      desiredA:
        Array.isArray(desiredAWorld) && desiredAWorld.length >= 2
          ? { x: desiredAWorld[0], y: desiredAWorld[1] }
          : null,
      nowMs: Number.isFinite(Number(pairNowMs)) ? Number(pairNowMs) : performance.now(),
      mode: pairMode || "observe",
      ikOk: true,
      beginFinalSettle: Boolean(beginFinalSettle),
      opts: pairConfig || undefined,
    })
    syncAccepted = Boolean(stepped.accept)
    qF = stepped.qF
    qD = stepped.qD
    syncDiag = getBrowFiveBarPairServoDiagnostics(pairGroup)
    const kinKey = side === "left" ? "leftBrowTipFivebar" : "rightBrowTipFivebar"
    const aliasKey = side === "left" ? "leftBrowFivebar" : "rightBrowFivebar"
    const syncAliasKey = side === "left" ? "leftBrowFivebarSync" : "rightBrowFivebarSync"
    if (String(pairMode) === "observe") {
      const diag = {
        ...(ikResult.diagnostics || {}),
        sync: syncDiag,
        qFCommandDeg: qF,
        qDCommandDeg: qD,
        observeOnly: true,
      }
      pose.kinematics[kinKey] = diag
      pose.kinematics[aliasKey] = diag
      pose.kinematics[syncAliasKey] = syncDiag
      if (pwmF != null && pwmD != null) {
        const sf = String(servoFId)
        const sd = String(servoDId)
        pose.logicalPose[sf] = Math.round(Number(pwmF))
        pose.logicalPose[sd] = Math.round(Number(pwmD))
        pose.actualPose[sf] = pose.logicalPose[sf]
        pose.actualPose[sd] = pose.logicalPose[sd]
      }
      return pose
    }
    if (syncAccepted) {
      pwmF = browAngleToBindingLogicalPwm(qF, resolved.bindingF)
      pwmD = browAngleToBindingLogicalPwm(qD, resolved.bindingD)
    } else {
      const diag = {
        ...(ikResult.diagnostics || {}),
        sync: syncDiag,
        syncRejected: true,
        syncRejectReason: stepped.reason,
      }
      pose.kinematics[kinKey] = diag
      pose.kinematics[aliasKey] = diag
      pose.kinematics[syncAliasKey] = syncDiag
      return pose
    }
  }

  const sf = String(servoFId)
  const sd = String(servoDId)
  const cfgList = Array.isArray(configs) ? configs : []

  const write = (servoKey, servoId, pwm) => {
    if (pwm == null || !Number.isFinite(Number(pwm))) return
    const logical = Math.round(
      Math.max(SERVO_LOGICAL_MIN_PWM, Math.min(SERVO_LOGICAL_MAX_PWM, Number(pwm)))
    )
    pose.logicalPose[servoKey] = logical
    if (!cfgList.length) {
      pose.actualPose[servoKey] = logical
      return
    }
    const cfg = getServoConfig(cfgList, servoId)
    if (cfg.enabled === false) return
    pose.actualPose[servoKey] = logicalToActualPwm(logical, cfg).actualPwm
  }

  /* F ← qF，D ← qD；必须成对写入 */
  if (
    pwmF == null ||
    pwmD == null ||
    !Number.isFinite(Number(pwmF)) ||
    !Number.isFinite(Number(pwmD))
  ) {
    const key = resolved.sideId === "right" ? "rightBrowTipFivebar" : "leftBrowTipFivebar"
    const diag = {
      ...(ikResult.diagnostics || {}),
      sync: syncDiag,
      syncRejected: true,
      syncRejectReason: "incomplete-pair-pwm",
    }
    pose.kinematics[key] = diag
    if (resolved.sideId === "right") {
      pose.kinematics.rightBrowFivebar = diag
      if (syncDiag) pose.kinematics.rightBrowFivebarSync = syncDiag
    }
    if (resolved.sideId === "left") {
      pose.kinematics.leftBrowFivebar = diag
      if (syncDiag) pose.kinematics.leftBrowFivebarSync = syncDiag
    }
    return pose
  }

  write(sf, servoFId, pwmF)
  write(sd, servoDId, pwmD)

  const key = resolved.sideId === "right" ? "rightBrowTipFivebar" : "leftBrowTipFivebar"
  const diag = {
    ...(ikResult.diagnostics || {}),
    qFCommandDeg: qF,
    qDCommandDeg: qD,
    finalCommandF: pose.logicalPose[sf] ?? null,
    finalCommandD: pose.logicalPose[sd] ?? null,
    finalCommandId1: resolved.sideId === "right" ? pose.logicalPose["1"] ?? null : undefined,
    finalCommandId2: resolved.sideId === "right" ? pose.logicalPose["2"] ?? null : undefined,
    sync: syncDiag,
  }
  pose.kinematics[key] = diag
  if (resolved.sideId === "right") {
    pose.kinematics.rightBrowFivebar = diag
    if (syncDiag) pose.kinematics.rightBrowFivebarSync = syncDiag
  }
  if (resolved.sideId === "left") {
    pose.kinematics.leftBrowFivebar = diag
    if (syncDiag) pose.kinematics.leftBrowFivebarSync = syncDiag
  }
  return pose
}

export { createBrowTipFivebarState, createRightBrowFiveBarSyncGroup, createLeftBrowFiveBarPairServo }
