import {
  buildCenterFinalServoOutputs,
  buildProfileNeutralFinalServoOutputs,
  listActuatorKeysFromBindings,
} from "../output/buildCenterFinalServoOutputs.js"
import { loadActuatorProfiles } from "../output/loadActuatorProfiles.js"
import { sendBusServoOutputs } from "../output/adapters/busServoOutputAdapter.js"
import {
  normalizeBusTransportFamily,
  resolveBusBaudConfig,
  resolveBusTransportByFamily,
} from "../servoAdapters/busServo/resolveBusTransport.js"
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
 * Stop / Disarm 回中：统一经 finalServoOutputs → Bus Servo Output Adapter。
 * @param {object} params
 */
export async function sendTrackingPreviewCenterServos({
  profile,
  configs = [],
  timeMs = DEVICE_DRIVE_DEFAULTS.servoTimeMs,
  transportFamily = "feetech",
  baudRate = null,
  outputMode = OUTPUT_MODES.BUS_SERVO,
  busMoveTimeMs = null,
  busTxMode = "hybrid",
  repeatCount = 1,
  repeatIntervalMs = 0,
  waitAfterLastMs = 0,
} = {}) {
  void outputMode
  void configs

  const family = normalizeBusTransportFamily(transportFamily)
  const transport = resolveBusTransportByFamily(family)
  const baudCfg = resolveBusBaudConfig(family)
  const openBaud = Number(baudRate) || baudCfg.defaultBaud

  const profileN = profile && typeof profile === "object" ? profile : null
  const finalOutputs = profileN
    ? buildProfileNeutralFinalServoOutputs({ profile: profileN, configs })
    : buildCenterFinalServoOutputs(listActuatorKeysFromBindings(profile))

  if (!finalOutputs.length) {
    return { ok: false, reason: "empty-command" }
  }

  const repeats = Math.max(1, Math.round(Number(repeatCount) || 1))
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

  const moveTime = busMoveTimeMs ?? timeMs
  const profiles = withBusMoveTime(actuatorProfiles, moveTime)

  let lastSend = /** @type {any} */ (null)
  for (let i = 0; i < repeats; i += 1) {
    if (i > 0) {
      await sleep(repeatIntervalMs)
    }
    lastSend = await sendBusServoOutputs(finalOutputs, profiles, {
      transport,
      txMode: busTxMode,
      scSyncMode: DEVICE_DRIVE_DEFAULTS.scsclSyncMode,
      scsclBroadcastId: DEVICE_DRIVE_DEFAULTS.scsclBroadcastId,
    })
    if (!lastSend.ok) {
      break
    }
  }

  await sleep(waitAfterLastMs)

  const preview = (lastSend?.built?.commands || [])
    .map((c) => `${c.actuatorKey}→#${c.busServoId} pos=${c.targetPosition}`)
    .join(" ")
  return {
    ok: Boolean(lastSend?.ok),
    command: `BUS center×${repeats}: ${preview}`,
    reason: lastSend?.ok ? "" : lastSend?.error,
    skipped: lastSend?.built?.skipped,
  }
}
