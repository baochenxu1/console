/**
 * SC/ST 总线舵机共用操作：ID 读写、EEPROM 锁、状态寄存器读取。
 */

import { clampInt, isValidServoId } from "../core/servoAdapter.js"
import { MAX_ID, describeServoError } from "./scProtocolConstants.js"
import { buildRead, buildWrite } from "./scPacket.js"
import { scsMakeWord, scsToHost } from "./scPacket.js"
import { normalizeRawPosition } from "./scServoCodec.js"

const ID_REG = 5

/**
 * @param {object} adapter 需实现 transport + _read(id, addr, len, decode, timeout, label)
 * @param {{ lockReg:number, end:number }} proto
 */
export async function readServoId(adapter, id, { timeoutMs = 100 } = {}) {
  const res = await adapter._read(id, ID_REG, 1, (p) => p[0], timeoutMs, "id")
  if (!res.ok) return res
  return { ...res, value: res.value, label: "id" }
}

export async function unlockEprom(adapter, id, lockReg) {
  const tx = buildWrite(id, lockReg, [0])
  const res = await adapter.transport.request(tx, { expectedId: id, timeoutMs: 80 })
  if (!res.ok) {
    return { ok: false, id, error: res.reason || "unlock-fail", txBytes: Array.from(tx) }
  }
  return { ok: true, id, txBytes: Array.from(tx), rxBytes: res.raw }
}

export async function lockEprom(adapter, id, lockReg) {
  const tx = buildWrite(id, lockReg, [1])
  const res = await adapter.transport.request(tx, { expectedId: id, timeoutMs: 80 })
  if (!res.ok) {
    return { ok: false, id, error: res.reason || "lock-fail", txBytes: Array.from(tx) }
  }
  return { ok: true, id, txBytes: Array.from(tx), rxBytes: res.raw }
}

/**
 * 修改舵机 ID（单台，非广播）。
 * @param {object} adapter
 * @param {number} oldId
 * @param {number} newId
 * @param {{ lockReg:number }} proto
 */
export async function changeServoId(adapter, oldId, newId, { lockReg }) {
  if (!isValidServoId(oldId) || !isValidServoId(newId)) {
    return { ok: false, error: `ID 须在 0..${MAX_ID}` }
  }
  if (oldId === newId) {
    return { ok: false, error: "新旧 ID 不能相同" }
  }

  const pingOld = await adapter.ping(oldId, { timeoutMs: 120 })
  if (!pingOld.ok) {
    return { ok: false, error: `Ping oldId=${oldId} 失败：${pingOld.error}` }
  }

  const un = await unlockEprom(adapter, oldId, lockReg)
  if (!un.ok) {
    return { ok: false, error: `Unlock EEPROM 失败：${un.error}` }
  }

  const tx = buildWrite(oldId, ID_REG, [newId])
  const wr = await adapter.transport.request(tx, { expectedId: oldId, timeoutMs: 100 })
  if (!wr.ok) {
    await lockEprom(adapter, oldId, lockReg)
    return { ok: false, error: `写入新 ID 失败：${wr.reason}`, txBytes: Array.from(tx) }
  }

  await lockEprom(adapter, oldId, lockReg)

  const pingNew = await adapter.ping(newId, { timeoutMs: 150 })
  const pingOldAgain = await adapter.ping(oldId, { timeoutMs: 80 })

  const success = pingNew.ok && !pingOldAgain.ok
  return {
    ok: success,
    oldId,
    newId,
    pingNewOk: pingNew.ok,
    pingOldOk: pingOldAgain.ok,
    error: success ? "" : "修改后验证未通过，请重新扫描或断电重试",
    steps: { unlock: un.ok, write: wr.ok, pingNew: pingNew.ok, pingOldAfter: pingOldAgain.ok },
  }
}

export function decodePresentSpeed(params, end) {
  if (!params || params.length < 2) return null
  return scsToHost(scsMakeWord(params[0], params[1], end), 15)
}

export function decodePresentLoad(params, end) {
  if (!params || params.length < 2) return null
  return scsToHost(scsMakeWord(params[0], params[1], end), 10)
}

export function decodePresentCurrent(params, end) {
  if (!params || params.length < 2) return null
  return scsToHost(scsMakeWord(params[0], params[1], end), 15)
}

export async function readPresentVoltage(adapter, id, reg, { timeoutMs = 100 } = {}) {
  return adapter._read(id, reg, 1, (p) => p[0], timeoutMs, "voltage")
}

export async function readPresentTemperature(adapter, id, reg, { timeoutMs = 100 } = {}) {
  return adapter._read(id, reg, 1, (p) => p[0], timeoutMs, "temperature")
}

export async function readMoving(adapter, id, reg, { timeoutMs = 100 } = {}) {
  return adapter._read(id, reg, 1, (p) => (p[0] ? 1 : 0), timeoutMs, "moving")
}

/** 位置读数后处理：强制 unsigned，负数视为解析错误。 */
export function finalizePositionRead(res) {
  if (!res || !res.ok) return res
  const norm = normalizeRawPosition(res.value)
  if (norm.parseError) {
    return {
      ...res,
      ok: false,
      error: norm.parseError,
      parseWarning: norm.parseError,
      value: null,
    }
  }
  return { ...res, value: norm.value, rawPosition: norm.value }
}
