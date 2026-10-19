import { clampNumber, toInt } from "../utils/clamp.js"
import { readJsonStorage, writeJsonStorage } from "../utils/storage.js"

export const SERVO_CONFIG_STORAGE_KEY = "servo-face-console:servo-configs"

export const SERVO_CONFIG_VERSION = "1.1.0"

/** 新结构过渡期：单舵机/配置页可寻址 ID 暂扩至 40（后续随结构定型再收紧）。 */
export const SERVO_COUNT = 40

export const STANDARD_CENTER_PWM = 1500

/** 逻辑位置统一范围。关键帧、滑条、表情动作都保存逻辑 PWM，不保存实际 PWM。 */
export const SERVO_LOGICAL_MIN_PWM = 500
export const SERVO_LOGICAL_MAX_PWM = 2500

export const DEFAULT_GROUP_ID = "ungrouped"
export const DEFAULT_DEVICE_META = {
  deviceId: "face_robot_001",
  name: "面部表情机器人-样机1",
  note: "",
}

export const DEFAULT_SERVO_GROUPS = [
  {
    groupId: "ungrouped",
    name: "未分组",
    enabled: true,
    order: 0,
    note: "",
  },
  {
    groupId: "brow",
    name: "眉部",
    enabled: true,
    order: 10,
    note: "",
  },
  {
    groupId: "eye",
    name: "眼部",
    enabled: true,
    order: 20,
    note: "",
  },
  {
    groupId: "mouth",
    name: "嘴部",
    enabled: true,
    order: 30,
    note: "",
  },
  {
    groupId: "cheek",
    name: "脸颊",
    enabled: true,
    order: 40,
    note: "",
  },
  {
    groupId: "aux",
    name: "辅助",
    enabled: true,
    order: 90,
    note: "",
  },
]

export const DEFAULT_SERVO_CONFIG = {
  groupId: DEFAULT_GROUP_ID,
  enabled: true,

  /**
   * direction = 1:
   * 逻辑 500  → 实际下限
   * 逻辑 1500 → 机械零位
   * 逻辑 2500 → 实际上限
   *
   * direction = -1:
   * 逻辑 500  → 实际上限
   * 逻辑 1500 → 机械零位
   * 逻辑 2500 → 实际下限
   */
  direction: 1,

  actualMinPwm: 500,
  actualMaxPwm: 2500,

  mechanicalZeroPwm: 1500,
  zeroOffsetPwm: 0,

  lastLogicalPwm: 1500,

  /** pwm | scscl | sms_sts */
  protocol: "scscl",
  busId: null,
}

/* -------------------------------------------------------------------------- */
/* 基础工具                                                                    */
/* -------------------------------------------------------------------------- */

