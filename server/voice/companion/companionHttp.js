/**
 * Companion HTTP：discover / pair / 包装 Xinqi Gateway（Origin + Pairing）。
 */

import {
  COMPANION_PROTOCOL_VERSION,
  COMPANION_SERVICE_NAME,
} from "./companionConfig.js"
import {
  applyCorsHeaders,
  extractPairingToken,
  originAllowed,
  readRequestOrigin,
} from "./companionSecurity.js"

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json; charset=utf-8")
  res.setHeader("Cache-Control", "no-store")
  res.end(JSON.stringify(body))
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString("utf8")
  if (!text.trim()) return {}
  return JSON.parse(text)
}

/**
 * @param {object} deps
 * @param {string[]} deps.allowedOrigins
 * @param {ReturnType<import('./pairingStore.js').createPairingStore>} deps.pairingStore
 * @param {() => Promise<{ ok: boolean, status?: number, body?: object }>} deps.probeXinqi
 * @param {(req, res) => Promise<void>} deps.xinqiHttpHandler
 * @param {number} deps.port
 * @param {string} deps.host
 * @param {() => string} [deps.ensureVisiblePairingCode] 确保有可用配对码并写入可见文件
 */
export function createCompanionHttpHandler(deps) {
  const {
    allowedOrigins,
    pairingStore,
    probeXinqi,
    xinqiHttpHandler,
    port,
    host,
    ensureVisiblePairingCode = null,
  } = deps

  function gateOrigin(req, res) {
    const origin = readRequestOrigin(req)
    const allowed = !origin || originAllowed(origin, allowedOrigins)
    // 无 Origin：同机工具 / 同源脚本；有 Origin 则必须在白名单
    if (origin && !allowed) {
      applyCorsHeaders(res, origin, { allowed: false })
      sendJson(res, 403, {
        ok: false,
        error: { code: "ORIGIN_DENIED", message: "Origin 未授权。" },
      })
      return { ok: false, origin, allowed: false }
    }
    applyCorsHeaders(res, origin, { allowed: Boolean(origin) && allowed })
    return { ok: true, origin, allowed: Boolean(origin) ? allowed : true }
  }

  function requirePairing(req, res, url) {
    const token = extractPairingToken(req, url)
    if (!pairingStore.isTokenValid(token)) {
      sendJson(res, 401, {
        ok: false,
        error: {
          code: "PAIRING_REQUIRED",
          message: "需要首次配对或配对已过期。",
        },
      })
      return false
    }
    return true
  }

  return async function handleCompanionHttp(req, res) {
    const originGate = gateOrigin(req, res)
    if (!originGate.ok) return

    if (req.method === "OPTIONS") {
      res.statusCode = 204
      res.end()
      return
    }

    let url
    try {
      url = new URL(req.url || "/", `http://${host}:${port}`)
    } catch {
      sendJson(res, 400, { ok: false, error: { code: "BAD_URL", message: "无效 URL。" } })
      return
    }

    const path = url.pathname

    if (path === "/api/companion/discover" && req.method === "GET") {
      const xinqi = await probeXinqi()
      // 始终保证有可重新配对的码（浏览器丢 token 时不必重启 Companion）
      if (typeof ensureVisiblePairingCode === "function") {
        ensureVisiblePairingCode()
      } else {
        pairingStore.ensurePairingCode()
      }
      const pair = pairingStore.snapshotPublic()
      const presented = extractPairingToken(req, url)
      const clientAuthorized = Boolean(presented && pairingStore.isTokenValid(presented))
      sendJson(res, 200, {
        ok: true,
        service: COMPANION_SERVICE_NAME,
        protocolVersion: COMPANION_PROTOCOL_VERSION,
        host,
        port,
        loopbackOnly: true,
        xinqi: {
          reachable: Boolean(xinqi.ok),
          status: xinqi.status ?? null,
        },
        pairing: {
          ...pair,
          clientAuthorized,
          // 浏览器侧：无有效 token 即需配对（即使本机曾配对过）
          browserPairingRequired: !clientAuthorized,
        },
        endpoints: {
          discover: "/api/companion/discover",
          pair: "/api/companion/pair",
          health: "/api/voice/xinqi/health",
          session: "/api/voice/xinqi/session",
          realtime: "/api/voice/xinqi/realtime",
        },
      })
      return
    }

    if (path === "/api/companion/pair" && req.method === "POST") {
      let body = {}
      try {
        body = await readJsonBody(req)
      } catch {
        sendJson(res, 400, {
          ok: false,
          error: { code: "INVALID_JSON", message: "请求体必须是 JSON。" },
        })
        return
      }
      const result = pairingStore.pairWithCode(body?.code, originGate.origin)
      if (!result.ok) {
        sendJson(res, 401, { ok: false, error: { code: result.code, message: result.message } })
        return
      }
      sendJson(res, 200, {
        ok: true,
        token: result.token,
        expiresAt: result.expiresAt,
        pairedAt: result.pairedAt,
      })
      return
    }

    if (path === "/healthz" && req.method === "GET") {
      sendJson(res, 200, { ok: true, service: COMPANION_SERVICE_NAME })
      return
    }

    if (path.startsWith("/api/voice/xinqi/")) {
      // health 可在已配对或未配对时探测引擎；session 必须配对
      if (path === "/api/voice/xinqi/session") {
        if (!requirePairing(req, res, url)) return
      } else if (path !== "/api/voice/xinqi/health") {
        if (!requirePairing(req, res, url)) return
      } else if (!pairingStore.isPaired()) {
        // health：未配对仍允许（用于区分引擎不可用 vs 需配对），但不泄露密钥
      }
      await xinqiHttpHandler(req, res)
      return
    }

    sendJson(res, 404, {
      ok: false,
      error: { code: "NOT_FOUND", message: "Companion 路径不存在。" },
    })
  }
}

/**
 * WebSocket upgrade 鉴权：Origin + pairing token（query 或 header）。
 */
export function authorizeCompanionUpgrade(req, { allowedOrigins, pairingStore }) {
  const origin = readRequestOrigin(req)
  if (origin && !originAllowed(origin, allowedOrigins)) {
    return { ok: false, code: "ORIGIN_DENIED", reason: "origin_denied" }
  }
  let url
  try {
    url = new URL(req.url || "/", "http://127.0.0.1")
  } catch {
    return { ok: false, code: "BAD_URL", reason: "bad_url" }
  }
  const token = extractPairingToken(req, url)
  if (!pairingStore.isTokenValid(token)) {
    return { ok: false, code: "PAIRING_REQUIRED", reason: "pairing_required" }
  }
  return { ok: true }
}
