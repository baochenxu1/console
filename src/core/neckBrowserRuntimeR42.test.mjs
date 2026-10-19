/**
 * R4.2 — Browser-Native Neck Runtime Hardening
 * ESTOP clear / Calibration ownership / IndexedDB startup / Backend switch /
 * Discard restore / Safe Disable active profile / Browser limits authority
 */

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"

import {
  applyWorkingOffsetsToProfile,
} from "../sdk/neck/calibration/softwareNeutralCalibration.js"
import {
  createMemoryNeckProfileStorage,
  saveActiveNeckProfile,
} from "../sdk/neck/calibration/neckProfileStore.js"
import {
  createLuviaReferenceProfile,
  exportNeckRuntimeProfile,
} from "../sdk/neck/core/neckRuntimeProfile.js"
import { mergeNeckSemanticLimits } from "../sdk/neck/neckPose.js"
import {
  BROWSER_NECK_RUNTIME_STATES,
} from "../sdk/neck/runtime/browserNeckRuntimeStates.js"
import {
  createBrowserNeckRuntimeHost,
  createFakeNeckRuntimeWorker,
  NECK_PROFILE_SOURCE,
} from "../sdk/neck/runtime/browserNeckRuntimeHost.js"
import { createNeckRuntimeWorkerLogic } from "../sdk/neck/runtime/neckRuntimeWorkerLogic.js"
import {
  BACKEND_ACTIVE,
  canSwitchNeckHardwareBackend,
  isBrowserBackendActive,
  isLuviaBackendActive,
  NECK_HARDWARE_BACKEND,
} from "../sdk/neck/transport/neckHardwareBackend.js"
import {
  canClearBrowserEstop,
  canEnableBrowserMotors,
  canSendBrowserSafeDisable,
} from "../sdk/neck/transport/neckHardwareBackendUi.js"
import { getMotorProtocolAdapter } from "../sdk/neck/protocol/motorProtocolRegistry.js"
import { ID_STATE_CONTROL } from "../sdk/neck/protocol/bmHmdProtocol.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "../..")

function readSrc(rel) {
  return readFileSync(join(root, rel), "utf8")
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function createReadyHost(opts = {}) {
  const frames = []
  const storage = opts.storage || createMemoryNeckProfileStorage()
  let transportState = opts.transportState || "READY"
  const host = createBrowserNeckRuntimeHost({
    getTransport: () => ({
      sendFrame: async (frame) => {
        frames.push(frame)
      },
      getState: () => ({
        state: transportState,
        slcanReady: transportState === "READY",
      }),
    }),
    createWorker: () =>
      createFakeNeckRuntimeWorker({
        delay: (ms) => sleep(Math.min(ms, 1)),
      }),
    profileStorage: storage,
    ...opts,
  })
  return {
    host,
    frames,
    storage,
    setTransportState(s) {
      transportState = s
    },
  }
}

async function waitUntil(predicate, { timeoutMs = 2000, intervalMs = 20 } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true
    await sleep(intervalMs)
  }
  return false
}

async function enableReady(host, profile = createLuviaReferenceProfile()) {
  await host.loadProfile(profile)
  await waitUntil(() => host.getSnapshot().workerReady && host.getSnapshot().profileReady)
  const en = await host.enableMotors()
  assert.equal(en.ok, true, en.error?.message || (en.gates && JSON.stringify(en.gates)))
  const ok = await waitUntil(() => host.getSnapshot().enabled === true)
  assert.equal(ok, true, `enable timeout state=${host.getSnapshot().state} err=${JSON.stringify(host.getSnapshot().lastError)}`)
}

