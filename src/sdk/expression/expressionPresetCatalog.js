import { applyFacePatch } from "./expressionPresetClip.js"
import {
  BUILTIN_PRESET_CONTENT_KIND,
  getBuiltinPresetClip,
} from "./expressionPresetBuiltinAssets.js"

export const EXPRESSION_PRESET_GROUPS = Object.freeze([
  { id: "all", label: "全部" },
  { id: "日常", label: "日常" },
  { id: "情绪", label: "情绪" },
  { id: "互动", label: "互动" },
])

/**
 * Catalog metadata only. Animation lives in expressionPresetBuiltinAssets.
 * clip is resolved from clipId at registration time for playback convenience.
 */
const PRESET_METADATA = Object.freeze([
  {
    id: "natural-smile",
    name: "自然微笑",
    group: "日常",
    description: "温和的友好表情",
    durationMs: 1200,
    tags: ["日常", "友好"],
    scope: "face",
    closedClip: true,
    supportsRepeat: true,
    thumbnail: "smile",
    clipId: "natural-smile",
  },
  {
    id: "happy-laugh",
    name: "开心大笑",
    group: "情绪",
    description: "张嘴笑，下颌略开",
    durationMs: 1800,
    tags: ["情绪", "开心"],
    scope: "face",
    closedClip: true,
    supportsRepeat: true,
    thumbnail: "laugh",
    clipId: "happy-laugh",
  },
  {
    id: "surprise",
    name: "惊讶",
    group: "情绪",
    description: "眉眼打开，下颌下落",
    durationMs: 1400,
    tags: ["情绪", "惊讶"],
    scope: "face",
    closedClip: true,
    supportsRepeat: true,
    thumbnail: "surprise",
    clipId: "surprise",
  },
  {
    id: "confused",
    name: "疑惑",
    group: "情绪",
    description: "不对称挑眉，可带轻微转头",
    durationMs: 1600,
    tags: ["情绪", "疑惑"],
    scope: "character",
    closedClip: true,
    supportsRepeat: true,
    thumbnail: "confused",
    clipId: "confused",
  },
  {
    id: "angry",
    name: "生气",
    group: "情绪",
    description: "皱眉、嘴角下压",
    durationMs: 1600,
    tags: ["情绪", "生气"],
    scope: "face",
    closedClip: true,
    supportsRepeat: true,
    thumbnail: "angry",
    clipId: "angry",
  },
  {
    id: "wink-hello",
    name: "眨眼招呼",
    group: "互动",
    description: "单侧眨眼致意",
    durationMs: 1000,
    tags: ["互动", "眨眼"],
    scope: "face",
    closedClip: true,
    supportsRepeat: true,
    thumbnail: "wink",
    clipId: "wink-hello",
  },
])

function hydratePreset(meta) {
  const clip = getBuiltinPresetClip(meta.clipId)
  if (!clip) {
    throw new Error(`Missing builtin preset clip for clipId=${meta.clipId}`)
  }
  return Object.freeze({
    ...meta,
    clip,
    contentKind: clip.contentKind || BUILTIN_PRESET_CONTENT_KIND,
    needsMotionTuning: Boolean(clip.needsMotionTuning),
  })
}

export const EXPRESSION_PRESET_CATALOG = Object.freeze(PRESET_METADATA.map(hydratePreset))

export function listBuiltinDemoPresets() {
  return EXPRESSION_PRESET_CATALOG
}

export function getBuiltinDemoPreset(id) {
  return EXPRESSION_PRESET_CATALOG.find((p) => p.id === id) || null
}

/** @deprecated Product library uses expressionPresetRegistry; kept for demo fixtures. */
export function listExpressionPresets() {
  return EXPRESSION_PRESET_CATALOG
}

/** @deprecated Product library uses expressionPresetRegistry. */
export function getExpressionPreset(id) {
  return getBuiltinDemoPreset(id)
}

export function filterExpressionPresets(groupId = "all") {
  if (!groupId || groupId === "all") {
    return EXPRESSION_PRESET_CATALOG
  }
  return EXPRESSION_PRESET_CATALOG.filter((p) => p.group === groupId)
}

export function isClosedBuiltinPreset(preset) {
  return Boolean(preset?.closedClip) && Array.isArray(preset?.clip?.keyframes)
}

/** Peak face for card thumbnail presentation only (not animation source). */
export function getPresetThumbnailFace(preset) {
  if (preset?.animation?.keyframes?.length) {
    const kfs = preset.animation.keyframes
    const mid = kfs[Math.max(0, Math.floor((kfs.length - 1) / 2))] || kfs[0]
    return mid?.characterPose?.face || mid?.rigSnapshot || applyFacePatch({})
  }
  const kfs = preset?.clip?.keyframes || []
  const mid = kfs[Math.max(0, Math.floor((kfs.length - 1) / 2))] || kfs[0]
  return applyFacePatch(mid?.face)
}
