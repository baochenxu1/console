import { clampNumber } from "../utils/clamp.js"
import {
  SERVO_LOGICAL_MIN_PWM,
  SERVO_LOGICAL_MAX_PWM,
  STANDARD_CENTER_PWM,
  getServoConfig,
  logicalToActualPwm,
} from "./servoConfig.js"
import {
  CHANNEL_X,
  CHANNEL_Y,
  CHANNEL_VALUE,
  CHANNEL_LATERAL,
  CURVE_LINEAR,
  CURVE_SMOOTHSTEP,
  applyBindingInvertToPwm,
  resolveBindingTargetsForEvaluate,
} from "./faceRigProfile.js"
import {
  applyFaceRigKinematicsOverrides,
  computeMouthCornerFiveBarIk,
  contributionExcludedForMouthFiveBar,
  resolveLeftMouthCornerKinematics,
  resolveRightMouthCornerKinematics,
} from "../sdk/kinematics/mouthCornerKinematics.js"
import { getMouthCornerLabSide } from "../sdk/kinematics/mouthCornerFiveBarLabConfig.js"
import { getLeftMouthFiveBarRuntime } from "../sdk/kinematics/leftMouthFiveBarRuntime.js"
import { getRightMouthFiveBarRuntime } from "../sdk/kinematics/rightMouthFiveBarRuntime.js"
import {
  applyBrowTipKinematicsOverrides,
  computeBrowTipFiveBarIk,
  contributionExcludedForBrowFiveBar,
  createBrowTipFivebarState,
  resolveBrowTipKinematics,
} from "../sdk/kinematics/browTipKinematics.js"
import {
  applyJawKinematicsOverrides,
  computeJaw3dIk,
  contributionExcludedForJaw3d,
  createJawKinematicsState,
  resolveJawKinematics,
} from "../sdk/kinematics/jawKinematics.js"
import {
  getBrowFiveBarPairServoDiagnostics,
  stepBrowFiveBarPairServo,
} from "../sdk/kinematics/rightBrowFiveBarSyncGroup.js"

export function mergePose(basePose = {}, overlayLogicalByServoId = {}) {
  return {
    ...basePose,
    ...overlayLogicalByServoId,
  }
}

export function channelRawToDriver(raw, channelSpec) {
  const mode = channelSpec?.mode || "signed100"
  let n = Number(raw)

  const lo = channelSpec?.rawMin
  const hi = channelSpec?.rawMax
  if (Number.isFinite(lo)) {
    n = Math.max(lo, n)
  }
  if (Number.isFinite(hi)) {
    n = Math.min(hi, n)
  }

  if (mode === "percent") {
    return clampNumber((n - 50) / 50, -1, 1)
  }
  if (mode === "signed50") {
    return clampNumber(n / 50, -1, 1)
  }

  return clampNumber(n / 100, -1, 1)
}

export function evaluateBindingLogical(driver, binding) {
  const w = clampNumber(binding.weight ?? 1, 0, 4)
  let u = clampNumber(driver * w, -1, 1)

  const curve = binding.curve || CURVE_LINEAR
  const sign = u >= 0 ? 1 : -1
  let mag = Math.abs(u)
  if (curve === CURVE_SMOOTHSTEP) {
    mag = mag * mag * (3 - 2 * mag)
  }
  u = sign * mag

  const { neutralPwm: n, positiveTargetPwm: pos, negativeTargetPwm: neg } =
    resolveBindingTargetsForEvaluate(binding)

  let pwm = u >= 0 ? n + u * (pos - n) : n + u * (n - neg)
  pwm = Math.round(pwm)
  return applyBindingInvertToPwm(
    clampNumber(pwm, SERVO_LOGICAL_MIN_PWM, SERVO_LOGICAL_MAX_PWM),
    binding
  )
}

/**
 * @param {object[]} contributions
 * @param {string[]} warnings
 * @returns {Record<string, number>}
 */
function mergeContributionsToLogicalPose(contributions, warnings) {
  const byServo = new Map()
  for (const c of contributions) {
    const sid = c.servoId
    if (!byServo.has(sid)) {
      byServo.set(sid, [])
    }
    byServo.get(sid).push(c)
  }

  const logicalPose = {}

  for (const [sid, list] of byServo) {
    if (!Array.isArray(list) || list.length === 0) {
      continue
    }

    const baseNeutral = clampNumber(
      list[0]?.neutralPwm ?? STANDARD_CENTER_PWM,
      SERVO_LOGICAL_MIN_PWM,
      SERVO_LOGICAL_MAX_PWM
    )

    const neutralSet = new Set(list.map((item) => item.neutralPwm))

    if (neutralSet.size > 1) {
      warnings.push(
        `舵机 ${sid}：多条绑定的 neutralPwm 不一致，当前使用 ${baseNeutral} 作为合成基准。`
      )
    }

    const offsetSum = list.reduce((acc, item) => acc + item.deltaFromNeutral, 0)

    const merged =
      list.length === 1
        ? list[0].logicalPwm
        : baseNeutral + offsetSum

    logicalPose[String(sid)] = clampNumber(
      Math.round(merged),
      SERVO_LOGICAL_MIN_PWM,
      SERVO_LOGICAL_MAX_PWM
    )

    if (list.length > 1) {
      warnings.push(
        `舵机 ${sid}：${list.length} 条绑定；逻辑脉宽 = ${baseNeutral} + 增量之和（${offsetSum}）= ${logicalPose[String(sid)]}`
      )
    }
  }

  return logicalPose
}

