/**
 * Local Xinqi Companion — 浏览器侧常量与状态枚举。
 */

export const COMPANION_DEFAULT_PORT = 18740
export const COMPANION_DEFAULT_BASE = `http://127.0.0.1:${COMPANION_DEFAULT_PORT}`

export const COMPANION_STATUS = Object.freeze({
  COMPANION_OFFLINE: "companion_offline",
  BROWSER_PERMISSION_DENIED: "browser_permission_denied",
  BROWSER_PERMISSION_PROMPT: "browser_permission_prompt",
  COMPANION_CONNECTED: "companion_connected",
  XINQI_ENGINE_UNAVAILABLE: "xinqi_engine_unavailable",
  PAIRING_REQUIRED: "pairing_required",
  PAIRING_COMPLETE: "pairing_complete",
  UNKNOWN: "unknown",
})

export const COMPANION_STATUS_LABELS = Object.freeze({
  [COMPANION_STATUS.COMPANION_OFFLINE]: "Companion 未启动",
  [COMPANION_STATUS.BROWSER_PERMISSION_DENIED]: "浏览器本机访问权限未授权",
  [COMPANION_STATUS.BROWSER_PERMISSION_PROMPT]: "需要授权本机网络访问",
  [COMPANION_STATUS.COMPANION_CONNECTED]: "Companion 已连接",
  [COMPANION_STATUS.XINQI_ENGINE_UNAVAILABLE]: "Xinqi Engine 不可用",
  [COMPANION_STATUS.PAIRING_REQUIRED]: "需要首次配对",
  [COMPANION_STATUS.PAIRING_COMPLETE]: "配对已完成",
  [COMPANION_STATUS.UNKNOWN]: "状态未知",
})

export const COMPANION_STORAGE_KEYS = Object.freeze({
  baseUrl: "facedev.companion.baseUrl",
  port: "facedev.companion.port",
  pairingToken: "facedev.companion.pairingToken",
  tokenExpiresAt: "facedev.companion.tokenExpiresAt",
  advancedOpen: "facedev.companion.advancedOpen",
})
