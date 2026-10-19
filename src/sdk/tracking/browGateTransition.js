/**
 * Brow gate 输出过渡：gate action 切换需确认，final 走 ramp 避免硬切。
 */

function numOr(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export const DEFAULT_BROW_GATE_TRANSITION = {
  transitionEnabled: true,
  maxControlDeltaPerFrame: 28,
  suppressReturnDeltaPerFrame: 14,
  passEnterConfirmFrames: 1,
  suppressEnterConfirmFrames: 1,
}

const SUPPRESS_ACTIONS = new Set([
  "lock_zero",
  "lock_zero_artifact",
  "lock_brow_artifact",
  "suppress_mouth",
  "suppress_lip_artifact_weak_brow",
])

const PASS_ACTIONS = new Set(["pass_explicit", "pass_explicit_lip_artifact_override", "normal"])

function ensureState(state) {
  if (!state.browGateTransition) {
    state.browGateTransition = {
      currentAction: "normal",
      pendingAction: null,
      confirmCount: 0,
      rampScale: 1,
    }
  }
  return state.browGateTransition
}

function isSuppressAction(action) {
  return SUPPRESS_ACTIONS.has(String(action || ""))
}

function isPassAction(action) {
  return PASS_ACTIONS.has(String(action || "")) || !isSuppressAction(action)
}

function resolveRampLimit(cfg, gateAction, prevAction) {
  if (isSuppressAction(gateAction) || isSuppressAction(prevAction)) {
    return numOr(cfg.suppressReturnDeltaPerFrame, 6)
  }
  return numOr(cfg.maxControlDeltaPerFrame, 8)
}

function clampChannel(prev, next, limit) {
  const p = Number(prev) || 0
  const n = Number(next) || 0
  const delta = Math.max(-limit, Math.min(limit, n - p))
  return p + delta
}

function rampBrowSide(prevSide, nextSide, limit) {
  return {
    tip: clampChannel(prevSide?.tip, nextSide?.tip, limit),
    mid: clampChannel(prevSide?.mid, nextSide?.mid, limit),
    tail: clampChannel(prevSide?.tail, nextSide?.tail, limit),
  }
}

/**
 * @param {object} prevRig
 * @param {object} nextRig gated rig from mapper
 * @param {object} gateDebug frame.debug.browGate
 * @param {object} state cal.eyeState or cal.browGateState bag
 * @param {typeof DEFAULT_BROW_GATE_TRANSITION} cfg
 */
export function applyBrowGateTransition(prevRig, nextRig, gateDebug, state, cfg = DEFAULT_BROW_GATE_TRANSITION) {
  if (cfg?.transitionEnabled === false || !nextRig) {
    return { rig: nextRig, debug: { enabled: false } }
  }

  const bag = ensureState(state || {})
  const gateAction = String(gateDebug?.gateAction || "normal")
  const prevAction = bag.currentAction

  let confirmNeeded = 0
  if (isPassAction(gateAction) && isSuppressAction(prevAction)) {
    confirmNeeded = Math.max(1, Math.round(numOr(cfg.passEnterConfirmFrames, 2)))
  } else if (isSuppressAction(gateAction) && isPassAction(prevAction)) {
    confirmNeeded = Math.max(1, Math.round(numOr(cfg.suppressEnterConfirmFrames, 2)))
  }

  let actionStable = gateAction === prevAction
  if (!actionStable) {
    if (bag.pendingAction !== gateAction) {
      bag.pendingAction = gateAction
      bag.confirmCount = 1
    } else {
      bag.confirmCount += 1
    }
    actionStable = bag.confirmCount >= confirmNeeded
  } else {
    bag.pendingAction = null
    bag.confirmCount = 0
    bag.currentAction = gateAction
  }

  const baseLimit = resolveRampLimit(cfg, gateAction, prevAction)
  const rampLimit = actionStable
    ? baseLimit
    : Math.max(2, baseLimit * (bag.confirmCount / Math.max(1, confirmNeeded || 1)))

  const prevL = prevRig?.browL || { tip: 0, mid: 0, tail: 0 }
  const prevR = prevRig?.browR || { tip: 0, mid: 0, tail: 0 }
  const nextL = nextRig?.browL || { tip: 0, mid: 0, tail: 0 }
  const nextR = nextRig?.browR || { tip: 0, mid: 0, tail: 0 }

  const blendedL = rampBrowSide(prevL, nextL, rampLimit)
  const blendedR = rampBrowSide(prevR, nextR, rampLimit)

  if (actionStable) {
    bag.currentAction = gateAction
  }

  return {
    rig: {
      ...nextRig,
      browL: blendedL,
      browR: blendedR,
    },
    debug: {
      enabled: true,
      gateAction,
      prevAction,
      pendingAction: bag.pendingAction,
      confirmCount: bag.confirmCount,
      confirmNeeded,
      actionStable,
      rampLimit,
    },
  }
}
