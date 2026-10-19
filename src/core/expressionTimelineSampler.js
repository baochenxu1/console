/**
 * 表情编排 Timeline Sampler（纯函数）。
 * Phase 1：per-channel sampling；时间权威 = keyframe.timeMs + project.timelineDurationMs。
 */

import {
  createInitialEliteRig,
  normalizeEliteRig,
  setEliteRigControlRaw,
} from "./faceDofMapper.js"
import { applyEasing, EXPRESSION_EASING_LINEAR } from "./expressionEasing.js"
import {
  getAllTimelineChannelIds,
  getChannelValueFromRig,
  getChannelValueFromCharacterPose,
  isNeckChannelId,
  parseTimelineChannelId,
} from "./expressionTimelineChannels.js"
import { characterPoseFromFaceRig, normalizeCharacterPose } from "./characterPose.js"
import { createNeutralNeckPose, normalizeNeckPose } from "../sdk/neck/neckPose.js"

function clampNumber(n, lo, hi) {
  const v = Number(n)
  if (!Number.isFinite(v)) return lo
  return Math.max(lo, Math.min(hi, v))
}

function hasRigSnapshot(keyframe) {
  return Boolean(
    (keyframe?.rigSnapshot && typeof keyframe.rigSnapshot === "object") ||
      (keyframe?.characterPose?.face && typeof keyframe.characterPose.face === "object")
  )
}

function resolveKeyframeFace(keyframe) {
  if (keyframe?.characterPose?.face) return normalizeEliteRig(keyframe.characterPose.face)
  if (keyframe?.rigSnapshot) return normalizeEliteRig(keyframe.rigSnapshot)
  return null
}

function resolveKeyframeCharacterPose(keyframe) {
  if (keyframe?.characterPose && typeof keyframe.characterPose === "object") {
    if (keyframe.characterPose.face) return normalizeCharacterPose(keyframe.characterPose)
    return {
      face: resolveKeyframeFace(keyframe) || createInitialEliteRig(),
      neck: normalizeNeckPose(keyframe.characterPose.neck),
    }
  }
  if (keyframe?.rigSnapshot) return characterPoseFromFaceRig(keyframe.rigSnapshot)
  return null
}

function getKeyframeChannelValue(keyframe, channelId) {
  if (isNeckChannelId(channelId)) {
    const pose = resolveKeyframeCharacterPose(keyframe)
    return getChannelValueFromCharacterPose(pose, channelId)
  }
  const face = resolveKeyframeFace(keyframe)
  return face ? getChannelValueFromRig(face, channelId) : null
}

function structuredCloneSafe(value) {
  if (value == null || typeof value !== "object") return value
  try {
    return structuredClone(value)
  } catch {
    return value
  }
}

/**
 * 对 Elite Rig 连续数值自由度做线性插值（整树工具，测试 / 兼容仍可用）。
 */
export function interpolateRigSnapshot(fromSnapshot, toSnapshot, progress) {
  const t = clampNumber(progress, 0, 1)
  const from = normalizeEliteRig(fromSnapshot)
  const to = normalizeEliteRig(toSnapshot)
  return lerpNumericTree(from, to, t)
}

function lerpNumericTree(from, to, t) {
  if (typeof from === "number" && typeof to === "number") {
    return from + (to - from) * t
  }

  if (
    from &&
    to &&
    typeof from === "object" &&
    typeof to === "object" &&
    !Array.isArray(from) &&
    !Array.isArray(to)
  ) {
    const out = {}
    const keys = new Set([...Object.keys(from), ...Object.keys(to)])
    for (const key of keys) {
      const a = from[key]
      const b = to[key]
      if (typeof a === "number" && typeof b === "number") {
        out[key] = a + (b - a) * t
      } else if (
        a &&
        b &&
        typeof a === "object" &&
        typeof b === "object" &&
        !Array.isArray(a) &&
        !Array.isArray(b)
      ) {
        out[key] = lerpNumericTree(a, b, t)
      } else if (b !== undefined) {
        out[key] = t >= 0.5 ? structuredCloneSafe(b) : structuredCloneSafe(a)
      } else {
        out[key] = structuredCloneSafe(a)
      }
    }
    return out
  }

  return t >= 0.5 ? structuredCloneSafe(to) : structuredCloneSafe(from)
}

