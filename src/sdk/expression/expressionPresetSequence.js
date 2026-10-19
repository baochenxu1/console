export const SEQUENCE_ITEM_REPEAT_MIN = 1
export const SEQUENCE_ITEM_REPEAT_MAX = 99

function uid(prefix) {
  return `${prefix}_${Date.now().toString(16)}_${Math.random().toString(16).slice(2, 8)}`
}

export function clampSequenceItemRepeat(n) {
  const v = Math.round(Number(n))
  if (!Number.isFinite(v)) return 1
  return Math.min(SEQUENCE_ITEM_REPEAT_MAX, Math.max(SEQUENCE_ITEM_REPEAT_MIN, v))
}

export function createSequenceItem(presetId, repeatCount = 1) {
  const instanceId = uid("seq")
  return {
    id: instanceId,
    instanceId,
    presetId: String(presetId || ""),
    repeatCount: clampSequenceItemRepeat(repeatCount),
  }
}

export function addSequenceItem(items, presetId, repeatCount = 1) {
  return [...(Array.isArray(items) ? items : []), createSequenceItem(presetId, repeatCount)]
}

export function removeSequenceItem(items, itemId) {
  return (Array.isArray(items) ? items : []).filter(
    (it) => it.id !== itemId && it.instanceId !== itemId
  )
}

export function removeSequenceItemsByPresetId(items, presetId) {
  return (Array.isArray(items) ? items : []).filter((it) => it.presetId !== presetId)
}

export function moveSequenceItem(items, itemId, delta) {
  const list = [...(Array.isArray(items) ? items : [])]
  const idx = list.findIndex((it) => it.id === itemId || it.instanceId === itemId)
  if (idx < 0) return list
  const next = idx + Number(delta)
  if (next < 0 || next >= list.length) return list
  const [row] = list.splice(idx, 1)
  list.splice(next, 0, row)
  return list
}

export function setSequenceItemRepeat(items, itemId, repeatCount) {
  return (Array.isArray(items) ? items : []).map((it) =>
    it.id === itemId || it.instanceId === itemId
      ? { ...it, repeatCount: clampSequenceItemRepeat(repeatCount) }
      : it
  )
}

export function canMutateSequence(playbackState) {
  return playbackState === "IDLE" || playbackState === "ERROR"
}

export function estimateSequenceDurationMs(items, resolvePreset) {
  const list = Array.isArray(items) ? items : []
  let total = 0
  for (const it of list) {
    const preset = typeof resolvePreset === "function" ? resolvePreset(it.presetId) : null
    const dur = Math.max(0, Number(preset?.durationMs) || 0)
    total += dur * clampSequenceItemRepeat(it.repeatCount)
  }
  return total
}

/**
 * Immutable playback snapshot created at Play Sequence time.
 * Working Sequence edits after this must not mutate the returned object.
 */
export function createSequencePlaybackSnapshot({
  items = [],
  mode = "once",
  repeatCount = 1,
  resolvePreset,
} = {}) {
  const validation = validateSequenceForPlayback(items, resolvePreset)
  if (!validation.ok) {
    return { ok: false, ...validation }
  }
  const frozenItems = Object.freeze(
    validation.items.map((it) =>
      Object.freeze({
        instanceId: it.instanceId || it.id,
        presetId: it.presetId,
        repeatCount: clampSequenceItemRepeat(it.repeatCount),
      })
    )
  )
  const snapshot = Object.freeze({
    sequenceRunId: uid("run"),
    items: frozenItems,
    mode,
    repeatCount:
      mode === "repeat" ? Math.min(999, Math.max(1, Math.round(Number(repeatCount) || 1))) : 1,
  })
  return { ok: true, snapshot }
}

export function validateSequenceForPlayback(items, resolvePreset) {
  const list = Array.isArray(items) ? items : []
  if (list.length === 0) {
    return { ok: false, code: "EMPTY", message: "尚未添加播放项", problemIndex: -1 }
  }
  const normalized = []
  for (let i = 0; i < list.length; i += 1) {
    const it = list[i]
    if (!it?.presetId) {
      return {
        ok: false,
        code: "MISSING_PRESET",
        message: `第 ${i + 1} 项缺少预设引用。`,
        problemIndex: i,
      }
    }
    const preset = typeof resolvePreset === "function" ? resolvePreset(it.presetId) : null
    if (!preset) {
      return {
        ok: false,
        code: "PRESET_MISSING",
        message: `第 ${i + 1} 项预设不存在。`,
        problemIndex: i,
      }
    }
    const hasAsset =
      (preset.animation && Array.isArray(preset.animation.keyframes) && preset.animation.keyframes.length) ||
      (preset.clip && Array.isArray(preset.clip.keyframes) && preset.clip.keyframes.length)
    if (!hasAsset) {
      return {
        ok: false,
        code: "PRESET_INVALID",
        message: `第 ${i + 1} 项「${preset.name || it.presetId}」动画无效。`,
        problemIndex: i,
      }
    }
    if (!preset.closedClip) {
      return {
        ok: false,
        code: "OPEN_CLIP",
        message: `第 ${i + 1} 项「${preset.name || it.presetId}」为非闭环动作，不能加入序列播放。`,
        problemIndex: i,
      }
    }
    const repeatCount = clampSequenceItemRepeat(it.repeatCount)
    if (repeatCount < 1) {
      return {
        ok: false,
        code: "BAD_REPEAT",
        message: `第 ${i + 1} 项重复次数无效。`,
        problemIndex: i,
      }
    }
    normalized.push({
      id: it.id || it.instanceId,
      instanceId: it.instanceId || it.id,
      presetId: it.presetId,
      repeatCount,
    })
  }
  return { ok: true, items: normalized }
}
