/**
 * Import FaceDEV 表情编排导出的 frameProject JSON → Preset draft / validated asset.
 * Reuses normalizeFrameProject migration; no second animation schema.
 */

import { createNeutralCharacterPose, normalizeCharacterPose } from "../../core/characterPose.js"
import {
  FRAME_PROJECT_TYPE,
  FRAME_PROJECT_VERSION,
  buildFrameProjectExport,
  normalizeFrameProject,
} from "../../core/frameProject.js"
import { sampleCharacterPoseAt } from "../../core/expressionTimelineSampler.js"
import { createNeutralNeckPose } from "../neck/neckPose.js"

export const PRESET_USER_GROUPS = Object.freeze(["日常", "情绪", "互动", "其它"])

export const PRESET_IMPORT_ERRORS = Object.freeze({
  PARSE: "PARSE",
  UNSUPPORTED_SCHEMA: "UNSUPPORTED_SCHEMA",
  NO_KEYFRAMES: "NO_KEYFRAMES",
  INVALID_DURATION: "INVALID_DURATION",
  INVALID_POSE: "INVALID_POSE",
})

const USER_MESSAGES = Object.freeze({
  [PRESET_IMPORT_ERRORS.PARSE]: "无法解析 JSON 文件。",
  [PRESET_IMPORT_ERRORS.UNSUPPORTED_SCHEMA]: "不是支持的 FaceDEV 表情工程文件。",
  [PRESET_IMPORT_ERRORS.NO_KEYFRAMES]: "文件中没有有效关键帧。",
  [PRESET_IMPORT_ERRORS.INVALID_DURATION]: "表情动画时长无效。",
  [PRESET_IMPORT_ERRORS.INVALID_POSE]: "表情动画数据不完整。",
})

export function userMessageForImportError(code) {
  return USER_MESSAGES[code] || "表情动画数据不完整。"
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v)
}

function posesEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function isCharacterPoseNeutral(pose) {
  const n = createNeutralCharacterPose()
  const p = normalizeCharacterPose(pose)
  return posesEqual(p.face, n.face) && posesEqual(p.neck, n.neck)
}

export function derivePresetDurationMs(project) {
  const kfs = Array.isArray(project?.keyframes) ? project.keyframes : []
  const lastT = kfs.reduce((m, kf) => Math.max(m, Math.round(Number(kf?.timeMs) || 0)), 0)
  const timeline = Math.round(Number(project?.timelineDurationMs) || 0)
  return Math.max(lastT, timeline, 0)
}

export function detectPresetScope(project) {
  const kfs = Array.isArray(project?.keyframes) ? project.keyframes : []
  const neutralNeck = createNeutralNeckPose()
  for (const kf of kfs) {
    const pose = normalizeCharacterPose(kf?.characterPose || { face: kf?.rigSnapshot, neck: kf?.neck })
    if (!posesEqual(pose.neck, neutralNeck)) {
      return "character"
    }
  }
  return "face"
}

export function detectClosedClip(project) {
  const kfs = Array.isArray(project?.keyframes) ? project.keyframes : []
  if (kfs.length < 1) return false
  const duration = derivePresetDurationMs(project)
  if (duration <= 0 && kfs.length < 2) return false
  try {
    const first = sampleCharacterPoseAt(project, 0)
    const lastT = Math.max(duration, ...kfs.map((k) => Math.round(Number(k.timeMs) || 0)))
    const last = sampleCharacterPoseAt(project, lastT)
    return isCharacterPoseNeutral(first) && isCharacterPoseNeutral(last)
  } catch {
    return false
  }
}

export function looksLikeFrameProject(raw) {
  if (!isPlainObject(raw)) return false
  if (Array.isArray(raw.keyframes)) return true
  if (Array.isArray(raw.actionGroups)) return true
  if (raw.projectType === FRAME_PROJECT_TYPE) return true
  if (raw.version || raw.expressionName || raw.expressionId) return true
  // FaceDEV preset wrapper
  if (isPlainObject(raw.animation) && Array.isArray(raw.animation.keyframes)) return true
  return false
}

export function unwrapImportPayload(raw) {
  if (isPlainObject(raw?.animation) && Array.isArray(raw.animation.keyframes)) {
    return {
      projectRaw: raw.animation,
      suggestedName: raw.name || raw.animation.expressionName || "",
      suggestedGroup: PRESET_USER_GROUPS.includes(raw.group) ? raw.group : "",
      description: typeof raw.description === "string" ? raw.description : "",
      tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    }
  }
  return {
    projectRaw: raw,
    suggestedName: "",
    suggestedGroup: "",
    description: "",
    tags: [],
  }
}

/**
 * @returns {{ ok: true, draft: object } | { ok: false, code: string, message: string, detail?: string }}
 */
