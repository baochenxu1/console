import { normalizeLabServoProfile } from "../core/servoProfile.js"
import { FACE_BUS_SERVO_ROUTE } from "./faceBusServoRoute.js"

function profilesToArray(profiles) {
  if (Array.isArray(profiles)) {
    return profiles.map((p) => normalizeLabServoProfile(p))
  }
  if (profiles && typeof profiles === "object") {
    return Object.values(profiles).map((p) => normalizeLabServoProfile(p))
  }
  return []
}

function profilePickScore(profile) {
  let score = 0
  if (profile.centerMode === "installed_center" && profile.installedCenterValid === true) {
    score += 1_000_000
  }
  if (profile.installedCenterCapturedAt) {
    const t = Date.parse(profile.installedCenterCapturedAt)
    if (Number.isFinite(t)) {
      score += t
    }
  }
  if (Number.isFinite(Number(profile.effectiveCenterPosition))) {
    score += 1
  }
  return score
}

function pickBestProfile(candidates) {
  if (!candidates.length) {
    return null
  }
  return [...candidates].sort((a, b) => profilePickScore(b) - profilePickScore(a))[0]
}

/**
 * @param {object} params
 * @param {number} params.logicalServoIndex
 * @param {object[] | object} params.profiles
 * @param {object} [params.routeMap]
 */
export function resolveBusServoProfile({
  logicalServoIndex,
  profiles,
  routeMap = FACE_BUS_SERVO_ROUTE,
}) {
  const idx = Number(logicalServoIndex)
  const route = routeMap[idx]

  if (!route) {
    return {
      ok: false,
      logicalServoIndex: idx,
      reason: "route-not-found",
      route: null,
    }
  }

  if (route.enabled === false) {
    return {
      ok: false,
      logicalServoIndex: idx,
      reason: "route-disabled",
      route,
    }
  }

  const busServoId = Number(route.busServoId)
  const protocol = route.protocol

  if (!Number.isFinite(busServoId) || busServoId <= 0) {
    return {
      ok: false,
      logicalServoIndex: idx,
      reason: "invalid-bus-id",
      route,
    }
  }

  const list = profilesToArray(profiles)
  const matches = list.filter(
    (p) =>
      Number(p.id) === busServoId &&
      p.protocol === protocol &&
      p.enabled !== false
  )

  const profile = pickBestProfile(matches)
  if (!profile) {
    return {
      ok: false,
      logicalServoIndex: idx,
      reason: "profile-not-found",
      route,
      busServoId,
      protocol,
    }
  }

  return {
    ok: true,
    route,
    profile,
    logicalServoIndex: idx,
    busServoId,
    protocol,
    warning: null,
  }
}
