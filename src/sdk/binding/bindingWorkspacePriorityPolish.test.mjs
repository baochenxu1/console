import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { restoreBindingFullRange } from "./bindingActions.js"
import {
  createDefaultFaceRigProfile,
  normalizeBinding,
  normalizeFaceRigProfile,
  bindingWithRestoredEndpointsVsNeutral,
  CHANNEL_VALUE,
} from "../../core/faceRigProfile.js"

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..")

function readSrc(rel) {
  return readFileSync(join(root, "src", rel), "utf8")
}

describe("Face Binding Workspace Priority Polish", () => {
  it("A–F: workspace actions reuse existing handlers; no footer; no duplicate persistence", () => {
    const editor = readSrc("sdk/react/FaceBindingEditor.jsx")
    const page = readSrc("pages/FaceRigPage.jsx")

    assert.match(editor, /rig\.resetEngine/)
    assert.match(editor, /handleSaveLocal|handleSaveProfile/)
    assert.match(editor, /rig\.handleImportClick/)
    assert.match(editor, /rig\.handleExportProfile/)
    assert.match(editor, /migrateToBusSemantics\(\{ skipConfirm: true \}\)/)
    assert.match(editor, /handleClearAllBindings\(\{ skipConfirm: true \}\)/)
    assert.match(editor, /face-rig-confirm-dialog/)
    assert.match(editor, /高级操作/)
    assert.doesNotMatch(editor, />\s*工作台操作/)
    assert.match(editor, /aria-label="工作台操作区"/)

    assert.doesNotMatch(page, /导入并生效/)
    assert.doesNotMatch(page, /恢复默认映射/)
    assert.doesNotMatch(page, /一键清除全部绑定/)
    assert.match(page, /handleImportFile/)
    assert.match(editor, /handleResetProfile/)
    assert.match(editor, /handleClearAllBindings/)
  })

  it("G/H: restore full range on primary travel card, not only More Settings", () => {
    const inspector = readSrc("components/FaceRigBindingInspector.jsx")
    const travelIdx = inspector.indexOf("face-rig-binding-travel-head")
    const restoreIdx = inspector.indexOf("恢复全范围")
    const moreIdx = inspector.indexOf("<summary>更多设置</summary>")
    assert.ok(travelIdx >= 0)
    assert.ok(restoreIdx >= 0)
    assert.ok(moreIdx > restoreIdx, "恢复全范围应出现在更多设置之前（主 Card 行程区）")
    assert.match(inspector, /handleRestoreFullStroke/)

    const moreBlock = inspector.slice(moreIdx)
    assert.doesNotMatch(moreBlock, /onClick=\{\(\) => handleRestoreFullStroke/)
  })

  it("I/J/K: restoreBindingFullRange behavior unchanged", () => {
    const base = normalizeFaceRigProfile(createDefaultFaceRigProfile())
    let profile = normalizeFaceRigProfile({
      ...base,
      bindings: [
        normalizeBinding({
          bindingId: "bind_priority_restore",
          controlId: "brow_l_tail",
          channel: CHANNEL_VALUE,
          servoId: 3,
          neutralPwm: 1500,
          positiveTargetPwm: 1700,
          negativeTargetPwm: 1300,
          rangeMode: "custom",
        }),
      ],
    })
    const id = profile.bindings[0].bindingId
    profile = restoreBindingFullRange(profile, id)
    const expected = bindingWithRestoredEndpointsVsNeutral(profile.bindings[0])
    assert.equal(profile.bindings[0].positiveTargetPwm, expected.positiveTargetPwm)
    assert.equal(profile.bindings[0].negativeTargetPwm, expected.negativeTargetPwm)
  })
})
