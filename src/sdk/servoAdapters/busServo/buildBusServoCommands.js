import { computeServoTargetFromLogical, LOGICAL_MIN, LOGICAL_MAX } from "../core/servoProfileMath.js"
import { PROTOCOL } from "../core/servoTypes.js"
import { FACE_BUS_SERVO_ROUTE } from "./faceBusServoRoute.js"
import { normalizeToBusLogicalValue } from "./normalizeToBusLogicalValue.js"
import { resolveBusServoProfile } from "./resolveBusServoProfile.js"

function clampLogical(v) {
  return Math.round(Math.max(LOGICAL_MIN, Math.min(LOGICAL_MAX, Number(v) || 0)))
}

function extractPoseEntries(actualPose) {
  if (!actualPose || typeof actualPose !== "object") {
    return []
  }
  if (Array.isArray(actualPose)) {
    return actualPose
      .map((item) => ({
        logicalServoIndex: Number(item.servoIndex ?? item.logicalServoIndex ?? item.id),
        output: item,
      }))
      .filter((item) => Number.isFinite(item.logicalServoIndex))
  }
  return Object.entries(actualPose).map(([key, value]) => ({
    logicalServoIndex: Number(key),
    output: typeof value === "object" ? value : { value, pwm: value },
  }))
}

function collectServoEntries({ actualPose, pwmOutputs }) {
  if (Array.isArray(pwmOutputs) && pwmOutputs.length > 0) {
    return pwmOutputs
      .map((o) => ({
        logicalServoIndex: Number(o.servoIndex ?? o.servoId ?? o.logicalServoIndex),
        output: o,
      }))
      .filter((e) => Number.isFinite(e.logicalServoIndex))
  }
  return extractPoseEntries(actualPose)
}

/**
 * 优先从旧 PWM 最终输出构建总线命令；仅 routeMap 中的舵机会下发。
 * @param {object} params
 * @param {Record<string, number> | Array} [params.actualPose]
 * @param {object[]} [params.pwmOutputs] 旧 PWM 链路最终输出（优先）
 * @param {object[] | object} params.profiles
 * @param {object} [params.routeMap]
 * @param {Record<number, number>} [params.previousTargets] busServoId → 上次 targetPosition
 */
export function buildBusServoCommands({
  actualPose,
  pwmOutputs,
  profiles,
  routeMap = FACE_BUS_SERVO_ROUTE,
  previousTargets = {},
}) {
  const commands = []
  const skipped = []
  let scCount = 0
  let stCount = 0

  for (const { logicalServoIndex, output } of collectServoEntries({ actualPose, pwmOutputs })) {
    if (!Number.isFinite(logicalServoIndex)) {
      continue
    }

    const resolved = resolveBusServoProfile({
      logicalServoIndex,
      profiles,
      routeMap,
    })

    if (!resolved.ok) {
      skipped.push({
        logicalServoIndex,
        reason: resolved.reason,
        route: resolved.route ?? null,
      })
      continue
    }

    const normalized = normalizeToBusLogicalValue(output)
    const busLogical = clampLogical(normalized.busLogical)
    const plan = computeServoTargetFromLogical(resolved.profile, busLogical)
    const prevTarget = previousTargets[resolved.busServoId]

    const cmd = {
      logicalServoIndex,
      busServoId: resolved.busServoId,
      protocol: resolved.protocol,
      servoModel: resolved.profile.servoModel,
      sourceType: normalized.sourceType,
      rawValue: normalized.rawValue,
      actualPwm: normalized.rawValue,
      busLogical,
      logicalValue: busLogical,
      pwmLogical: normalized.rawValue,
      targetPosition: plan.targetPosition,
      previousTargetPosition: prevTarget ?? null,
      deltaTarget:
        prevTarget != null && plan.targetPosition != null
          ? plan.targetPosition - prevTarget
          : null,
      centerMode: plan.centerMode ?? resolved.profile.centerMode,
      installedCenterPosition: resolved.profile.installedCenterPosition,
      isClamped: Boolean(plan.isClamped),
      clampReason: plan.clampReason ?? plan.warning ?? null,
      profile: resolved.profile,
      speed: resolved.profile.speed ?? 0,
      time: resolved.profile.time ?? 40,
      acc: resolved.profile.acc ?? 0,
      sent: false,
      skippedReason: null,
    }

    commands.push(cmd)
    if (resolved.protocol === PROTOCOL.SMS_STS) {
      stCount += 1
    } else {
      scCount += 1
    }
  }

  return {
    commands,
    skipped,
    summary: {
      commandCount: commands.length,
      skippedCount: skipped.length,
      scCount,
      stCount,
    },
  }
}

