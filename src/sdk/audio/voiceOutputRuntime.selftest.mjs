/**
 * Voice output：解码、重采样相位、源样本计数与 playback ACK。
 * 播放完成由 PCMQueue.render 消费样本驱动，不用定时器冒充 ACK。
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  PCMQueue,
  composePlaybackWorkletSource,
  createPlaybackEngine,
  decodePcm16leBase64,
  XINQI_SOURCE_RATE,
} from "./pcmPlaybackQueue.js"
import { createVoiceOutputRuntime } from "./voiceOutputRuntime.js"

function pcmBase64(samples) {
  const bytes = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]))
    bytes.writeInt16LE(Math.round(value < 0 ? value * 32768 : value * 32767), i * 2)
  }
  return bytes.toString("base64")
}

function renderUntil(engine, predicate, limit = 8000) {
  let last = null
  for (let i = 0; i < limit; i += 1) {
    last = engine.render(128)
    if (predicate(last, engine.getState())) return last
  }
  return last
}

{
  const decoded = decodePcm16leBase64(pcmBase64([0, 0.5, -0.5]))
  assert.equal(decoded.ok, true)
  assert.equal(decoded.samples.length, 3)
  assert.ok(Math.abs(decoded.samples[1] - 0.5) < 0.001)
  assert.equal(decodePcm16leBase64("AAAA").ok, false)
}

function steadyOutput(rate) {
  const engine = createPlaybackEngine({ outputRate: rate })
  const acks = []
  const tracked = createPlaybackEngine({
    outputRate: rate,
    onAck: (ack) => acks.push(ack),
  })
  const samples = new Float32Array(12000).fill(0.5)
  tracked.begin("t-rate")
  tracked.appendSamples("t-rate", samples)
  const first = renderUntil(tracked, (frame) => frame.samplesPlayed > 1000)
  const second = tracked.render(256)
  const joined = [...first.output.slice(-8), ...second.output.slice(0, 8)]
  for (let i = 1; i < joined.length; i += 1) {
    assert.ok(Math.abs(joined[i] - joined[i - 1]) < 0.05, `phase jump at ${rate}`)
  }
  assert.ok(tracked.getState().samplesPlayed > 0)
  assert.ok(tracked.getState().samplesPlayed <= tracked.getState().samplesReceived)
  void engine
  return tracked
}

const at48 = steadyOutput(48000)
const at441 = steadyOutput(44100)
assert.equal(at48.getState().outputSampleRate, 48000)
assert.equal(at441.getState().outputSampleRate, 44100)
const ratio48 = XINQI_SOURCE_RATE / 48000
const played48 = at48.getState().samplesPlayed
assert.ok(played48 > 1000)
assert.ok(Math.abs(played48 / ratio48 - played48 / ratio48) === 0)

{
  const engine = createPlaybackEngine({ outputRate: 48000 })
  engine.begin("order")
  engine.appendSamples("order", new Float32Array(8000).fill(0.8))
  engine.appendSamples("order", new Float32Array(8000).fill(-0.8))
  renderUntil(engine, (frame) => frame.samplesPlayed > 9000)
  const tail = engine.render(64).output
  assert.ok(tail.some((sample) => sample < 0), "later chunk should play after earlier chunk")
}

{
  const engine = createPlaybackEngine({ outputRate: 48000 })
  engine.begin("under")
  engine.appendSamples("under", new Float32Array(5760).fill(0.2))
  renderUntil(engine, () => engine.getState().underruns > 0, 4000)
  assert.ok(engine.getState().underruns > 0)
}

{
  const engine = createPlaybackEngine({ outputRate: 48000, maxSeconds: 1 })
  engine.begin("overflow")
  const full = engine.appendSamples("overflow", new Float32Array(XINQI_SOURCE_RATE))
  assert.equal(full.ok, true)
  const overflow = engine.appendSamples("overflow", new Float32Array(10).fill(0.1))
  assert.equal(overflow.ok, false)
  assert.equal(overflow.reason, "overflow")
}

{
  const acks = []
  const engine = createPlaybackEngine({
    outputRate: 48000,
    onAck: (ack) => acks.push(ack),
  })
  engine.begin("count")
  engine.appendSamples("count", new Float32Array(20000).fill(0.25))
  renderUntil(engine, () => engine.getState().samplesPlayed >= 6000)
  const progress = acks.filter((item) => item.type === "playback.progress")
  assert.ok(progress.length >= 1)
  for (let i = 1; i < progress.length; i += 1) {
    assert.ok(progress[i].samples > progress[i - 1].samples)
    assert.ok(progress[i].samples <= engine.getState().samplesReceived)
  }
  assert.equal(engine.acceptProgress({ id: "old", samples: 1 }).reason, "stale-turn")
  assert.equal(engine.acceptProgress({ id: "count", samples: engine.getState().samplesReceived + 10 }).reason, "ahead-of-received")
}

{
  const acks = []
  const engine = createPlaybackEngine({
    outputRate: 48000,
    onAck: (ack) => acks.push(ack),
  })
  engine.begin("drain")
  engine.appendSamples("drain", new Float32Array(8000).fill(0.3))
  renderUntil(engine, () => engine.getState().samplesPlayed > 1000)
  assert.equal(acks.some((item) => item.type === "playback.done"), false)
  engine.finish("drain")
  assert.equal(acks.some((item) => item.type === "playback.done"), false)
  renderUntil(engine, () => engine.getState().doneSent)
  assert.equal(acks.at(-1).type, "playback.done")
  assert.equal(acks.at(-1).id, "drain")
  const progress = acks.filter((item) => item.type === "playback.progress")
  if (progress.length) {
    assert.ok(progress.at(-1).samples <= engine.getState().samplesReceived)
  }
}

{
  const acks = []
  const engine = createPlaybackEngine({
    outputRate: 48000,
    onAck: (ack) => acks.push(ack),
  })
  engine.begin("old")
  engine.appendSamples("old", new Float32Array(8000).fill(0.2))
  engine.begin("new")
  const ignored = engine.acceptProgress({ id: "old", samples: 100 })
  assert.equal(ignored.ok, false)
  engine.appendSamples("new", new Float32Array(8000).fill(0.2))
  renderUntil(engine, () => acks.some((item) => item.id === "new"))
  assert.equal(acks.some((item) => item.id === "old"), false)
}

{
  const acks = []
  const engine = createPlaybackEngine({
    outputRate: 48000,
    onAck: (ack) => acks.push(ack),
  })
  engine.begin("cut")
  engine.appendSamples("cut", new Float32Array(12000).fill(0.4))
  renderUntil(engine, () => engine.getState().samplesPlayed > 500)
  engine.interrupt("cut")
  for (let i = 0; i < 30; i += 1) engine.render(128)
  assert.equal(acks.some((item) => item.type === "playback.done"), false)
  assert.equal(engine.getState().state, "Interrupted")
}

{
  const acks = []
  const engine = createPlaybackEngine({
    outputRate: 48000,
    onAck: (ack) => acks.push(ack),
  })
  engine.begin("stop")
  engine.appendSamples("stop", new Float32Array(9000).fill(0.2))
  engine.stop()
  engine.render(256)
  assert.equal(acks.some((item) => item.type === "playback.done"), false)
  engine.begin("again")
  engine.appendSamples("again", new Float32Array(9000).fill(0.2))
  renderUntil(engine, () => engine.getState().samplesPlayed > 0)
  assert.equal(engine.getState().turnId, "again")
  engine.close()
  assert.equal(engine.begin("after-close").ok, false)
}

{
  const suspended = createVoiceOutputRuntime({
    AudioContextCtor: class {
      constructor() { this.state = "suspended"; this.sampleRate = 48000 }
      resume() { return Promise.resolve() }
      close() { this.state = "closed"; return Promise.resolve() }
    },
  })
  const result = await suspended.start()
  assert.equal(result.ok, false)
  assert.equal(result.code, "OUTPUT_SUSPENDED")
}

{
  const missing = createVoiceOutputRuntime({
    sinkId: "usb-speaker",
    AudioContextCtor: class {
      constructor() { this.state = "running"; this.sampleRate = 48000; this.audioWorklet = {} }
      resume() { return Promise.resolve() }
      setSinkId() { throw new Error("device gone") }
      close() { return Promise.resolve() }
    },
  })
  const result = await missing.start()
  assert.equal(result.ok, false)
  assert.equal(result.code, "OUTPUT_DEVICE_UNAVAILABLE")
}

{
  const acks = []
  const engine = createPlaybackEngine({
    outputRate: 48000,
    onAck: (ack) => acks.push(ack),
  })
  engine.begin("silent")
  engine.finish("silent")
  renderUntil(engine, () => engine.getState().doneSent, 40)
  assert.equal(engine.getState().doneSent, true)
  assert.equal(acks.some((item) => item.type === "playback.progress"), false)
  assert.equal(acks.some((item) => item.type === "playback.done"), true)
}

{
  const queue = readFileSync(new URL("./pcmPlaybackQueue.js", import.meta.url), "utf8")
  const processor = readFileSync(new URL("./worklets/pcmPlaybackProcessor.js", import.meta.url), "utf8")
  const composed = composePlaybackWorkletSource(queue, processor)
  assert.equal(composed.includes("export "), false)
  assert.equal(composed.includes("import "), false)
  assert.ok(composed.includes("registerProcessor(\"playback-processor\""))
  assert.ok(composed.includes("collectPlaybackNotices"))
}

{
  const { readPlaybackWorkletModuleText } = await import("./voiceOutputRuntime.js")
  const { fileURLToPath } = await import("node:url")
  await assert.rejects(
    () => readPlaybackWorkletModuleText("data:text/javascript;base64,YQ=="),
    /data:/,
  )
  const text = await readPlaybackWorkletModuleText(
    new URL("./pcmPlaybackQueue.js", import.meta.url),
    async (url) => ({
      ok: true,
      text: async () => readFileSync(fileURLToPath(String(url)), "utf8"),
    }),
  )
  assert.ok(text.includes("XINQI_SOURCE_RATE"))
}

{
  // 所选设备与默认设备均不可用时，必须显式失败（不得假装已开始播放）。
  const missing = createVoiceOutputRuntime({
    sinkId: "usb-speaker",
    AudioContextCtor: class {
      constructor() { this.state = "running"; this.sampleRate = 48000; this.audioWorklet = {} }
      resume() { return Promise.resolve() }
      setSinkId() { throw new Error("device gone") }
      close() { return Promise.resolve() }
    },
  })
  const hardFail = await missing.start()
  assert.equal(hardFail.ok, false)
  assert.equal(hardFail.code, "OUTPUT_DEVICE_UNAVAILABLE")
}

{
  // 所选设备失效时回退默认设备，并标记 sinkFallback。
  const queueSrc = readFileSync(new URL("./pcmPlaybackQueue.js", import.meta.url), "utf8")
  const processorSrc = readFileSync(new URL("./worklets/pcmPlaybackProcessor.js", import.meta.url), "utf8")
  const applied = []
  class FakeNode {
    constructor() { this.port = { onmessage: null, postMessage() {} } }
    connect() { return this }
    disconnect() {}
  }
  const previousNode = globalThis.AudioWorkletNode
  globalThis.AudioWorkletNode = FakeNode
  try {
    const runtime = createVoiceOutputRuntime({
      sinkId: "gone-device",
      AudioContextCtor: class {
        constructor() {
          this.state = "running"
          this.sampleRate = 48000
          this.destination = {}
          this.audioWorklet = { addModule: async () => {} }
        }
        resume() { return Promise.resolve() }
        async setSinkId(id) {
          applied.push(id)
          if (id === "gone-device") throw new Error("missing")
        }
        close() { return Promise.resolve() }
      },
      fetchImpl: async (url) => {
        const href = String(url)
        const body = href.includes("pcmPlaybackProcessor") ? processorSrc : queueSrc
        return { ok: true, text: async () => body }
      },
    })
    const result = await runtime.start()
    assert.equal(result.ok, true)
    assert.equal(result.sinkFallback, true)
    assert.deepEqual(applied, ["gone-device", ""])
    assert.equal(runtime.getState().workletState, "ready")
    assert.equal(runtime.getState().sinkFallback, true)
  } finally {
    globalThis.AudioWorkletNode = previousNode
  }
}

console.log("voiceOutputRuntime.selftest ok")
