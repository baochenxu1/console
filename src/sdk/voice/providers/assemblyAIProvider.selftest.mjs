/**
 * AssemblyAI Provider：aggregator + protocol + mock WebSocket。
 */
import assert from "node:assert/strict"
import { floatToPcm16leBuffer } from "../../audio/pcm16.js"
import { createAudioFrame, VOICE_AUDIO_FORMAT } from "../../audio/audioFrame.js"
import {
  createAssemblyAIChunkAggregator,
  ASSEMBLYAI_CHUNK_BYTES,
  ASSEMBLYAI_FRAMES_PER_CHUNK,
} from "./assemblyAIChunkAggregator.js"
import {
  buildAssemblyAIWebSocketUrl,
  mapAssemblyAIServerMessage,
  redactWebSocketUrl,
  ASSEMBLYAI_SPEECH_MODEL,
} from "./assemblyAIProtocol.js"
import { createAssemblyAIProvider } from "./assemblyAIProvider.js"
import { VOICE_PROVIDER_EVENTS, VOICE_PROVIDER_STATES } from "../voiceProvider.js"
import { listVoiceProviders } from "../voiceProviderRegistry.js"
import { defaultFetch, isLikelyUnboundNativeMethod } from "../browserApi.js"

assert.equal(isLikelyUnboundNativeMethod(defaultFetch), false)

function makeFrame(sequence) {
  const samples = new Float32Array(VOICE_AUDIO_FORMAT.samplesPerFrame).fill(0.05)
  return createAudioFrame({
    sequence,
    timestampMs: sequence * 20,
    data: floatToPcm16leBuffer(samples),
  })
}

{
  const agg = createAssemblyAIChunkAggregator()
  assert.equal(ASSEMBLYAI_FRAMES_PER_CHUNK, 5)
  assert.equal(ASSEMBLYAI_CHUNK_BYTES, 3200)
  const out1 = []
  for (let i = 0; i < 5; i += 1) {
    out1.push(...agg.push(makeFrame(i + 1).data))
  }
  assert.equal(out1.length, 1)
  assert.equal(out1[0].byteLength, 3200)

  const out2 = []
  for (let i = 0; i < 12; i += 1) {
    out2.push(...agg.push(makeFrame(i + 1).data))
  }
  assert.equal(out2.length, 2)
  assert.equal(agg.getState().pendingFrames, 2)
  assert.equal(agg.getState().pendingBytes, 1280)
  const tail = agg.flush()
  assert.equal(tail.byteLength, 1280)
  assert.equal(agg.getState().pendingBytes, 0)
}

{
  const url = buildAssemblyAIWebSocketUrl({ token: "secret-token" })
  assert.match(url, /^wss:\/\/streaming\.assemblyai\.com\/v3\/ws\?/)
  assert.match(url, /sample_rate=16000/)
  assert.match(url, /encoding=pcm_s16le/)
  assert.match(url, new RegExp(`speech_model=${ASSEMBLYAI_SPEECH_MODEL}`))
  assert.match(url, /language_codes=/)
  assert.match(url, /token=secret-token/)
  const redacted = redactWebSocketUrl(url)
  assert.equal(redacted.includes("secret-token"), false)
  assert.match(redacted, /token=%5Bredacted%5D|token=\[redacted\]/)
}

{
  const partial = mapAssemblyAIServerMessage({
    type: "Turn",
    end_of_turn: false,
    transcript: "你好",
    turn_order: 1,
  }, () => 11)
  assert.equal(partial.event, VOICE_PROVIDER_EVENTS.transcriptPartial)
  assert.equal(partial.text, "你好")

  const final = mapAssemblyAIServerMessage({
    type: "Turn",
    end_of_turn: true,
    transcript: "你好世界",
    turn_order: 1,
  }, () => 22)
  assert.equal(final.event, VOICE_PROVIDER_EVENTS.transcriptFinal)

  const begin = mapAssemblyAIServerMessage({ type: "Begin", id: "abc" }, () => 1)
  assert.equal(begin.kind, "begin")
  const term = mapAssemblyAIServerMessage({ type: "Termination" }, () => 2)
  assert.equal(term.kind, "termination")
  const bad = mapAssemblyAIServerMessage("{not-json", () => 3)
  assert.equal(bad.ok, false)
}

{
  assert.ok(listVoiceProviders().some((item) => item.id === "assemblyai"))
  assert.ok(listVoiceProviders().some((item) => item.id === "mock"))

  let active = null
  class ControllableWs {
    constructor(url) {
      this.url = url
      this.readyState = 0
      this.sent = []
      this.onopen = null
      this.onmessage = null
      this.onerror = null
      this.onclose = null
      active = this
      queueMicrotask(() => {
        this.readyState = 1
        this.onopen?.({})
      })
    }
    send(data) { this.sent.push(data) }
    close() {
      this.readyState = 3
      this.onclose?.({ code: 1000, reason: "bye", wasClean: true })
    }
  }

  const events = []
  const provider = createAssemblyAIProvider({
    WebSocketCtor: ControllableWs,
    fetchToken: async () => ({ ok: true, token: "tok2", expiresIn: 60 }),
    terminateTimeoutMs: 80,
  })
  provider.onEvent(VOICE_PROVIDER_EVENTS.connected, () => events.push("connected"))
  provider.onEvent(VOICE_PROVIDER_EVENTS.transcriptPartial, (p) => events.push(["p", p.text]))
  provider.onEvent(VOICE_PROVIDER_EVENTS.transcriptFinal, (p) => events.push(["f", p.text]))
  provider.onEvent(VOICE_PROVIDER_EVENTS.error, (p) => events.push(["e", p.code]))
  provider.onEvent(VOICE_PROVIDER_EVENTS.disconnected, () => events.push("disconnected"))

  assert.equal((await provider.connect()).ok, true)
  await new Promise((r) => setTimeout(r, 0))
  assert.ok(events.includes("connected"))
  assert.equal(provider.getState(), VOICE_PROVIDER_STATES.CONNECTED)

  active.onmessage({ data: JSON.stringify({ type: "Begin", id: "1" }) })
  active.onmessage({
    data: JSON.stringify({ type: "Turn", end_of_turn: false, transcript: "测试", turn_order: 1 }),
  })
  active.onmessage({
    data: JSON.stringify({ type: "Turn", end_of_turn: true, transcript: "测试完成", turn_order: 1 }),
  })
  active.onmessage({ data: "{bad" })
  assert.deepEqual(events.filter((item) => Array.isArray(item) && (item[0] === "p" || item[0] === "f")), [
    ["p", "测试"],
    ["f", "测试完成"],
  ])
  assert.ok(events.some((item) => Array.isArray(item) && item[0] === "e"))

  for (let i = 0; i < 5; i += 1) {
    assert.equal(provider.sendAudio(makeFrame(i + 1)).ok, true)
  }
  assert.equal(provider.getStats().audioChunksSent, 1)
  assert.equal(provider.getStats().providerBytesSent, 3200)
  assert.equal(provider.getStats().framesReceived, 5)

  await provider.disconnect()
  assert.ok(active.sent.some((item) => typeof item === "string" && item.includes("Terminate")))
  assert.equal(provider.getState(), VOICE_PROVIDER_STATES.IDLE)
  assert.ok(events.includes("disconnected"))
}

console.log("assemblyAIProvider.selftest ok")
