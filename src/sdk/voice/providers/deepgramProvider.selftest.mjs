/**
 * Deepgram Provider：protocol join + Results buffering + mock WebSocket。
 */
import assert from "node:assert/strict"
import { floatToPcm16leBuffer } from "../../audio/pcm16.js"
import { createAudioFrame, VOICE_AUDIO_FORMAT } from "../../audio/audioFrame.js"
import {
  buildDeepgramWebSocketUrl,
  buildDeepgramWebSocketProtocols,
  mapDeepgramServerMessage,
  joinTranscriptSegments,
  composeCurrentTranscript,
  redactDeepgramWebSocketUrl,
  DEEPGRAM_SPEECH_MODEL,
  DEEPGRAM_CHUNK_BYTES,
  DEEPGRAM_CHUNK_DURATION_MS,
} from "./deepgramProtocol.js"
import { createDeepgramProvider } from "./deepgramProvider.js"
import { VOICE_PROVIDER_EVENTS, VOICE_PROVIDER_STATES } from "../voiceProvider.js"
import { listVoiceProviders } from "../voiceProviderRegistry.js"

function makeFrame(sequence) {
  const samples = new Float32Array(VOICE_AUDIO_FORMAT.samplesPerFrame).fill(0.05)
  return createAudioFrame({
    sequence,
    timestampMs: sequence * 20,
    data: floatToPcm16leBuffer(samples),
  })
}

{
  assert.equal(
    joinTranscriptSegments(["你好，我现在正在", "测试实时语音识别。"]),
    "你好，我现在正在测试实时语音识别。",
  )
  assert.equal(joinTranscriptSegments(["hello", "world"]), "hello world")
  assert.equal(joinTranscriptSegments(["hello ", "world"]), "hello world")
  assert.equal(joinTranscriptSegments(["你好。", "世界"]), "你好。世界")
  assert.equal(
    composeCurrentTranscript(["你好，我现在正在"], "测试 Deepgram"),
    "你好，我现在正在测试 Deepgram",
  )
}

{
  const url = buildDeepgramWebSocketUrl()
  assert.match(url, /^wss:\/\/api\.deepgram\.com\/v1\/listen\?/)
  assert.match(url, new RegExp(`model=${DEEPGRAM_SPEECH_MODEL}`))
  assert.match(url, /language=zh-CN/)
  assert.match(url, /encoding=linear16/)
  assert.match(url, /sample_rate=16000/)
  assert.match(url, /channels=1/)
  assert.match(url, /interim_results=true/)
  assert.match(url, /smart_format=true/)
  assert.match(url, /punctuate=true/)
  assert.match(url, /endpointing=300/)
  assert.match(url, /vad_events=true/)
  assert.match(url, /utterance_end_ms=1000/)
  assert.equal(url.includes("access_token="), false)
  assert.equal(url.includes("token="), false)
  assert.equal(redactDeepgramWebSocketUrl(url).includes("secret"), false)

  const protocols = buildDeepgramWebSocketProtocols("jwt-test-token")
  assert.deepEqual(protocols, ["bearer", "jwt-test-token"])
  assert.notEqual(protocols[0], "token")
}

{
  const interim = mapDeepgramServerMessage({
    type: "Results",
    is_final: false,
    speech_final: false,
    channel: { alternatives: [{ transcript: "你好" }] },
  }, () => 1)
  assert.equal(interim.kind, "results")
  assert.equal(interim.isFinal, false)
  assert.equal(interim.text, "你好")

  const stable = mapDeepgramServerMessage({
    type: "Results",
    is_final: true,
    speech_final: false,
    channel: { alternatives: [{ transcript: "你好，我现在正在" }] },
  }, () => 2)
  assert.equal(stable.isFinal, true)
  assert.equal(stable.speechFinal, false)

  const end = mapDeepgramServerMessage({
    type: "Results",
    is_final: true,
    speech_final: true,
    channel: { alternatives: [{ transcript: "测试实时语音识别。" }] },
  }, () => 3)
  assert.equal(end.speechFinal, true)

  assert.equal(mapDeepgramServerMessage({ type: "Metadata" }, () => 4).kind, "metadata")
  assert.equal(mapDeepgramServerMessage({ type: "SpeechStarted" }, () => 5).kind, "speech_started")
  assert.equal(mapDeepgramServerMessage({ type: "UtteranceEnd" }, () => 6).kind, "utterance_end")
  assert.equal(mapDeepgramServerMessage("{not-json", () => 7).ok, false)
}

