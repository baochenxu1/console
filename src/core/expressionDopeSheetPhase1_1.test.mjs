/**
 * FaceDEV Expression Dope Sheet Phase 1.1 — 整脸关键帧正式收敛测试
 */
import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  createDefaultFrameProject,
  normalizeFrameProject,
} from "./frameProject.js"
import {
  getAllTimelineChannelIds,
  isFullFaceKeyed,
} from "./expressionTimelineChannels.js"
import {
  addChannelKeyAtTime,
  addFullFaceKeyAtTime,
  copyFullFaceKeyToTime,
  moveChannelKey,
  moveFullFaceKey,
} from "./expressionKeyframeOps.js"
import { sampleExpressionTimeline } from "./expressionTimelineSampler.js"
import { createInitialEliteRig } from "./faceDofMapper.js"
import {
  EXPRESSION_CHANNEL_EDITING_ENABLED,
  isExpressionChannelKeyMutationEnabled,
  isExpressionKeyTimeEditable,
  projectHasAdvancedChannelKeys,
  resolveFullFaceSelectionIndex,
} from "./expressionCapabilities.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

test("A — Formal Add Key：正式 add 生成 Full-Face Event（keyedChannels = ALL）", () => {
  const base = createDefaultFrameProject([])
  const rig = createInitialEliteRig()
  rig.jaw.val = 33
  const next = addFullFaceKeyAtTime(base, 500, rig, { jaw: 33 }, [])
  const ev = next.keyframes.find((k) => k.timeMs === 500)
  assert.ok(ev)
  assert.ok(isFullFaceKeyed(ev.keyedChannels))
  assert.equal(ev.keyedChannels.length, getAllTimelineChannelIds().length)
  assert.ok(ev.rigSnapshot)
  assert.equal(Math.round(ev.rigSnapshot.jaw.val), 33)
})

test("B — Full Face Drag：拖整脸改变整个 event timeMs，snapshot/keyed 不变", () => {
  let project = createDefaultFrameProject([])
  const rig = createInitialEliteRig()
  project = addFullFaceKeyAtTime(project, 500, rig, {}, [])
  const before = project.keyframes.find((k) => k.timeMs === 500)
  const snap = structuredClone(before.rigSnapshot)
  const keyed = [...before.keyedChannels]
  project = moveFullFaceKey(project, 500, 650, [])
  const after = project.keyframes.find((k) => k.timeMs === 650)
  assert.ok(after)
  assert.equal(after.timeMs, 650)
  assert.deepEqual(after.keyedChannels, keyed)
  assert.ok(isFullFaceKeyed(after.keyedChannels))
  assert.equal(after.rigSnapshot.jaw.val, snap.jaw.val)
  assert.ok(!project.keyframes.some((k) => k.timeMs === 500 && isFullFaceKeyed(k.keyedChannels)))
})

test("B2 — Alt 复制：copyFullFaceKeyToTime 保留源时间并在目标新增 ALL", () => {
  let project = createDefaultFrameProject([])
  const rig = createInitialEliteRig()
  rig.jaw.val = 42
  project = addFullFaceKeyAtTime(project, 500, rig, {}, [])
  project = copyFullFaceKeyToTime(project, 500, 900, [])
  const src = project.keyframes.find((k) => k.timeMs === 500)
  const dup = project.keyframes.find((k) => k.timeMs === 900)
  assert.ok(src)
  assert.ok(dup)
  assert.ok(isFullFaceKeyed(src.keyedChannels))
  assert.ok(isFullFaceKeyed(dup.keyedChannels))
  assert.equal(Math.round(dup.rigSnapshot.jaw.val), 42)
  assert.notEqual(src.keyframeId, dup.keyframeId)
})

test("C — Child Drag Guard：Channel row 正式模式不可改时间", () => {
  assert.equal(EXPRESSION_CHANNEL_EDITING_ENABLED, false)
  assert.equal(isExpressionChannelKeyMutationEnabled(), false)
  assert.equal(
    isExpressionKeyTimeEditable({
      rowKind: "channel",
      channelId: "jaw.value",
      keyedChannels: getAllTimelineChannelIds(),
    }),
    false
  )
})

test("D — Group Drag Guard：Group summary 不可改 event time", () => {
  assert.equal(
    isExpressionKeyTimeEditable({
      rowKind: "group",
      channelId: null,
      keyedChannels: getAllTimelineChannelIds(),
    }),
    false
  )
  assert.equal(
    isExpressionKeyTimeEditable({
      rowKind: "face",
      channelId: null,
      keyedChannels: getAllTimelineChannelIds(),
    }),
    true
  )
})

