/**
 * Companion 连接偏好（端口 / 配对 token）。不存储 Robot API Key。
 */

import { COMPANION_DEFAULT_PORT, COMPANION_STORAGE_KEYS } from "./companionConstants.js"
import { assertLoopbackCompanionUrl, buildCompanionBaseUrl } from "./companionUrl.js"

function storage() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null
  } catch {
    return null
  }
}

export function loadCompanionPreferences(store = storage()) {
  const portRaw = store?.getItem?.(COMPANION_STORAGE_KEYS.port)
  const port = Number(portRaw)
  const baseRaw = store?.getItem?.(COMPANION_STORAGE_KEYS.baseUrl) || ""
  const token = store?.getItem?.(COMPANION_STORAGE_KEYS.pairingToken) || ""
  const expiresRaw = store?.getItem?.(COMPANION_STORAGE_KEYS.tokenExpiresAt)
  const tokenExpiresAt = expiresRaw ? Number(expiresRaw) : null
  const advancedOpen = store?.getItem?.(COMPANION_STORAGE_KEYS.advancedOpen) === "1"

  let baseUrl = ""
  if (baseRaw) {
    const checked = assertLoopbackCompanionUrl(baseRaw)
    if (checked.ok) baseUrl = checked.url
  }
  const safePort = Number.isFinite(port) && port > 0 ? port : COMPANION_DEFAULT_PORT
  if (!baseUrl) baseUrl = buildCompanionBaseUrl(safePort)

  return {
    port: safePort,
    baseUrl,
    pairingToken: token,
    tokenExpiresAt: Number.isFinite(tokenExpiresAt) ? tokenExpiresAt : null,
    advancedOpen,
  }
}

export function saveCompanionPort(port, store = storage()) {
  const n = Number(port)
  const safe = Number.isFinite(n) && n > 0 ? n : COMPANION_DEFAULT_PORT
  const baseUrl = buildCompanionBaseUrl(safe)
  store?.setItem?.(COMPANION_STORAGE_KEYS.port, String(safe))
  store?.setItem?.(COMPANION_STORAGE_KEYS.baseUrl, baseUrl)
  return { port: safe, baseUrl }
}

export function saveCompanionBaseUrl(raw, store = storage()) {
  const checked = assertLoopbackCompanionUrl(raw)
  if (!checked.ok) return checked
  const url = new URL(checked.url)
  const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80)
  store?.setItem?.(COMPANION_STORAGE_KEYS.baseUrl, checked.url)
  store?.setItem?.(COMPANION_STORAGE_KEYS.port, String(port))
  return { ok: true, baseUrl: checked.url, port }
}

export function saveCompanionPairingToken({ token, expiresAt }, store = storage()) {
  if (!token) {
    store?.removeItem?.(COMPANION_STORAGE_KEYS.pairingToken)
    store?.removeItem?.(COMPANION_STORAGE_KEYS.tokenExpiresAt)
    return
  }
  store?.setItem?.(COMPANION_STORAGE_KEYS.pairingToken, String(token))
  if (expiresAt != null) {
    store?.setItem?.(COMPANION_STORAGE_KEYS.tokenExpiresAt, String(expiresAt))
  }
}

export function clearCompanionPairingToken(store = storage()) {
  saveCompanionPairingToken({ token: "" }, store)
}

export function saveCompanionAdvancedOpen(open, store = storage()) {
  store?.setItem?.(COMPANION_STORAGE_KEYS.advancedOpen, open ? "1" : "0")
}

export function hasValidStoredPairing(prefs, now = Date.now()) {
  if (!prefs?.pairingToken) return false
  if (prefs.tokenExpiresAt != null && now > Number(prefs.tokenExpiresAt)) return false
  return true
}
