/**
 * NeckRuntimeProfile — browser-native geometry/mapping/safety snapshot.
 * Embeds validated Luvia neck_geometry + kinematics_hardware_mapping + motion ceilings.
 * R2.1 additive: motorProtocol + transport (defaults migrate old profiles → bm-hmd + FD Luvia).
 */

export const NECK_RUNTIME_PROFILE_VERSION = "facedev-neck-runtime-profile-v1"
export const DEFAULT_MOTOR_PROTOCOL_TYPE = "bm-hmd"
export const DEFAULT_MOTOR_PROTOCOL_VERSION = "bm-hmd-luvia-v1"

const DEFAULT_TRANSPORT = Object.freeze({
  type: "slcan",
  can: Object.freeze({
    mode: "fd",
    arbitrationBitrate: 1_000_000,
    dataBitrate: 5_000_000,
    brs: false,
  }),
})

const LUVIA_SIDE_1 = Object.freeze({
  a0Mm: Object.freeze([49.71, 20.0, 17.23]),
  oMm: Object.freeze([38.1, 60.0, -113.5]),
  n: Object.freeze([1.0, 0.0, 0.0]),
  b0Mm: Object.freeze([55.0, 20.1273820135, -110.310276673]),
  linkLengthMm: 127.65,
})

const LUVIA_SIDE_2 = Object.freeze({
  a0Mm: Object.freeze([49.71, -20.0, 17.23]),
  oMm: Object.freeze([38.1, -60.0, -113.5]),
  n: Object.freeze([-1.0, 0.0, 0.0]),
  b0Mm: Object.freeze([55.0, -20.1273820135, -110.310276673]),
  linkLengthMm: 127.65,
})

function cloneSide(side) {
  return {
    a0Mm: [...(side?.a0Mm || [0, 0, 0])].map(Number),
    oMm: [...(side?.oMm || [0, 0, 0])].map(Number),
    n: [...(side?.n || [1, 0, 0])].map(Number),
    b0Mm: [...(side?.b0Mm || [0, 0, 0])].map(Number),
    linkLengthMm: Number(side?.linkLengthMm),
  }
}

