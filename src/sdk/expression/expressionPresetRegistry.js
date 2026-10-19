/**
 * Product Preset registry: user library only (IndexedDB-backed cache).
 * Builtin demos remain available for tests via listBuiltinDemoPresets.
 */

import {
  EXPRESSION_PRESET_CATALOG,
  EXPRESSION_PRESET_GROUPS as BUILTIN_GROUPS,
} from "./expressionPresetCatalog.js"

export const EXPRESSION_PRESET_GROUPS = Object.freeze([
  { id: "all", label: "全部" },
  { id: "日常", label: "日常" },
  { id: "情绪", label: "情绪" },
  { id: "互动", label: "互动" },
  { id: "其它", label: "其它" },
])

/** @type {object[]} */
let userLibrary = []

export function setUserPresetLibrary(presets) {
  userLibrary = Array.isArray(presets) ? presets.slice() : []
  return userLibrary
}

export function getUserPresetLibrary() {
  return userLibrary
}

/** Product library — never includes BUILTIN_DEMO_CONTENT. */
export function listExpressionPresets() {
  return userLibrary
}

export function getExpressionPreset(id) {
  if (!id) return null
  return userLibrary.find((p) => p.id === id) || null
}

export function filterExpressionPresets(groupId = "all") {
  if (!groupId || groupId === "all") return userLibrary
  return userLibrary.filter((p) => p.group === groupId)
}

export function listBuiltinDemoPresets() {
  return EXPRESSION_PRESET_CATALOG
}

export function getBuiltinDemoPreset(id) {
  return EXPRESSION_PRESET_CATALOG.find((p) => p.id === id) || null
}

export function isClosedPlayablePreset(preset) {
  if (!preset?.closedClip) return false
  if (preset.animation && Array.isArray(preset.animation.keyframes)) return true
  if (preset.clip && Array.isArray(preset.clip.keyframes)) return true
  return false
}

export function canRepeatPreset(preset) {
  return isClosedPlayablePreset(preset)
}

export function canAddPresetToSequence(preset) {
  return isClosedPlayablePreset(preset)
}

export { BUILTIN_GROUPS }