function extractKeyframesList(frameProjectOrKeyframes) {
  if (Array.isArray(frameProjectOrKeyframes)) {
    return { keyframes: frameProjectOrKeyframes, timelineDurationMs: null, project: null }
  }
  const keyframes = Array.isArray(frameProjectOrKeyframes?.keyframes)
    ? frameProjectOrKeyframes.keyframes
    : []
  const timelineDurationMs = Number.isFinite(Number(frameProjectOrKeyframes?.timelineDurationMs))
    ? Math.max(0, Number(frameProjectOrKeyframes.timelineDurationMs))
    : null
  return { keyframes, timelineDurationMs, project: frameProjectOrKeyframes }
}

function resolveAbsoluteTime(keyframe, index, previousTimeMs) {
  if (Number.isFinite(Number(keyframe?.timeMs))) {
    return Math.max(0, Math.round(Number(keyframe.timeMs)))
  }
  // legacy fallback：按 duration 链累计（仅未迁移数据）
  return previousTimeMs
}

/**
 * @param {object|object[]} frameProjectOrKeyframes
 * @param {{ timelineDurationMs?: number }} [options]
 */
export function buildExpressionTimeline(frameProjectOrKeyframes, options = {}) {
  const { keyframes: list, timelineDurationMs: projectDuration } =
    extractKeyframesList(frameProjectOrKeyframes)

  const keyframes = []
  let cursor = 0
  let legacySum = 0
  let usedLegacy = false

  const sorted = [...list].sort((a, b) => {
    const ta = Number.isFinite(Number(a?.timeMs)) ? Number(a.timeMs) : Infinity
    const tb = Number.isFinite(Number(b?.timeMs)) ? Number(b.timeMs) : Infinity
    if (ta !== tb) return ta - tb
    return 0
  })

  for (let i = 0; i < sorted.length; i += 1) {
    const keyframe = sorted[i] || {}
    let timeMs
    if (Number.isFinite(Number(keyframe.timeMs))) {
      timeMs = Math.max(0, Math.round(Number(keyframe.timeMs)))
    } else {
      usedLegacy = true
      timeMs = cursor
      const durationMs = Math.max(0, Number(keyframe.durationMs) || 0)
      cursor += durationMs
      legacySum += durationMs
    }
    keyframes.push({
      index: i,
      timeMs,
      durationMs: Math.max(0, Number(keyframe.durationMs) || 0),
      easing: String(keyframe.easing || EXPRESSION_EASING_LINEAR),
      keyframe,
      keyedChannels: Array.isArray(keyframe.keyedChannels)
        ? keyframe.keyedChannels.map(String)
        : null,
    })
  }

  const maxKeyTime = keyframes.length ? Math.max(...keyframes.map((k) => k.timeMs)) : 0
  let totalDurationMs =
    options.timelineDurationMs != null && Number.isFinite(Number(options.timelineDurationMs))
      ? Math.max(0, Number(options.timelineDurationMs))
      : projectDuration != null
        ? projectDuration
        : usedLegacy
          ? legacySum
          : maxKeyTime

  totalDurationMs = Math.max(totalDurationMs, maxKeyTime)

  return {
    keyframes,
    totalDurationMs,
    keyframeCount: keyframes.length,
  }
}

/**
 * 解析「全部 / 区间」播放窗口（绝对时间）。
 * 全量播放：第一关键帧 → 最后一帧（不播 timeline 尾部 Hold 空段）。
 */
