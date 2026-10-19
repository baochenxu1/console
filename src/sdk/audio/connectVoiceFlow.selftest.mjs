/**
 * Connect Flow 纯逻辑 selftest（不触碰浏览器 MediaDevices）。
 */

import assert from "node:assert/strict"
import {
  isPseudoAudioDeviceId,
  listPhysicalAudioInputs,
  looksLikeRespeakerLabel,
  normalizeAudioInputDevice,
  shortAudioInputLabel,
  sortAudioInputDevices,
} from "./audioDevices.js"
import {
  loadPreferredAudioInput,
  savePreferredAudioInput,
  VOICE_PREFERRED_AUDIO_INPUT_KEY,
} from "./audioPreferences.js"
import {
  buildVoiceConnectPlan,
  DEVICE_RESOLVE_CODES,
  resolvePreferredAudioInput,
  SELECTION_SOURCES,
} from "./resolvePreferredAudioInput.js"

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null
    },
    setItem(key, value) {
      map.set(key, String(value))
    },
    removeItem(key) {
      map.delete(key)
    },
  }
}

function aliasSuite() {
  return sortAudioInputDevices([
    { deviceId: "default", kind: "audioinput", label: "默认 - 麦克风 (ReSpeaker Lite)", groupId: "g-respeaker" },
    { deviceId: "communications", kind: "audioinput", label: "通讯 - 麦克风 (ReSpeaker Lite)", groupId: "g-respeaker" },
    { deviceId: "physical-respeaker", kind: "audioinput", label: "麦克风 (ReSpeaker Lite) (2886:0019)", groupId: "g-respeaker" },
    { deviceId: "usb", kind: "audioinput", label: "USB Microphone", groupId: "g-usb" },
    { deviceId: "intel", kind: "audioinput", label: "Intel Microphone Array", groupId: "g-intel" },
  ])
}

assert.equal(isPseudoAudioDeviceId("default"), true)
assert.equal(isPseudoAudioDeviceId("communications"), true)
assert.equal(isPseudoAudioDeviceId("physical-respeaker"), false)

{
  const devices = aliasSuite()
  const physicals = listPhysicalAudioInputs(devices)
  assert.equal(physicals.length, 3)
  assert.ok(physicals.every((item) => item.isPhysical))
  assert.equal(looksLikeRespeakerLabel(devices.find((d) => d.deviceId === "default").label), true)
  assert.equal(shortAudioInputLabel(devices.find((d) => d.deviceId === "physical-respeaker")), "ReSpeaker Lite")
}

// Case 1: default + communications + physical ReSpeaker → physical
{
  const result = resolvePreferredAudioInput({
    devices: aliasSuite(),
    selectedDeviceId: "",
    preferredDeviceId: "",
  })
  assert.equal(result.ok, true)
  assert.equal(result.deviceId, "physical-respeaker")
  assert.ok(["respeaker_auto", "default_alias_mapped"].includes(result.reason))
}

// Case 2: preferred = default → ignore → physical ReSpeaker
{
  const result = resolvePreferredAudioInput({
    devices: aliasSuite(),
    selectedDeviceId: "",
    preferred: { deviceId: "default", label: "默认 - ReSpeaker Lite" },
  })
  assert.equal(result.ok, true)
  assert.equal(result.deviceId, "physical-respeaker")
  assert.notEqual(result.deviceId, "default")
}

// Case 3: preferred = communications → ignore
{
  const result = resolvePreferredAudioInput({
    devices: aliasSuite(),
    selectedDeviceId: "",
    preferredDeviceId: "communications",
  })
  assert.equal(result.ok, true)
  assert.equal(result.deviceId, "physical-respeaker")
}

// Case 4: preferred = valid physical ReSpeaker
{
  const result = resolvePreferredAudioInput({
    devices: aliasSuite(),
    selectedDeviceId: "",
    preferredDeviceId: "physical-respeaker",
  })
  assert.equal(result.ok, true)
  assert.equal(result.reason, "preferred_device")
  assert.equal(result.deviceId, "physical-respeaker")
}

// Case 5: explicit user selection = USB Microphone（不被 ReSpeaker auto override）
{
  const result = resolvePreferredAudioInput({
    devices: aliasSuite(),
    selectedDeviceId: "usb",
    selectionSource: SELECTION_SOURCES.User,
    preferredDeviceId: "physical-respeaker",
  })
  assert.equal(result.ok, true)
  assert.equal(result.reason, "current_selection")
  assert.equal(result.deviceId, "usb")
}

