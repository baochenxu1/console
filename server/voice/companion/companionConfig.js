/**
 * FaceDEV Local Xinqi Companion 默认配置。
 * 仅监听 loopback；默认端口 18740。
 */

export const COMPANION_DEFAULT_PORT = 18740
export const COMPANION_DEFAULT_HOST = "127.0.0.1"
export const COMPANION_SERVICE_NAME = "facedev-local-xinqi-companion"
export const COMPANION_PROTOCOL_VERSION = 1

/** 默认允许的浏览器 Origin（CF Pages Release + 本机开发） */
export const COMPANION_DEFAULT_ALLOWED_ORIGINS = Object.freeze([
  "https://release.faceconsole-web-staging.pages.dev",
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
  "http://127.0.0.1:8787",
  "http://localhost:8787",
])

export const COMPANION_PAIRING_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const COMPANION_PAIRING_CODE_TTL_MS = 15 * 60 * 1000

export function parseAllowedOrigins(raw) {
  if (!raw || !String(raw).trim()) return [...COMPANION_DEFAULT_ALLOWED_ORIGINS]
  return String(raw)
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function resolveCompanionListen({ processEnv = process.env } = {}) {
  const port = Number(processEnv.FACEDEV_COMPANION_PORT || COMPANION_DEFAULT_PORT)
  const host = String(processEnv.FACEDEV_COMPANION_HOST || COMPANION_DEFAULT_HOST).trim() || COMPANION_DEFAULT_HOST
  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : COMPANION_DEFAULT_PORT,
    allowedOrigins: parseAllowedOrigins(processEnv.FACEDEV_COMPANION_ALLOWED_ORIGINS),
  }
}
