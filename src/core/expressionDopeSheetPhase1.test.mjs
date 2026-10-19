/**
 * FaceDEV Expression Dope Sheet Phase 1 — 自动测试 A–R（核心可自动化部分）
 */
import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  createDefaultFrameProject,
  migrateLegacyKeyframesToAbsoluteTime,
  normalizeFrameProject,
  DEFAULT_TIMELINE_DURATION_MS,
} from "./frameProject.js"
import {
  ALL_TIMELINE_CHANNELS,
  buildFaceKeySummaries,
  buildGroupKeySummaries,
  getAllTimelineChannelIds,
  getChannelValueFromRig,
  isFullFaceKeyed,
  listTimelineChannels,
  listTimelineGroups,
  setChannelValueOnRig,
} from "./expressionTimelineChannels.js"
import {
  addChannelKeyAtTime,
  addFullFaceKeyAtTime,
  moveChannelKey,
  moveFullFaceKey,
} from "./expressionKeyframeOps.js"
import {
  buildExpressionTimeline,
  buildTransientKeyframeFromSample,
  resolveExpressionPlaybackWindow,
  sampleExpressionTimeline,
} from "./expressionTimelineSampler.js"
import { createInitialEliteRig, mapFaceRigToPose, normalizeEliteRig, rigValuesFromEliteRig } from "./faceDofMapper.js"
import { normalizeFaceRigProfile } from "./faceRigProfile.js"
import { computePlaybackTimelineTime } from "./actionPlayer.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

function almostEqual(a, b, eps = 1e-4) {
  assert.ok(Math.abs(Number(a) - Number(b)) <= eps, `expected ${a} ≈ ${b}`)
}

function makeLegacyKf(durationMs, rigPatch = {}) {
  const rig = createInitialEliteRig()
  Object.assign(rig.jaw, rigPatch.jaw || {})
  if (rigPatch.browL) Object.assign(rig.browL, rigPatch.browL)
  return {
    keyframeId: `kf_${Math.random().toString(36).slice(2, 7)}`,
    name: "legacy",
    durationMs,
    easing: "linear",
    positions: {},
    rigSnapshot: rig,
  }
}

test("A — Legacy Migration：duration 500/300/200 → time 0/500/800，duration ≥链长且不低于默认，ALL keyed", () => {
  const { keyframes, timelineDurationMs } = migrateLegacyKeyframesToAbsoluteTime([
    makeLegacyKf(500),
    makeLegacyKf(300),
    makeLegacyKf(200),
  ])
  assert.equal(keyframes[0].timeMs, 0)
  assert.equal(keyframes[1].timeMs, 500)
  assert.equal(keyframes[2].timeMs, 800)
  assert.equal(timelineDurationMs, Math.max(1000, DEFAULT_TIMELINE_DURATION_MS))
  assert.ok(isFullFaceKeyed(keyframes[0].keyedChannels))
  assert.equal(keyframes[0].keyedChannels.length, getAllTimelineChannelIds().length)

  const project = normalizeFrameProject({
    keyframes: [makeLegacyKf(500), makeLegacyKf(300), makeLegacyKf(200)],
  })
  assert.equal(project.timelineDurationMs, Math.max(1000, DEFAULT_TIMELINE_DURATION_MS))
  assert.equal(project.keyframes[2].timeMs, 800)
})

test("B — Full Face Key：完整 snapshot + ALL channels", () => {
  const base = createDefaultFrameProject([])
  const rig = createInitialEliteRig()
  rig.jaw.val = 40
  const next = addFullFaceKeyAtTime(base, 500, rig, {}, [])
  const ev = next.keyframes.find((k) => k.timeMs === 500)
  assert.ok(ev)
  assert.ok(ev.rigSnapshot)
  almostEqual(ev.rigSnapshot.jaw.val, 40)
  assert.ok(isFullFaceKeyed(ev.keyedChannels))
  assert.ok(ev.positions && typeof ev.positions === "object")
})

