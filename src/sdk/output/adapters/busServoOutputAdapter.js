import { computeServoTargetFromLogical } from "../../servoAdapters/core/servoProfileMath.js"
import { sendBusServoCommands } from "../../servoAdapters/busServo/sendBusServoCommands.js"
import { resolveActuatorProfile } from "../resolveActuatorProfile.js"
import { ACTUATOR_BUS_ID_MISMATCH } from "../analyzeActuatorProfiles.js"
import { clampLogical } from "../pwmLogicalConvert.js"
import {
  applyActuatorTargetSafety,
  DEFAULT_ACTUATOR_SAFETY,
  getPreviousSafeTarget,
  hasPreviousSafeTarget,
  inferActuatorSafetyRole,
} from "../actuatorOutputSafety.js"

function isForbiddenBusId(id) {
  const n = Number(id)
  return !Number.isFinite(n) || n <= 0
}

/**
 * FinalServoOutput[] → bus commands（按 actuatorKey 查 profile，不用 routeMap）。
 */
function resolveMotionPhase(out, { eyeReleasing = false } = {}) {
  if (out?.motionPhase === "eye-release") {
    return "eye-release"
  }
  const ch = String(out?.sourceChannel || "")
  if (eyeReleasing && ch.startsWith("eye_")) {
    return "eye-release"
  }
  return null
}

