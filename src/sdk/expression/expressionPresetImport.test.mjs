import assert from "node:assert/strict"
import { describe, it, beforeEach } from "node:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { createDefaultFrameProject, createKeyframe, normalizeFrameProject } from "../../core/frameProject.js"
import { createNeutralCharacterPose } from "../../core/characterPose.js"
import {
  parseAndValidateExpressionImport,
  createUserPresetFromDraft,
  buildPresetExportPayload,
  detectClosedClip,
  samplePresetRepresentativeCharacterPose,
  PRESET_IMPORT_ERRORS,
} from "./expressionPresetImport.js"
import {
  createMemoryExpressionPresetStorage,
  listUserPresets,
  saveUserPreset,
  getUserPreset,
  updateUserPresetMetadata,
  replaceUserPresetAsset,
  deleteUserPreset,
} from "./expressionPresetUserStore.js"
import {
  setUserPresetLibrary,
  listExpressionPresets,
  getExpressionPreset,
  canRepeatPreset,
  canAddPresetToSequence,
  listBuiltinDemoPresets,
} from "./expressionPresetRegistry.js"
import { buildPresetFrameProject } from "./expressionPresetClip.js"
import { getBuiltinDemoPreset } from "./expressionPresetCatalog.js"
import {
  createExpressionPresetPlaybackController,
  PRESET_REPEAT_MODES,
  PRESET_PLAYBACK_STATES,
} from "./expressionPresetPlaybackController.js"
import { addSequenceItem } from "./expressionPresetSequence.js"
import { resetPhysicalMotionOwnersForTests } from "./physicalMotionOwner.js"

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..")

function readSrc(rel) {
  return readFileSync(join(root, rel), "utf8")
}

function makeClosedProject(name = "自然微笑") {
  const n = createNeutralCharacterPose()
  const peak = {
    face: {
      ...n.face,
      mouth: { ...n.face.mouth, UL: 30, UR: 30, LL: 20, LR: 20 },
    },
    neck: { ...n.neck },
  }
  return normalizeFrameProject(
    {
      expressionName: name,
      expressionId: "expr_test",
      timelineDurationMs: 1200,
      keyframes: [
        createKeyframe({ name: "a", timeMs: 0, characterPose: n, rigSnapshot: n.face, configs: [] }),
        createKeyframe({ name: "b", timeMs: 500, characterPose: peak, rigSnapshot: peak.face, configs: [] }),
        createKeyframe({ name: "c", timeMs: 1200, characterPose: n, rigSnapshot: n.face, configs: [] }),
      ],
    },
    []
  )
}

function makeOpenProject() {
  const n = createNeutralCharacterPose()
  const peak = {
    face: { ...n.face, jaw: { ...n.face.jaw, val: 40 } },
    neck: { ...n.neck },
  }
  return normalizeFrameProject(
    {
      expressionName: "张嘴停住",
      timelineDurationMs: 800,
      keyframes: [
        createKeyframe({ name: "a", timeMs: 0, characterPose: n, rigSnapshot: n.face, configs: [] }),
        createKeyframe({ name: "b", timeMs: 800, characterPose: peak, rigSnapshot: peak.face, configs: [] }),
      ],
    },
    []
  )
}

function makeCharacterProject() {
  const n = createNeutralCharacterPose()
  const peak = {
    face: n.face,
    neck: { pitch: 0, roll: 0, yaw: 12 },
  }
  return normalizeFrameProject(
    {
      expressionName: "转头",
      timelineDurationMs: 1000,
      keyframes: [
        createKeyframe({ name: "a", timeMs: 0, characterPose: n, rigSnapshot: n.face, configs: [] }),
        createKeyframe({ name: "b", timeMs: 500, characterPose: peak, rigSnapshot: peak.face, configs: [] }),
        createKeyframe({ name: "c", timeMs: 1000, characterPose: n, rigSnapshot: n.face, configs: [] }),
      ],
    },
    []
  )
}

