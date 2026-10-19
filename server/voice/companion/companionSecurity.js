/**
 * Companion Origin / loopback / pairing 校验（无 Robot API Key 暴露）。
 */

import { randomBytes, timingSafeEqual } from "node:crypto"

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"])

export function isLoopbackHostname(hostname = "") {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "")
  return LOOPBACK_HOSTS.has(h) || h === "127.0.0.1"
}

/**
 * 手动地址仅允许 loopback（防公网 URL / 任意局域网扫描）。
 * @param {string} raw
 */
export function assertLoopbackBaseUrl(raw) {
  let url
  try {
    url = new URL(String(raw || "").trim())
  } catch {
    return { ok: false, code: "INVALID_URL", message: "地址格式无效。" }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, code: "INVALID_PROTOCOL", message: "仅允许 http/https。" }
  }
  if (!isLoopbackHostname(url.hostname)) {
    return { ok: false, code: "NON_LOOPBACK", message: "仅允许 127.0.0.1 / localhost。" }
  }
  return { ok: true, url: url.href.replace(/\/$/, "") }
}

export function originAllowed(origin, allowedOrigins = []) {
  if (!origin) return false
  const o = String(origin).trim()
  if (!o || o === "null") return false
  return allowedOrigins.some((item) => String(item).trim() === o)
}

export function readRequestOrigin(req) {
  const origin = req?.headers?.origin
  if (origin) return String(origin).trim()
  return ""
}

export function generatePairingCode() {
  // 6 位数字，便于本机控制台抄写
  const n = randomBytes(3).readUIntBE(0, 3) % 1_000_000
  return String(n).padStart(6, "0")
}

export function generatePairingToken() {
  return randomBytes(32).toString("base64url")
}

export function safeEqualString(a, b) {
  const aa = Buffer.from(String(a || ""), "utf8")
  const bb = Buffer.from(String(b || ""), "utf8")
  if (aa.length !== bb.length) return false
  try {
    return timingSafeEqual(aa, bb)
  } catch {
    return false
  }
}

/**
 * 从 Authorization Bearer / X-FaceDEV-Pairing / query.pairing 读取 token。
 */
export function extractPairingToken(req, url = null) {
  const auth = String(req?.headers?.authorization || "")
  const m = /^Bearer\s+(.+)$/i.exec(auth)
  if (m?.[1]) return m[1].trim()
  const header = req?.headers?.["x-facedev-pairing"]
  if (header) return String(header).trim()
  if (url) {
    const q = url.searchParams?.get("pairing")
    if (q) return String(q).trim()
  }
  return ""
}

export function applyCorsHeaders(res, origin, { allowed = false } = {}) {
  if (allowed && origin) {
    res.setHeader("Access-Control-Allow-Origin", origin)
    res.setHeader("Vary", "Origin")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Accept, Authorization, X-FaceDEV-Pairing",
    )
    res.setHeader("Access-Control-Max-Age", "600")
  }
}