function logicalPoseToActualPose(logicalPose, configs, warnings) {
  const actualPose = {}
  const cfgList = Array.isArray(configs) ? configs : []
  for (const [key, logicalRaw] of Object.entries(logicalPose)) {
    const logical =
      logicalRaw != null && typeof logicalRaw === "object"
        ? logicalRaw.logicalPwm ?? logicalRaw.pwm
        : logicalRaw
    const servoId = Number(key)
    const cfg = getServoConfig(cfgList, servoId)
    if (cfg.enabled === false) {
      warnings.push(`舵机 ${key}：未启用，跳过实际脉宽映射`)
      continue
    }
    const r = logicalToActualPwm(logical, cfg)
    actualPose[key] = r.actualPwm
  }
  return actualPose
}

/**
 * @param {object} rigValues
 * @param {object} profile
 * @param {object[]} [configs]
 * @param {{
 *   kinematics?: object,
 *   rightMouthCornerFivebarState?: { qPrev: number[], lastOk: boolean, lastDiagnostics: object | null },
 *   leftMouthCornerFivebarState?: { qPrev: number[], lastOk: boolean, lastDiagnostics: object | null },
 *   rightMouthRuntime?: object,
 *   leftMouthRuntime?: object,
 * }} [options]
 */
export function mapFaceRigToPose(rigValues, profile, configs = [], options = {}) {
  const warnings = []
  const contributions = []
  const controlsById = new Map((profile.controls || []).map((c) => [c.controlId, c]))

  for (const binding of profile.bindings || []) {
    if (!binding.enabled) {
      continue
    }

    const ctrl = controlsById.get(binding.controlId)
    if (!ctrl) {
      warnings.push(`绑定 ${binding.bindingId}：未知控件 ${binding.controlId}`)
      continue
    }

    const spec = ctrl.channels?.[binding.channel]
    if (!spec) {
      warnings.push(`绑定 ${binding.bindingId}：控件 ${binding.controlId} 无通道 ${binding.channel}`)
      continue
    }

    const raw = rigValues[binding.controlId]?.[binding.channel]
    if (raw === undefined || raw === null || Number.isNaN(Number(raw))) {
      warnings.push(`绑定 ${binding.bindingId}：缺少数值 ${binding.controlId}.${binding.channel}`)
      continue
    }

    const driver = channelRawToDriver(raw, spec)
    const logicalPwm = evaluateBindingLogical(driver, binding)

    contributions.push({
      bindingId: binding.bindingId,
      controlId: binding.controlId,
      channel: binding.channel,
      servoId: binding.servoId,
      neutralPwm: binding.neutralPwm,
      logicalPwm,
      deltaFromNeutral: logicalPwm - binding.neutralPwm,
      rawChannelValue: Number(raw),
      driver,
    })
  }

  const rightRt = getRightMouthFiveBarRuntime()
  const leftRt = getLeftMouthFiveBarRuntime()
  const rightResolved = resolveRightMouthCornerKinematics(profile, {
    runtimeParams: rightRt.params,
    runtimeBindingOverride: rightRt.bindingOverride,
    kinematics: options?.kinematics,
    runtimeSource: rightRt.source,
  })
  const leftResolved = resolveLeftMouthCornerKinematics(profile, {
    runtimeParams: leftRt.params,
    runtimeBindingOverride: leftRt.bindingOverride,
    kinematics: options?.kinematics,
    runtimeSource: leftRt.source,
  })
  const leftBrowResolved = resolveBrowTipKinematics(profile, "left", {
    kinematics: options?.kinematics,
  })
  const rightBrowResolved = resolveBrowTipKinematics(profile, "right", {
    kinematics: options?.kinematics,
  })
  const jawResolved = resolveJawKinematics(profile, {
    kinematics: options?.kinematics,
  })
  const leftBrowState =
    options?.leftBrowTipFivebarState ?? options?.browTipFivebarStates?.left ?? createBrowTipFivebarState()
  const rightBrowState =
    options?.rightBrowTipFivebarState ?? options?.browTipFivebarStates?.right ?? createBrowTipFivebarState()
  const jawState = options?.jawKinematicsState ?? createJawKinematicsState()

  const contribsForFiveBarMerge = contributions.filter((c) => {
    if (contributionExcludedForMouthFiveBar(c, rightResolved)) {
      return false
    }
    if (contributionExcludedForMouthFiveBar(c, leftResolved)) {
      return false
    }
    if (contributionExcludedForBrowFiveBar(c, leftBrowResolved)) {
      return false
    }
    if (contributionExcludedForBrowFiveBar(c, rightBrowResolved)) {
      return false
    }
    if (contributionExcludedForJaw3d(c, jawResolved)) {
      return false
    }
    return true
  })

  /** @type {Record<string, object>} */
  const kinematics = {}
  const logicalPose = mergeContributionsToLogicalPose(contribsForFiveBarMerge, warnings)
  const actualPose = logicalPoseToActualPose(logicalPose, configs, warnings)
  const pose = {
    logicalPose,
    actualPose,
    contributions,
    warnings,
    kinematics,
  }

  const mouthSides = [
    {
      sideId: /** @type {const} */ ("right"),
      resolved: rightResolved,
      rt: rightRt,
      state:
        options?.rightMouthCornerFivebarState ?? options?.mouthFiveBarStates?.right,
    },
    {
      sideId: /** @type {const} */ ("left"),
      resolved: leftResolved,
      rt: leftRt,
      state: options?.leftMouthCornerFivebarState ?? options?.mouthFiveBarStates?.left,
    },
  ]

  for (const { sideId, resolved, rt, state } of mouthSides) {
    const side = getMouthCornerLabSide(sideId)
    for (const conflict of resolved.fiveBarConflicts || []) {
      if (conflict?.blockedServoId != null) {
        warnings.push(
          `${side.label}五杆：舵机 ${conflict.blockedServoId} 已被 ${(conflict.blockedBy || []).join("、") || "其他控件"} 占用，五杆改用 ${conflict.fallbackServoId ?? "profile 嘴角绑定"}`
        )
      }
    }
    if (!resolved.enabled) {
      pose.kinematics[sideId === "left" ? "leftMouthCorner" : "rightMouthCorner"] = {
        enabled: false,
        overrideNote: "",
        ikOk: null,
        ikMessage: "",
      }
      continue
    }
    if (!resolved.readyForIk) {
      if (resolved.skipReason) {
        pose.warnings.push(resolved.skipReason)
      }
      const skipDiag = {
        enabled: true,
        readyForIk: false,
        overrideNote: "",
        ikOk: null,
        ikMessage: resolved.skipReason || "未就绪",
        servoAId: resolved.servoAId,
        servoBId: resolved.servoBId,
      }
      if (sideId === "left") {
        pose.kinematics.leftMouthCorner = skipDiag
        pose.kinematics.leftMouthCornerFivebar = skipDiag
      } else {
        pose.kinematics.rightMouthCorner = skipDiag
        pose.kinematics.rightMouthCornerFivebar = skipDiag
      }
      continue
    }

    const resolvedForIk = options?.bypassMouthServoOutputFilter
      ? {
          ...resolved,
          params: {
            ...resolved.params,
            maxStepDeg: 180,
            filterAlpha: 1,
          },
        }
      : resolved
    const ik = computeMouthCornerFiveBarIk(rigValues, resolvedForIk, state, sideId)
    if (ik.ok) {
      if (ik.diagnostics?.scale != null && Number(ik.diagnostics.scale) < 0.8) {
        pose.warnings.push(
          `${side.label}五杆：scale=${Number(ik.diagnostics.scale).toFixed(3)} < 0.8（D_target 已强钳位），输出可能偏离 Pad 意图`
        )
      }
      applyFaceRigKinematicsOverrides({
        rig: rigValues,
        profile,
        configs,
        pose,
        sideId,
        kinematics: options?.kinematics,
        ikResult: ik,
        rightMouthRuntime: sideId === "right" ? rt : undefined,
        leftMouthRuntime: sideId === "left" ? rt : undefined,
        rightMouthCornerFivebarState: sideId === "right" ? state : undefined,
        leftMouthCornerFivebarState: sideId === "left" ? state : undefined,
      })
    } else {
      pose.warnings.push(`${side.label}五杆 IK：${ik.message}`)
      if (sideId === "left") {
        pose.kinematics.leftMouthCorner = ik.diagnostics
        pose.kinematics.leftMouthCornerFivebar = ik.diagnostics
      } else {
        pose.kinematics.rightMouthCorner = ik.diagnostics
        pose.kinematics.rightMouthCornerFivebar = ik.diagnostics
      }
    }
  }

  for (const { sideId, resolved, state } of [
    { sideId: "left", resolved: leftBrowResolved, state: leftBrowState },
    { sideId: "right", resolved: rightBrowResolved, state: rightBrowState },
  ]) {
    const kinKey = sideId === "left" ? "leftBrowTipFivebar" : "rightBrowTipFivebar"
    if (!resolved.enabled) {
      pose.kinematics[kinKey] = { enabled: false, ikOk: null, ikMessage: "" }
      continue
    }
    if (!resolved.readyForIk) {
      if (resolved.skipReason) pose.warnings.push(resolved.skipReason)
      pose.kinematics[kinKey] = {
        enabled: true,
        readyForIk: false,
        ikOk: null,
        ikMessage: resolved.skipReason || "未就绪",
        servoAId: resolved.servoAId,
        servoBId: resolved.servoBId,
        servoFId: resolved.servoFId,
        servoDId: resolved.servoDId,
        nodeFBindingKey: resolved.nodeFBindingKey,
        nodeDBindingKey: resolved.nodeDBindingKey,
        fdWarnings: resolved.fdWarnings || [],
      }
      if (sideId === "right") {
        pose.kinematics.rightBrowFivebar = pose.kinematics[kinKey]
      }
      if (sideId === "left") {
        pose.kinematics.leftBrowFivebar = pose.kinematics[kinKey]
      }
      continue
    }
    try {
      const ik = computeBrowTipFiveBarIk(rigValues, resolved, state)
      if (ik.ok) {
        applyBrowTipKinematicsOverrides({
          pose,
          resolved,
          ikResult: ik,
          configs,
          rightBrowSyncGroup:
            sideId === "right" ? options?.rightBrowFiveBarSyncGroup ?? null : null,
          rightBrowSyncNowMs:
            sideId === "right" ? options?.rightBrowSyncNowMs ?? null : null,
          rightBrowSyncMode:
            sideId === "right" ? options?.rightBrowSyncMode || "observe" : "observe",
          rightBrowPairServoConfig:
            sideId === "right" ? options?.rightBrowPairServoConfig ?? null : null,
          leftBrowSyncGroup:
            sideId === "left" ? options?.leftBrowFiveBarSyncGroup ?? null : null,
          leftBrowSyncNowMs:
            sideId === "left" ? options?.leftBrowSyncNowMs ?? null : null,
          leftBrowSyncMode:
            sideId === "left" ? options?.leftBrowSyncMode || "observe" : "observe",
          leftBrowPairServoConfig:
            sideId === "left" ? options?.leftBrowPairServoConfig ?? null : null,
          beginFinalSettle:
            sideId === "right"
              ? Boolean(options?.beginFinalSettle)
              : Boolean(options?.beginLeftBrowFinalSettle),
        })
      } else {
        pose.warnings.push(`${resolved.meta.label}五杆 IK：${ik.message}`)
        pose.kinematics[kinKey] = ik.diagnostics
        if (sideId === "right" && options?.rightBrowFiveBarSyncGroup) {
          /* IK 失败：整组不发送；推进 reject 状态供诊断 */
          stepBrowFiveBarPairServo(options.rightBrowFiveBarSyncGroup, {
            sideId: "right",
            qFTarget: NaN,
            qDTarget: NaN,
            nowMs: options?.rightBrowSyncNowMs ?? performance.now(),
            mode: options?.rightBrowSyncMode || "observe",
            ikOk: false,
          })
          pose.kinematics.rightBrowFivebarSync = getBrowFiveBarPairServoDiagnostics(
            options.rightBrowFiveBarSyncGroup
          )
        }
        if (sideId === "left" && options?.leftBrowFiveBarSyncGroup) {
          stepBrowFiveBarPairServo(options.leftBrowFiveBarSyncGroup, {
            sideId: "left",
            qFTarget: NaN,
            qDTarget: NaN,
            nowMs: options?.leftBrowSyncNowMs ?? performance.now(),
            mode: options?.leftBrowSyncMode || "observe",
            ikOk: false,
          })
          pose.kinematics.leftBrowFivebarSync = getBrowFiveBarPairServoDiagnostics(
            options.leftBrowFiveBarSyncGroup
          )
        }
      }
    } catch (err) {
      /* 眉尖 IK 不得拖垮整条 Pose / 实时下发 */
      const msg = err?.message || String(err)
      pose.warnings.push(`${resolved.meta.label}五杆 IK 异常：${msg}`)
      pose.kinematics[kinKey] = {
        enabled: true,
        readyForIk: true,
        ikOk: false,
        ok: false,
        ikMessage: msg,
        servoAId: resolved.servoAId,
        servoBId: resolved.servoBId,
      }
    }
  }

  /* Jaw 3D：完整 {value,lateral} → IK → jaw_A / jaw_D */
  if (!jawResolved.enabled) {
    pose.kinematics.jaw3d = { enabled: false, readyForIk: null, ikOk: null, ikMessage: "" }
  } else if (!jawResolved.readyForIk) {
    if (jawResolved.skipReason) pose.warnings.push(jawResolved.skipReason)
    pose.kinematics.jaw3d = {
      enabled: true,
      readyForIk: false,
      ikOk: null,
      ikMessage: jawResolved.skipReason || "未就绪",
      binding: {
        nodeAKey: jawResolved.nodeABindingKey,
        nodeDKey: jawResolved.nodeDBindingKey,
        servoAId: jawResolved.servoAId,
        servoDId: jawResolved.servoDId,
      },
    }
  } else {
    try {
      const ik = computeJaw3dIk(rigValues, jawResolved, jawState)
      if (ik.ok) {
        applyJawKinematicsOverrides({
          pose,
          resolved: jawResolved,
          ikResult: ik,
          configs,
        })
      } else {
        pose.warnings.push(`下颌 3D IK：${ik.message}`)
        pose.kinematics.jaw3d = ik.diagnostics
      }
    } catch (err) {
      const msg = err?.message || String(err)
      pose.warnings.push(`下颌 3D IK 异常：${msg}`)
      pose.kinematics.jaw3d = {
        enabled: true,
        readyForIk: true,
        ikOk: false,
        ikMessage: msg,
      }
    }
  }

  const kinOut = pose.kinematics || {}
  if (kinOut.rightMouthCorner && !kinOut.rightMouthCornerFivebar) {
    kinOut.rightMouthCornerFivebar = kinOut.rightMouthCorner
  }
  if (kinOut.leftMouthCorner && !kinOut.leftMouthCornerFivebar) {
    kinOut.leftMouthCornerFivebar = kinOut.leftMouthCorner
  }

  return {
    logicalPose: pose.logicalPose,
    actualPose: pose.actualPose,
    contributions,
    warnings: pose.warnings,
    kinematics: kinOut,
  }
}

