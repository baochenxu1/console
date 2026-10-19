/**
 * Upper Face Twitch Guard：真实发送层拦截 eyelid / eye_xy / brow 随机大跳。
 * 含 per-actuator guard 与 frame-level multi-spike hold。
 */

import { inferActuatorSafetyRole } from "./actuatorOutputSafety.js"

export const DEFAULT_UPPER_FACE_TWITCH_GUARD = {
  enabled: true,
  hardTargetJumpThreshold: {
    eyelid: 35,
    eyeXY: 35,
    brow: 45,
    default: 60,
  },
  hardControlJumpThreshold: {
    eyelid: 12,
    eyeXY: 10,
    brow: 14,
    default: 20,
  },
  holdFramesOnTwitch: 1,
  recoverMaxTargetDelta: {
    eyelid: 8,
    eyeXY: 8,
    brow: 10,
    default: 12,
  },
  upperFaceFrameSpikeGuard: {
    enabled: true,
    spikeCountThreshold: 2,
    holdFrames: 1,
  },
}

/**
 * Tracking Device Drive：整脸协同大动时不触发 frame-spike hold；
 * recover 与 safety slew 对齐，避免 30→10 双重限速。
 */
export const DEFAULT_TRACKING_UPPER_FACE_TWITCH_GUARD = {
  ...DEFAULT_UPPER_FACE_TWITCH_GUARD,
  /** Tracking 仅保留 safety slew；twitch recover 会二次限速 upper face */
  enabled: false,
  upperFaceFrameSpikeGuard: {
    enabled: false,
    spikeCountThreshold: 6,
    holdFrames: 0,
  },
  recoverMaxTargetDelta: {
    eyelid: 22,
    eyeXY: 28,
    brow: 48,
    default: 55,
  },
  hardTargetJumpThreshold: {
    eyelid: 70,
    eyeXY: 70,
    brow: 90,
    default: 120,
  },
  hardControlJumpThreshold: {
    eyelid: 28,
    eyeXY: 24,
    brow: 32,
    default: 40,
  },
}

