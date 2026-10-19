import { readJsonStorage } from "../../../utils/storage.js"
import {
  SERVO_CONFIG_DOCUMENT_STORAGE_KEY,
  SC_SERVO_LAB_STORAGE_KEY,
  loadScServoLabProject,
  createDefaultServoConfigDocument,
} from "../scservo/scServoLabStore.js"
import { normalizeLabServoProfile } from "../core/servoProfile.js"
import { BUS_SERVO_PROFILE_ACTIVE } from "./busServoProfileActive.js"

function projectProfilesToArray(project) {
  if (!project?.profiles) {
    return []
  }
  if (Array.isArray(project.profiles)) {
    return project.profiles.map((p) => normalizeLabServoProfile(p))
  }
  return Object.values(project.profiles).map((p) => normalizeLabServoProfile(p))
}

/**
 * 加载总线舵机 profile 列表。
 * 面部绑定 / Tracking 下发应经 {@link loadActuatorProfiles} 每次现读，以本地「当前生效文档」为准。
 * 优先级：servoConfigDocument.v1（含从旧 v2 迁移）→ bus-servo-profile.active.json → 空。
 */
export function loadBusServoProfiles() {
  // 走正式 load（含旧键迁移折叠），保证每 busId 一条
  const fromDocument = loadScServoLabProject()
  const docProfiles = projectProfilesToArray(fromDocument)
  if (docProfiles.length > 0) {
    return {
      source: "localStorage",
      project: fromDocument,
      profiles: docProfiles,
      allowRealSend: true,
    }
  }

  // 空文档时仍可读内置 active.json（只读种子，不会写回旧 v2 键）
  const rawDoc = readJsonStorage(SERVO_CONFIG_DOCUMENT_STORAGE_KEY, null)
  const rawLegacy = readJsonStorage(SC_SERVO_LAB_STORAGE_KEY, null)
  if (!rawDoc && !rawLegacy && BUS_SERVO_PROFILE_ACTIVE?.profiles?.length > 0) {
    const profiles = projectProfilesToArray(BUS_SERVO_PROFILE_ACTIVE)
    return {
      source: "active-json",
      project: BUS_SERVO_PROFILE_ACTIVE,
      profiles,
      allowRealSend: profiles.length > 0,
    }
  }

  return {
    source: "empty",
    project: fromDocument || createDefaultServoConfigDocument(),
    profiles: [],
    allowRealSend: false,
  }
}
