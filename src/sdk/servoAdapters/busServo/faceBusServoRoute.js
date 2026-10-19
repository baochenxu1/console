/**
 * 遗留迁移用 routeMap：旧 servoIndex → busServoId + protocol。
 * 正式运行时输出由 finalServoOutputs + actuatorProfile 决定，不再以本表为发送依据。
 * 用途：migrateLegacyBusProfilesToActuatorProfiles / Direct Test fallback。
 */

export const FACE_BUS_SERVO_ROUTE = {
  // Right face: old logical 0~10 -> bus 1~11
  0: { busServoId: 1, protocol: "scscl", enabled: true },
  1: { busServoId: 2, protocol: "scscl", enabled: true },
  2: { busServoId: 3, protocol: "scscl", enabled: true },
  3: { busServoId: 4, protocol: "scscl", enabled: true },
  4: { busServoId: 5, protocol: "scscl", enabled: true },
  5: { busServoId: 6, protocol: "scscl", enabled: true },
  6: { busServoId: 7, protocol: "scscl", enabled: true },
  7: { busServoId: 8, protocol: "sms_sts", enabled: true },
  8: { busServoId: 9, protocol: "sms_sts", enabled: true },
  9: { busServoId: 10, protocol: "scscl", enabled: true },
  // Tongue: old logical 10 -> bus 11, currently disabled.
  10: { busServoId: 11, protocol: "scscl", enabled: false },

  // Left face: old logical 13~22 -> bus 14~23
  13: { busServoId: 14, protocol: "scscl", enabled: true },
  14: { busServoId: 15, protocol: "scscl", enabled: true },
  15: { busServoId: 16, protocol: "scscl", enabled: true },
  16: { busServoId: 17, protocol: "scscl", enabled: true },
  17: { busServoId: 18, protocol: "scscl", enabled: true },
  18: { busServoId: 19, protocol: "scscl", enabled: true },
  19: { busServoId: 20, protocol: "scscl", enabled: true },
  20: { busServoId: 21, protocol: "scscl", enabled: true },
  21: { busServoId: 22, protocol: "scscl", enabled: true },
  22: { busServoId: 23, protocol: "scscl", enabled: true },
}

/** routeMap 中所有 enabled 的 logical 索引（用于回中） */
export function listEnabledRouteLogicalIndices(routeMap = FACE_BUS_SERVO_ROUTE) {
  return Object.keys(routeMap)
    .map(Number)
    .filter((idx) => routeMap[idx]?.enabled === true)
    .sort((a, b) => a - b)
}
