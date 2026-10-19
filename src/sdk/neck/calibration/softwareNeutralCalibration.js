/**
 * FaceDEV Software Installation Neutral Calibration (R4.1).
 * Product calibration is ONLY software trim of mapping.side1/side2.offsetDeg.
 * Does NOT change moduleFromQAndOffset math; yaw has no installation offset.
 */

import {
  exportNeckRuntimeProfile,
  normalizeNeckRuntimeProfile,
} from "../core/neckRuntimeProfile.js"

export const OFFSET_NUDGE_STEPS = Object.freeze([0.1, 0.5])

export const CALIBRATION_STATUS = Object.freeze({
  IDLE: "IDLE",
  EDITING: "EDITING",
  UNSAVED: "UNSAVED",
  SAVED: "SAVED",
  ERROR: "ERROR",
})

export const NEUTRAL_INSTALLATION_OFFSET_TOO_LARGE = "NEUTRAL_INSTALLATION_OFFSET_TOO_LARGE"

export const SOFTWARE_INSTALLATION_NEUTRAL_TYPE = "software-installation-neutral"

const DEFAULT_OFFSET_ABS_LIMIT_DEG = 30

function num(v, fallback = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function roundOffset(v) {
  // Keep short decimal stability for 0.1 / 0.5 nudges
  return Math.round(num(v) * 1000) / 1000
}

/**
 * @param {object|null|undefined} profile
 * @returns {number}
 */
export function getOffsetAbsLimitDeg(profile) {
  const lim = profile?.mapping?.limits || {}
  if (lim.neutralOffsetAbsDeg != null && Number.isFinite(Number(lim.neutralOffsetAbsDeg))) {
    return Math.abs(Number(lim.neutralOffsetAbsDeg))
  }
  if (lim.offsetAbsLimitDeg != null && Number.isFinite(Number(lim.offsetAbsLimitDeg))) {
    return Math.abs(Number(lim.offsetAbsLimitDeg))
  }
  return DEFAULT_OFFSET_ABS_LIMIT_DEG
}

/**
 * @param {object|null|undefined} profile
 * @returns {{ side1: number, side2: number }}
 */
export function readPersistedSideOffsets(profile) {
  const p = profile ? normalizeNeckRuntimeProfile(profile) : null
  return {
    side1: num(p?.mapping?.side1?.offsetDeg, 0),
    side2: num(p?.mapping?.side2?.offsetDeg, 0),
  }
}

/**
 * Clone profile with only side1/side2 offsetDeg replaced.
 * @param {object} profile
 * @param {{ side1: number, side2: number }} offsets
 */
export function applyWorkingOffsetsToProfile(profile, { side1, side2 } = {}) {
  const base = exportNeckRuntimeProfile(profile)
  const s1 = roundOffset(side1)
  const s2 = roundOffset(side2)
  base.mapping = {
    ...base.mapping,
    side1: { ...base.mapping.side1, offsetDeg: s1 },
    side2: { ...base.mapping.side2, offsetDeg: s2 },
  }
  return normalizeNeckRuntimeProfile(base)
}

/**
 * Reject (no silent clamp) when |next| > limit.
 * @returns {{ ok: true, working: {side1:number,side2:number} } | { ok: false, code: string, message: string, working: object }}
 */
export function nudgeWorkingOffset(working, side, delta, limit) {
  const key = side === "side2" || side === 2 || side === "2" ? "side2" : "side1"
  const lim = Math.abs(Number(limit))
  const next = roundOffset(num(working?.[key], 0) + num(delta, 0))
  if (!Number.isFinite(lim) || Math.abs(next) > lim + 1e-12) {
    return {
      ok: false,
      code: NEUTRAL_INSTALLATION_OFFSET_TOO_LARGE,
      message: `offset ${key}=${next} exceeds ±${lim}°`,
      working: {
        side1: num(working?.side1, 0),
        side2: num(working?.side2, 0),
      },
    }
  }
  return {
    ok: true,
    working: {
      side1: key === "side1" ? next : num(working?.side1, 0),
      side2: key === "side2" ? next : num(working?.side2, 0),
    },
  }
}

function offsetsEqual(a, b) {
  return Math.abs(num(a?.side1) - num(b?.side1)) < 1e-9 && Math.abs(num(a?.side2) - num(b?.side2)) < 1e-9
}

/**
 * Host-owned calibration session (working vs persisted offsets).
 * @param {{ persistedProfile: object }} opts
 */
export function createCalibrationSession({ persistedProfile } = {}) {
  let profileSnapshot = persistedProfile
    ? normalizeNeckRuntimeProfile(persistedProfile)
    : null
  let persistedOffsets = readPersistedSideOffsets(profileSnapshot)
  let workingOffsets = { ...persistedOffsets }
  let status = CALIBRATION_STATUS.IDLE
  let lastError = null

  function recomputeStatus() {
    if (status === CALIBRATION_STATUS.ERROR) return
    if (status === CALIBRATION_STATUS.IDLE) return
    if (!offsetsEqual(workingOffsets, persistedOffsets)) {
      status = CALIBRATION_STATUS.UNSAVED
    } else if (status === CALIBRATION_STATUS.UNSAVED || status === CALIBRATION_STATUS.EDITING) {
      status = CALIBRATION_STATUS.EDITING
    }
  }

  function dirty() {
    return !offsetsEqual(workingOffsets, persistedOffsets)
  }

  function snapshot() {
    return {
      status,
      dirty: dirty(),
      persistedOffsets: { ...persistedOffsets },
      workingOffsets: { ...workingOffsets },
      limitDeg: getOffsetAbsLimitDeg(profileSnapshot),
      lastError,
    }
  }

  return {
    enter() {
      lastError = null
      persistedOffsets = readPersistedSideOffsets(profileSnapshot)
      workingOffsets = { ...persistedOffsets }
      status = CALIBRATION_STATUS.EDITING
      return { ok: true, ...snapshot() }
    },

    /** Refresh persisted baseline from a new canonical profile (e.g. after load). */
    syncPersistedProfile(profile) {
      profileSnapshot = profile ? normalizeNeckRuntimeProfile(profile) : null
      persistedOffsets = readPersistedSideOffsets(profileSnapshot)
      if (status === CALIBRATION_STATUS.IDLE || status === CALIBRATION_STATUS.SAVED) {
        workingOffsets = { ...persistedOffsets }
      }
      recomputeStatus()
      return snapshot()
    },

    nudge(side, delta) {
      const limit = getOffsetAbsLimitDeg(profileSnapshot)
      const result = nudgeWorkingOffset(workingOffsets, side, delta, limit)
      if (!result.ok) {
        status = CALIBRATION_STATUS.ERROR
        lastError = { code: result.code, message: result.message }
        return { ...result, ...snapshot() }
      }
      lastError = null
      workingOffsets = result.working
      if (status === CALIBRATION_STATUS.ERROR) status = CALIBRATION_STATUS.EDITING
      recomputeStatus()
      if (status === CALIBRATION_STATUS.IDLE) status = CALIBRATION_STATUS.EDITING
      if (dirty()) status = CALIBRATION_STATUS.UNSAVED
      return { ok: true, ...snapshot() }
    },

    setOffset(side, value) {
      const key = side === "side2" || side === 2 || side === "2" ? "side2" : "side1"
      const limit = getOffsetAbsLimitDeg(profileSnapshot)
      const next = roundOffset(value)
      if (Math.abs(next) > limit + 1e-12) {
        status = CALIBRATION_STATUS.ERROR
        lastError = {
          code: NEUTRAL_INSTALLATION_OFFSET_TOO_LARGE,
          message: `offset ${key}=${next} exceeds ±${limit}°`,
        }
        return { ok: false, code: NEUTRAL_INSTALLATION_OFFSET_TOO_LARGE, ...snapshot() }
      }
      lastError = null
      workingOffsets = {
        side1: key === "side1" ? next : workingOffsets.side1,
        side2: key === "side2" ? next : workingOffsets.side2,
      }
      if (status === CALIBRATION_STATUS.IDLE) status = CALIBRATION_STATUS.EDITING
      recomputeStatus()
      if (dirty()) status = CALIBRATION_STATUS.UNSAVED
      return { ok: true, ...snapshot() }
    },

    /** Reset working software trim to 0/0 (not firmware zero). */
    resetTrimWorking() {
      lastError = null
      workingOffsets = { side1: 0, side2: 0 }
      if (status === CALIBRATION_STATUS.IDLE) status = CALIBRATION_STATUS.EDITING
      recomputeStatus()
      if (dirty()) status = CALIBRATION_STATUS.UNSAVED
      return { ok: true, ...snapshot() }
    },

    cancelRestore() {
      lastError = null
      workingOffsets = { ...persistedOffsets }
      status = CALIBRATION_STATUS.EDITING
      return { ok: true, ...snapshot() }
    },

    markSaved() {
      lastError = null
      persistedOffsets = { ...workingOffsets }
      status = CALIBRATION_STATUS.SAVED
      return { ok: true, ...snapshot() }
    },

    exitToIdle() {
      lastError = null
      workingOffsets = { ...persistedOffsets }
      status = CALIBRATION_STATUS.IDLE
      return { ok: true, ...snapshot() }
    },

    getWorkingOffsets: () => ({ ...workingOffsets }),
    getPersistedOffsets: () => ({ ...persistedOffsets }),
    hasUnsaved: () => dirty(),
    getStatus: () => status,
    snapshot,
  }
}
