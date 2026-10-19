/**
 * Companion URL 约束：仅 loopback，禁止公网 / 任意局域网。
 */

import { COMPANION_DEFAULT_PORT } from "./companionConstants.js"

export function isLoopbackHostname(hostname = "") {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "")
  return h === "127.0.0.1" || h === "localhost" || h === "::1"
}

export function buildCompanionBaseUrl(port = COMPANION_DEFAULT_PORT) {
  const p = Number(port)
  const safe = Number.isFinite(p) && p > 0 ? p : COMPANION_DEFAULT_PORT
  return `http://127.0.0.1:${safe}`
}

/**
 * @param {string} raw
 * @returns {{ ok: true, url: string } | { ok: false, code: string, message: string }}
 */
export function assertLoopbackCompanionUrl(raw) {
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
    return { ok: false, code: "NON_LOOPBACK", message: "仅允许 127.0.0.1 / localhost，不允许公网或局域网地址。" }
  }
  // 去掉路径尾部斜杠，保留端口
  const normalized = `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`
  return { ok: true, url: normalized }
}

export function companionHttpToWsBase(httpBase) {
  const checked = assertLoopbackCompanionUrl(httpBase)
  if (!checked.ok) return checked
  const u = new URL(checked.url)
  const proto = u.protocol === "https:" ? "wss:" : "ws:"
  return { ok: true, wsBase: `${proto}//${u.host}` }
}