export function resolveExpressionPlaybackWindow(timeline, startIndex = 0, endIndex = null) {
  const count = timeline?.keyframeCount || 0
  const total = Math.max(0, Number(timeline?.totalDurationMs) || 0)
  const entries = timeline?.keyframes || []

  if (count <= 0) {
    return { startTimeMs: 0, endTimeMs: total, windowDurationMs: total }
  }

  const firstTime = Math.max(0, Math.round(Number(entries[0]?.timeMs) || 0))
  const lastTime = Math.max(0, Math.round(Number(entries[count - 1]?.timeMs) || 0))

  // 全选 / 默认：第一关键 → 最后一帧，到点自动结束（暂停在末帧）
  if (startIndex <= 0 && (endIndex == null || endIndex >= count - 1)) {
    const startTimeMs = firstTime
    const endTimeMs = Math.max(startTimeMs, lastTime)
    return {
      startTimeMs,
      endTimeMs,
      windowDurationMs: endTimeMs - startTimeMs,
    }
  }

  const safeStart = Math.max(0, Math.min(startIndex, count - 1))
  const safeEnd =
    endIndex == null ? count - 1 : Math.max(safeStart, Math.min(endIndex, count - 1))

  const startTimeMs = Math.max(0, Math.round(Number(entries[safeStart]?.timeMs) || 0))
  let endTimeMs =
    safeEnd >= count - 1
      ? Math.max(startTimeMs, lastTime)
      : Math.max(0, Math.round(Number(entries[Math.min(safeEnd + 1, count - 1)]?.timeMs) || 0))

  if (safeStart === safeEnd) {
    // 单事件窗口：到下一事件；若无下一事件则停在本帧（零长度）
    const next = entries[safeStart + 1]
    endTimeMs = next
      ? Math.max(0, Math.round(Number(next.timeMs) || 0))
      : startTimeMs
  }

  if (endTimeMs < startTimeMs) {
    endTimeMs = startTimeMs
  }

  return {
    startTimeMs,
    endTimeMs,
    windowDurationMs: endTimeMs - startTimeMs,
  }
}

function eventKeysChannel(entry, channelId) {
  const keyed = entry.keyedChannels
  if (!keyed) {
    // 旧整脸语义：无 keyedChannels 视为 ALL
    return true
  }
  return keyed.includes(channelId)
}

function findChannelKeys(entries, channelId) {
  return entries.filter((e) => eventKeysChannel(e, channelId) && hasRigSnapshot(e.keyframe))
}

function sampleChannelValue(channelEntries, channelId, timelineTimeMs) {
  if (channelEntries.length === 0) {
    return { value: null, rawProgress: 0, easedProgress: 0, easing: EXPRESSION_EASING_LINEAR, hold: true }
  }

  let prev = null
  let next = null
  for (const entry of channelEntries) {
    if (entry.timeMs <= timelineTimeMs) prev = entry
    if (entry.timeMs > timelineTimeMs && !next) next = entry
  }

  if (!prev && next) {
    const v = getKeyframeChannelValue(next.keyframe, channelId)
    return { value: v, rawProgress: 0, easedProgress: 0, easing: next.easing, hold: true }
  }

  if (prev && !next) {
    const v = getKeyframeChannelValue(prev.keyframe, channelId)
    return {
      value: v,
      rawProgress: 1,
      easedProgress: 1,
      easing: prev.easing,
      hold: true,
      prev,
      next: null,
    }
  }

  if (prev && next) {
    const span = Math.max(0, next.timeMs - prev.timeMs)
    const rawProgress = span <= 0 ? 1 : clampNumber((timelineTimeMs - prev.timeMs) / span, 0, 1)
    const easing = prev.easing || EXPRESSION_EASING_LINEAR
    const easedProgress = applyEasing(rawProgress, easing)
    const a = getKeyframeChannelValue(prev.keyframe, channelId)
    const b = getKeyframeChannelValue(next.keyframe, channelId)
    if (a == null || b == null) {
      return { value: a ?? b, rawProgress, easedProgress, easing, hold: true, prev, next }
    }
    const value = a + (b - a) * easedProgress
    return { value, rawProgress, easedProgress, easing, hold: false, prev, next }
  }

  return { value: null, rawProgress: 0, easedProgress: 0, easing: EXPRESSION_EASING_LINEAR, hold: true }
}

function nearestPriorFullSnapshot(entries, timelineTimeMs) {
  let best = null
  for (const entry of entries) {
    if (entry.timeMs <= timelineTimeMs && hasRigSnapshot(entry.keyframe)) {
      best = resolveKeyframeFace(entry.keyframe)
    }
  }
  if (best) return normalizeEliteRig(best)
  for (const entry of entries) {
    if (hasRigSnapshot(entry.keyframe)) {
      const face = resolveKeyframeFace(entry.keyframe)
      if (face) return normalizeEliteRig(face)
    }
  }
  return createInitialEliteRig()
}