{
  assert.ok(listVoiceProviders().some((item) => item.id === "deepgram"))
  assert.ok(listVoiceProviders().some((item) => item.id === "assemblyai"))
  assert.ok(listVoiceProviders().some((item) => item.id === "mock"))

  let active = null
  class ControllableWs {
    constructor(url, protocols) {
      this.url = url
      this.protocols = protocols
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
  const provider = createDeepgramProvider({
    WebSocketCtor: ControllableWs,
    fetchToken: async () => ({
      ok: true,
      provider: "deepgram",
      token: "jwt-live-test",
      expiresIn: 30,
    }),
    finalizeTimeoutMs: 200,
    now: () => 42,
  })
  provider.onEvent(VOICE_PROVIDER_EVENTS.transcriptPartial, (p) => events.push(["partial", p.text]))
  provider.onEvent(VOICE_PROVIDER_EVENTS.transcriptFinal, (p) => events.push(["final", p.text]))
  provider.onEvent(VOICE_PROVIDER_EVENTS.error, (p) => events.push(["error", p.code]))

  const connected = await provider.connect()
  assert.equal(connected.ok, true)
  assert.equal(provider.getState(), VOICE_PROVIDER_STATES.CONNECTED)
  assert.ok(active)
  assert.deepEqual(active.protocols, ["bearer", "jwt-live-test"])
  assert.equal(String(active.url).includes("jwt-live-test"), false)
  assert.equal(provider.getStats().authState, "TEMP_TOKEN")
  assert.equal(provider.getStats().streamingState, "ACTIVE")
  assert.equal(provider.getStats().chunkDurationMs, DEEPGRAM_CHUNK_DURATION_MS)
  assert.equal(provider.getStats().chunkBytes, DEEPGRAM_CHUNK_BYTES)

  for (let i = 0; i < 10; i += 1) {
    const result = provider.sendAudio(makeFrame(i + 1))
    assert.equal(result.ok, true)
  }
  assert.equal(provider.getStats().framesReceived, 10)
  assert.equal(provider.getStats().audioChunksSent, 10)
  assert.equal(provider.getStats().providerBytesSent, 10 * 640)
  assert.equal(active.sent.filter((item) => item instanceof ArrayBuffer || ArrayBuffer.isView(item)).length, 10)

  active.onmessage?.({
    data: JSON.stringify({
      type: "Results",
      is_final: false,
      speech_final: false,
      channel: { alternatives: [{ transcript: "你好" }] },
    }),
  })
  assert.deepEqual(events.at(-1), ["partial", "你好"])

  active.onmessage?.({
    data: JSON.stringify({
      type: "Results",
      is_final: true,
      speech_final: false,
      channel: { alternatives: [{ transcript: "你好，我现在正在" }] },
    }),
  })
  assert.equal(events.some((item) => item[0] === "final"), false)
  assert.deepEqual(events.at(-1), ["partial", "你好，我现在正在"])

  active.onmessage?.({
    data: JSON.stringify({
      type: "Results",
      is_final: false,
      speech_final: false,
      channel: { alternatives: [{ transcript: "测试 Deepgram 实时识别" }] },
    }),
  })
  assert.deepEqual(
    events.at(-1),
    ["partial", "你好，我现在正在测试 Deepgram 实时识别"],
  )

  active.onmessage?.({
    data: JSON.stringify({
      type: "Results",
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript: "测试实时语音识别。" }] },
    }),
  })
  assert.deepEqual(
    events.at(-1),
    ["final", "你好，我现在正在测试实时语音识别。"],
  )
  assert.equal(provider.getStats().finalTranscripts, 1)

  active.onmessage?.({ data: JSON.stringify({ type: "Metadata", request_id: "r1" }) })
  active.onmessage?.({ data: JSON.stringify({ type: "SpeechStarted" }) })
  active.onmessage?.({ data: JSON.stringify({ type: "UtteranceEnd" }) })
  active.onmessage?.({ data: "{broken" })
  assert.ok(events.some((item) => item[0] === "error"))

  await provider.disconnect()
  const jsonSent = active.sent
    .filter((item) => typeof item === "string")
    .map((item) => JSON.parse(item).type)
  assert.ok(jsonSent.includes("Finalize"))
  assert.ok(jsonSent.includes("CloseStream"))
  assert.equal(provider.getState(), VOICE_PROVIDER_STATES.IDLE)
  assert.equal(provider.getStats().streamingState, "DISCONNECTED")
}

console.log("deepgramProvider.selftest ok")
