import { loadActuatorProfiles } from "../output/loadActuatorProfiles.js"
import { buildBusCommandsFromFinalOutputs } from "../output/adapters/busServoOutputAdapter.js"
import { sendBusServoCommands } from "../servoAdapters/busServo/sendBusServoCommands.js"
import {
  normalizeBusTransportFamily,
  resolveBusBaudConfig,
  resolveBusTransportByFamily,
} from "../servoAdapters/busServo/resolveBusTransport.js"
import { LOGICAL_CENTER } from "../output/finalServoOutputTypes.js"
import { logicalToPwm } from "../output/pwmLogicalConvert.js"
import { DEVICE_DRIVE_DEFAULTS, OUTPUT_MODES } from "./trackingPreviewConstants.js"

function sleep(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return Promise.resolve()
  }
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function withBusMoveTime(profiles, moveTimeMs) {
  const t = Number(moveTimeMs)
  if (!Number.isFinite(t) || t <= 0 || !profiles?.length) {
    return profiles
  }
  return profiles.map((p) => ({
    ...p,
    time: Math.max(Number(p.time) || 0, t),
  }))
}

/**
 * 将 finalServoOutputs 从 fromLogical 线性插值到目标（t∈(0,1]）。
 */
export function blendFinalOutputsToward(targetOutputs, t, fromLogical = LOGICAL_CENTER) {
  const ratio = Math.max(0, Math.min(1, Number(t) || 0))
  const from = Number(fromLogical)
  return (targetOutputs || []).map((out) => {
    const targetLv = Number(out.logicalValue)
    const lv = Number.isFinite(targetLv)
      ? from + (targetLv - from) * ratio
      : from
    return {
      ...out,
      logicalValue: lv,
      pwmValue: logicalToPwm(lv),
      sourceType: out.sourceType || "arm-warmup",
    }
  })
}

/**
 * Arm Device Drive 平滑过渡：从中位 linear 过渡到当前 tracking 目标（总线）。
 */
export async function sendTrackingPreviewArmWarmup({
  targetFinalOutputs = [],
  configs = [],
  outputMode = OUTPUT_MODES.BUS_SERVO,
  transportFamily = "feetech",
  baudRate = null,
  steps = 6,
  stepIntervalMs = 120,
  busMoveTimeMs = 220,
  fromLogical = LOGICAL_CENTER,
  busTxMode = "hybrid",
} = {}) {
  void configs
  void outputMode

  if (!targetFinalOutputs.length) {
    return { ok: false, reason: "empty-target" }
  }

  const family = normalizeBusTransportFamily(transportFamily)
  const transport = resolveBusTransportByFamily(family)
  const baudCfg = resolveBusBaudConfig(family)
  const openBaud = Number(baudRate) || baudCfg.defaultBaud

  const stepCount = Math.max(1, Math.round(Number(steps) || 1))
  let lastCommands = []

  const { actuatorProfiles, allowRealSend } = loadActuatorProfiles()
  if (!allowRealSend) {
    return { ok: false, reason: "no-profiles" }
  }

  if (!transport.getStatus()?.connected) {
    try {
      await transport.open({
        baudRate: openBaud,
        requestPortIfNeeded: true,
      })
    } catch {
      return { ok: false, reason: "not-connected" }
    }
  }

  const profiles = withBusMoveTime(actuatorProfiles, busMoveTimeMs)

  for (let i = 1; i <= stepCount; i += 1) {
    const blended = blendFinalOutputsToward(targetFinalOutputs, i / stepCount, fromLogical)
    const built = buildBusCommandsFromFinalOutputs(blended, profiles, {
      actuatorSafety: { enabled: false },
    })
    if (!built.commands.length) {
      return { ok: false, reason: "empty-command" }
    }
    const writeResult = await sendBusServoCommands(built.commands, {
      transport,
      txMode: busTxMode,
      scSyncMode: DEVICE_DRIVE_DEFAULTS.scsclSyncMode,
      scsclBroadcastId: DEVICE_DRIVE_DEFAULTS.scsclBroadcastId,
    })
    if (!writeResult.ok) {
      return { ok: false, reason: writeResult.error || "bus-write-failed", step: i }
    }
    lastCommands = built.commands
    if (i < stepCount) {
      await sleep(stepIntervalMs)
    }
  }

  return { ok: true, stepCount, lastCommands, mode: "bus-servo" }
}
