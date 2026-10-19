/**
 * Presentation-only helpers for Voice Console — no SDK side effects.
 */
import assert from "node:assert/strict"
import {
  VOICE_HELP,
  providerDisplayInfo,
  sessionDisplayInfo,
  shortDeviceDisplayName,
  shortErrorSummary,
  transportDisplayInfo,
} from "./voiceConsolePresentation.js"

assert.equal(providerDisplayInfo("mock").label, "Mock")
assert.ok(providerDisplayInfo("assemblyai").tip.includes("100 ms"))
assert.equal(transportDisplayInfo("deepgram").short, "20 ms")
assert.equal(sessionDisplayInfo("IDLE").badge, "Ready")
assert.equal(sessionDisplayInfo("RUNNING", { listening: true }).badge, "Listening")
assert.equal(shortErrorSummary("短"), "短")
assert.ok(shortErrorSummary("x".repeat(80)).endsWith("…"))
assert.equal(
  shortDeviceDisplayName({ label: "麦克风 (ReSpeaker Lite) (2886:0019)", deviceId: "a" }, { preferredDeviceId: "a" }),
  "ReSpeaker Lite · 优先",
)
assert.ok(VOICE_HELP.inputActivity.length > 10)
console.log("voiceConsolePresentation.selftest: PASS")