test("E — Child Click：定位所属 Full-Face Event 索引", () => {
  let project = createDefaultFrameProject([])
  const rig = createInitialEliteRig()
  project = addFullFaceKeyAtTime(project, 0, rig, {}, [])
  project = addFullFaceKeyAtTime(project, 800, createInitialEliteRig(), {}, [])
  const idx = resolveFullFaceSelectionIndex(project.keyframes, 800)
  assert.equal(idx, project.keyframes.findIndex((k) => k.timeMs === 800))
  assert.ok(isFullFaceKeyed(project.keyframes[idx].keyedChannels))
})

test("F — Partial Project Compatibility：partial 仍可播放/显示，normalize 不破坏", () => {
  let project = createDefaultFrameProject([])
  const rig = createInitialEliteRig()
  project = addChannelKeyAtTime(project, 400, "jaw.value", rig, {}, [])
  assert.ok(projectHasAdvancedChannelKeys(project))
  const partial = project.keyframes.find((k) => k.timeMs === 400)
  assert.ok(partial)
  assert.ok(!isFullFaceKeyed(partial.keyedChannels))
  assert.deepEqual(partial.keyedChannels, ["jaw.value"])

  const normalized = normalizeFrameProject(project, [])
  const again = normalized.keyframes.find((k) => k.timeMs === 400)
  assert.ok(again)
  assert.deepEqual(again.keyedChannels, ["jaw.value"])
  assert.ok(projectHasAdvancedChannelKeys(normalized))

  const sample = sampleExpressionTimeline(normalized, 400)
  assert.ok(sample.rigSnapshot)

  // 正式模式不会把 channel 拖成可编辑
  assert.equal(
    isExpressionKeyTimeEditable({
      rowKind: "channel",
      channelId: "jaw.value",
      keyedChannels: again.keyedChannels,
    }),
    false
  )
})

test("G — Per-channel sampler regression：独立属性 Core 仍可用", () => {
  let project = createDefaultFrameProject([])
  const a = createInitialEliteRig()
  a.jaw.val = 0
  const b = createInitialEliteRig()
  b.jaw.val = 100
  project = addChannelKeyAtTime(project, 0, "jaw.value", a, {}, [])
  project = addChannelKeyAtTime(project, 1000, "jaw.value", b, {}, [])
  // 仍可 moveChannelKey（Core），仅 UI 禁用
  project = moveChannelKey(project, 1000, 800, "jaw.value", [])
  const mid = sampleExpressionTimeline(project, 400)
  assert.ok(Math.abs(mid.rigSnapshot.jaw.val - 50) < 1)
})

test("H — Face Rig Layout regression：Dope Sheet / FaceRigControls 仍挂载，Timeline 外高未改本阶段目标", () => {
  const editor = readFileSync(join(__dirname, "../sdk/react/FaceExpressionEditor.jsx"), "utf8")
  assert.match(editor, /FaceRigControls/)
  assert.match(editor, /ExpressionDopeSheetTimeline/)
  assert.match(editor, /face-expression-bottom/)
  const css = readFileSync(join(__dirname, "../styles/face-rig.css"), "utf8")
  assert.match(css, /\.face-expression-bottom[\s\S]*?height:\s*var\(--face-expression-timeline-h,\s*200px\)/)
  assert.match(css, /\.expr-dope[\s\S]*?height:\s*var\(--face-expression-timeline-h,\s*200px\)/)
  assert.match(css, /--face-expression-timeline-h:\s*200px/)
})

test("I — SC/ST/RJ regression：本阶段未引入协议依赖；Dope Sheet 已门控 Channel 编辑", () => {
  const player = readFileSync(join(__dirname, "./actionPlayer.js"), "utf8")
  assert.doesNotMatch(player, /from ["'].*scServo|from ["'].*stServo|rjHostMotionAdapter/)
  const dope = readFileSync(join(__dirname, "../sdk/react/ExpressionDopeSheetTimeline.jsx"), "utf8")
  assert.match(dope, /isExpressionChannelKeyMutationEnabled|isExpressionKeyTimeEditable/)
  assert.match(dope, /addFullFaceKeyAtTime/)
  assert.match(dope, /EXPRESSION_CHANNEL_EDITING|isExpressionChannelKeyMutationEnabled\(\)/)
  const caps = readFileSync(join(__dirname, "./expressionCapabilities.js"), "utf8")
  assert.match(caps, /EXPRESSION_CHANNEL_EDITING_ENABLED = false/)
})

test("capability — hollow / partial Face 行不可拖时间", () => {
  assert.equal(
    isExpressionKeyTimeEditable({
      rowKind: "face",
      keyedChannels: ["jaw.value"],
    }),
    false
  )
})
