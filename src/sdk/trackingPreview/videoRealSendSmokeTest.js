/** Video Real-send Smoke Test V0 — 受控短时真机下发。 */

import { inferActuatorSafetyRole } from "../output/actuatorOutputSafety.js"
import { LOGICAL_CENTER } from "../output/finalServoOutputTypes.js"
import { clampLogical, logicalToPwm } from "../output/pwmLogicalConvert.js"
import { VIDEO_DEVICE_DRIVE_MODES } from "./videoDeviceDryRunConstants.js"

export { VIDEO_DEVICE_DRIVE_MODES }

export const TRACKING_VIDEO_REAL_SEND_SMOKE_TEST_STORAGE_KEY =
  "facedev.tracking.videoRealSendSmokeTestEnabled"

export const TRACKING_VIDEO_SMOKE_TEST_PROFILE_STORAGE_KEY =
  "facedev.tracking.videoSmokeTestProfile"

export const SMOKE_TEST_PROFILES = /** @type {const} */ ({
  MOUTH_JAW_ONLY: "mouth_jaw_only",
  EYELID_ONLY: "eyelid_only",
  BROW_ONLY: "brow_only",
  /** 全脸通道，tracking 输出 1:1 下发（仍禁用 servo16） */
  FULL_FACE: "full_face",
  FULL_FACE_LOW_GAIN: "full_face_low_gain",
})

/** @typedef {typeof SMOKE_TEST_PROFILES[keyof typeof SMOKE_TEST_PROFILES]} SmokeTestProfileId */

export const SMOKE_TEST_PROFILE_LABELS = {
  [SMOKE_TEST_PROFILES.MOUTH_JAW_ONLY]: "Mouth + Jaw only",
  [SMOKE_TEST_PROFILES.EYELID_ONLY]: "Eyelid only (未实现)",
  [SMOKE_TEST_PROFILES.BROW_ONLY]: "Brow only (未实现)",
  [SMOKE_TEST_PROFILES.FULL_FACE]: "Full face (unity gain)",
  [SMOKE_TEST_PROFILES.FULL_FACE_LOW_GAIN]: "Full face low gain",
}

export const IMPLEMENTED_SMOKE_TEST_PROFILES = new Set([
  SMOKE_TEST_PROFILES.MOUTH_JAW_ONLY,
  SMOKE_TEST_PROFILES.FULL_FACE,
  SMOKE_TEST_PROFILES.FULL_FACE_LOW_GAIN,
])

/** 单次 smoke test 真发上限（无法解析视频时长时的回退；整段视频模式为 0 = 不限时） */
export const VIDEO_REAL_SEND_SMOKE_TEST_MAX_MS = 30000

/** full_face_low_gain：嘴部近满幅，眉保守，眼/下巴适度放大 */
export const SMOKE_TEST_FULL_FACE_ROLE_GAIN = /** @type {const} */ ({
  jaw: 1.28,
  lip: 1,
  mouthCorner: 1,
  brow: 0.4,
  eye: 0.58,
  eyeXY: 0.58,
  default: 0.5,
})

/** smoke test 单通道增益上限（low_gain profile 用；full_face 为 1.0 直通） */
export const SMOKE_TEST_GAIN_MAX = 1.35

const BLOCKED_LEGACY_SERVO = new Set([16])

/**
 * @param {import("../output/finalServoOutputTypes.js").FinalServoOutput} out
 */
function outputRole(out) {
  return inferActuatorSafetyRole(out?.sourceChannel, out?.actuatorKey)
}

/**
 * @param {import("../output/finalServoOutputTypes.js").FinalServoOutput} out
 */
function isBlockedServo16(out) {
  const legacy = Number(out?.legacyServoIndex)
  if (BLOCKED_LEGACY_SERVO.has(legacy)) {
    return true
  }
  const key = String(out?.actuatorKey || "").toLowerCase()
  return key === "servo_16" || (key.endsWith("_16") && key.startsWith("servo"))
}

/**
 * @param {number} logicalValue
 * @param {number} gain 相对中位缩放；>1 可小幅放大，结果仍 clamp 到 logical 范围
 */
function scaleLogicalTowardCenter(logicalValue, gain) {
  const lv = Number(logicalValue)
  if (!Number.isFinite(lv)) {
    return LOGICAL_CENTER
  }
  const g = Math.max(0, Math.min(SMOKE_TEST_GAIN_MAX, Number(gain) || 0))
  return clampLogical(LOGICAL_CENTER + (lv - LOGICAL_CENTER) * g)
}