test("C — Single Channel Key：snapshot 完整，keyed 仅 jaw.value", () => {
  let project = createDefaultFrameProject([])
  const rig = createInitialEliteRig()
  rig.jaw.val = 55
  project = addChannelKeyAtTime(project, 400, "jaw.value", rig, {}, [])
  const ev = project.keyframes.find((k) => k.timeMs === 400)
  assert.ok(ev)
  assert.deepEqual(ev.keyedChannels, ["jaw.value"])
  assert.ok(ev.rigSnapshot?.browL)
  assert.ok(ev.rigSnapshot?.eyeL)
  almostEqual(ev.rigSnapshot.jaw.val, 55)
})

test("D — Independent Timing：brow / jaw 各自 progress", () => {
  let project = createDefaultFrameProject([])
  project = { ...project, timelineDurationMs: 1000 }

  let rig = createInitialEliteRig()
  project = addFullFaceKeyAtTime(project, 0, rig, {}, [])

  rig = createInitialEliteRig()
  rig.browL.y = 0
  project = addChannelKeyAtTime(project, 200, "brow_l_tip.y", rig, {}, [])
  rig = createInitialEliteRig()
  rig.browL.y = 100
  project = addChannelKeyAtTime(project, 800, "brow_l_tip.y", rig, {}, [])

  rig = createInitialEliteRig()
  rig.jaw.val = 0
  // t=0 already has jaw from full face; add mid key
  project = addChannelKeyAtTime(project, 500, "jaw.value", { ...createInitialEliteRig(), jaw: { val: 100, lateral: 0 } }, {}, [])

  // Fix jaw key value explicitly
  const jawEv = project.keyframes.find((k) => k.timeMs === 500)
  jawEv.rigSnapshot = setChannelValueOnRig(jawEv.rigSnapshot, "jaw.value", 100)

  const sample = sampleExpressionTimeline(project, 350)
  assert.equal(sample.legacyFallback, false)
  // brow: 200→800，progress (350-200)/(800-200)=0.25 → y=25
  almostEqual(getChannelValueFromRig(sample.rigSnapshot, "brow_l_tip.y"), 25, 0.5)
  // jaw: 0→500，progress 350/500=0.7 → val=70
  almostEqual(getChannelValueFromRig(sample.rigSnapshot, "jaw.value"), 70, 0.5)
})

test("E — Channel Hold：末 Key 之后持有", () => {
  let project = createDefaultFrameProject([])
  project.timelineDurationMs = 1000
  let rig = createInitialEliteRig()
  rig.jaw.val = 10
  project = addFullFaceKeyAtTime(project, 0, rig, {}, [])
  rig = createInitialEliteRig()
  rig.jaw.val = 80
  project = addChannelKeyAtTime(project, 300, "jaw.value", rig, {}, [])
  const sample = sampleExpressionTimeline(project, 900)
  almostEqual(getChannelValueFromRig(sample.rigSnapshot, "jaw.value"), 80, 0.5)
})

test("F — Same Time Merge", () => {
  let project = createDefaultFrameProject([])
  const rig = createInitialEliteRig()
  project = addChannelKeyAtTime(project, 400, "brow_l_tip.x", rig, {}, [])
  project = addChannelKeyAtTime(project, 400, "jaw.value", rig, {}, [])
  const at400 = project.keyframes.filter((k) => k.timeMs === 400)
  assert.equal(at400.length, 1)
  assert.ok(at400[0].keyedChannels.includes("brow_l_tip.x"))
  assert.ok(at400[0].keyedChannels.includes("jaw.value"))
})

test("G — Existing Key Preservation", () => {
  let project = createDefaultFrameProject([])
  let rig = createInitialEliteRig()
  rig.browL.x = 33
  project = addChannelKeyAtTime(project, 400, "brow_l_tip.x", rig, {}, [])
  const before = getChannelValueFromRig(
    project.keyframes.find((k) => k.timeMs === 400).rigSnapshot,
    "brow_l_tip.x"
  )
  rig = createInitialEliteRig()
  rig.browL.x = 99
  rig.jaw.val = 12
  project = addChannelKeyAtTime(project, 400, "jaw.value", rig, {}, [])
  const after = getChannelValueFromRig(
    project.keyframes.find((k) => k.timeMs === 400).rigSnapshot,
    "brow_l_tip.x"
  )
  almostEqual(after, before)
  almostEqual(
    getChannelValueFromRig(project.keyframes.find((k) => k.timeMs === 400).rigSnapshot, "jaw.value"),
    12
  )
})

