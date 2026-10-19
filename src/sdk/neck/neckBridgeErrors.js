/**
 * Neck Bridge 连接错误分类（不依赖 Chromium 文案字符串匹配）。
 */

export const NECK_BRIDGE_ERROR_CODES = Object.freeze({
  BRIDGE_NOT_RUNNING: "BRIDGE_NOT_RUNNING",
  LOCAL_NETWORK_PERMISSION_REQUIRED: "LOCAL_NETWORK_PERMISSION_REQUIRED",
  LOCAL_NETWORK_PERMISSION_DENIED: "LOCAL_NETWORK_PERMISSION_DENIED",
  ORIGIN_NOT_ALLOWED: "ORIGIN_NOT_ALLOWED",
  CAPABILITIES_FAILED: "CAPABILITIES_FAILED",
  PROTOCOL_MISMATCH: "PROTOCOL_MISMATCH",
  BRIDGE_BUSY: "BRIDGE_BUSY",
  WEBSOCKET_FAILED: "WEBSOCKET_FAILED",
  SESSION_REJECTED: "SESSION_REJECTED",
  BRIDGE_UNHEALTHY: "BRIDGE_UNHEALTHY",
  UNSUPPORTED_BROWSER: "UNSUPPORTED_BROWSER",
  /** Bridge session 在线，但 COM/CANable 硬件未 connect */
  HARDWARE_NOT_CONNECTED: "HARDWARE_NOT_CONNECTED",
  HARDWARE_CONNECT_FAILED: "HARDWARE_CONNECT_FAILED",
  SESSION_INACTIVE: "SESSION_INACTIVE",
  CHANNEL_REQUIRED: "CHANNEL_REQUIRED",
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
})

export const NECK_BRIDGE_ERROR_USER_MESSAGES = Object.freeze({
  BRIDGE_NOT_RUNNING: "Local Neck Bridge not detected.",
  LOCAL_NETWORK_PERMISSION_REQUIRED: "Local Neck access permission required.",
  LOCAL_NETWORK_PERMISSION_DENIED: "Local Neck access denied",
  ORIGIN_NOT_ALLOWED: "This page origin is not allowed by the local Neck Bridge.",
  CAPABILITIES_FAILED: "Failed to read Neck Bridge capabilities.",
  PROTOCOL_MISMATCH: "Neck Bridge protocol version mismatch.",
  BRIDGE_BUSY: "Neck Bridge is busy.",
  WEBSOCKET_FAILED: "Neck Bridge WebSocket failed.",
  SESSION_REJECTED: "Neck Bridge session rejected.",
  BRIDGE_UNHEALTHY: "Neck Bridge reported unhealthy.",
  UNSUPPORTED_BROWSER: "This browser is not supported for local Neck hardware.",
  HARDWARE_NOT_CONNECTED: "HARDWARE_NOT_CONNECTED — Connect Hardware (COM) first.",
  HARDWARE_CONNECT_FAILED: "Hardware connect failed.",
  SESSION_INACTIVE: "Neck Bridge session is not active.",
  CHANNEL_REQUIRED: "COM channel is required for hardware connect.",
  UNKNOWN_ERROR: "Neck Bridge connection failed.",
})

/**
 * @param {string} code
 * @param {{ detail?: string, cause?: any }} [extra]
 */
export function createNeckBridgeError(code, extra = {}) {
  const c = NECK_BRIDGE_ERROR_CODES[code] || NECK_BRIDGE_ERROR_CODES.UNKNOWN_ERROR
  return {
    code: c,
    message: NECK_BRIDGE_ERROR_USER_MESSAGES[c] || NECK_BRIDGE_ERROR_USER_MESSAGES.UNKNOWN_ERROR,
    detail: extra.detail != null ? String(extra.detail) : null,
    cause: extra.cause ?? null,
  }
}

/**
 * Health probe 失败分类。
 * @param {{ httpStatus?: number|null, permissionState?: string, networkError?: boolean, healthOk?: boolean|null, healthBody?: any }} input
 */