function num(v, fallback = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Canonical Luvia reference profile (validated geometry + frozen mapping + safety vmax/amax).
 */
export function createLuviaReferenceProfile(overrides = {}) {
  const base = {
    version: NECK_RUNTIME_PROFILE_VERSION,
    name: "luvia-reference",
    semantic: {
      units: "deg",
      pitchPositive: "NOSE_DOWN",
      rollPositive: "HEAD_TILT_RIGHT",
      yawPositive: "HEAD_TURN_LEFT",
      pitch: { min: -10, max: 10 },
      roll: { min: -15, max: 15 },
      yaw: { min: -90, max: 90 },
    },
    geometry: {
      status: "VALIDATED",
      mathematicalStatus: "VALIDATED",
      physicalStatus: "NOT_CAD_VERIFIED",
      frame: "BASE",
      units: "mm",
      originMm: [0, 0, 0],
      side1: cloneSide(LUVIA_SIDE_1),
      side2: cloneSide(LUVIA_SIDE_2),
    },
    mapping: {
      side1: { motorId: 2, qToModuleSign: -1, offsetDeg: 0 },
      side2: { motorId: 1, qToModuleSign: 1, offsetDeg: 0 },
      yaw: {
        motorId: 3,
        qToModuleSign: 1,
        neutralDeg: 0,
        minDeg: -90,
        maxDeg: 90,
        enabled: true,
      },
      limits: {
        poseAbsDeg: 20,
        jointAbsDeg: 20,
        relativeModuleAbsDeg: 20,
        globalModuleMinDeg: -40,
        globalModuleMaxDeg: 40,
        neutralOffsetAbsDeg: 30,
        uiPitchAbsDeg: 10,
        uiRollAbsDeg: 15,
      },
    },
    safety: {
      maxVelocityDegS: 85,
      maxAccelerationDegS2: 400,
      periodS: 0.01,
    },
    kinematics: {
      attitude: "R_BH = Rx(roll) @ Ry(pitch)",
      branchRule: "nearest_continuous",
      selectNearestUsesAbs: true,
      closureTolMm: 0.1,
      qDefinition: "q_new_zero_is_mechanical_closure",
    },
    motorProtocol: {
      type: DEFAULT_MOTOR_PROTOCOL_TYPE,
      version: DEFAULT_MOTOR_PROTOCOL_VERSION,
    },
    transport: {
      type: DEFAULT_TRANSPORT.type,
      can: { ...DEFAULT_TRANSPORT.can },
    },
    // R4.1: optional metadata only — not used in mapping math
    calibration: null,
  }
  return normalizeNeckRuntimeProfile({
    ...base,
    ...overrides,
    geometry: { ...base.geometry, ...(overrides.geometry || {}) },
    mapping: deepMerge(base.mapping, overrides.mapping),
    safety: { ...base.safety, ...(overrides.safety || {}) },
    semantic: deepMerge(base.semantic, overrides.semantic),
    motorProtocol: deepMerge(base.motorProtocol, overrides.motorProtocol),
    transport: deepMerge(base.transport, overrides.transport),
    calibration:
      overrides.calibration !== undefined ? overrides.calibration : base.calibration,
  })
}

/**
 * Optional calibration metadata (software-installation-neutral).
 * Never participates in moduleFromQAndOffset / mapQs math.
 */
function normalizeCalibration(raw) {
  if (raw == null || raw === false) return null
  if (typeof raw !== "object") return null
  const type = String(raw.type || "software-installation-neutral")
  return {
    type,
    calibratedAt: raw.calibratedAt != null ? String(raw.calibratedAt) : null,
    status: raw.status != null ? String(raw.status) : null,
  }
}

function normalizeMotorProtocol(raw) {
  const src = raw && typeof raw === "object" ? raw : {}
  return {
    type: String(src.type || DEFAULT_MOTOR_PROTOCOL_TYPE),
    version: String(src.version || DEFAULT_MOTOR_PROTOCOL_VERSION),
  }
}

function normalizeTransport(raw) {
  const src = raw && typeof raw === "object" ? raw : {}
  if (src.can && typeof src.can === "object") {
    const mode = String(src.can.mode || "fd")
    return {
      type: String(src.type || "slcan"),
      can: {
        mode,
        arbitrationBitrate: num(src.can.arbitrationBitrate, 1_000_000),
        dataBitrate:
          mode === "classic"
            ? src.can.dataBitrate == null
              ? null
              : num(src.can.dataBitrate, 5_000_000)
            : num(src.can.dataBitrate, 5_000_000),
        brs: Boolean(src.can.brs),
      },
    }
  }
  // Migrate flat / missing transport → Luvia FD defaults
  const mode = src.canFd === false ? "classic" : "fd"
  return {
    type: String(src.type || DEFAULT_TRANSPORT.type),
    can: {
      mode,
      arbitrationBitrate: num(src.arbitrationBitrate, DEFAULT_TRANSPORT.can.arbitrationBitrate),
      dataBitrate:
        mode === "classic"
          ? null
          : num(src.dataBitrate, DEFAULT_TRANSPORT.can.dataBitrate),
      brs: Boolean(src.brs),
    },
  }
}

function deepMerge(a, b) {
  if (!b || typeof b !== "object") return { ...a }
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" && !Array.isArray(a[k])) {
      out[k] = deepMerge(a[k], v)
    } else {
      out[k] = v
    }
  }
  return out
}

/**
 * Normalize / import a profile object (pure).
 */