function nearestPriorNeck(entries, timelineTimeMs) {
  let best = createNeutralNeckPose()
  for (const entry of entries) {
    if (entry.timeMs <= timelineTimeMs) {
      const pose = resolveKeyframeCharacterPose(entry.keyframe)
      if (pose?.neck) best = normalizeNeckPose(pose.neck)
    }
  }
  return best
}

/**
 * 正式：在绝对时间 t 采样一次 CharacterPose（Face + Neck 共用同一 clock）。
 * 禁止对 Face / Neck 使用不同 Timeline 时钟。
 */
export function sampleCharacterPoseAt(frameProjectOrKeyframes, timeMs, options = {}) {
  const sample = sampleExpressionTimeline(frameProjectOrKeyframes, timeMs, options)
  return {
    ...sample,
    characterPose: sample.characterPose || null,
    face: sample.characterPose?.face || sample.rigSnapshot || null,
    neck: sample.characterPose?.neck || null,
  }
}

/**
 * @param {object|object[]} frameProjectOrKeyframes
 * @param {number} timeMs
 * @param {{ timelineDurationMs?: number }} [options]
 */
export function sampleExpressionTimeline(frameProjectOrKeyframes, timeMs, options = {}) {
  const timeline = buildExpressionTimeline(frameProjectOrKeyframes, options)
  const totalDurationMs = timeline.totalDurationMs
  const entries = timeline.keyframes

  if (entries.length === 0) {
    return {
      timelineTimeMs: 0,
      totalDurationMs: 0,
      fromKeyframeIndex: -1,
      toKeyframeIndex: -1,
      segmentStartMs: 0,
      segmentDurationMs: 0,
      rawProgress: 0,
      easedProgress: 0,
      easing: EXPRESSION_EASING_LINEAR,
      rigSnapshot: null,
      legacyFallback: true,
      fromKeyframe: null,
      toKeyframe: null,
      holdKeyframe: null,
      perChannel: true,
    }
  }

  const timelineTimeMs = clampNumber(timeMs, 0, Math.max(0, totalDurationMs))

  // 若任一事件缺少 rigSnapshot → legacy positions hold（不伪造准确 snapshot）
  const anyLegacy = entries.some((e) => !hasRigSnapshot(e.keyframe))
  if (anyLegacy) {
    return sampleLegacyHold(entries, timelineTimeMs, totalDurationMs)
  }

  const channelIds = getAllTimelineChannelIds()
  let baseRig = nearestPriorFullSnapshot(entries, timelineTimeMs)
  let neck = nearestPriorNeck(entries, timelineTimeMs)

  /** @type {Record<string, ReturnType<typeof sampleChannelValue>>} */
  const channelSamples = {}
  let reportPrev = entries[0]
  let reportNext = entries[Math.min(1, entries.length - 1)]
  let reportRaw = 0
  let reportEased = 0
  let reportEasing = EXPRESSION_EASING_LINEAR

  for (const channelId of channelIds) {
    const channelEntries = findChannelKeys(entries, channelId)
    const sample = sampleChannelValue(channelEntries, channelId, timelineTimeMs)
    channelSamples[channelId] = sample
    if (sample.value != null) {
      if (isNeckChannelId(channelId)) {
        const axis = parseTimelineChannelId(channelId)?.channel
        if (axis) neck = { ...neck, [axis]: sample.value }
      } else {
        const parsed = parseTimelineChannelId(channelId)
        if (parsed) {
          baseRig = setEliteRigControlRaw(baseRig, parsed.controlId, parsed.channel, sample.value)
        }
      }
    }
    if (sample.prev && sample.next && !sample.hold) {
      reportPrev = sample.prev
      reportNext = sample.next
      reportRaw = sample.rawProgress
      reportEased = sample.easedProgress
      reportEasing = sample.easing
    }
  }

  const rigSnapshot = normalizeEliteRig(baseRig)
  const characterPose = normalizeCharacterPose({ face: rigSnapshot, neck })

  return {
    timelineTimeMs,
    totalDurationMs,
    fromKeyframeIndex: reportPrev?.index ?? 0,
    toKeyframeIndex: reportNext?.index ?? reportPrev?.index ?? 0,
    segmentStartMs: reportPrev?.timeMs ?? 0,
    segmentDurationMs: Math.max(0, (reportNext?.timeMs ?? reportPrev?.timeMs ?? 0) - (reportPrev?.timeMs ?? 0)),
    rawProgress: reportRaw,
    easedProgress: reportEased,
    easing: reportEasing,
    rigSnapshot,
    characterPose,
    legacyFallback: false,
    fromKeyframe: reportPrev?.keyframe ?? null,
    toKeyframe: reportNext?.keyframe ?? reportPrev?.keyframe ?? null,
    holdKeyframe: null,
    perChannel: true,
    channelSamples,
  }
}