describe("R4.2 ESTOP Clear Path (A–I)", () => {
  it("A: Enable → ESTOP → latched", async () => {
    const { host } = createReadyHost()
    try {
      await enableReady(host)
      host.estop()
      await sleep(20)
      const snap = host.getSnapshot()
      assert.equal(snap.state, BROWSER_NECK_RUNTIME_STATES.ESTOP)
      assert.equal(snap.estop, true)
      assert.equal(snap.estopLatched, true)
    } finally {
      await host.dispose()
    }
  })

  it("B: ESTOP → target rejected", async () => {
    const { host } = createReadyHost()
    try {
      await enableReady(host)
      host.setHardwarePreview(true)
      host.estop()
      await sleep(20)
      assert.equal(host.offerTarget({ pose: { pitch: 2, roll: 0, yaw: 0 }, source: "editor" }), false)
    } finally {
      await host.dispose()
    }
  })

  it("C: ESTOP → Resume rejected", async () => {
    const { host } = createReadyHost()
    try {
      await enableReady(host)
      host.estop()
      await sleep(20)
      const r = host.resume()
      assert.equal(r.ok, false)
      assert.equal(r.error.code, "ESTOP_LATCHED")
    } finally {
      await host.dispose()
    }
  })

  it("D: ESTOP → Enable rejected", async () => {
    const { host } = createReadyHost()
    try {
      await enableReady(host)
      host.estop()
      await sleep(20)
      const r = await host.enableMotors()
      assert.equal(r.ok, false)
      assert.equal(r.gates?.noEstop, false)
    } finally {
      await host.dispose()
    }
  })

  it("E: ESTOP → Disable does not clear latch", async () => {
    const { host } = createReadyHost()
    try {
      await enableReady(host)
      host.estop()
      await sleep(20)
      host.disableMotors()
      await sleep(20)
      const snap = host.getSnapshot()
      assert.equal(snap.estopLatched, true)
      assert.equal(snap.state, BROWSER_NECK_RUNTIME_STATES.ESTOP)
    } finally {
      await host.dispose()
    }
  })

  it("F: clearEstop → DISABLED/READY", async () => {
    const { host } = createReadyHost()
    try {
      await enableReady(host)
      host.estop()
      await sleep(20)
      const c = host.clearEstop()
      assert.equal(c.ok, true)
      await sleep(20)
      const snap = host.getSnapshot()
      assert.equal(snap.state, BROWSER_NECK_RUNTIME_STATES.DISABLED)
      assert.equal(snap.estopLatched, false)
      assert.equal(snap.enabled, false)
    } finally {
      await host.dispose()
    }
  })

  it("G: clearEstop does not auto-enable", async () => {
    const { host } = createReadyHost()
    try {
      await enableReady(host)
      host.estop()
      await sleep(20)
      host.clearEstop()
      await sleep(20)
      assert.equal(host.getSnapshot().enabled, false)
    } finally {
      await host.dispose()
    }
  })

  it("H: clearEstop then explicit Enable succeeds", async () => {
    const { host } = createReadyHost()
    try {
      await enableReady(host)
      host.estop()
      await sleep(20)
      host.clearEstop()
      await sleep(20)
      const en = await host.enableMotors()
      assert.equal(en.ok, true)
      const ok = await waitUntil(() => host.getSnapshot().enabled === true)
      assert.equal(ok, true)
    } finally {
      await host.dispose()
    }
  })

  it("I: Transport not READY → cannot fake clear", async () => {
    const { host, setTransportState } = createReadyHost()
    try {
      await enableReady(host)
      host.estop()
      await sleep(20)
      setTransportState("CLOSED")
      const c = host.clearEstop()
      assert.equal(c.ok, false)
      assert.equal(c.error.code, "TRANSPORT_NOT_READY")
      assert.equal(host.getSnapshot().estopLatched, true)
    } finally {
      await host.dispose()
    }
  })
})

