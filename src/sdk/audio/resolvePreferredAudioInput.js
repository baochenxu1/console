/**
 * 解析 Connect Flow 应使用的 physical audioinput。
 * 纯函数，便于 selftest；不触碰 getUserMedia。
 * 明确排除 Chromium default / communications alias。
 */

import {
  listPhysicalAudioInputs,
  listPseudoAudioInputs,
  looksLikeRespeakerLabel,
  looksLikeRespeakerLiteLabel,
  normalizeAudioInputDevice,
} from "./audioDevices.js"

export const DEVICE_RESOLVE_CODES = Object.freeze({
  Ok: "OK",
  NoAudioInput: "NO_AUDIO_INPUT",
  MultiplePreferredDevices: "MULTIPLE_PREFERRED_DEVICES",
  RequireUserSelection: "REQUIRE_USER_SELECTION",
})

export const SELECTION_SOURCES = Object.freeze({
  User: "user",
  Preferred: "preferred",
  Auto: "auto",
  DefaultMapped: "default_mapped",
  Fallback: "fallback",
  None: "none",
})

function normalizeList(devices = []) {
  return (devices || []).map((item) =>
    item?.isPhysical != null ? item : normalizeAudioInputDevice(item),
  )
}

function findPhysicalById(physicals, deviceId) {
  if (!deviceId) return null
  return physicals.find((item) => item.deviceId === deviceId) || null
}

function listPhysicalRespeakers(physicals = []) {
  const lite = physicals.filter((item) => looksLikeRespeakerLiteLabel(item.label))
  if (lite.length > 0) return lite
  return physicals.filter((item) => looksLikeRespeakerLabel(item.label))
}

function matchPreferredFingerprint(physicals, preferred) {
  if (!preferred) return null
  const groupId = String(preferred.groupId || "").trim()
  if (groupId) {
    const byGroup = physicals.filter((item) => item.groupId && item.groupId === groupId)
    if (byGroup.length === 1) return byGroup[0]
    const respeakerInGroup = byGroup.filter((item) => item.isReSpeaker)
    if (respeakerInGroup.length === 1) return respeakerInGroup[0]
  }
  const label = String(preferred.label || "").trim().toLowerCase()
  if (label) {
    const byLabel = physicals.filter((item) => String(item.label || "").trim().toLowerCase() === label)
    if (byLabel.length === 1) return byLabel[0]
  }
  if (looksLikeRespeakerLabel(preferred.label)) {
    const respeakers = listPhysicalRespeakers(physicals)
    if (respeakers.length === 1) return respeakers[0]
  }
  return null
}

/**
 * 若存在 default alias，尝试映射到同 groupId 的 physical device。
 */
function mapDefaultAliasToPhysical(devices, physicals) {
  const defaultAlias = (devices || []).find((item) => item.isDefaultAlias)
  if (!defaultAlias?.groupId) return null
  const mapped = physicals.filter((item) => item.groupId && item.groupId === defaultAlias.groupId)
  if (mapped.length === 1) return mapped[0]
  const respeaker = mapped.filter((item) => item.isReSpeaker)
  if (respeaker.length === 1) return respeaker[0]
  return null
}

function okResult(device, reason, selectionSource) {
  return {
    ok: true,
    code: DEVICE_RESOLVE_CODES.Ok,
    deviceId: device.deviceId,
    device,
    reason,
    selectionSource,
    message: "",
  }
}

/**
 * @param {{
 *   devices: Array<object>,
 *   selectedDeviceId?: string,
 *   selectionSource?: string,
 *   preferredDeviceId?: string,
 *   preferred?: { deviceId?: string, label?: string, groupId?: string } | null,
 * }} input
 */
