/**
 * Optional Neck UI Product Integration — automated acceptance (A–AL).
 */

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"

import {
  createDefaultFrameProject,
  normalizeFrameProject,
  createDefaultProjectModules,
  normalizeProjectModules,
  getProjectNeckModule,
  patchProjectNeckModule,
  canEditNeckPose,
  canDispatchNeckHardware,
  shouldWriteNeckOnFullCharacterKey,
} from "./frameProject.js"
import { addFullFaceKeyAtTime } from "./expressionKeyframeOps.js"
import { createNeutralNeckPose, normalizeNeckPose } from "../sdk/neck/neckPose.js"
import { createConnectNeckService } from "../sdk/neck/product/connectNeckService.js"
import { getDefaultNeckHardwareBackend, NECK_HARDWARE_BACKEND } from "../sdk/neck/transport/index.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "../..")

function readSrc(rel) {
  return readFileSync(join(root, rel), "utf8")
}

describe("Optional Neck Module — schema / migration (A, B, F)", () => {
  it("A: new project → Neck disabled (Face-only)", () => {
    const p = createDefaultFrameProject([])
    assert.equal(getProjectNeckModule(p).enabled, false)
    assert.equal(getProjectNeckModule(p).locked, false)
    assert.deepEqual(createDefaultProjectModules().neck, { enabled: false, locked: false })
  })

  it("B: missing modules.neck → migration enabled=true (preserve existing behavior)", () => {
    const legacy = normalizeFrameProject(
      {
        schemaVersion: 2,
        expressionName: "legacy",
        keyframes: [],
        timelineDurationMs: 0,
      },
      []
    )
    assert.equal(getProjectNeckModule(legacy).enabled, true)
    const noModules = normalizeProjectModules(undefined)
    assert.equal(noModules.neck.enabled, true)
  })

  it("F: disabling module does not delete neck keyframe data", () => {
    let p = createDefaultFrameProject([])
    p = patchProjectNeckModule(p, { enabled: true, locked: false })
    const neck = normalizeNeckPose({ pitch: 5, roll: -2, yaw: 3 })
    p = addFullFaceKeyAtTime(p, 0, { eyes: {}, brows: {}, mouth: {}, tongue: {}, jaw: {} }, {}, [], {
      neck,
      writeNeck: true,
    })
    const before = p.keyframes[0].characterPose.neck
    p = patchProjectNeckModule(p, { enabled: false })
    assert.equal(getProjectNeckModule(p).enabled, false)
    assert.deepEqual(p.keyframes[0].characterPose.neck, before)
  })
})

describe("Optional Neck — edit / Full Key / dispatch gates (C–E, H–K)", () => {
  it("C: Neck disabled → manual edit inactive", () => {
    const p = createDefaultFrameProject([])
    assert.equal(canEditNeckPose(p), false)
  })

  it("D: Neck disabled → Full Character Key Face only", () => {
    let p = createDefaultFrameProject([])
    assert.equal(shouldWriteNeckOnFullCharacterKey(p), false)
    const existingNeck = normalizeNeckPose({ pitch: 8, roll: 1, yaw: -4 })
    p = patchProjectNeckModule(p, { enabled: true })
    p = addFullFaceKeyAtTime(p, 100, {}, {}, [], { neck: existingNeck, writeNeck: true })
    p = patchProjectNeckModule(p, { enabled: false })
    const next = addFullFaceKeyAtTime(
      p,
      100,
      {},
      {},
      [],
      {
        neck: createNeutralNeckPose(),
        writeNeck: shouldWriteNeckOnFullCharacterKey(p),
      }
    )
    const kf = next.keyframes.find((k) => k.timeMs === 100)
    assert.ok(kf)
    assert.equal(kf.characterPose.neck.pitch, existingNeck.pitch)
    assert.equal(kf.characterPose.neck.yaw, existingNeck.yaw)
  })

  it("E: Neck disabled → hardware dispatch gated", () => {
    const p = createDefaultFrameProject([])
    assert.equal(canDispatchNeckHardware(p), false)
  })

  it("H/I/J: Lock prevents edit (pad/yaw/neutral)", () => {
    let p = createDefaultFrameProject([])
    p = patchProjectNeckModule(p, { enabled: true, locked: true })
    assert.equal(canEditNeckPose(p), false)
    assert.equal(shouldWriteNeckOnFullCharacterKey(p), false)
  })

  it("K: Lock Full Key does not overwrite Neck", () => {
    let p = createDefaultFrameProject([])
    p = patchProjectNeckModule(p, { enabled: true, locked: false })
    const neck = normalizeNeckPose({ pitch: 8, roll: -3, yaw: 6 })
    p = addFullFaceKeyAtTime(p, 100, {}, {}, [], { neck, writeNeck: true })
    p = patchProjectNeckModule(p, { locked: true })
    const next = addFullFaceKeyAtTime(p, 100, {}, {}, [], {
      neck: createNeutralNeckPose(),
      writeNeck: shouldWriteNeckOnFullCharacterKey(p),
    })
    const kf = next.keyframes.find((k) => k.timeMs === 100)
    assert.ok(kf)
    assert.equal(kf.characterPose.neck.pitch, 8)
  })

  it("L: Lock still allows hardware dispatch (playback)", () => {
    let p = createDefaultFrameProject([])
    p = patchProjectNeckModule(p, { enabled: true, locked: true })
    assert.equal(canDispatchNeckHardware(p), true)
    assert.equal(canEditNeckPose(p), false)
  })

  it("M: Lock is edit-only (not hardware disable) — helpers independent", () => {
    let p = patchProjectNeckModule(createDefaultFrameProject([]), {
      enabled: true,
      locked: true,
    })
    assert.equal(canDispatchNeckHardware(p), true)
    p = patchProjectNeckModule(p, { enabled: false, locked: true })
    assert.equal(canDispatchNeckHardware(p), false)
  })
})

