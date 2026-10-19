/**
 * Expression Keyframe Editing API（纯函数）。
 * Sparse Full-Snapshot：每个事件始终带完整 rigSnapshot；keyedChannels 仅标记动画 Key。
 */

import { createPoseFromServos } from "./frameProject.js"
import {
  ALL_TIMELINE_CHANNELS,
  getAllTimelineChannelIds,
  getChannelValueFromRig,
  isFullFaceKeyed,
  setChannelValueOnRig,
} from "./expressionTimelineChannels.js"
import { createInitialEliteRig, normalizeEliteRig } from "./faceDofMapper.js"
import { sampleExpressionTimeline } from "./expressionTimelineSampler.js"
import { EXPRESSION_EASING_LINEAR } from "./expressionEasing.js"
import { toInt } from "../utils/clamp.js"
import { normalizeCharacterPose } from "./characterPose.js"
import { createNeutralNeckPose, normalizeNeckPose } from "../sdk/neck/neckPose.js"

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
}

function cloneRig(rig) {
  return normalizeEliteRig(rig && typeof rig === "object" ? structuredClone(rig) : createInitialEliteRig())
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

function sortEvents(keyframes) {
  return [...(keyframes || [])].sort((a, b) => (Number(a.timeMs) || 0) - (Number(b.timeMs) || 0))
}

function touchProject(project, keyframes) {
  return {
    ...project,
    keyframes: sortEvents(keyframes),
    updatedAt: new Date().toISOString(),
  }
}

function findEventIndexAtTime(keyframes, timeMs, toleranceMs = 0) {
  const t = Math.round(Number(timeMs) || 0)
  const tol = Math.max(0, Number(toleranceMs) || 0)
  return keyframes.findIndex((kf) => Math.abs((Number(kf.timeMs) || 0) - t) <= tol)
}

function makeEvent({
  timeMs,
  name,
  rigSnapshot,
  characterPose,
  neck,
  positions,
  keyedChannels,
  easing = EXPRESSION_EASING_LINEAR,
  configs = [],
  keyframeId,
} = {}) {
  const id = keyframeId || createId("kf")
  // Face：显式 rigSnapshot 优先（Channel merge 路径）；否则 characterPose.face
  // Neck：显式 neck 优先，否则保留 characterPose.neck
  const pose = normalizeCharacterPose({
    face: rigSnapshot ?? characterPose?.face,
    neck: neck ?? characterPose?.neck ?? createNeutralNeckPose(),
  })
  return {
    keyframeId: id,
    id,
    name: name || "关键帧",
    timeMs: Math.max(0, Math.round(Number(timeMs) || 0)),
    easing: String(easing || EXPRESSION_EASING_LINEAR),
    positions: createPoseFromServos(configs, positions || {}),
    characterPose: pose,
    rigSnapshot: cloneRig(pose.face),
    keyedChannels: uniqChannels(keyedChannels),
  }
}

/**
 * 合并时：已 keyed 的通道值必须保留；新通道从 currentRig 写入；其余用 baseRig 上下文。
 */
function mergeRigPreservingKeyed(baseRig, currentRig, existingKeyed, incomingKeyed) {
  let rig = cloneRig(baseRig)
  const existing = new Set(existingKeyed || [])
  const incoming = uniqChannels(incomingKeyed)

  for (const ch of existing) {
    const v = getChannelValueFromRig(baseRig, ch)
    if (v != null) rig = setChannelValueOnRig(rig, ch, v)
  }
  for (const ch of incoming) {
    if (existing.has(ch)) continue
    const v = getChannelValueFromRig(currentRig, ch)
    if (v != null) rig = setChannelValueOnRig(rig, ch, v)
  }
  return normalizeEliteRig(rig)
}

function ensureTimelineDuration(project, timeMs) {
  const dur = Math.max(0, Number(project?.timelineDurationMs) || 0)
  const t = Math.max(0, Math.round(Number(timeMs) || 0))
  if (t > dur) {
    return { ...project, timelineDurationMs: t }
  }
  return project
}

/**
 * 在 playhead 添加 Full Character Key（Face + optional Neck，keyedChannels = ALL）。
 * opts.neck / opts.characterPose.neck 写入当前 Neck；缺省 Neutral 或保留已有。
 * opts.writeNeck === false → Face only（保留已有 Neck，不覆盖）。
 */
export function addFullFaceKeyAtTime(project, timeMs, currentRig, positions = {}, configs = [], opts = {}) {
  const t = Math.max(0, Math.round(Number(timeMs) || 0))
  let next = ensureTimelineDuration({ ...project }, t)
  const keyframes = [...(next.keyframes || [])]
  const idx = findEventIndexAtTime(keyframes, t, opts.toleranceMs ?? 0)
  const all = getAllTimelineChannelIds()
  const rig = cloneRig(currentRig)
  const writeNeck = opts.writeNeck !== false
  let neckPose
  if (writeNeck) {
    neckPose = normalizeNeckPose(
      opts.neck ??
        opts.characterPose?.neck ??
        (idx >= 0 ? keyframes[idx]?.characterPose?.neck : null) ??
        createNeutralNeckPose()
    )
  } else {
    // Face-only / locked: preserve existing neck on keyframe; new key → neutral
    neckPose = normalizeNeckPose(
      (idx >= 0 ? keyframes[idx]?.characterPose?.neck : null) ?? createNeutralNeckPose()
    )
  }
  const characterPose = normalizeCharacterPose({ face: rig, neck: neckPose })

  if (idx >= 0) {
    const prev = keyframes[idx]
    keyframes[idx] = makeEvent({
      ...prev,
      keyframeId: prev.keyframeId,
      timeMs: t,
      name: opts.name || prev.name || "整脸关键帧",
      characterPose,
      positions: createPoseFromServos(configs, positions),
      keyedChannels: all,
      easing: opts.easing || prev.easing,
      configs,
    })
  } else {
    keyframes.push(
      makeEvent({
        timeMs: t,
        name: opts.name || "整脸关键帧",
        characterPose,
        positions,
        keyedChannels: all,
        easing: opts.easing,
        configs,
      })
    )
  }
  return touchProject(next, keyframes)
}

/** 别名：正式语义 Full Character Key */
export const addCharacterKeyAtTime = addFullFaceKeyAtTime

/**
 * 单属性 Key：完整 snapshot + keyedChannels 仅含该通道（同时间 merge）。
 */
export function addChannelKeyAtTime(
  project,
  timeMs,
  channelId,
  currentRig,
  positions = {},
  configs = [],
  opts = {}
) {
  const ch = String(channelId || "")
  if (!ch) return project

  const t = Math.max(0, Math.round(Number(timeMs) || 0))
  let next = ensureTimelineDuration({ ...project }, t)
  const keyframes = [...(next.keyframes || [])]
  const idx = findEventIndexAtTime(keyframes, t, opts.toleranceMs ?? 0)
  const current = cloneRig(currentRig)

  if (idx >= 0) {
    const prev = keyframes[idx]
    const existingKeyed = uniqChannels(prev.keyedChannels)
    const mergedKeyed = uniqChannels([...existingKeyed, ch])
    const mergedRig = mergeRigPreservingKeyed(prev.rigSnapshot, current, existingKeyed, [ch])
    keyframes[idx] = makeEvent({
      ...prev,
      keyframeId: prev.keyframeId,
      timeMs: t,
      name: prev.name,
      rigSnapshot: mergedRig,
      positions: createPoseFromServos(configs, {
        ...(prev.positions || {}),
        ...(positions || {}),
      }),
      keyedChannels: mergedKeyed,
      easing: prev.easing,
      configs,
    })
  } else {
    keyframes.push(
      makeEvent({
        timeMs: t,
        name: opts.name || ch,
        rigSnapshot: current,
        positions,
        keyedChannels: [ch],
        easing: opts.easing,
        configs,
      })
    )
  }
  return touchProject(next, keyframes)
}

export function removeChannelKey(project, timeMs, channelId, configs = []) {
  const ch = String(channelId || "")
  const t = Math.max(0, Math.round(Number(timeMs) || 0))
  const keyframes = [...(project.keyframes || [])]
  const idx = findEventIndexAtTime(keyframes, t)
  if (idx < 0) return project

  const prev = keyframes[idx]
  const nextKeyed = uniqChannels(prev.keyedChannels).filter((id) => id !== ch)
  if (nextKeyed.length === 0) {
    if (keyframes.length <= 1) {
      // 至少保留一枚；清空 keyed 不允许删光工程
      keyframes[idx] = makeEvent({
        ...prev,
        keyframeId: prev.keyframeId,
        keyedChannels: getAllTimelineChannelIds(),
        configs,
      })
    } else {
      keyframes.splice(idx, 1)
    }
  } else {
    keyframes[idx] = makeEvent({
      ...prev,
      keyframeId: prev.keyframeId,
      keyedChannels: nextKeyed,
      configs,
    })
  }
  return touchProject(project, keyframes)
}

/**
 * 移动单通道 Key：拆 Event，目标时间 sample 后写入通道关键值并 merge。
 */
export function moveChannelKey(project, fromTimeMs, toTimeMs, channelId, configs = [], opts = {}) {
  const ch = String(channelId || "")
  if (!ch) return project

  const fromT = Math.max(0, Math.round(Number(fromTimeMs) || 0))
  const toT = Math.max(0, Math.round(Number(toTimeMs) || 0))
  if (fromT === toT) return project

  const keyframes = [...(project.keyframes || [])]
  const fromIdx = findEventIndexAtTime(keyframes, fromT)
  if (fromIdx < 0) return project

  const source = keyframes[fromIdx]
  const keyed = uniqChannels(source.keyedChannels)
  if (!keyed.includes(ch)) return project

  const channelValue = getChannelValueFromRig(source.rigSnapshot, ch)
  if (channelValue == null) return project

  // 1) 从源事件移除该通道
  let working = removeChannelKey(project, fromT, ch, configs)

  // 2) sample 目标时间完整 Rig
  const sample = sampleExpressionTimeline(working, toT)
  let targetRig = sample?.rigSnapshot
    ? cloneRig(sample.rigSnapshot)
    : cloneRig(createInitialEliteRig())
  targetRig = setChannelValueOnRig(targetRig, ch, channelValue)

  // 3) 在目标时间 add/merge
  working = addChannelKeyAtTime(working, toT, ch, targetRig, {}, configs, {
    toleranceMs: opts.toleranceMs ?? 0,
    name: opts.name,
  })

  // 若目标已有事件，确保该通道关值写回（addChannelKeyAtTime 对新通道用 currentRig）
  const idx = findEventIndexAtTime(working.keyframes || [], toT, opts.toleranceMs ?? 0)
  if (idx >= 0) {
    const ev = working.keyframes[idx]
    const patchedRig = setChannelValueOnRig(ev.rigSnapshot, ch, channelValue)
    const nextKfs = [...working.keyframes]
    nextKfs[idx] = makeEvent({
      ...ev,
      keyframeId: ev.keyframeId,
      rigSnapshot: patchedRig,
      keyedChannels: uniqChannels([...(ev.keyedChannels || []), ch]),
      configs,
    })
    working = touchProject(working, nextKfs)
  }

  return ensureTimelineDuration(working, toT)
}

/**
 * 整脸 Key 整体移动（不拆分）；目标合并后 keyedChannels = ALL。
 */
export function moveFullFaceKey(project, fromTimeMs, toTimeMs, configs = [], opts = {}) {
  const fromT = Math.max(0, Math.round(Number(fromTimeMs) || 0))
  const toT = Math.max(0, Math.round(Number(toTimeMs) || 0))
  if (fromT === toT) return project

  const keyframes = [...(project.keyframes || [])]
  const fromIdx = findEventIndexAtTime(keyframes, fromT)
  if (fromIdx < 0) return project

  const source = keyframes[fromIdx]
  if (!isFullFaceKeyed(source.keyedChannels)) {
    // 非整脸：按「全部通道」仍整体移动该事件
  }

  const moving = { ...source, timeMs: toT }
  keyframes.splice(fromIdx, 1)

  const toIdx = findEventIndexAtTime(keyframes, toT, opts.toleranceMs ?? 0)
  if (toIdx >= 0) {
    const target = keyframes[toIdx]
    keyframes[toIdx] = makeEvent({
      ...target,
      keyframeId: target.keyframeId,
      timeMs: toT,
      name: moving.name || target.name,
      characterPose: moving.characterPose || {
        face: moving.rigSnapshot,
        neck: moving.characterPose?.neck,
      },
      positions: moving.positions,
      keyedChannels: getAllTimelineChannelIds(),
      easing: moving.easing || target.easing,
      configs,
    })
  } else {
    keyframes.push(
      makeEvent({
        ...moving,
        keyframeId: moving.keyframeId || createId("kf"),
        timeMs: toT,
        characterPose: moving.characterPose,
        keyedChannels: getAllTimelineChannelIds(),
        configs,
      })
    )
  }

  return ensureTimelineDuration(touchProject(project, keyframes), toT)
}

/**
 * Alt+拖动复制：保留源时间整脸 Key，在目标时间写入同姿态副本（keyedChannels = ALL）。
 */
export function copyFullFaceKeyToTime(project, fromTimeMs, toTimeMs, configs = [], opts = {}) {
  const fromT = Math.max(0, Math.round(Number(fromTimeMs) || 0))
  const toT = Math.max(0, Math.round(Number(toTimeMs) || 0))
  if (fromT === toT) return project

  const keyframes = project?.keyframes || []
  const fromIdx = findEventIndexAtTime(keyframes, fromT)
  if (fromIdx < 0) return project

  const source = keyframes[fromIdx]
  const name =
    opts.name ||
    (source.name ? `${String(source.name).replace(/\s*副本$/, "")} 副本` : "整脸关键帧 副本")

  return addFullFaceKeyAtTime(
    project,
    toT,
    cloneRig(source.rigSnapshot || source.characterPose?.face),
    source.positions && typeof source.positions === "object" ? { ...source.positions } : {},
    configs,
    {
      name,
      easing: source.easing,
      neck: source.characterPose?.neck || createNeutralNeckPose(),
    }
  )
}

/**
 * 用当前完整 Face Rig 更新已选整脸 Key。
 */
export function updateKeyEventFromCurrentRig(
  project,
  timeMs,
  currentRig,
  positions = {},
  configs = [],
  opts = {}
) {
  const t = Math.max(0, Math.round(Number(timeMs) || 0))
  const keyframes = [...(project.keyframes || [])]
  const idx = findEventIndexAtTime(keyframes, t)
  if (idx < 0) return project

  const prev = keyframes[idx]
  const keepAll = opts.forceFullFace || isFullFaceKeyed(prev.keyedChannels)
  keyframes[idx] = makeEvent({
    ...prev,
    keyframeId: prev.keyframeId,
    timeMs: t,
    rigSnapshot: cloneRig(currentRig),
    positions: createPoseFromServos(configs, positions),
    keyedChannels: keepAll ? getAllTimelineChannelIds() : uniqChannels(prev.keyedChannels),
    easing: prev.easing,
    configs,
  })
  return touchProject(project, keyframes)
}

export function setTimelineDurationMs(project, durationMs) {
  const d = Math.max(0, toInt(durationMs, 0))
  const maxKey = Math.max(0, ...(project.keyframes || []).map((k) => Number(k.timeMs) || 0))
  return {
    ...project,
    timelineDurationMs: Math.max(d, maxKey),
    updatedAt: new Date().toISOString(),
  }
}

export { ALL_TIMELINE_CHANNELS, makeEvent as createSparseKeyframeEvent }
