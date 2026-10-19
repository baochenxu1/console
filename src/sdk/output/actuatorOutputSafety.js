/** @typedef {{ enabled?: boolean, mode?: string, maxTargetDeltaPerFrame?: Record<string, number> }} ActuatorSafetyConfig */

export const DEFAULT_ACTUATOR_SAFETY = {
  enabled: true,
  mode: "slew-only",
  maxTargetDeltaPerFrame: {
    jaw: 35,
    lip: 40,
    mouthCorner: 40,
    eye: 12,
    eyeXY: 16,
    brow: 30,
    default: 45,
  },
  /** eye release 阶段更严格的 target slew（不影响闭眼方向） */
  releaseMaxTargetDeltaPerFrame: {
    eye: 8,
  },
}

/** Device Drive 实时追踪：放宽 per-send slew；mapping 大跳变时直接对齐避免机械追赶 */
export const DEFAULT_TRACKING_ACTUATOR_SAFETY = {
  ...DEFAULT_ACTUATOR_SAFETY,
  resetOnLargeJump: true,
  largeJumpMultiplier: 2.8,
  maxTargetDeltaPerFrame: {
    jaw: 65,
    lip: 78,
    mouthCorner: 78,
    eye: 32,
    eyeXY: 32,
    brow: 72,
    default: 80,
  },
  releaseMaxTargetDeltaPerFrame: {
    eye: 28,
  },
}

/**
 * @returns {{ actuators: Record<string, { lastSafeTargetPosition: number, lastCandidateTargetPosition: number, lastSafeLogicalValue: number, lastTimestampMs: number, busServoId?: number }> }}
 */
/**
 * @param {{ ownerId?: string, consumerType?: string }} [meta]
 */
export function createActuatorSafetyState(meta = null) {
  return {
    ownerId: meta?.ownerId || "unknown",
    consumerType: meta?.consumerType || "unknown",
    stateCommitCount: 0,
    actuators: {},
  }
}

/**
 * @param {ReturnType<typeof createActuatorSafetyState>} safetyState
 * @param {string} actuatorKey
 */
export function hasPreviousSafeTarget(safetyState, actuatorKey) {
  const key = String(actuatorKey || "")
  if (!key || !safetyState?.actuators) {
    return false
  }
  return Object.prototype.hasOwnProperty.call(safetyState.actuators, key)
}

/**
 * @param {ReturnType<typeof createActuatorSafetyState>} safetyState
 * @param {string} actuatorKey
 */
export function getPreviousSafeTarget(safetyState, actuatorKey) {
  if (!hasPreviousSafeTarget(safetyState, actuatorKey)) {
    return null
  }
  const v = safetyState.actuators[String(actuatorKey)]?.lastSafeTargetPosition
  return Number.isFinite(Number(v)) ? Number(v) : null
}

/**
 * @param {ReturnType<typeof createActuatorSafetyState>} safetyState
 * @param {object} command
 * @param {number} nowMs
 * @param {{ frameIndex?: number | null, sourceSeq?: number | null }} [meta]
 */
export function commitActuatorSafetyState(safetyState, command, nowMs = Date.now(), meta = null) {
  if (!safetyState) {
    return
  }
  if (!safetyState.actuators) {
    safetyState.actuators = {}
  }
  const key = String(command?.actuatorKey || "")
  if (!key) {
    return
  }
  const safeTarget = Number(command.targetPosition)
  if (!Number.isFinite(safeTarget)) {
    return
  }
  safetyState.actuators[key] = {
    busServoId: Number(command.busServoId),
    lastSafeTargetPosition: safeTarget,
    lastSentTargetPosition: safeTarget,
    lastCandidateTargetPosition: Number.isFinite(Number(command.candidateTargetPosition))
      ? Number(command.candidateTargetPosition)
      : safeTarget,
    lastSafeLogicalValue: Number.isFinite(Number(command.busLogical))
      ? Number(command.busLogical)
      : Number(command.logicalValue),
    lastTimestampMs: nowMs,
    lastFrameIndex: Number.isFinite(Number(meta?.frameIndex)) ? Number(meta.frameIndex) : null,
    lastSourceSeq: Number.isFinite(Number(meta?.sourceSeq)) ? Number(meta.sourceSeq) : null,
  }
  safetyState.stateCommitCount = (Number(safetyState.stateCommitCount) || 0) + 1
}

/**
 * @param {ReturnType<typeof createActuatorSafetyState>} safetyState
 * @param {object[]} commands
 * @param {number} [nowMs]
 * @param {{ frameIndex?: number | null, sourceSeq?: number | null }} [meta]
 */
export function commitActuatorSafetyStates(safetyState, commands, nowMs = Date.now(), meta = null) {
  for (const cmd of commands || []) {
    commitActuatorSafetyState(safetyState, cmd, nowMs, meta)
  }
}

/**
 * @param {string | null | undefined} sourceChannel
 * @param {string | null | undefined} actuatorKey
 */
