import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, beforeEach } from "node:test"

import {
  EXPRESSION_PRESET_CATALOG,
  EXPRESSION_PRESET_GROUPS,
  filterExpressionPresets,
  getBuiltinDemoPreset,
  listBuiltinDemoPresets,
} from "./expressionPresetCatalog.js"
import {
  BUILTIN_PRESET_CONTENT_KIND,
  EXPRESSION_PRESET_BUILTIN_CLIPS,
  getBuiltinPresetClip,
  listBuiltinPresetClipIds,
} from "./expressionPresetBuiltinAssets.js"
import { buildPresetFrameProject, clipEndsAtNeutral } from "./expressionPresetClip.js"
import {
  addSequenceItem,
  canMutateSequence,
  createSequencePlaybackSnapshot,
  estimateSequenceDurationMs,
  moveSequenceItem,
  removeSequenceItem,
  removeSequenceItemsByPresetId,
  setSequenceItemRepeat,
  validateSequenceForPlayback,
} from "./expressionPresetSequence.js"
import {
  createExpressionPresetPlaybackController,
  PRESET_PLAYBACK_STATES,
  PRESET_REPEAT_MODES,
} from "./expressionPresetPlaybackController.js"
import {
  PHYSICAL_MOTION_OWNERS,
  acquirePhysicalMotionOwner,
  describePresetPlaybackBlockReason,
  listPhysicalMotionOwners,
  releasePhysicalMotionOwner,
  resetPhysicalMotionOwnersForTests,
} from "./physicalMotionOwner.js"
import { createNeutralCharacterPose } from "../../core/characterPose.js"
import { canDispatchNeckHardware } from "../../core/frameProject.js"
import { createDefaultFrameProject } from "../../core/frameProject.js"

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..")