/**
 * @param {import("../output/finalServoOutputTypes.js").FinalServoOutput} out
 */
function isMouthJawOnlyAllowed(out) {
  if (!out || isBlockedServo16(out)) {
    return false
  }
  const role = outputRole(out)
  if (role === "brow" || role === "eye" || role === "eyeXY") {
    return false
  }
  const ch = String(out.sourceChannel || "").toLowerCase()
  if (ch.startsWith("brow_") || ch.startsWith("eye_") || ch.startsWith("eye_xy.")) {
    return false
  }
  return role === "jaw" || role === "lip" || role === "mouthCorner"
}

/**
 * @param {import("../output/finalServoOutputTypes.js").FinalServoOutput} out
 */
function isFullFaceSmokeTestAllowed(out) {
  return Boolean(out) && !isBlockedServo16(out)
}

/**
 * @param {import("../output/finalServoOutputTypes.js").FinalServoOutput} out
 * @param {number} gain
 */
function applyGainToOutput(out, gain) {
  const lv = scaleLogicalTowardCenter(out.logicalValue, gain)
  return {
    ...out,
    logicalValue: lv,
    pwmValue: logicalToPwm(lv),
    debug: {
      ...(out.debug && typeof out.debug === "object" ? out.debug : {}),
      smokeTestGain: gain,
    },
  }
}

/**
 * @param {SmokeTestProfileId | string | null | undefined} profile
 */
export function resolveSmokeTestRoleGain(profile, role) {
  if (profile === SMOKE_TEST_PROFILES.FULL_FACE) {
    return 1
  }
  if (profile !== SMOKE_TEST_PROFILES.FULL_FACE_LOW_GAIN) {
    return 1
  }
  const r = String(role || "default")
  return SMOKE_TEST_FULL_FACE_ROLE_GAIN[r] ?? SMOKE_TEST_FULL_FACE_ROLE_GAIN.default
}

/**
 * @param {SmokeTestProfileId | string | null | undefined} profile
 */
export function describeSmokeTestProfile(profile) {
  if (profile === SMOKE_TEST_PROFILES.MOUTH_JAW_ONLY) {
    return "仅 mouth/jaw 通道，禁用 brow/eye/eyeXY/servo16"
  }
  if (profile === SMOKE_TEST_PROFILES.FULL_FACE) {
    return "全脸通道 unity gain（tracking 输出 1:1），仍禁用 servo16"
  }
  if (profile === SMOKE_TEST_PROFILES.FULL_FACE_LOW_GAIN) {
    return "全脸通道（下巴/眼略放大，眉低增益），仍禁用 servo16"
  }
  return "受控 smoke test"
}

/**
 * @param {import("../output/finalServoOutputTypes.js").FinalServoOutput[]} outputs
 * @param {SmokeTestProfileId | string | null | undefined} profile
 */
export function applySmokeTestProfileToOutputs(outputs, profile) {
  const list = Array.isArray(outputs) ? outputs : []
  if (profile === SMOKE_TEST_PROFILES.MOUTH_JAW_ONLY) {
    return list.filter(isMouthJawOnlyAllowed)
  }
  if (profile === SMOKE_TEST_PROFILES.FULL_FACE) {
    return list.filter(isFullFaceSmokeTestAllowed)
  }
  if (profile === SMOKE_TEST_PROFILES.FULL_FACE_LOW_GAIN) {
    return list
      .filter(isFullFaceSmokeTestAllowed)
      .map((out) => applyGainToOutput(out, resolveSmokeTestRoleGain(profile, outputRole(out))))
  }
  return []
}

/**
 * @param {import("../output/finalServoOutputTypes.js").FinalServoOutput[]} outputs
 * @param {SmokeTestProfileId | string | null | undefined} profile
 */
export function filterFinalOutputsForSmokeTest(outputs, profile) {
  return applySmokeTestProfileToOutputs(outputs, profile)
}

/**
 * @param {object[]} commands
 * @param {Set<string>} allowedActuatorKeys
 */
export function filterBusCommandsForSmokeTest(commands, allowedActuatorKeys) {
  if (!allowedActuatorKeys?.size) {
    return []
  }
  return (commands || []).filter((c) => allowedActuatorKeys.has(String(c.actuatorKey || "")))
}

/**
 * @param {SmokeTestProfileId | string | null | undefined} profile
 */
export function isSmokeTestProfileImplemented(profile) {
  return IMPLEMENTED_SMOKE_TEST_PROFILES.has(String(profile || ""))
}
