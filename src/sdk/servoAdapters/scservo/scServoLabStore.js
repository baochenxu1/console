/**
 * 舵机配置：单活动工程文档（对齐表情编排）。
 *
 * 规则：
 * - 本地只有一份生效文档
 * - 每个 busServoId 只保留一条 Profile（protocol/servoModel 为字段，不是主键）
 * - 切换协议 / 保存 = 覆盖该 ID，旧协议条目失效
 * - 导入 = 整份替换并立即落盘，清除历史 storage 键
 */

import { readJsonStorage, writeJsonStorage } from "../../../utils/storage.js"
import { PROTOCOL } from "../core/servoTypes.js"
import { normalizeLabServoProfile, createDefaultLabServoProfile } from "../core/servoProfile.js"
import { defaultServoModelForProtocol } from "../core/servoMechanicalSafety.js"
import {
  pickBestActuatorProfile,
  preferredProtocolFromBusTransportFamily,
} from "../../output/actuatorProfilePick.js"
import { getStoredBusTransportFamily } from "../busServo/resolveBusTransport.js"
import { sanitizeExpressionExportBasename, getDateTimeText } from "../../../utils/fileExport.js"

/** 正式单文档槽 */
export const SERVO_CONFIG_DOCUMENT_STORAGE_KEY = "facedev.servoConfigDocument.v1"

/** @deprecated 多键残留，导入/保存时清空 */
export const SC_SERVO_LAB_STORAGE_KEY = "facedev.servoProfiles.v2"
export const SC_SERVO_LAB_STORAGE_KEY_V1 = "facedev.servoProfiles.v1"
const LEGACY_STORAGE_KEY = "servo-face-console:sc-servo-lab-profiles"

export const BUS_SERVO_PROFILES_CHANGED_EVENT = "facedev:busServoProfilesChanged"

export const SERVO_CONFIG_DOCUMENT_VERSION = "facedev.servoConfigDocument.v1"
export const SERVO_CONFIG_DOCUMENT_TYPE = "robot-face-servo-config"

/** 兼容旧调用：仍导出 makeProfileKey，但存储不再用它做主键 */
export function makeProfileKey(protocol, id, servoModel) {
  const m = servoModel || defaultServoModelForProtocol(protocol)
  return `${protocol}:${m}:${id}`
}

export function makeLegacyProfileKey(protocol, id) {
  return `${protocol}:${id}`
}

function profileIdKey(id) {
  return String(Number(id))
}

function emitProfilesChanged(document) {
  if (typeof window === "undefined") return
  const n = Object.keys(document?.profiles || {}).length
  window.dispatchEvent(
    new CustomEvent(BUS_SERVO_PROFILES_CHANGED_EVENT, {
      detail: {
        updatedAt: document?.updatedAt || null,
        profileCount: n,
        documentName: document?.documentName || null,
      },
    })
  )
}

export function createDefaultServoConfigDocument() {
  return {
    version: SERVO_CONFIG_DOCUMENT_VERSION,
    projectType: SERVO_CONFIG_DOCUMENT_TYPE,
    documentId: "servo_cfg_001",
    documentName: "默认配置",
    profiles: {},
    updatedAt: new Date().toISOString(),
    savedAt: null,
  }
}

/**
 * 将任意历史 profiles（数组 / 多键 map）折叠为「每 busId 一条」。
 * 同 ID 多协议时必须带 UI 总线族 preferredProtocol，否则 ST installed_center
 * 会永久压掉 RJ，面部绑定对 ID2/4 等就会发飞特帧而 RJ 真机不动。
 */