describe("Connect Neck facade (N–V)", () => {
  function mockTransport(opts = {}) {
    const state = {
      state: opts.state || "DISCONNECTED",
      slcanReady: Boolean(opts.slcanReady),
      lastError: null,
    }
    const calls = { open: [], selectPort: 0, close: 0, getPorts: 0 }
    return {
      calls,
      state,
      getPorts: async () => {
        calls.getPorts += 1
        return opts.ports || []
      },
      getPort: () => opts.ports?.[0] || null,
      selectPort: async () => {
        calls.selectPort += 1
        if (opts.selectFails) throw new Error("cancelled")
        opts.ports = opts.portsAfterSelect || opts.ports || [{ id: "p1" }]
        return opts.ports[0] || { id: "p1" }
      },
      open: async (arg) => {
        calls.open.push(arg)
        if (opts.openFails) throw new Error("open failed")
        state.state = "READY"
        state.slcanReady = true
      },
      close: async () => {
        calls.close += 1
        state.state = "DISCONNECTED"
        state.slcanReady = false
      },
      getState: () => ({ ...state }),
    }
  }

  function mockHost(opts = {}) {
    const snap = {
      profileReady: true,
      profile: { loaded: true },
      gates: { profileValid: true },
      enabled: false,
      ...opts.snap,
    }
    const calls = {
      resolveStartupProfile: 0,
      enableMotors: 0,
      disableMotors: 0,
      notifyReady: 0,
      notifyLost: 0,
      estop: 0,
      clearEstop: 0,
    }
    return {
      calls,
      snap,
      resolveStartupProfile: async () => {
        calls.resolveStartupProfile += 1
        if (opts.profileFails) throw new Error("profile boom")
      },
      getSnapshot: () => snap,
      notifyTransportReady: () => {
        calls.notifyReady += 1
      },
      notifyTransportLost: () => {
        calls.notifyLost += 1
      },
      enableMotors: async () => {
        calls.enableMotors += 1
        snap.enabled = true
        return { ok: true }
      },
      disableMotors: (o) => {
        calls.disableMotors += 1
        snap.enabled = false
        return { ok: true, opts: o }
      },
      estop: () => {
        calls.estop += 1
      },
      clearEstop: () => {
        calls.clearEstop += 1
        return { ok: true }
      },
    }
  }

  it("N: Connect Neck loads active persisted profile (resolveStartupProfile)", async () => {
    const transport = mockTransport({ ports: [{ id: "a" }] })
    const host = mockHost()
    const svc = createConnectNeckService({ transport, host })
    const r = await svc.connectNeck()
    assert.equal(r.ok, true)
    assert.equal(host.calls.resolveStartupProfile, 1)
  })

  it("O: Connect always confirms COM via selectPort (even single authorized port)", async () => {
    const port = { id: "only" }
    const transport = mockTransport({ ports: [port] })
    const host = mockHost()
    const svc = createConnectNeckService({ transport, host })
    await svc.connectNeck()
    assert.ok(transport.calls.selectPort >= 1)
    assert.equal(transport.calls.open.length, 1)
    assert.ok(transport.calls.open[0].port)
  })

  it("O2: already READY → connect is no-op without re-open", async () => {
    const transport = mockTransport({ ports: [{ id: "a" }] })
    transport.getState = () => ({ state: "READY", slcanReady: true })
    const host = mockHost()
    const svc = createConnectNeckService({ transport, host })
    const r = await svc.connectNeck()
    assert.equal(r.ok, true)
    assert.equal(transport.calls.selectPort, 0)
    assert.equal(transport.calls.open.length, 0)
  })

  it("P: no port → requestPort / selectPort on click", async () => {
    const transport = mockTransport({ ports: [], portsAfterSelect: [{ id: "new" }] })
    const host = mockHost()
    const svc = createConnectNeckService({ transport, host })
    await svc.connectNeck()
    assert.ok(transport.calls.selectPort >= 1)
  })

  it("Q/R: successful connect → Connected; does not auto-enable", async () => {
    const transport = mockTransport({ ports: [{ id: "a" }] })
    const host = mockHost()
    const svc = createConnectNeckService({ transport, host })
    const r = await svc.connectNeck()
    assert.equal(r.ok, true)
    assert.equal(r.state, "CONNECTED")
    assert.equal(host.calls.enableMotors, 0)
    assert.equal(host.snap.enabled, false)
  })

  it("S/T: Enable explicit → Ready path", async () => {
    const transport = mockTransport({ ports: [{ id: "a" }] })
    const host = mockHost()
    const svc = createConnectNeckService({ transport, host })
    await svc.connectNeck()
    const en = await svc.enableNeckMotors()
    assert.equal(en.ok, true)
    assert.equal(host.calls.enableMotors, 1)
    assert.equal(host.snap.enabled, true)
  })

  it("U: Disconnect lifecycle", async () => {
    const transport = mockTransport({ ports: [{ id: "a" }] })
    const host = mockHost()
    const svc = createConnectNeckService({ transport, host })
    await svc.connectNeck()
    await svc.enableNeckMotors()
    await svc.disconnectNeck()
    assert.equal(host.calls.disableMotors, 1)
    assert.equal(transport.calls.close, 1)
    assert.equal(host.calls.notifyLost, 1)
  })

  it("V: ESTOP/Clear facade delegates (contract unchanged)", () => {
    const host = mockHost()
    const svc = createConnectNeckService({ transport: mockTransport(), host })
    svc.estop()
    svc.clearEstop()
    assert.equal(host.calls.estop, 1)
    assert.equal(host.calls.clearEstop, 1)
  })

  it("multiple authorized ports → selectPort (no silent guess)", async () => {
    const transport = mockTransport({
      ports: [{ id: "a" }, { id: "b" }],
      portsAfterSelect: [{ id: "b" }],
    })
    const host = mockHost()
    const svc = createConnectNeckService({ transport, host })
    await svc.connectNeck()
    assert.ok(transport.calls.selectPort >= 1)
  })
})

