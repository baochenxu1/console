/**
 * Expression Timeline Channel Registry（Rig Semantic Channel，非舵机 / IK 节点）。
 * 从 faceRigProfile 正式控件半自动生成，供 Dope Sheet / sampler / key ops 共用。
 */

import { createDefaultControls } from "./faceRigProfile.js"
import {
  createInitialEliteRig,
  normalizeEliteRig,
  rigValuesFromEliteRig,
  setEliteRigControlRaw,
} from "./faceDofMapper.js"

/** 不进入 Timeline 的 controlId（IK / 兼容 / 停用） */
const EXCLUDED_CONTROL_IDS = new Set([
  "brow_l_F",
  "brow_l_D",
  "brow_l_tip_a",
  "brow_l_tip_b",
  "brow_r_F",
  "brow_r_D",
  "brow_r_tip_a",
  "brow_r_tip_b",
  "jaw_A",
  "jaw_D",
  "tongue",
  "eye_xy",
  "sharedRadar",
])

const GROUP_ORDER = ["face", "brow", "eyes", "nose", "mouth", "jaw", "neck"]

const GROUP_META = {
  face: { groupId: "face", label: "全脸", virtual: true },
  brow: { groupId: "brow", label: "眉毛", virtual: false },
  eyes: { groupId: "eyes", label: "眼睛", virtual: false },
  nose: { groupId: "nose", label: "鼻子", virtual: false },
  mouth: { groupId: "mouth", label: "嘴部", virtual: false },
  jaw: { groupId: "jaw", label: "下颌", virtual: false },
  neck: { groupId: "neck", label: "颈部", virtual: false },
}

/** Neck semantic channels（非 faceRigProfile 控件） */
export const NECK_TIMELINE_CHANNEL_DEFS = Object.freeze([
  {
    channelId: "neck.pitch",
    controlId: "neck",
    channel: "pitch",
    groupId: "neck",
    label: "Pitch",
  },
  {
    channelId: "neck.roll",
    controlId: "neck",
    channel: "roll",
    groupId: "neck",
    label: "Roll",
  },
  {
    channelId: "neck.yaw",
    controlId: "neck",
    channel: "yaw",
    groupId: "neck",
    label: "Yaw",
  },
])

export const NECK_TIMELINE_CHANNEL_IDS = Object.freeze(
  NECK_TIMELINE_CHANNEL_DEFS.map((c) => c.channelId)
)

function resolveGroupId(controlId) {
  if (controlId.startsWith("brow_")) return "brow"
  if (controlId.startsWith("eye_")) return "eyes"
  if (controlId.startsWith("nose_")) return "nose"
  if (controlId.startsWith("mouth_")) return "mouth"
  if (controlId === "jaw") return "jaw"
  if (controlId === "neck") return "neck"
  return null
}

const CHANNEL_LABELS = {
  x: "X",
  y: "Y",
  value: "值",
  lateral: "侧移",
}

function buildChannelLabel(control, channelKey) {
  const base = String(control.label || control.controlId)
  if (channelKey === "value" && Object.keys(control.channels || {}).length === 1) {
    return base
  }
  const ch = CHANNEL_LABELS[channelKey] || channelKey
  return `${base} · ${ch}`
}

/**
 * @typedef {{ channelId: string, controlId: string, channel: string, groupId: string, label: string }} TimelineChannelDef
 */

/**
 * @returns {TimelineChannelDef[]}
 */
export function listTimelineChannels(controls = createDefaultControls()) {
  const out = []
  for (const control of controls) {
    const controlId = String(control?.controlId || "")
    if (!controlId || EXCLUDED_CONTROL_IDS.has(controlId)) continue
    const groupId = resolveGroupId(controlId)
    if (!groupId) continue
    const channels = control.channels && typeof control.channels === "object" ? control.channels : {}
    for (const channelKey of Object.keys(channels)) {
      out.push({
        channelId: `${controlId}.${channelKey}`,
        controlId,
        channel: channelKey,
        groupId,
        label: buildChannelLabel(control, channelKey),
      })
    }
  }
  for (const neckCh of NECK_TIMELINE_CHANNEL_DEFS) {
    out.push({ ...neckCh })
  }
  return out
}

