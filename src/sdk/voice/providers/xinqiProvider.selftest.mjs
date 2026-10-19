/**
 * XinqiProvider：session / ready / 3200B 聚合 / 对话事件。不访问真实云。
 */
import assert from "node:assert/strict"
import { floatToPcm16leBuffer } from "../../audio/pcm16.js"
import { createAudioFrame, VOICE_AUDIO_FORMAT } from "../../audio/audioFrame.js"
import { createXinqiProvider } from "./xinqiProvider.js"
import { mapXinqiServerMessage } from "./xinqiProtocol.js"
import { VOICE_PROVIDER_EVENTS, VOICE_PROVIDER_STATES } from "../voiceProvider.js"
import { listVoiceProviders } from "../voiceProviderRegistry.js"

function makeFrame(sequence) {
  const samples = new Float32Array(VOICE_AUDIO_FORMAT.samplesPerFrame).fill(0.02)
  return createAudioFrame({
    sequence,
    timestampMs: sequence * 20,
    data: floatToPcm16leBuffer(samples),
  })
}

{
  const delta = mapXinqiServerMessage({ type: "turn.delta", id: "t1", text: "你好" })
  assert.equal(delta.incremental, true)
  assert.equal(delta.text, "你好")
  const done = mapXinqiServerMessage({
    type: "turn.text.done",
    id: "t1",
    message: { role: "assistant", content: "你好，我在。" },
  })
  assert.equal(done.text, "你好，我在。")
  const user = mapXinqiServerMessage({
    type: "user",
    message: { role: "user", content: "测试一句话" },
  })
  assert.equal(user.event, VOICE_PROVIDER_EVENTS.transcriptFinal)
  assert.equal(user.text, "测试一句话")
  const env = mapXinqiServerMessage({
    type: "environment",
    state: "ignored",
    target: "background",
    reason: "noise",
  })
  assert.equal(env.kind, "environment")
  assert.equal(env.environmentState, "ignored")
  assert.equal(env.environmentTarget, "background")
  const emptyPartial = mapXinqiServerMessage({ type: "transcript.partial", text: "" })
  assert.equal(emptyPartial.kind, "user_partial")
  assert.equal(emptyPartial.text, "")
  const gateErr = mapXinqiServerMessage({
    type: "error",
    code: "XINQI_INVALID_AUDIO_FRAME",
    message: "音频帧必须为 3200 字节，实际 87（Buffer）。",
    expectedBytes: 3200,
    actualBytes: 87,
    dataType: "Buffer",
    stage: "gateway_browser_message",
  })
  assert.equal(gateErr.kind, "gateway_error")
  assert.equal(gateErr.expectedBytes, 3200)
  assert.equal(gateErr.actualBytes, 87)
}

assert.ok(listVoiceProviders().some((item) => item.id === "xinqi"))

