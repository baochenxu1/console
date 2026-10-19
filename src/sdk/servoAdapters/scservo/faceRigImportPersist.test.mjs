/**
 * 面部绑定：导入即落盘（替换本地单文档）。
 */
import assert from "node:assert/strict"
import test from "node:test"

const store = new Map()
const localStorageMock = {
  getItem(key) {
    return store.has(key) ? store.get(key) : null
  },
  setItem(key, value) {
    store.set(key, String(value))
  },
  removeItem(key) {
    store.delete(key)
  },
}
globalThis.window = {
  localStorage: localStorageMock,
  dispatchEvent() {
    return true
  },
}
globalThis.localStorage = localStorageMock

const {
  createDefaultFaceRigProfile,
  saveFaceRigProfile,
  loadFaceRigProfile,
  parseFaceRigImport,
  buildFaceRigExportFilename,
  FACE_RIG_STORAGE_KEY,
} = await import("../../../core/faceRigProfile.js")

test("导入绑定：parse + save 后 load 即为导入内容", () => {
  store.clear()
  const baseline = createDefaultFaceRigProfile()
  baseline.name = "旧绑定"
  saveFaceRigProfile(baseline)

  const incoming = {
    projectType: "robot-face-rig-profile",
    name: "新设备绑定",
    controls: baseline.controls,
    bindings: [
      {
        bindingId: "b_test",
        controlId: "jaw_open",
        channel: "value",
        servoId: 25,
        enabled: true,
        neutralPwm: 1500,
        positiveTargetPwm: 1800,
        negativeTargetPwm: 1200,
        weight: 1,
        curve: "linear",
        rangeMode: "custom",
      },
    ],
  }

  const imported = parseFaceRigImport(incoming)
  const saved = saveFaceRigProfile(imported)
  assert.equal(saved.name, "新设备绑定")

  const loaded = loadFaceRigProfile()
  assert.equal(loaded.name, "新设备绑定")
  assert.ok(localStorage.getItem(FACE_RIG_STORAGE_KEY))
})

test("导出文件名包含配置名称", () => {
  const name = buildFaceRigExportFilename("精英面部绑定")
  assert.match(name, /^精英面部绑定_\d{8}_\d{6}\.json$/)
})
