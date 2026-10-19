import assert from "node:assert/strict"
import {
  pickBestActuatorProfile,
  preferredProtocolFromBusTransportFamily,
} from "./actuatorProfilePick.js"
import { migrateLegacyBusProfilesToActuatorProfiles } from "./migrateLegacyBusProfilesToActuatorProfiles.js"
import { buildBusCommandsFromFinalOutputs } from "./adapters/busServoOutputAdapter.js"
import { PROTOCOL } from "../servoAdapters/core/servoTypes.js"
import { normalizeLabServoProfile } from "../servoAdapters/core/servoProfile.js"

const store = new Map()
const localStorageMock = {
  getItem(key) {
    return store.has(key) ? store.get(key) : null
  },
  setItem(key, value) {
    store.set(key, String(value))
  },
  removeItem(key) {
    store.delete(key)
  },
}
globalThis.localStorage = localStorageMock
globalThis.window = { localStorage: localStorageMock }

assert.equal(preferredProtocolFromBusTransportFamily("rj_sbus"), PROTOCOL.RJ_SBUS)
assert.equal(preferredProtocolFromBusTransportFamily("feetech"), null)

const rj = {
  actuatorKey: "servo_1",
  protocol: "rj_sbus",
  busServoId: 1,
  centerMode: "standard_window",
  enabled: true,
}
const stInstalled = {
  actuatorKey: "servo_1",
  protocol: "sms_sts",
  busServoId: 1,
  centerMode: "installed_center",
  installedCenterPosition: 2048,
  installedCenterValid: true,
  installedCenterCapturedAt: new Date().toISOString(),
  enabled: true,
}

const wrong = pickBestActuatorProfile([stInstalled, rj], { preferredProtocol: null })
/* 无 preferred 时走 majority；同票时插入顺序不稳定，只断言能选出一条 */
assert.ok(wrong && (wrong.protocol === "sms_sts" || wrong.protocol === "rj_sbus"))

const preferSt = pickBestActuatorProfile([rj, stInstalled], {
  preferredProtocol: PROTOCOL.SMS_STS,
})
assert.equal(preferSt.protocol, "sms_sts", "显式 preferred ST 时应选 ST")

const right = pickBestActuatorProfile([rj, stInstalled], {
  preferredProtocol: PROTOCOL.RJ_SBUS,
})
assert.equal(right.protocol, "rj_sbus", "UI 主用 RJ 时必须丢掉残留 ST")

/* 仅残留 ST：resolve 在 RJ 族下应覆盖为 rj_sbus（与舵机页一致），否则 ID2/4 绑定发飞特帧 */
{
  const { resolveActuatorProfile } = await import("./resolveActuatorProfile.js")
  const { getStoredBusTransportFamily, BUS_TRANSPORT_FAMILY_STORAGE_KEY } = await import(
    "../servoAdapters/busServo/resolveBusTransport.js"
  )
  localStorage.setItem(BUS_TRANSPORT_FAMILY_STORAGE_KEY, JSON.stringify("rj_sbus"))
  assert.equal(getStoredBusTransportFamily(), "rj_sbus")
  const stOnly = normalizeLabServoProfile({
    id: 2,
    protocol: PROTOCOL.SMS_STS,
    centerMode: "installed_center",
    installedCenterPosition: 2048,
    installedCenterValid: true,
  })
  const migratedStOnly = migrateLegacyBusProfilesToActuatorProfiles({
    oldProfiles: [stOnly],
    preferredProtocol: PROTOCOL.RJ_SBUS,
  })
  const resolved = resolveActuatorProfile({
    actuatorKey: "servo_2",
    legacyServoIndex: 2,
    profiles: migratedStOnly,
  })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.profile.protocol, "rj_sbus", "仅 ST 残留时 RJ 族须覆盖协议")
  const built2 = buildBusCommandsFromFinalOutputs(
    [
      {
        actuatorKey: "servo_2",
        legacyServoIndex: 2,
        logicalValue: 1000,
        pwmValue: 2500,
        enabled: true,
      },
    ],
    [resolved.profile]
  )
  assert.equal(built2.commands[0]?.protocol, "rj_sbus")
  localStorage.removeItem(BUS_TRANSPORT_FAMILY_STORAGE_KEY)
}

const rjLab = normalizeLabServoProfile({ id: 1, protocol: PROTOCOL.RJ_SBUS })
const stLab = normalizeLabServoProfile({
  id: 1,
  protocol: PROTOCOL.SMS_STS,
  centerMode: "installed_center",
  installedCenterPosition: 2048,
  installedCenterCapturedAt: new Date().toISOString(),
  calibrated: true,
})
const migrated = migrateLegacyBusProfilesToActuatorProfiles({
  oldProfiles: [rjLab, stLab],
  preferredProtocol: PROTOCOL.RJ_SBUS,
})
assert.equal(migrated.length, 1)
assert.equal(migrated[0].protocol, "rj_sbus")

const built = buildBusCommandsFromFinalOutputs(
  [
    {
      actuatorKey: "servo_1",
      legacyServoIndex: 1,
      logicalValue: 1000,
      pwmValue: 2500,
      enabled: true,
    },
  ],
  migrated
)
assert.equal(built.commands[0].protocol, "rj_sbus")
assert.equal(built.commands[0].targetPosition, 900)

console.log("actuatorProfilePick.rjPreferred.selftest: ok")
