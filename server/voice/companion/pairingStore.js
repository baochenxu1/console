/**
 * 本机配对状态：配对码 + Bearer token（落盘到用户目录，不进 git）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  COMPANION_PAIRING_CODE_TTL_MS,
  COMPANION_PAIRING_TTL_MS,
} from "./companionConfig.js"
import {
  generatePairingCode,
  generatePairingToken,
  safeEqualString,
} from "./companionSecurity.js"

function defaultStatePath() {
  const base = process.env.FACEDEV_COMPANION_STATE_DIR
    || path.join(os.homedir(), ".facedev", "companion")
  return path.join(base, "pairing.json")
}

function emptyState() {
  return {
    version: 1,
    pairingCode: null,
    pairingCodeExpiresAt: null,
    token: null,
    tokenExpiresAt: null,
    pairedAt: null,
    pairedOrigin: null,
  }
}

export function createPairingStore({
  statePath = defaultStatePath(),
  now = () => Date.now(),
  codeTtlMs = COMPANION_PAIRING_CODE_TTL_MS,
  tokenTtlMs = COMPANION_PAIRING_TTL_MS,
} = {}) {
  let state = emptyState()

  function ensureDir() {
    const dir = path.dirname(statePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  function load() {
    try {
      if (!existsSync(statePath)) {
        state = emptyState()
        return state
      }
      const raw = JSON.parse(readFileSync(statePath, "utf8"))
      state = { ...emptyState(), ...raw }
    } catch {
      state = emptyState()
    }
    return state
  }

  function save() {
    ensureDir()
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  }

  function isTokenValid(token) {
    if (!token || !state.token) return false
    if (!safeEqualString(token, state.token)) return false
    if (!state.tokenExpiresAt || now() > Number(state.tokenExpiresAt)) return false
    return true
  }

  function isPaired() {
    return isTokenValid(state.token)
  }

  function ensurePairingCode() {
    load()
    const codeOk = state.pairingCode
      && state.pairingCodeExpiresAt
      && now() <= Number(state.pairingCodeExpiresAt)
    if (codeOk) return state.pairingCode
    state.pairingCode = generatePairingCode()
    state.pairingCodeExpiresAt = now() + codeTtlMs
    save()
    return state.pairingCode
  }

  function rotatePairingCode() {
    load()
    state.pairingCode = generatePairingCode()
    state.pairingCodeExpiresAt = now() + codeTtlMs
    save()
    return state.pairingCode
  }

  /**
   * @param {string} code
   * @param {string} [origin]
   */
  function pairWithCode(code, origin = "") {
    load()
    if (!state.pairingCode || !state.pairingCodeExpiresAt) {
      return { ok: false, code: "PAIRING_CODE_MISSING", message: "请先在 Companion 控制台查看配对码。" }
    }
    if (now() > Number(state.pairingCodeExpiresAt)) {
      return { ok: false, code: "PAIRING_CODE_EXPIRED", message: "配对码已过期，请重启 Companion 或刷新配对码。" }
    }
    if (!safeEqualString(String(code || "").trim(), state.pairingCode)) {
      return { ok: false, code: "PAIRING_CODE_INVALID", message: "配对码不正确。" }
    }
    const token = generatePairingToken()
    const expiresAt = now() + tokenTtlMs
    state.token = token
    state.tokenExpiresAt = expiresAt
    state.pairedAt = now()
    state.pairedOrigin = origin || null
    // 一次性配对码
    state.pairingCode = null
    state.pairingCodeExpiresAt = null
    save()
    return {
      ok: true,
      token,
      expiresAt,
      pairedAt: state.pairedAt,
    }
  }

  function revoke() {
    load()
    state.token = null
    state.tokenExpiresAt = null
    state.pairedAt = null
    state.pairedOrigin = null
    save()
  }

  function snapshotPublic() {
    load()
    return {
      pairingRequired: !isPaired(),
      paired: isPaired(),
      tokenExpiresAt: isPaired() ? state.tokenExpiresAt : null,
      pairingCodeActive: Boolean(
        state.pairingCode && state.pairingCodeExpiresAt && now() <= Number(state.pairingCodeExpiresAt),
      ),
    }
  }

  load()

  return {
    statePath,
    load,
    save,
    isTokenValid,
    isPaired,
    ensurePairingCode,
    rotatePairingCode,
    pairWithCode,
    revoke,
    snapshotPublic,
    getState: () => ({ ...state }),
  }
}
