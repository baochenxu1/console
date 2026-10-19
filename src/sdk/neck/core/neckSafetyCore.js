/**
 * Pure safety validation + JointSafetyLimiter — port of Luvia safety_limiter.py.
 */

/**
 * Validate finite / joint / yaw against profile (pre- or post-IK).
 */
export function validateNeckPlanInputs({ pose, joints, profile, mapped } = {}) {
  const reasons = []
  const p = pose || {}
  for (const axis of ["pitch", "roll", "yaw"]) {
    if (!Number.isFinite(Number(p[axis]))) reasons.push("NON_FINITE_TARGET")
  }
  if (joints) {
    const lim = profile?.mapping?.limits?.jointAbsDeg ?? 20
    if (Math.abs(Number(joints.q1)) > lim + 1e-9 || Math.abs(Number(joints.q2)) > lim + 1e-9) {
      reasons.push("JOINT_LIMIT_REJECTED")
    }
  }
  if (mapped && mapped.valid === false && mapped.rejectReason) {
    reasons.push(mapped.rejectReason)
  }
  const yaw = profile?.mapping?.yaw
  if (yaw?.enabled !== false && pose) {
    const y = Number(pose.yaw)
    if (y < Number(yaw.minDeg) - 1e-9 || y > Number(yaw.maxDeg) + 1e-9) {
      reasons.push("YAW_LIMIT_REJECTED")
    }
  }
  return {
    ok: reasons.length === 0,
    reason: reasons[0] || "",
    reasons,
  }
}

export function createSafetyLimiterState({ q1 = 0, q2 = 0, q3 = 0, v1 = 0, v2 = 0, v3 = 0, initialized = false } = {}) {
  return {
    q1: Number(q1),
    q2: Number(q2),
    q3: Number(q3),
    v1: Number(v1),
    v2: Number(v2),
    v3: Number(v3),
    initialized: Boolean(initialized),
  }
}

function axisStep(q, v, desired, dt, vmax, amax) {
  const remaining = Number(desired) - Number(q)
  if (Math.abs(remaining) <= 1e-12 && Math.abs(v) <= 1e-9) {
    return { q: Number(desired), v: 0, limited: false, reason: "" }
  }
  let vCmd = remaining / dt
  let limited = false
  let reason = ""
  if (vmax > 0 && Math.abs(vCmd) > vmax + 1e-12) {
    vCmd = vCmd > 0 ? vmax : -vmax
    limited = true
    reason = "VELOCITY_CEILING"
  }
  if (amax > 0) {
    const dvMax = amax * dt
    const dv = vCmd - v
    if (Math.abs(dv) > dvMax + 1e-12) {
      vCmd = v + (dv > 0 ? dvMax : -dvMax)
      limited = true
      reason = "ACCELERATION_CEILING"
    }
  }
  let qNew = q + vCmd * dt
  if ((remaining > 0 && qNew > desired) || (remaining < 0 && qNew < desired)) {
    qNew = Number(desired)
    vCmd = 0
  }
  return { q: qNew, v: vCmd, limited, reason }
}

/**
 * Stateless-friendly step matching JointSafetyLimiter.step.
 * @param {{ target: {q1,q2,q3}, previousState, dt?, maxVelocityDegS?, maxAccelerationDegS2?, periodS? }} args
 */
export function jointSafetyLimiterStep({
  target,
  previousState,
  dt = null,
  maxVelocityDegS = 85,
  maxAccelerationDegS2 = 400,
  periodS = 0.01,
} = {}) {
  const vmax = Math.max(0, Number(maxVelocityDegS))
  const amax = Math.max(0, Number(maxAccelerationDegS2))
  const period = Math.max(1e-4, Number(periodS))
  const useDt = dt == null ? period : Math.max(1e-4, Math.min(Number(dt), 0.05))
  const desired = {
    q1: Number(target?.q1 ?? 0),
    q2: Number(target?.q2 ?? 0),
    q3: Number(target?.q3 ?? 0),
  }
  let state = previousState ? { ...previousState } : createSafetyLimiterState()

  if (!state.initialized) {
    state = createSafetyLimiterState({
      q1: desired.q1,
      q2: desired.q2,
      q3: desired.q3,
      initialized: true,
    })
    return {
      safeTarget: { q1: state.q1, q2: state.q2, q3: state.q3 },
      nextState: state,
      limited: false,
      reason: "",
      velocities: { v1: 0, v2: 0, v3: 0 },
    }
  }

  const a1 = axisStep(state.q1, state.v1, desired.q1, useDt, vmax, amax)
  const a2 = axisStep(state.q2, state.v2, desired.q2, useDt, vmax, amax)
  const a3 = axisStep(state.q3, state.v3, desired.q3, useDt, vmax, amax)
  const nextState = createSafetyLimiterState({
    q1: a1.q,
    q2: a2.q,
    q3: a3.q,
    v1: a1.v,
    v2: a2.v,
    v3: a3.v,
    initialized: true,
  })
  const limited = Boolean(a1.limited || a2.limited || a3.limited)
  const reason = a1.reason || a2.reason || a3.reason
  return {
    safeTarget: { q1: nextState.q1, q2: nextState.q2, q3: nextState.q3 },
    nextState,
    limited,
    reason,
    velocities: { v1: nextState.v1, v2: nextState.v2, v3: nextState.v3 },
  }
}