export function buildServoMovesFromLogicalPose(logicalPose, configs, timeMs = 500) {
  if (!Array.isArray(configs) || !logicalPose || typeof logicalPose !== "object") {
    return []
  }

  const moves = []

  for (const [idStr, logicalEntry] of Object.entries(logicalPose)) {
    const servoId = Number(idStr)
    const cfg = getServoConfig(configs, servoId)
    if (cfg.enabled === false) {
      continue
    }

    const logical =
      logicalEntry != null && typeof logicalEntry === "object"
        ? logicalEntry.logicalPwm ?? logicalEntry.pwm
        : logicalEntry
    if (!Number.isFinite(Number(logical))) {
      continue
    }

    const r = logicalToActualPwm(logical, cfg)

    moves.push({
      servoId,
      pwm: r.actualPwm,
      timeMs,
      minPwm: cfg.actualMinPwm,
      maxPwm: cfg.actualMaxPwm,
    })
  }

  return moves
}

function clampSigned100ish(n) {
  return Math.round(clampNumber(Number(n) || 0, -100, 100))
}

/** 鼻子仅向上：0＝中位，100＝最大上抬 */
function clampNoseUp(n) {
  return Math.round(clampNumber(Number(n) || 0, 0, 100))
}

/** 下颌 / 眉梢左右：±50 */
function clampJawLateral(n) {
  return Math.round(clampNumber(Number(n) || 0, -50, 50))
}