/** Face-only channel ids（不含 neck.*） */
export function getFaceTimelineChannelIds() {
  ensureCache()
  return _cachedChannels.filter((c) => c.groupId !== "neck").map((c) => c.channelId)
}

export function getNeckTimelineChannelIds() {
  return [...NECK_TIMELINE_CHANNEL_IDS]
}

export function isNeckChannelId(channelId) {
  return NECK_TIMELINE_CHANNEL_IDS.includes(String(channelId || ""))
}

let _cachedChannels = null
let _cachedIds = null

function ensureCache() {
  if (!_cachedChannels) {
    _cachedChannels = listTimelineChannels()
    _cachedIds = Object.freeze(_cachedChannels.map((c) => c.channelId))
  }
}

/** @returns {readonly string[]} */
export function getAllTimelineChannelIds() {
  ensureCache()
  return _cachedIds
}

export const ALL_TIMELINE_CHANNELS = getAllTimelineChannelIds()

export function getTimelineChannelDef(channelId) {
  ensureCache()
  return _cachedChannels.find((c) => c.channelId === channelId) || null
}

export function listTimelineGroups() {
  ensureCache()
  return GROUP_ORDER.map((groupId) => {
    const meta = GROUP_META[groupId]
    const channels =
      groupId === "face" ? [] : _cachedChannels.filter((c) => c.groupId === groupId)
    return {
      ...meta,
      channelIds: channels.map((c) => c.channelId),
      channels,
    }
  })
}

/**
 * @param {string} channelId
 * @returns {{ controlId: string, channel: string } | null}
 */
export function parseTimelineChannelId(channelId) {
  const raw = String(channelId || "")
  const dot = raw.lastIndexOf(".")
  if (dot <= 0) return null
  return {
    controlId: raw.slice(0, dot),
    channel: raw.slice(dot + 1),
  }
}

/**
 * @param {object} rig
 * @param {string} channelId
 * @returns {number | null}
 */
export function getChannelValueFromRig(rig, channelId) {
  if (isNeckChannelId(channelId)) return null
  const parsed = parseTimelineChannelId(channelId)
  if (!parsed) return null
  const values = rigValuesFromEliteRig(rig)
  const entry = values[parsed.controlId]
  if (!entry || typeof entry !== "object") return null
  const n = Number(entry[parsed.channel])
  return Number.isFinite(n) ? n : null
}

/**
 * @param {object} rig
 * @param {string} channelId
 * @param {number} value
 */
export function setChannelValueOnRig(rig, channelId, value) {
  if (isNeckChannelId(channelId)) return normalizeEliteRig(rig)
  const parsed = parseTimelineChannelId(channelId)
  if (!parsed) return normalizeEliteRig(rig)
  return setEliteRigControlRaw(rig, parsed.controlId, parsed.channel, value)
}

/**
 * 从 CharacterPose 读通道值（Face 走 elite rig，Neck 走 neck.*）。
 * @param {{ face?: object, neck?: object }|null|undefined} characterPose
 * @param {string} channelId
 */
export function getChannelValueFromCharacterPose(characterPose, channelId) {
  if (isNeckChannelId(channelId)) {
    const axis = parseTimelineChannelId(channelId)?.channel
    const n = Number(characterPose?.neck?.[axis])
    return Number.isFinite(n) ? n : 0
  }
  return getChannelValueFromRig(characterPose?.face || characterPose, channelId)
}

/**
 * @param {{ face?: object, neck?: object }} characterPose
 * @param {string} channelId
 * @param {number} value
 */