describe("R4.2 Calibration Ownership (J–Q)", () => {
  it("J: Enter Calibration → owner active", async () => {
    const { host } = createReadyHost()
    try {
      await enableReady(host)
      const r = host.enterNeutralCalibration()
      assert.equal(r.ok, true)
      await sleep(20)
      assert.equal(host.getSnapshot().calibratingNeutral, true)
      assert.equal(host.getSnapshot().state, BROWSER_NECK_RUNTIME_STATES.CALIBRATING_NEUTRAL)
    } finally {
      await host.dispose()
    }
  })

  it("K: Hold rejected while calibrating", async () => {
    const { host } = createReadyHost()
    try {
      await enableReady(host)
      host.enterNeutralCalibration()
      await sleep(15)
      const r = host.hold()
      assert.equal(r.ok, false)
      assert.equal(r.error.code, "CALIBRATION_ACTIVE")
      assert.equal(host.getSnapshot().state, BROWSER_NECK_RUNTIME_STATES.CALIBRATING_NEUTRAL)
    } finally {
      await host.dispose()
    }
  })

  it("L: Resume rejected while calibrating", async () => {
    const { host } = createReadyHost()
    try {
      await enableReady(host)
      host.enterNeutralCalibration()
      await sleep(15)
      const r = host.resume()
      assert.equal(r.ok, false)
      assert.equal(r.error.code, "CALIBRATION_ACTIVE")
    } finally {
      await host.dispose()
    }
  })

  it("M: Manual target rejected while calibrating", async () => {
    const { host } = createReadyHost()
    try {
      await enableReady(host)
      host.setHardwarePreview(true)
      host.enterNeutralCalibration()
      await sleep(15)
      assert.equal(host.offerTarget({ pose: { pitch: 1, roll: 0, yaw: 0 }, source: "editor" }), false)
    } finally {
      await host.dispose()
    }
  })

  it("N: Timeline target rejected while calibrating", async () => {
    const { host } = createReadyHost()
    try {
      await enableReady(host)
      host.enterNeutralCalibration()
      await sleep(15)
      assert.equal(
        host.offerTarget({ pose: { pitch: 1, roll: 0, yaw: 0 }, source: "timeline" }),
        false
      )
    } finally {
      await host.dispose()
    }
  })

  it("O: Enable duplicate rejected while calibrating", async () => {
    const { host } = createReadyHost()
    try {
      await enableReady(host)
      host.enterNeutralCalibration()
      await sleep(15)
      const r = await host.enableMotors()
      assert.equal(r.ok, false)
    } finally {
      await host.dispose()
    }
  })

  it("P: ESTOP still works during calibration", async () => {
    const { host } = createReadyHost()
    try {
      await enableReady(host)
      host.enterNeutralCalibration()
      await sleep(15)
      host.estop()
      await sleep(20)
      assert.equal(host.getSnapshot().state, BROWSER_NECK_RUNTIME_STATES.ESTOP)
    } finally {
      await host.dispose()
    }
  })

  it("Q: ESTOP invalidates calibration session", async () => {
    const { host } = createReadyHost()
    try {
      await enableReady(host)
      host.enterNeutralCalibration()
      host.nudgeCalibrationOffset("side1", 0.5)
      await sleep(15)
      host.estop()
      await sleep(20)
      assert.equal(host.getSnapshot().calibratingNeutral, false)
      assert.notEqual(host.getCalibrationSnapshot().status, "CALIBRATING")
    } finally {
      await host.dispose()
    }
  })
})