/**
 * 旧 v4 percent pad（中位 50）→ signed100（中位 0）。
 * 仅当两轴都像 [0,100] 中位制且无负值时转换；已是 signed 的不动。
 */
export function migrateBrowPadPercentToSigned(x, y) {
  const rx = Number(x)
  const ry = Number(y)
  const looksPercent =
    Number.isFinite(rx) &&
    Number.isFinite(ry) &&
    rx >= 0 &&
    rx <= 100 &&
    ry >= 0 &&
    ry <= 100
  if (!looksPercent) {
    return { x: clampSigned100ish(rx), y: clampSigned100ish(ry) }
  }
  return {
    x: clampSigned100ish((rx - 50) * 2),
    y: clampSigned100ish((ry - 50) * 2),
  }
}

function normalizeBrowSide(side, { migratePercentPad = false } = {}) {
  const tipRaw = side?.tip
  const hasXy = side?.x != null || side?.y != null
  let x
  let y
  if (hasXy) {
    if (migratePercentPad) {
      const m = migrateBrowPadPercentToSigned(side.x ?? 50, side.y ?? 50)
      x = m.x
      y = m.y
    } else {
      x = clampSigned100ish(side.x ?? 0)
      y = clampSigned100ish(side.y ?? 0)
    }
  } else {
    const tipA =
      side?.tipA != null
        ? clampSigned100ish(side.tipA)
        : tipRaw && typeof tipRaw === "object"
          ? clampSigned100ish(tipRaw.a ?? tipRaw.tipA ?? tipRaw.val ?? tipRaw.value ?? 0)
          : clampSigned100ish(typeof tipRaw === "number" ? tipRaw : 0)
    const tipB =
      side?.tipB != null
        ? clampSigned100ish(side.tipB)
        : tipRaw && typeof tipRaw === "object"
          ? clampSigned100ish(tipRaw.b ?? tipRaw.tipB ?? tipRaw.lateral ?? tipRaw.tipLateral ?? 0)
          : clampSigned100ish(side?.tipLateral ?? 0)
    x = tipB
    y = tipA
  }
  return {
    x,
    y,
    tipA: y,
    tipB: x,
    tip: y,
    mid: clampSigned100ish(side?.mid ?? 0),
    tail: clampSigned100ish(side?.tail ?? 0),
  }
}