export function buildBusCommandsFromFinalOutputs(finalOutputs, actuatorProfiles, {
  actuatorSafety = DEFAULT_ACTUATOR_SAFETY,
  safetyState = null,
  eyeReleasing = false,
  frameSeq = null,
  elapsedMsSinceLastSend = null,
  frameBudgetMs = 40,
} = {}) {
  const commands = []
  const skipped = []
  let scCount = 0
  let stCount = 0

  for (const out of finalOutputs || []) {
    if (out?.enabled === false) {
      continue
    }

    const resolved = resolveActuatorProfile({
      actuatorKey: out.actuatorKey,
      legacyServoIndex: out.legacyServoIndex,
      profiles: actuatorProfiles,
    })

    if (!resolved.ok) {
      skipped.push({
        actuatorKey: out.actuatorKey,
        legacyServoIndex: out.legacyServoIndex,
        reason: resolved.reason,
      })
      continue
    }

    if (resolved.warning === ACTUATOR_BUS_ID_MISMATCH) {
      skipped.push({
        actuatorKey: out.actuatorKey,
        legacyServoIndex: out.legacyServoIndex,
        reason: resolved.warning,
        message: resolved.warningMessage,
        busServoId: resolved.profile?.busServoId,
      })
      continue
    }

    const ap = resolved.profile
    if (!ap.protocol || isForbiddenBusId(ap.busServoId)) {
      skipped.push({
        actuatorKey: out.actuatorKey,
        reason: "invalid-bus-id",
      })
      continue
    }

    const busLogical = clampLogical(out.logicalValue)
    const plan = computeServoTargetFromLogical(ap, busLogical)
    const busServoId = Number(ap.busServoId)
    const actuatorKey = String(out.actuatorKey || "")
    const hasPrevious = hasPreviousSafeTarget(safetyState, actuatorKey)
    const prevTarget = hasPrevious ? getPreviousSafeTarget(safetyState, actuatorKey) : null
    const role = inferActuatorSafetyRole(out.sourceChannel, out.actuatorKey)
    const candidateTarget = plan.targetPosition
    const motionPhase = resolveMotionPhase(out, { eyeReleasing })
    const guarded = applyActuatorTargetSafety({
      candidateTarget,
      previousTarget: prevTarget,
      hasPreviousTarget: hasPrevious,
      role,
      motionPhase,
      cfg: actuatorSafety,
      elapsedMsSinceLastSend,
      frameBudgetMs,
    })
    const safeTarget = guarded.safeTarget

    const cmd = {
      actuatorKey: out.actuatorKey,
      frameSeq: Number.isFinite(Number(frameSeq))
        ? Number(frameSeq)
        : Number.isFinite(Number(out.sourceFrameIndex))
          ? Number(out.sourceFrameIndex)
          : null,
      motionPhase,
      sourceChannel: out.sourceChannel || null,
      legacyServoIndex: out.legacyServoIndex,
      logicalServoIndex: out.legacyServoIndex,
      busServoId,
      protocol: ap.protocol,
      servoModel: ap.servoModel,
      profileWarning: resolved.warning || null,
      profileWarningMessage: resolved.warningMessage || null,
      sourceType: out.sourceType || "actual-pwm",
      rawValue: out.pwmValue,
      actualPwm: out.pwmValue,
      busLogical,
      logicalValue: busLogical,
      targetPosition: safeTarget,
      candidateTargetPosition: candidateTarget,
      previousTargetPosition: prevTarget ?? null,
      deltaTarget:
        prevTarget != null && safeTarget != null && Number.isFinite(Number(safeTarget))
          ? Number(safeTarget) - Number(prevTarget)
          : null,
      safety: guarded.safety,
      centerMode: plan.centerMode ?? ap.centerMode,
      installedCenterPosition: ap.installedCenterPosition,
      isClamped: Boolean(plan.isClamped),
      clampReason: plan.clampReason ?? plan.warning ?? null,
      profile: ap,
      speed: ap.speed ?? 0,
      time: ap.time ?? 0,
      acc: ap.acc ?? 0,
      sent: false,
      skippedReason: null,
    }

    commands.push(cmd)
    if (ap.protocol === "sms_sts") {
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

export function formatBusCommandsPreview(commands, { maxItems = 6 } = {}) {
  if (!commands?.length) {
    return ""
  }
  const parts = commands.slice(0, maxItems).map(
    (c) =>
      `${c.actuatorKey}→#${c.busServoId} lv=${c.busLogical} pos=${c.targetPosition}`
  )
  if (commands.length > maxItems) {
    parts.push(`+${commands.length - maxItems} more`)
  }
  return parts.join(" | ")
}

export function buildBusOutputDebug(built, finalOutputs, sendMeta = {}) {
  const { realTxFps, droppedByFpsLimit, ...txRaw } = sendMeta

  return {
    sourceFrame: {
      hasFinalServoOutputs: (finalOutputs?.length ?? 0) > 0,
      finalServoOutputCount: finalOutputs?.length ?? 0,
    },
    finalServoOutputs: (finalOutputs || []).slice(0, 20).map((o) => ({
      actuatorKey: o.actuatorKey,
      legacyServoIndex: o.legacyServoIndex,
      logicalValue: o.logicalValue,
      pwmValue: o.pwmValue,
      sourceChannel: o.sourceChannel,
      bindingId: o.bindingId,
      sourceType: o.sourceType,
    })),
    busBuild: {
      commandCount: built?.summary?.commandCount ?? 0,
      skippedCount: built?.summary?.skippedCount ?? 0,
      scCount: built?.summary?.scCount ?? 0,
      stCount: built?.summary?.stCount ?? 0,
    },
    busCommands: (built?.commands || []).slice(0, 20).map((c) => ({
      actuatorKey: c.actuatorKey,
      busServoId: c.busServoId,
      protocol: c.protocol,
      logicalValue: c.busLogical,
      sourceChannel: c.sourceChannel ?? null,
      candidateTargetPosition: c.candidateTargetPosition ?? null,
      safetyTargetPosition: c.safety?.safeTarget ?? c.safetyTargetPosition ?? c.targetPosition ?? null,
      twitchGuardTargetPosition:
        c.twitchGuardTargetPosition ?? c.twitchGuard?.outputTarget ?? c.targetPosition ?? null,
      realSentTargetPosition: c.sent ? (c.realSentTargetPosition ?? c.targetPosition ?? null) : null,
      sendMode: c.sendMode ?? null,
      targetPosition: c.targetPosition,
      twitchGuard: c.twitchGuard ?? null,
      safety: c.safety ?? null,
      centerMode: c.centerMode,
      sent: Boolean(c.sent),
    })),
    skipped: (built?.skipped || []).slice(0, 20),
    tx: {
      realTxCount: txRaw.realTxCount ?? txRaw.txSent ?? 0,
      realTxFps: realTxFps ?? null,
      droppedByFpsLimit: droppedByFpsLimit ?? 0,
      commandCount: txRaw.commandCount ?? txRaw.commandCountTotal ?? txRaw.txSent ?? built?.summary?.commandCount ?? 0,
      packetCount: txRaw.packetCount ?? txRaw.packetCountTotal ?? null,
      writeDurationMs: txRaw.writeDurationMs ?? txRaw.writeDurationMsTotal ?? null,
      commandCountTotal: txRaw.commandCountTotal ?? txRaw.commandCount ?? null,
      packetCountTotal: txRaw.packetCountTotal ?? txRaw.packetCount ?? null,
      writeDurationMsTotal: txRaw.writeDurationMsTotal ?? txRaw.writeDurationMs ?? null,
      groups: txRaw.groups ?? [],
      sentServoIds: txRaw.sentServoIds ?? [],
      skippedServoIds: txRaw.skippedServoIds ?? [],
      packetHex: txRaw.packetHex ?? txRaw.lastTxPacketHex ?? "",
      lastTxPacketHex: txRaw.lastTxPacketHex ?? txRaw.packetHex ?? "",
      lastTxBusId: txRaw.lastTxBusId ?? null,
      lastTxProtocol: txRaw.lastTxProtocol ?? "",
      lastTxTargetPosition: txRaw.lastTxTargetPosition ?? null,
      lastTxReason: txRaw.lastTxReason ?? txRaw.txSkippedReason ?? "",
      txMode: txRaw.txMode ?? "hybrid",
      scSyncMode: txRaw.scSyncMode ?? null,
      scsclBroadcastId: txRaw.scsclBroadcastId ?? null,
      portConnected: txRaw.portConnected ?? null,
      writerSharedWithServoPage: txRaw.writerSharedWithServoPage ?? false,
    },
  }
}

/**
 * 发送 bus 输出（Device Drive 默认 sync-write）。
 */
export async function sendBusServoOutputs(
  finalOutputs,
  actuatorProfiles,
  options = {}
) {
  const built = buildBusCommandsFromFinalOutputs(finalOutputs, actuatorProfiles, {
    safetyState: options.safetyState ?? null,
  })

  if (
    options.commandTimeMs != null &&
    Number.isFinite(Number(options.commandTimeMs)) &&
    built.commands?.length
  ) {
    const t = Math.max(0, Math.round(Number(options.commandTimeMs)))
    for (const c of built.commands) {
      c.time = t
    }
  }

  if (!built.commands.length) {
    return {
      ok: false,
      error: built.skipped.length ? "全部 actuator 被跳过" : "无 bus 命令",
      built,
      send: null,
    }
  }

  const sendRes = await sendBusServoCommands(built.commands, {
    transport: options.transport,
    rjTransport: options.rjTransport,
    txMode: options.txMode ?? "hybrid",
    syncMode: options.syncMode ?? options.scSyncMode ?? "sync-inst",
    scSyncMode: options.scSyncMode ?? options.syncMode ?? "sync-inst",
    scsclBroadcastId: options.scsclBroadcastId,
    rjMotionConfig: options.rjMotionConfig ?? options.motionConfig,
  })

  const commandsWithSent = {
    ...built,
    commands: built.commands.map((c) => ({ ...c, sent: sendRes.ok })),
  }

  return {
    ok: sendRes.ok,
    built: commandsWithSent,
    send: sendRes,
    error: sendRes.error,
  }
}