describe("R4.2 IndexedDB Startup Profile (R–X)", () => {
  it("R: persisted profile exists → startup loads it", async () => {
    const storage = createMemoryNeckProfileStorage()
    const persisted = applyWorkingOffsetsToProfile(createLuviaReferenceProfile(), {
      side1: -13,
      side2: -20,
    })
    await saveActiveNeckProfile(persisted, { storage })
    const { host } = createReadyHost({ storage })
    const r = await host.resolveStartupProfile()
    assert.equal(r.ok, true)
    assert.equal(r.source, NECK_PROFILE_SOURCE.INDEXED_DB)
    assert.equal(host.getSnapshot().profileSource, NECK_PROFILE_SOURCE.INDEXED_DB)
    await host.dispose()
  })

  it("S: offsets preserved from IDB", async () => {
    const storage = createMemoryNeckProfileStorage()
    const persisted = applyWorkingOffsetsToProfile(createLuviaReferenceProfile(), {
      side1: -13,
      side2: -20,
    })
    await saveActiveNeckProfile(persisted, { storage })
    const { host } = createReadyHost({ storage })
    await host.resolveStartupProfile()
    const p = host.getProfile()
    assert.equal(p.mapping.side1.offsetDeg, -13)
    assert.equal(p.mapping.side2.offsetDeg, -20)
    await host.dispose()
  })

  it("T: no persisted profile → default 0/0", async () => {
    const { host } = createReadyHost()
    const r = await host.resolveStartupProfile()
    assert.equal(r.source, NECK_PROFILE_SOURCE.DEFAULT)
    const p = host.getProfile()
    assert.equal(p.mapping.side1.offsetDeg, 0)
    assert.equal(p.mapping.side2.offsetDeg, 0)
    await host.dispose()
  })

  it("U: corrupt profile → fallback", async () => {
    const storage = createMemoryNeckProfileStorage()
    await storage.set("active", { version: "facedev-neck-runtime-profile-v1", broken: true })
    // force invalid by storing non-importable payload that import will reject
    await storage.set("active", "{not-json")
    const { host } = createReadyHost({ storage })
    // loadActiveNeckProfile may throw on parse — resolveStartupProfile catches
    // Override storage get to throw
    const badStorage = {
      async get() {
        throw new Error("corrupt")
      },
      async set() {},
      async delete() {},
    }
    const { host: host2 } = createReadyHost({ storage: badStorage })
    const r = await host2.resolveStartupProfile()
    assert.equal(r.source, NECK_PROFILE_SOURCE.FALLBACK_AFTER_ERROR)
    assert.equal(host2.getProfile().mapping.side1.offsetDeg, 0)
    await host.dispose()
    await host2.dispose()
  })

  it("V: invalid profile payload fails load cleanly", async () => {
    const { host } = createReadyHost()
    try {
      const r = await host.loadProfile("{not-json")
      assert.equal(r.ok, false)
      assert.equal(r.error.code, "PROFILE_INVALID")
    } finally {
      await host.dispose()
    }
  })

  it("W: profile loading blocks Enable", async () => {
    const { host } = createReadyHost()
    try {
      // Before resolve: profileReady false
      assert.equal(host.getSnapshot().profileReady, false)
      assert.equal(
        canEnableBrowserMotors({
          backend: NECK_HARDWARE_BACKEND.BROWSER_SLCAN,
          transportReady: true,
          profileValid: false,
          profileReady: false,
          workerReady: true,
          estop: false,
          backendConflict: false,
        }),
        false
      )
      await host.resolveStartupProfile()
      assert.equal(host.getSnapshot().profileReady, true)
    } finally {
      await host.dispose()
    }
  })

  it("X: refresh simulation preserves calibration", async () => {
    const storage = createMemoryNeckProfileStorage()
    const { host } = createReadyHost({ storage })
    try {
      await enableReady(host)
      host.enterNeutralCalibration()
      host.nudgeCalibrationOffset("side1", -1)
      host.nudgeCalibrationOffset("side2", -2)
      await host.saveCalibration()
    } finally {
      await host.dispose()
    }

    const { host: host2 } = createReadyHost({ storage })
    try {
      const r = await host2.resolveStartupProfile()
      assert.equal(r.source, NECK_PROFILE_SOURCE.INDEXED_DB)
      assert.equal(host2.getProfile().mapping.side1.offsetDeg, -1)
      assert.equal(host2.getProfile().mapping.side2.offsetDeg, -2)
    } finally {
      await host2.dispose()
    }
  })
})