function clampPct100(n) {
  return clampNumber(Number(n) ?? 50, 0, 100)
}

export function createInitialEliteRig() {
  return {
    browL: { x: 0, y: 0, tipA: 0, tipB: 0, tip: 0, mid: 0, tail: 0 },
    browR: { x: 0, y: 0, tipA: 0, tipB: 0, tip: 0, mid: 0, tail: 0 },
    eyeL: { up: 0, lo: 0, x: 50, y: 50 },
    eyeR: { up: 0, lo: 0, x: 50, y: 50 },
    /** @deprecated 兼容旧 Tracking/诊断镜像；UI 主路径使用 eyeL/eyeR.x/y */
    sharedRadar: { x: 50, y: 50 },
    noseL: { val: 0 },
    noseR: { val: 0 },
    mouth: {
      UL: 0,
      UR: 0,
      LL: 0,
      LR: 0,
      sideL: { x: 50, y: 50 },
      sideR: { x: 50, y: 50 },
    },
    /** 旧字段可读；新结构不下发 Tongue binding */
    tongue: { val: 0 },
    jaw: { val: 0, lateral: 0 },
  }
}

/**
 * 将旧 elite rig（仅 sharedRadar / 无 nose / 无 jaw.lateral）升级到新结构字段。
 * @param {object|null|undefined} rig
 */
export function normalizeEliteRig(rig) {
  const base = createInitialEliteRig()
  if (!rig || typeof rig !== "object") {
    return base
  }
  const sharedX = clampPct100(rig.sharedRadar?.x ?? rig.eyeL?.x ?? 50)
  const sharedY = clampPct100(rig.sharedRadar?.y ?? rig.eyeL?.y ?? 50)
  const eyeL = {
    up: clampSigned100ish(rig.eyeL?.up ?? 0),
    lo: clampSigned100ish(rig.eyeL?.lo ?? 0),
    x: clampPct100(rig.eyeL?.x ?? sharedX),
    y: clampPct100(rig.eyeL?.y ?? sharedY),
  }
  const eyeR = {
    up: clampSigned100ish(rig.eyeR?.up ?? 0),
    lo: clampSigned100ish(rig.eyeR?.lo ?? 0),
    x: clampPct100(rig.eyeR?.x ?? sharedX),
    y: clampPct100(rig.eyeR?.y ?? sharedY),
  }
  const mirrorX = (eyeL.x + eyeR.x) / 2
  const mirrorY = (eyeL.y + eyeR.y) / 2
  return {
    ...base,
    ...rig,
    browL: normalizeBrowSide(rig.browL),
    browR: normalizeBrowSide(rig.browR),
    eyeL,
    eyeR,
    sharedRadar: { x: mirrorX, y: mirrorY },
    noseL: { val: clampNoseUp(rig.noseL?.val ?? 0) },
    noseR: { val: clampNoseUp(rig.noseR?.val ?? 0) },
    mouth: {
      UL: 0,
      UR: 0,
      LL: 0,
      LR: 0,
      sideL: { x: 50, y: 50 },
      sideR: { x: 50, y: 50 },
      ...rig.mouth,
      sideL: { x: 50, y: 50, ...rig.mouth?.sideL },
      sideR: { x: 50, y: 50, ...rig.mouth?.sideR },
    },
    tongue: { val: clampSigned100ish(rig.tongue?.val ?? 0) },
    jaw: {
      val: clampSigned100ish(rig.jaw?.val ?? 0),
      lateral: clampJawLateral(rig.jaw?.lateral ?? 0),
    },
  }
}