export function resolvePreferredAudioInput({
  devices = [],
  selectedDeviceId = "",
  selectionSource = SELECTION_SOURCES.None,
  preferredDeviceId = "",
  preferred = null,
} = {}) {
  const list = normalizeList(devices)
  const physicals = listPhysicalAudioInputs(list)
  if (physicals.length === 0) {
    return {
      ok: false,
      code: DEVICE_RESOLVE_CODES.NoAudioInput,
      deviceId: "",
      device: null,
      reason: "no_physical_audio_input",
      selectionSource: SELECTION_SOURCES.None,
      message: "未检测到物理麦克风。",
      diagnostics: summarizeDeviceResolution(list),
    }
  }

  const preferredSnapshot = preferred || (preferredDeviceId
    ? { deviceId: preferredDeviceId, label: "", groupId: "" }
    : null)

  // 1) 当前 UI 已选 physical device（仍存在）。Alias / default 绝不会命中。
  const selected = findPhysicalById(physicals, selectedDeviceId)
  if (selected) {
    const source = selectionSource === SELECTION_SOURCES.User
      ? SELECTION_SOURCES.User
      : selectionSource && selectionSource !== SELECTION_SOURCES.None
        ? selectionSource
        : SELECTION_SOURCES.User
    return okResult(selected, "current_selection", source)
  }

  // 2) localStorage preferred physical deviceId
  const preferredId = String(preferredSnapshot?.deviceId || preferredDeviceId || "").trim()
  const preferredHit = findPhysicalById(physicals, preferredId)
  if (preferredHit) {
    return okResult(preferredHit, "preferred_device", SELECTION_SOURCES.Preferred)
  }

  // 3) preferred fingerprint / groupId / label → physical
  const fingerprinted = matchPreferredFingerprint(physicals, preferredSnapshot)
  if (fingerprinted) {
    return okResult(fingerprinted, "preferred_fingerprint", SELECTION_SOURCES.Preferred)
  }

  // 4 / 5) unique physical ReSpeaker / multiple
  const respeakers = listPhysicalRespeakers(physicals)
  if (respeakers.length === 1) {
    return okResult(respeakers[0], "respeaker_auto", SELECTION_SOURCES.Auto)
  }
  if (respeakers.length > 1) {
    return {
      ok: false,
      code: DEVICE_RESOLVE_CODES.MultiplePreferredDevices,
      deviceId: "",
      device: null,
      reason: "multiple_respeaker",
      selectionSource: SELECTION_SOURCES.None,
      message: "检测到多个 ReSpeaker，请选择输入设备。",
      candidates: respeakers,
      diagnostics: summarizeDeviceResolution(list),
    }
  }

  // 6) Browser default alias → same groupId physical
  const mapped = mapDefaultAliasToPhysical(list, physicals)
  if (mapped) {
    return okResult(mapped, "default_alias_mapped", SELECTION_SOURCES.DefaultMapped)
  }

  // 7) unique physical audioinput
  if (physicals.length === 1) {
    return okResult(physicals[0], "unique_physical", SELECTION_SOURCES.Fallback)
  }

  // 8) require user selection — 禁止 fallback devices[0]（常为 default alias）
  return {
    ok: false,
    code: DEVICE_RESOLVE_CODES.RequireUserSelection,
    deviceId: "",
    device: null,
    reason: "require_user_selection",
    selectionSource: SELECTION_SOURCES.None,
    message: "请选择麦克风输入设备。",
    diagnostics: summarizeDeviceResolution(list),
  }
}

export function summarizeDeviceResolution(devices = []) {
  const list = normalizeList(devices)
  const physicals = listPhysicalAudioInputs(list)
  const aliases = listPseudoAudioInputs(list)
  const respeakers = listPhysicalRespeakers(physicals)
  return {
    rawAudioInputCount: list.length,
    physicalInputCount: physicals.length,
    defaultAliasPresent: aliases.some((item) => item.isDefaultAlias),
    communicationsAliasPresent: aliases.some((item) => item.isCommunicationsAlias),
    physicalRespeakerCount: respeakers.length,
  }
}

/**
 * Connect transaction 用的不可变计划（不读 React state）。
 */
export function buildVoiceConnectPlan({
  freshDevices,
  selectedDeviceId = "",
  selectionSource = SELECTION_SOURCES.None,
  preferred = null,
  providerId = "",
  channelMode = "mono",
} = {}) {
  const devices = normalizeList(freshDevices)
  const resolved = resolvePreferredAudioInput({
    devices,
    selectedDeviceId,
    selectionSource,
    preferred,
    preferredDeviceId: preferred?.deviceId || "",
  })
  return {
    devices,
    physicalDevices: listPhysicalAudioInputs(devices),
    providerId: String(providerId || ""),
    channelMode,
    resolved,
    deviceId: resolved.ok ? resolved.deviceId : "",
    selectionSource: resolved.selectionSource || SELECTION_SOURCES.None,
    diagnostics: resolved.diagnostics || summarizeDeviceResolution(devices),
  }
}
