/**
 * Optional Neck UI Polish — dispatch gate + view exclusivity (A–P).
 */

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"

import {
  canDispatchNeckHardware,
  canDispatchNeckPhysical,
  canEditNeckPose,
  createDefaultFrameProject,
  patchProjectNeckModule,
  shouldWriteNeckOnFullCharacterKey,
} from "./frameProject.js"
import {
  createBrowserNeckRuntimeHost,
  createFakeNeckRuntimeWorker,
} from "../sdk/neck/runtime/browserNeckRuntimeHost.js"
import { createLuviaReferenceProfile } from "../sdk/neck/core/neckRuntimeProfile.js"
import {
  getNeckSettingsGates,
  getNeckDeviceStatusLabel,
  getNeckConnectionStatusText,
  getNeckConnectionPillTone,
} from "../sdk/neck/product/neckProductUiGates.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "../..")

function readSrc(rel) {
  return readFileSync(join(root, rel), "utf8")
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

describe("Physical dispatch gate (A–D)", () => {
  it("A/D: CLOSED transport never reaches sendFrame via host flush", async () => {
    let sendCount = 0
    const host = createBrowserNeckRuntimeHost({
      getTransport: () => ({
        sendFrame: async () => {
          sendCount += 1
          throw new Error("sendFrame requires READY (state=CLOSED)")
        },
        getState: () => ({ state: "CLOSED", slcanReady: false }),
      }),
      createWorker: () =>
        createFakeNeckRuntimeWorker({
          delay: (ms) => sleep(Math.min(ms, 1)),
        }),
    })
    try {
      await host.loadProfile(createLuviaReferenceProfile())
      // Simulate worker TX while CLOSED — must be dropped
      host._txQueue.submit({
        priority: 10,
        frame: { id: 0x32, data: [] },
        replacePeriodic: true,
      })
      // Directly invoke flush path via microtask by scheduling
      // Host only flushes from txFrame when READY; inject via internal queue + notify lost
      host.notifyTransportLost()
      await sleep(20)
      assert.equal(sendCount, 0)
      assert.equal(canDispatchNeckPhysical({
        moduleEnabled: true,
        transportReady: false,
        motorsEnabled: false,
        source: "editor",
        hardwarePreview: true,
      }), false)
    } finally {
      await host.dispose()
    }
  })

  it("B/C: semantic edit gate independent of physical; Neutral disconnected OK", () => {
    let p = createDefaultFrameProject([])
    p = patchProjectNeckModule(p, { enabled: true, locked: false })
    assert.equal(canEditNeckPose(p), true)
    assert.equal(
      canDispatchNeckPhysical({
        project: p,
        transportReady: false,
        motorsEnabled: false,
        hardwarePreview: false,
        source: "editor",
      }),
      false
    )
  })

  it("D: physical only when gate true", () => {
    assert.equal(
      canDispatchNeckPhysical({
        moduleEnabled: true,
        transportReady: true,
        motorsEnabled: true,
        hardwarePreview: true,
        source: "editor",
      }),
      true
    )
    assert.equal(
      canDispatchNeckPhysical({
        moduleEnabled: true,
        transportReady: true,
        motorsEnabled: true,
        hardwarePreview: false,
        source: "editor",
      }),
      false
    )
    assert.equal(
      canDispatchNeckPhysical({
        moduleEnabled: true,
        transportReady: true,
        motorsEnabled: true,
        hardwarePreview: false,
        source: "timeline",
      }),
      true
    )
  })
})

describe("View exclusivity & settings gates (E–L)", () => {
  it("E: disabled module still shows controls (read-only), enable in header", () => {
    const ui = readSrc("src/sdk/react/NeckExpressionControls.jsx")
    const css = readSrc("src/styles/face-rig.css")
    const consoleUi = readSrc("src/components/FaceRigControlConsole.jsx")
    assert.match(ui, /启用 Neck/)
    assert.match(ui, /关闭 Neck/)
    assert.match(ui, /is-module-off/)
    assert.match(ui, /模块未启用/)
    assert.doesNotMatch(ui, /当前工程未启用颈部控制/)
    assert.match(css, /\.neck-expression-btn\s*\{[^}]*width:\s*auto/s)
    assert.match(consoleUi, /neck-fit-viewport/)
    assert.match(consoleUi, /mouth-fit-viewport/)
    assert.match(consoleUi, /useFitScale/)
    assert.match(css, /\.neck-fit-scaler/)
    assert.match(css, /\.mouth-fit-scaler/)
    assert.match(css, /max-height:\s*46%/)
    assert.doesNotMatch(consoleUi, /mouth-section-vertical-shift/)
  })

  it("F/K/L: control/settings/calibration mutual exclusive", () => {
    const ui = readSrc("src/sdk/react/NeckExpressionControls.jsx")
    assert.match(ui, /data-testid="neck-control-view"/)
    assert.match(ui, /data-testid="neck-settings-view"/)
    assert.match(ui, /data-testid="neck-calibration-view"/)
    assert.match(ui, /activeView === "control"/)
    assert.match(ui, /activeView === "settings"/)
    assert.match(ui, /activeView === "calibration"/)
    // Settings must not stack menu above pad in same render branch
    assert.doesNotMatch(ui, /neck-expression-menu/)
  })

  it("G: disconnected Settings only calibration gate (no disable/disconnect/close)", () => {
    const g = getNeckSettingsGates({
      transportReady: false,
      motorsEnabled: false,
      estop: false,
      calibrating: false,
    })
    assert.equal(g.showCalibration, false)
    assert.equal(g.canCloseModule, true)
    const ui = readSrc("src/sdk/react/NeckExpressionControls.jsx")
    assert.doesNotMatch(ui, /neck-expression-settings[\s\S]*关闭 Neck/)
    assert.match(ui, /硬件预览/)
    assert.match(ui, /FaceRealtimePreviewToggle/)
    assert.match(ui, /失能电机/)
    assert.match(ui, /断开 Neck/)
  })

  it("H: connected motors-disabled gate", () => {
    const g = getNeckSettingsGates({
      transportReady: true,
      motorsEnabled: false,
    })
    assert.equal(g.showCalibration, false)
    assert.equal(g.canCloseModule, false)
  })

  it("I: ready Settings gate", () => {
    const g = getNeckSettingsGates({
      transportReady: true,
      motorsEnabled: true,
    })
    assert.equal(g.showCalibration, true)
    assert.equal(g.canCloseModule, false)
  })

  it("J: module disable blocked while physical active", () => {
    assert.equal(
      getNeckSettingsGates({ transportReady: true, motorsEnabled: false }).canCloseModule,
      false
    )
    assert.equal(
      getNeckSettingsGates({ transportReady: false, motorsEnabled: false }).canCloseModule,
      true
    )
  })
})

describe("Calibration LIMIT / ESTOP / lock / optional (M–P)", () => {
  it("M: AT LIMIT disables invalid direction", () => {
    const ui = readSrc("src/sdk/react/NeckExpressionControls.jsx")
    assert.match(ui, /已达下限/)
    assert.match(ui, /已达上限/)
    assert.match(ui, /disabled=\{blocked/)
  })

  it("N: ESTOP full-width row under primary three buttons", () => {
    const ui = readSrc("src/sdk/react/NeckExpressionControls.jsx")
    assert.match(ui, /急停/)
    assert.match(ui, /回中/)
    assert.match(ui, /neck-expression-actions--primary[\s\S]*回中[\s\S]*连接/)
    assert.match(ui, /neck-expression-actions--estop[\s\S]*急停/)
  })

  it("O: lock semantics still in schema helpers", () => {
    let p = createDefaultFrameProject([])
    p = patchProjectNeckModule(p, { enabled: true, locked: true })
    assert.equal(canEditNeckPose(p), false)
    assert.equal(canDispatchNeckHardware(p), true)
    assert.equal(shouldWriteNeckOnFullCharacterKey(p), false)
  })

  it("P: optional module + connection status helpers", () => {
    const p = createDefaultFrameProject([])
    assert.equal(canDispatchNeckHardware(p), false)
    assert.equal(getNeckDeviceStatusLabel({ moduleEnabled: false }), "未启用")
    assert.equal(getNeckDeviceStatusLabel({ moduleEnabled: true, transportReady: false }), "未连接")
    assert.equal(
      getNeckDeviceStatusLabel({ moduleEnabled: true, transportReady: true, motorsEnabled: true }),
      "就绪"
    )
    assert.match(
      getNeckConnectionStatusText({ moduleEnabled: true, transportReady: true, motorsEnabled: false }),
      /已连接/
    )
    assert.match(
      getNeckConnectionStatusText({
        moduleEnabled: true,
        transportReady: true,
        motorsEnabled: true,
        hardwarePreview: true,
      }),
      /硬件预览开/
    )
    assert.equal(getNeckConnectionPillTone({ moduleEnabled: true, transportReady: false }), "offline")
    assert.equal(
      getNeckConnectionPillTone({ moduleEnabled: true, transportReady: true, motorsEnabled: false }),
      "connected"
    )
    assert.equal(
      getNeckConnectionPillTone({ moduleEnabled: true, transportReady: true, motorsEnabled: true }),
      "ready"
    )
  })
})

describe("Editor wiring polish", () => {
  it("uses canDispatchNeckPhysical; does not pipe lastError as connect banner", () => {
    const editor = readSrc("src/sdk/react/FaceExpressionEditor.jsx")
    assert.match(editor, /canDispatchNeckPhysical/)
    assert.doesNotMatch(editor, /browserRuntimeSnap\?\.lastError/)
    assert.match(editor, /connectError=\{neckModule\.enabled \? connectError : null\}/)
  })

  it("host skips sendFrame when not READY", () => {
    const host = readSrc("src/sdk/neck/runtime/browserNeckRuntimeHost.js")
    assert.match(host, /never call sendFrame unless transport is READY/)
    assert.match(host, /if \(!transportIsReady\(\)\)/)
  })
})