export function syncSharedRadarMirror(rig) {
  const n = normalizeEliteRig(rig)
  return {
    ...n,
    sharedRadar: {
      x: (Number(n.eyeL.x) + Number(n.eyeR.x)) / 2,
      y: (Number(n.eyeL.y) + Number(n.eyeR.y)) / 2,
    },
  }
}

export function rigValuesFromEliteRig(rig) {
  const n = normalizeEliteRig(rig)
  const lx = n.eyeL.x
  const ly = n.eyeL.y
  const rx = n.eyeR.x
  const ry = n.eyeR.y

  return {
    brow_l_tip: { x: n.browL.x, y: n.browL.y },
    brow_l_F: { value: n.browL.tipB },
    brow_l_D: { value: n.browL.tipA },
    brow_l_tip_a: { value: n.browL.tipA },
    brow_l_tip_b: { value: n.browL.tipB },
    brow_l_mid: { value: n.browL.mid },
    brow_l_tail: { value: n.browL.tail },
    brow_r_tip: { x: n.browR.x, y: n.browR.y },
    brow_r_F: { value: n.browR.tipB },
    brow_r_D: { value: n.browR.tipA },
    brow_r_tip_a: { value: n.browR.tipA },
    brow_r_tip_b: { value: n.browR.tipB },
    brow_r_mid: { value: n.browR.mid },
    brow_r_tail: { value: n.browR.tail },
    /** @deprecated Tracking 镜像 tipA（由 y 导出） */
    // kept via tipA fields above
    eye_l_up: { value: n.eyeL.up },
    eye_l_lo: { value: n.eyeL.lo },
    eye_r_up: { value: n.eyeR.up },
    eye_r_lo: { value: n.eyeR.lo },
    eye_l_xy: { x: lx, y: ly },
    eye_r_xy: { x: rx, y: ry },
    /** 兼容旧绑定/诊断：镜像为左右均值 */
    eye_xy: { x: (lx + rx) / 2, y: (ly + ry) / 2 },
    nose_l: { value: n.noseL.val },
    nose_r: { value: n.noseR.val },
    mouth_ul: { value: n.mouth.UL },
    mouth_ur: { value: n.mouth.UR },
    mouth_ll: { value: n.mouth.LL },
    mouth_lr: { value: n.mouth.LR },
    mouth_corner_l: { x: n.mouth.sideL.x, y: n.mouth.sideL.y },
    mouth_corner_r: { x: n.mouth.sideR.x, y: n.mouth.sideR.y },
    tongue: { value: n.tongue.val },
    jaw: { value: n.jaw.val, lateral: n.jaw.lateral },
  }
}

function invertDriverForTargetLogicalPwm(targetPwm, binding) {
  const t = clampNumber(targetPwm, SERVO_LOGICAL_MIN_PWM, SERVO_LOGICAL_MAX_PWM)
  let best = 0
  let bestErr = Infinity
  for (let i = 0; i <= 72; i += 1) {
    const d = -1 + (2 * i) / 72
    const got = evaluateBindingLogical(d, binding)
    const err = Math.abs(got - t)
    if (err < bestErr) {
      bestErr = err
      best = d
    }
  }
  return best
}

function driverToChannelRawForSpec(driver, channelSpec) {
  const mode = channelSpec?.mode || "signed100"
  const u = clampNumber(driver, -1, 1)
  let raw = mode === "percent" ? 50 + u * 50 : mode === "signed50" ? u * 50 : u * 100
  const lo = channelSpec?.rawMin
  const hi = channelSpec?.rawMax
  if (Number.isFinite(lo)) {
    raw = Math.max(lo, raw)
  }
  if (Number.isFinite(hi)) {
    raw = Math.min(hi, raw)
  }
  return raw
}

/** 将单通道 raw 写回 elite rig 状态（与 FaceRigControlConsole 数据结构一致） */
export function setEliteRigControlRaw(rig, controlId, channel, rawNumeric) {
  return patchEliteFromControlChannel(rig, controlId, channel, rawNumeric)
}

