/**
 * Character Hardware Dispatch：Face / Neck 并列子系统，互不阻断。
 *
 * CharacterPose { face, neck }
 *   ├── dispatchFaceHardware(face)  → SENT | SKIPPED_* | FAILED
 *   └── dispatchNeckHardware(neck)  → SENT | SKIPPED_* | FAILED | STALE | DISCONNECTED
 */

import { loadActuatorProfiles } from "../output/loadActuatorProfiles.js"
import { dispatchKeyframeToHardware } from "./keyframePlaybackDispatch.js"

export const FACE_HW_STATUS = Object.freeze({
  SENT: "SENT",
  SKIPPED_NO_PROFILE: "SKIPPED_NO_PROFILE",
  SKIPPED_NO_OUTPUTS: "SKIPPED_NO_OUTPUTS",
  DISCONNECTED: "DISCONNECTED",
  FAILED: "FAILED",
  IDLE: "IDLE",
})

export const NECK_HW_STATUS = Object.freeze({
  SENT: "SENT",
  DISCONNECTED: "DISCONNECTED",
  STALE: "STALE",
  FAILED: "FAILED",
  SKIPPED: "SKIPPED",
  IDLE: "IDLE",
})

/** @type {{ faceStatus: string, faceError: string|null, warnedNoProfile: boolean, faceSkipCount: number, faceFailCount: number }} */
const faceDiag = {
  faceStatus: FACE_HW_STATUS.IDLE,
  faceError: null,
  warnedNoProfile: false,
  faceSkipCount: 0,
  faceFailCount: 0,
}

/**
 * 预期的「无 Face 硬件」状态：不 throw、不每 tick console.error。
 */
export function isFaceHardwareUnavailableError(err) {
  const msg = String(err?.message || err || "")
  return (
    msg.includes("无可用 actuator profile") ||
    msg.includes("无可下发的 Bus 输出") ||
    msg.includes("串口未连接") ||
    msg.includes("No port selected") ||
    msg.includes("No port") ||
    /actuator profile/i.test(msg)
  )
}

export function peekFaceHardwareAvailability() {
  const bundle = loadActuatorProfiles()
  const ready = Boolean(bundle?.allowRealSend && (bundle.actuatorProfiles?.length || 0) > 0)
  return {
    profilesReady: ready,
    profileCount: Array.isArray(bundle?.actuatorProfiles) ? bundle.actuatorProfiles.length : 0,
  }
}

/**
 * Face 子系统：无 profile → SKIPPED（不 throw）。
 * @returns {Promise<{ attempted: boolean, status: string, error: string|null }>}
 */
export async function dispatchFaceHardware({
  keyframe,
  configs,
  signal,
  dispatchFaceImpl = dispatchKeyframeToHardware,
} = {}) {
  const availability = peekFaceHardwareAvailability()
  if (!availability.profilesReady) {
    faceDiag.faceStatus = FACE_HW_STATUS.SKIPPED_NO_PROFILE
    faceDiag.faceError = "无可用 actuator profile"
    faceDiag.faceSkipCount += 1
    // 仅首次提示一次，避免 50Hz error storm
    if (!faceDiag.warnedNoProfile) {
      faceDiag.warnedNoProfile = true
      if (typeof console !== "undefined" && typeof console.info === "function") {
        console.info(
          "[character-hw] Face hardware SKIPPED_NO_PROFILE（后续 tick 静默；Neck 不受影响）"
        )
      }
    }
    return {
      attempted: false,
      status: FACE_HW_STATUS.SKIPPED_NO_PROFILE,
      error: faceDiag.faceError,
    }
  }

  try {
    const ok = await dispatchFaceImpl({ keyframe, configs, signal })
    if (ok === false) {
      return { attempted: true, status: FACE_HW_STATUS.IDLE, error: null }
    }
    faceDiag.faceStatus = FACE_HW_STATUS.SENT
    faceDiag.faceError = null
    return { attempted: true, status: FACE_HW_STATUS.SENT, error: null }
  } catch (err) {
    const msg = err?.message || String(err)
    if (isFaceHardwareUnavailableError(err)) {
      const status = msg.includes("串口") || msg.includes("port")
        ? FACE_HW_STATUS.DISCONNECTED
        : msg.includes("Bus 输出")
          ? FACE_HW_STATUS.SKIPPED_NO_OUTPUTS
          : FACE_HW_STATUS.SKIPPED_NO_PROFILE
      faceDiag.faceStatus = status
      faceDiag.faceError = msg
      faceDiag.faceSkipCount += 1
      if (!faceDiag.warnedNoProfile) {
        faceDiag.warnedNoProfile = true
        if (typeof console !== "undefined" && typeof console.info === "function") {
          console.info(`[character-hw] Face hardware ${status}: ${msg}`)
        }
      }
      return { attempted: true, status, error: msg }
    }
    faceDiag.faceStatus = FACE_HW_STATUS.FAILED
    faceDiag.faceError = msg
    faceDiag.faceFailCount += 1
    if (typeof console !== "undefined" && typeof console.warn === "function") {
      console.warn("[character-hw] Face hardware FAILED:", err)
    }
    return { attempted: true, status: FACE_HW_STATUS.FAILED, error: msg }
  }
}