function numOr(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function pickRoleMap(map, role, fallbackKey = "default") {
  const m = map && typeof map === "object" ? map : {}
  const v = m[role] ?? m[fallbackKey]
  return Number.isFinite(Number(v)) ? Number(v) : null
}

function resolveCandidateControl(cmd) {
  const v = cmd?.busLogical ?? cmd?.logicalValue ?? cmd?.safety?.lastSafeLogicalValue
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function resolveCandidateTarget(cmd) {
  const t = Number(cmd?.targetPosition ?? cmd?.safety?.candidateTarget)
  return Number.isFinite(t) ? t : null
}

/** @param {string | null | undefined} sourceChannel @param {string | null | undefined} actuatorKey */
export function inferUpperFaceRole(sourceChannel, actuatorKey) {
  const ch = String(sourceChannel || "")
  if (ch.startsWith("eye_xy.")) {
    return "eyeXY"
  }
  if (ch.startsWith("brow_")) {
    return "brow"
  }
  if (ch.startsWith("eye_")) {
    return "eyelid"
  }

  const safetyRole = inferActuatorSafetyRole(sourceChannel, actuatorKey)
  if (safetyRole === "brow") return "brow"
  if (safetyRole === "eye") return "eyelid"

  const key = String(actuatorKey || "")
  if (key === "servo_5" || key === "servo_19") return "eyeXY"
  if (["servo_1", "servo_2", "servo_22", "servo_23"].includes(key)) return "brow"
  if (["servo_3", "servo_4", "servo_20", "servo_21"].includes(key)) return "eyelid"
  return null
}

export function isUpperFaceCommand(cmd) {
  return inferUpperFaceRole(cmd?.sourceChannel, cmd?.actuatorKey) != null
}

export function createUpperFaceTwitchGuardState() {
  return {
    actuators: {},
    holdFramesLeft: {},
    frameSpikeHoldLeft: 0,
  }
}

function readActuatorState(state, key) {
  return state?.actuators?.[key] || null
}

function wouldTriggerTwitch(cmd, prev, cfg, role) {
  const candidate = resolveCandidateTarget(cmd)
  const candidateControl = resolveCandidateControl(cmd)
  if (!prev || !Number.isFinite(candidate)) {
    return false
  }
  const prevTarget = Number(prev.lastRealSentTarget)
  const prevControl = Number.isFinite(Number(prev.lastRealSentControl))
    ? Number(prev.lastRealSentControl)
    : null
  if (!Number.isFinite(prevTarget)) {
    return false
  }

  const targetJumpThr = pickRoleMap(cfg.hardTargetJumpThreshold, role) ?? 60
  const controlJumpThr = pickRoleMap(cfg.hardControlJumpThreshold, role) ?? 20
  const targetJump = Math.abs(candidate - prevTarget) > targetJumpThr
  const controlJump =
    candidateControl != null &&
    prevControl != null &&
    Math.abs(candidateControl - prevControl) > controlJumpThr
  return targetJump || controlJump
}

function resolveRawCandidateTarget(cmd) {
  const raw = Number(cmd?.candidateTargetPosition ?? cmd?.safety?.candidateTarget)
  if (Number.isFinite(raw)) {
    return raw
  }
  return resolveCandidateTarget(cmd)
}

function guardSingleCommand(cmd, state, cfg, role, frameSpikeTriggered) {
  const key = String(cmd.actuatorKey || "")
  const prev = readActuatorState(state, key)
  const candidate = resolveCandidateTarget(cmd)
  const rawCandidate = resolveRawCandidateTarget(cmd)
  const candidateControl = resolveCandidateControl(cmd)
  const safetyTarget = Number(cmd.targetPosition)
  const hasPrev = prev && Number.isFinite(Number(prev.lastRealSentTarget))
  const prevTarget = hasPrev ? Number(prev.lastRealSentTarget) : null
  const prevControl = Number.isFinite(Number(prev?.lastRealSentControl))
    ? Number(prev.lastRealSentControl)
    : null
  const holdLeft = Number(state.holdFramesLeft[key]) || 0

  let outputTarget = Number.isFinite(safetyTarget) ? safetyTarget : candidate
  let triggered = false
  let action = "pass"
  let reason = "pass"
  const targetJump =
    hasPrev && Number.isFinite(rawCandidate) ? Math.abs(rawCandidate - prevTarget) : 0
  const controlJump =
    candidateControl != null && prevControl != null
      ? Math.abs(candidateControl - prevControl)
      : 0

  if (frameSpikeTriggered) {
    outputTarget = prevTarget ?? outputTarget
    triggered = true
    action = "frame-spike-hold"
    reason = "frame-spike-hold"
  } else if (!hasPrev || !Number.isFinite(candidate)) {
    action = "first-sample-pass"
    reason = "first-sample-pass"
  } else if (holdLeft > 0) {
    outputTarget = prevTarget
    state.holdFramesLeft[key] = holdLeft - 1
    triggered = true
    action = "hold"
    reason = "twitch-hold"
  } else {
    const targetJumpThr = pickRoleMap(cfg.hardTargetJumpThreshold, role) ?? 60
    const controlJumpThr = pickRoleMap(cfg.hardControlJumpThreshold, role) ?? 20
    const isTargetJump = targetJump > targetJumpThr
    const isControlJump = controlJump > controlJumpThr

    if (isTargetJump || isControlJump) {
      outputTarget = prevTarget
      state.holdFramesLeft[key] = Math.max(
        0,
        Math.round(numOr(cfg.holdFramesOnTwitch, 1))
      )
      triggered = true
      action = "hold"
      reason = isTargetJump ? "twitch-target-jump" : "twitch-control-jump"
    } else if (cmd.safety?.limited) {
      // actuator safety 已做 per-send slew，不再 recover 二次限速（否则 brow 30→10 卡顿）
      outputTarget = candidate
      action = "pass"
      reason = "pass-after-safety-slew"
    } else {
      const recoverMax = pickRoleMap(cfg.recoverMaxTargetDelta, role) ?? 12
      const delta = candidate - prevTarget
      const clamped = prevTarget + Math.max(-recoverMax, Math.min(recoverMax, delta))
      if (Math.abs(clamped - candidate) > 1e-6) {
        outputTarget = clamped
        action = "recover-slew"
        reason = "recover-slew"
      }
    }
  }

  const twitchGuard = {
    actuatorKey: key,
    role,
    sourceChannel: cmd.sourceChannel || null,
    candidateControl,
    lastRealSentControl: prevControl,
    controlJump,
    candidateTarget: candidate,
    safetyTargetPosition: safetyTarget,
    lastRealSentTarget: prevTarget,
    targetJump,
    triggered,
    frameSpikeTriggered,
    action,
    reason,
    outputTarget,
  }

  return {
    ...cmd,
    targetPosition: outputTarget,
    candidateTargetPosition: cmd.candidateTargetPosition ?? candidate,
    safetyTargetPosition: safetyTarget,
    twitchGuardTargetPosition: outputTarget,
    twitchGuard,
  }
}

/**
 * @param {object[]} commands bus commands（已过 actuatorSafety）
 * @param {ReturnType<typeof createUpperFaceTwitchGuardState>} state
 * @param {typeof DEFAULT_UPPER_FACE_TWITCH_GUARD} cfg
 */
export function applyUpperFaceTwitchGuardToCommands(
  commands,
  state,
  cfg = DEFAULT_UPPER_FACE_TWITCH_GUARD
) {
  if (!cfg?.enabled || !state) {
    return { commands: commands || [], twitchDebug: [], frameSpikeDebug: null }
  }

  const frameCfg = cfg.upperFaceFrameSpikeGuard || {}
  const frameHoldLeft = Number(state.frameSpikeHoldLeft) || 0
  let frameSpikeTriggered = frameHoldLeft > 0
  if (frameHoldLeft > 0) {
    state.frameSpikeHoldLeft = frameHoldLeft - 1
  }

  const upperEntries = []
  for (let i = 0; i < (commands || []).length; i += 1) {
    const cmd = commands[i]
    const role = inferUpperFaceRole(cmd?.sourceChannel, cmd?.actuatorKey)
    if (!role) continue
    const key = String(cmd.actuatorKey || "")
    const prev = readActuatorState(state, key)
    if (wouldTriggerTwitch(cmd, prev, cfg, role)) {
      upperEntries.push({ index: i, role, cmd })
    }
  }

  if (
    !frameSpikeTriggered &&
    frameCfg.enabled !== false &&
    upperEntries.length >= Math.max(1, Math.round(numOr(frameCfg.spikeCountThreshold, 2)))
  ) {
    frameSpikeTriggered = true
    state.frameSpikeHoldLeft = Math.max(
      0,
      Math.round(numOr(frameCfg.holdFrames, 1))
    )
  }

  const out = []
  const twitchDebug = []

  for (const cmd of commands || []) {
    const role = inferUpperFaceRole(cmd?.sourceChannel, cmd?.actuatorKey)
    if (!role) {
      out.push(cmd)
      continue
    }
    const guarded = guardSingleCommand(cmd, state, cfg, role, frameSpikeTriggered)
    out.push(guarded)
    twitchDebug.push(guarded.twitchGuard)
  }

  return {
    commands: out,
    twitchDebug,
    frameSpikeDebug: {
      triggered: frameSpikeTriggered,
      spikeCount: upperEntries.length,
      holdFramesLeft: state.frameSpikeHoldLeft,
      spikeActuators: upperEntries.map((e) => e.cmd.actuatorKey),
    },
  }
}

/** 真实发送成功后 commit guard state。 */
export function commitUpperFaceTwitchGuardState(state, commands, frameSeq = null) {
  if (!state) return
  for (const cmd of commands || []) {
    const key = String(cmd.actuatorKey || "")
    if (!key || !isUpperFaceCommand(cmd)) continue
    const t = Number(cmd.targetPosition)
    if (!Number.isFinite(t)) continue
    const control = resolveCandidateControl(cmd)
    const prev = readActuatorState(state, key)
    state.actuators[key] = {
      lastRealSentTarget: t,
      lastRealSentControl: control,
      lastSafeTarget: Number(cmd.safetyTargetPosition ?? cmd.safety?.safeTarget ?? t),
      lastSafeControl: control,
      lastRealSentFrameSeq: Number.isFinite(Number(frameSeq)) ? Number(frameSeq) : null,
      lastCandidateTarget: Number(cmd.candidateTargetPosition ?? t),
      lastCandidateControl: control,
      lastTwitchGuardTarget: Number(cmd.twitchGuardTargetPosition ?? t),
    }
    if (!prev) {
      state.actuators[key].firstSample = true
    }
  }
}