function patchEliteFromControlChannel(rig, controlId, channel, rawNumeric) {
  const r = Number(rawNumeric)
  const base = normalizeEliteRig(rig)
  switch (controlId) {
    case "brow_l_tip": {
      const browL = { ...base.browL }
      if (channel === CHANNEL_X) browL.x = clampSigned100ish(r)
      else if (channel === CHANNEL_Y) browL.y = clampSigned100ish(r)
      return syncSharedRadarMirror({ ...base, browL: normalizeBrowSide(browL) })
    }
    case "brow_l_tip_a":
    case "brow_l_tip_b":
    case "brow_l_F":
    case "brow_l_D": {
      /* 执行器通道由 Five-Bar IK 写入，不反写 semantic brow.x/y */
      return syncSharedRadarMirror(base)
    }
    case "brow_l_mid":
      return syncSharedRadarMirror({ ...base, browL: { ...base.browL, mid: clampSigned100ish(r) } })
    case "brow_l_tail":
      return syncSharedRadarMirror({ ...base, browL: { ...base.browL, tail: clampSigned100ish(r) } })
    case "brow_r_tip": {
      const browR = { ...base.browR }
      if (channel === CHANNEL_X) browR.x = clampSigned100ish(r)
      else if (channel === CHANNEL_Y) browR.y = clampSigned100ish(r)
      return syncSharedRadarMirror({ ...base, browR: normalizeBrowSide(browR) })
    }
    case "brow_r_tip_a":
    case "brow_r_tip_b":
    case "brow_r_F":
    case "brow_r_D": {
      /* 执行器通道由 Five-Bar IK 写入，不反写 semantic brow.x/y（禁止 H→单舵机语义） */
      return syncSharedRadarMirror(base)
    }
    case "brow_r_mid":
      return syncSharedRadarMirror({ ...base, browR: { ...base.browR, mid: clampSigned100ish(r) } })
    case "brow_r_tail":
      return syncSharedRadarMirror({ ...base, browR: { ...base.browR, tail: clampSigned100ish(r) } })
    case "eye_l_up":
      return syncSharedRadarMirror({ ...base, eyeL: { ...base.eyeL, up: clampSigned100ish(r) } })
    case "eye_l_lo":
      return syncSharedRadarMirror({ ...base, eyeL: { ...base.eyeL, lo: clampSigned100ish(r) } })
    case "eye_r_up":
      return syncSharedRadarMirror({ ...base, eyeR: { ...base.eyeR, up: clampSigned100ish(r) } })
    case "eye_r_lo":
      return syncSharedRadarMirror({ ...base, eyeR: { ...base.eyeR, lo: clampSigned100ish(r) } })
    case "mouth_ul":
      return syncSharedRadarMirror({ ...base, mouth: { ...base.mouth, UL: clampSigned100ish(r) } })
    case "mouth_ur":
      return syncSharedRadarMirror({ ...base, mouth: { ...base.mouth, UR: clampSigned100ish(r) } })
    case "mouth_ll":
      return syncSharedRadarMirror({ ...base, mouth: { ...base.mouth, LL: clampSigned100ish(r) } })
    case "mouth_lr":
      return syncSharedRadarMirror({ ...base, mouth: { ...base.mouth, LR: clampSigned100ish(r) } })
    case "nose_l":
      return syncSharedRadarMirror({ ...base, noseL: { val: clampNoseUp(r) } })
    case "nose_r":
      return syncSharedRadarMirror({ ...base, noseR: { val: clampNoseUp(r) } })
    case "tongue":
      return syncSharedRadarMirror({ ...base, tongue: { val: clampSigned100ish(r) } })
    case "jaw": {
      const jaw = { ...base.jaw }
      if (channel === CHANNEL_LATERAL) jaw.lateral = clampJawLateral(r)
      else jaw.val = clampSigned100ish(r)
      return syncSharedRadarMirror({ ...base, jaw })
    }
    case "mouth_corner_l": {
      const sideL = { ...base.mouth?.sideL }
      if (channel === CHANNEL_X) sideL.x = clampPct100(r)
      else if (channel === CHANNEL_Y) sideL.y = clampPct100(r)
      return syncSharedRadarMirror({ ...base, mouth: { ...base.mouth, sideL } })
    }
    case "mouth_corner_r": {
      const sideR = { ...base.mouth?.sideR }
      if (channel === CHANNEL_X) sideR.x = clampPct100(r)
      else if (channel === CHANNEL_Y) sideR.y = clampPct100(r)
      return syncSharedRadarMirror({ ...base, mouth: { ...base.mouth, sideR } })
    }
    case "eye_l_xy": {
      const eyeL = { ...base.eyeL }
      if (channel === CHANNEL_X) eyeL.x = clampPct100(r)
      else if (channel === CHANNEL_Y) eyeL.y = clampPct100(r)
      return syncSharedRadarMirror({ ...base, eyeL })
    }
    case "eye_r_xy": {
      const eyeR = { ...base.eyeR }
      if (channel === CHANNEL_X) eyeR.x = clampPct100(r)
      else if (channel === CHANNEL_Y) eyeR.y = clampPct100(r)
      return syncSharedRadarMirror({ ...base, eyeR })
    }
    case "eye_xy": {
      // 旧通道：同时写入左右眼
      const eyeL = { ...base.eyeL }
      const eyeR = { ...base.eyeR }
      if (channel === CHANNEL_X) {
        eyeL.x = clampPct100(r)
        eyeR.x = clampPct100(r)
      } else if (channel === CHANNEL_Y) {
        eyeL.y = clampPct100(r)
        eyeR.y = clampPct100(r)
      }
      return syncSharedRadarMirror({ ...base, eyeL, eyeR })
    }
    default:
      return base
  }
}

function eyeRadarTotalError(rigTry, profile, configs, targetByServo, eyeBindings) {
  if (!eyeBindings.length) {
    return 0
  }
  const { logicalPose } = mapFaceRigToPose(rigValuesFromEliteRig(rigTry), profile, configs)
  let e = 0
  for (const b of eyeBindings) {
    const tid = targetByServo[String(b.servoId)]
    if (tid === undefined || tid === null) {
      continue
    }
    const got = logicalPose[String(b.servoId)]
    if (got === undefined || got === null) {
      continue
    }
    e += (Number(got) - Number(tid)) ** 2
  }
  return e
}