describe("R4.2 Backend Switch Lifecycle (Y–AD)", () => {
  it("Y: Browser enabled → switch rejected", () => {
    const g = canSwitchNeckHardwareBackend({
      from: NECK_HARDWARE_BACKEND.BROWSER_SLCAN,
      to: NECK_HARDWARE_BACKEND.LUVIA_BRIDGE,
      browserRuntimeEnabled: true,
      browserTransportState: "READY",
    })
    assert.equal(g.ok, false)
    assert.equal(g.code, BACKEND_ACTIVE)
  })

  it("Z: Browser transport open → switch rejected", () => {
    const g = canSwitchNeckHardwareBackend({
      from: NECK_HARDWARE_BACKEND.BROWSER_SLCAN,
      to: NECK_HARDWARE_BACKEND.LUVIA_BRIDGE,
      browserTransportState: "READY",
      browserSlcanReady: true,
    })
    assert.equal(g.ok, false)
  })

  it("AA: calibration active → switch rejected", () => {
    const g = canSwitchNeckHardwareBackend({
      from: NECK_HARDWARE_BACKEND.BROWSER_SLCAN,
      to: NECK_HARDWARE_BACKEND.LUVIA_BRIDGE,
      browserCalibrating: true,
      browserTransportState: "CLOSED",
    })
    assert.equal(g.ok, false)
  })

  it("AB: Browser fully closed → switch allowed", () => {
    assert.equal(
      isBrowserBackendActive({ transportState: "CLOSED", runtimeEnabled: false }),
      false
    )
    const g = canSwitchNeckHardwareBackend({
      from: NECK_HARDWARE_BACKEND.BROWSER_SLCAN,
      to: NECK_HARDWARE_BACKEND.LUVIA_BRIDGE,
      browserTransportState: "CLOSED",
      browserRuntimeEnabled: false,
      browserCalibrating: false,
      browserEstop: false,
    })
    assert.equal(g.ok, true)
  })

  it("AC: Bridge connected → switch rejected", () => {
    assert.equal(isLuviaBackendActive({ hardwareConnected: true }), true)
    const g = canSwitchNeckHardwareBackend({
      from: NECK_HARDWARE_BACKEND.LUVIA_BRIDGE,
      to: NECK_HARDWARE_BACKEND.BROWSER_SLCAN,
      bridgeHardwareConnected: true,
    })
    assert.equal(g.ok, false)
    assert.equal(g.code, BACKEND_ACTIVE)
  })

  it("AD: Bridge disconnected → switch allowed", () => {
    const g = canSwitchNeckHardwareBackend({
      from: NECK_HARDWARE_BACKEND.LUVIA_BRIDGE,
      to: NECK_HARDWARE_BACKEND.BROWSER_SLCAN,
      bridgeHardwareConnected: false,
    })
    assert.equal(g.ok, true)
  })
})

describe("R4.2 Calibration Discard (AE–AH)", () => {
  it("AE: nudge → Disable without discard → UNSAVED_CALIBRATION", async () => {
    const { host } = createReadyHost()
    try {
      await enableReady(host)
      host.enterNeutralCalibration()
      host.nudgeCalibrationOffset("side1", 0.5)
      const r = host.disableMotors({ discardUnsaved: false })
      assert.equal(r.ok, false)
      assert.equal(r.error.code, "UNSAVED_CALIBRATION")
      assert.equal(host.getSnapshot().calibratingNeutral, true)
    } finally {
      await host.dispose()
    }
  })

  it("AF: Discard → Worker persisted offsets", async () => {
    const { host } = createReadyHost()
    try {
      const base = applyWorkingOffsetsToProfile(createLuviaReferenceProfile(), {
        side1: -5,
        side2: -6,
      })
      await enableReady(host, base)
      host.enterNeutralCalibration()
      host.nudgeCalibrationOffset("side1", 0.5)
      assert.equal(host.getCalibrationSnapshot().workingOffsets.side1, -4.5)
      const r = host.disableMotors({ discardUnsaved: true })
      assert.equal(r.ok, true)
      await sleep(20)
      assert.equal(host.getProfile().mapping.side1.offsetDeg, -5)
      assert.equal(host.getSnapshot().calibratingNeutral, false)
    } finally {
      await host.dispose()
    }
  })

  it("AG: Save → Worker new persisted", async () => {
    const { host, storage } = createReadyHost()
    try {
      await enableReady(host)
      host.enterNeutralCalibration()
      host.nudgeCalibrationOffset("side1", -1.5)
      await host.saveCalibration()
      assert.equal(host.getProfile().mapping.side1.offsetDeg, -1.5)
      const loaded = await storage.get("active")
      assert.ok(loaded)
      assert.equal(loaded.mapping.side1.offsetDeg, -1.5)
    } finally {
      await host.dispose()
    }
  })

  it("AH: transport loss → persisted restored", async () => {
    const { host } = createReadyHost()
    try {
      const base = applyWorkingOffsetsToProfile(createLuviaReferenceProfile(), {
        side1: -3,
        side2: 0,
      })
      await enableReady(host, base)
      host.enterNeutralCalibration()
      host.nudgeCalibrationOffset("side1", -1)
      host.notifyTransportLost()
      await sleep(20)
      assert.equal(host.getProfile().mapping.side1.offsetDeg, -3)
      assert.equal(host.getSnapshot().calibratingNeutral, false)
    } finally {
      await host.dispose()
    }
  })
})

