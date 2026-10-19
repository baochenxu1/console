/**
 * Mouth scenario 切换过渡：Python gate 已做 ramp，JS 侧再对 rig.mouth 四通道做兜底 slew。
 */

function numOr(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export const DEFAULT_MOUTH_SCENARIO_TRANSITION = {
  transitionEnabled: true,
  /** 正常帧 per-channel slew */
  maxDeltaPerFrame: 26,
  /** scenario 切换后若干帧内的更严 slew */
  scenarioChangeDeltaPerFrame: 14,
  scenarioChangeHoldFrames: 10,
}

const MOUTH_KEYS = ["UL", "UR", "LL", "LR"]

function ensureState(state) {
  if (!state.mouthScenarioTransition) {
    state.mouthScenarioTransition = {
      currentScenario: null,
      holdFramesRemaining: 0,
    }
  }
  return state.mouthScenarioTransition
}

function clampChannel(prev, next, limit) {
  const p = Number(prev) || 0
  const n = Number(next) || 0
  const delta = Math.max(-limit, Math.min(limit, n - p))
  return p + delta
}

function resolveScenario(debug) {
  return (
    debug?.mouthScenarioClassifier?.finalScenario ||
    debug?.lipGeometry?.gateDecision?.finalScenario ||
    debug?.mouthScenario?.finalScenario ||
    null
  )
}

/**
 * @param {object} prevRig
 * @param {object} nextRig
 * @param {object} debug frame.debug
 * @param {object} state cal.eyeState or cal bag
 * @param {typeof DEFAULT_MOUTH_SCENARIO_TRANSITION} cfg
 */
export function applyMouthScenarioTransition(prevRig, nextRig, debug, state, cfg = DEFAULT_MOUTH_SCENARIO_TRANSITION) {
  if (cfg?.transitionEnabled === false || !nextRig?.mouth) {
    return { rig: nextRig, debug: { enabled: false } }
  }

  const scenario = resolveScenario(debug)
  const bag = ensureState(state || {})
  const prevScenario = bag.currentScenario
  let holdRemaining = Number(bag.holdFramesRemaining) || 0

  if (scenario && scenario !== prevScenario) {
    bag.currentScenario = scenario
    holdRemaining = Math.max(1, Math.round(numOr(cfg.scenarioChangeHoldFrames, 10)))
    bag.holdFramesRemaining = holdRemaining
  } else if (holdRemaining > 0) {
    holdRemaining -= 1
    bag.holdFramesRemaining = holdRemaining
  }

  const limit =
    holdRemaining > 0
      ? numOr(cfg.scenarioChangeDeltaPerFrame, 14)
      : numOr(cfg.maxDeltaPerFrame, 26)

  const prevMouth = prevRig?.mouth || {}
  const nextMouth = nextRig.mouth
  const mouth = { ...nextMouth }

  for (const k of MOUTH_KEYS) {
    mouth[k] = clampChannel(prevMouth[k], nextMouth[k], limit)
  }

  return {
    rig: { ...nextRig, mouth },
    debug: {
      enabled: true,
      scenario: scenario || prevScenario,
      prevScenario,
      holdFramesRemaining: holdRemaining,
      rampLimit: limit,
    },
  }
}
