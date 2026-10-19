/**
 * Audio Runtime 纯函数自测：PCM16 / Resampler / Frame Accumulator。
 */
import assert from "node:assert/strict"
import {
  clampFloatSample,
  floatSampleToInt16,
  floatToPcm16,
  floatToPcm16leBuffer,
  readPcm16leSample,
} from "./pcm16.js"
import { createLinearResampler } from "./audioResampler.js"
import {
  VOICE_AUDIO_FORMAT,
  createAudioFrame,
  createAudioFrameAccumulator,
  validateAudioFrame,
} from "./audioFrame.js"

assert.equal(clampFloatSample(2), 1)
assert.equal(clampFloatSample(-3), -1)
assert.equal(clampFloatSample(0.5), 0.5)
assert.equal(floatSampleToInt16(0), 0)
assert.equal(floatSampleToInt16(1), 32767)
assert.equal(floatSampleToInt16(-1), -32768)
assert.equal(floatSampleToInt16(0.5), 16384)
assert.equal(floatSampleToInt16(-0.5), -16384)
assert.equal(floatSampleToInt16(2), 32767)
assert.equal(floatSampleToInt16(-2), -32768)

const pcm = floatToPcm16([0, 1, -1, 0.5])
assert.deepEqual([...pcm], [0, 32767, -32768, 16384])

const le = floatToPcm16leBuffer([0, 1, -1])
assert.equal(le.byteLength, 6)
assert.equal(readPcm16leSample(le, 0), 0)
assert.equal(readPcm16leSample(le, 1), 32767)
assert.equal(readPcm16leSample(le, 2), -32768)
const bytes = new Uint8Array(le)
assert.equal(bytes[2], 0xff)
assert.equal(bytes[3], 0x7f)
assert.equal(bytes[4], 0x00)
assert.equal(bytes[5], 0x80)

{
  const resampler = createLinearResampler(48000, 16000)
  const one = resampler.process(new Float32Array(480).fill(0.25))
  assert.equal(one.length, 160)
  assert.ok(Math.abs(one[0] - 0.25) < 1e-6)

  const continuous = createLinearResampler(48000, 16000)
  let total = 0
  for (let i = 0; i < 10; i += 1) {
    total += continuous.process(new Float32Array(480).fill(0.1)).length
  }
  // 10 × 480 / 3 = 1600
  assert.equal(total, 1600)

  const blocks = createLinearResampler(48000, 16000)
  let blockTotal = 0
  for (let i = 0; i < 30; i += 1) {
    blockTotal += blocks.process(new Float32Array(128).fill(0.1)).length
  }
  // 30 × 128 / 3 = 1280；流式余数允许 ±2
  assert.ok(Math.abs(blockTotal - 1280) <= 2)
}

{
  const resampler = createLinearResampler(44100, 16000)
  const out = resampler.process(new Float32Array(441).fill(0))
  assert.ok(out.length > 140 && out.length < 180)
  assert.equal(out.every((n) => Number.isFinite(n)), true)
}

{
  let clock = 1000
  const acc = createAudioFrameAccumulator({
    encodePcm16le: floatToPcm16leBuffer,
    now: () => {
      clock += 20
      return clock
    },
  })
  const first = acc.push(new Float32Array(100).fill(0.1))
  assert.equal(first.length, 0)
  const second = acc.push(new Float32Array(100).fill(0.1))
  assert.equal(second.length, 0)
  const third = acc.push(new Float32Array(100).fill(0.1))
  assert.equal(third.length, 0)
  const fourth = acc.push(new Float32Array(100).fill(0.1))
  assert.equal(fourth.length, 1)
  assert.equal(fourth[0].samples, 320)
  assert.equal(fourth[0].byteLength, 640)
  assert.equal(fourth[0].sequence, 1)
  assert.equal(fourth[0].sampleRate, 16000)
  assert.equal(fourth[0].encoding, "pcm_s16le")
  assert.equal(acc.pendingSamples(), 80)
  const next = acc.push(new Float32Array(240).fill(0.2))
  assert.equal(next.length, 1)
  assert.equal(next[0].sequence, 2)
  assert.equal(acc.pendingSamples(), 0)
  assert.equal(validateAudioFrame(fourth[0]).ok, true)
  assert.equal(validateAudioFrame(createAudioFrame({
    sequence: 1,
    timestampMs: 1,
    data: new ArrayBuffer(10),
  })).ok, false)
}

assert.equal(VOICE_AUDIO_FORMAT.samplesPerFrame, 320)
assert.equal(VOICE_AUDIO_FORMAT.bytesPerFrame, 640)
assert.equal(VOICE_AUDIO_FORMAT.frameDurationMs, 20)

console.log("audioRuntime.selftest ok")
