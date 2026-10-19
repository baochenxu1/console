/**
 * 解析 Xinqi 工程根目录（EXE 旁 / 启动参数）。
 * 禁止扫描整盘；不以 process.cwd() 为唯一依据。
 */

import { existsSync } from "node:fs"
import path from "node:path"

export const XINQI_ROOT_MARKERS = Object.freeze([
  "start.cmd",
  "scripts/launch.mjs",
])

/**
 * @param {string} dir
 */
export function looksLikeXinqiRoot(dir) {
  const root = path.resolve(String(dir || ""))
  if (!root || !existsSync(root)) {
    return { ok: false, root, missing: ["(directory)"] }
  }
  const missing = []
  for (const rel of XINQI_ROOT_MARKERS) {
    if (!existsSync(path.join(root, rel))) missing.push(rel)
  }
  // .env 允许缺失文件，但会在后续 Key 检查时报错；仍作为软提示
  const hasEnv = existsSync(path.join(root, ".env"))
  if (missing.length) {
    return { ok: false, root, missing, hasEnv }
  }
  return { ok: true, root, missing: [], hasEnv }
}

/**
 * @param {object} [options]
 * @param {string[]} [options.argv]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.execPath]
 * @param {boolean} [options.isSea]
 * @param {string} [options.scriptDir] 开发态 companion 源码旁无法当 Xinqi 根；可注入
 */
export function resolveXinqiRoot(options = {}) {
  const argv = options.argv || process.argv
  const env = options.env || process.env
  const execPath = options.execPath || process.execPath
  const isSea = Boolean(options.isSea)

  const fromArg = argv.find((a) => String(a).startsWith("--xinqi-root="))
  if (fromArg) {
    const dir = fromArg.slice("--xinqi-root=".length).replace(/^["']|["']$/g, "")
    const checked = looksLikeXinqiRoot(dir)
    if (!checked.ok) {
      return {
        ok: false,
        code: "XINQI_ROOT_INVALID",
        message: `启动参数 --xinqi-root 不是有效 Xinqi 根目录（缺少：${checked.missing.join(", ")}）。`,
        root: checked.root,
      }
    }
    return { ok: true, root: checked.root, source: "argv" }
  }

  if (env.FACEDEV_XINQI_ROOT && String(env.FACEDEV_XINQI_ROOT).trim()) {
    const checked = looksLikeXinqiRoot(String(env.FACEDEV_XINQI_ROOT).trim())
    if (!checked.ok) {
      return {
        ok: false,
        code: "XINQI_ROOT_INVALID",
        message: `环境变量 FACEDEV_XINQI_ROOT 不是有效 Xinqi 根目录（缺少：${checked.missing.join(", ")}）。`,
        root: checked.root,
      }
    }
    return { ok: true, root: checked.root, source: "env" }
  }

  // SEA / 独立 EXE：优先 EXE 所在目录
  if (isSea) {
    const exeDir = path.dirname(path.resolve(execPath))
    const checked = looksLikeXinqiRoot(exeDir)
    if (!checked.ok) {
      return {
        ok: false,
        code: "XINQI_ROOT_INVALID",
        message: `未在 EXE 同目录找到 Xinqi（缺少：${checked.missing.join(", ")}）。请把 FaceDEV-Companion.exe 放到 Xinqi 工程根目录。`,
        root: checked.root,
      }
    }
    return { ok: true, root: checked.root, source: "exe_dir" }
  }

  // 开发态：可选 FACEDEV 工程旁调试，但仍要求显式 root 或 cwd 像 Xinqi
  const cwdChecked = looksLikeXinqiRoot(process.cwd())
  if (cwdChecked.ok) {
    return { ok: true, root: cwdChecked.root, source: "cwd" }
  }

  return {
    ok: false,
    code: "XINQI_ROOT_MISSING",
    message: "无法定位 Xinqi 工程根。请使用 --xinqi-root=... 或将 EXE 放在含 start.cmd 与 scripts\\launch.mjs 的目录。",
    root: null,
  }
}
