/**
 * Browser Local Bridge capability / permission diagnostics（Phase 2）。
 * Permission API 仅 feature-detect；unsupported ≠ Neck unsupported。
 */

export const PERMISSION_STATES = Object.freeze({
  GRANTED: "granted",
  PROMPT: "prompt",
  DENIED: "denied",
  UNSUPPORTED: "unsupported",
})

const LOOPBACK_PERMISSION_NAMES = Object.freeze(["loopback-network", "local-network"])

export function detectBrowserFamily(userAgent = "") {
  const ua = String(userAgent || "")
  if (/Edg\//i.test(ua)) return "edge"
  if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) return "chrome"
  if (/Firefox\//i.test(ua)) return "firefox"
  if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) return "safari"
  return "unknown"
}

export function isLoopbackHost(hostname = "") {
  const h = String(hostname || "").toLowerCase()
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1"
}

/**
 * @param {{ location?: Location|null, navigator?: Navigator|null, isSecureContext?: boolean }} [env]
 */
export function detectLocalBridgeEnvironment(env = {}) {
  const nav = env.navigator || (typeof navigator !== "undefined" ? navigator : null)
  const loc = env.location || (typeof location !== "undefined" ? location : null)
  const ua = nav?.userAgent || ""
  const browserFamily = detectBrowserFamily(ua)
  const hostname = loc?.hostname || ""
  const isLoopbackPage = isLoopbackHost(hostname)
  const secure =
    typeof env.isSecureContext === "boolean"
      ? env.isSecureContext
      : typeof globalThis.isSecureContext === "boolean"
        ? globalThis.isSecureContext
        : isLoopbackPage
  const permissionsApi =
    nav?.permissions && typeof nav.permissions.query === "function" ? nav.permissions : null

  return {
    isSecureContext: Boolean(secure),
    browserFamily,
    isChromiumFamily: browserFamily === "chrome" || browserFamily === "edge",
    isLoopbackPage,
    loopbackPermissionApiSupport: Boolean(permissionsApi),
    localNetworkPermissionApiSupport: Boolean(permissionsApi),
    userAgent: ua,
    hostname,
    origin: loc?.origin || null,
  }
}

/**
 * Chromium Desktop 是 Neck Local Hardware 目标；本机 Vite loopback 页面仍允许以便 Phase 1/2 本地联调。
 */
export function isNeckLocalHardwareSupported(environment) {
  const env = environment || detectLocalBridgeEnvironment()
  if (env.isChromiumFamily) return true
  if (env.isLoopbackPage) return true
  return false
}

/**
 * @param {PermissionStatus|null|undefined} status
 */
export function normalizePermissionState(status) {
  const s = String(status?.state || "").toLowerCase()
  if (s === "granted") return PERMISSION_STATES.GRANTED
  if (s === "denied") return PERMISSION_STATES.DENIED
  if (s === "prompt") return PERMISSION_STATES.PROMPT
  return PERMISSION_STATES.UNSUPPORTED
}

/**
 * Feature-detect Permissions API；任一已知 name 可用即返回其 state。
 * @param {{ permissions?: { query: Function }|null }} [deps]
 */
export async function queryLocalNetworkPermission(deps = {}) {
  const permissions =
    deps.permissions ||
    (typeof navigator !== "undefined" ? navigator.permissions : null)
  if (!permissions || typeof permissions.query !== "function") {
    return {
      supported: false,
      name: null,
      state: PERMISSION_STATES.UNSUPPORTED,
    }
  }

  for (const name of LOOPBACK_PERMISSION_NAMES) {
    try {
      const status = await permissions.query({ name })
      return {
        supported: true,
        name,
        state: normalizePermissionState(status),
        status,
      }
    } catch {
      // 该 name 不支持，试下一个
    }
  }

  return {
    supported: false,
    name: null,
    state: PERMISSION_STATES.UNSUPPORTED,
  }
}