describe("Layout / product UI wiring (W–AB, AL)", () => {
  it("W: Neck controls render in mouth lower slot", () => {
    const consoleSrc = readSrc("src/components/FaceRigControlConsole.jsx")
    assert.match(consoleSrc, /mouth-section-neck-slot/)
    assert.match(consoleSrc, /neckSlot/)
  })

  it("X/Y: Eye / Mouth structure preserved (no absolute overlay Neck)", () => {
    const consoleSrc = readSrc("src/components/FaceRigControlConsole.jsx")
    assert.doesNotMatch(consoleSrc, /position:\s*absolute/)
    assert.match(consoleSrc, /face-expression-eye-section/)
    assert.match(consoleSrc, /face-expression-mouth-section|mouth-section/)
    const css = readSrc("src/styles/face-rig.css")
    assert.match(css, /\.mouth-section-neck-slot/)
    assert.doesNotMatch(css, /\.mouth-section-neck-slot\s*\{[^}]*position:\s*absolute/)
  })

  it("Z: Right sidebar no permanent NeckBridgePanel / NeckCharacterControls", () => {
    const editor = readSrc("src/sdk/react/FaceExpressionEditor.jsx")
    assert.doesNotMatch(editor, /NeckBridgePanel/)
    assert.doesNotMatch(editor, /NeckCharacterControls/)
    assert.match(editor, /NeckExpressionControls/)
    assert.match(editor, /neckSlot/)
  })

  it("AA: side-stack hosts ExpressionFramePanel without neck column", () => {
    const editor = readSrc("src/sdk/react/FaceExpressionEditor.jsx")
    assert.match(editor, /face-expression-side-stack/)
    assert.match(editor, /ExpressionFramePanel/)
    assert.doesNotMatch(editor, /face-expression-neck-column/)
  })

  it("AB: Timeline dock structure unchanged (still bottom dock)", () => {
    const editor = readSrc("src/sdk/react/FaceExpressionEditor.jsx")
    assert.match(editor, /face-expression-timeline-dock/)
    assert.match(editor, /ExpressionDopeSheetTimeline/)
  })

  it("AL: expression page has no raw transport diagnostics strings", () => {
    const editor = readSrc("src/sdk/react/FaceExpressionEditor.jsx")
    for (const banned of [
      "tickHz",
      "productionReady",
      "COMMISSIONING",
      "targetChain",
      "Refresh Ports",
      "VID/PID",
      "Safe Disable",
    ]) {
      assert.equal(editor.includes(banned), false, `banned: ${banned}`)
    }
  })
})