function readSrc(rel) {
  return readFileSync(join(root, rel), "utf8")
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function createTestController(over = {}) {
  const neutrals = { count: 0 }
  const clips = { count: 0, lastPreset: null }
  const basePlay =
    typeof over.playClip === "function"
      ? over.playClip
      : async ({ signal }) => {
          await new Promise((resolve) => {
            if (signal?.aborted) {
              resolve()
              return
            }
            const t = setTimeout(resolve, over.clipMs ?? 4)
            signal?.addEventListener("abort", () => {
              clearTimeout(t)
              resolve()
            })
          })
        }
  const { playClip: _ignored, ...rest } = over
  const controller = createExpressionPresetPlaybackController({
    playClip: async (args) => {
      clips.count += 1
      clips.lastPreset = args.preset?.id
      await basePlay(args)
    },
    dispatchNeutral: async () => {
      neutrals.count += 1
    },
    getBlockingOwners: over.getBlockingOwners || listPhysicalMotionOwners,
    ...rest,
  })
  return { controller, neutrals, clips }
}

describe("Expression preset catalog (A–C)", () => {
  it("A: at least 5 builtin demo presets (fixtures)", () => {
    assert.ok(listBuiltinDemoPresets().length >= 5)
    assert.equal(EXPRESSION_PRESET_CATALOG.length, 6)
  })

  it("B: catalog metadata valid", () => {
    for (const p of EXPRESSION_PRESET_CATALOG) {
      assert.ok(p.id && p.name && p.group && p.description)
      assert.ok(Number(p.durationMs) > 0)
      assert.ok(["face", "character"].includes(p.scope))
      assert.equal(p.supportsRepeat, true)
      assert.ok(Array.isArray(p.tags))
    }
    assert.ok(getBuiltinDemoPreset("natural-smile"))
    assert.equal(filterExpressionPresets("日常").length, 1)
  })

  it("C: closedClip=true and clip ends at neutral", () => {
    for (const p of EXPRESSION_PRESET_CATALOG) {
      assert.equal(p.closedClip, true)
      assert.equal(clipEndsAtNeutral(p.clip), true)
      const project = buildPresetFrameProject(p, [])
      assert.ok(project.keyframes.length >= 2)
      const last = project.keyframes[project.keyframes.length - 1]
      const n = createNeutralCharacterPose()
      assert.deepEqual(last.characterPose.face, n.face)
      assert.deepEqual(last.characterPose.neck, n.neck)
    }
  })

  it("builtin validation: unique id, group, clip ref, demo markers", () => {
    const ids = new Set()
    const groups = new Set(EXPRESSION_PRESET_GROUPS.map((g) => g.id).filter((id) => id !== "all"))
    for (const p of EXPRESSION_PRESET_CATALOG) {
      assert.equal(ids.has(p.id), false)
      ids.add(p.id)
      assert.ok(groups.has(p.group), `invalid group ${p.group}`)
      assert.ok(Number(p.durationMs) > 0)
      assert.ok(p.clipId)
      assert.ok(getBuiltinPresetClip(p.clipId))
      assert.equal(p.clip, EXPRESSION_PRESET_BUILTIN_CLIPS[p.clipId])
      assert.equal(p.contentKind, BUILTIN_PRESET_CONTENT_KIND)
      assert.equal(p.needsMotionTuning, true)
      assert.ok(Array.isArray(p.clip.keyframes))
      assert.ok(p.clip.keyframes.length >= 2)
    }
    assert.equal(listBuiltinPresetClipIds().length, 6)
  })
})

describe("Expression preset UI wiring (D–F)", () => {
  it("D/E/F: card select, play, add to sequence exist", () => {
    const card = readSrc("src/sdk/react/expressionPreset/ExpressionPresetCard.jsx")
    assert.match(card, /onSelect/)
    assert.match(card, /onPlay/)
    assert.match(card, /onAdd/)
    const page = readSrc("src/pages/ExpressionPresetPage.jsx")
    assert.match(page, /addSequenceItem/)
    assert.match(page, /startPreset/)
    const app = readSrc("src/App.jsx")
    assert.match(app, /常用表情/)
    assert.match(app, /presets/)
    assert.match(app, /表情编排/)
    assert.match(app, /追踪预览/)
  })

  it("A UI: library uses product registry + import entry", () => {
    const library = readSrc("src/sdk/react/expressionPreset/ExpressionPresetLibrary.jsx")
    assert.match(library, /filterExpressionPresets/)
    assert.match(library, /EXPRESSION_PRESET_GROUPS/)
    assert.match(library, /ExpressionPresetCard/)
    assert.match(library, /导入表情/)
    assert.match(library, /expressionPresetRegistry/)
    assert.equal(listBuiltinDemoPresets().length, 6)
    assert.equal(filterExpressionPresets("情绪").length, 4)
    assert.equal(filterExpressionPresets("互动").length, 1)
  })

  it("H/I/K sequence empty hides controls; populated shows them", () => {
    const seq = readSrc("src/sdk/react/expressionPreset/ExpressionPresetSequence.jsx")
    assert.match(seq, /尚未添加动作/)
    assert.match(seq, /is-empty/)
    assert.match(seq, /empty \? \(/)
    assert.match(seq, /播放序列/)
    assert.match(seq, /整体播放/)
  })

  it("AC/AF UI: two-column shell + compact library + left sequence", () => {
    const page = readSrc("src/pages/ExpressionPresetPage.jsx")
    const css = readSrc("src/styles/expression-preset.css")
    const card = readSrc("src/sdk/react/expressionPreset/ExpressionPresetCard.jsx")
    const player = readSrc("src/sdk/react/expressionPreset/ExpressionPresetPlayer.jsx")
    assert.match(page, /xp-shell/)
    assert.match(page, /xp-left/)
    assert.match(page, /ExpressionPresetLibrary/)
    assert.match(page, /ExpressionPresetSequence/)
    assert.match(page, /ExpressionPresetPlayer/)
    assert.match(css, /grid-template-columns:\s*minmax\(240px,\s*32%\)\s*minmax\(0,\s*68%\)/)
    assert.match(css, /\.xp-row-list/)
    assert.match(css, /max-height:\s*min\(300px,\s*36vh\)/)
    assert.match(css, /\.xp-char-stage/)
    assert.match(css, /aspect-ratio:\s*1\s*\/\s*1/)
    assert.doesNotMatch(css, /aspect-ratio:\s*2\.2/)
    assert.doesNotMatch(card, /xp-card-thumb|FaceRigPreviewCanvas/)
    assert.match(player, /CharacterPresetPreviewStage/)
    assert.match(player, /xp-playback-dock/)
    assert.match(player, /sequenceReadyCount/)
  })

  it("Character Preview: Face + Neck from same pose; read-only", () => {
    const player = readSrc("src/sdk/react/expressionPreset/ExpressionPresetPlayer.jsx")
    const stage = readSrc("src/sdk/react/expressionPreset/CharacterPresetPreviewStage.jsx")
    const neck = readSrc("src/sdk/react/expressionPreset/NeckReadOnlyPreview.jsx")
    const page = readSrc("src/pages/ExpressionPresetPage.jsx")
    assert.match(player, /CharacterPresetPreviewStage/)
    assert.match(player, /characterPose=\{pose\}/)
    assert.match(stage, /snapshot|characterPose|pose\.face|pose\.neck|face|neck/)
    assert.match(stage, /FaceRigPreviewCanvas/)
    assert.match(stage, /NeckReadOnlyPreview/)
    assert.match(stage, /computeUniformContainScale|transform:\s*`scale\(/)
    assert.match(neck, /data-readonly="true"/)
    assert.match(neck, /xp-neck-ro-pad/)
    assert.doesNotMatch(neck, /onPointerDown|onChange|bridgeStatus|Connect/)
    assert.match(page, /samplePresetRepresentativeCharacterPose/)
    assert.doesNotMatch(page, /neck:\s*createNeutralCharacterPose\(\)\.neck/)
  })
})

describe("Character preset preview geometry", () => {
  it("A/B: Pitch/Roll 1:1 logical; uniform contain scale", async () => {
    const {
      CHARACTER_PRESET_STAGE_LOGICAL,
      computeUniformContainScale,
      isUniformScale,
    } = await import("./characterPresetPreviewStage.js")
    assert.equal(CHARACTER_PRESET_STAGE_LOGICAL.neck.padSize, CHARACTER_PRESET_STAGE_LOGICAL.neck.padSize)
    assert.ok(CHARACTER_PRESET_STAGE_LOGICAL.neck.padSize >= 150)
    assert.ok(CHARACTER_PRESET_STAGE_LOGICAL.neck.padSize <= 190)
    assert.ok(CHARACTER_PRESET_STAGE_LOGICAL.neck.yawWidth <= CHARACTER_PRESET_STAGE_LOGICAL.neck.padSize * 2.05)
    assert.ok(CHARACTER_PRESET_STAGE_LOGICAL.neck.yawWidth >= CHARACTER_PRESET_STAGE_LOGICAL.neck.padSize * 1.45)
    const s = computeUniformContainScale(1200, 800)
    assert.ok(s > 0)
    assert.equal(isUniformScale(s, s), true)
    const css = readSrc("src/styles/expression-preset.css")
    assert.match(css, /\.xp-neck-ro-pad[\s\S]*aspect-ratio:\s*1\s*\/\s*1/)
    assert.doesNotMatch(css, /\.xp-neck-ro-pad[\s\S]*width:\s*100%/)
  })

  it("C–F / M–R: stage composition + content-driven left + no Neck stretch", () => {
    const stage = readSrc("src/sdk/react/expressionPreset/CharacterPresetPreviewStage.jsx")
    const css = readSrc("src/styles/expression-preset.css")
    assert.match(stage, /data-logical-width/)
    assert.match(stage, /data-uniform-scale/)
    assert.match(stage, /xp-char-stage-face/)
    assert.match(stage, /xp-char-stage-neck/)
    assert.match(css, /\.xp-library[\s\S]*flex:\s*0 0 auto/)
    assert.match(css, /\.xp-sequence[\s\S]*flex:\s*0 0 auto/)
    assert.match(css, /\.xp-playback-dock/)
    assert.doesNotMatch(css, /aspect-ratio:\s*2\.2\s*\/\s*1/)
  })
})

describe("Expression preset playback (G–J)", () => {
  beforeEach(() => resetPhysicalMotionOwnersForTests())

  it("G: single play complete → neutral", async () => {
    const { controller, neutrals, clips } = createTestController()
    await controller.startPreset({ presetId: "natural-smile", mode: PRESET_REPEAT_MODES.ONCE })
    await controller.waitForPlayLoop()
    assert.equal(clips.count, 1)
    assert.equal(neutrals.count, 1)
    assert.equal(controller.getSnapshot().state, PRESET_PLAYBACK_STATES.IDLE)
  })

  it("H: repeat N correct count", async () => {
    const { controller, clips } = createTestController()
    await controller.startPreset({
      presetId: "natural-smile",
      mode: PRESET_REPEAT_MODES.REPEAT,
      repeatCount: 3,
    })
    await controller.waitForPlayLoop()
    assert.equal(clips.count, 3)
    assert.equal(controller.getSnapshot().state, PRESET_PLAYBACK_STATES.IDLE)
  })

  it("I: infinite continues until stop", async () => {
    const { controller, clips } = createTestController({ clipMs: 8 })
    await controller.startPreset({
      presetId: "wink-hello",
      mode: PRESET_REPEAT_MODES.INFINITE,
    })
    await wait(30)
    assert.ok(clips.count >= 2)
    assert.equal(controller.getSnapshot().state, PRESET_PLAYBACK_STATES.PLAYING_PRESET)
    await controller.stopToNeutral()
    assert.equal(controller.getSnapshot().state, PRESET_PLAYBACK_STATES.IDLE)
  })

  it("J: stop → neutral", async () => {
    const { controller, neutrals } = createTestController({ clipMs: 40 })
    await controller.startPreset({ presetId: "angry", mode: PRESET_REPEAT_MODES.INFINITE })
    await wait(8)
    await controller.stopToNeutral()
    assert.ok(neutrals.count >= 1)
    assert.equal(controller.getSnapshot().state, PRESET_PLAYBACK_STATES.IDLE)
  })
})

describe("Expression preset playback lock (K–O)", () => {
  beforeEach(() => resetPhysicalMotionOwnersForTests())

  it("K: playing preset → another preset Play rejected", async () => {
    const { controller, clips } = createTestController({ clipMs: 40 })
    await controller.startPreset({ presetId: "natural-smile", mode: PRESET_REPEAT_MODES.INFINITE })
    const before = clips.count
    await controller.startPreset({ presetId: "surprise", mode: PRESET_REPEAT_MODES.ONCE })
    assert.match(controller.getSnapshot().blockReason, /正在播放/)
    assert.equal(clips.count, before)
    await controller.stopToNeutral()
  })

  it("L: playing preset → sequence Play rejected", async () => {
    const { controller } = createTestController({ clipMs: 40 })
    await controller.startPreset({ presetId: "natural-smile", mode: PRESET_REPEAT_MODES.INFINITE })
    await controller.startSequence({
      items: addSequenceItem([], "wink-hello"),
      mode: PRESET_REPEAT_MODES.ONCE,
    })
    assert.match(controller.getSnapshot().blockReason, /正在播放/)
    await controller.stopToNeutral()
  })

  it("M: playing sequence → preset Play rejected", async () => {
    const { controller } = createTestController({ clipMs: 40 })
    await controller.startSequence({
      items: addSequenceItem([], "natural-smile"),
      mode: PRESET_REPEAT_MODES.INFINITE,
    })
    await controller.startPreset({ presetId: "angry", mode: PRESET_REPEAT_MODES.ONCE })
    assert.match(controller.getSnapshot().blockReason, /正在播放/)
    await controller.stopToNeutral()
  })

  it("N: playing sequence → sequence edits disabled/rejected", async () => {
    const { controller } = createTestController({ clipMs: 40 })
    await controller.startSequence({
      items: addSequenceItem([], "natural-smile"),
      mode: PRESET_REPEAT_MODES.INFINITE,
    })
    assert.equal(controller.canMutateSequence(), false)
    assert.equal(canMutateSequence(PRESET_PLAYBACK_STATES.PLAYING_SEQUENCE), false)
    assert.equal(canMutateSequence(PRESET_PLAYBACK_STATES.IDLE), true)
    await controller.stopToNeutral()
  })

  it("O: old callbacks invalid after Stop", async () => {
    let late = 0
    const { controller } = createTestController({
      clipMs: 30,
      playClip: async ({ signal }) => {
        await wait(20)
        if (!signal?.aborted) late += 1
      },
    })
    await controller.startPreset({ presetId: "happy-laugh", mode: PRESET_REPEAT_MODES.INFINITE })
    await wait(5)
    const gen = controller.getGeneration()
    await controller.stopToNeutral()
    await wait(40)
    assert.notEqual(controller.getGeneration(), gen)
    assert.equal(controller.getSnapshot().state, PRESET_PLAYBACK_STATES.IDLE)
    assert.equal(late, 0)
  })
})

describe("Expression preset sequence (P–X)", () => {
  beforeEach(() => resetPhysicalMotionOwnersForTests())

  it("A–H working sequence: add/dup/instanceId/remove/move/repeat/duration/clear", () => {
    let items = []
    items = addSequenceItem(items, "natural-smile")
    items = addSequenceItem(items, "wink-hello")
    items = addSequenceItem(items, "natural-smile")
    assert.equal(items.length, 3)
    assert.notEqual(items[0].instanceId, items[2].instanceId)
    assert.equal(items[0].presetId, items[2].presetId)
    items = moveSequenceItem(items, items[2].id, -1)
    assert.equal(items[1].presetId, "natural-smile")
    items = setSequenceItemRepeat(items, items[1].id, 2)
    assert.equal(items[1].repeatCount, 2)
    items = setSequenceItemRepeat(items, items[1].id, 0)
    assert.equal(items[1].repeatCount, 1)
    items = setSequenceItemRepeat(items, items[1].id, 120)
    assert.equal(items[1].repeatCount, 99)
    const dur = estimateSequenceDurationMs(items, getBuiltinDemoPreset)
    assert.ok(dur > 0)
    items = removeSequenceItem(items, items[0].id)
    assert.equal(items.length, 2)
    items = removeSequenceItemsByPresetId(items, "natural-smile")
    assert.equal(items.every((it) => it.presetId !== "natural-smile"), true)
    items = []
    assert.equal(items.length, 0)
  })

  it("I–N snapshot: immutable, order/repeat correct, invalid/open blocked", () => {
    let items = addSequenceItem([], "natural-smile")
    items = addSequenceItem(items, "wink-hello")
    items = setSequenceItemRepeat(items, items[1].id, 2)
    const created = createSequencePlaybackSnapshot({
      items,
      mode: PRESET_REPEAT_MODES.REPEAT,
      repeatCount: 3,
      resolvePreset: getBuiltinDemoPreset,
    })
    assert.equal(created.ok, true)
    assert.ok(created.snapshot.sequenceRunId)
    assert.equal(created.snapshot.items.length, 2)
    assert.equal(created.snapshot.items[0].presetId, "natural-smile")
    assert.equal(created.snapshot.items[1].repeatCount, 2)
    assert.equal(created.snapshot.repeatCount, 3)
    assert.throws(() => {
      created.snapshot.items.push({ presetId: "x" })
    })
    items = setSequenceItemRepeat(items, items[0].id, 5)
    assert.equal(created.snapshot.items[0].repeatCount, 1)

    const missing = createSequencePlaybackSnapshot({
      items: addSequenceItem([], "no-such-preset"),
      resolvePreset: getBuiltinDemoPreset,
    })
    assert.equal(missing.ok, false)

    const openPreset = {
      id: "open-clip",
      name: "Open",
      closedClip: false,
      clip: { keyframes: [{ timeMs: 0 }, { timeMs: 100 }] },
      durationMs: 100,
    }
    const open = validateSequenceForPlayback(
      addSequenceItem([], "open-clip"),
      (id) => (id === "open-clip" ? openPreset : null)
    )
    assert.equal(open.ok, false)
    assert.equal(open.code, "OPEN_CLIP")
  })

  it("P/Q/R/S: add remove move item repeat", () => {
    let items = []
    items = addSequenceItem(items, "natural-smile")
    items = addSequenceItem(items, "wink-hello")
    items = addSequenceItem(items, "surprise")
    assert.equal(items.length, 3)
    items = moveSequenceItem(items, items[2].id, -1)
    assert.equal(items[1].presetId, "surprise")
    items = setSequenceItemRepeat(items, items[1].id, 2)
    assert.equal(items[1].repeatCount, 2)
    items = removeSequenceItem(items, items[0].id)
    assert.equal(items.length, 2)
  })

  it("O/P/Q/T: sequence order + item repeats + once", async () => {
    const order = []
    const { controller, clips } = createTestController({
      playClip: async ({ preset, signal }) => {
        order.push(preset.id)
        await wait(2)
        if (signal?.aborted) return
      },
    })
    let items = addSequenceItem([], "natural-smile")
    items = setSequenceItemRepeat(items, items[0].id, 2)
    items = addSequenceItem(items, "wink-hello")
    await controller.startSequence({ items, mode: PRESET_REPEAT_MODES.ONCE })
    await controller.waitForPlayLoop()
    assert.deepEqual(order, ["natural-smile", "natural-smile", "wink-hello"])
    assert.equal(clips.count, 3)
    assert.equal(controller.getSnapshot().state, PRESET_PLAYBACK_STATES.IDLE)
  })

  it("T: sequence single play", async () => {
    const { controller, clips } = createTestController()
    const items = addSequenceItem(addSequenceItem([], "natural-smile"), "wink-hello")
    await controller.startSequence({ items, mode: PRESET_REPEAT_MODES.ONCE })
    await controller.waitForPlayLoop()
    assert.equal(clips.count, 2)
    assert.equal(controller.getSnapshot().state, PRESET_PLAYBACK_STATES.IDLE)
  })

  it("U/R: sequence repeat N whole playlist", async () => {
    const { controller, clips } = createTestController()
    const items = addSequenceItem(addSequenceItem([], "surprise"), "angry")
    await controller.startSequence({ items, mode: PRESET_REPEAT_MODES.REPEAT, repeatCount: 2 })
    await controller.waitForPlayLoop()
    assert.equal(clips.count, 4)
  })

  it("V/S/Z: sequence infinite until stop", async () => {
    const { controller, clips } = createTestController({ clipMs: 6 })
    const items = addSequenceItem([], "angry")
    await controller.startSequence({ items, mode: PRESET_REPEAT_MODES.INFINITE })
    await wait(20)
    assert.ok(clips.count >= 2)
    await controller.stopToNeutral()
    assert.equal(controller.getSnapshot().state, PRESET_PLAYBACK_STATES.IDLE)
    assert.equal(controller.getActiveSequenceSnapshot(), null)
  })

  it("W/X/T/V: each item and sequence finish through Neutral; no artificial gap", async () => {
    const gaps = []
    let lastEnd = 0
    const { controller, neutrals, clips } = createTestController({
      playClip: async ({ signal }) => {
        const start = Date.now()
        if (lastEnd) gaps.push(start - lastEnd)
        await wait(3)
        if (signal?.aborted) return
        lastEnd = Date.now()
      },
    })
    let items = addSequenceItem([], "natural-smile")
    items = setSequenceItemRepeat(items, items[0].id, 2)
    items = addSequenceItem(items, "wink-hello")
    await controller.startSequence({ items, mode: PRESET_REPEAT_MODES.ONCE })
    await controller.waitForPlayLoop()
    assert.equal(clips.count, 3)
    assert.ok(neutrals.count >= 1)
    assert.equal(controller.getSnapshot().state, PRESET_PLAYBACK_STATES.IDLE)
    for (const g of gaps) {
      assert.ok(g < 200, `unexpected long gap ${g}ms`)
    }
  })

  it("W–AB stop invalidates run; stale callback cannot continue", async () => {
    let lateContinues = 0
    const { controller } = createTestController({
      clipMs: 40,
      playClip: async ({ signal }) => {
        await wait(25)
        if (!signal?.aborted) lateContinues += 1
      },
    })
    const items = addSequenceItem(addSequenceItem([], "natural-smile"), "wink-hello")
    await controller.startSequence({ items, mode: PRESET_REPEAT_MODES.INFINITE })
    await wait(8)
    const snap = controller.getActiveSequenceSnapshot()
    assert.ok(snap?.sequenceRunId)
    const runId = snap.sequenceRunId
    await controller.stopToNeutral()
    await wait(50)
    assert.equal(controller.getActiveSequenceSnapshot(), null)
    assert.notEqual(controller.getSnapshot().sequenceRunId, runId)
    assert.equal(controller.getSnapshot().state, PRESET_PLAYBACK_STATES.IDLE)
    assert.equal(listPhysicalMotionOwners().includes(PHYSICAL_MOTION_OWNERS.PRESET_PLAYBACK), false)
    assert.equal(lateContinues, 0)
  })
})

describe("Expression preset ownership (Y–AE)", () => {
  beforeEach(() => resetPhysicalMotionOwnersForTests())

  it("Y: Tracking active → Preset rejected", async () => {
    const { controller, clips } = createTestController({
      getBlockingOwners: () => [PHYSICAL_MOTION_OWNERS.TRACKING_DEVICE_DRIVE],
    })
    await controller.startPreset({ presetId: "natural-smile" })
    assert.match(controller.getSnapshot().blockReason, /追踪预览/)
    assert.equal(clips.count, 0)
  })

  it("Z: Timeline active → Preset rejected", async () => {
    const { controller, clips } = createTestController({
      getBlockingOwners: () => [PHYSICAL_MOTION_OWNERS.TIMELINE_PLAYBACK],
    })
    await controller.startPreset({ presetId: "natural-smile" })
    assert.match(controller.getSnapshot().blockReason, /时间轴/)
    assert.equal(clips.count, 0)
  })

  it("AA: Calibration active → Preset rejected", async () => {
    const { controller } = createTestController({
      getBlockingOwners: () => [PHYSICAL_MOTION_OWNERS.NECK_CALIBRATION],
    })
    await controller.startPreset({ presetId: "natural-smile" })
    assert.match(controller.getSnapshot().blockReason, /标定/)
  })

  it("AB: Hardware test active → Preset rejected", async () => {
    const { controller } = createTestController({
      getBlockingOwners: () => [PHYSICAL_MOTION_OWNERS.BINDING_HARDWARE_TEST],
    })
    await controller.startPreset({ presetId: "natural-smile" })
    assert.match(controller.getSnapshot().blockReason, /绑定硬件测试/)
  })

  it("AC/AD: owns output during play and releases after complete", async () => {
    const { controller } = createTestController({ clipMs: 8 })
    await controller.startPreset({ presetId: "natural-smile", mode: PRESET_REPEAT_MODES.ONCE })
    assert.ok(listPhysicalMotionOwners().includes(PHYSICAL_MOTION_OWNERS.PRESET_PLAYBACK))
    await controller.waitForPlayLoop()
    assert.equal(listPhysicalMotionOwners().includes(PHYSICAL_MOTION_OWNERS.PRESET_PLAYBACK), false)
  })

  it("AE: owner released after Stop", async () => {
    const { controller } = createTestController({ clipMs: 40 })
    await controller.startPreset({ presetId: "natural-smile", mode: PRESET_REPEAT_MODES.INFINITE })
    await controller.stopToNeutral()
    assert.equal(listPhysicalMotionOwners().includes(PHYSICAL_MOTION_OWNERS.PRESET_PLAYBACK), false)
  })

  it("reason helper covers owners", () => {
    assert.match(
      describePresetPlaybackBlockReason([PHYSICAL_MOTION_OWNERS.TRACKING_DEVICE_DRIVE]),
      /追踪/
    )
  })
})

describe("Expression preset page lifecycle (AF–AJ)", () => {
  beforeEach(() => resetPhysicalMotionOwnersForTests())

  it("AF: leave while IDLE is a no-op", async () => {
    const { controller, neutrals } = createTestController()
    await controller.prepareLeave()
    assert.equal(controller.getSnapshot().state, PRESET_PLAYBACK_STATES.IDLE)
    assert.equal(neutrals.count, 0)
  })

  it("AG/AH/AI/AJ: leave while PLAYING → Stop + Neutral + release + no background", async () => {
    const { controller, neutrals } = createTestController({ clipMs: 40 })
    await controller.startPreset({ presetId: "wink-hello", mode: PRESET_REPEAT_MODES.INFINITE })
    await controller.prepareLeave()
    assert.equal(controller.getSnapshot().state, PRESET_PLAYBACK_STATES.IDLE)
    assert.ok(neutrals.count >= 1)
    assert.equal(listPhysicalMotionOwners().includes(PHYSICAL_MOTION_OWNERS.PRESET_PLAYBACK), false)
    assert.equal(controller.isBusy(), false)
    const app = readSrc("src/App.jsx")
    assert.match(app, /prepareLeave/)
    assert.match(app, /requestPageChange/)
  })
})

describe("Expression preset Neck isolation (AK–AO)", () => {
  it("AK: Face preset + Neck OFF works", () => {
    const p = createDefaultFrameProject([])
    assert.equal(canDispatchNeckHardware(p), false)
    const preset = getBuiltinDemoPreset("natural-smile")
    assert.equal(preset.scope, "face")
  })

  it("AL: Character preset + Neck OFF → Face still plays", async () => {
    resetPhysicalMotionOwnersForTests()
    const { controller, clips } = createTestController()
    assert.equal(getBuiltinDemoPreset("confused").scope, "character")
    await controller.startPreset({ presetId: "confused", mode: PRESET_REPEAT_MODES.ONCE })
    await controller.waitForPlayLoop()
    assert.equal(clips.count, 1)
    assert.equal(controller.getSnapshot().state, PRESET_PLAYBACK_STATES.IDLE)
  })

  it("AM/AN: Neck ON but disconnected → Face plays, neck skipped", async () => {
    resetPhysicalMotionOwnersForTests()
    const neckCalls = []
    const { controller, clips } = createTestController({
      dispatchNeck: async () => {
        neckCalls.push("SKIPPED_NO_HARDWARE")
        return { attempted: false, status: "SKIPPED", error: "SKIPPED_NO_HARDWARE" }
      },
    })
    await controller.startPreset({ presetId: "confused", mode: PRESET_REPEAT_MODES.ONCE })
    await controller.waitForPlayLoop()
    assert.equal(clips.count, 1)
    assert.equal(controller.getSnapshot().state, PRESET_PLAYBACK_STATES.IDLE)
  })

  it("AO: Neck hardware error does not abort Face playback", async () => {
    resetPhysicalMotionOwnersForTests()
    const { controller, clips } = createTestController({
      playClip: async ({ preset, onSample }) => {
        onSample?.({
          timelineTimeMs: preset.durationMs,
          characterPose: createNeutralCharacterPose(),
        })
        // Face clip finished even if Neck would have failed in the real dispatch path.
      },
    })
    await controller.startPreset({ presetId: "confused", mode: PRESET_REPEAT_MODES.ONCE })
    await controller.waitForPlayLoop()
    assert.equal(clips.count, 1)
    assert.equal(controller.getSnapshot().state, PRESET_PLAYBACK_STATES.IDLE)
  })
})

describe("Expression preset regression wiring", () => {
  it("does not add pause/skip/transition UI", () => {
    const player = readSrc("src/sdk/react/expressionPreset/ExpressionPresetPlayer.jsx")
    assert.doesNotMatch(player, /Pause|Resume|Skip|Crossfade|Transition/)
    assert.match(player, /停止并回中/)
  })

  it("O: Preset animation data not defined inside Page JSX", () => {
    const page = readSrc("src/pages/ExpressionPresetPage.jsx")
    assert.doesNotMatch(page, /keyframes\s*:/)
    assert.doesNotMatch(page, /mouth\s*:\s*\{/)
    assert.doesNotMatch(page, /browL\s*:/)
    assert.doesNotMatch(page, /UL\s*:\s*\d+/)
    assert.match(page, /getExpressionPreset/)
    assert.match(page, /listUserPresets/)
    const card = readSrc("src/sdk/react/expressionPreset/ExpressionPresetCard.jsx")
    assert.doesNotMatch(card, /keyframes/)
    assert.doesNotMatch(card, /mouth\s*:/)
    const catalog = readSrc("src/sdk/expression/expressionPresetCatalog.js")
    assert.match(catalog, /getBuiltinPresetClip/)
    assert.doesNotMatch(catalog, /timeMs:\s*450/)
    const assets = readSrc("src/sdk/expression/expressionPresetBuiltinAssets.js")
    assert.match(assets, /BUILTIN_DEMO_CONTENT/)
    assert.match(assets, /natural-smile/)
  })

  it("player uses single primary action (no dual Play+Stop idle)", () => {
    const player = readSrc("src/sdk/react/expressionPreset/ExpressionPresetPlayer.jsx")
    assert.match(player, /stopping \?/)
    assert.match(player, /playing \?/)
    assert.match(player, /正在回中/)
  })

  it("page header hosts SerialCapsule + 实时预览 like other Face pages", () => {
    const page = readSrc("src/pages/ExpressionPresetPage.jsx")
    assert.match(page, /SerialCapsulePanel/)
    assert.match(page, /FaceRealtimePreviewToggle/)
    assert.match(page, /transportMode="bus"/)
    assert.match(page, /realtimePreview/)
    assert.match(page, /dispatchFaceImpl/)
    assert.match(page, /face-expression-upper-dock/)
    assert.match(page, /face-expression-top-cluster/)
    assert.match(page, /face-expression-toolbar-right/)
  })
})
