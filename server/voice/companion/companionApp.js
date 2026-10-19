/**
 * Companion 可打包核心：启动 Gateway + 配对控制台输出。
 */

import http from "node:http"
import { createXinqiGatewayContext } from "../xinqi/createXinqiGatewayHandler.js"
import { attachXinqiRealtimeGateway } from "../xinqi/xinqiRealtimeGateway.js"
import { DEFAULT_XINQI_BASE_URL } from "../xinqi/xinqiConfig.js"
import {
  COMPANION_SERVICE_NAME,
  resolveCompanionListen,
} from "./companionConfig.js"
import {
  authorizeCompanionUpgrade,
  createCompanionHttpHandler,
} from "./companionHttp.js"
import { createPairingStore } from "./pairingStore.js"
import { isLoopbackHostname } from "./companionSecurity.js"
import { loadXinqiRobotKeyFromRoot } from "./loadXinqiRobotKey.js"
import { resolveXinqiRoot } from "./resolveXinqiRoot.js"
import { writeVisiblePairingCode } from "./pairingCodeFile.js"

function detectSea() {
  try {
    if (typeof process.getBuiltinModule === "function") {
      const sea = process.getBuiltinModule("sea")
      return Boolean(sea && typeof sea.isSea === "function" && sea.isSea())
    }
  } catch {
    /* ignore */
  }
  return false
}

