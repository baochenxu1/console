import test from "node:test"
import assert from "node:assert/strict"

import {
  createBrowserSourceState,
  selectBrowserIdle,
  selectBrowserCamera,
  markBrowserTrackingStarted,
  markBrowserTrackingStopped,
  resolveBrowserSourceCapability,
  isBrowserFrameGenerationValid,
  BROWSER_VIDEO_UNSUPPORTED_HINT,
  BROWSER_UPLOAD_UNSUPPORTED_HINT,
} from "./browserSourceRuntime.js"
import {
  resolveEffectiveTrackingSource,
  isEffectiveSourceSegmentActive,
  resolveSourceSegmentAvailability,
  canStartBrowserCameraTracking,
} from "../../trackingPreview/resolveEffectiveTrackingSource.js"

test("A — Browser Camera switch does not require Python REST helpers", () => {
  let state = createBrowserSourceState()
  state = selectBrowserCamera(state)
  assert.equal(state.sourceType, "camera")
  assert.equal(state.status, "ready")
  const eff = resolveEffectiveTrackingSource({
    trackingBackend: "browser",
    browserSource: state,
    pythonSource: { sourceType: "idle", status: "idle" },
  })
  assert.equal(eff.sourceType, "camera")
  assert.equal(eff.runtime, "browser")
  assert.equal(
    resolveSourceSegmentAvailability("browser", "camera").allowed,
    true
  )
})

test("B — Browser Idle releases tracking flags without Python", () => {
  let state = createBrowserSourceState()
  state = selectBrowserCamera(state)
  state = markBrowserTrackingStarted(state)
  const genBefore = state.sourceGeneration
  state = selectBrowserIdle(state)
  assert.equal(state.sourceType, "idle")
  assert.equal(state.trackingEnabled, false)
  assert.ok(state.sourceGeneration > genBefore)
})

test("C — Python Camera path still allowed via availability", () => {
  assert.equal(resolveSourceSegmentAvailability("python", "camera").allowed, true)
  assert.equal(resolveSourceSegmentAvailability("python", "video").allowed, true)
  const eff = resolveEffectiveTrackingSource({
    trackingBackend: "python",
    browserSource: createBrowserSourceState(),
    pythonSource: { sourceType: "camera", status: "running", sourceEpoch: 3 },
  })
  assert.equal(eff.sourceType, "camera")
  assert.equal(eff.sourceGeneration, 3)
})

test("D — Python Idle effective source", () => {
  const eff = resolveEffectiveTrackingSource({
    trackingBackend: "python",
    browserSource: selectBrowserCamera(createBrowserSourceState()),
    pythonSource: { sourceType: "idle", status: "idle" },
  })
  assert.equal(eff.sourceType, "idle")
  assert.equal(eff.runtime, "python")
})

test("E — Browser effective source ignores Python idle", () => {
  const browser = selectBrowserCamera(createBrowserSourceState())
  const eff = resolveEffectiveTrackingSource({
    trackingBackend: "browser",
    browserSource: browser,
    pythonSource: { sourceType: "idle", status: "error", error: "connection refused" },
  })
  assert.equal(eff.sourceType, "camera")
  assert.equal(
    isEffectiveSourceSegmentActive("camera", eff, "camera"),
    true
  )
  assert.equal(isEffectiveSourceSegmentActive("idle", eff, "camera"), false)
})

test("F — Python video effective source", () => {
  const eff = resolveEffectiveTrackingSource({
    trackingBackend: "python",
    browserSource: createBrowserSourceState(),
    pythonSource: { sourceType: "video", status: "running", sourceEpoch: 9 },
  })
  assert.equal(eff.sourceType, "video")
  assert.equal(isEffectiveSourceSegmentActive("video", eff, "video"), true)
})

test("G — Browser Video capability gate", () => {
  const gate = resolveBrowserSourceCapability("video")
  assert.equal(gate.allowed, false)
  assert.equal(gate.hint, BROWSER_VIDEO_UNSUPPORTED_HINT)
  assert.equal(resolveSourceSegmentAvailability("browser", "video").allowed, false)
})

test("H — Browser Upload capability gate", () => {
  const gate = resolveBrowserSourceCapability("upload")
  assert.equal(gate.allowed, false)
  assert.equal(gate.hint, BROWSER_UPLOAD_UNSUPPORTED_HINT)
})

test("I — Runtime Python→Browser starts at idle (selector)", () => {
  const browser = createBrowserSourceState()
  const eff = resolveEffectiveTrackingSource({
    trackingBackend: "browser",
    browserSource: browser,
    pythonSource: { sourceType: "camera", status: "running" },
  })
  assert.equal(eff.sourceType, "idle")
  assert.equal(eff.capabilities.camera, true)
  assert.equal(eff.capabilities.video, false)
})

test("J — Browser stop keeps camera optional", () => {
  let state = markBrowserTrackingStarted(selectBrowserCamera(createBrowserSourceState()))
  state = markBrowserTrackingStopped(state, { keepCameraSource: true })
  assert.equal(state.sourceType, "camera")
  assert.equal(state.trackingEnabled, false)
  state = markBrowserTrackingStopped(
    markBrowserTrackingStarted(selectBrowserCamera(createBrowserSourceState())),
    { keepCameraSource: false }
  )
  assert.equal(state.sourceType, "idle")
})

test("K — Browser Start gate ignores Python unreachable", () => {
  const eff = resolveEffectiveTrackingSource({
    trackingBackend: "browser",
    browserSource: selectBrowserCamera(createBrowserSourceState()),
    pythonSource: { sourceType: "idle", error: "ECONNREFUSED" },
  })
  assert.equal(canStartBrowserCameraTracking(eff, { trackingEnabled: false }), true)
  assert.equal(canStartBrowserCameraTracking(eff, { trackingEnabled: true }), false)
})

test("L — stale Browser generation rejected", () => {
  const expected = 11
  const stale = {
    debug: { inputSource: { sourceGeneration: 10, sourceEpoch: 10 } },
  }
  const fresh = {
    debug: { inputSource: { sourceGeneration: 11, sourceEpoch: 11 } },
  }
  assert.equal(isBrowserFrameGenerationValid(expected, stale), false)
  assert.equal(isBrowserFrameGenerationValid(expected, fresh), true)
})

test("M — Device Drive contract: effective source has no protocol fields", () => {
  const eff = resolveEffectiveTrackingSource({
    trackingBackend: "browser",
    browserSource: selectBrowserCamera(createBrowserSourceState()),
  })
  const json = JSON.stringify(eff)
  assert.equal(json.includes("syncWrite"), false)
  assert.equal(json.includes("WebSerial"), false)
  assert.equal(json.includes("rjSbus"), false)
})

test("N — SC/ST/RJ regression: browser source runtime module is protocol-free", async () => {
  const fs = await import("node:fs/promises")
  const src = await fs.readFile(new URL("./browserSourceRuntime.js", import.meta.url), "utf8")
  for (const forbidden of ["WebSerial", "syncWrite", "rjSbus", "Scscl", "sendBusServo"]) {
    assert.equal(src.includes(forbidden), false)
  }
})
