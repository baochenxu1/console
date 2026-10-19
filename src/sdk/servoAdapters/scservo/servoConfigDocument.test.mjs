/**
 * 舵机配置单文档：折叠 / 导入 / 落盘 / 清除旧键。
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
  collapseProfilesToOnePerBusId,
  createDefaultServoConfigDocument,
  parseLabImportPayload,
  importAndActivateServoConfigDocument,
  setLabProfile,
  getLabProfile,
  saveScServoLabProject,
  loadScServoLabProject,
  SERVO_CONFIG_DOCUMENT_STORAGE_KEY,
  SC_SERVO_LAB_STORAGE_KEY,
  PROTOCOL,
} = await import("./scServoLabStore.js")

function makeProfile(id, protocol, servoModel, extra = {}) {
  return {
    id,
    protocol,
    servoModel,
    label: `S${id}`,
    centerMode: "installed_center",
    installedCenterValid: true,
    installedCenterPosition: protocol === "scscl" ? 512 : 2048,
    calibratedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  }
}

test("collapseProfilesToOnePerBusId：同 ID 多协议只留一条", () => {
  const collapsed = collapseProfilesToOnePerBusId({
    "scscl:sc_300_1024:26": makeProfile(26, "scscl", "sc_300_1024"),
    "sms_sts:sts_3215_4096:26": makeProfile(26, "sms_sts", "sts_3215_4096", {
      calibratedAt: "2026-06-01T00:00:00.000Z",
    }),
    "sms_sts:sts_3215_4096:25": makeProfile(25, "sms_sts", "sts_3215_4096"),
  })
  assert.equal(Object.keys(collapsed).length, 2)
  assert.ok(collapsed["26"])
  assert.ok(collapsed["25"])
  assert.equal(Number(collapsed["26"].id), 26)
  assert.equal(Number(collapsed["25"].id), 25)
})

test("setLabProfile：切换协议覆盖同 ID，不残留多键", () => {
  let doc = createDefaultServoConfigDocument()
  doc = setLabProfile(doc, makeProfile(25, "sms_sts", "sts_3215_4096"))
  doc = setLabProfile(doc, makeProfile(25, "scscl", "sc_300_1024"))
  assert.equal(Object.keys(doc.profiles).length, 1)
  assert.equal(doc.profiles["25"].protocol, "scscl")
  const got = getLabProfile(doc, 25, "sms_sts")
  assert.equal(got.protocol, "scscl", "取 Profile 以文档生效条为准，不按请求协议另开槽")
})

test("importAndActivate：整份替换并清除旧 v2 键", () => {
  store.clear()
  localStorage.setItem(
    SC_SERVO_LAB_STORAGE_KEY,
    JSON.stringify({
      version: "facedev.servoProfiles.v2",
      profiles: {
        "scscl:sc_300_1024:26": makeProfile(26, "scscl", "sc_300_1024"),
        "sms_sts:sts_3215_4096:26": makeProfile(26, "sms_sts", "sts_3215_4096"),
      },
    })
  )

  const imported = importAndActivateServoConfigDocument({
    projectType: "robot-face-servo-config",
    documentName: "新设备配置",
    profiles: [makeProfile(25, "sms_sts", "sts_3215_4096"), makeProfile(26, "sms_sts", "sts_3215_4096")],
  })

  assert.equal(imported.documentName, "新设备配置")
  assert.equal(Object.keys(imported.profiles).length, 2)
  assert.equal(localStorage.getItem(SC_SERVO_LAB_STORAGE_KEY), null)
  assert.ok(localStorage.getItem(SERVO_CONFIG_DOCUMENT_STORAGE_KEY))
  const reloaded = loadScServoLabProject()
  assert.equal(reloaded.documentName, "新设备配置")
  assert.equal(Object.keys(reloaded.profiles).length, 2)
})

test("parseLabImportPayload：兼容旧 v2 profiles 数组并折叠", () => {
  const doc = parseLabImportPayload({
    version: "facedev.servoProfiles.v2",
    profiles: [
      makeProfile(10, "scscl", "sc_300_1024"),
      makeProfile(10, "sms_sts", "sts_3215_4096"),
    ],
  })
  assert.equal(Object.keys(doc.profiles).length, 1)
  assert.equal(Number(doc.profiles["10"].id), 10)
})

test("load：旧 v2 自动迁移到单文档并清旧键", () => {
  store.clear()
  localStorage.setItem(
    SC_SERVO_LAB_STORAGE_KEY,
    JSON.stringify({
      version: "facedev.servoProfiles.v2",
      profiles: {
        "scscl:sc_300_1024:1": makeProfile(1, "scscl", "sc_300_1024"),
        "sms_sts:sts_3215_4096:1": makeProfile(1, "sms_sts", "sts_3215_4096"),
      },
    })
  )
  const doc = loadScServoLabProject()
  assert.equal(Object.keys(doc.profiles).length, 1)
  assert.equal(localStorage.getItem(SC_SERVO_LAB_STORAGE_KEY), null)
  assert.ok(localStorage.getItem(SERVO_CONFIG_DOCUMENT_STORAGE_KEY))
})

test("save：写出单文档槽", () => {
  store.clear()
  let doc = createDefaultServoConfigDocument()
  doc = setLabProfile(doc, makeProfile(3, "sms_sts", "sts_3215_4096"))
  const saved = saveScServoLabProject(doc)
  assert.equal(saved.projectType, "robot-face-servo-config")
  const raw = JSON.parse(localStorage.getItem(SERVO_CONFIG_DOCUMENT_STORAGE_KEY))
  assert.equal(Object.keys(raw.profiles).length, 1)
  assert.equal(raw.profiles["3"].protocol, "sms_sts")
})

void PROTOCOL