async function fetchCompanionDiscover(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/companion/discover`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
    const body = await res.json().catch(() => null)
    return { ok: res.ok, status: res.status, body }
  } catch (error) {
    return { ok: false, error: error?.message || "network", name: error?.name || "Error" }
  }
}

/**
 * @param {object} [options]
 */
export async function startCompanionApp(options = {}) {
  const isSea = options.isSea != null ? options.isSea : detectSea()
  const resolved = resolveXinqiRoot({
    argv: options.argv || process.argv,
    env: options.env || process.env,
    execPath: options.execPath || process.execPath,
    isSea,
  })
  if (!resolved.ok) {
    console.error(`[companion] ${resolved.message}`)
    return { ok: false, code: resolved.code, message: resolved.message }
  }

  const keyResult = loadXinqiRobotKeyFromRoot(resolved.root)
  if (!keyResult.ok) {
    console.error(`[companion] ${keyResult.message}`)
    return { ok: false, code: keyResult.code, message: keyResult.message }
  }

  if (!process.env.XINQI_ROBOT_API_KEY) {
    process.env.XINQI_ROBOT_API_KEY = keyResult.robotApiKey
  }
  if (!process.env.XINQI_BASE_URL) {
    process.env.XINQI_BASE_URL = keyResult.baseUrl || DEFAULT_XINQI_BASE_URL
  }

  const listen = resolveCompanionListen({ processEnv: process.env })
  if (!isLoopbackHostname(listen.host)) {
    console.error(`[companion] 拒绝非 loopback 监听地址：${listen.host}`)
    return { ok: false, code: "NON_LOOPBACK", message: "仅允许 loopback" }
  }

  const existing = await fetchCompanionDiscover(listen.port)
  if (existing.ok && existing.body?.service === COMPANION_SERVICE_NAME) {
    console.log(`[companion] 检测到已运行的 ${COMPANION_SERVICE_NAME} @ :${listen.port}`)
    console.log("[companion] 不重复启动；本进程退出。")
    return { ok: true, alreadyRunning: true, port: listen.port, xinqiRoot: resolved.root }
  }
  if (existing.ok && existing.body && existing.body.service !== COMPANION_SERVICE_NAME) {
    console.error(`[companion] 端口 ${listen.port} 已被其他服务占用（非 FaceDEV Companion）。`)
    return {
      ok: false,
      code: "PORT_FOREIGN",
      message: `端口 ${listen.port} 被其他程序占用`,
    }
  }

  const pairingStore = createPairingStore()
  const xinqi = createXinqiGatewayContext({
    xinqiBaseUrl: process.env.XINQI_BASE_URL || DEFAULT_XINQI_BASE_URL,
    xinqiRobotApiKey: process.env.XINQI_ROBOT_API_KEY,
  })

  async function probeXinqi() {
    try {
      const result = await xinqi.client.health()
      return {
        ok: result.status >= 200 && result.status < 300 && result.body?.ok !== false,
        status: result.status,
        body: result.body,
      }
    } catch {
      return { ok: false, status: 0 }
    }
  }

  const ensureVisiblePairingCode = () => {
    const code = pairingStore.ensurePairingCode()
    const pair = pairingStore.snapshotPublic()
    writeVisiblePairingCode(code, { paired: pair.paired })
    return code
  }

  const companionHandler = createCompanionHttpHandler({
    allowedOrigins: listen.allowedOrigins,
    pairingStore,
    probeXinqi,
    xinqiHttpHandler: xinqi.httpHandler,
    port: listen.port,
    host: listen.host,
    ensureVisiblePairingCode,
  })

  const server = http.createServer(async (req, res) => {
    await companionHandler(req, res)
  })

  attachXinqiRealtimeGateway({
    httpServer: server,
    sessionStore: xinqi.sessionStore,
    getUpstreamWsBaseUrl: () => xinqi.client.getWsBaseUrl(),
    getUpstreamOrigin: () => xinqi.client.getOrigin(),
    authorizeUpgrade: (req) => authorizeCompanionUpgrade(req, {
      allowedOrigins: listen.allowedOrigins,
      pairingStore,
    }),
  })

  let alreadyRunning = false
  try {
    await new Promise((resolve, reject) => {
      server.once("error", async (error) => {
        if (error?.code === "EADDRINUSE") {
          const again = await fetchCompanionDiscover(listen.port)
          if (again.ok && again.body?.service === COMPANION_SERVICE_NAME) {
            console.log("[companion] 端口已被合法 Companion 占用，退出。")
            alreadyRunning = true
            resolve()
            return
          }
          console.error(`[companion] 端口 ${listen.port} 被其他程序占用，无法启动。`)
          reject(Object.assign(new Error("PORT_IN_USE_FOREIGN"), { code: "PORT_FOREIGN" }))
          return
        }
        reject(error)
      })
      server.listen(listen.port, listen.host, () => resolve())
    })
  } catch (error) {
    return {
      ok: false,
      code: error?.code || "LISTEN_FAILED",
      message: error?.message || "listen failed",
    }
  }

  if (alreadyRunning) {
    return { ok: true, alreadyRunning: true, port: listen.port, xinqiRoot: resolved.root }
  }

  const code = pairingStore.rotatePairingCode()
  const pair = pairingStore.snapshotPublic()
  const codeFile = writeVisiblePairingCode(code, { paired: pair.paired })

  console.log(`[companion] listening on http://${listen.host}:${listen.port}`)
  console.log(`[companion] xinqi root: ${resolved.root}`)
  console.log(`[companion] XINQI_BASE_URL ${process.env.XINQI_BASE_URL || DEFAULT_XINQI_BASE_URL}`)
  console.log("[companion] XINQI_ROBOT_API_KEY configured")
  console.log(`[companion] pairing state: ${pair.paired ? "paired" : "needs pairing"}`)
  if (pair.paired) {
    console.log(`[companion] 重新配对码（15 分钟有效）：${code}`)
    console.log("[companion] 云端页若提示需要配对，输入此码（会替换本机旧授权）")
  } else {
    console.log(`[companion] 首次配对码（15 分钟有效）：${code}`)
    console.log("[companion] 在 FaceDEV 云端页「本机 Companion」中输入此配对码")
  }
  console.log(`[companion] 配对码文件: ${codeFile}`)
  console.log(`[companion] state file: ${pairingStore.statePath}`)
  console.log("[companion] Xinqi Engine 未就绪时 Companion 会保持运行，稍后自动健康检查。")

  return {
    ok: true,
    alreadyRunning: false,
    port: listen.port,
    xinqiRoot: resolved.root,
    server,
    pairingStore,
  }
}