function mapLinear(value, inMin, inMax, outMin, outMax) {
  if (inMax === inMin) {
    return outMin
  }

  const ratio = (value - inMin) / (inMax - inMin)
  return outMin + ratio * (outMax - outMin)
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function normalizeDeviceMeta(device) {
  return {
    deviceId: String(device?.deviceId || DEFAULT_DEVICE_META.deviceId),
    name: String(device?.name || DEFAULT_DEVICE_META.name),
    note: String(device?.note || ""),
  }
}

export function normalizeDirection(value) {
  if (value === -1 || value === "-1" || value === "reverse" || value === "反向") {
    return -1
  }

  return 1
}

export function getDirectionName(direction) {
  return normalizeDirection(direction) === -1 ? "反向" : "正向"
}

/* -------------------------------------------------------------------------- */
/* 舵机分组                                                                    */
/* -------------------------------------------------------------------------- */

export function createDefaultServoGroups() {
  return DEFAULT_SERVO_GROUPS.map((group) => ({
    ...group,
  }))
}

export function normalizeServoGroup(group, fallbackOrder = 0) {
  const rawGroupId = String(group?.groupId || group?.id || DEFAULT_GROUP_ID).trim()
  const groupId = rawGroupId || DEFAULT_GROUP_ID

  return {
    groupId,
    name: String(group?.name || groupId),
    enabled: group?.enabled !== false,
    order: toInt(group?.order, fallbackOrder),
    note: String(group?.note || ""),
  }
}

export function normalizeServoGroups(groups) {
  const resultMap = new Map()

  createDefaultServoGroups().forEach((group) => {
    resultMap.set(group.groupId, normalizeServoGroup(group, group.order))
  })

  if (Array.isArray(groups)) {
    groups.forEach((group, index) => {
      const normalized = normalizeServoGroup(group, index)

      resultMap.set(normalized.groupId, {
        ...resultMap.get(normalized.groupId),
        ...normalized,
      })
    })
  }

  if (!resultMap.has(DEFAULT_GROUP_ID)) {
    resultMap.set(DEFAULT_GROUP_ID, normalizeServoGroup(DEFAULT_SERVO_GROUPS[0], 0))
  }

  return Array.from(resultMap.values()).sort((a, b) => a.order - b.order)
}

export function getServoGroup(groups, groupId) {
  const normalizedGroups = normalizeServoGroups(groups)
  const id = String(groupId || DEFAULT_GROUP_ID)

  return (
    normalizedGroups.find((group) => group.groupId === id) ||
    normalizedGroups.find((group) => group.groupId === DEFAULT_GROUP_ID) ||
    normalizeServoGroup(DEFAULT_SERVO_GROUPS[0], 0)
  )
}

export function updateServoGroup(groups, groupId, patch) {
  const id = String(groupId || DEFAULT_GROUP_ID)
  const normalizedGroups = normalizeServoGroups(groups)

  return normalizeServoGroups(
    normalizedGroups.map((group) => {
      if (group.groupId !== id) {
        return group
      }

      return {
        ...group,
        ...patch,
        groupId: id,
      }
    })
  )
}

export function addServoGroup(groups, newGroup) {
  const normalizedGroups = normalizeServoGroups(groups)
  const group = normalizeServoGroup(newGroup, normalizedGroups.length)

  if (normalizedGroups.some((item) => item.groupId === group.groupId)) {
    return updateServoGroup(normalizedGroups, group.groupId, group)
  }

  return normalizeServoGroups([...normalizedGroups, group])
}

/**
 * 删除分组时，建议由上层 UI 先把相关舵机移动到其他分组。
 * 这里仅删除 group 本身，并确保默认分组仍存在。
 */
export function deleteServoGroup(groups, groupId) {
  const id = String(groupId || DEFAULT_GROUP_ID)

  if (id === DEFAULT_GROUP_ID) {
    return normalizeServoGroups(groups)
  }

  return normalizeServoGroups(normalizeServoGroups(groups).filter((group) => group.groupId !== id))
}

/* -------------------------------------------------------------------------- */
/* 舵机配置                                                                    */
/* -------------------------------------------------------------------------- */

export function createDefaultServoConfig(servoId) {
  return {
    servoId,
    name: `舵机 ${servoId}`,
    groupId: DEFAULT_SERVO_CONFIG.groupId,
    enabled: DEFAULT_SERVO_CONFIG.enabled,

    direction: DEFAULT_SERVO_CONFIG.direction,

    actualMinPwm: DEFAULT_SERVO_CONFIG.actualMinPwm,
    actualMaxPwm: DEFAULT_SERVO_CONFIG.actualMaxPwm,

    mechanicalZeroPwm: DEFAULT_SERVO_CONFIG.mechanicalZeroPwm,
    zeroOffsetPwm: DEFAULT_SERVO_CONFIG.zeroOffsetPwm,

    lastLogicalPwm: DEFAULT_SERVO_CONFIG.lastLogicalPwm,

    protocol: DEFAULT_SERVO_CONFIG.protocol,
    busId: servoId,
  }
}

export function createDefaultServoConfigs(count = SERVO_COUNT) {
  return Array.from({ length: count }, (_, index) => createDefaultServoConfig(index))
}

export function normalizeServoConfig(config = {}) {
  const servoId = clampNumber(toInt(config.servoId, 0), 0, 254)

  let actualMinPwm = clampNumber(
    toInt(config.actualMinPwm, DEFAULT_SERVO_CONFIG.actualMinPwm),
    SERVO_LOGICAL_MIN_PWM,
    SERVO_LOGICAL_MAX_PWM
  )

  let actualMaxPwm = clampNumber(
    toInt(config.actualMaxPwm, DEFAULT_SERVO_CONFIG.actualMaxPwm),
    SERVO_LOGICAL_MIN_PWM,
    SERVO_LOGICAL_MAX_PWM
  )

  if (actualMinPwm >= actualMaxPwm) {
    actualMinPwm = SERVO_LOGICAL_MIN_PWM
    actualMaxPwm = SERVO_LOGICAL_MAX_PWM
  }

  /**
   * 兼容旧数据：
   * 旧配置只有 zeroOffsetPwm，没有 mechanicalZeroPwm。
   * 新配置以 mechanicalZeroPwm 为准，zeroOffsetPwm 由 mechanicalZeroPwm - 1500 得出。
   */
  const oldZeroOffsetPwm = clampNumber(toInt(config.zeroOffsetPwm, 0), -1000, 1000)

  const mechanicalZeroPwm = clampNumber(
    toInt(config.mechanicalZeroPwm, STANDARD_CENTER_PWM + oldZeroOffsetPwm),
    actualMinPwm,
    actualMaxPwm
  )

  const zeroOffsetPwm = mechanicalZeroPwm - STANDARD_CENTER_PWM

  const lastLogicalPwm = clampNumber(
    toInt(config.lastLogicalPwm, STANDARD_CENTER_PWM),
    SERVO_LOGICAL_MIN_PWM,
    SERVO_LOGICAL_MAX_PWM
  )

  const groupId = String(config.groupId || DEFAULT_GROUP_ID)

  const protocol =
    config.protocol === "scscl" || config.protocol === "sms_sts" || config.protocol === "rj_sbus"
      ? config.protocol
      : "scscl"
  const busId = clampNumber(toInt(config.busId ?? servoId, servoId), 0, 252)

  return {
    servoId,
    name: String(config.name || `舵机 ${servoId}`),
    groupId,
    enabled: config.enabled !== false,

    direction: normalizeDirection(config.direction),

    actualMinPwm,
    actualMaxPwm,

    mechanicalZeroPwm,
    zeroOffsetPwm,

    lastLogicalPwm,

    protocol,
    busId,
  }
}

export function normalizeServoConfigs(configs, count = SERVO_COUNT) {
  if (!Array.isArray(configs)) {
    return createDefaultServoConfigs(count)
  }

  const byId = new Map()

  configs.forEach((item) => {
    const normalized = normalizeServoConfig(item)
    byId.set(normalized.servoId, normalized)
  })

  const result = []

  for (let i = 0; i < count; i += 1) {
    result.push(byId.get(i) || createDefaultServoConfig(i))
  }

  return result
}

export function ensureServoGroupRefs(servos, groups) {
  const normalizedGroups = normalizeServoGroups(groups)
  const groupIdSet = new Set(normalizedGroups.map((group) => group.groupId))

  return normalizeServoConfigs(servos).map((servo) => {
    if (groupIdSet.has(servo.groupId)) {
      return servo
    }

    return {
      ...servo,
      groupId: DEFAULT_GROUP_ID,
    }
  })
}

export function getServoConfig(servos, servoId) {
  const id = toInt(servoId, 0)
  const normalizedServos = normalizeServoConfigs(servos)

  return normalizedServos.find((item) => item.servoId === id) || createDefaultServoConfig(id)
}

export function getServosByGroup(servos, groupId) {
  const id = String(groupId || DEFAULT_GROUP_ID)

  return normalizeServoConfigs(servos).filter((servo) => servo.groupId === id && servo.enabled)
}

function resolveServoPatch(item, patch) {
  const merged = {
    ...item,
    ...patch,
  }

  /**
   * 兼容旧 UI：
   * 如果上层还在 patch zeroOffsetPwm，也同步改 mechanicalZeroPwm。
   */
  if (hasOwn(patch, "mechanicalZeroPwm")) {
    const mechanicalZeroPwm = toInt(patch.mechanicalZeroPwm, STANDARD_CENTER_PWM)

    merged.mechanicalZeroPwm = mechanicalZeroPwm
    merged.zeroOffsetPwm = mechanicalZeroPwm - STANDARD_CENTER_PWM
  } else if (hasOwn(patch, "zeroOffsetPwm")) {
    const zeroOffsetPwm = toInt(patch.zeroOffsetPwm, 0)

    merged.zeroOffsetPwm = zeroOffsetPwm
    merged.mechanicalZeroPwm = STANDARD_CENTER_PWM + zeroOffsetPwm
  }

  return merged
}

export function updateServoConfig(servos, servoId, patch) {
  const id = toInt(servoId, 0)
  const normalizedServos = normalizeServoConfigs(servos)

  return normalizeServoConfigs(
    normalizedServos.map((item) => {
      if (item.servoId !== id) {
        return item
      }

      return resolveServoPatch(item, patch)
    })
  )
}

export function resetServoConfig(servos, servoId) {
  const id = toInt(servoId, 0)
  const normalizedServos = normalizeServoConfigs(servos)

  return normalizeServoConfigs(
    normalizedServos.map((item) => {
      if (item.servoId !== id) {
        return item
      }

      return createDefaultServoConfig(id)
    })
  )
}

/* -------------------------------------------------------------------------- */
/* 配置工程读写                                                                 */
/* -------------------------------------------------------------------------- */

export function createDefaultServoConfigProject() {
  const groups = createDefaultServoGroups()
  const servos = ensureServoGroupRefs(createDefaultServoConfigs(), groups)

  return {
    version: SERVO_CONFIG_VERSION,
    projectType: "robot-face-servo-config",
    standardCenterPwm: STANDARD_CENTER_PWM,
    servoCount: SERVO_COUNT,
    device: normalizeDeviceMeta(),
    groups,
    servos,
  }
}

export function normalizeServoConfigProject(project) {
  /**
   * 兼容旧格式：
   * 1. localStorage 里直接保存 servos 数组
   * 2. localStorage 里保存 { servos: [...] }
   */
  if (Array.isArray(project)) {
    const groups = createDefaultServoGroups()
    const servos = ensureServoGroupRefs(project, groups)

    return {
      ...createDefaultServoConfigProject(),
      device: normalizeDeviceMeta(),
      groups,
      servos,
    }
  }

  if (!project || typeof project !== "object") {
    return createDefaultServoConfigProject()
  }

  const groups = normalizeServoGroups(project.groups)
  const servos = ensureServoGroupRefs(project.servos, groups)
  const device = normalizeDeviceMeta(project.device)

  return {
    version: String(project.version || SERVO_CONFIG_VERSION),
    projectType: "robot-face-servo-config",
    standardCenterPwm: STANDARD_CENTER_PWM,
    servoCount: servos.length,
    device,
    groups,
    servos,
  }
}

export function loadServoConfigProject() {
  const stored = readJsonStorage(SERVO_CONFIG_STORAGE_KEY, null)

  return normalizeServoConfigProject(stored)
}

export function saveServoConfigProject(project) {
  const normalized = normalizeServoConfigProject(project)

  const payload = {
    ...normalized,
    version: SERVO_CONFIG_VERSION,
    savedAt: new Date().toISOString(),
  }

  writeJsonStorage(SERVO_CONFIG_STORAGE_KEY, payload)

  return payload
}

export function buildServoConfigProjectExport(project) {
  const normalized = normalizeServoConfigProject(project)

  return {
    ...normalized,
    version: SERVO_CONFIG_VERSION,
    exportedAt: new Date().toISOString(),
  }
}

/**
 * 兼容旧 UI：
 * 当前 ServoControlPanel 如果还在使用 loadServoConfigs/saveServoConfigs，
 * 这里仍然保持可用。
 */
export function loadServoConfigs() {
  return loadServoConfigProject().servos
}

export function saveServoConfigs(servos) {
  const currentProject = loadServoConfigProject()

  return saveServoConfigProject({
    ...currentProject,
    servos,
  })
}

export function buildServoConfigExport(configsOrProject) {
  if (Array.isArray(configsOrProject)) {
    const currentProject = loadServoConfigProject()

    return buildServoConfigProjectExport({
      ...currentProject,
      servos: configsOrProject,
    })
  }

  return buildServoConfigProjectExport(configsOrProject)
}

export function updateServoConfigInProject(project, servoId, patch) {
  const normalized = normalizeServoConfigProject(project)

  return normalizeServoConfigProject({
    ...normalized,
    servos: updateServoConfig(normalized.servos, servoId, patch),
  })
}

export function updateServoGroupInProject(project, groupId, patch) {
  const normalized = normalizeServoConfigProject(project)

  return normalizeServoConfigProject({
    ...normalized,
    groups: updateServoGroup(normalized.groups, groupId, patch),
  })
}

/* -------------------------------------------------------------------------- */
/* 逻辑 PWM → 实际 PWM 映射                                                     */
/* -------------------------------------------------------------------------- */

export function getLogicalRange() {
  return {
    logicalMinPwm: SERVO_LOGICAL_MIN_PWM,
    logicalMaxPwm: SERVO_LOGICAL_MAX_PWM,
  }
}

export function getMechanicalZeroPwm(servoConfig) {
  return normalizeServoConfig(servoConfig).mechanicalZeroPwm
}

export function actualToMechanicalZero(actualPwm) {
  return clampNumber(
    toInt(actualPwm, STANDARD_CENTER_PWM),
    SERVO_LOGICAL_MIN_PWM,
    SERVO_LOGICAL_MAX_PWM
  )
}

export function actualToZeroOffset(actualCenterPwm) {
  return actualToMechanicalZero(actualCenterPwm) - STANDARD_CENTER_PWM
}

/**
 * 逻辑 PWM 到实际 PWM 的核心映射。
 *
 * 注意：
 * 1. 关键帧、滑条、表情动作全部使用逻辑 PWM。
 * 2. 机械零位不会压缩最大/最小极限。
 * 3. 使用分段映射：
 *    逻辑 500  → 实际下限/上限
 *    逻辑 1500 → 机械零位
 *    逻辑 2500 → 实际上限/下限
 * 4. direction = -1 时，左右方向反转。
 */
export function logicalToActualPwm(logicalPwm, servoConfig) {
  const config = normalizeServoConfig(servoConfig)

  const inputLogicalPwm = clampNumber(
    toInt(logicalPwm, STANDARD_CENTER_PWM),
    SERVO_LOGICAL_MIN_PWM,
    SERVO_LOGICAL_MAX_PWM
  )

  const mechanicalZeroPwm = getMechanicalZeroPwm(config)
  const zeroOffsetPwm = mechanicalZeroPwm - STANDARD_CENTER_PWM

  /**
   * direction = -1 时，将逻辑坐标围绕 1500 镜像。
   *
   * 例：
   * 逻辑 500  → 2500
   * 逻辑 1500 → 1500
   * 逻辑 2500 → 500
   */
  const effectiveLogicalPwm =
    config.direction === -1
      ? STANDARD_CENTER_PWM - (inputLogicalPwm - STANDARD_CENTER_PWM)
      : inputLogicalPwm

  let rawActualPwm

  if (effectiveLogicalPwm <= STANDARD_CENTER_PWM) {
    rawActualPwm = mapLinear(
      effectiveLogicalPwm,
      SERVO_LOGICAL_MIN_PWM,
      STANDARD_CENTER_PWM,
      config.actualMinPwm,
      mechanicalZeroPwm
    )
  } else {
    rawActualPwm = mapLinear(
      effectiveLogicalPwm,
      STANDARD_CENTER_PWM,
      SERVO_LOGICAL_MAX_PWM,
      mechanicalZeroPwm,
      config.actualMaxPwm
    )
  }

  rawActualPwm = Math.round(rawActualPwm)

  const actualPwm = clampNumber(rawActualPwm, config.actualMinPwm, config.actualMaxPwm)

  const limited = rawActualPwm !== actualPwm

  return {
    servoId: config.servoId,

    inputLogicalPwm,
    effectiveLogicalPwm,

    direction: config.direction,

    mechanicalZeroPwm,
    zeroOffsetPwm,

    rawActualPwm,
    actualPwm,
    limited,
  }
}

export function buildSimpleSendText(convertResult) {
  const offset = convertResult.zeroOffsetPwm
  const offsetText = offset === 0 ? "" : `，偏移${offset > 0 ? "+" : ""}${offset}`

  const directionText = convertResult.direction === -1 ? "，反向" : ""

  const limitedText = convertResult.limited ? "，限位" : ""

  return `舵机 ${convertResult.servoId}：${convertResult.inputLogicalPwm} → ${convertResult.actualPwm}${directionText}${offsetText}${limitedText}`
}
