/**
 * Eye XY / sharedRadar 稳定器：中心吸附 + 每帧限速，与眼皮 blink 解耦。
 *
 * V2.3 Vertical Recovery:
 * - Per-axis snap / away-confirm（Y 门槛低于 X，避免 candidateY≈48.2 永久锁死在 50）
 * - 正负方向对称
 * - 不删除抗抖；X 保持既有已验证参数
 */

function numOr(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export const DEFAULT_EYE_XY_STABILIZATION = {
  enabled: true,
  alpha: 0.62,
  maxControlDeltaPerFrame: 18,
  /** Legacy shared snap (fallback). Prefer per-axis. */
  snapToCenterDeadband: 1.2,
  /** X: keep validated horizontal behavior (~escape needs |Δ|≳1.94 from center). */
  snapToCenterDeadbandX: 1.2,
  /**
   * Y: lower snap so sustained |candidate−50|≈1.83 (EYE_VERTICAL min 48.17)
   * can escape after EMA: alpha*1.83≈1.13 > 0.65.
   */
  snapToCenterDeadbandY: 0.65,
  centerLatchEnabled: true,
  /** X 轴暂不吸附中心，避免左右看被拉回 50 */
  centerLatchXEnabled: false,
  /** Y 轴不做中心 latch；靠 per-axis snap + awayConfirm */
  centerLatchYEnabled: false,
  centerEnterThreshold: 2,
  centerExitThreshold: 4.5,
  centerEnterThresholdX: 2,
  centerExitThresholdX: 4.5,
  centerEnterThresholdY: 1.0,
  centerExitThresholdY: 2.5,
  /** Consecutive frames |input−center| >= awayActivate → skip snap (must leave 50). */
  awayConfirmFrames: 3,
  awayActivateThresholdX: 2.0,
  /** From EYE_VERTICAL: negative peak offset 1.83 — activate below that. */
  awayActivateThresholdY: 1.0,
  centerValue: 50,
}

function clampAbs(delta, limit) {
  if (!Number.isFinite(limit) || limit <= 0) return delta
  return Math.max(-limit, Math.min(limit, delta))
}

function ensureState(state) {
  if (!state.eyeXY) {
    state.eyeXY = {
      latched: { x: false, y: false },
      enterCount: { x: 0, y: 0 },
      exitCount: { x: 0, y: 0 },
      awayCount: { x: 0, y: 0 },
      prev: { x: 50, y: 50 },
    }
  }
  if (!state.eyeXY.awayCount) state.eyeXY.awayCount = { x: 0, y: 0 }
  return state.eyeXY
}

function axisSnap(cfg, axis) {
  if (axis === "y") {
    return numOr(cfg.snapToCenterDeadbandY, numOr(cfg.snapToCenterDeadband, 0.65))
  }
  return numOr(cfg.snapToCenterDeadbandX, numOr(cfg.snapToCenterDeadband, 1.2))
}

function axisEnterThr(cfg, axis) {
  if (axis === "y") return numOr(cfg.centerEnterThresholdY, numOr(cfg.centerEnterThreshold, 1))
  return numOr(cfg.centerEnterThresholdX, numOr(cfg.centerEnterThreshold, 2))
}

function axisExitThr(cfg, axis) {
  if (axis === "y") return numOr(cfg.centerExitThresholdY, numOr(cfg.centerExitThreshold, 2.5))
  return numOr(cfg.centerExitThresholdX, numOr(cfg.centerExitThreshold, 4.5))
}

function axisAwayThr(cfg, axis) {
  if (axis === "y") return numOr(cfg.awayActivateThresholdY, 1.0)
  return numOr(cfg.awayActivateThresholdX, 2.0)
}

function applyCenterLatch(value, axis, eyeState, cfg) {
  const latchEnabled =
    axis === "y"
      ? cfg.centerLatchYEnabled === true && cfg.centerLatchEnabled !== false
      : axis === "x"
        ? cfg.centerLatchXEnabled === true && cfg.centerLatchEnabled !== false
        : cfg.centerLatchEnabled !== false
  if (!latchEnabled) {
    return { value, latched: false }
  }
  const center = numOr(cfg.centerValue, 50)
  const enterThr = axisEnterThr(cfg, axis)
  const exitThr = axisExitThr(cfg, axis)
  const dist = Math.abs(value - center)

  if (!eyeState.latched[axis]) {
    if (dist < enterThr) {
      eyeState.enterCount[axis] += 1
      eyeState.exitCount[axis] = 0
    } else {
      eyeState.enterCount[axis] = 0
    }
    if (eyeState.enterCount[axis] >= 2) {
      eyeState.latched[axis] = true
      eyeState.enterCount[axis] = 0
    }
  } else {
    if (dist > exitThr) {
      eyeState.exitCount[axis] += 1
      eyeState.enterCount[axis] = 0
    } else {
      eyeState.exitCount[axis] = 0
    }
    if (eyeState.exitCount[axis] >= 2) {
      eyeState.latched[axis] = false
      eyeState.exitCount[axis] = 0
    }
  }

  return {
    value: eyeState.latched[axis] ? center : value,
    latched: eyeState.latched[axis],
  }
}

function stabilizeAxis(prev, next, axis, eyeState, cfg) {
  const alpha = numOr(cfg.alpha, 0.35)
  const maxDelta = numOr(cfg.maxControlDeltaPerFrame, 6)
  const snap = axisSnap(cfg, axis)
  const center = numOr(cfg.centerValue, 50)
  const awayThr = axisAwayThr(cfg, axis)
  const awayFrames = Math.max(1, Math.trunc(numOr(cfg.awayConfirmFrames, 3)))

  const inputDist = Math.abs(next - center)
  if (inputDist >= awayThr) {
    eyeState.awayCount[axis] += 1
  } else {
    eyeState.awayCount[axis] = 0
  }
  const forceAway = eyeState.awayCount[axis] >= awayFrames

  let target = prev + alpha * (next - prev)
  target = prev + clampAbs(target - prev, maxDelta)

  const zl = applyCenterLatch(target, axis, eyeState, cfg)
  target = zl.value

  let action = "track"
  let snapped = false
  if (!forceAway && Math.abs(target - center) < snap) {
    target = center
    snapped = true
    action = "snap_center"
  } else if (forceAway) {
    action = "force_away"
  } else if (zl.latched) {
    action = "center_latch"
  }

  const stateLabel =
    Math.abs(target - center) < 1e-6 ? "center" : forceAway || !snapped ? "tracking" : "center"

  return {
    value: target,
    latched: zl.latched,
    limited: Math.abs(target - prev) >= maxDelta - 1e-6,
    action,
    state: stateLabel,
    snapped,
    forceAway,
    inputDist,
    snapThreshold: snap,
    activationThreshold: awayThr,
    releaseThreshold: axisExitThr(cfg, axis),
    awayCount: eyeState.awayCount[axis],
  }
}

/**
 * @param {{ x: number, y: number }} prev
 * @param {{ x: number, y: number }} next
 * @param {typeof DEFAULT_EYE_XY_STABILIZATION} cfg
 * @param {object} state tracking calibration state bag
 */
export function stabilizeEyeXY(prev, next, cfg = DEFAULT_EYE_XY_STABILIZATION, state = null) {
  const bag = state || {}
  const eyeState = ensureState(bag)
  const px = numOr(prev?.x, 50)
  const py = numOr(prev?.y, 50)
  const nx = numOr(next?.x, 50)
  const ny = numOr(next?.y, 50)

  if (cfg?.enabled === false) {
    return {
      x: nx,
      y: ny,
      debug: { enabled: false },
    }
  }

  const sx = stabilizeAxis(px, nx, "x", eyeState, cfg)
  const sy = stabilizeAxis(py, ny, "y", eyeState, cfg)

  eyeState.prev = { x: sx.value, y: sy.value }

  return {
    x: sx.value,
    y: sy.value,
    debug: {
      enabled: true,
      raw: { x: nx, y: ny },
      prev: { x: px, y: py },
      input: { x: nx, y: ny },
      output: { x: sx.value, y: sy.value },
      centerLatch: { x: sx.latched, y: sy.latched },
      limited: { x: sx.limited, y: sy.limited },
      state: { x: sx.state, y: sy.state },
      action: { x: sx.action, y: sy.action },
      activationThreshold: { x: sx.activationThreshold, y: sy.activationThreshold },
      releaseThreshold: { x: sx.releaseThreshold, y: sy.releaseThreshold },
      snapThreshold: { x: sx.snapThreshold, y: sy.snapThreshold },
      awayCount: { x: sx.awayCount, y: sy.awayCount },
      // Flat aliases for ai-review / diagnostics
      inputX: nx,
      inputY: ny,
      outputX: sx.value,
      outputY: sy.value,
      stateX: sx.state,
      stateY: sy.state,
      actionX: sx.action,
      actionY: sy.action,
      activationThresholdX: sx.activationThreshold,
      activationThresholdY: sy.activationThreshold,
      releaseThresholdX: sx.releaseThreshold,
      releaseThresholdY: sy.releaseThreshold,
    },
  }
}
