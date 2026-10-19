import { loadBusServoProfiles } from "../servoAdapters/busServo/loadBusServoProfiles.js"
import { migrateLegacyBusProfilesToActuatorProfiles } from "./migrateLegacyBusProfilesToActuatorProfiles.js"

/**
 * 加载 actuator profiles（由当前总线舵机配置迁移而来）。
 * 每次调用都重新读 storage，面部绑定下发请直接调用本函数，勿长期缓存旧列表。
 */
export function loadActuatorProfiles() {
  const bus = loadBusServoProfiles()
  const actuatorProfiles = migrateLegacyBusProfilesToActuatorProfiles({
    oldProfiles: bus.profiles,
  })

  return {
    source: bus.source,
    allowRealSend: bus.allowRealSend && actuatorProfiles.length > 0,
    busProfiles: bus.profiles,
    actuatorProfiles,
    project: bus.project,
    updatedAt: bus.project?.updatedAt || bus.project?.createdAt || null,
  }
}
