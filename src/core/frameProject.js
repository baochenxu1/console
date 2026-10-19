import {
  SERVO_COUNT,
  SERVO_LOGICAL_MAX_PWM,
  SERVO_LOGICAL_MIN_PWM,
  STANDARD_CENTER_PWM,
} from "./servoConfig.js"
import { createInitialEliteRig, normalizeEliteRig } from "./faceDofMapper.js"
import { clampNumber, toInt } from "../utils/clamp.js"
import { readJsonStorage, writeJsonStorage } from "../utils/storage.js"
import { getAllTimelineChannelIds, isFullFaceKeyed, expandKeyedChannelsToCharacter } from "./expressionTimelineChannels.js"
import { EXPRESSION_EASING_LINEAR } from "./expressionEasing.js"
import {
  characterPoseFromFaceRig,
  normalizeCharacterPose,
  createNeutralCharacterPose,
} from "./characterPose.js"
import {
  createDefaultProjectModules,
  normalizeProjectModules,
} from "./frameProjectNeckModule.js"

export {
  createDefaultProjectModules,
  normalizeProjectModules,
  getProjectNeckModule,
  patchProjectNeckModule,
  canEditNeckPose,
  canDispatchNeckHardware,
  canDispatchNeckPhysical,
  shouldWriteNeckOnFullCharacterKey,
} from "./frameProjectNeckModule.js"

export const FRAME_PROJECT_STORAGE_KEY = "servo-face-console:single-expression-project"
export const FRAME_PROJECT_VERSION = "3.0.0"
export const FRAME_PROJECT_TYPE = "robot-face-single-expression"
export const DEFAULT_TIMELINE_DURATION_MS = 5000

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
}

export function getEnabledServos(configs = []) {
  if (!Array.isArray(configs) || configs.length === 0) {
    return Array.from({ length: SERVO_COUNT }, (_, servoId) => ({
      servoId,
      name: `舵机 ${servoId}`,
      enabled: true,
    }))
  }

  return configs.filter((servo) => servo.enabled !== false)
}

export function createPoseFromServos(configs = [], sourcePose = {}) {
  const pose = {}

  for (const servo of getEnabledServos(configs)) {
    const key = String(servo.servoId)
    pose[key] = clampNumber(
      toInt(sourcePose?.[key], STANDARD_CENTER_PWM),
      SERVO_LOGICAL_MIN_PWM,
      SERVO_LOGICAL_MAX_PWM
    )
  }

  return pose
}

/** 缺键一律中位，不回填 lastLogicalPwm。 */
export function isCenterOnlyLogicalPose(positions = {}) {
  if (!positions || typeof positions !== "object") {
    return true
  }
  const keys = Object.keys(positions)
  if (keys.length === 0) {
    return true
  }
  return keys.every((key) => {
    const n = Number(positions[key])
    return !Number.isFinite(n) || n === STANDARD_CENTER_PWM
  })
}