function sampleLegacyHold(entries, timelineTimeMs, totalDurationMs) {
  let fromEntry = entries[0]
  for (let i = 0; i < entries.length - 1; i += 1) {
    const cur = entries[i]
    const next = entries[i + 1]
    if (timelineTimeMs >= cur.timeMs && timelineTimeMs < next.timeMs) {
      fromEntry = cur
      break
    }
  }
  const last = entries[entries.length - 1]
  if (timelineTimeMs >= last.timeMs) {
    fromEntry = last
  }
  const toEntry = entries[Math.min(fromEntry.index + 1, entries.length - 1)]
  const segmentDurationMs = Math.max(0, toEntry.timeMs - fromEntry.timeMs)
  const rawProgress =
    fromEntry === toEntry || segmentDurationMs <= 0
      ? 1
      : clampNumber((timelineTimeMs - fromEntry.timeMs) / segmentDurationMs, 0, 1)

  const holdKeyframe = rawProgress < 1 ? fromEntry.keyframe : toEntry.keyframe
  return {
    timelineTimeMs,
    totalDurationMs,
    fromKeyframeIndex: fromEntry.index,
    toKeyframeIndex: toEntry.index,
    segmentStartMs: fromEntry.timeMs,
    segmentDurationMs,
    rawProgress,
    easedProgress: rawProgress,
    easing: fromEntry.easing,
    rigSnapshot: hasRigSnapshot(holdKeyframe) ? normalizeEliteRig(holdKeyframe.rigSnapshot) : null,
    legacyFallback: true,
    fromKeyframe: fromEntry.keyframe,
    toKeyframe: toEntry.keyframe,
    holdKeyframe,
    perChannel: false,
  }
}

/**
 * 由采样结果构造可交给 dispatchKeyframeToHardware 的瞬时关键帧。
 */
export function buildTransientKeyframeFromSample(sample, opts = {}) {
  const moveTimeMs = Math.max(20, Number(opts.moveTimeMs) || 20)
  const hold = sample?.holdKeyframe
  const from = sample?.fromKeyframe
  const to = sample?.toKeyframe

  if (sample?.legacyFallback) {
    const src = hold || (sample.rawProgress < 1 ? from : to) || from || to
    return {
      keyframeId: `timeline_legacy_${sample.timelineTimeMs}`,
      name: src?.name || "timeline-legacy",
      durationMs: moveTimeMs,
      timeMs: Math.round(sample?.timelineTimeMs || 0),
      easing: sample.easing || EXPRESSION_EASING_LINEAR,
      positions: { ...(src?.positions || {}) },
      ...(hasRigSnapshot(src) ? { rigSnapshot: structuredCloneSafe(src.rigSnapshot) } : {}),
      transient: true,
      legacyFallback: true,
    }
  }

  return {
    keyframeId: `timeline_${Math.round(sample?.timelineTimeMs || 0)}`,
    name: "timeline-sample",
    durationMs: moveTimeMs,
    timeMs: Math.round(sample?.timelineTimeMs || 0),
    easing: sample?.easing || EXPRESSION_EASING_LINEAR,
    positions: {},
    rigSnapshot: sample?.rigSnapshot ? structuredCloneSafe(sample.rigSnapshot) : normalizeEliteRig(null),
    transient: true,
    legacyFallback: false,
  }
}
