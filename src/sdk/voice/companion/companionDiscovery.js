/**
 * 自动发现本机 Companion（仅 127.0.0.1，不扫描局域网/公网）。
 * 状态区分：未启动 / LNA 未授权 / 已连接 / Xinqi 不可用 / 需配对 / 配对完成。
 */

import {
  PERMISSION_STATES,
  queryLocalNetworkPermission,
} from "../../neck/neckLocalBridgeCapability.js"
import {
  COMPANION_DEFAULT_BASE,
  COMPANION_STATUS,
  COMPANION_STATUS_LABELS,
} from "./companionConstants.js"
import {
  clearCompanionPairingToken,
  hasValidStoredPairing,
  loadCompanionPreferences,
  saveCompanionPairingToken,
} from "./companionPreferences.js"
import { assertLoopbackCompanionUrl } from "./companionUrl.js"

/**
 * @param {object} [options]
 * @param {string} [options.baseUrl]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {{ permissions?: { query: Function } }} [options.permissionDeps]
 * @param {Storage|null} [options.store]
 * @param {() => number} [options.now]
 */
export async function discoverLocalCompanion(options = {}) {
  const prefs = loadCompanionPreferences(options.store)
  const baseChecked = assertLoopbackCompanionUrl(options.baseUrl || prefs.baseUrl || COMPANION_DEFAULT_BASE)
  if (!baseChecked.ok) {
    return {
      ok: false,
      status: COMPANION_STATUS.UNKNOWN,
      label: baseChecked.message,
      prefs,
      baseUrl: null,
      permission: null,
      discover: null,
      error: baseChecked,
    }
  }
  const baseUrl = baseChecked.url
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 2500
  const now = options.now || (() => Date.now())

  const permission = await queryLocalNetworkPermission(options.permissionDeps || {})
  if (permission.state === PERMISSION_STATES.DENIED) {
    return {
      ok: false,
      status: COMPANION_STATUS.BROWSER_PERMISSION_DENIED,
      label: COMPANION_STATUS_LABELS[COMPANION_STATUS.BROWSER_PERMISSION_DENIED],
      prefs,
      baseUrl,
      permission,
      discover: null,
      error: { code: "LNA_DENIED" },
    }
  }

  let discover = null
  let networkError = null
  const storedOk = hasValidStoredPairing(prefs, now())
  try {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null
    /** @type {Record<string, string>} */
    const headers = { Accept: "application/json" }
    if (storedOk && prefs.pairingToken) {
      headers.Authorization = `Bearer ${prefs.pairingToken}`
      headers["X-FaceDEV-Pairing"] = prefs.pairingToken
    }
    const res = await fetchImpl(`${baseUrl}/api/companion/discover`, {
      method: "GET",
      headers,
      cache: "no-store",
      signal: ctrl?.signal,
    })
    if (timer) clearTimeout(timer)
    const body = await res.json().catch(() => null)
    if (!res.ok || !body?.ok) {
      networkError = { code: "DISCOVER_HTTP", status: res.status, body }
    } else {
      discover = body
    }
  } catch (error) {
    networkError = {
      code: "DISCOVER_NETWORK",
      message: error?.message || "network",
      name: error?.name || "Error",
    }
  }

  if (!discover) {
    // Chromium LNA：未授权时常表现为 Failed to fetch；若 Permission API 为 prompt，优先标权限
    if (
      permission.state === PERMISSION_STATES.PROMPT
      && networkError?.code === "DISCOVER_NETWORK"
    ) {
      return {
        ok: false,
        status: COMPANION_STATUS.BROWSER_PERMISSION_PROMPT,
        label: COMPANION_STATUS_LABELS[COMPANION_STATUS.BROWSER_PERMISSION_PROMPT],
        prefs,
        baseUrl,
        permission,
        discover: null,
        error: networkError,
      }
    }
    return {
      ok: false,
      status: COMPANION_STATUS.COMPANION_OFFLINE,
      label: COMPANION_STATUS_LABELS[COMPANION_STATUS.COMPANION_OFFLINE],
      prefs,
      baseUrl,
      permission,
      discover: null,
      error: networkError,
    }
  }

  const serverPairingRequired = Boolean(discover.pairing?.pairingRequired)
  const clientAuthorized = discover.pairing?.clientAuthorized
  // 服务端明确拒绝浏览器 token，或本地无 token / 过期 → 需要（重新）配对
  const browserNeedsPair = clientAuthorized === false
    || Boolean(discover.pairing?.browserPairingRequired)
    || serverPairingRequired
    || !storedOk
  if (browserNeedsPair) {
    if (storedOk && clientAuthorized === false) {
      clearCompanionPairingToken(options.store)
    } else if (!storedOk) {
      clearCompanionPairingToken(options.store)
    }
    return {
      ok: true,
      status: COMPANION_STATUS.PAIRING_REQUIRED,
      label: COMPANION_STATUS_LABELS[COMPANION_STATUS.PAIRING_REQUIRED],
      prefs: loadCompanionPreferences(options.store),
      baseUrl,
      permission,
      discover,
      error: null,
      canRepair: true,
    }
  }

  if (!discover.xinqi?.reachable) {
    return {
      ok: true,
      status: COMPANION_STATUS.XINQI_ENGINE_UNAVAILABLE,
      label: COMPANION_STATUS_LABELS[COMPANION_STATUS.XINQI_ENGINE_UNAVAILABLE],
      prefs,
      baseUrl,
      permission,
      discover,
      error: null,
    }
  }

  // 已配对 + Companion 可达 + Xinqi 可达
  return {
    ok: true,
    status: COMPANION_STATUS.PAIRING_COMPLETE,
    label: COMPANION_STATUS_LABELS[COMPANION_STATUS.PAIRING_COMPLETE],
    companionConnected: true,
    prefs,
    baseUrl,
    permission,
    discover,
    error: null,
    // 兼容展示「Companion 已连接」子状态
    secondaryStatus: COMPANION_STATUS.COMPANION_CONNECTED,
    secondaryLabel: COMPANION_STATUS_LABELS[COMPANION_STATUS.COMPANION_CONNECTED],
  }
}