function uniqChannels(list) {
  const out = []
  const seen = new Set()
  for (const id of list || []) {
    const s = String(id)
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

function looksLikeV2Keyframe(frame) {
  return frame && typeof frame === "object" && Number.isFinite(Number(frame.timeMs))
}

function looksLikeV2Project(project) {
  if (!project || typeof project !== "object") return false
  if (Number.isFinite(Number(project.timelineDurationMs))) return true
  const kfs = Array.isArray(project.keyframes) ? project.keyframes : []
  return kfs.length > 0 && kfs.every(looksLikeV2Keyframe)
}

/**
 * Legacy duration 链 → absolute timeMs + timelineDurationMs。
 * KF0.duration=500, KF1=300, KF2=200 → times 0/500/800, duration=1000。
 */
export function migrateLegacyKeyframesToAbsoluteTime(rawKeyframes = []) {
  const all = getAllTimelineChannelIds()
  const list = Array.isArray(rawKeyframes) ? rawKeyframes : []
  const migrated = []
  let timeMs = 0
  let totalDurationMs = 0

  for (let i = 0; i < list.length; i += 1) {
    const frame = list[i] || {}
    const durationMs = Math.max(0, toInt(frame.durationMs, 500))
    totalDurationMs += durationMs

    const keyed =
      Array.isArray(frame.keyedChannels) && frame.keyedChannels.length > 0
        ? uniqChannels(frame.keyedChannels)
        : all

    migrated.push({
      ...frame,
      timeMs: Number.isFinite(Number(frame.timeMs)) ? Math.max(0, Math.round(Number(frame.timeMs))) : timeMs,
      keyedChannels: keyed,
      // durationMs 仅作 legacy 兼容字段保留，不再作为时间权威
      durationMs,
    })
    timeMs += durationMs
  }

  return {
    keyframes: migrated,
    timelineDurationMs: Math.max(totalDurationMs, timeMs, DEFAULT_TIMELINE_DURATION_MS),
  }
}

export function createKeyframe({
  name,
  timeMs = 0,
  durationMs = 500,
  positions = {},
  rigSnapshot = null,
  characterPose = null,
  keyedChannels = null,
  configs = [],
  easing = EXPRESSION_EASING_LINEAR,
} = {}) {
  const keyframeId = createId("kf")
  const all = getAllTimelineChannelIds()
  const channels =
    Array.isArray(keyedChannels) && keyedChannels.length > 0 ? uniqChannels(keyedChannels) : all

  const pose = characterPose
    ? normalizeCharacterPose(characterPose)
    : characterPoseFromFaceRig(rigSnapshot || createInitialEliteRig())

  const frame = {
    keyframeId,
    id: keyframeId,
    name: name || "关键帧",
    timeMs: Math.max(0, Math.round(Number(timeMs) || 0)),
    durationMs: Math.max(20, toInt(durationMs, 500)),
    easing: String(easing || EXPRESSION_EASING_LINEAR),
    positions: createPoseFromServos(configs, positions),
    keyedChannels: expandKeyedChannelsToCharacter(channels),
    characterPose: pose,
    rigSnapshot: pose.face,
  }
  return frame
}

export function createDefaultFrameProject(configs = []) {
  const firstKeyframe = createKeyframe({
    name: "自然表情",
    timeMs: 0,
    durationMs: 500,
    positions: createPoseFromServos(configs),
    rigSnapshot: createInitialEliteRig(),
    keyedChannels: getAllTimelineChannelIds(),
    configs,
  })

  return {
    version: FRAME_PROJECT_VERSION,
    projectType: FRAME_PROJECT_TYPE,
    expressionId: "expr_001",
    expressionName: "未命名表情",
    timelineDurationMs: DEFAULT_TIMELINE_DURATION_MS,
    keyframes: [firstKeyframe],
    modules: createDefaultProjectModules(),
    updatedAt: new Date().toISOString(),
  }
}

export function normalizeKeyframe(frame = {}, configs = [], index = 0) {
  const keyframeId = String(frame.keyframeId || frame.id || createId("kf"))
  const sourcePositions = frame.positions || frame.pose || {}
  const all = getAllTimelineChannelIds()

  const timeMs = Number.isFinite(Number(frame.timeMs))
    ? Math.max(0, Math.round(Number(frame.timeMs)))
    : 0

  let keyedChannels =
    Array.isArray(frame.keyedChannels) && frame.keyedChannels.length > 0
      ? uniqChannels(frame.keyedChannels)
      : all
  keyedChannels = expandKeyedChannelsToCharacter(keyedChannels)

  let characterPose
  if (frame.characterPose && typeof frame.characterPose === "object") {
    characterPose = normalizeCharacterPose(frame.characterPose)
  } else if (frame.rigSnapshot && typeof frame.rigSnapshot === "object") {
    characterPose = characterPoseFromFaceRig(frame.rigSnapshot)
  } else {
    characterPose = createNeutralCharacterPose()
    // positions-only legacy：不伪造 face；采样层走 legacyFallback
    characterPose = {
      face: undefined,
      neck: characterPose.neck,
    }
  }

  const normalized = {
    keyframeId,
    id: keyframeId,
    name: String(frame.name || `关键帧 ${index + 1}`),
    timeMs,
    durationMs: Math.max(20, toInt(frame.durationMs, 500)),
    easing: String(frame.easing || EXPRESSION_EASING_LINEAR),
    positions: createPoseFromServos(configs, sourcePositions),
    keyedChannels,
    characterPose: characterPose.face
      ? normalizeCharacterPose(characterPose)
      : { face: undefined, neck: normalizeCharacterPose({ neck: characterPose.neck }).neck },
  }

  // 兼容字段：rigSnapshot = characterPose.face
  if (normalized.characterPose.face) {
    normalized.rigSnapshot = normalized.characterPose.face
  } else {
    normalized.rigSnapshot = undefined
  }
  return normalized
}

function finalizeV2Project(base, configs) {
  const rawKeyframes = Array.isArray(base.keyframes) ? base.keyframes : []
  let timelineDurationMs = Number(base.timelineDurationMs)
  let keyframes

  if (looksLikeV2Project(base)) {
    keyframes =
      rawKeyframes.length > 0
        ? rawKeyframes.map((frame, index) => normalizeKeyframe(frame, configs, index))
        : createDefaultFrameProject(configs).keyframes
    if (!Number.isFinite(timelineDurationMs) || timelineDurationMs < 0) {
      const maxT = Math.max(0, ...keyframes.map((k) => Number(k.timeMs) || 0))
      timelineDurationMs = Math.max(maxT, DEFAULT_TIMELINE_DURATION_MS)
    }
  } else {
    const migrated = migrateLegacyKeyframesToAbsoluteTime(rawKeyframes)
    keyframes =
      migrated.keyframes.length > 0
        ? migrated.keyframes.map((frame, index) => normalizeKeyframe(frame, configs, index))
        : createDefaultFrameProject(configs).keyframes
    timelineDurationMs = migrated.timelineDurationMs
  }

  keyframes = [...keyframes].sort((a, b) => a.timeMs - b.timeMs)
  const maxKeyTime = Math.max(0, ...keyframes.map((k) => Number(k.timeMs) || 0))
  timelineDurationMs = Math.max(timelineDurationMs, maxKeyTime)
  // 旧默认 1000ms → 新默认 5s（仅精确命中旧默认且关键未超出）
  if (timelineDurationMs === 1000 && maxKeyTime <= 1000) {
    timelineDurationMs = DEFAULT_TIMELINE_DURATION_MS
  }

  // 保证至少一枚 t=0 整脸 Key（新工程 / 空工程）
  if (keyframes.length === 0) {
    return createDefaultFrameProject(configs)
  }

  return {
    version: FRAME_PROJECT_VERSION,
    projectType: FRAME_PROJECT_TYPE,
    expressionId: String(base.expressionId || "expr_001"),
    // Preserve empty string while editing; only fall back when field is absent.
    expressionName:
      typeof base.expressionName === "string"
        ? base.expressionName
        : typeof base.name === "string"
          ? base.name
          : "未命名表情",
    timelineDurationMs,
    keyframes,
    modules: normalizeProjectModules(base.modules),
    updatedAt: String(base.updatedAt || new Date().toISOString()),
  }
}

export function normalizeFrameProject(project, configs = []) {
  if (!project || typeof project !== "object") {
    return createDefaultFrameProject(configs)
  }

  if (Array.isArray(project.actionGroups)) {
    const firstGroup = project.actionGroups[0]
    const frames = Array.isArray(firstGroup?.frames) ? firstGroup.frames : []
    return finalizeV2Project(
      {
        expressionName: firstGroup?.name || "未命名表情",
        keyframes: frames,
      },
      configs
    )
  }

  return finalizeV2Project(project, configs)
}

export function addKeyframe(project, keyframe, configs = []) {
  const normalized = normalizeFrameProject(project, configs)
  const nextKf = normalizeKeyframe(keyframe, configs, normalized.keyframes.length)
  const keyframes = [...normalized.keyframes, nextKf].sort((a, b) => a.timeMs - b.timeMs)
  const timelineDurationMs = Math.max(
    normalized.timelineDurationMs,
    ...keyframes.map((k) => Number(k.timeMs) || 0)
  )

  return {
    ...normalized,
    keyframes,
    timelineDurationMs,
    updatedAt: new Date().toISOString(),
  }
}

export function updateKeyframe(project, keyframeId, patch, configs = []) {
  const normalized = normalizeFrameProject(project, configs)

  return finalizeV2Project(
    {
      ...normalized,
      keyframes: normalized.keyframes.map((frame, index) => {
        if (frame.keyframeId !== keyframeId) return frame
        return normalizeKeyframe(
          {
            ...frame,
            ...patch,
            positions: patch.positions || frame.positions,
            keyedChannels: patch.keyedChannels || frame.keyedChannels,
            rigSnapshot:
              patch.rigSnapshot !== undefined ? patch.rigSnapshot : frame.rigSnapshot,
          },
          configs,
          index
        )
      }),
      updatedAt: new Date().toISOString(),
    },
    configs
  )
}

export function replaceKeyframes(project, keyframes, configs = []) {
  const normalized = normalizeFrameProject(project, configs)
  return finalizeV2Project(
    {
      ...normalized,
      keyframes,
      updatedAt: new Date().toISOString(),
    },
    configs
  )
}

export function deleteKeyframe(project, keyframeId, configs = []) {
  const normalized = normalizeFrameProject(project, configs)
  if (normalized.keyframes.length <= 1) return normalized

  return finalizeV2Project(
    {
      ...normalized,
      keyframes: normalized.keyframes.filter((frame) => frame.keyframeId !== keyframeId),
      updatedAt: new Date().toISOString(),
    },
    configs
  )
}

export function copyKeyframe(project, keyframeId, configs = []) {
  const normalized = normalizeFrameProject(project, configs)
  const index = normalized.keyframes.findIndex((frame) => frame.keyframeId === keyframeId)
  if (index < 0) return normalized

  const source = normalized.keyframes[index]
  const newKeyframe = normalizeKeyframe(
    {
      ...source,
      keyframeId: createId("kf"),
      id: undefined,
      name: `${source.name} 副本`,
      timeMs: source.timeMs,
      positions: { ...source.positions },
      keyedChannels: [...(source.keyedChannels || [])],
      rigSnapshot: source.rigSnapshot ? structuredClone(source.rigSnapshot) : undefined,
    },
    configs,
    index + 1
  )

  const nextFrames = [...normalized.keyframes]
  nextFrames.splice(index + 1, 0, newKeyframe)
  return replaceKeyframes(normalized, nextFrames, configs)
}

export function insertKeyframe(project, index, keyframe, configs = []) {
  const normalized = normalizeFrameProject(project, configs)
  const safeIndex = clampNumber(toInt(index, normalized.keyframes.length), 0, normalized.keyframes.length)
  const nextFrames = [...normalized.keyframes]
  nextFrames.splice(safeIndex, 0, normalizeKeyframe(keyframe, configs, safeIndex))
  return replaceKeyframes(normalized, nextFrames, configs)
}

export function moveKeyframe(project, fromIndex, toIndex, configs = []) {
  const normalized = normalizeFrameProject(project, configs)
  if (
    fromIndex < 0 ||
    fromIndex >= normalized.keyframes.length ||
    toIndex < 0 ||
    toIndex >= normalized.keyframes.length
  ) {
    return normalized
  }

  const nextFrames = [...normalized.keyframes]
  const [item] = nextFrames.splice(fromIndex, 1)
  nextFrames.splice(toIndex, 0, item)
  return replaceKeyframes(normalized, nextFrames, configs)
}

export function updateExpressionName(project, expressionName, configs = []) {
  const normalized = normalizeFrameProject(project, configs)

  return {
    ...normalized,
    // Allow clearing the input; do not auto-fill while the user deletes text.
    expressionName: expressionName == null ? "" : String(expressionName),
    updatedAt: new Date().toISOString(),
  }
}

export function loadFrameProject(configs = []) {
  const stored = readJsonStorage(FRAME_PROJECT_STORAGE_KEY, null)
  return normalizeFrameProject(stored, configs)
}

export function saveFrameProject(project, configs = []) {
  const normalized = normalizeFrameProject(project, configs)
  const payload = {
    ...normalized,
    savedAt: new Date().toISOString(),
  }
  writeJsonStorage(FRAME_PROJECT_STORAGE_KEY, payload)
  return payload
}

export function buildFrameProjectExport(project, servoConfigSnapshot = null, configs = []) {
  const normalized = normalizeFrameProject(project, configs)

  return {
    ...normalized,
    servoConfigSnapshot,
    exportedAt: new Date().toISOString(),
  }
}

export function listFullFaceKeyframes(project, configs = []) {
  const normalized = normalizeFrameProject(project, configs)
  return normalized.keyframes.filter((kf) => isFullFaceKeyed(kf.keyedChannels))
}