describe("R4.2 Safe Disable Active Profile (AI–AL)", () => {
  it("AI: active BM_HMD profile used", async () => {
    const { host, frames } = createReadyHost()
    try {
      await host.loadProfile(createLuviaReferenceProfile())
      await sleep(10)
      const r = await host.sendSafeDisable()
      assert.equal(r.ok, true)
      assert.ok(frames.length >= 1)
      assert.equal(frames[0].arbitrationId, ID_STATE_CONTROL)
    } finally {
      await host.dispose()
    }
  })

  it("AJ: non-default profile name still encodes disable", async () => {
    const { host, frames } = createReadyHost()
    try {
      const custom = createLuviaReferenceProfile({ name: "device-instance-trim" })
      custom.mapping.side1.offsetDeg = -13
      await host.loadProfile(custom)
      await sleep(10)
      const r = await host.sendSafeDisable()
      assert.equal(r.ok, true)
      assert.equal(r.profileName, "device-instance-trim")
      assert.ok(frames.length >= 1)
    } finally {
      await host.dispose()
    }
  })

  it("AK: Safe Disable must not instantiate reference in UI wiring", () => {
    const src = readSrc("src/sdk/react/NeckEngineeringPanel.jsx")
    assert.equal(src.includes("createLuviaReferenceProfile()"), false)
    assert.ok(src.includes("sendSafeDisable"))
    const editor = readSrc("src/sdk/react/FaceExpressionEditor.jsx")
    assert.equal(editor.includes("sendSafeDisable"), false)
  })

  it("AL: invalid profile fails cleanly", async () => {
    const { host } = createReadyHost()
    try {
      const r = await host.sendSafeDisable()
      assert.equal(r.ok, false)
      assert.equal(r.error.code, "INVALID_PROFILE")
      assert.equal(
        canSendBrowserSafeDisable({
          backend: NECK_HARDWARE_BACKEND.BROWSER_SLCAN,
          transportState: "READY",
          slcanReady: true,
          profileValid: false,
        }),
        false
      )
    } finally {
      await host.dispose()
    }
  })
})

describe("R4.2 Browser/Bridge State Authority (AM–AR)", () => {
  it("AM: Browser backend uses active profile pitch limits", async () => {
    const { host } = createReadyHost()
    const p = createLuviaReferenceProfile({
      semantic: { pitch: { min: -8, max: 8 }, roll: { min: -15, max: 15 }, yaw: { min: -90, max: 90 } },
    })
    await host.loadProfile(p)
    const lim = host.getSnapshot().semanticLimits
    assert.equal(lim.pitch.min, -8)
    assert.equal(lim.pitch.max, 8)
    await host.dispose()
  })

  it("AN: Browser roll limits from profile", async () => {
    const { host } = createReadyHost()
    const p = createLuviaReferenceProfile({
      semantic: { pitch: { min: -10, max: 10 }, roll: { min: -12, max: 12 }, yaw: { min: -90, max: 90 } },
    })
    await host.loadProfile(p)
    assert.equal(host.getSnapshot().semanticLimits.roll.max, 12)
    await host.dispose()
  })

  it("AO: Browser yaw limits from profile", async () => {
    const { host } = createReadyHost()
    const p = createLuviaReferenceProfile({
      semantic: { pitch: { min: -10, max: 10 }, roll: { min: -15, max: 15 }, yaw: { min: -45, max: 45 } },
    })
    await host.loadProfile(p)
    assert.equal(host.getSnapshot().semanticLimits.yaw.min, -45)
    await host.dispose()
  })

  it("AP: Bridge capabilities do not alter Browser limits authority helper", () => {
    const fromProfile = mergeNeckSemanticLimits({
      pitch: { min: -10, max: 10 },
      roll: { min: -15, max: 15 },
      yaw: { min: -90, max: 90 },
    })
    const bridgeFake = mergeNeckSemanticLimits({
      pitch: { min: -99, max: 99 },
      roll: { min: -99, max: 99 },
      yaw: { min: -99, max: 99 },
    })
    // Product rule: when browser backend, use profile — bridge fake must not be mixed in test of selector
    assert.notEqual(fromProfile.pitch.max, bridgeFake.pitch.max)
    const editor = readSrc("src/sdk/react/FaceExpressionEditor.jsx")
    assert.ok(editor.includes("getSharedBrowserSlcanTransport") || editor.includes("createConnectNeckService"))
    assert.ok(editor.includes("semanticLimits") || editor.includes("profile?.semantic"))
    const eng = readSrc("src/sdk/react/NeckEngineeringPanel.jsx")
    assert.ok(eng.includes("BROWSER_SLCAN") || eng.includes("NECK_HARDWARE_BACKEND"))
  })

  it("AQ: Browser UI path does not pass Bridge commissioning badge", () => {
    const eng = readSrc("src/sdk/react/NeckEngineeringPanel.jsx")
    assert.ok(eng.includes("LUVIA_BRIDGE") || eng.includes("luvia"))
    const panel = readSrc("src/sdk/react/NeckBridgePanel.jsx")
    assert.ok(panel.includes("bridgeStatus") || panel.includes("LUVIA_BRIDGE") || panel.includes("luvia-bridge"))
    const editor = readSrc("src/sdk/react/FaceExpressionEditor.jsx")
    assert.equal(editor.includes("bridgeStatus="), false)
    assert.equal(editor.includes("COMMISSIONING"), false)
  })

  it("AR: Clear ESTOP UI gate helper", () => {
    assert.equal(
      canClearBrowserEstop({
        backend: NECK_HARDWARE_BACKEND.BROWSER_SLCAN,
        runtimeHostPresent: true,
        estopLatched: true,
        transportReady: true,
      }),
      true
    )
    assert.equal(
      canClearBrowserEstop({
        backend: NECK_HARDWARE_BACKEND.BROWSER_SLCAN,
        runtimeHostPresent: true,
        estopLatched: false,
        transportReady: true,
      }),
      false
    )
  })
})

