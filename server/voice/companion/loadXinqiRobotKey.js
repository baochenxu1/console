/**
 * 从 Xinqi 工程根 .env 读取 ROBOT_API_KEY（仅本机进程内使用）。
 * 不打印、不写日志、不返回给浏览器。
 */

import { existsSync } from "node:fs"
import path from "node:path"
import { parseEnvFile } from "../loadEnv.js"

/**
 * @param {string} xinqiRoot
 * @returns {{ ok: true, robotApiKey: string, baseUrl: string } | { ok: false, code: string, message: string }}
 */
export function loadXinqiRobotKeyFromRoot(xinqiRoot) {
  const root = path.resolve(String(xinqiRoot || ""))
  const envPath = path.join(root, ".env")
  if (!existsSync(envPath)) {
    return {
      ok: false,
      code: "XINQI_ENV_MISSING",
      message: "Xinqi 根目录缺少 .env。",
    }
  }

  const parsed = parseEnvFile(envPath)
  const robotApiKey = String(
    parsed.ROBOT_API_KEY
      || parsed.XINQI_ROBOT_API_KEY
      || "",
  ).trim()
  const baseUrl = String(
    parsed.XINQI_BASE_URL
      || parsed.ENGINE_BASE_URL
      || "http://127.0.0.1:3210",
  ).trim() || "http://127.0.0.1:3210"

  if (!robotApiKey) {
    return {
      ok: false,
      code: "ROBOT_API_KEY_MISSING",
      message: "Xinqi ROBOT_API_KEY 未配置。",
    }
  }

  return {
    ok: true,
    robotApiKey,
    baseUrl,
    envPath,
  }
}