/**
 * 回中：routeMap 中 enabled 路由，PWM 中位 1500 → bus logical 500。
 */
export function buildBusServoNeutralCommands({
  profiles,
  routeMap = FACE_BUS_SERVO_ROUTE,
}) {
  const pwmOutputs = []
  for (const idx of Object.keys(routeMap).map(Number)) {
    if (routeMap[idx]?.enabled === true) {
      pwmOutputs.push({
        servoIndex: idx,
        actualPwm: 1500,
        pwm: 1500,
        sourceType: "neutral-pwm",
      })
    }
  }
  return buildBusServoCommands({ pwmOutputs, profiles, routeMap })
}

export function formatBusCommandsPreview(commands, { maxItems = 6 } = {}) {
  if (!commands?.length) {
    return ""
  }
  const parts = commands.slice(0, maxItems).map(
    (c) =>
      `L${c.logicalServoIndex}→#${c.busServoId} ${c.sourceType || "?"} lv=${c.busLogical} pos=${c.targetPosition}`
  )
  if (commands.length > maxItems) {
    parts.push(`+${commands.length - maxItems} more`)
  }
  return parts.join(" | ")
}

/**
 * 构建 Bus Servo Debug 面板数据（完整链路）。
 */
export function buildBusServoOutputDebug(built, sendMeta = {}) {
  const {
    sourceFrame,
    pwmOutputCount,
    realTxFps,
    droppedByFpsLimit,
    ...txRaw
  } = sendMeta

  const commands = (built?.commands || []).map((c) => ({
    logicalServoIndex: c.logicalServoIndex,
    busServoId: c.busServoId,
    protocol: c.protocol,
    sourceType: c.sourceType,
    rawValue: c.rawValue,
    actualPwm: c.actualPwm ?? c.rawValue,
    busLogical: c.busLogical,
    targetPosition: c.targetPosition,
    previousTargetPosition: c.previousTargetPosition,
    deltaTarget: c.deltaTarget,
    centerMode: c.centerMode,
    installedCenterPosition: c.installedCenterPosition,
    isClamped: c.isClamped,
    sent: Boolean(c.sent),
    skippedReason: c.skippedReason,
  }))

  const finalCount = pwmOutputCount ?? sourceFrame?.finalServoOutputCount ?? 0

  return {
    sourceFrame: {
      hasRigFrame: sourceFrame?.hasRigFrame ?? null,
      hasFaceRig: sourceFrame?.hasFaceRig ?? null,
      hasFinalServoOutputs: finalCount > 0,
      finalServoOutputCount: finalCount,
      ...sourceFrame,
    },
    busBuild: {
      commandCount: built?.summary?.commandCount ?? 0,
      skippedCount: built?.summary?.skippedCount ?? 0,
      scCount: built?.summary?.scCount ?? 0,
      stCount: built?.summary?.stCount ?? 0,
    },
    commands: commands.slice(0, 20),
    skipped: (built?.skipped || []).slice(0, 20),
    tx: {
      realTxCount: txRaw.realTxCount ?? txRaw.txSent ?? 0,
      realTxFps: realTxFps ?? null,
      droppedByFpsLimit: droppedByFpsLimit ?? 0,
      lastTxPacketHex: txRaw.lastTxPacketHex ?? "",
      lastTxBusId: txRaw.lastTxBusId ?? null,
      lastTxProtocol: txRaw.lastTxProtocol ?? "",
      lastTxTargetPosition: txRaw.lastTxTargetPosition ?? null,
      lastTxReason: txRaw.lastTxReason ?? txRaw.txSkippedReason ?? "",
      txMode: txRaw.txMode ?? "sync-write",
      portConnected: txRaw.portConnected ?? null,
      writerSharedWithServoPage: txRaw.writerSharedWithServoPage ?? true,
    },
  }
}
