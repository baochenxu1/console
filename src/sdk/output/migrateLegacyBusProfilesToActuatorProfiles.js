import { normalizeLabServoProfile } from "../servoAdapters/core/servoProfile.js"
import { normalizeActuatorProfile } from "./actuatorProfileTypes.js"
import { legacyServoIndexToActuatorKey } from "./actuatorKeys.js"
import {
  majorityActuatorProtocol,
  pickBestActuatorProfile,
  preferredProtocolFromBusTransportFamily,
} from "./actuatorProfilePick.js"
import { getStoredBusTransportFamily } from "../servoAdapters/busServo/resolveBusTransport.js"

/**
 * 旧 bus profile（id+protocol）→ actuator profile（actuatorKey+busServoId）。
 *
 * 正式语义（不再使用 routeMap +1）：
 *   busProfile.id = 1 → actuatorKey servo_1, busServoId = 1
 *   busProfile.id = 14 → actuatorKey servo_14, busServoId = 14
 *
 * routeMap 仅保留在 faceBusServoRoute.js 供旧数据一次性迁移 / Direct Test fallback。
 *
 * 跨协议同 ID：优先当前 UI 总线族（RJ / 飞特），避免残留 ST 标定把 RJ 绑定打到 ~3072。
 */
export function migrateLegacyBusProfilesToActuatorProfiles({
  oldProfiles,
  preferredProtocol = null,
} = {}) {
  const list = Array.isArray(oldProfiles)
    ? oldProfiles
    : Object.values(oldProfiles || {})

  /** @type {Record<string, object[]>} */
  const groups = {}
  /** @type {object[]} */
  const allCandidates = []

  for (const entry of list) {
    const normalized = normalizeLabServoProfile(entry)
    const busId = Number(normalized.id)
    if (!Number.isFinite(busId) || busId <= 0) {
      continue
    }

    const actuatorKey = legacyServoIndexToActuatorKey(busId)

    const candidate = normalizeActuatorProfile({
      ...normalized,
      actuatorKey,
      outputType: "bus",
      legacyServoIndex: busId,
      busServoId: busId,
      protocol: normalized.protocol,
      servoModel: normalized.servoModel,
      enabled: normalized.enabled !== false,
    })

    if (!groups[actuatorKey]) groups[actuatorKey] = []
    groups[actuatorKey].push(candidate)
    allCandidates.push(candidate)
  }

  const familyPreferred =
    preferredProtocol ||
    preferredProtocolFromBusTransportFamily(getStoredBusTransportFamily())
  const effectivePreferred =
    familyPreferred || majorityActuatorProtocol(allCandidates)

  return Object.keys(groups)
    .sort()
    .map((key) =>
      pickBestActuatorProfile(groups[key], { preferredProtocol: effectivePreferred })
    )
    .filter(Boolean)
}

/**
 * @deprecated 仅旧 routeMap 反查；运行时输出不再使用。
 */
export function buildLegacyIndexLookupFromRoute(routeMap) {
  const lookup = {}
  for (const [idx, route] of Object.entries(routeMap || {})) {
    if (!route || route.busServoId == null) {
      continue
    }
    lookup[`${route.protocol}:${route.busServoId}`] = Number(idx)
  }
  return lookup
}