export function collapseProfilesToOnePerBusId(rawProfiles, options = {}) {
  /** @type {Record<string, object[]>} */
  const groups = {}

  const push = (entry) => {
    const p = normalizeLabServoProfile(entry)
    const id = Number(p.id)
    if (!Number.isFinite(id) || id < 0) return
    const key = profileIdKey(id)
    if (!groups[key]) groups[key] = []
    groups[key].push(p)
  }

  if (Array.isArray(rawProfiles)) {
    for (const entry of rawProfiles) push(entry)
  } else if (rawProfiles && typeof rawProfiles === "object") {
    for (const entry of Object.values(rawProfiles)) push(entry)
  }

  const preferredProtocol =
    options.preferredProtocol ||
    preferredProtocolFromBusTransportFamily(getStoredBusTransportFamily())

  /** @type {Record<string, object>} */
  const out = {}
  for (const [idKey, list] of Object.entries(groups)) {
    const best =
      list.length === 1
        ? list[0]
        : pickBestActuatorProfile(list, { preferredProtocol })
    if (!best) continue
    const p = normalizeLabServoProfile({ ...best, id: Number(idKey) })
    out[idKey] = p
  }
  return out
}

function clearLegacyServoProfileKeys() {
  try {
    if (typeof localStorage === "undefined") return
    localStorage.removeItem(SC_SERVO_LAB_STORAGE_KEY)
    localStorage.removeItem(SC_SERVO_LAB_STORAGE_KEY_V1)
    localStorage.removeItem(LEGACY_STORAGE_KEY)
  } catch {
    //
  }
}

function readLegacyV2Project() {
  let raw = readJsonStorage(SC_SERVO_LAB_STORAGE_KEY, null)
  if (!raw?.profiles) raw = readJsonStorage(SC_SERVO_LAB_STORAGE_KEY_V1, null)
  if (!raw?.profiles) {
    const legacy = readJsonStorage(LEGACY_STORAGE_KEY, null)
    if (legacy?.profiles) raw = legacy
  }
  return raw
}

/**
 * @returns {object} servo config document
 */
export function loadScServoLabProject() {
  const doc = readJsonStorage(SERVO_CONFIG_DOCUMENT_STORAGE_KEY, null)
  if (doc && (doc.projectType === SERVO_CONFIG_DOCUMENT_TYPE || doc.version === SERVO_CONFIG_DOCUMENT_VERSION)) {
    return normalizeServoConfigDocument(doc)
  }

  const legacy = readLegacyV2Project()
  if (legacy?.profiles && Object.keys(legacy.profiles).length > 0) {
    const migrated = normalizeServoConfigDocument({
      ...createDefaultServoConfigDocument(),
      documentName: "默认配置",
      profiles: collapseProfilesToOnePerBusId(legacy.profiles),
      migratedFrom: "facedev.servoProfiles.v2",
    })
    saveScServoLabProject(migrated)
    clearLegacyServoProfileKeys()
    return migrated
  }

  return createDefaultServoConfigDocument()
}

export function normalizeServoConfigDocument(raw) {
  const base = createDefaultServoConfigDocument()
  if (!raw || typeof raw !== "object") return base
  const profiles = collapseProfilesToOnePerBusId(raw.profiles || {})
  let documentName = String(raw.documentName || raw.name || base.documentName).trim() || base.documentName
  if (documentName === "从旧版迁移的舵机配置" || documentName === "默认舵机配置") {
    documentName = "默认配置"
  }
  return {
    ...base,
    ...raw,
    version: SERVO_CONFIG_DOCUMENT_VERSION,
    projectType: SERVO_CONFIG_DOCUMENT_TYPE,
    documentId: String(raw.documentId || base.documentId),
    documentName,
    profiles,
    updatedAt: raw.updatedAt || base.updatedAt,
    savedAt: raw.savedAt || null,
  }
}

/**
 * 整份替换落盘；同时清除历史多键 storage。
 * @returns {object} saved document
 */
export function saveScServoLabProject(project) {
  const document = normalizeServoConfigDocument({
    ...project,
    updatedAt: new Date().toISOString(),
    savedAt: new Date().toISOString(),
  })
  writeJsonStorage(SERVO_CONFIG_DOCUMENT_STORAGE_KEY, document)
  clearLegacyServoProfileKeys()
  emitProfilesChanged(document)
  return document
}

/** 兼容别名 */
export const loadServoConfigDocument = loadScServoLabProject
export const saveServoConfigDocument = saveScServoLabProject

/**
 * 按 busId 取当前生效 Profile；不存在则返回未落盘的默认（请求协议）。
 */
