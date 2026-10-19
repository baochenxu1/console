/**
 * R3.1 — Browser CAN Backend UI Wiring tests (A–T).
 */

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, beforeEach, afterEach } from "node:test"

import {
  NECK_HARDWARE_BACKEND,
  HARDWARE_BACKEND_CONFLICT,
  checkHardwareBackendConflict,
  getDefaultNeckHardwareBackend,
} from "../sdk/neck/transport/neckHardwareBackend.js"
import {
  BROWSER_MOTOR_CONTROL_R4_HINT,
  canCloseBrowserSlcan,
  canConnectLuviaHardware,
  canOpenBrowserSlcan,
  canSelectBrowserCanAdapter,
  canSendBrowserSafeDisable,
  formatBrowserCanStatusLabel,
  getBackendSwitchConflict,
  isBrowserMotorControlAvailable,
  BROWSER_MOTOR_CONTROL_R4_HINT_ZH,
} from "../sdk/neck/transport/neckHardwareBackendUi.js"
import { mapBrowserSlcanPhysicalDebugView } from "../sdk/neck/neckPhysicalDebug.js"
import {
  getSharedBrowserSlcanTransport,
  releaseSharedBrowserSlcanTransport,
  peekSharedBrowserSlcanTransport,
  getSharedBrowserSlcanRefCount,
  _resetSharedBrowserSlcanTransportForTest,
} from "../sdk/neck/transport/browserSlcanTransportService.js"
import { createMockSerialPort } from "../sdk/neck/transport/mockSerialPort.js"
import { WEB_SERIAL_CAPABILITY } from "../sdk/neck/transport/webSerialCapability.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "../..")

function readSrc(rel) {
  return readFileSync(join(root, rel), "utf8")
}

beforeEach(async () => {
  await _resetSharedBrowserSlcanTransportForTest()
})

afterEach(async () => {
  await _resetSharedBrowserSlcanTransportForTest()
})

