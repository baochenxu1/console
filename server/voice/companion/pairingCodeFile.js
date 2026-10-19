/**
 * 把当前配对码写到用户可见文件（控制台窗口之外）。
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export function pairingCodeFilePath() {
  return path.join(os.homedir(), ".facedev", "companion", "PAIRING_CODE.txt")
}

/**
 * @param {string} code
 * @param {{ paired?: boolean }} [meta]
 */
export function writeVisiblePairingCode(code, meta = {}) {
  const file = pairingCodeFilePath()
  const dir = path.dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const paired = Boolean(meta.paired)
  const lines = [
    "FaceDEV Local Xinqi Companion",
    paired ? "Re-pair code (valid ~15 min):" : "First-time pair code (valid ~15 min):",
    String(code),
    "",
    "Enter this code on FaceDEV cloud page (Provider = Xinqi).",
    `Written: ${new Date().toISOString()}`,
    "",
  ]
  writeFileSync(file, lines.join("\r\n"), "utf8")
  return file
}