export function getLabProfile(project, id, protocol = PROTOCOL.SCSCL) {
  const sid = Number(id)
  const key = profileIdKey(sid)
  const existing = project?.profiles?.[key]
  if (existing) {
    return normalizeLabServoProfile({ ...existing, id: sid })
  }
  return createDefaultLabServoProfile({ id: sid, protocol })
}

/**
 * 写入/覆盖该 busId 的唯一 Profile（旧协议条目一并失效）。
 */
export function setLabProfile(project, profile) {
  const p = normalizeLabServoProfile(profile)
  const key = profileIdKey(p.id)
  return {
    ...project,
    profiles: {
      ...(project.profiles || {}),
      [key]: p,
    },
    updatedAt: new Date().toISOString(),
  }
}

/**
 * 删除该 busId 的全部配置（与协议无关）。
 */
export function clearLabProfile(project, id, _protocol) {
  const key = profileIdKey(id)
  const next = { ...(project.profiles || {}) }
  delete next[key]
  // 兼容清理万一残留的旧多键形态
  for (const k of Object.keys(next)) {
    if (k.endsWith(`:${Number(id)}`) && k.includes(":")) delete next[k]
  }
  return { ...project, profiles: next, updatedAt: new Date().toISOString() }
}

export function migrateLabProfileOnIdChange(project, oldId, newId, protocol, { copy = true } = {}) {
  if (!copy) return project
  const src = getLabProfile(project, oldId, protocol)
  if (!project?.profiles?.[profileIdKey(oldId)]) {
    return project
  }
  let next = setLabProfile(project, { ...src, id: Number(newId) })
  next = clearLabProfile(next, oldId)
  return next
}

export function updateServoConfigDocumentName(project, name) {
  const documentName = String(name || "").trim() || "未命名舵机配置"
  return { ...project, documentName, updatedAt: new Date().toISOString() }
}

export function buildLabExportPayload(project) {
  const doc = normalizeServoConfigDocument(project)
  return {
    version: SERVO_CONFIG_DOCUMENT_VERSION,
    projectType: SERVO_CONFIG_DOCUMENT_TYPE,
    documentId: doc.documentId,
    documentName: doc.documentName,
    createdAt: new Date().toISOString(),
    exportedAt: new Date().toISOString(),
    // 数组便于阅读；导入时折叠为每 ID 一条
    profiles: Object.values(doc.profiles || {}).map((p) => normalizeLabServoProfile(p)),
  }
}

export function buildServoConfigExportFilename(documentName) {
  const base = sanitizeExpressionExportBasename(documentName, "servo-config")
  return `${base}_${getDateTimeText()}.json`
}

/**
 * 解析导入文件 → 单文档（每 ID 一条）。不落盘；调用方应 save 覆盖本地。
 */
export function parseLabImportPayload(data) {
  if (!data || typeof data !== "object") {
    throw new Error("无效的舵机配置文件。")
  }

  let list = []
  if (Array.isArray(data.profiles)) {
    list = data.profiles
  } else if (data.profiles && typeof data.profiles === "object") {
    list = Object.values(data.profiles)
  } else if (Array.isArray(data)) {
    list = data
  } else {
    throw new Error("配置文件缺少 profiles。")
  }

  const profiles = collapseProfilesToOnePerBusId(list)
  if (Object.keys(profiles).length === 0) {
    throw new Error("配置文件中没有有效的舵机 Profile。")
  }

  return normalizeServoConfigDocument({
    ...createDefaultServoConfigDocument(),
    documentId: data.documentId || `servo_cfg_import_${Date.now()}`,
    documentName: String(data.documentName || data.name || "导入的舵机配置").trim(),
    profiles,
    importNote: "导入已整份替换本地配置；旧多协议残留已失效。",
  })
}

/**
 * 导入并立即生效：覆盖文档槽 + 删除历史键。
 */
export function importAndActivateServoConfigDocument(data) {
  const document = parseLabImportPayload(data)
  return saveScServoLabProject(document)
}

export function resetServoConfigDocumentToDefault() {
  const document = createDefaultServoConfigDocument()
  return saveScServoLabProject(document)
}
