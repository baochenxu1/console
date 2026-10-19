/**
 * 总线物理链路解析。
 *
 * 产品约定（RJ 机型）：
 * - RJ 与飞特 ST 可共一条 UART（工程默认 1M），开一次口即可。
 * - 同一口上按协议切换报文：RJ 帧 / Feetech 帧，不需要开两路串口。
 * - UI「主用类型」决定默认 Open 用哪套 transport 实例与默认波特率。
 */

import { PROTOCOL } from "../core/servoTypes.js"
import { scServoTransport } from "../scservo/scServoWebSerialTransport.js"
import { COMMON_BAUDRATES, DEFAULT_SC_BAUDRATE } from "../scservo/scProtocolConstants.js"
import { rjSbusTransport } from "../rjsbus/rjSbusWebSerialTransport.js"
import { COMMON_RJ_BAUDRATES, DEFAULT_RJ_BAUDRATE } from "../rjsbus/rjSbusConstants.js"
import { readJsonStorage } from "../../../utils/storage.js"

/** @typedef {'feetech' | 'rj_sbus'} BusTransportFamily */

export const BUS_TRANSPORT_FAMILY_STORAGE_KEY = "faceconsole.busTransportFamily"

export const BUS_TRANSPORT_FAMILY_OPTIONS = [
  {
    id: /** @type {BusTransportFamily} */ ("feetech"),
    label: "SC/ST（飞特）",
    shortLabel: "SC/ST",
  },
  {
    id: /** @type {BusTransportFamily} */ ("rj_sbus"),
    label: "RJ_SBUS（锐捷）",
    shortLabel: "RJ",
  },
]

export function normalizeBusTransportFamily(value) {
  if (value === "rj_sbus" || value === PROTOCOL.RJ_SBUS) return "rj_sbus"
  return "feetech"
}

/** 当前 UI/产品选用的总线族（持久化）。 */
export function getStoredBusTransportFamily() {
  return normalizeBusTransportFamily(
    readJsonStorage(BUS_TRANSPORT_FAMILY_STORAGE_KEY, "feetech")
  )
}

export function getActiveBusTransport(family = getStoredBusTransportFamily()) {
  return resolveBusTransportByFamily(family)
}

export function getActiveBusTransportLabel(family = getStoredBusTransportFamily()) {
  return resolveBusBaudConfig(family).shortLabel
}

/** 指定族的 transport 实例是否已连接。 */
export function isActiveBusTransportConnected(family = getStoredBusTransportFamily()) {
  return Boolean(getActiveBusTransport(family)?.getStatus?.()?.connected)
}

/**
 * 共总线物理线：优先用当前选用族已打开的口；否则用另一族已打开的口。
 * RJ@1M 与 ST 混用时，开一次即可，RJ/ST 报文都写这一条线。
 */
export function getSharedBusWireTransport(family = getStoredBusTransportFamily()) {
  const preferred = getActiveBusTransport(family)
  if (preferred?.getStatus?.()?.connected) {
    return preferred
  }
  const other =
    normalizeBusTransportFamily(family) === "rj_sbus" ? scServoTransport : rjSbusTransport
  if (other?.getStatus?.()?.connected) {
    return other
  }
  return preferred
}

export function isSharedBusWireConnected(family = getStoredBusTransportFamily()) {
  return Boolean(getSharedBusWireTransport(family)?.getStatus?.()?.connected)
}

/** @deprecated 与 isSharedBusWireConnected 同义：共总线任一端已开即可 */
export function isAnyBusTransportConnected() {
  return isSharedBusWireConnected()
}

export function normalizeBusProtocol(protocol) {
  if (protocol === PROTOCOL.SMS_STS || protocol === "sms_sts") return PROTOCOL.SMS_STS
  if (
    protocol === PROTOCOL.RJ_SBUS ||
    protocol === "rj_sbus" ||
    protocol === "RJ" ||
    protocol === "RJ_SBUS"
  ) {
    return PROTOCOL.RJ_SBUS
  }
  return PROTOCOL.SCSCL
}

