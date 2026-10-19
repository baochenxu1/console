/**
 * FaceDEV 表情编排 Phase 1：Timeline Sampler + 绝对时钟播放器测试（A–N）
 */
import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  EXPRESSION_HARDWARE_SAMPLE_INTERVAL_MS,
  computePlaybackTimelineTime,
  createLatestWinsCadenceGate,
  playKeyframes,
} from "./actionPlayer.js"
import { applyEasing } from "./expressionEasing.js"
import {
  buildExpressionTimeline,
  buildTransientKeyframeFromSample,
  interpolateRigSnapshot,
  sampleExpressionTimeline,
} from "./expressionTimelineSampler.js"
import { createInitialEliteRig, mapFaceRigToPose, rigValuesFromEliteRig } from "./faceDofMapper.js"
import { normalizeFaceRigProfile } from "./faceRigProfile.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

function makeKf(partial) {
  return {
    keyframeId: partial.keyframeId || `kf_${Math.random().toString(36).slice(2, 8)}`,
    name: partial.name || "kf",
    durationMs: partial.durationMs ?? 500,
    easing: partial.easing || "linear",
    positions: partial.positions || {},
    ...(partial.rigSnapshot ? { rigSnapshot: partial.rigSnapshot } : {}),
  }
}

function almostEqual(a, b, eps = 1e-6) {
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`)
}

test("A — Timeline 累计时间", () => {
  const keyframes = [
    makeKf({ durationMs: 500, rigSnapshot: createInitialEliteRig() }),
    makeKf({ durationMs: 300, rigSnapshot: createInitialEliteRig() }),
    makeKf({ durationMs: 500, rigSnapshot: createInitialEliteRig() }),
  ]
  const timeline = buildExpressionTimeline(keyframes)
  assert.equal(timeline.keyframes[0].timeMs, 0)
  assert.equal(timeline.keyframes[1].timeMs, 500)
  assert.equal(timeline.keyframes[2].timeMs, 800)
  assert.equal(timeline.totalDurationMs, 1300)
})

test("B — 线性插值 50%", () => {
  const from = createInitialEliteRig()
  from.jaw.val = 0
  const to = createInitialEliteRig()
  to.jaw.val = 100
  const mid = interpolateRigSnapshot(from, to, 0.5)
  almostEqual(mid.jaw.val, 50)
})

test("C — 多 Rig DOF 插值", () => {
  const from = createInitialEliteRig()
  from.browL.x = 0
  from.browL.y = -20
  from.jaw.val = 0
  from.jaw.lateral = -10
  const to = createInitialEliteRig()
  to.browL.x = 100
  to.browL.y = 20
  to.jaw.val = 50
  to.jaw.lateral = 10
  const mid = interpolateRigSnapshot(from, to, 0.5)
  almostEqual(mid.browL.x, 50)
  almostEqual(mid.browL.y, 0)
  almostEqual(mid.jaw.val, 25)
  almostEqual(mid.jaw.lateral, 0)
})

test("D — Easing：linear + 未知 fallback", () => {
  almostEqual(applyEasing(0.5, "linear"), 0.5)
  almostEqual(applyEasing(0.5, "unknown-curve-xyz"), 0.5)
  assert.ok(applyEasing(0.5, "ease-in") < 0.5)
  assert.ok(applyEasing(0.5, "ease-out") > 0.5)

  const from = createInitialEliteRig()
  from.jaw.val = 0
  const to = createInitialEliteRig()
  to.jaw.val = 100
  const keyframes = [
    makeKf({ durationMs: 1000, easing: "ease-in", rigSnapshot: from }),
    makeKf({ durationMs: 100, rigSnapshot: to }),
  ]
  const sample = sampleExpressionTimeline(keyframes, 500)
  almostEqual(sample.rawProgress, 0.5)
  assert.ok(sample.easedProgress < sample.rawProgress)
  almostEqual(sample.rigSnapshot.jaw.val, sample.easedProgress * 100, 1e-4)
})

test("E — Rig → Mapper（非舵机直接插值）", () => {
  const from = createInitialEliteRig()
  from.jaw.val = 0
  const to = createInitialEliteRig()
  to.jaw.val = 40
  const keyframes = [
    makeKf({ durationMs: 1000, rigSnapshot: from }),
    makeKf({ durationMs: 100, rigSnapshot: to }),
  ]
  const sample = sampleExpressionTimeline(keyframes, 500)
  assert.equal(sample.legacyFallback, false)
  assert.ok(sample.rigSnapshot)
  almostEqual(sample.rigSnapshot.jaw.val, 20)

  const profile = normalizeFaceRigProfile({})
  const mapped = mapFaceRigToPose(rigValuesFromEliteRig(sample.rigSnapshot), profile, [])
  assert.ok(mapped && typeof mapped.logicalPose === "object")

  const transient = buildTransientKeyframeFromSample(sample, { moveTimeMs: 20 })
  assert.ok(transient.rigSnapshot)
  assert.equal(transient.transient, true)
  assert.deepEqual(Object.keys(transient.positions || {}), [])
})

test("F — Legacy 无 rigSnapshot", () => {
  const keyframes = [
    makeKf({ durationMs: 500, positions: { "0": 1500 } }),
    makeKf({ durationMs: 500, positions: { "0": 2000 }, rigSnapshot: createInitialEliteRig() }),
  ]
  const sample = sampleExpressionTimeline(keyframes, 250)
  assert.equal(sample.legacyFallback, true)
  assert.equal(sample.holdKeyframe?.positions?.["0"], 1500)
})

test("G — Absolute Clock（非固定累加 20ms）", () => {
  const ticks = [0, 21, 43, 71, 95]
  const times = ticks.map((nowMs) =>
    computePlaybackTimelineTime({
      nowMs,
      anchorClockMs: 0,
      anchorTimelineMs: 0,
      totalDurationMs: 1000,
      loop: false,
    })
  )
  assert.deepEqual(times, ticks)
  assert.notEqual(times[1] - times[0], 20)
})

test("H — Loop 长时间稳定（无漂移）", () => {
  const total = 1000
  for (const elapsed of [950, 1010, 1990, 2025, 10025]) {
    const t = computePlaybackTimelineTime({
      nowMs: elapsed,
      anchorClockMs: 0,
      anchorTimelineMs: 0,
      totalDurationMs: total,
      loop: true,
    })
    assert.equal(t, elapsed % total)
  }
})

test("I — Pause / Resume 冻结时间", async () => {
  let now = 0
  const clock = () => now
  const controlRef = { current: null }
  const controller = new AbortController()

  const playPromise = playKeyframes({
    keyframes: [
      makeKf({ durationMs: 1000, rigSnapshot: createInitialEliteRig() }),
      makeKf({ durationMs: 1000, rigSnapshot: createInitialEliteRig() }),
    ],
    loop: false,
    clock,
    controlRef,
    signal: controller.signal,
    hardwareIntervalMs: 50,
    scheduleUi: (cb) => setTimeout(cb, 0),
    cancelUi: (id) => clearTimeout(id),
    scheduleHw: (cb, ms) => setInterval(cb, ms),
    clearHw: (id) => clearInterval(id),
    sendKeyframe: async () => {},
  })

  await new Promise((r) => setTimeout(r, 5))
  now = 400
  await new Promise((r) => setTimeout(r, 5))
  controlRef.current?.pause?.()
  const pausedAt = controlRef.current?.getTimelineTime?.() ?? 0
  almostEqual(pausedAt, 400, 1)

  now = 4000
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(controlRef.current?.getTimelineTime?.(), pausedAt)

  controlRef.current?.resume?.()
  now = 4100
  await new Promise((r) => setTimeout(r, 5))
  const after = controlRef.current?.getTimelineTime?.() ?? 0
  almostEqual(after, 500, 30)

  controller.abort()
  await playPromise
})

test("J — Stop 后 stale send 不再 dispatch", async () => {
  let now = 0
  const clock = () => now
  const dispatches = []
  const controller = new AbortController()
  let generationAlive = true

  const playPromise = playKeyframes({
    keyframes: [
      makeKf({ durationMs: 5000, rigSnapshot: createInitialEliteRig() }),
      makeKf({ durationMs: 5000, rigSnapshot: createInitialEliteRig() }),
    ],
    loop: true,
    clock,
    signal: controller.signal,
    hardwareIntervalMs: 20,
    scheduleUi: (cb) => setTimeout(cb, 1),
    cancelUi: (id) => clearTimeout(id),
    scheduleHw: (cb, ms) => setInterval(cb, ms),
    clearHw: (id) => clearInterval(id),
    sendKeyframe: async ({ keyframe }) => {
      if (!generationAlive) {
        dispatches.push("STALE")
        return
      }
      dispatches.push(keyframe.keyframeId)
    },
  })

  await new Promise((r) => setTimeout(r, 30))
  controller.abort()
  generationAlive = false
  now = 200
  await new Promise((r) => setTimeout(r, 50))
  await playPromise
  assert.ok(!dispatches.includes("STALE"))
})

test("K — Hardware Cadence ≠ UI sample 次数", () => {
  let now = 0
  const gate = createLatestWinsCadenceGate({
    intervalMs: EXPRESSION_HARDWARE_SAMPLE_INTERVAL_MS,
    now: () => now,
  })
  let uiSamples = 0
  let hwSends = 0
  for (let t = 0; t < 100; t += 1) {
    now = t
    gate.offer({ t })
    uiSamples += 1
    if (gate.takeIfDue()) {
      hwSends += 1
    }
  }
  assert.ok(uiSamples > hwSends)
  assert.ok(hwSends <= Math.ceil(100 / EXPRESSION_HARDWARE_SAMPLE_INTERVAL_MS) + 1)
})

test("L — Latest wins（窗口内只发最新）", () => {
  let now = 0
  const gate = createLatestWinsCadenceGate({ intervalMs: 20, now: () => now })
  gate.offer({ id: 100 })
  gate.offer({ id: 108 })
  gate.offer({ id: 116 })
  gate.offer({ id: 120 })
  const due = gate.takeIfDue()
  assert.equal(due.id, 120)
  assert.equal(gate.peekPending(), null)
})

test("M — Scrub 到 segment 中间", () => {
  const from = createInitialEliteRig()
  from.mouth.UL = 0
  const to = createInitialEliteRig()
  to.mouth.UL = 80
  const keyframes = [
    makeKf({ durationMs: 1000, rigSnapshot: from }),
    makeKf({ durationMs: 100, rigSnapshot: to }),
  ]
  const sample = sampleExpressionTimeline(keyframes, 250)
  almostEqual(sample.timelineTimeMs, 250)
  almostEqual(sample.rawProgress, 0.25)
  almostEqual(sample.rigSnapshot.mouth.UL, 20)
})

test("N — Protocol regression：播放器不依赖 SC/ST/RJ 协议实现", () => {
  const actionPlayerSrc = readFileSync(join(__dirname, "actionPlayer.js"), "utf8")
  const samplerSrc = readFileSync(join(__dirname, "expressionTimelineSampler.js"), "utf8")
  for (const src of [actionPlayerSrc, samplerSrc]) {
    assert.equal(src.includes("rjSbus"), false)
    assert.equal(src.includes("Scscl"), false)
    assert.equal(src.includes("syncWrite"), false)
    assert.equal(src.includes("sendBusServoCommands"), false)
    assert.equal(src.includes("rjHostMotionAdapter"), false)
  }
  assert.ok(actionPlayerSrc.includes("sendKeyframe"))
})