describe("Calibration UI (AC–AG)", () => {
  it("AC/AG: calibration channels extensible (not hard-coded dual blocks only)", () => {
    const ui = readSrc("src/sdk/react/NeckExpressionControls.jsx")
    assert.match(ui, /export const NECK_CALIBRATION_CHANNELS/)
    assert.match(ui, /id:\s*"side1"/)
    assert.match(ui, /id:\s*"side2"/)
    assert.match(ui, /NECK_CALIBRATION_CHANNELS\.map/)
    assert.match(ui, /机械中位标定/)
    assert.match(ui, /重置 Trim/)
  })

  it("AF: LIMIT disables nudge buttons at bounds", () => {
    const ui = readSrc("src/sdk/react/NeckExpressionControls.jsx")
    assert.match(ui, /LIMIT/)
    assert.match(ui, /atMin|atMax/)
    assert.match(ui, /disabled=\{blocked/)
  })
})

describe("Engineering migration (AH–AK)", () => {
  it("AH–AK: product nav has no kinematics/SC lab pages; expression path browser-slcan", () => {
    const app = readSrc("src/App.jsx")
    assert.doesNotMatch(app, /KinematicsLabPage|ScServoLabPage|机构调试|SC\/ST 舵机/)
    assert.match(app, /串口与单舵机控制/)
    assert.match(app, /动作帧编辑与预览/)
    assert.match(app, /面部绑定/)
    assert.match(app, /表情编排/)
    assert.match(app, /常用表情/)
    assert.match(app, /追踪预览/)
    const eng = readSrc("src/sdk/react/NeckEngineeringPanel.jsx")
    assert.match(eng, /NeckBridgePanel/)
    assert.match(eng, /Physical|onSendBrowserSafeDisable|onLoadBrowserProfile|luvia|Luvia/i)
    assert.equal(getDefaultNeckHardwareBackend(), NECK_HARDWARE_BACKEND.LUVIA_BRIDGE)
    const editor = readSrc("src/sdk/react/FaceExpressionEditor.jsx")
    assert.match(editor, /createConnectNeckService/)
    assert.match(editor, /getSharedBrowserSlcanTransport/)
    assert.doesNotMatch(editor, /getSharedNeckBridgeClient/)
  })
})

describe("Face-only isolation (G)", () => {
  it("G: Face-only path does not require Web Serial in module helpers", () => {
    const p = createDefaultFrameProject([])
    assert.equal(canEditNeckPose(p), false)
    assert.equal(canDispatchNeckHardware(p), false)
    const editor = readSrc("src/sdk/react/FaceExpressionEditor.jsx")
    assert.match(editor, /neckModule\.enabled \? connectError/)
  })
})