test("H — Move Single Channel Key：自动拆 Event，双方完整 snapshot", () => {
  let project = createDefaultFrameProject([])
  const rig = createInitialEliteRig()
  rig.browL.x = 10
  rig.browL.y = 20
  project = addChannelKeyAtTime(project, 400, "brow_l_tip.x", rig, {}, [])
  project = addChannelKeyAtTime(project, 400, "brow_l_tip.y", rig, {}, [])
  project = moveChannelKey(project, 400, 500, "brow_l_tip.x", [])
  const at400 = project.keyframes.find((k) => k.timeMs === 400)
  const at500 = project.keyframes.find((k) => k.timeMs === 500)
  assert.ok(at400)
  assert.ok(at500)
  assert.deepEqual(at400.keyedChannels, ["brow_l_tip.y"])
  assert.deepEqual(at500.keyedChannels, ["brow_l_tip.x"])
  assert.ok(at400.rigSnapshot?.jaw)
  assert.ok(at500.rigSnapshot?.jaw)
  almostEqual(getChannelValueFromRig(at500.rigSnapshot, "brow_l_tip.x"), 10)
})

test("I — Move Into Existing Event：正确 merge", () => {
  let project = createDefaultFrameProject([])
  let rig = createInitialEliteRig()
  rig.browL.x = 5
  project = addChannelKeyAtTime(project, 200, "brow_l_tip.x", rig, {}, [])
  rig = createInitialEliteRig()
  rig.jaw.val = 7
  project = addChannelKeyAtTime(project, 500, "jaw.value", rig, {}, [])
  project = moveChannelKey(project, 200, 500, "brow_l_tip.x", [])
  const at500 = project.keyframes.find((k) => k.timeMs === 500)
  assert.ok(at500.keyedChannels.includes("jaw.value"))
  assert.ok(at500.keyedChannels.includes("brow_l_tip.x"))
  almostEqual(getChannelValueFromRig(at500.rigSnapshot, "brow_l_tip.x"), 5)
})

test("J — Move Full Face Key", () => {
  let project = createDefaultFrameProject([])
  const rig = createInitialEliteRig()
  project = addFullFaceKeyAtTime(project, 200, rig, {}, [])
  project = moveFullFaceKey(project, 200, 600, [])
  assert.ok(!project.keyframes.some((k) => k.timeMs === 200 && isFullFaceKeyed(k.keyedChannels)))
  const at600 = project.keyframes.find((k) => k.timeMs === 600)
  assert.ok(isFullFaceKeyed(at600.keyedChannels))
})

test("K — Group Summary", () => {
  const events = [
    { timeMs: 100, keyedChannels: ["brow_l_tip.x"] },
    { timeMs: 200, keyedChannels: ["brow_l_tip.y"] },
    { timeMs: 300, keyedChannels: ["brow_r_tip.x"] },
  ]
  const brow = listTimelineGroups().find((g) => g.groupId === "brow")
  const summaries = buildGroupKeySummaries(events, brow.channelIds)
  assert.deepEqual(
    summaries.map((s) => s.timeMs),
    [100, 200, 300]
  )
  assert.ok(summaries.every((s) => s.kind === "hollow"))
})

test("L — Face Summary：partial hollow / full solid", () => {
  const all = getAllTimelineChannelIds()
  const summaries = buildFaceKeySummaries([
    { timeMs: 0, keyedChannels: all },
    { timeMs: 100, keyedChannels: ["jaw.value"] },
  ])
  assert.equal(summaries.find((s) => s.timeMs === 0).kind, "solid")
  assert.equal(summaries.find((s) => s.timeMs === 100).kind, "hollow")
})