export function setChannelValueOnCharacterPose(characterPose, channelId, value) {
  const face = characterPose?.face
  const neck = characterPose?.neck && typeof characterPose.neck === "object"
    ? { ...characterPose.neck }
    : { pitch: 0, roll: 0, yaw: 0 }
  if (isNeckChannelId(channelId)) {
    const axis = parseTimelineChannelId(channelId)?.channel
    if (axis) neck[axis] = Number(value) || 0
    return {
      face: normalizeEliteRig(face),
      neck,
    }
  }
  return {
    face: setChannelValueOnRig(face, channelId, value),
    neck,
  }
}

/**
 * Full Character Key：keyedChannels 覆盖全部 Face + Neck 通道。
 * @param {string[]|null|undefined} keyedChannels
 */
export function isFullFaceKeyed(keyedChannels) {
  const all = getAllTimelineChannelIds()
  if (!Array.isArray(keyedChannels) || keyedChannels.length === 0) return false
  if (keyedChannels.length < all.length) return false
  const set = new Set(keyedChannels.map(String))
  return all.every((id) => set.has(id))
}

/** 别名：正式语义为 Full Character Key */
export const isFullCharacterKeyed = isFullFaceKeyed

/**
 * 旧工程「整脸 ALL」在加入 neck 通道后扩展为 Character ALL。
 */
export function expandKeyedChannelsToCharacter(keyedChannels) {
  const faceIds = getFaceTimelineChannelIds()
  const all = getAllTimelineChannelIds()
  if (!Array.isArray(keyedChannels) || keyedChannels.length === 0) {
    return [...all]
  }
  const set = new Set(keyedChannels.map(String))
  const wasFullFace = faceIds.every((id) => set.has(id))
  if (wasFullFace) return [...all]
  return keyedChannels.map(String)
}

/**
 * @param {string[]} keyedChannels
 * @returns {'solid'|'hollow'|'none'}
 */
export function faceKeyVisualKind(keyedChannels) {
  if (!Array.isArray(keyedChannels) || keyedChannels.length === 0) return "none"
  return isFullFaceKeyed(keyedChannels) ? "solid" : "hollow"
}

/**
 * @param {Array<{ timeMs: number, keyedChannels?: string[] }>} events
 * @param {string[]} childChannelIds
 * @returns {Array<{ timeMs: number, kind: 'solid'|'hollow' }>}
 */
export function buildGroupKeySummaries(events, childChannelIds) {
  const children = Array.isArray(childChannelIds) ? childChannelIds.map(String) : []
  if (children.length === 0) return []

  /** @type {Map<number, Set<string>>} */
  const byTime = new Map()
  for (const event of events || []) {
    const t = Math.round(Number(event?.timeMs) || 0)
    const keyed = Array.isArray(event?.keyedChannels) ? event.keyedChannels.map(String) : []
    for (const ch of keyed) {
      if (!children.includes(ch)) continue
      if (!byTime.has(t)) byTime.set(t, new Set())
      byTime.get(t).add(ch)
    }
  }

  return [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([timeMs, set]) => ({
      timeMs,
      kind: children.every((id) => set.has(id)) ? "solid" : "hollow",
    }))
}

/**
 * Face 行：每个事件时间一个 diamond。
 * @param {Array<{ timeMs: number, keyedChannels?: string[] }>} events
 */
export function buildFaceKeySummaries(events) {
  const byTime = new Map()
  for (const event of events || []) {
    const t = Math.round(Number(event?.timeMs) || 0)
    const kind = faceKeyVisualKind(event?.keyedChannels)
    if (kind === "none") continue
    const prev = byTime.get(t)
    if (!prev || (prev === "hollow" && kind === "solid")) {
      byTime.set(t, kind)
    }
  }
  return [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([timeMs, kind]) => ({ timeMs, kind }))
}

export function createNeutralTimelineRig() {
  return createInitialEliteRig()
}
