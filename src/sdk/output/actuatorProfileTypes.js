import { normalizeLabServoProfile } from "../servoAdapters/core/servoProfile.js"
import { actuatorKeyToLegacyIndex, legacyServoIndexToActuatorKey } from "./actuatorKeys.js"

const PWM_DEFAULTS = { min: 500, center: 1500, max: 2500 }

/**
 * @typedef {object} ActuatorProfile
 * @property {string} actuatorKey
 * @property {'bus'} outputType
 * @property {number} [legacyServoIndex]
 * @property {number} [pwmChannel]
 * @property {number} [minPwm]
 * @property {number} [centerPwm]
 * @property {number} [maxPwm]
 * @property {string} [protocol]
 * @property {number} [busServoId]
 * @property {string} [servoModel]
 * @property {boolean} [enabled]
 */

export function normalizeActuatorProfile(raw = {}) {
  const legacyServoIndex =
    Number.isFinite(Number(raw.legacyServoIndex))
      ? Number(raw.legacyServoIndex)
      : Number.isFinite(Number(raw.servoIndex))
        ? Number(raw.servoIndex)
        : actuatorKeyToLegacyIndex(raw.actuatorKey)

  const actuatorKey =
    typeof raw.actuatorKey === "string"
      ? raw.actuatorKey
      : legacyServoIndex != null
        ? legacyServoIndexToActuatorKey(legacyServoIndex)
        : raw.busServoId != null
          ? `bus_${raw.protocol || "scscl"}_${raw.busServoId}`
          : "servo_unknown"

  const hasBus =
    raw.protocol === "scscl" ||
    raw.protocol === "sms_sts" ||
    raw.protocol === "rj_sbus" ||
    raw.outputType === "bus" ||
    raw.outputType === "pwm" // 历史：强制视为 bus 候选，由 normalize 纠正

  const busBase = hasBus || raw.busServoId != null ? normalizeLabServoProfile({
    ...raw,
    protocol:
      raw.protocol === "pwm" || !raw.protocol
        ? "scscl"
        : raw.protocol,
    outputType: "bus",
  }) : null

  return {
    ...(busBase || {}),
    actuatorKey,
    outputType: "bus",
    legacyServoIndex: legacyServoIndex ?? null,
    pwmChannel: raw.pwmChannel ?? legacyServoIndex ?? null,
    minPwm: raw.minPwm ?? PWM_DEFAULTS.min,
    centerPwm: raw.centerPwm ?? PWM_DEFAULTS.center,
    maxPwm: raw.maxPwm ?? PWM_DEFAULTS.max,
    protocol: raw.protocol === "pwm" ? "scscl" : raw.protocol ?? busBase?.protocol ?? "scscl",
    busServoId: raw.busServoId ?? busBase?.id ?? null,
    servoModel: raw.servoModel ?? busBase?.servoModel ?? null,
    enabled: raw.enabled !== false,
    id: busBase?.id ?? raw.busServoId ?? legacyServoIndex,
  }
}