describe("R3.1 Browser CAN Backend UI Wiring", () => {
  it("A: Luvia backend keeps Runtime controls in panel source", () => {
    const src = readSrc("src/sdk/react/NeckBridgePanel.jsx")
    assert.match(src, /Connect Runtime/)
    assert.match(src, /Luvia Bridge/)
    assert.match(src, /isLuvia/)
    assert.equal(getDefaultNeckHardwareBackend(), NECK_HARDWARE_BACKEND.LUVIA_BRIDGE)
  })

  it("B: Browser CAN hides Connect Runtime (conditional isBrowser)", () => {
    const src = readSrc("src/sdk/react/NeckBridgePanel.jsx")
    assert.match(src, /isBrowser/)
    assert.match(src, /no localhost Runtime/)
    const browserSection = src.slice(src.indexOf('aria-label="Browser CAN"'))
    assert.ok(browserSection.length > 50)
    assert.doesNotMatch(browserSection, /Connect Runtime/)
    assert.match(src, /\{isLuvia \? \(/)
    assert.match(src, /Connect Runtime/)
  })

  it("C: WebSerial unsupported → Select/Open disabled helpers", () => {
    assert.equal(
      canSelectBrowserCanAdapter({
        backend: "browser-slcan",
        webSerialSupported: false,
        transportState: "CLOSED",
      }),
      false
    )
    assert.equal(
      canOpenBrowserSlcan({
        backend: "browser-slcan",
        webSerialSupported: false,
        portSelected: true,
        transportState: "CLOSED",
      }),
      false
    )
    assert.equal(
      formatBrowserCanStatusLabel("CLOSED", {
        supported: false,
        capabilityState: WEB_SERIAL_CAPABILITY.UNSUPPORTED,
      }),
      "Unsupported"
    )
  })

  it("D: Select requires browser-slcan + supported + not OPENING/READY", () => {
    assert.equal(
      canSelectBrowserCanAdapter({
        backend: "luvia-bridge",
        webSerialSupported: true,
        transportState: "CLOSED",
      }),
      false
    )
    assert.equal(
      canSelectBrowserCanAdapter({
        backend: "browser-slcan",
        webSerialSupported: true,
        transportState: "CLOSED",
      }),
      true
    )
    assert.equal(
      canSelectBrowserCanAdapter({
        backend: "browser-slcan",
        webSerialSupported: true,
        transportState: "READY",
      }),
      false
    )
    const eng = readSrc("src/sdk/react/NeckEngineeringPanel.jsx")
    assert.match(eng, /selectPort/)
    assert.match(eng, /onSelectBrowserCanAdapter/)
  })

  it("E: selected port enables Open", () => {
    assert.equal(
      canOpenBrowserSlcan({
        backend: "browser-slcan",
        webSerialSupported: true,
        portSelected: false,
        transportState: "CLOSED",
      }),
      false
    )
    assert.equal(
      canOpenBrowserSlcan({
        backend: "browser-slcan",
        webSerialSupported: true,
        portSelected: true,
        transportState: "CLOSED",
      }),
      true
    )
  })

  it("F: Open → READY status label", () => {
    assert.equal(formatBrowserCanStatusLabel("READY"), "Ready")
    assert.equal(formatBrowserCanStatusLabel("OPENING"), "Opening")
  })

  it("G: Close lifecycle helper", () => {
    assert.equal(
      canCloseBrowserSlcan({ backend: "browser-slcan", transportState: "CLOSED" }),
      false
    )
    assert.equal(
      canCloseBrowserSlcan({ backend: "browser-slcan", transportState: "READY" }),
      true
    )
    assert.equal(
      canCloseBrowserSlcan({ backend: "browser-slcan", transportState: "ERROR" }),
      true
    )
  })

  it("H: Safe Disable disabled before READY", () => {
    assert.equal(
      canSendBrowserSafeDisable({
        backend: "browser-slcan",
        transportState: "CLOSED",
        slcanReady: false,
      }),
      false
    )
  })

  it("I: Safe Disable enabled after READY", () => {
    assert.equal(
      canSendBrowserSafeDisable({
        backend: "browser-slcan",
        transportState: "READY",
        slcanReady: true,
      }),
      true
    )
  })

  it("J: Enable available in R4 Browser backend (host wired)", () => {
    assert.equal(isBrowserMotorControlAvailable(true), true)
    const src = readSrc("src/sdk/react/NeckBridgePanel.jsx")
    assert.doesNotMatch(src, /NOT AVAILABLE \[R3\]/)
    assert.match(src, /Enable Motors/)
    assert.match(src, /BROWSER_MOTOR_CONTROL_R4_HINT/)
  })

  it("K: Clear R4 runtime UX hints", () => {
    assert.ok(BROWSER_MOTOR_CONTROL_R4_HINT.includes("R4"))
    assert.match(BROWSER_MOTOR_CONTROL_R4_HINT, /Browser Runtime R4/)
    assert.match(BROWSER_MOTOR_CONTROL_R4_HINT_ZH, /R4/)
    const src = readSrc("src/sdk/react/NeckBridgePanel.jsx")
    assert.match(src, /BROWSER_MOTOR_CONTROL_R4_HINT/)
    assert.match(src, /BROWSER_MOTOR_CONTROL_R4_HINT_ZH/)
  })

  it("L: Backend conflict Luvia→Browser blocks open", () => {
    const c = getBackendSwitchConflict({
      backend: "browser-slcan",
      bridgeHardwareConnected: true,
      browserSlcanReady: false,
    })
    assert.equal(c.conflict, true)
    assert.equal(c.code, HARDWARE_BACKEND_CONFLICT)
    assert.match(c.message, /Disconnect Luvia/)
    assert.equal(c.blockBrowserOpen, true)
    assert.equal(
      canOpenBrowserSlcan({
        backend: "browser-slcan",
        webSerialSupported: true,
        portSelected: true,
        transportState: "CLOSED",
        bridgeHardwareConnected: true,
      }),
      false
    )
  })

  it("M: Backend conflict Browser→Luvia blocks Connect Hardware", () => {
    const c = getBackendSwitchConflict({
      backend: "luvia-bridge",
      bridgeHardwareConnected: false,
      browserSlcanReady: true,
      browserTransportState: "READY",
    })
    assert.equal(c.conflict, true)
    assert.match(c.message, /Close Browser CAN/)
    assert.equal(
      canConnectLuviaHardware({
        backend: "luvia-bridge",
        sessionActive: true,
        hardwareConnected: false,
        browserSlcanReady: true,
        browserTransportState: "READY",
      }),
      false
    )
  })

  it("N: No auto backend takeover (panel source)", () => {
    const src = readSrc("src/sdk/react/NeckBridgePanel.jsx")
    assert.match(src, /不自动切换\/关闭另一 backend/)
    assert.doesNotMatch(src, /onDisconnectHardware\?\.\(\).*onNeckHardwareBackendChange/)
    assert.equal(
      checkHardwareBackendConflict({
        browserSlcanReady: true,
        bridgeHardwareConnected: true,
      }).conflict,
      true
    )
  })

  it("O: Physical Debug Browser fields", () => {
    const view = mapBrowserSlcanPhysicalDebugView({
      state: "READY",
      serialOpen: true,
      slcanReady: true,
      portSelected: true,
      portInfo: { usbVendorId: 0x1d50, usbProductId: 0x606f },
      canMode: "fd",
      brs: false,
      baudRate: 115200,
      counters: { txFrames: 2, rxFrames: 1, txBytes: 40, rxBytes: 20 },
      lastTxFrame: { arbitrationId: 0x201, data: [0x38], isFd: true },
      lastRxFrame: null,
      lastError: null,
    })
    assert.equal(view.activeBackend, "browser-slcan")
    assert.equal(view.state, "READY")
    assert.equal(view.serialOpen, "true")
    assert.equal(view.slcanReady, "true")
    assert.equal(view.canMode, "fd")
    assert.equal(view.brs, "false")
    assert.equal(view.txFrameCount, "2")
    assert.equal(view.motorControl, "R4 Runtime")
    const panel = readSrc("src/sdk/react/NeckBridgePanel.jsx")
    assert.match(panel, /mapBrowserSlcanPhysicalDebugView/)
    assert.match(panel, /txFrameCount/)
  })

  it("P: Transport singleton", async () => {
    const mock = createMockSerialPort({ usbVendorId: 1, usbProductId: 2 })
    const a = getSharedBrowserSlcanTransport({
      serial: {
        requestPort: async () => mock,
        getPorts: async () => [mock],
      },
      isSecureContext: true,
      navigator: { serial: {} },
    })
    const b = getSharedBrowserSlcanTransport()
    assert.equal(a, b)
    assert.equal(peekSharedBrowserSlcanTransport(), a)
    assert.equal(getSharedBrowserSlcanRefCount(), 2)
    await releaseSharedBrowserSlcanTransport()
    assert.equal(getSharedBrowserSlcanRefCount(), 1)
    assert.ok(peekSharedBrowserSlcanTransport())
    await releaseSharedBrowserSlcanTransport()
    assert.equal(getSharedBrowserSlcanRefCount(), 0)
    assert.equal(peekSharedBrowserSlcanTransport(), null)
  })

  it("Q: React remount no duplicate transport (refcount)", async () => {
    const t1 = getSharedBrowserSlcanTransport({
      serial: {
        requestPort: async () => createMockSerialPort(),
        getPorts: async () => [],
      },
      isSecureContext: true,
      navigator: { serial: {} },
    })
    // Simulate Strict Mode: acquire again before first release finishes
    const t2 = getSharedBrowserSlcanTransport()
    assert.equal(t1, t2)
    await releaseSharedBrowserSlcanTransport()
    assert.equal(peekSharedBrowserSlcanTransport(), t1)
    await releaseSharedBrowserSlcanTransport()
    assert.equal(peekSharedBrowserSlcanTransport(), null)
  })

  it("R: existing Luvia Bridge UI regression (source + backend default)", () => {
    const src = readSrc("src/sdk/react/NeckBridgePanel.jsx")
    assert.match(src, /Connect Hardware/)
    assert.match(src, /Disconnect Hardware/)
    assert.match(src, /Enable/)
    assert.match(src, /ESTOP/)
    assert.match(src, /Hardware Preview/)
    assert.equal(getDefaultNeckHardwareBackend(), "luvia-bridge")
  })

  it("S: Character Timeline — Browser CAN routes via runtime host (not raw transport)", () => {
    const editor = readSrc("src/sdk/react/FaceExpressionEditor.jsx")
    assert.match(editor, /createBrowserNeckRuntimeHost/)
    assert.match(editor, /getSharedBrowserSlcanTransport|createConnectNeckService/)
    assert.match(editor, /offerTarget/)
    assert.doesNotMatch(editor, /sendFrame.*timeline/i)
    const actionPlayer = readSrc("src/core/actionPlayer.js")
    assert.doesNotMatch(actionPlayer, /WebSerialSlcan|browser-slcan|getSharedBrowserSlcan/)
  })

  it("T: SC/ST/RJ regression — panel does not import face adapters", () => {
    const src = readSrc("src/sdk/react/NeckBridgePanel.jsx")
    assert.doesNotMatch(src, /softCheek|softTongue|rightJaw|SoftCheek|SoftTongue/)
    const sc = readSrc("src/core/expressionTimelineChannels.js")
    assert.ok(sc.length > 100)
  })
})