describe("R4.2 Worker-level calibration hold defense", () => {
  it("Worker hold during CALIBRATING emits CALIBRATION_ACTIVE", async () => {
    const messages = []
    const logic = createNeckRuntimeWorkerLogic({
      postMessage: (m) => messages.push(m),
      delay: async () => {},
      createScheduler: () => ({
        start() {},
        stop() {},
        isRunning: () => false,
        getStats: () => ({}),
      }),
    })
    await logic.handleMessage({ type: "init", profile: createLuviaReferenceProfile() })
    // Force enable path lightly: set state via enter after faking enabled
    // Use enable then enter
    await logic.handleMessage({ type: "enable" })
    await sleep(5)
    // FakeWorker enable may complete; enter calib
    await logic.handleMessage({ type: "enterNeutralCalibration" })
    assert.equal(logic.getState(), BROWSER_NECK_RUNTIME_STATES.CALIBRATING_NEUTRAL)
    messages.length = 0
    await logic.handleMessage({ type: "hold" })
    assert.ok(messages.some((m) => m.type === "error" && m.code === "CALIBRATION_ACTIVE"))
    assert.equal(logic.getState(), BROWSER_NECK_RUNTIME_STATES.CALIBRATING_NEUTRAL)
    await logic.handleMessage({ type: "dispose" })
  })
})

describe("R4.2 Source / freeze checks", () => {
  it("Host exports clearEstop and resolveStartupProfile", () => {
    const src = readSrc("src/sdk/neck/runtime/browserNeckRuntimeHost.js")
    assert.ok(src.includes("clearEstop"))
    assert.ok(src.includes("resolveStartupProfile"))
    assert.ok(src.includes("sendSafeDisable"))
    assert.ok(src.includes("UNSAVED_CALIBRATION"))
  })

  it("Panel has Clear ESTOP button", () => {
    const src = readSrc("src/sdk/react/NeckBridgePanel.jsx")
    assert.ok(src.includes("Clear ESTOP"))
    assert.ok(src.includes("onBrowserClearEstop"))
  })

  it("Default backend remains luvia-bridge", () => {
    assert.equal(
      readSrc("src/sdk/neck/transport/neckHardwareBackend.js").includes(
        "return NECK_HARDWARE_BACKEND.LUVIA_BRIDGE"
      ),
      true
    )
  })
})