export function classifyHealthFailure(input = {}) {
  const perm = String(input.permissionState || "")
  if (perm === "denied") {
    return createNeckBridgeError(NECK_BRIDGE_ERROR_CODES.LOCAL_NETWORK_PERMISSION_DENIED)
  }
  if (perm === "prompt" && input.networkError) {
    // 可能被权限拦截；真正能力仍由后续 Retry 验证
    return createNeckBridgeError(NECK_BRIDGE_ERROR_CODES.LOCAL_NETWORK_PERMISSION_REQUIRED)
  }
  const status = Number(input.httpStatus)
  if (status === 403 || status === 401) {
    return createNeckBridgeError(NECK_BRIDGE_ERROR_CODES.ORIGIN_NOT_ALLOWED, {
      detail: `HTTP ${status}`,
    })
  }
  if (status === 409 || status === 423 || status === 429) {
    return createNeckBridgeError(NECK_BRIDGE_ERROR_CODES.BRIDGE_BUSY, {
      detail: `HTTP ${status}`,
    })
  }
  if (Number.isFinite(status) && status >= 500) {
    return createNeckBridgeError(NECK_BRIDGE_ERROR_CODES.BRIDGE_UNHEALTHY, {
      detail: `HTTP ${status}`,
    })
  }
  if (input.healthOk === false) {
    return createNeckBridgeError(NECK_BRIDGE_ERROR_CODES.BRIDGE_UNHEALTHY)
  }
  if (input.networkError || !Number.isFinite(status)) {
    return createNeckBridgeError(NECK_BRIDGE_ERROR_CODES.BRIDGE_NOT_RUNNING)
  }
  return createNeckBridgeError(NECK_BRIDGE_ERROR_CODES.UNKNOWN_ERROR, {
    detail: Number.isFinite(status) ? `HTTP ${status}` : null,
  })
}

export function classifyCapabilitiesFailure({ httpStatus, networkError } = {}) {
  const status = Number(httpStatus)
  if (status === 403 || status === 401) {
    return createNeckBridgeError(NECK_BRIDGE_ERROR_CODES.ORIGIN_NOT_ALLOWED, {
      detail: `HTTP ${status}`,
    })
  }
  if (networkError || !Number.isFinite(status)) {
    return createNeckBridgeError(NECK_BRIDGE_ERROR_CODES.CAPABILITIES_FAILED)
  }
  return createNeckBridgeError(NECK_BRIDGE_ERROR_CODES.CAPABILITIES_FAILED, {
    detail: `HTTP ${status}`,
  })
}

export function classifyWebSocketFailure({ closeCode, wasClean } = {}) {
  const code = Number(closeCode)
  if (code === 1008 || code === 4003) {
    return createNeckBridgeError(NECK_BRIDGE_ERROR_CODES.ORIGIN_NOT_ALLOWED, {
      detail: `WS close ${code}`,
    })
  }
  if (code === 1013 || code === 4009) {
    return createNeckBridgeError(NECK_BRIDGE_ERROR_CODES.BRIDGE_BUSY, {
      detail: `WS close ${code}`,
    })
  }
  return createNeckBridgeError(NECK_BRIDGE_ERROR_CODES.WEBSOCKET_FAILED, {
    detail: Number.isFinite(code) ? `WS close ${code}${wasClean ? " clean" : ""}` : null,
  })
}

export function classifyHelloRejection(msg) {
  if (msg && msg.accepted === false) {
    const reason = String(msg.reason || "")
    if (/protocol/i.test(reason) || msg.protocolVersion) {
      return createNeckBridgeError(NECK_BRIDGE_ERROR_CODES.PROTOCOL_MISMATCH, {
        detail: reason || String(msg.protocolVersion || ""),
      })
    }
    if (/busy/i.test(reason)) {
      return createNeckBridgeError(NECK_BRIDGE_ERROR_CODES.BRIDGE_BUSY, { detail: reason })
    }
    return createNeckBridgeError(NECK_BRIDGE_ERROR_CODES.SESSION_REJECTED, { detail: reason })
  }
  return createNeckBridgeError(NECK_BRIDGE_ERROR_CODES.PROTOCOL_MISMATCH)
}