test("M — Timeline Sample at Diamond：partial 用 sampledRig 而非 event.rigSnapshot", () => {
  let project = createDefaultFrameProject([])
  project.timelineDurationMs = 1000
  let rig = createInitialEliteRig()
  rig.jaw.val = 0
  project = addFullFaceKeyAtTime(project, 0, rig, {}, [])
  rig = createInitialEliteRig()
  rig.jaw.val = 100
  project = addFullFaceKeyAtTime(project, 1000, rig, {}, [])
  // partial at 500：snapshot 里故意放 jaw=-40（合法 signed），但只 key brow
  rig = createInitialEliteRig()
  rig.jaw.val = -40
  rig.browL.x = 50
  project = addChannelKeyAtTime(project, 500, "brow_l_tip.x", rig, {}, [])
  const ev = project.keyframes.find((k) => k.timeMs === 500)
  almostEqual(ev.rigSnapshot.jaw.val, -40)
  const sample = sampleExpressionTimeline(project, 500)
  // jaw 应由 0→1000 全脸插值得到 ~50，而不是 event 上下文 -40
  almostEqual(getChannelValueFromRig(sample.rigSnapshot, "jaw.value"), 50, 1)
  almostEqual(getChannelValueFromRig(sample.rigSnapshot, "brow_l_tip.x"), 50, 1)
  assert.notEqual(
    getChannelValueFromRig(sample.rigSnapshot, "jaw.value"),
    getChannelValueFromRig(ev.rigSnapshot, "jaw.value")
  )
})

test("N — Loop Stability：elapsed % duration", () => {
  const t = computePlaybackTimelineTime({
    nowMs: 2500,
    anchorClockMs: 0,
    anchorTimelineMs: 0,
    totalDurationMs: 1000,
    loop: true,
  })
  assert.equal(t, 500)
})

test("O — Hardware Regression：sampled full Rig → transient → mapper", () => {
  let project = createDefaultFrameProject([])
  const sample = sampleExpressionTimeline(project, 0)
  assert.ok(sample.rigSnapshot)
  const transient = buildTransientKeyframeFromSample(sample, { moveTimeMs: 20 })
  assert.equal(transient.transient, true)
  assert.ok(transient.rigSnapshot)
  const profile = normalizeFaceRigProfile({})
  const mapped = mapFaceRigToPose(rigValuesFromEliteRig(transient.rigSnapshot), profile, [])
  assert.ok(mapped?.logicalPose)
})

test("P — Legacy Project Playback 时间点一致（迁移前后）", () => {
  const legacy = [makeLegacyKf(500, { jaw: { val: 0 } }), makeLegacyKf(500, { jaw: { val: 100 } })]
  const oldTimeline = buildExpressionTimeline(legacy)
  assert.equal(oldTimeline.totalDurationMs, 1000)
  const oldMid = sampleExpressionTimeline(legacy, 250)
  const migrated = normalizeFrameProject({ keyframes: legacy })
  const newMid = sampleExpressionTimeline(migrated, 250)
  almostEqual(oldMid.rigSnapshot.jaw.val, newMid.rigSnapshot.jaw.val, 1)
})

test("P2 — 全量播放窗口：第一关键 → 最后一帧（不播满 timelineDuration）", () => {
  let project = createDefaultFrameProject([])
  project = { ...project, timelineDurationMs: 5000 }
  const rigA = createInitialEliteRig()
  const rigB = createInitialEliteRig()
  rigB.jaw.val = 80
  project = addFullFaceKeyAtTime(project, 0, rigA, {}, [])
  project = addFullFaceKeyAtTime(project, 2000, rigB, {}, [])
  const timeline = buildExpressionTimeline(project)
  assert.equal(timeline.totalDurationMs, 5000)
  const win = resolveExpressionPlaybackWindow(timeline, 0, null)
  assert.equal(win.startTimeMs, 0)
  assert.equal(win.endTimeMs, 2000)
  assert.equal(win.windowDurationMs, 2000)
})

test("Q — Face Rig Layout Regression：仍挂载 FaceRigControls + Dope Sheet", () => {
  const editor = readFileSync(join(__dirname, "../sdk/react/FaceExpressionEditor.jsx"), "utf8")
  assert.match(editor, /FaceRigControls/)
  assert.match(editor, /ExpressionDopeSheetTimeline/)
  assert.match(editor, /face-expression-bottom/)
})

test("R — Protocol / Channel Registry：无舵机 ID，排除 F\/D\/jaw_A", () => {
  const channels = listTimelineChannels()
  assert.ok(channels.length > 10)
  assert.ok(channels.every((c) => c.channelId.includes(".")))
  assert.ok(!channels.some((c) => /_F|_D|jaw_A|tongue|tip_a/.test(c.controlId)))
  assert.ok(ALL_TIMELINE_CHANNELS.includes("jaw.value"))
  assert.ok(ALL_TIMELINE_CHANNELS.includes("brow_l_tip.x"))
})
