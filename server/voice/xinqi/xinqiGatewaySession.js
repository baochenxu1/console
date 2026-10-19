/**
 * 内存态 Xinqi Gateway Session：仅保存短期 upstream token。
 */

import { randomUUID } from "node:crypto"
import {
  XINQI_GATEWAY_MAX_SESSIONS,
  XINQI_GATEWAY_SESSION_TTL_MS,
} from "./xinqiConfig.js"
import { XINQI_ERROR_CODES, xinqiJsonError } from "./xinqiErrors.js"

/**
 * @param {object} [options]
 * @param {number} [options.ttlMs]
 * @param {number} [options.maxSessions]
 * @param {() => number} [options.now]
 * @param {() => string} [options.randomId]
 */
export function createXinqiGatewaySessionStore({
  ttlMs = XINQI_GATEWAY_SESSION_TTL_MS,
  maxSessions = XINQI_GATEWAY_MAX_SESSIONS,
  now = () => Date.now(),
  randomId = () => randomUUID(),
  enableExpiryTimer = true,
} = {}) {
  /** @type {Map<string, object>} */
  const sessions = new Map()
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const timers = new Map()

  function clearTimer(id) {
    const timer = timers.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.delete(id)
    }
  }

  function purgeExpired() {
    const t = now()
    for (const [id, session] of sessions) {
      if (!session.wsBound && session.expiresAt <= t) {
        remove(id)
      }
    }
  }

  function scheduleExpiry(id) {
    clearTimer(id)
    if (!enableExpiryTimer) return
    const session = sessions.get(id)
    if (!session || session.wsBound) return
    const delay = Math.max(0, session.expiresAt - now())
    const timer = setTimeout(() => {
      const current = sessions.get(id)
      if (current && !current.wsBound) remove(id)
    }, delay)
    if (typeof timer.unref === "function") timer.unref()
    timers.set(id, timer)
  }

  /**
   * @param {object} data
   * @param {string} data.upstreamToken
   * @param {string} data.sessionId
   * @param {object} data.protocol
   */
  function create(data) {
    purgeExpired()
    if (sessions.size >= maxSessions) {
      return xinqiJsonError(
        XINQI_ERROR_CODES.SessionLimit,
        "Xinqi Gateway session 数量已达上限。",
        503,
      )
    }

    const gatewaySessionId = randomId()
    const createdAt = now()
    const session = {
      gatewaySessionId,
      upstreamToken: String(data.upstreamToken || ""),
      sessionId: String(data.sessionId || ""),
      protocol: data.protocol,
      createdAt,
      expiresAt: createdAt + ttlMs,
      wsBound: false,
    }
    sessions.set(gatewaySessionId, session)
    scheduleExpiry(gatewaySessionId)
    return {
      status: 200,
      body: {
        provider: "xinqi",
        gatewaySessionId,
        sessionId: session.sessionId,
        protocol: session.protocol,
      },
    }
  }

  function get(gatewaySessionId) {
    const id = String(gatewaySessionId || "")
    const session = sessions.get(id)
    if (!session) {
      purgeExpired()
      return xinqiJsonError(
        XINQI_ERROR_CODES.SessionNotFound,
        "Gateway session 不存在。",
        404,
      )
    }
    if (!session.wsBound && session.expiresAt <= now()) {
      remove(id)
      purgeExpired()
      return xinqiJsonError(
        XINQI_ERROR_CODES.SessionExpired,
        "Gateway session 已过期。",
        410,
      )
    }
    purgeExpired()
    return { status: 200, session }
  }

  function markWsBound(gatewaySessionId) {
    const result = get(gatewaySessionId)
    if (result.status !== 200) return result
    result.session.wsBound = true
    clearTimer(gatewaySessionId)
    return result
  }

  function remove(gatewaySessionId) {
    const id = String(gatewaySessionId || "")
    clearTimer(id)
    const session = sessions.get(id)
    if (session) {
      session.upstreamToken = ""
      sessions.delete(id)
    }
    return { ok: true }
  }

  function size() {
    purgeExpired()
    return sessions.size
  }

  function clearAll() {
    for (const id of [...sessions.keys()]) remove(id)
  }

  /** 测试辅助：不暴露 token。 */
  function debugPublic(gatewaySessionId) {
    const result = get(gatewaySessionId)
    if (result.status !== 200) return result
    const { upstreamToken, ...rest } = result.session
    return {
      status: 200,
      session: {
        ...rest,
        hasUpstreamToken: Boolean(upstreamToken),
      },
    }
  }

  return {
    create,
    get,
    markWsBound,
    remove,
    size,
    clearAll,
    debugPublic,
  }
}
