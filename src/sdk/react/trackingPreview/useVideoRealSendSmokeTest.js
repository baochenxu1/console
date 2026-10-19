import { useCallback, useEffect, useRef, useState } from "react"
import {
  IMPLEMENTED_SMOKE_TEST_PROFILES,
  SMOKE_TEST_PROFILES,
  VIDEO_REAL_SEND_SMOKE_TEST_MAX_MS,
} from "../../trackingPreview/videoRealSendSmokeTest.js"
import { VIDEO_DEVICE_DRIVE_MODES } from "../../trackingPreview/videoDeviceDryRunConstants.js"

/**
 * Video 受控真机 smoke test：显式 arm、超时或片尾自动 disarm、Stop 立即 disarm。
 */
export function useVideoRealSendSmokeTest({
  enabled = false,
  profile = SMOKE_TEST_PROFILES.FULL_FACE,
  previewSourceRunning = false,
  isVideoSource = false,
  sendTrackingControl,
  wsOpen = false,
  /** 0 = 不限时，依赖页面 Stop / 片尾流程；>0 = 毫秒上限 */
  maxDurationMs = VIDEO_REAL_SEND_SMOKE_TEST_MAX_MS,
} = {}) {
  const [armed, setArmed] = useState(false)
  const [armedAtMs, setArmedAtMs] = useState(null)
  const [lastDisarmReason, setLastDisarmReason] = useState("")
  const timeoutRef = useRef(null)
  const armedRef = useRef(false)
  const maxDurationMsRef = useRef(maxDurationMs)

  const clearTimer = useCallback(() => {
    if (timeoutRef.current != null) {
      window.clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [])

  maxDurationMsRef.current = maxDurationMs

  const syncWs = useCallback(
    (nextEnabled, nextProfile, reason) => {
      sendTrackingControl?.({
        action: "setVideoRealSendSmokeTest",
        enabled: Boolean(nextEnabled),
        profile: nextEnabled ? nextProfile : null,
        reason: reason || "ui",
      })
    },
    [sendTrackingControl]
  )

  const disarm = useCallback(
    (reason = "manual") => {
      if (!armedRef.current) {
        return
      }
      armedRef.current = false
      setArmed(false)
      setArmedAtMs(null)
      setLastDisarmReason(String(reason || "manual"))
      clearTimer()
      syncWs(false, profile, reason)
    },
    [clearTimer, profile, syncWs]
  )

  const scheduleTimeout = useCallback(
    (durationMs) => {
      clearTimer()
      const ms = Number(durationMs)
      if (!Number.isFinite(ms) || ms <= 0) {
        return
      }
      timeoutRef.current = window.setTimeout(() => {
        disarm(`timeout-${ms}ms`)
      }, ms)
    },
    [clearTimer, disarm]
  )

  const arm = useCallback(() => {
    if (!enabled || !isVideoSource) {
      return { ok: false, reason: "smoke-test-disabled" }
    }
    if (!IMPLEMENTED_SMOKE_TEST_PROFILES.has(String(profile || ""))) {
      return { ok: false, reason: "profile-not-implemented" }
    }
    armedRef.current = true
    setArmed(true)
    setArmedAtMs(Date.now())
    setLastDisarmReason("")
    syncWs(true, profile, "arm")
    scheduleTimeout(maxDurationMsRef.current)
    return { ok: true }
  }, [enabled, isVideoSource, profile, syncWs, scheduleTimeout])

  armedRef.current = armed

  useEffect(() => {
    if (!previewSourceRunning && armedRef.current) {
      disarm("stop-tracking")
    }
  }, [previewSourceRunning, disarm])

  useEffect(() => {
    if (!enabled && armedRef.current) {
      disarm("disabled")
    }
  }, [enabled, disarm])

  useEffect(() => {
    if (enabled && armed && wsOpen) {
      syncWs(true, profile, "sync-on-ws-ready")
    }
  }, [enabled, armed, wsOpen, profile, syncWs])


  useEffect(() => () => clearTimer(), [clearTimer])

  const deviceDriveMode = armed
    ? VIDEO_DEVICE_DRIVE_MODES.REAL_SMOKE_TEST
    : VIDEO_DEVICE_DRIVE_MODES.OFF

  return {
    enabled,
    profile,
    armed,
    armedAtMs,
    lastDisarmReason,
    deviceDriveMode,
    maxDurationMs,
    arm,
    disarm,
    active: Boolean(enabled && armed && isVideoSource),
  }
}
