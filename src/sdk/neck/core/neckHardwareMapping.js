/**
 * q → module degrees / signed raw — port of Luvia kinematics_hardware_mapper.map_qs.
 */

export function roundHalfUpSigned(x) {
  const v = Number(x)
  if (v >= 0) return Math.floor(v + 0.5)
  return Math.ceil(v - 0.5)
}

export function signedRawFromCommandDeg(commandDeg) {
  const raw = roundHalfUpSigned((Number(commandDeg) / 360) * 1000)
  return raw === 0 ? 0 : raw
}

export function commandFromQ(qDeg, sign) {
  return Number(sign) * Number(qDeg)
}

export function moduleFromQAndOffset(qDeg, sign, offsetDeg) {
  return Number(offsetDeg) + Number(sign) * Number(qDeg)
}

function isFiniteNumber(v) {
  return Number.isFinite(Number(v))
}

function rejectMapped(partial, reason) {
  return {
    pitchDeg: Number(partial.pitchDeg),
    rollDeg: Number(partial.rollDeg),
    q1Deg: Number(partial.q1Deg),
    q2Deg: Number(partial.q2Deg),
    side1MotorId: Number(partial.side1MotorId || 0),
    side2MotorId: Number(partial.side2MotorId || 0),
    sign1: Number(partial.sign1 || 0),
    sign2: Number(partial.sign2 || 0),
    module1Deg: 0,
    module2Deg: 0,
    raw1: 0,
    raw2: 0,
    id1RelativeDeg: 0,
    id2RelativeDeg: 0,
    side1OffsetDeg: 0,
    side2OffsetDeg: 0,
    valid: false,
    rejectReason: reason,
    yawDeg: Number(partial.yawDeg || 0),
    q3Deg: Number(partial.yawDeg || 0),
    module3Deg: 0,
    raw3: 0,
    yawMotorId: Number(partial.yawMotorId || 0),
    yawSign: Number(partial.yawSign || 0),
    motorIds: { id1: 1, id2: 2, id3: 3 },
    moduleDeg: { id1: 0, id2: 0, id3: 0 },
    raw: { id1: 0, id2: 0, id3: 0 },
  }
}

/**
 * Map kinematic qs using profile.mapping.
 * Motor ordering: ID1 = side2, ID2 = side1, yaw ID3.
 */