function refineOneEyeRadar(rig, profile, configs, targetByServo, controlId, eyeKey) {
  const eyeBindings = (profile.bindings || []).filter(
    (b) => b.enabled && b.controlId === controlId
  )
  if (!eyeBindings.length) {
    return rig
  }
  let rx = clampPct100(rig[eyeKey]?.x ?? 50)
  let ry = clampPct100(rig[eyeKey]?.y ?? 50)
  const deltas = [-12, -8, -5, -3, -1, 0, 1, 3, 5, 8, 12]
  for (let iter = 0; iter < 48; iter += 1) {
    let bestRx = rx
    let bestErr = eyeRadarTotalError(
      { ...rig, [eyeKey]: { ...rig[eyeKey], x: rx, y: ry } },
      profile,
      configs,
      targetByServo,
      eyeBindings
    )
    for (const d of deltas) {
      const nx = clampPct100(rx + d)
      const err = eyeRadarTotalError(
        { ...rig, [eyeKey]: { ...rig[eyeKey], x: nx, y: ry } },
        profile,
        configs,
        targetByServo,
        eyeBindings
      )
      if (err < bestErr) {
        bestErr = err
        bestRx = nx
      }
    }
    rx = bestRx
    let bestRy = ry
    bestErr = eyeRadarTotalError(
      { ...rig, [eyeKey]: { ...rig[eyeKey], x: rx, y: ry } },
      profile,
      configs,
      targetByServo,
      eyeBindings
    )
    for (const d of deltas) {
      const ny = clampPct100(ry + d)
      const err = eyeRadarTotalError(
        { ...rig, [eyeKey]: { ...rig[eyeKey], x: rx, y: ny } },
        profile,
        configs,
        targetByServo,
        eyeBindings
      )
      if (err < bestErr) {
        bestErr = err
        bestRy = ny
      }
    }
    ry = bestRy
  }
  return { ...rig, [eyeKey]: { ...rig[eyeKey], x: rx, y: ry } }
}

function refineEyeRadarFromTargets(rig, profile, configs, targetByServo) {
  let next = normalizeEliteRig(rig)
  next = refineOneEyeRadar(next, profile, configs, targetByServo, "eye_l_xy", "eyeL")
  next = refineOneEyeRadar(next, profile, configs, targetByServo, "eye_r_xy", "eyeR")
  // 旧 profile 仅有 eye_xy 时仍尝试
  const legacy = (profile.bindings || []).filter((b) => b.enabled && b.controlId === "eye_xy")
  if (legacy.length) {
    next = refineOneEyeRadar(
      { ...next, eyeL: { ...next.eyeL }, eyeR: { ...next.eyeR } },
      profile,
      configs,
      targetByServo,
      "eye_xy",
      "eyeL"
    )
    next = {
      ...next,
      eyeR: { ...next.eyeR, x: next.eyeL.x, y: next.eyeL.y },
    }
  }
  return syncSharedRadarMirror(next)
}

/**
 * 根据关键帧中存储的舵机逻辑脉宽，反推 elite rig 控件状态，使时间轴选中关键帧后面部控件与 poses 大致一致。
 * 多绑定合成的舵机只做近似；eye_xy 用小步交替搜索。
 */
export function approximateEliteRigFromKeyframePositions(positions = {}, profile, configs = []) {
  let rig = createInitialEliteRig()
  const controlsById = new Map((profile.controls || []).map((c) => [c.controlId, c]))
  const bindings = (profile.bindings || []).filter((b) => b.enabled)

  const targetByServo = {}
  const posObj = positions && typeof positions === "object" ? positions : {}
  for (const key of Object.keys(posObj)) {
    const pwm = Number(posObj[key])
    if (Number.isFinite(pwm)) {
      targetByServo[String(key)] = clampNumber(pwm, SERVO_LOGICAL_MIN_PWM, SERVO_LOGICAL_MAX_PWM)
    }
  }

  const clusters = new Map()
  for (const b of bindings) {
    const k = `${b.controlId}\t${b.channel}`
    if (!clusters.has(k)) clusters.set(k, [])
    clusters.get(k).push(b)
  }

  const skippedMultiNonEye = []

  for (const [, binds] of clusters) {
    const b0 = binds[0]
    const { controlId, channel } = b0
    if (
      (controlId === "eye_xy" || controlId === "eye_l_xy" || controlId === "eye_r_xy") &&
      (channel === CHANNEL_X || channel === CHANNEL_Y) &&
      binds.length > 1
    ) {
      continue
    }
    if (binds.length !== 1) {
      skippedMultiNonEye.push(binds)
      continue
    }
    const pwmT = targetByServo[String(b0.servoId)]
    if (pwmT === undefined || pwmT === null) {
      continue
    }
    const ctrl = controlsById.get(controlId)
    if (!ctrl) {
      continue
    }
    const spec = ctrl.channels?.[channel]
    if (!spec) {
      continue
    }
    const driver = invertDriverForTargetLogicalPwm(pwmT, b0)
    const raw = driverToChannelRawForSpec(driver, spec)
    rig = patchEliteFromControlChannel(rig, controlId, channel, raw)
  }

  for (const binds of skippedMultiNonEye) {
    const b0 = binds[0]
    const pwmT = targetByServo[String(b0.servoId)]
    if (pwmT === undefined || pwmT === null) {
      continue
    }
    const ctrl = controlsById.get(b0.controlId)
    if (!ctrl) {
      continue
    }
    const spec = ctrl.channels?.[b0.channel]
    if (!spec) {
      continue
    }
    const driver = invertDriverForTargetLogicalPwm(pwmT, b0)
    const raw = driverToChannelRawForSpec(driver, spec)
    rig = patchEliteFromControlChannel(rig, b0.controlId, b0.channel, raw)
  }

  rig = refineEyeRadarFromTargets(rig, profile, configs, targetByServo)
  return rig
}
