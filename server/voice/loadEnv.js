/**
 * Voice server 环境配置解析。
 * 优先级：既有非空 process.env > .env.local > .env
 * 不把 secret 注入 Browser / import.meta.env。
 */

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

export const VOICE_ENV_KEYS = Object.freeze({
  assemblyAIAPIKey: "ASSEMBLYAI_API_KEY",
  deepgramAPIKey: "DEEPGRAM_API_KEY",
  voiceApiPort: "VOICE_API_PORT",
  xinqiBaseUrl: "XINQI_BASE_URL",
  xinqiRobotApiKey: "XINQI_ROBOT_API_KEY",
})

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function isNonEmpty(value) {
  return value != null && String(value).trim() !== ""
}

/**
 * 解析单个 .env 文件为纯对象（不写 process.env）。
 * @param {string} filePath
 * @returns {Record<string, string>}
 */
export function parseEnvFile(filePath) {
  /** @type {Record<string, string>} */
  const out = {}
  if (!filePath || !existsSync(filePath)) return out
  const text = stripBom(readFileSync(filePath, "utf8"))
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!key) continue
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/**
 * @param {object} options
 * @param {string} [options.root]
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} [options.processEnv]
 * @param {Record<string, string>} [options.fileEnv] 已合并的文件 env（测试注入）
 * @param {boolean} [options.applyToProcessEnv] 是否把缺失项写回 process.env（standalone 用）
 */
export function resolveVoiceServerConfig({
  root = process.cwd(),
  processEnv = process.env,
  fileEnv = null,
  applyToProcessEnv = false,
} = {}) {
  const fromLocal = parseEnvFile(path.join(root, ".env.local"))
  const fromDotEnv = parseEnvFile(path.join(root, ".env"))
  /** 文件层：.env.local 覆盖 .env */
  const fromFiles = fileEnv || { ...fromDotEnv, ...fromLocal }

  const pick = (key) => {
    if (isNonEmpty(processEnv?.[key])) return String(processEnv[key]).trim()
    if (isNonEmpty(fromFiles[key])) return String(fromFiles[key]).trim()
    return ""
  }

  const assemblyAIAPIKey = pick(VOICE_ENV_KEYS.assemblyAIAPIKey)
  const deepgramAPIKey = pick(VOICE_ENV_KEYS.deepgramAPIKey)
  const voiceApiPort = pick(VOICE_ENV_KEYS.voiceApiPort)
  const xinqiBaseUrl = pick(VOICE_ENV_KEYS.xinqiBaseUrl)
  const xinqiRobotApiKey = pick(VOICE_ENV_KEYS.xinqiRobotApiKey)

  if (applyToProcessEnv) {
    const target = processEnv || process.env
    if (!isNonEmpty(target[VOICE_ENV_KEYS.assemblyAIAPIKey]) && assemblyAIAPIKey) {
      target[VOICE_ENV_KEYS.assemblyAIAPIKey] = assemblyAIAPIKey
    }
    if (!isNonEmpty(target[VOICE_ENV_KEYS.deepgramAPIKey]) && deepgramAPIKey) {
      target[VOICE_ENV_KEYS.deepgramAPIKey] = deepgramAPIKey
    }
    if (!isNonEmpty(target[VOICE_ENV_KEYS.voiceApiPort]) && voiceApiPort) {
      target[VOICE_ENV_KEYS.voiceApiPort] = voiceApiPort
    }
    if (!isNonEmpty(target[VOICE_ENV_KEYS.xinqiBaseUrl]) && xinqiBaseUrl) {
      target[VOICE_ENV_KEYS.xinqiBaseUrl] = xinqiBaseUrl
    }
    if (!isNonEmpty(target[VOICE_ENV_KEYS.xinqiRobotApiKey]) && xinqiRobotApiKey) {
      target[VOICE_ENV_KEYS.xinqiRobotApiKey] = xinqiRobotApiKey
    }
  }

  return {
    root,
    assemblyAIAPIKey,
    deepgramAPIKey,
    voiceApiPort,
    xinqiBaseUrl,
    xinqiRobotApiKey,
    hasAssemblyAIAPIKey: Boolean(assemblyAIAPIKey),
    hasDeepgramAPIKey: Boolean(deepgramAPIKey),
    hasXinqiRobotApiKey: Boolean(xinqiRobotApiKey),
    sources: {
      processHasKey: isNonEmpty(processEnv?.[VOICE_ENV_KEYS.assemblyAIAPIKey]),
      envLocalHasKey: isNonEmpty(fromLocal[VOICE_ENV_KEYS.assemblyAIAPIKey]),
      envHasKey: isNonEmpty(fromDotEnv[VOICE_ENV_KEYS.assemblyAIAPIKey]),
      processHasDeepgramKey: isNonEmpty(processEnv?.[VOICE_ENV_KEYS.deepgramAPIKey]),
      envLocalHasDeepgramKey: isNonEmpty(fromLocal[VOICE_ENV_KEYS.deepgramAPIKey]),
      envHasDeepgramKey: isNonEmpty(fromDotEnv[VOICE_ENV_KEYS.deepgramAPIKey]),
      processHasXinqiKey: isNonEmpty(processEnv?.[VOICE_ENV_KEYS.xinqiRobotApiKey]),
      envLocalHasXinqiKey: isNonEmpty(fromLocal[VOICE_ENV_KEYS.xinqiRobotApiKey]),
      envHasXinqiKey: isNonEmpty(fromDotEnv[VOICE_ENV_KEYS.xinqiRobotApiKey]),
      processHasXinqiBaseUrl: isNonEmpty(processEnv?.[VOICE_ENV_KEYS.xinqiBaseUrl]),
      envLocalHasXinqiBaseUrl: isNonEmpty(fromLocal[VOICE_ENV_KEYS.xinqiBaseUrl]),
      envHasXinqiBaseUrl: isNonEmpty(fromDotEnv[VOICE_ENV_KEYS.xinqiBaseUrl]),
    },
  }
}

/**
 * 兼容旧入口：把 .env / .env.local 中缺失项填入 process.env（不覆盖非空值）。
 */
export function loadProjectEnv(cwd = process.cwd()) {
  const config = resolveVoiceServerConfig({
    root: cwd,
    processEnv: process.env,
    applyToProcessEnv: true,
  })
  return {
    ok: true,
    loaded: (config.hasAssemblyAIAPIKey ? 1 : 0)
      + (config.hasDeepgramAPIKey ? 1 : 0)
      + (config.hasXinqiRobotApiKey ? 1 : 0),
    hasAssemblyAIAPIKey: config.hasAssemblyAIAPIKey,
    hasDeepgramAPIKey: config.hasDeepgramAPIKey,
    hasXinqiRobotApiKey: config.hasXinqiRobotApiKey,
  }
}

/** @deprecated 使用 parseEnvFile / resolveVoiceServerConfig */
export function loadEnvFile(filePath) {
  const parsed = parseEnvFile(filePath)
  let loaded = 0
  for (const [key, value] of Object.entries(parsed)) {
    if (isNonEmpty(process.env[key])) continue
    process.env[key] = value
    loaded += 1
  }
  return { ok: Object.keys(parsed).length > 0 || existsSync(filePath), loaded }
}