/**
 * 使用本机 Companion 控制台配对码完成首次配对。
 */
export async function pairWithCompanion({
  baseUrl,
  code,
  fetchImpl = globalThis.fetch,
  store,
} = {}) {
  const checked = assertLoopbackCompanionUrl(baseUrl)
  if (!checked.ok) return { ok: false, ...checked }
  if (!String(code || "").trim()) {
    return { ok: false, code: "PAIRING_CODE_MISSING", message: "请输入配对码。" }
  }
  try {
    const res = await fetchImpl(`${checked.url}/api/companion/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ code: String(code).trim() }),
      cache: "no-store",
    })
    const body = await res.json().catch(() => null)
    if (!res.ok || !body?.ok || !body.token) {
      return {
        ok: false,
        code: body?.error?.code || "PAIR_FAILED",
        message: body?.error?.message || "配对失败。",
      }
    }
    saveCompanionPairingToken({ token: body.token, expiresAt: body.expiresAt }, store)
    return { ok: true, token: body.token, expiresAt: body.expiresAt }
  } catch (error) {
    return {
      ok: false,
      code: "PAIR_NETWORK",
      message: error?.message || "无法连接 Companion。",
    }
  }
}

/**
 * 构建 XinqiProvider 所需的跨源 URL / headers。
 */
export function buildXinqiCompanionTransport(discoveryOrPrefs) {
  const baseUrl = discoveryOrPrefs?.baseUrl
    || discoveryOrPrefs?.prefs?.baseUrl
    || COMPANION_DEFAULT_BASE
  const token = discoveryOrPrefs?.prefs?.pairingToken
    || discoveryOrPrefs?.pairingToken
    || ""
  const checked = assertLoopbackCompanionUrl(baseUrl)
  if (!checked.ok) return { ok: false, ...checked }
  const u = new URL(checked.url)
  const wsProto = u.protocol === "https:" ? "wss:" : "ws:"
  const headers = token
    ? { Authorization: `Bearer ${token}`, "X-FaceDEV-Pairing": token }
    : {}

  return {
    ok: true,
    baseUrl: checked.url,
    pairingToken: token,
    sessionUrl: () => `${checked.url}/api/voice/xinqi/session`,
    realtimeUrl: (gatewaySessionId) => (
      `${wsProto}//${u.host}/api/voice/xinqi/realtime`
      + `?session=${encodeURIComponent(gatewaySessionId)}`
      + (token ? `&pairing=${encodeURIComponent(token)}` : "")
    ),
    sessionHeaders: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...headers,
    },
  }
}

export function companionStatusTone(status) {
  switch (status) {
    case COMPANION_STATUS.PAIRING_COMPLETE:
    case COMPANION_STATUS.COMPANION_CONNECTED:
      return "ok"
    case COMPANION_STATUS.PAIRING_REQUIRED:
    case COMPANION_STATUS.BROWSER_PERMISSION_PROMPT:
      return "warn"
    case COMPANION_STATUS.COMPANION_OFFLINE:
    case COMPANION_STATUS.BROWSER_PERMISSION_DENIED:
    case COMPANION_STATUS.XINQI_ENGINE_UNAVAILABLE:
      return "danger"
    default:
      return "neutral"
  }
}

/** 清除浏览器本地配对并重新发现（强制进入可重新配对状态）。 */
export async function resetCompanionPairing(options = {}) {
  clearCompanionPairingToken(options.store)
  return discoverLocalCompanion(options)
}
