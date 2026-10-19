/**
 * 旧逻辑 PWM（500–2500）经 actuator profile 下发到总线舵机。
 * 供 FrameEditor / ServoControl 等历史页面在移除 PWM 文本协议后继续实发。
 */

import { createServoAdapter } from "../../servoAdapters/index.js"
import { writeLogicalValueWithProfile } from "../../servoAdapters/scservo/scServoLabMotion.js"
import { pwmLogicalToBusLogical } from "../../servoAdapters/busServo/pwmLogicalToBusLogical.js"
import { resolveBusTransport, getActiveBusTransportLabel } from "../../servoAdapters/busServo/resolveBusTransport.js"
import { loadActuatorProfiles } from "../loadActuatorProfiles.js"
import { PROTOCOL } from "../../servoAdapters/core/servoTypes.js"

function resolveProfileForLegacyIndex(actuatorProfiles, legacyServoIndex) {
  const sid = Number(legacyServoIndex)
  return (actuatorProfiles || []).find(
    (p) =>
      p &&
      p.enabled !== false &&
      p.outputType !== "pwm" &&
      Number(p.legacyServoIndex) === sid
  )
}

/**
 * @param {number} legacyServoIndex
 * @param {number} logicalPwm 500–2500 逻辑空间
 * @param {{ timeMs?: number, profiles?: object[], openIfNeeded?: boolean }} [options]
 */
export async function sendLegacyLogicalPwmViaBus(
  legacyServoIndex,
  logicalPwm,
  { timeMs = 40, profiles = null, openIfNeeded = true } = {}
) {
  const bundle = profiles
    ? { actuatorProfiles: profiles, allowRealSend: profiles.length > 0 }
    : loadActuatorProfiles()

  const profile = resolveProfileForLegacyIndex(bundle.actuatorProfiles, legacyServoIndex)
  if (!profile) {
    return {
      ok: false,
      error: `无 legacyServoIndex=${legacyServoIndex} 的总线 actuator profile`,
    }
  }

  const protocol = profile.protocol || PROTOCOL.SCSCL
  const transport = resolveBusTransport(protocol)

  if (!transport.getStatus()?.connected) {
    if (!openIfNeeded) {
      return { ok: false, error: `${getActiveBusTransportLabel()} 串口未连接` }
    }
    try {
      await transport.open({ requestPortIfNeeded: true })
    } catch (e) {
      return { ok: false, error: e?.message || `${getActiveBusTransportLabel()} 串口未连接` }
    }
  }

  const busLogical = pwmLogicalToBusLogical(logicalPwm)
  const adapter = createServoAdapter(protocol, { transport })
  const writeProfile = {
    ...profile,
    id: profile.busServoId ?? profile.id,
    time: timeMs,
  }

  const res = await writeLogicalValueWithProfile(adapter, writeProfile, busLogical, {
    waitAck: false,
    requireCalibrated: false,
    allowManualWrite: true,
  })

  return {
    ok: Boolean(res.ok),
    error: res.error || "",
    busServoId: writeProfile.id,
    busLogical,
    targetPosition: res.sentTarget ?? res.targetPosition,
    txBytes: res.txBytes,
    protocol,
  }
}

/**
 * 对所有已配置总线 profile 回中位（logical 500）。
 */
export async function sendAllBusProfilesToCenter({ profiles = null, timeMs = 200 } = {}) {
  const bundle = profiles
    ? { actuatorProfiles: profiles }
    : loadActuatorProfiles()
  const list = (bundle.actuatorProfiles || []).filter(
    (p) => p && p.enabled !== false && p.outputType !== "pwm" && p.protocol
  )
  if (!list.length) {
    return { ok: false, error: "无可用总线 actuator profile", sent: 0 }
  }

  let sent = 0
  const errors = []
  for (const profile of list) {
    const protocol = profile.protocol || PROTOCOL.SCSCL
    const transport = resolveBusTransport(protocol)
    if (!transport.getStatus()?.connected) {
      try {
        await transport.open({ requestPortIfNeeded: true })
      } catch (e) {
        errors.push(
          `#${profile.busServoId ?? profile.id}: ${e?.message || `${getActiveBusTransportLabel()} 串口未连接`}`
        )
        continue
      }
    }
    const adapter = createServoAdapter(protocol, { transport })
    const writeProfile = {
      ...profile,
      id: profile.busServoId ?? profile.id,
      time: timeMs,
    }
    const res = await writeLogicalValueWithProfile(adapter, writeProfile, 500, {
      waitAck: false,
      requireCalibrated: false,
      allowManualWrite: true,
    })
    if (res.ok) sent += 1
    else errors.push(`#${writeProfile.id}: ${res.error || "fail"}`)
  }

  return {
    ok: sent > 0 && errors.length === 0,
    sent,
    error: errors.join("; "),
  }
}
