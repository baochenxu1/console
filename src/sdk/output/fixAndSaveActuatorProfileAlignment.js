import { loadBusServoProfiles } from "../servoAdapters/busServo/loadBusServoProfiles.js"
import {
  loadScServoLabProject,
  saveScServoLabProject,
} from "../servoAdapters/scservo/scServoLabStore.js"
import { normalizeLabServoProfile } from "../servoAdapters/core/servoProfile.js"
import { legacyServoIndexToActuatorKey } from "./actuatorKeys.js"
import {
  analyzeActuatorProfiles,
  fixActuatorProfileBusIdAlignment,
} from "./analyzeActuatorProfiles.js"
import { migrateLegacyBusProfilesToActuatorProfiles } from "./migrateLegacyBusProfilesToActuatorProfiles.js"

/**
 * 一键修复：bus profile id 与 actuatorKey 数字对齐，写入 localStorage。
 * 保留 protocol、零点、safeWindow、direction 等字段。
 */
export function fixAndSaveActuatorProfileAlignment() {
  const bus = loadBusServoProfiles()
  const before = migrateLegacyBusProfilesToActuatorProfiles({
    oldProfiles: bus.profiles,
  })
  const analysisBefore = analyzeActuatorProfiles(before)

  const project = loadScServoLabProject()
  const nextProfiles = {}

  for (const entry of bus.profiles) {
    const p = normalizeLabServoProfile(entry)
    const n = Number(p.id)
    if (!Number.isFinite(n) || n <= 0) {
      continue
    }
    const aligned = normalizeLabServoProfile({
      ...p,
      id: n,
      actuatorKey: legacyServoIndexToActuatorKey(n),
    })
    // 单文档模型：主键为 busId，同 ID 只保留一条
    nextProfiles[String(n)] = aligned
  }

  const saved = saveScServoLabProject({ ...project, profiles: nextProfiles })

  const after = migrateLegacyBusProfilesToActuatorProfiles({
    oldProfiles: Object.values(nextProfiles),
  })
  const analysisAfter = analyzeActuatorProfiles(after)

  return {
    ok: true,
    saved,
    fixedCount: Object.keys(nextProfiles).length,
    analysisBefore,
    analysisAfter,
    message:
      analysisAfter.aligned
        ? `已对齐 ${Object.keys(nextProfiles).length} 个 bus profile（actuatorKey ↔ bus ID 1:1）`
        : `已保存，但仍有 ${analysisAfter.mismatchCount} 项不一致，请检查配置`,
  }
}

export function realignActuatorProfilesInMemory(profiles) {
  const fixed = fixActuatorProfileBusIdAlignment(profiles)
  return {
    profiles: fixed,
    analysis: analyzeActuatorProfiles(fixed),
  }
}
