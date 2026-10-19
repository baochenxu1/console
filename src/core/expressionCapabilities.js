/**
 * Expression Dope Sheet 能力开关（非正式用户设置）。
 * Phase 1.1：正式 UI 仅开放整脸关键帧编辑；独立 Channel 编辑预留。
 */

import { isFullFaceKeyed } from "./expressionTimelineChannels.js"

/** 为 true 时开放 Channel add / drag / delete / split / merge（未来 Advanced） */
export const EXPRESSION_CHANNEL_EDITING_ENABLED = false

/**
 * 当前正式模式下，该 Dope Sheet 标记是否允许横向拖动改 timeMs。
 * @param {{ rowKind: 'face'|'group'|'channel', channelId?: string|null, keyedChannels?: string[]|null }} args
 */
export function isExpressionKeyTimeEditable({ rowKind, channelId = null, keyedChannels = null } = {}) {
  if (EXPRESSION_CHANNEL_EDITING_ENABLED) {
    if (rowKind === "group") return false
    if (rowKind === "channel") return Boolean(channelId)
    if (rowKind === "face") return isFullFaceKeyed(keyedChannels)
    return false
  }

  // Phase 1.1：仅 Full-Face 行上的整脸 Key 可改时间
  if (rowKind !== "face" || channelId) return false
  return isFullFaceKeyed(keyedChannels)
}

/**
 * 是否允许在 Dope Sheet 上独立新增 / 删除 Channel Key。
 */
export function isExpressionChannelKeyMutationEnabled() {
  return EXPRESSION_CHANNEL_EDITING_ENABLED === true
}

/**
 * 工程是否包含非 ALL 的 partial keyedChannels（高级属性关键帧）。
 * @param {{ keyframes?: object[] }|null|undefined} project
 */
export function projectHasAdvancedChannelKeys(project) {
  const list = Array.isArray(project?.keyframes) ? project.keyframes : []
  return list.some((kf) => {
    const keyed = kf?.keyedChannels
    if (!Array.isArray(keyed) || keyed.length === 0) return false
    return !isFullFaceKeyed(keyed)
  })
}

/**
 * 点击子 Diamond 时解析应选中的 Full-Face / Event 索引。
 * @param {object[]} keyframes
 * @param {number} timeMs
 * @returns {number} index or -1
 */
export function resolveFullFaceSelectionIndex(keyframes, timeMs) {
  const list = Array.isArray(keyframes) ? keyframes : []
  const t = Math.round(Number(timeMs) || 0)
  const fullIdx = list.findIndex(
    (k) => Math.round(Number(k?.timeMs) || 0) === t && isFullFaceKeyed(k?.keyedChannels)
  )
  if (fullIdx >= 0) return fullIdx
  return list.findIndex((k) => Math.round(Number(k?.timeMs) || 0) === t)
}