export function mapQs({
  pitchDeg,
  rollDeg,
  q1Deg,
  q2Deg,
  yawDeg = 0,
  mapping,
  yawEnabled,
  yawSign,
  yawMin,
  yawMax,
} = {}) {
  const map = mapping || {}
  const s1 = map.side1 || {}
  const s2 = map.side2 || {}
  const yaw = map.yaw || {}
  const lim = map.limits || {}
  const yawOn = yawEnabled != null ? Boolean(yawEnabled) : yaw.enabled !== false
  const ySign =
    yawSign != null ? Math.trunc(Number(yawSign)) : Math.trunc(Number(yaw.qToModuleSign ?? 1))
  const yMin = yawMin != null ? Number(yawMin) : Number(yaw.minDeg ?? -90)
  const yMax = yawMax != null ? Number(yawMax) : Number(yaw.maxDeg ?? 90)

  const base = {
    pitchDeg,
    rollDeg,
    q1Deg,
    q2Deg,
    yawDeg,
    side1MotorId: s1.motorId,
    side2MotorId: s2.motorId,
    sign1: s1.qToModuleSign,
    sign2: s2.qToModuleSign,
    yawMotorId: yaw.motorId || 3,
    yawSign: ySign,
  }

  const vals = [pitchDeg, rollDeg, q1Deg, q2Deg, yawDeg]
  if (vals.some((v) => !isFiniteNumber(v))) {
    return rejectMapped(base, "NON_FINITE_TARGET")
  }

  const mid1 = Math.trunc(Number(s1.motorId))
  const mid2 = Math.trunc(Number(s2.motorId))
  const sign1 = Math.trunc(Number(s1.qToModuleSign))
  const sign2 = Math.trunc(Number(s2.qToModuleSign))
  const mappingComplete =
    (mid1 === 1 || mid1 === 2) &&
    (mid2 === 1 || mid2 === 2) &&
    (sign1 === -1 || sign1 === 1) &&
    (sign2 === -1 || sign2 === 1) &&
    mid1 !== mid2
  if (!mappingComplete) return rejectMapped(base, "MAPPING_INCOMPLETE")

  const jointAbs = Number(lim.jointAbsDeg ?? 20)
  if (Math.abs(q1Deg) > jointAbs + 1e-9 || Math.abs(q2Deg) > jointAbs + 1e-9) {
    return rejectMapped(base, "JOINT_LIMIT_REJECTED")
  }

  const off1 = Number(s1.offsetDeg ?? 0)
  const off2 = Number(s2.offsetDeg ?? 0)
  const dqS1 = commandFromQ(q1Deg, sign1)
  const dqS2 = commandFromQ(q2Deg, sign2)
  const cmdS1 = moduleFromQAndOffset(q1Deg, sign1, off1)
  const cmdS2 = moduleFromQAndOffset(q2Deg, sign2, off2)

  const relAbs = Number(lim.relativeModuleAbsDeg ?? 20)
  if (Math.abs(dqS1) > relAbs + 1e-9 || Math.abs(dqS2) > relAbs + 1e-9) {
    return rejectMapped(base, "RELATIVE_MODULE_LIMIT_REJECTED")
  }

  const outerAbs = relAbs + Number(lim.neutralOffsetAbsDeg ?? 30)
  for (const cmd of [cmdS1, cmdS2]) {
    if (!isFiniteNumber(cmd)) return rejectMapped(base, "NON_FINITE_TARGET")
    if (Math.abs(cmd) > outerAbs + 1e-9) return rejectMapped(base, "MODULE_LIMIT_REJECTED")
  }

  const byMotor = { [mid1]: cmdS1, [mid2]: cmdS2 }
  if (!(1 in byMotor) || !(2 in byMotor)) {
    return rejectMapped(base, "MOTOR_ID_PAIR_INVALID")
  }

  const m1 = Number(byMotor[1])
  const m2 = Number(byMotor[2])
  const r1 = signedRawFromCommandDeg(m1)
  const r2 = signedRawFromCommandDeg(m2)
  const rawOuter = Math.abs(signedRawFromCommandDeg(outerAbs))
  if (!(r1 >= -rawOuter && r1 <= rawOuter && r2 >= -rawOuter && r2 <= rawOuter)) {
    return rejectMapped(base, "RAW_LIMIT_REJECTED")
  }

  let yawF = Number(yawDeg)
  let q3 = 0
  let m3 = 0
  let r3 = 0
  let yawMid = 0
  let yawSgn = 0
  if (yawOn) {
    yawMid = Math.trunc(Number(yaw.motorId ?? 3))
    yawSgn = ySign
    if (yawSgn !== -1 && yawSgn !== 1) yawSgn = Math.trunc(Number(yaw.qToModuleSign ?? 1))
    if (yawF < yMin - 1e-9 || yawF > yMax + 1e-9) {
      return rejectMapped(
        { ...base, yawDeg: yawF, yawMotorId: yawMid, yawSign: yawSgn },
        "YAW_LIMIT_REJECTED"
      )
    }
    q3 = yawF
    m3 = yawSgn * yawF
    r3 = signedRawFromCommandDeg(m3)
  }

  return {
    pitchDeg: Number(pitchDeg),
    rollDeg: Number(rollDeg),
    q1Deg: Number(q1Deg),
    q2Deg: Number(q2Deg),
    side1MotorId: mid1,
    side2MotorId: mid2,
    sign1,
    sign2,
    module1Deg: m1,
    module2Deg: m2,
    raw1: r1,
    raw2: r2,
    id1RelativeDeg: m1 - off2,
    id2RelativeDeg: m2 - off1,
    side1OffsetDeg: off1,
    side2OffsetDeg: off2,
    valid: true,
    rejectReason: "",
    yawDeg: yawOn ? yawF : 0,
    q3Deg: Number(q3),
    module3Deg: Number(m3),
    raw3: Number(r3),
    yawMotorId: yawOn ? yawMid : 0,
    yawSign: yawOn ? yawSgn : 0,
    motorIds: { id1: 1, id2: 2, id3: yawOn ? yawMid || 3 : 3 },
    moduleDeg: { id1: m1, id2: m2, id3: m3 },
    raw: { id1: r1, id2: r2, id3: r3 },
  }
}