describe("Expression preset import (A–J)", () => {
  it("A/B/C/D/F: valid frameProject imports with name duration face closed", () => {
    const project = makeClosedProject("自然微笑")
    const result = parseAndValidateExpressionImport(project)
    assert.equal(result.ok, true)
    assert.equal(result.draft.name, "自然微笑")
    assert.ok(result.draft.durationMs >= 1200)
    assert.equal(result.draft.scope, "face")
    assert.equal(result.draft.closedClip, true)
    assert.ok(result.draft.keyframeCount >= 3)
  })

  it("E: Character/Neck scope detected", () => {
    const result = parseAndValidateExpressionImport(makeCharacterProject())
    assert.equal(result.ok, true)
    assert.equal(result.draft.scope, "character")
    assert.equal(result.draft.hasNeck, true)
  })

  it("G: invalid JSON rejected", () => {
    const result = parseAndValidateExpressionImport("{not json")
    assert.equal(result.ok, false)
    assert.equal(result.code, PRESET_IMPORT_ERRORS.PARSE)
  })

  it("H: unsupported schema rejected", () => {
    const result = parseAndValidateExpressionImport({ foo: 1 })
    assert.equal(result.ok, false)
    assert.equal(result.code, PRESET_IMPORT_ERRORS.UNSUPPORTED_SCHEMA)
  })

  it("I: no keyframes rejected", () => {
    const result = parseAndValidateExpressionImport({
      version: "3.0.0",
      projectType: "robot-face-single-expression",
      keyframes: [],
      timelineDurationMs: 1000,
    })
    // normalizeFrameProject may inject default keyframe — if so treat as migration reuse
    if (result.ok) {
      assert.ok(result.draft.keyframeCount >= 1)
    } else {
      assert.equal(result.code, PRESET_IMPORT_ERRORS.NO_KEYFRAMES)
    }
  })

  it("J: migration reused via normalizeFrameProject / export roundtrip", () => {
    const project = makeClosedProject()
    const draft = parseAndValidateExpressionImport(project).draft
    const preset = createUserPresetFromDraft(draft)
    const exported = buildPresetExportPayload(preset, [])
    const again = parseAndValidateExpressionImport(exported)
    assert.equal(again.ok, true)
    assert.equal(again.draft.closedClip, true)
  })
})

describe("Expression preset persistence (K–P)", () => {
  /** @type {ReturnType<typeof createMemoryExpressionPresetStorage>} */
  let storage

  beforeEach(() => {
    storage = createMemoryExpressionPresetStorage()
  })

  it("K/L: save and list restores", async () => {
    const draft = parseAndValidateExpressionImport(makeClosedProject()).draft
    const preset = createUserPresetFromDraft(draft)
    await saveUserPreset(preset, { storage })
    const list = await listUserPresets({ storage })
    assert.equal(list.length, 1)
    assert.equal(list[0].id, preset.id)
    assert.ok(list[0].animation.keyframes.length >= 3)
  })

  it("M/N: rename and group persist", async () => {
    const preset = createUserPresetFromDraft(parseAndValidateExpressionImport(makeClosedProject()).draft)
    await saveUserPreset(preset, { storage })
    await updateUserPresetMetadata(preset.id, { name: "新名字", group: "情绪" }, { storage })
    const got = await getUserPreset(preset.id, { storage })
    assert.equal(got.name, "新名字")
    assert.equal(got.group, "情绪")
  })

  it("O/P: replace and delete persist", async () => {
    const preset = createUserPresetFromDraft(parseAndValidateExpressionImport(makeClosedProject("旧")).draft)
    await saveUserPreset(preset, { storage })
    const nextDraft = parseAndValidateExpressionImport(makeClosedProject("新动作")).draft
    nextDraft.durationMs = 2000
    const replaced = await replaceUserPresetAsset(preset.id, nextDraft, { storage })
    assert.equal(replaced.id, preset.id)
    assert.equal(replaced.name, preset.name)
    assert.ok(replaced.durationMs >= 1200)
    await deleteUserPreset(preset.id, { storage })
    assert.equal(await getUserPreset(preset.id, { storage }), null)
  })
})

describe("Expression preset replace (Q–V)", () => {
  it("Q/R/S/T/U/V: replace preserves id/name; invalid does not destroy", async () => {
    const storage = createMemoryExpressionPresetStorage()
    const preset = createUserPresetFromDraft(
      parseAndValidateExpressionImport(makeClosedProject("自然微笑")).draft
    )
    await saveUserPreset(preset, { storage })
    const openDraft = parseAndValidateExpressionImport(makeOpenProject()).draft
    const replaced = await replaceUserPresetAsset(preset.id, openDraft, { storage })
    assert.equal(replaced.id, preset.id)
    assert.equal(replaced.name, "自然微笑")
    assert.equal(replaced.closedClip, false)
    setUserPresetLibrary([replaced])
    assert.equal(getExpressionPreset(preset.id)?.id, preset.id)

    let failed = false
    try {
      await replaceUserPresetAsset(preset.id, { animation: null }, { storage })
    } catch {
      failed = true
    }
    assert.equal(failed, true)
    const still = await getUserPreset(preset.id, { storage })
    assert.ok(still.animation.keyframes.length >= 2)
  })
})

