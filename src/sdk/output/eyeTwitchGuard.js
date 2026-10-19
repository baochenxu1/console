/**
 * @deprecated 使用 upperFaceTwitchGuard；保留兼容导出。
 */

import {
  applyUpperFaceTwitchGuardToCommands,
  commitUpperFaceTwitchGuardState,
  createUpperFaceTwitchGuardState,
  DEFAULT_UPPER_FACE_TWITCH_GUARD,
} from "./upperFaceTwitchGuard.js"

export const DEFAULT_EYE_TWITCH_GUARD = {
  ...DEFAULT_UPPER_FACE_TWITCH_GUARD,
  hardTargetJumpThreshold: DEFAULT_UPPER_FACE_TWITCH_GUARD.hardTargetJumpThreshold.eyelid,
  hardControlJumpThreshold: DEFAULT_UPPER_FACE_TWITCH_GUARD.hardControlJumpThreshold.eyelid,
  recoverMaxTargetDelta: DEFAULT_UPPER_FACE_TWITCH_GUARD.recoverMaxTargetDelta.eyelid,
}

export function createEyeTwitchGuardState() {
  return createUpperFaceTwitchGuardState()
}

export function applyEyeTwitchGuardToCommands(commands, state, cfg = DEFAULT_EYE_TWITCH_GUARD) {
  const merged = {
    ...DEFAULT_UPPER_FACE_TWITCH_GUARD,
    ...cfg,
    hardTargetJumpThreshold: {
      ...DEFAULT_UPPER_FACE_TWITCH_GUARD.hardTargetJumpThreshold,
      ...(typeof cfg?.hardTargetJumpThreshold === "object"
        ? cfg.hardTargetJumpThreshold
        : Number.isFinite(Number(cfg?.hardTargetJumpThreshold))
          ? { eyelid: Number(cfg.hardTargetJumpThreshold) }
          : {}),
    },
    hardControlJumpThreshold: {
      ...DEFAULT_UPPER_FACE_TWITCH_GUARD.hardControlJumpThreshold,
      ...(typeof cfg?.hardControlJumpThreshold === "object"
        ? cfg.hardControlJumpThreshold
        : Number.isFinite(Number(cfg?.hardControlJumpThreshold))
          ? { eyelid: Number(cfg.hardControlJumpThreshold) }
          : {}),
    },
    recoverMaxTargetDelta: {
      ...DEFAULT_UPPER_FACE_TWITCH_GUARD.recoverMaxTargetDelta,
      ...(typeof cfg?.recoverMaxTargetDelta === "object"
        ? cfg.recoverMaxTargetDelta
        : Number.isFinite(Number(cfg?.recoverMaxTargetDelta))
          ? { eyelid: Number(cfg.recoverMaxTargetDelta) }
          : {}),
    },
  }
  const result = applyUpperFaceTwitchGuardToCommands(commands, state, merged)
  return {
    commands: result.commands,
    twitchDebug: result.twitchDebug,
    frameSpikeDebug: result.frameSpikeDebug,
  }
}

export function commitEyeTwitchGuardState(state, commands, frameSeq = null) {
  commitUpperFaceTwitchGuardState(state, commands, frameSeq)
}
