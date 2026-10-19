/**
 * planNeckPose — deterministic Pose → execution plan (no I/O / hardware).
 */

import { normalizeNeckPose } from "../neckPose.js"
import { createLuviaReferenceProfile, geometryFromProfile, normalizeNeckRuntimeProfile } from "./neckRuntimeProfile.js"
import { solveIk } from "./neckKinematics.js"
import { mapQs } from "./neckHardwareMapping.js"
import {
  createSafetyLimiterState,
  jointSafetyLimiterStep,
  validateNeckPlanInputs,
} from "./neckSafetyCore.js"

export function createNeckPlannerState({
  q1 = 0,
  q2 = 0,
  q3 = 0,
  v1 = 0,
  v2 = 0,
  v3 = 0,
  pitch = 0,
  roll = 0,
  yaw = 0,
  safetyInitialized = false,
} = {}) {
  return {
    q1: Number(q1),
    q2: Number(q2),
    q3: Number(q3),
    v1: Number(v1),
    v2: Number(v2),
    v3: Number(v3),
    pitch: Number(pitch),
    roll: Number(roll),
    yaw: Number(yaw),
    safety: createSafetyLimiterState({
      q1,
      q2,
      q3,
      v1,
      v2,
      v3,
      initialized: safetyInitialized,
    }),
  }
}

function rejectPlan({ semanticPose, previousState, reason, diagnostics = {} }) {
  return {
    accepted: false,
    rejectReason: reason,
    semanticPose,
    joints: { q1: previousState?.q1 ?? 0, q2: previousState?.q2 ?? 0, q3: previousState?.q3 ?? 0 },
    motorTargets: {
      moduleDeg: { id1: 0, id2: 0, id3: 0 },
      raw: { id1: 0, id2: 0, id3: 0 },
      motorIds: { id1: 1, id2: 2, id3: 3 },
    },
    diagnostics: { ...diagnostics, accepted: false, rejectReason: reason },
    nextState: previousState || createNeckPlannerState(),
  }
}

/**
 * @param {{ pose: object, profile?: object, previousState?: object, applySafetyLimiter?: boolean, dt?: number }} args
 */
export function planNeckPose({
  pose,
  profile = null,
  previousState = null,
  applySafetyLimiter = true,
  dt = null,
} = {}) {
  const prof = normalizeNeckRuntimeProfile(profile || createLuviaReferenceProfile())
  const prev = previousState || createNeckPlannerState()
  const semanticPose = normalizeNeckPose(pose, { clamp: false })

  if (
    !Number.isFinite(semanticPose.pitch) ||
    !Number.isFinite(semanticPose.roll) ||
    !Number.isFinite(semanticPose.yaw)
  ) {
    return rejectPlan({ semanticPose, previousState: prev, reason: "NON_FINITE_TARGET" })
  }

  const geom = geometryFromProfile(prof)
  const ik = solveIk(geom, {
    pitchDeg: semanticPose.pitch,
    rollDeg: semanticPose.roll,
    previousQ1Deg: prev.q1,
    previousQ2Deg: prev.q2,
  })

  if (!ik.valid) {
    return rejectPlan({
      semanticPose,
      previousState: prev,
      reason: ik.rejectReason || "IK_INVALID",
      diagnostics: {
        ik,
        branch: ik.branch,
        closureErrorMm: ik.closureErrorMm,
      },
    })
  }

  const mapped = mapQs({
    pitchDeg: semanticPose.pitch,
    rollDeg: semanticPose.roll,
    q1Deg: ik.q1Deg,
    q2Deg: ik.q2Deg,
    yawDeg: semanticPose.yaw,
    mapping: prof.mapping,
  })

  if (!mapped.valid) {
    return rejectPlan({
      semanticPose,
      previousState: prev,
      reason: mapped.rejectReason || "MAP_REJECTED",
      diagnostics: {
        ik,
        mapped,
        branch: ik.branch,
        closureErrorMm: ik.closureErrorMm,
      },
    })
  }

  const desiredJoints = {
    q1: ik.q1Deg,
    q2: ik.q2Deg,
    q3: mapped.q3Deg,
  }

  let safetyResult = null
  let nextJoints = desiredJoints
  if (applySafetyLimiter) {
    safetyResult = jointSafetyLimiterStep({
      target: desiredJoints,
      previousState: prev.safety,
      dt,
      maxVelocityDegS: prof.safety.maxVelocityDegS,
      maxAccelerationDegS2: prof.safety.maxAccelerationDegS2,
      periodS: prof.safety.periodS,
    })
    nextJoints = safetyResult.safeTarget
  } else {
    safetyResult = {
      safeTarget: desiredJoints,
      nextState: createSafetyLimiterState({ ...desiredJoints, initialized: true }),
      limited: false,
      reason: "",
    }
  }

  const gate = validateNeckPlanInputs({
    pose: semanticPose,
    joints: desiredJoints,
    profile: prof,
    mapped,
  })

  const nextState = createNeckPlannerState({
    q1: nextJoints.q1,
    q2: nextJoints.q2,
    q3: nextJoints.q3,
    v1: safetyResult.nextState.v1,
    v2: safetyResult.nextState.v2,
    v3: safetyResult.nextState.v3,
    pitch: semanticPose.pitch,
    roll: semanticPose.roll,
    yaw: semanticPose.yaw,
    safetyInitialized: true,
  })
  nextState.safety = safetyResult.nextState

  return {
    accepted: true,
    rejectReason: "",
    semanticPose,
    joints: desiredJoints,
    motorTargets: {
      moduleDeg: { ...mapped.moduleDeg },
      raw: { ...mapped.raw },
      motorIds: { ...mapped.motorIds },
      side1OffsetDeg: mapped.side1OffsetDeg,
      side2OffsetDeg: mapped.side2OffsetDeg,
      signs: { side1: mapped.sign1, side2: mapped.sign2, yaw: mapped.yawSign },
    },
    diagnostics: {
      accepted: true,
      ik,
      mapped,
      branch: ik.branch,
      closureErrorMm: ik.closureErrorMm,
      safetyLimited: Boolean(safetyResult.limited),
      safetyLimitReason: safetyResult.reason || "",
      safeJoints: nextJoints,
      validate: gate,
    },
    nextState,
  }
}