/**
 * Neck 子系统：与 Face 完全独立。
 * @param {(neck: object, meta: object) => boolean|void|Promise<boolean|void>} dispatchNeck
 * @returns {Promise<{ attempted: boolean, status: string, sequence: number|null, error: string|null }>}
 */
export async function dispatchNeckHardware(neck, meta, dispatchNeck) {
  if (typeof dispatchNeck !== "function") {
    return { attempted: false, status: NECK_HW_STATUS.SKIPPED, sequence: null, error: null }
  }
  if (!neck || typeof neck !== "object") {
    return { attempted: false, status: NECK_HW_STATUS.SKIPPED, sequence: null, error: null }
  }
  try {
    const result = await dispatchNeck(neck, meta)
    if (result && typeof result === "object" && result.status) {
      return {
        attempted: Boolean(result.attempted ?? true),
        status: String(result.status),
        sequence: result.sequence ?? null,
        error: result.error ?? null,
      }
    }
    if (result === false) {
      return {
        attempted: true,
        status: NECK_HW_STATUS.SKIPPED,
        sequence: meta?.sequence ?? null,
        error: null,
      }
    }
    return {
      attempted: true,
      status: NECK_HW_STATUS.SENT,
      sequence: meta?.sequence ?? null,
      error: null,
    }
  } catch (err) {
    const msg = err?.message || String(err)
    if (typeof console !== "undefined" && typeof console.warn === "function") {
      console.warn("[character-hw] Neck hardware FAILED:", err)
    }
    return { attempted: true, status: NECK_HW_STATUS.FAILED, sequence: null, error: msg }
  }
}

/**
 * 同一 sampled timelineTimeMs 下并列下发 Face + Neck。
 * 使用独立 try 路径（非 Promise.all），任一 reject 不影响另一子系统。
 *
 * @returns {Promise<{ timelineTimeMs: number, face: object, neck: object }>}
 */
export async function dispatchCharacterHardware({
  keyframe,
  configs,
  signal,
  sample,
  dispatchNeck,
  dispatchFaceImpl,
  timelineTimeMs,
} = {}) {
  const t =
    timelineTimeMs != null
      ? Number(timelineTimeMs)
      : Number(sample?.timelineTimeMs) || 0

  // Face 与 Neck 并行启动，但各自 catch；用 allSettled 避免互相 reject
  const facePromise = dispatchFaceHardware({
    keyframe,
    configs,
    signal,
    dispatchFaceImpl,
  })
  const neckPromise = dispatchNeckHardware(
    sample?.characterPose?.neck || null,
    {
      timelineTimeMs: t,
      sample,
    },
    dispatchNeck
  )

  const [faceSettled, neckSettled] = await Promise.allSettled([facePromise, neckPromise])

  const face =
    faceSettled.status === "fulfilled"
      ? faceSettled.value
      : {
          attempted: true,
          status: FACE_HW_STATUS.FAILED,
          error: faceSettled.reason?.message || String(faceSettled.reason),
        }

  const neck =
    neckSettled.status === "fulfilled"
      ? neckSettled.value
      : {
          attempted: true,
          status: NECK_HW_STATUS.FAILED,
          sequence: null,
          error: neckSettled.reason?.message || String(neckSettled.reason),
        }

  return {
    timelineTimeMs: t,
    face,
    neck,
  }
}

export function getFaceHardwareDispatchDiag() {
  return { ...faceDiag }
}

export function resetFaceHardwareDispatchDiag() {
  faceDiag.faceStatus = FACE_HW_STATUS.IDLE
  faceDiag.faceError = null
  faceDiag.warnedNoProfile = false
  faceDiag.faceSkipCount = 0
  faceDiag.faceFailCount = 0
}
