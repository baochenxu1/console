/**
 * Mock Voice Provider + AudioFrame 校验自测。
 */
import assert from "node:assert/strict"
import { floatToPcm16leBuffer } from "../audio/pcm16.js"
import { createAudioFrame, VOICE_AUDIO_FORMAT } from "../audio/audioFrame.js"
import { createMockVoiceProvider } from "./mockVoiceProvider.js"
import { listVoiceProviders, createVoiceProvider } from "./voiceProviderRegistry.js"
import { VOICE_PROVIDER_EVENTS, VOICE_PROVIDER_STATES } from "./voiceProvider.js"

assert.deepEqual(listVoiceProviders().map((item) => item.id), ["mock", "assemblyai", "deepgram", "xinqi"])
const provider = createVoiceProvider("mock")
assert.equal(provider.id, "mock")
assert.equal(provider.getState(), VOICE_PROVIDER_STATES.IDLE)
assert.equal(createVoiceProvider("assemblyai").id, "assemblyai")
assert.equal(createVoiceProvider("deepgram").id, "deepgram")
assert.equal(createVoiceProvider("xinqi").id, "xinqi")

const events = []
provider.onEvent(VOICE_PROVIDER_EVENTS.connected, (payload) => events.push(["connected", payload]))
provider.onEvent(VOICE_PROVIDER_EVENTS.disconnected, () => events.push(["disconnected"]))
provider.onEvent(VOICE_PROVIDER_EVENTS.error, (payload) => events.push(["error", payload.reason]))

const connected = await provider.connect()
assert.equal(connected.ok, true)
assert.equal(provider.getState(), VOICE_PROVIDER_STATES.CONNECTED)
assert.equal(events[0][0], "connected")

const samples = new Float32Array(VOICE_AUDIO_FORMAT.samplesPerFrame).fill(0.1)
const frame = createAudioFrame({
  sequence: 1,
  timestampMs: 12,
  data: floatToPcm16leBuffer(samples),
})
assert.equal(provider.sendAudio(frame).ok, true)
assert.equal(provider.getStats().framesReceived, 1)
assert.equal(provider.getStats().bytesReceived, 640)

const bad = createAudioFrame({
  sequence: 2,
  timestampMs: 32,
  data: new ArrayBuffer(10),
})
assert.equal(provider.sendAudio(bad).ok, false)
assert.equal(provider.getStats().invalidFrames, 1)
assert.equal(events.some((item) => item[0] === "error"), true)

const gap = createAudioFrame({
  sequence: 99,
  timestampMs: 40,
  data: floatToPcm16leBuffer(samples),
})
// previous valid sequence was 1; after invalid, lastSequence still 1
assert.equal(provider.sendAudio(gap).ok, false)

const next = createAudioFrame({
  sequence: 2,
  timestampMs: 40,
  data: floatToPcm16leBuffer(samples),
})
assert.equal(provider.sendAudio(next).ok, true)
assert.equal(provider.getStats().framesReceived, 2)

await provider.disconnect()
assert.equal(provider.getState(), VOICE_PROVIDER_STATES.IDLE)
assert.equal(events.some((item) => item[0] === "disconnected"), true)
assert.equal(createMockVoiceProvider().id, "mock")

console.log("voiceRuntime.selftest ok")
