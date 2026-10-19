/**
 * Xinqi Engine HTTP client（server-side only）。
 */

import {
  normalizeXinqiBaseUrl,
  validateXinqiProtocol,
} from "./xinqiConfig.js"
import { XINQI_ERROR_CODES, xinqiJsonError } from "./xinqiErrors.js"

function defaultFetch(...args) {
  return globalThis.fetch(...args)
}

/**
 * @param {object} options
 * @param {string} [options.baseUrl]
 * @param {string} [options.robotApiKey]
 * @param {typeof fetch} [options.fetchImpl]
 */
export function createXinqiClient({
  baseUrl,
  robotApiKey,
  fetchImpl = defaultFetch,
} = {}) {
  const normalized = normalizeXinqiBaseUrl(baseUrl)
  if (!normalized.ok) {
    return {
      getBaseUrl: () => "",
      getOrigin: () => "",
      getWsBaseUrl: () => "",
      async health() {
        return { status: normalized.status, body: normalized.body }
      },
      async connectRobot() {
        return { status: normalized.status, body: normalized.body }
      },
    }
  }

  const key = String(robotApiKey || "").trim()

  async function health() {
    let response
    try {
      response = await fetchImpl(`${normalized.baseUrl}/health`, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      })
    } catch (error) {
      console.error("[xinqi] health unreachable", error?.name || error)
      return xinqiJsonError(XINQI_ERROR_CODES.Unreachable, "无法连接 Xinqi Engine。", 502)
    }

    let data = null
    try {
      data = await response.json()
    } catch {
      data = null
    }

    if (!response.ok) {
      return xinqiJsonError(XINQI_ERROR_CODES.Unreachable, "Xinqi Engine health 响应异常。", 502)
    }

    const robotApi = String(data?.robotApi || "unknown")
    if (robotApi !== "configured") {
      return xinqiJsonError(
        XINQI_ERROR_CODES.RobotApiNotConfigured,
        "Xinqi Engine Robot API 未配置。",
        502,
        { robotApi },
      )
    }

    return {
      status: 200,
      body: {
        provider: "xinqi",
        reachable: true,
        app: String(data?.app || "xinqi-engine"),
        version: data?.version != null ? String(data.version) : null,
        robotApi: "configured",
      },
    }
  }

  /**
   * @param {object} [options]
   * @param {string} [options.sessionId]
   */
  async function connectRobot({ sessionId } = {}) {
    if (!key) {
      return xinqiJsonError(
        XINQI_ERROR_CODES.MissingRobotApiKey,
        "服务器未配置 Xinqi Robot API Key。",
        500,
      )
    }

    let response
    try {
      response = await fetchImpl(`${normalized.baseUrl}/api/robot/connect`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(sessionId ? { sessionId } : {}),
      })
    } catch (error) {
      console.error("[xinqi] connect unreachable", error?.name || error)
      return xinqiJsonError(XINQI_ERROR_CODES.ConnectFailed, "无法连接 Xinqi Robot API。", 502)
    }

    let data = null
    try {
      data = await response.json()
    } catch {
      data = null
    }

    if (response.status === 401) {
      return xinqiJsonError(XINQI_ERROR_CODES.AuthFailed, "Xinqi Robot API 鉴权失败。", 502)
    }

    if (!response.ok || !data?.token || !data?.sessionId) {
      console.error("[xinqi] connect failed", response.status)
      return xinqiJsonError(XINQI_ERROR_CODES.ConnectFailed, "Xinqi Robot connect 失败。", 502)
    }

    const protocolCheck = validateXinqiProtocol(data.protocol || {})
    if (!protocolCheck.ok) {
      return { status: protocolCheck.status, body: protocolCheck.body }
    }

    return {
      status: 200,
      body: {
        provider: "xinqi",
        // server-only fields — caller must strip before Browser response
        _upstreamToken: String(data.token),
        sessionId: String(data.sessionId),
        expiresInSeconds: Number(data.expiresInSeconds) || null,
        protocol: protocolCheck.protocol,
      },
    }
  }

  return {
    getBaseUrl: () => normalized.baseUrl,
    getOrigin: () => normalized.origin,
    getWsBaseUrl: () => normalized.wsBaseUrl,
    health,
    connectRobot,
  }
}