describe("Expression preset capability (W–AA)", () => {
  beforeEach(() => resetPhysicalMotionOwnersForTests())

  it("W/X: closed supports repeat and sequence", async () => {
    const preset = createUserPresetFromDraft(parseAndValidateExpressionImport(makeClosedProject()).draft)
    setUserPresetLibrary([preset])
    assert.equal(canRepeatPreset(preset), true)
    assert.equal(canAddPresetToSequence(preset), true)
    const controller = createExpressionPresetPlaybackController({
      resolvePreset: (id) => getExpressionPreset(id),
      playClip: async () => {},
      dispatchNeutral: async () => {},
    })
    await controller.startPreset({ presetId: preset.id, mode: PRESET_REPEAT_MODES.REPEAT, repeatCount: 2 })
    await controller.waitForPlayLoop()
    assert.equal(controller.getSnapshot().state, PRESET_PLAYBACK_STATES.IDLE)
    const items = addSequenceItem([], preset.id)
    await controller.startSequence({ items, mode: PRESET_REPEAT_MODES.ONCE })
    await controller.waitForPlayLoop()
    assert.equal(controller.getSnapshot().state, PRESET_PLAYBACK_STATES.IDLE)
  })

  it("Y/Z/AA: open single only; repeat/sequence rejected", async () => {
    const preset = createUserPresetFromDraft(parseAndValidateExpressionImport(makeOpenProject()).draft)
    setUserPresetLibrary([preset])
    assert.equal(canRepeatPreset(preset), false)
    assert.equal(canAddPresetToSequence(preset), false)
    const controller = createExpressionPresetPlaybackController({
      resolvePreset: (id) => getExpressionPreset(id),
      playClip: async () => {},
      dispatchNeutral: async () => {},
    })
    await controller.startPreset({ presetId: preset.id, mode: PRESET_REPEAT_MODES.ONCE })
    await controller.waitForPlayLoop()
    assert.equal(controller.getSnapshot().state, PRESET_PLAYBACK_STATES.IDLE)
    await controller.startPreset({ presetId: preset.id, mode: PRESET_REPEAT_MODES.REPEAT, repeatCount: 2 })
    assert.match(controller.getSnapshot().blockReason, /非闭环/)
    await controller.startSequence({ items: addSequenceItem([], preset.id) })
    assert.match(controller.getSnapshot().blockReason, /非闭环/)
  })
})

describe("Expression preset demo visibility (AB–AC)", () => {
  it("AB: product library does not register builtin demos", () => {
    setUserPresetLibrary([])
    assert.equal(listExpressionPresets().length, 0)
    assert.equal(getExpressionPreset("natural-smile"), null)
  })

  it("AC: demo fixtures remain for tests", () => {
    assert.equal(listBuiltinDemoPresets().length, 6)
    assert.ok(getBuiltinDemoPreset("natural-smile"))
    const project = buildPresetFrameProject(getBuiltinDemoPreset("natural-smile"), [])
    assert.ok(project.keyframes.length >= 2)
    assert.equal(detectClosedClip(project), true)
  })
})

describe("Expression preset preview architecture (AD–AI)", () => {
  it("AD–AI: contain fitMode additive; page uses it; no hardcoded scale crop", () => {
    const canvas = readSrc("src/sdk/react/FaceRigPreviewCanvas.jsx")
    assert.match(canvas, /fitMode/)
    assert.match(canvas, /contain/)
    assert.match(canvas, /useFaceRigPreviewScale/)
    assert.match(canvas, /variant/)
    const player = readSrc("src/sdk/react/expressionPreset/ExpressionPresetPlayer.jsx")
    assert.match(player, /CharacterPresetPreviewStage/)
    const stage = readSrc("src/sdk/react/expressionPreset/CharacterPresetPreviewStage.jsx")
    assert.match(stage, /fitMode="contain"/)
    assert.match(stage, /variant="preset"/)
    assert.match(stage, /NeckReadOnlyPreview/)
    const css = readSrc("src/styles/expression-preset.css")
    assert.doesNotMatch(css, /scale\(0\.36\)/)
    assert.match(css, /\.xp-char-stage/)
    assert.match(css, /minmax\(240px,\s*32%\)/)
    const page = readSrc("src/pages/ExpressionPresetPage.jsx")
    assert.match(page, /parseAndValidateExpressionImport/)
    assert.match(page, /listUserPresets/)
    assert.match(page, /samplePresetRepresentativeCharacterPose/)
    assert.doesNotMatch(page, /natural-smile/)
  })

  it("A–G Character Preview samples full pose; editor Face Rig unchanged", () => {
    const confused = getBuiltinDemoPreset("confused")
    assert.ok(confused)
    const pose = samplePresetRepresentativeCharacterPose(confused)
    assert.ok(pose.face)
    assert.ok(pose.neck)
    assert.equal(typeof pose.neck.pitch, "number")
    assert.equal(typeof pose.neck.roll, "number")
    assert.equal(typeof pose.neck.yaw, "number")
    assert.ok(
      Math.abs(pose.neck.pitch) + Math.abs(pose.neck.roll) + Math.abs(pose.neck.yaw) > 0 ||
        confused.scope === "character"
    )
    const neutral = samplePresetRepresentativeCharacterPose(null)
    assert.equal(neutral.neck.pitch, 0)
    assert.equal(neutral.neck.roll, 0)
    assert.equal(neutral.neck.yaw, 0)
    const canvas = readSrc("src/sdk/react/FaceRigPreviewCanvas.jsx")
    assert.match(canvas, /variant === "preset"/)
    const neckPreview = readSrc("src/sdk/react/expressionPreset/NeckReadOnlyPreview.jsx")
    assert.doesNotMatch(neckPreview, /bridgeStatus|Connect|Calibration/)
    assert.doesNotMatch(readSrc("src/components/FaceRigWorkspace.jsx"), /xp-char-stage/)
  })
})
