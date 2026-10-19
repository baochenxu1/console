/**
 * @param {number} legacyServoIndex
 */
export function legacyServoIndexToActuatorKey(legacyServoIndex) {
  return `servo_${Number(legacyServoIndex)}`
}

/**
 * @param {string} actuatorKey
 * @returns {number | null}
 */
export function actuatorKeyToLegacyIndex(actuatorKey) {
  if (typeof actuatorKey !== "string") {
    return null
  }
  const m = actuatorKey.match(/^servo_(\d+)$/)
  return m ? Number(m[1]) : null
}