function harness({ fetchImpl, bufferedAmount = 0 } = {}) {
  let active = null
  class FakeWs {
    constructor(url) {
      this.url = url
      this.readyState = 0
      this.sent = []
      this.bufferedAmount = bufferedAmount
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
    close(code = 1000, reason = "bye") {
      this.readyState = 3
      this.onclose?.({ code, reason: String(reason || ""), wasClean: true })
    }
    server(obj) {
      this.onmessage?.({ data: JSON.stringify(obj) })
    }
  }
  const events = []
  const provider = createXinqiProvider({
    WebSocketCtor: FakeWs,
    fetchImpl: fetchImpl || (async () => ({
      ok: true,
      async json() {
        return { gatewaySessionId: "gw-1", sessionId: "s-1", protocol: { version: 1 } }
      },
    })),
    realtimeUrl: (id) => `ws://localhost/api/voice/xinqi/realtime?session=${id}`,
    readyTimeoutMs: 500,
    backpressureBytes: 1000,
    now: () => 10,
  })
  const listen = () => {
    provider.onEvent(VOICE_PROVIDER_EVENTS.transcriptPartial, (p) => events.push(["partial", p.text]))
    provider.onEvent(VOICE_PROVIDER_EVENTS.transcriptFinal, (p) => events.push(["user", p.text]))
    provider.onEvent(VOICE_PROVIDER_EVENTS.assistantStart, (p) => events.push(["start", p.turnId]))
    provider.onEvent(VOICE_PROVIDER_EVENTS.assistantDelta, (p) => events.push(["delta", p.text]))
    provider.onEvent(VOICE_PROVIDER_EVENTS.assistantTextDone, (p) => events.push(["done", p.text]))
    provider.onEvent(VOICE_PROVIDER_EVENTS.error, (p) => events.push(["error", p.code]))
    provider.onEvent(VOICE_PROVIDER_EVENTS.disconnected, () => events.push(["disconnected"]))
  }
  listen()
  return { provider, events, socket: () => active, listen }
}

{
  const { provider } = harness({
    fetchImpl: async () => ({
      ok: false,
      status: 502,
      async json() { return { error: { code: "XINQI_UNREACHABLE", message: "down" } } },
    }),
  })
  const failed = await provider.connect()
  assert.equal(failed.ok, false)
  assert.equal(failed.code, "XINQI_UNREACHABLE")
}

{
  const { provider, events, socket } = harness()
  const pending = provider.connect()
  await new Promise((r) => setTimeout(r, 20))
  const ws = socket()
  assert.ok(ws)
  assert.equal(String(ws.url).includes("gw-1"), true)
  ws.server({ type: "policy", policy: { turnTaking: "server" } })
  assert.equal(provider.getState(), VOICE_PROVIDER_STATES.CONNECTING)
  ws.server({ type: "ready", microphone: true })
  const connected = await pending
  assert.equal(connected.ok, true)
  assert.equal(provider.getState(), VOICE_PROVIDER_STATES.CONNECTED)
  assert.equal(provider.getStats().authState, "GATEWAY_SESSION")

  for (let i = 1; i <= 4; i += 1) provider.sendAudio(makeFrame(i))
  assert.equal(ws.sent.filter((item) => item instanceof ArrayBuffer).length, 0)
  assert.equal(provider.getStats().framesReceived, 4)
  assert.equal(provider.getStats().pendingAudioFrames, 4)

  provider.sendAudio(makeFrame(5))
  const binaries = ws.sent.filter((item) => item instanceof ArrayBuffer)
  assert.equal(binaries.length, 1)
  assert.equal(binaries[0].byteLength, 3200)
  assert.equal(binaries.some((item) => item.byteLength === 640), false)
  assert.equal(provider.getStats().audioChunksSent, 1)
  assert.equal(provider.getStats().providerBytesSent, 3200)

  ws.server({ type: "transcript.partial", text: "你好" })
  ws.server({ type: "user", message: { role: "user", content: "你好，测试" } })
  ws.server({ type: "turn.start", id: "turn-1", kind: "reply" })
  ws.server({ type: "turn.delta", id: "turn-1", text: "我在" })
  ws.server({ type: "turn.delta", id: "turn-1", text: "这里。" })
  ws.server({
    type: "turn.text.done",
    id: "turn-1",
    message: { role: "assistant", content: "我在这里。" },
  })
  ws.server({ type: "audio", id: "turn-stale", data: "BBBB", sampleRate: 24000 })
  ws.server({ type: "audio", id: "turn-1", data: "AAAA", sampleRate: 24000 })
  ws.server({ type: "audio.done", id: "turn-1" })
  ws.server({ type: "turn.done", id: "turn-1" })

  assert.deepEqual(events.filter((item) => item[0] === "partial").at(-1), ["partial", "你好"])
  assert.deepEqual(events.filter((item) => item[0] === "user").at(-1), ["user", "你好，测试"])
  assert.deepEqual(events.filter((item) => item[0] === "start").at(-1), ["start", "turn-1"])
  const deltas = events.filter((item) => item[0] === "delta").map((item) => item[1])
  assert.deepEqual(deltas, ["我在", "这里。"])
  assert.equal(deltas.join(""), "我在这里。")
  assert.deepEqual(events.filter((item) => item[0] === "done").at(-1), ["done", "我在这里。"])
  assert.equal(provider.getStats().audioEvents, 1)
  assert.equal(provider.getStats().audioDroppedTurnMismatch, 1)
  assert.equal(provider.getStats().audioDoneEvents, 1)
  assert.equal(provider.getStats().turnDoneEvents, 1)
  assert.equal(provider.getStats().playbackAckSent, 0)
  assert.equal(ws.sent.some((item) => typeof item === "string" && item.includes("playback")), false)

  const progress = provider.reportPlaybackProgress({ turnId: "turn-1", samples: 4800, received: 9600 })
  assert.equal(progress.ok, true)
  const progressMessage = JSON.parse(ws.sent.filter((item) => typeof item === "string").at(-1))
  assert.equal(progressMessage.type, "playback.progress")
  assert.equal(progressMessage.samples, 4800)
  assert.equal(provider.reportPlaybackProgress({ turnId: "turn-1", samples: 4800, received: 9600 }).reason, "not-monotonic")
  assert.equal(provider.reportPlaybackProgress({ turnId: "turn-1", samples: 20000, received: 9600 }).reason, "ahead-of-received")
  assert.equal(provider.reportPlaybackProgress({ turnId: "other", samples: 5000, received: 9600 }).reason, "stale-turn")
  const done = provider.reportPlaybackDone({ turnId: "turn-1" })
  assert.equal(done.ok, true)
  assert.equal(JSON.parse(ws.sent.filter((item) => typeof item === "string").at(-1)).type, "playback.done")
  assert.equal(provider.reportPlaybackDone({ turnId: "turn-1" }).ok, false)

  provider.sendAudio(makeFrame(6))
  provider.sendAudio(makeFrame(7))
  assert.equal(provider.getStats().pendingAudioFrames, 2)
  ws.server({ type: "fatal", message: "上游失败" })
  assert.ok(events.some((item) => item[0] === "error" && item[1] === "XINQI_FATAL"))

  await provider.disconnect()
  assert.equal(provider.getState(), VOICE_PROVIDER_STATES.IDLE)
  assert.equal(provider.reportPlaybackProgress({ turnId: "turn-1", samples: 6000, received: 6000 }).ok, false)
  assert.ok(events.includes("disconnected") || events.some((item) => item[0] === "disconnected"))
  assert.equal(ws.sent.filter((item) => item instanceof ArrayBuffer).every((buf) => buf.byteLength === 3200), true)
  assert.ok(provider.getStats().droppedFrames >= 2)
}

{
  const { provider, events, socket } = harness({ bufferedAmount: 5000 })
  const pending = provider.connect()
  await new Promise((r) => setTimeout(r, 20))
  const ws = socket()
  ws.server({ type: "ready", microphone: true })
  await pending
  const result = provider.sendAudio(makeFrame(1))
  assert.equal(result.ok, false)
  assert.equal(result.code, "XINQI_BACKPRESSURE")
  assert.equal(ws.sent.filter((item) => item instanceof ArrayBuffer).length, 0)
  assert.ok(events.some((item) => item[1] === "XINQI_BACKPRESSURE"))
  await provider.disconnect()
}

{
  const { provider, events, socket } = harness()
  for (let round = 0; round < 2; round += 1) {
    const pending = provider.connect()
    await new Promise((r) => setTimeout(r, 20))
    socket().server({ type: "ready", microphone: true })
    const connected = await pending
    assert.equal(connected.ok, true)
    await provider.disconnect()
    assert.equal(provider.getState(), VOICE_PROVIDER_STATES.IDLE)
  }
  assert.ok(events.filter((item) => item[0] === "disconnected").length >= 2)
}

{
  const { provider, events, socket } = harness()
  const pending = provider.connect()
  await new Promise((r) => setTimeout(r, 20))
  const ws = socket()
  ws.server({ type: "ready", microphone: true })
  await pending
  const audioEvents = []
  provider.onEvent(VOICE_PROVIDER_EVENTS.audioDelta, () => audioEvents.push("audio"))
  ws.server({ type: "turn.start", id: "turn-cut", kind: "reply" })
  ws.server({ type: "audio", id: "turn-cut", data: "AAAA", sampleRate: 24000 })
  assert.equal(audioEvents.length, 1)
  ws.server({
    type: "error",
    code: "XINQI_UPSTREAM_UNAVAILABLE",
    message: "Xinqi 上游 realtime 连接已关闭。",
    closeSide: "upstream",
    closeCode: 1000,
    closeReason: "upstream_close",
    cleanupReason: "upstream_close",
    connectionMs: 40400,
  })
  assert.ok(events.some((item) => item[0] === "error" && item[1] === "XINQI_UPSTREAM_UNAVAILABLE"))
  assert.equal(provider.getStats().closeSide, "upstream")
  assert.equal(provider.getStats().closeCode, 1000)
  assert.equal(provider.getStats().cleanupReason, "upstream_close")
  assert.equal(provider.reportPlaybackDone({ turnId: "turn-cut" }).ok, false)
  ws.close(1000, "upstream code=1000 upstream_close")
  assert.ok(events.some((item) => item[0] === "disconnected"))
  assert.equal(provider.getState(), VOICE_PROVIDER_STATES.ERROR)
  assert.equal(provider.sendAudio(makeFrame(99)).ok, false)
  await provider.disconnect()
}

{
  const { provider, events, socket } = harness()
  const pending = provider.connect()
  await new Promise((r) => setTimeout(r, 20))
  const ws = socket()
  ws.server({ type: "ready", microphone: true })
  await pending
  ws.close()
  assert.ok(events.some((item) => item[1] === "XINQI_WS_CLOSED"))
  assert.equal(provider.getStats().closeInitiator, "unknown")
}

{
  const { provider, socket } = harness()
  const pending = provider.connect()
  await new Promise((r) => setTimeout(r, 20))
  const ws = socket()
  ws.server({ type: "ready", microphone: true })
  await pending
  // 4 帧不足 3200，不应发送
  for (let i = 1; i <= 4; i += 1) assert.equal(provider.sendAudio(makeFrame(i)).ok, true)
  assert.equal(ws.sent.filter((item) => item instanceof ArrayBuffer).length, 0)
  // 第 5 帧聚合成 3200
  assert.equal(provider.sendAudio(makeFrame(5)).ok, true)
  assert.equal(ws.sent.filter((item) => item instanceof ArrayBuffer).at(-1).byteLength, 3200)
  // 非标准帧被拒绝，不得上行
  const bad = provider.sendAudio(createAudioFrame({
    sequence: 99,
    timestampMs: 0,
    data: new ArrayBuffer(100),
  }))
  assert.equal(bad.ok, false)
  assert.equal(ws.sent.filter((item) => item instanceof ArrayBuffer).every((buf) => buf.byteLength === 3200), true)
  // disconnect 后禁止上传
  await provider.disconnect()
  assert.equal(provider.sendAudio(makeFrame(10)).ok, false)
}

{
  const { provider, socket } = harness()
  const pending = provider.connect()
  await new Promise((r) => setTimeout(r, 20))
  socket().server({ type: "ready", microphone: true })
  await pending
  const traces = []
  provider.onEvent(VOICE_PROVIDER_EVENTS.trace, (p) => traces.push(p))
  socket().server({
    type: "environment",
    state: "ignored",
    target: "background",
    reason: "旁人聊天",
  })
  assert.ok(traces.some((item) => item.environmentState === "ignored" && item.environmentTarget === "background"))
  await provider.disconnect()
}

console.log("xinqiProvider.selftest ok")
