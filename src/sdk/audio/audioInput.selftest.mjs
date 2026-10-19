/**
 * 纯函数自测：设备排序、约束构造、音量 / 相关 / 差值、错误分类。
 * 不 mock 整套 MediaDevices。
 */
import assert from "node:assert/strict"
import {
  formatDeviceLabel,
  looksLikeRespeakerLabel,
  shortDeviceId,
  sortAudioInputDevices,
} from "./audioDevices.js"
import {
  AUDIO_CAPTURE_CONSTRAINTS,
  AUDIO_CHANNEL_MODES,
  buildAudioCaptureConstraints,
  formatSettingValue,
  readTrackSettings,
  requestedChannelCountForMode,
} from "./audioCapture.js"
import {
  buildChannelDiagnosticHint,
  byteTimeDomainToFloatSamples,
  calculateChannelDifference,
  calculateCorrelation,
  calculatePeak,
  calculateRms,
  computePeakFromTimeDomain,
  computeRmsFromTimeDomain,
} from "./audioMeter.js"
import { AUDIO_ERROR_CODES, classifyAudioError } from "./audioErrors.js"

assert.equal(looksLikeRespeakerLabel("ReSpeaker Lite"), true)
assert.equal(looksLikeRespeakerLabel("Seeed Studio XMOS"), true)
assert.equal(looksLikeRespeakerLabel("USB Audio Device"), false)

const sorted = sortAudioInputDevices([
  { kind: "audioinput", deviceId: "a", label: "Headset Mic" },
  { kind: "videoinput", deviceId: "cam", label: "Camera" },
  { kind: "audioinput", deviceId: "b", label: "ReSpeaker Lite" },
])
assert.equal(sorted.length, 2)
assert.equal(sorted[0].deviceId, "b")
assert.equal(sorted[1].deviceId, "a")
assert.equal(formatDeviceLabel(sorted[0]).includes("优先"), true)
assert.equal(shortDeviceId("abcdefghijklmnop"), "abcdefghijklmnop")
assert.equal(shortDeviceId("abcdefghijklmnopqrstuvwxyz"), "abcdefgh…uvwxyz")

const mono = buildAudioCaptureConstraints("dev-1", AUDIO_CHANNEL_MODES.mono)
assert.equal(mono.video, false)
assert.deepEqual(mono.audio.deviceId, { exact: "dev-1" })
assert.deepEqual(mono.audio.channelCount, { ideal: 1 })
assert.deepEqual(mono.audio.sampleRate, { ideal: 16000 })
assert.equal(mono.audio.echoCancellation, false)
assert.equal(mono.requestedChannels, 1)
assert.equal(AUDIO_CAPTURE_CONSTRAINTS.sampleRateIdeal, 16000)

const native = buildAudioCaptureConstraints("dev-2", AUDIO_CHANNEL_MODES.native)
assert.equal(native.audio.channelCount, undefined)
assert.equal(native.requestedChannels, null)
assert.equal(requestedChannelCountForMode(AUDIO_CHANNEL_MODES.native), null)

const stereo = buildAudioCaptureConstraints("dev-3", AUDIO_CHANNEL_MODES.stereo)
assert.deepEqual(stereo.audio.channelCount, { ideal: 2 })
assert.equal(stereo.requestedChannels, 2)
assert.notEqual(JSON.stringify(stereo.audio.channelCount), JSON.stringify({ exact: 2 }))

assert.equal(formatSettingValue(null), "N/A")
assert.equal(formatSettingValue(true), "true")
assert.equal(formatSettingValue(48000), "48000")

const settings = readTrackSettings({
  getSettings: () => ({
    sampleRate: 48000,
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    deviceId: "abc",
  }),
})
assert.equal(settings.sampleRate, 48000)
assert.equal(settings.sampleSize, null)
assert.equal(settings.channelCount, 1)
assert.equal(settings.echoCancellation, false)

assert.equal(calculateRms([]), 0)
assert.equal(calculateRms([0, 0, 0, 0]), 0)
assert.ok(Math.abs(calculateRms([1, -1, 1, -1]) - 1) < 1e-9)
assert.equal(calculatePeak([0.1, -0.5, 0.2]), 0.5)

const silence = new Uint8Array(8).fill(128)
assert.equal(computeRmsFromTimeDomain(silence), 0)
assert.equal(computePeakFromTimeDomain(silence), 0)
const loud = Uint8Array.from([128, 255, 0, 128])
assert.ok(computeRmsFromTimeDomain(loud) > 0.5)
assert.equal(computePeakFromTimeDomain(loud), 1)
assert.deepEqual([...byteTimeDomainToFloatSamples(Uint8Array.from([128, 255, 0]))], [0, 127 / 128, -1])

const same = [0.1, 0.2, 0.3, 0.4]
assert.ok(Math.abs(calculateCorrelation(same, same) - 1) < 1e-9)
assert.ok(Math.abs(calculateCorrelation(same, same.map((n) => -n)) + 1) < 1e-9)
assert.ok(Math.abs(calculateCorrelation([1, 2, 3, 4], [4, 3, 2, 1]) + 1) < 1e-9)
assert.equal(calculateCorrelation([0, 0, 0, 0], [0, 0, 0, 0]), null)
assert.equal(calculateCorrelation([0, 0, 0, 0], [1, 2, 3, 4]), null)
assert.ok(Number.isFinite(calculateCorrelation([1, 2, 3, 4], [1, 3, 2, 5])))

assert.ok(Math.abs(calculateChannelDifference(same, same)) < 1e-12)
assert.ok(calculateChannelDifference([0, 0, 0], [1, 1, 1]) > 0.9)
assert.equal(calculateChannelDifference([], []), null)

assert.equal(
  buildChannelDiagnosticHint({ actualChannels: 1 }).includes("mono"),
  true,
)
assert.equal(
  buildChannelDiagnosticHint({
    actualChannels: 2,
    rms0: 0.1,
    rms1: 0.1,
    correlation: 0.999,
    difference: 0.001,
  }).includes("nearly identical"),
  true,
)
assert.equal(
  buildChannelDiagnosticHint({
    actualChannels: 2,
    rms0: 0.2,
    rms1: 0.05,
    correlation: 0.2,
    difference: 0.2,
  }).includes("different signals"),
  true,
)
assert.equal(
  buildChannelDiagnosticHint({
    actualChannels: 2,
    rms0: 0.2,
    rms1: 0.0001,
    correlation: null,
    difference: 0.1,
  }).includes("significantly lower"),
  true,
)

assert.equal(classifyAudioError({ name: "NotAllowedError" }).code, AUDIO_ERROR_CODES.NotAllowedError)
assert.equal(classifyAudioError({ name: "NotFoundError" }).code, AUDIO_ERROR_CODES.NotFoundError)
assert.equal(classifyAudioError({ name: "NotReadableError" }).code, AUDIO_ERROR_CODES.NotReadableError)
assert.equal(classifyAudioError({ name: "OverconstrainedError" }).code, AUDIO_ERROR_CODES.OverconstrainedError)
assert.equal(classifyAudioError({ name: "Boom", message: "x" }).code, AUDIO_ERROR_CODES.Unknown)

console.log("audioInput.selftest ok")