export function busTransportFamilyForProtocol(protocol) {
  return normalizeBusProtocol(protocol) === PROTOCOL.RJ_SBUS ? "rj_sbus" : "feetech"
}

/** 从 bus command / profile 推断协议族（仅影响报文格式，不强制换口）。 */
export function busTransportFamilyForCommand(cmd) {
  const protocol = cmd?.profile?.protocol ?? cmd?.protocol
  return busTransportFamilyForProtocol(protocol)
}

/**
 * 共总线门控：口开了则 RJ + ST 命令全部保留，同一 UART 上切换报文下发。
 *
 * @param {object[]} commands
 * @param {{ activeFamily?: string, fallbackTransport?: { getStatus?: () => { connected?: boolean } } }} [options]
 * @returns {{ ok: boolean, connected: boolean, activeFamily: BusTransportFamily, reason: string, kept: object[], skipped: object[] }}
 */
export function evaluateBusCommandsPortGate(commands, options = {}) {
  const family = normalizeBusTransportFamily(
    options.activeFamily ?? getStoredBusTransportFamily()
  )
  const activeLabel = getActiveBusTransportLabel(family)
  const raw = Array.isArray(commands) ? commands : []
  const wire =
    options.fallbackTransport?.getStatus?.()?.connected
      ? options.fallbackTransport
      : getSharedBusWireTransport(family)
  const connected = Boolean(wire?.getStatus?.()?.connected)

  if (!connected) {
    return {
      ok: false,
      connected: false,
      activeFamily: family,
      reason: `${activeLabel} 串口未连接`,
      kept: [],
      skipped: raw,
    }
  }

  return {
    ok: true,
    connected: true,
    activeFamily: family,
    reason: "",
    kept: raw,
    skipped: [],
  }
}

export function resolveBusTransport(protocol) {
  return busTransportFamilyForProtocol(protocol) === "rj_sbus" ? rjSbusTransport : scServoTransport
}

export function resolveBusTransportByFamily(family) {
  return normalizeBusTransportFamily(family) === "rj_sbus" ? rjSbusTransport : scServoTransport
}

export function resolveBusBaudConfig(protocolOrFamily) {
  const family = (() => {
    if (
      protocolOrFamily === "rj_sbus" ||
      protocolOrFamily === PROTOCOL.RJ_SBUS
    ) {
      return "rj_sbus"
    }
    if (
      protocolOrFamily === "feetech" ||
      protocolOrFamily === "bus" ||
      protocolOrFamily === PROTOCOL.SCSCL ||
      protocolOrFamily === PROTOCOL.SMS_STS ||
      protocolOrFamily === "scscl" ||
      protocolOrFamily === "sms_sts"
    ) {
      return "feetech"
    }
    return busTransportFamilyForProtocol(protocolOrFamily)
  })()

  if (family === "rj_sbus") {
    return {
      family: /** @type {BusTransportFamily} */ ("rj_sbus"),
      defaultBaud: DEFAULT_RJ_BAUDRATE,
      baudOptions: COMMON_RJ_BAUDRATES,
      label: "RJ_SBUS",
      shortLabel: "RJ",
    }
  }
  return {
    family: /** @type {BusTransportFamily} */ ("feetech"),
    defaultBaud: DEFAULT_SC_BAUDRATE,
    baudOptions: COMMON_BAUDRATES,
    label: "SC/ST",
    shortLabel: "SC/ST",
  }
}

export function busProtocolLabel(protocol) {
  const p = normalizeBusProtocol(protocol)
  if (p === PROTOCOL.SMS_STS) return "ST32 360° 总线舵机"
  if (p === PROTOCOL.RJ_SBUS) return "锐捷 RJ_SBUS 总线舵机"
  return "SC 300° 总线舵机"
}