// Case 6: multiple physical ReSpeaker → MULTIPLE
{
  const multi = sortAudioInputDevices([
    { deviceId: "default", kind: "audioinput", label: "默认 - ReSpeaker Lite", groupId: "g1" },
    { deviceId: "r1", kind: "audioinput", label: "ReSpeaker Lite A", groupId: "g1" },
    { deviceId: "r2", kind: "audioinput", label: "ReSpeaker Lite B", groupId: "g2" },
  ])
  const result = resolvePreferredAudioInput({
    devices: multi,
    selectedDeviceId: "",
    preferredDeviceId: "",
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, DEVICE_RESOLVE_CODES.MultiplePreferredDevices)
}

// Case 7: permission 后 fresh list（带 physical）覆盖旧空 label / alias-only 语义
{
  const before = sortAudioInputDevices([
    { deviceId: "default", kind: "audioinput", label: "", groupId: "" },
  ])
  const after = aliasSuite()
  const stale = resolvePreferredAudioInput({ devices: before })
  assert.equal(stale.ok, false)
  const fresh = resolvePreferredAudioInput({ devices: after })
  assert.equal(fresh.ok, true)
  assert.equal(fresh.deviceId, "physical-respeaker")
}

// selected alias must not win
{
  const result = resolvePreferredAudioInput({
    devices: aliasSuite(),
    selectedDeviceId: "default",
    selectionSource: SELECTION_SOURCES.User,
  })
  assert.equal(result.ok, true)
  assert.equal(result.deviceId, "physical-respeaker")
}

// preferred fingerprint via groupId
{
  const result = resolvePreferredAudioInput({
    devices: aliasSuite(),
    preferred: { deviceId: "old-opaque-id", label: "ReSpeaker Lite", groupId: "g-respeaker" },
  })
  assert.equal(result.ok, true)
  assert.equal(result.deviceId, "physical-respeaker")
  assert.equal(result.reason, "preferred_fingerprint")
}

// connect plan uses freshDevices snapshot（不依赖 React state）
{
  const plan = buildVoiceConnectPlan({
    freshDevices: aliasSuite(),
    selectedDeviceId: "default",
    selectionSource: SELECTION_SOURCES.Auto,
    preferred: { deviceId: "communications" },
    providerId: "mock",
    channelMode: "mono",
  })
  assert.equal(plan.resolved.ok, true)
  assert.equal(plan.deviceId, "physical-respeaker")
  assert.equal(plan.providerId, "mock")
  assert.equal(plan.physicalDevices.length, 3)
}

// Preference migration: default / communications invalid
{
  const storage = memoryStorage({
    [VOICE_PREFERRED_AUDIO_INPUT_KEY]: JSON.stringify({ deviceId: "default", label: "ReSpeaker" }),
  })
  assert.equal(loadPreferredAudioInput(storage), null)

  const storage2 = memoryStorage({
    [VOICE_PREFERRED_AUDIO_INPUT_KEY]: JSON.stringify({ deviceId: "communications", label: "ReSpeaker" }),
  })
  assert.equal(loadPreferredAudioInput(storage2), null)

  const storage3 = memoryStorage()
  assert.equal(savePreferredAudioInput({ deviceId: "default", label: "x" }, storage3), false)
  assert.equal(savePreferredAudioInput({
    deviceId: "physical-respeaker",
    label: "ReSpeaker Lite",
    groupId: "g-respeaker",
  }, storage3), true)
  const loaded = loadPreferredAudioInput(storage3)
  assert.equal(loaded.deviceId, "physical-respeaker")
  assert.equal(loaded.groupId, "g-respeaker")
}

// Retry decision helper（页面逻辑同构）
{
  function isRetryableStartError(code) {
    return code === "NotReadableError" || code === "AbortError"
  }
  assert.equal(isRetryableStartError("NotReadableError"), true)
  assert.equal(isRetryableStartError("AbortError"), true)
  assert.equal(isRetryableStartError("NotAllowedError"), false)

  let attempts = 0
  let state = "IDLE"
  function attemptStart(failFirst) {
    attempts += 1
    if (failFirst && attempts === 1) {
      return { ok: false, code: "NotReadableError" }
    }
    state = "RUNNING"
    return { ok: true }
  }
  let result = attemptStart(true)
  if (!result.ok && isRetryableStartError(result.code)) {
    result = attemptStart(true)
  }
  assert.equal(result.ok, true)
  assert.equal(state, "RUNNING")
  assert.equal(attempts, 2)

  attempts = 0
  result = { ok: false, code: "NotAllowedError" }
  if (!result.ok && isRetryableStartError(result.code)) {
    attempts += 1
  }
  assert.equal(attempts, 0)
}

// normalize flags
{
  const n = normalizeAudioInputDevice({
    deviceId: "default",
    label: "默认 - ReSpeaker Lite",
    groupId: "g",
  })
  assert.equal(n.isDefaultAlias, true)
  assert.equal(n.isPhysical, false)
  assert.equal(n.isReSpeaker, true)
}

console.log("connectVoiceFlow.selftest ok")
