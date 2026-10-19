import { normalizeActuatorProfile } from "./actuatorProfileTypes.js"
import { actuatorKeyToLegacyIndex, legacyServoIndexToActuatorKey } from "./actuatorKeys.js"
import { ACTUATOR_BUS_ID_MISMATCH, parseActuatorKeyNumber } from "./analyzeActuatorProfiles.js"
import {
  majorityActuatorProtocol,
  pickBestActuatorProfile,
  preferredProtocolFromBusTransportFamily,
} from "./actuatorProfilePick.js"
import { getStoredBusTransportFamily } from "../servoAdapters/busServo/resolveBusTransport.js"
import { defaultServoModelForProtocol } from "../servoAdapters/core/servoMechanicalSafety.js"
import { PROTOCOL } from "../servoAdapters/core/servoTypes.js"

function profilesToList(profiles) {
  if (Array.isArray(profiles)) {
    return profiles.map((p) => normalizeActuatorProfile(p))
  }
  if (profiles && typeof profiles === "object") {
    return Object.values(profiles).map((p) => normalizeActuatorProfile(p))
  }
  return []
}

/**
 * 按 actuatorKey 精确解析设备 profile（运行时不用 routeMap，不用 legacy 回退匹配）。
 */
export function resolveActuatorProfile({ actuatorKey, legacyServoIndex, profiles }) {
  const list = profilesToList(profiles)
  const key =
    actuatorKey ||
    (legacyServoIndex != null ? legacyServoIndexToActuatorKey(legacyServoIndex) : null)

  if (!key) {
    return { ok: false, reason: "missing-actuator-key", actuatorKey: null, profile: null }
  }

  const legacy =
    legacyServoIndex != null
      ? Number(legacyServoIndex)
      : actuatorKeyToLegacyIndex(key)

  const matches = list.filter((p) => p.actuatorKey === key && p.enabled !== false)

  if (!matches.length) {
    const disabled = list.filter((p) => p.actuatorKey === key && p.enabled === false)
    if (disabled.length) {
      return {
        ok: false,
        reason: "actuator-disabled",
        actuatorKey: key,
        legacyServoIndex: legacy,
        profile: disabled[0],
      }
    }
    return {
      ok: false,
      reason: "profile-not-found",
      actuatorKey: key,
      legacyServoIndex: legacy,
      profile: null,
    }
  }

  const familyPreferred = preferredProtocolFromBusTransportFamily(
    getStoredBusTransportFamily()
  )
  const preferredProtocol = familyPreferred || majorityActuatorProtocol(list)
  let profile = pickBestActuatorProfile(matches, { preferredProtocol })

  const expectedBusId = parseActuatorKeyNumber(key)
  let warning = null
  let warningMessage = null
  if (
    Number.isFinite(expectedBusId) &&
    Number.isFinite(Number(profile.busServoId)) &&
    Number(profile.busServoId) !== expectedBusId
  ) {
    warning = ACTUATOR_BUS_ID_MISMATCH
    warningMessage =
      `actuatorKey ${key} 与实际 bus ID ${profile.busServoId} 不一致，可能是旧 +1 迁移残留。`
  }

  /*
   * 与 Bus 舵机页 useBusServoProfile 对齐：UI「主用总线族」为 RJ 时，
   * 即便本地只残留 ST/SC 条目，下发也按 RJ 组包（否则 ID2/4 等会发飞特帧，
   * 舵机页能动、面部绑定不动）。
   */
  if (
    familyPreferred === PROTOCOL.RJ_SBUS &&
    profile &&
    String(profile.protocol || "") !== PROTOCOL.RJ_SBUS
  ) {
    const prevProto = profile.protocol
    profile = normalizeActuatorProfile({
      ...profile,
      protocol: PROTOCOL.RJ_SBUS,
      servoModel: defaultServoModelForProtocol(PROTOCOL.RJ_SBUS),
    })
    const overrideNote =
      `UI 主用 RJ：已将 ${key} 的存储协议 ${prevProto} 覆盖为 rj_sbus（与舵机页一致）。` +
      `建议在舵机配置页对该 ID 重新保存 RJ 中位。`
    if (!warning) {
      warning = "protocol-family-ui-override"
      warningMessage = overrideNote
    } else {
      warningMessage = `${warningMessage} ${overrideNote}`
    }
  }

  const protocols = new Set(matches.map((p) => String(p.protocol || "")))
  if (protocols.size > 1) {
    const conflictNote =
      `同一 ${key} 存在多协议配置（${[...protocols].join("/")}），` +
      `已按总线族/主导协议（${preferredProtocol || "n/a"}）择优为 ${profile.protocol}；请删除错误协议残留。`
    if (!warning) {
      warning = "actuator-protocol-conflict"
      warningMessage = conflictNote
    } else {
      warningMessage = `${warningMessage} ${conflictNote}`
    }
  }

  return {
    ok: true,
    actuatorKey: profile.actuatorKey,
    legacyServoIndex: profile.legacyServoIndex ?? legacy,
    profile,
    warning,
    warningMessage,
  }
}