export function parseAndValidateExpressionImport(rawOrText, options = {}) {
  const configs = Array.isArray(options.configs) ? options.configs : []
  const fileName = String(options.fileName || "").trim()

  let raw = rawOrText
  if (typeof rawOrText === "string") {
    try {
      raw = JSON.parse(rawOrText)
    } catch (err) {
      return {
        ok: false,
        code: PRESET_IMPORT_ERRORS.PARSE,
        message: userMessageForImportError(PRESET_IMPORT_ERRORS.PARSE),
        detail: err?.message || String(err),
      }
    }
  }

  if (!looksLikeFrameProject(raw)) {
    return {
      ok: false,
      code: PRESET_IMPORT_ERRORS.UNSUPPORTED_SCHEMA,
      message: userMessageForImportError(PRESET_IMPORT_ERRORS.UNSUPPORTED_SCHEMA),
    }
  }

  const unwrapped = unwrapImportPayload(raw)
  let project
  try {
    project = normalizeFrameProject(unwrapped.projectRaw, configs)
  } catch (err) {
    return {
      ok: false,
      code: PRESET_IMPORT_ERRORS.UNSUPPORTED_SCHEMA,
      message: userMessageForImportError(PRESET_IMPORT_ERRORS.UNSUPPORTED_SCHEMA),
      detail: err?.message || String(err),
    }
  }

  const keyframes = Array.isArray(project.keyframes) ? project.keyframes : []
  if (keyframes.length === 0) {
    return {
      ok: false,
      code: PRESET_IMPORT_ERRORS.NO_KEYFRAMES,
      message: userMessageForImportError(PRESET_IMPORT_ERRORS.NO_KEYFRAMES),
    }
  }

  const durationMs = derivePresetDurationMs(project)
  if (!(durationMs > 0) && keyframes.length < 2) {
    // single keyframe at t=0 is valid duration 0 visually but treat as at least hold
  }
  const effectiveDuration = Math.max(durationMs, keyframes.length > 1 ? durationMs : Math.max(durationMs, 1))

  let closedClip = false
  try {
    closedClip = detectClosedClip(project)
  } catch (err) {
    return {
      ok: false,
      code: PRESET_IMPORT_ERRORS.INVALID_POSE,
      message: userMessageForImportError(PRESET_IMPORT_ERRORS.INVALID_POSE),
      detail: err?.message || String(err),
    }
  }

  const scope = detectPresetScope(project)
  const hasNeck = scope === "character"
  const fromFile = fileName.replace(/\.json$/i, "").trim()
  const name =
    String(unwrapped.suggestedName || project.expressionName || project.name || fromFile || "").trim() ||
    "未命名表情"
  const group = unwrapped.suggestedGroup || "其它"

  const draft = {
    name,
    group,
    description: unwrapped.description || "",
    tags: unwrapped.tags,
    durationMs: effectiveDuration,
    keyframeCount: keyframes.length,
    scope,
    hasFace: true,
    hasNeck,
    closedClip,
    validationStatus: closedClip ? "ok" : "open_clip",
    supportsRepeat: closedClip,
    supportsSequence: closedClip,
    animation: project,
    version: project.version || FRAME_PROJECT_VERSION,
    projectType: project.projectType || FRAME_PROJECT_TYPE,
  }

  return { ok: true, draft }
}

export function createUserPresetFromDraft(draft, options = {}) {
  const now = new Date().toISOString()
  const id =
    String(options.id || "").trim() ||
    `user_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const group = PRESET_USER_GROUPS.includes(draft.group) ? draft.group : "其它"
  return {
    id,
    name: String(draft.name || "未命名表情").trim() || "未命名表情",
    group,
    description: String(draft.description || ""),
    tags: Array.isArray(draft.tags) ? draft.tags.map(String) : [],
    source: "user",
    createdAt: options.createdAt || now,
    updatedAt: now,
    durationMs: Math.max(1, Math.round(Number(draft.durationMs) || 1)),
    scope: draft.scope === "character" ? "character" : "face",
    closedClip: Boolean(draft.closedClip),
    validationStatus: draft.closedClip ? "ok" : "open_clip",
    supportsRepeat: Boolean(draft.closedClip),
    supportsSequence: Boolean(draft.closedClip),
    keyframeCount: Math.max(0, Math.round(Number(draft.keyframeCount) || 0)),
    hasFace: true,
    hasNeck: Boolean(draft.hasNeck),
    thumbnail: "user",
    animation: draft.animation,
  }
}

export function buildPresetExportPayload(preset, configs = []) {
  const animation = normalizeFrameProject(
    {
      ...(preset.animation || {}),
      expressionId: preset.id,
      expressionName: preset.name,
    },
    configs
  )
  const projectExport = buildFrameProjectExport(animation, null, configs)
  return {
    faceDevPresetVersion: 1,
    id: preset.id,
    name: preset.name,
    group: preset.group,
    description: preset.description || "",
    tags: preset.tags || [],
    source: "user",
    durationMs: preset.durationMs,
    scope: preset.scope,
    closedClip: Boolean(preset.closedClip),
    animation: projectExport,
  }
}

/** Mid-clip representative CharacterPose (face + neck) for IDLE preview. */
export function samplePresetRepresentativeCharacterPose(preset) {
  const neutral = createNeutralCharacterPose()
  const project = preset?.animation
  if (!project?.keyframes?.length) {
    return neutral
  }
  const dur = Math.max(1, Number(preset.durationMs) || derivePresetDurationMs(project) || 1)
  try {
    return normalizeCharacterPose(sampleCharacterPoseAt(project, dur * 0.5))
  } catch {
    return neutral
  }
}

export function samplePresetRepresentativeFace(preset) {
  return samplePresetRepresentativeCharacterPose(preset).face
}