export function inferActuatorSafetyRole(sourceChannel, actuatorKey) {
  const ch = String(sourceChannel || "")
  if (ch.startsWith("jaw.")) {
    return "jaw"
  }
  if (
    ch.startsWith("mouth_ul.") ||
    ch.startsWith("mouth_ur.") ||
    ch.startsWith("mouth_ll.") ||
    ch.startsWith("mouth_lr.")
  ) {
    return "lip"
  }
  if (ch.startsWith("mouth_corner_")) {
    return "mouthCorner"
  }
  if (ch.startsWith("brow_")) {
    return "brow"
  }
  if (ch.startsWith("eye_xy.")) {
    return "eyeXY"
  }
  if (ch.startsWith("eye_")) {
    return "eye"
  }
  const key = String(actuatorKey || "")
  if (key.includes("jaw") || key === "servo_9" || key === "servo_15" || key === "servo_16") {
    return "jaw"
  }
  return "default"
}

function pickLimit(map, role) {
  const m = map && typeof map === "object" ? map : {}
  const v = m[role] ?? m.default
  return Number.isFinite(Number(v)) ? Number(v) : null
}

function clampDelta(delta, maxDelta) {
  if (!Number.isFinite(maxDelta) || maxDelta <= 0) {
    return delta
  }
  return Math.max(-maxDelta, Math.min(maxDelta, delta))
}

/**
 * 轻量 per-frame slew limit（无 hard-jump / hold）。
 * @param {object} args
 * @param {number | null | undefined} args.candidateTarget
 * @param {number | null | undefined} args.previousTarget
 * @param {boolean} [args.hasPreviousTarget]
 * @param {string} args.role
 * @param {string} [args.motionPhase] 如 "eye-release"
 * @param {ActuatorSafetyConfig} [args.cfg]
 * @param {number | null} [args.elapsedMsSinceLastSend] 距上次真实发送的间隔，用于 time-scaled slew
 * @param {number} [args.frameBudgetMs] 标称发送间隔（默认 40ms ≈ 25fps）
 */
export function applyActuatorTargetSafety({
  candidateTarget,
  previousTarget,
  hasPreviousTarget = false,
  role,
  motionPhase = null,
  cfg = DEFAULT_ACTUATOR_SAFETY,
  elapsedMsSinceLastSend = null,
  frameBudgetMs = 40,
} = {}) {
  const candidate = Number(candidateTarget)
  const prev = Number(previousTarget)
  const previousSafeTarget =
    hasPreviousTarget && Number.isFinite(prev) ? prev : null
  const useReleaseLimit = motionPhase === "eye-release" && role === "eye"
  let maxDelta = useReleaseLimit
    ? pickLimit(cfg?.releaseMaxTargetDeltaPerFrame, role) ??
      pickLimit(cfg?.maxTargetDeltaPerFrame, role)
    : pickLimit(cfg?.maxTargetDeltaPerFrame, role)

  const elapsed = Number(elapsedMsSinceLastSend)
  if (Number.isFinite(elapsed) && elapsed > 0 && Number.isFinite(maxDelta) && maxDelta > 0) {
    const budget =
      Number.isFinite(Number(frameBudgetMs)) && Number(frameBudgetMs) > 0
        ? Number(frameBudgetMs)
        : 40
    const scale = Math.max(1, Math.min(6, elapsed / budget))
    maxDelta = maxDelta * scale
  }

  const baseSafety = {
    candidateTarget: Number.isFinite(candidate) ? candidate : candidateTarget,
    safeTarget: Number.isFinite(candidate) ? candidate : candidateTarget,
    previousSafeTarget,
    deltaTarget: null,
    maxDelta,
    role,
    motionPhase: motionPhase || null,
    limited: false,
    reason: "pass",
  }

  if (!cfg?.enabled || !Number.isFinite(candidate)) {
    return {
      safeTarget: candidateTarget,
      safety: {
        ...baseSafety,
        reason: "disabled-or-invalid",
      },
    }
  }

  if (!hasPreviousTarget || !Number.isFinite(prev)) {
    return {
      safeTarget: candidate,
      safety: {
        ...baseSafety,
        safeTarget: candidate,
        previousSafeTarget: candidate,
        deltaTarget: 0,
        reason: "first-sample-pass",
      },
    }
  }

  const delta = candidate - prev
  const mult = Number(cfg?.largeJumpMultiplier)
  if (
    cfg?.resetOnLargeJump &&
    Number.isFinite(maxDelta) &&
    maxDelta > 0 &&
    Number.isFinite(mult) &&
    mult > 0 &&
    Math.abs(delta) > maxDelta * mult
  ) {
    return {
      safeTarget: candidate,
      safety: {
        ...baseSafety,
        candidateTarget: candidate,
        safeTarget: candidate,
        previousSafeTarget: prev,
        deltaTarget: delta,
        maxDelta,
        limited: false,
        reason: "large-jump-reset",
      },
    }
  }

  const clampedDelta = clampDelta(delta, maxDelta ?? Infinity)
  const safeTarget = prev + clampedDelta
  const limited = Math.abs(clampedDelta - delta) > 1e-6

  return {
    safeTarget,
    safety: {
      candidateTarget: candidate,
      safeTarget,
      previousSafeTarget: prev,
      deltaTarget: safeTarget - prev,
      maxDelta,
      role,
      motionPhase: motionPhase || null,
      limited,
      reason: limited ? (useReleaseLimit ? "release-slew-limit" : "slew-limit") : "pass",
    },
  }
}

/** @deprecated 使用 buildBusCommandsFromFinalOutputs 内建 safety */
export const applyLightActuatorSafety = applyActuatorTargetSafety