export function normalizeNeckRuntimeProfile(raw) {
  const src = raw && typeof raw === "object" ? raw : {}
  const geom = src.geometry || {}
  const map = src.mapping || {}
  const s1 = map.side1 || map.side_1 || {}
  const s2 = map.side2 || map.side_2 || {}
  const yaw = map.yaw || {}
  const lim = map.limits || {}
  const sem = src.semantic || {}
  const safety = src.safety || {}

  const side1Geom = geom.side1 || geom.side_1 || LUVIA_SIDE_1
  const side2Geom = geom.side2 || geom.side_2 || LUVIA_SIDE_2

  return {
    version: String(src.version || NECK_RUNTIME_PROFILE_VERSION),
    name: String(src.name || "neck-runtime-profile"),
    semantic: {
      units: String(sem.units || "deg"),
      pitchPositive: String(sem.pitchPositive || sem.pitch_positive || "NOSE_DOWN"),
      rollPositive: String(sem.rollPositive || sem.roll_positive || "HEAD_TILT_RIGHT"),
      yawPositive: String(sem.yawPositive || sem.yaw_positive || "HEAD_TURN_LEFT"),
      pitch: {
        min: num(sem.pitch?.min, -10),
        max: num(sem.pitch?.max, 10),
      },
      roll: {
        min: num(sem.roll?.min, -15),
        max: num(sem.roll?.max, 15),
      },
      yaw: {
        min: num(sem.yaw?.min, -90),
        max: num(sem.yaw?.max, 90),
      },
    },
    geometry: {
      status: String(geom.status || "VALIDATED"),
      mathematicalStatus: String(geom.mathematicalStatus || geom.mathematical_status || geom.status || "VALIDATED"),
      physicalStatus: String(geom.physicalStatus || geom.physical_status || "NOT_CAD_VERIFIED"),
      frame: String(geom.frame || "BASE"),
      units: String(geom.units || "mm"),
      originMm: [...(geom.originMm || geom.origin_mm || [0, 0, 0])].map(Number),
      side1: cloneSide(side1Geom),
      side2: cloneSide(side2Geom),
    },
    mapping: {
      side1: {
        motorId: Math.trunc(num(s1.motorId ?? s1.motor_id, 2)),
        qToModuleSign: Math.trunc(num(s1.qToModuleSign ?? s1.q_to_module_sign, -1)),
        offsetDeg: num(s1.offsetDeg ?? s1.offset_deg, 0),
      },
      side2: {
        motorId: Math.trunc(num(s2.motorId ?? s2.motor_id, 1)),
        qToModuleSign: Math.trunc(num(s2.qToModuleSign ?? s2.q_to_module_sign, 1)),
        offsetDeg: num(s2.offsetDeg ?? s2.offset_deg, 0),
      },
      yaw: {
        motorId: Math.trunc(num(yaw.motorId ?? yaw.motor_id, 3)),
        qToModuleSign: Math.trunc(num(yaw.qToModuleSign ?? yaw.q_to_module_sign, 1)),
        neutralDeg: num(yaw.neutralDeg ?? yaw.neutral_deg, 0),
        minDeg: num(yaw.minDeg ?? yaw.min_deg, -90),
        maxDeg: num(yaw.maxDeg ?? yaw.max_deg, 90),
        enabled: yaw.enabled !== false,
      },
      limits: {
        poseAbsDeg: num(lim.poseAbsDeg ?? lim.pose_abs_deg, 20),
        jointAbsDeg: num(lim.jointAbsDeg ?? lim.joint_abs_deg, 20),
        relativeModuleAbsDeg: num(lim.relativeModuleAbsDeg ?? lim.relative_module_abs_deg, 20),
        globalModuleMinDeg: num(lim.globalModuleMinDeg ?? lim.global_module_min_deg, -40),
        globalModuleMaxDeg: num(lim.globalModuleMaxDeg ?? lim.global_module_max_deg, 40),
        neutralOffsetAbsDeg: num(lim.neutralOffsetAbsDeg ?? lim.neutral_offset_abs_deg, 30),
        uiPitchAbsDeg: num(lim.uiPitchAbsDeg ?? lim.ui_pitch_abs_deg, 10),
        uiRollAbsDeg: num(lim.uiRollAbsDeg ?? lim.ui_roll_abs_deg, 15),
      },
    },
    safety: {
      maxVelocityDegS: num(safety.maxVelocityDegS ?? safety.max_velocity_deg_s, 85),
      maxAccelerationDegS2: num(safety.maxAccelerationDegS2 ?? safety.max_acceleration_deg_s2, 400),
      periodS: num(safety.periodS ?? safety.period_s, 0.01),
    },
    kinematics: {
      attitude: String(src.kinematics?.attitude || "R_BH = Rx(roll) @ Ry(pitch)"),
      branchRule: String(src.kinematics?.branchRule || "nearest_continuous"),
      selectNearestUsesAbs: src.kinematics?.selectNearestUsesAbs !== false,
      closureTolMm: num(src.kinematics?.closureTolMm ?? src.kinematics?.closure_tol_mm, 0.1),
      qDefinition: String(src.kinematics?.qDefinition || "q_new_zero_is_mechanical_closure"),
    },
    // R2.1: default-migrate missing motorProtocol/transport → bm-hmd + FD Luvia
    motorProtocol: normalizeMotorProtocol(src.motorProtocol),
    transport: normalizeTransport(src.transport),
    // R4.1: preserve optional calibration metadata (offsets live in mapping.*.offsetDeg)
    calibration: normalizeCalibration(src.calibration),
  }
}

export function exportNeckRuntimeProfile(profile) {
  return JSON.parse(JSON.stringify(normalizeNeckRuntimeProfile(profile)))
}

export function importNeckRuntimeProfile(json) {
  const data = typeof json === "string" ? JSON.parse(json) : json
  return normalizeNeckRuntimeProfile(data)
}

/** Geometry view used by kinematics (from profile). */
export function geometryFromProfile(profile) {
  const p = normalizeNeckRuntimeProfile(profile)
  const g = p.geometry
  return {
    status: g.status,
    mathematicalStatus: g.mathematicalStatus,
    physicalStatus: g.physicalStatus,
    frame: g.frame,
    units: g.units,
    originMm: [...g.originMm],
    side1: { ...g.side1, geometricSide: "SIDE_1" },
    side2: { ...g.side2, geometricSide: "SIDE_2" },
  }
}
