import { useCallback, useRef, useState } from "react"
import { resolveTrackingSourceContext } from "../../tracking/input/trackingSourceContext.js"
import {
  applyVideoNeutralToFrame,
  buildVideoNeutralSnapshot,
  canSetNeutralFromFrame,
  createVideoNeutralClearedEvent,
  createVideoNeutralSetEvent,
  resetTrackingTemporalState,
} from "../../tracking/videoNeutralCalibration.js"

/**
 * Video Preview 专用 neutral snapshot 状态（Phase 2.2）。
 */
export function useVideoNeutralCalibration({
  calibrationRef,
  prevCalibratedRef,
  isVideoTab = false,
} = {}) {
  const [snapshot, setSnapshot] = useState(null)
  const [enabled, setEnabled] = useState(true)
  const eventsRef = useRef([])

  const pushEvent = useCallback((event) => {
    if (!event) return
    eventsRef.current = [...eventsRef.current, { ...event, at: new Date().toISOString() }]
  }, [])

  const resetTemporal = useCallback(
    (reason, calibrationId = null) => {
      const evt = resetTrackingTemporalState({
        calibrationRef,
        prevCalibratedRef,
        reason,
        calibrationId,
      })
      pushEvent(evt)
      return evt
    },
    [calibrationRef, prevCalibratedRef, pushEvent]
  )

  const setNeutralFromFrame = useCallback(
    (lastFrame, videoFrameDebug) => {
      const check = canSetNeutralFromFrame(lastFrame, videoFrameDebug)
      if (!check.ok) {
        return { ok: false, reason: check.reason }
      }
      const built = buildVideoNeutralSnapshot(lastFrame, videoFrameDebug)
      if (!built) {
        return { ok: false, reason: "build-failed" }
      }
      resetTemporal("video-neutral-set", built.calibrationId)
      setSnapshot(built)
      setEnabled(true)
      pushEvent(createVideoNeutralSetEvent(built))
      return { ok: true, snapshot: built }
    },
    [pushEvent, resetTemporal]
  )

  const clearNeutral = useCallback(() => {
    const id = snapshot?.calibrationId ?? null
    resetTemporal("video-neutral-cleared", id)
    setSnapshot(null)
    pushEvent(createVideoNeutralClearedEvent(id))
    return { ok: true }
  }, [snapshot, pushEvent, resetTemporal])

  const applyNeutralToFrame = useCallback(
    (lastFrame) => {
      if (!lastFrame) {
        return {
          frame: lastFrame,
          applied: false,
          skipReason: "no-frame",
          rawRig: null,
          neutralizedRig: null,
        }
      }
      const sourceContext = resolveTrackingSourceContext(lastFrame, {}, { isVideoTab })
      if (!sourceContext.isVideoSource) {
        return {
          frame: lastFrame,
          applied: false,
          skipReason: "not-video",
          rawRig: lastFrame?.rig,
          neutralizedRig: lastFrame?.rig,
        }
      }
      if (!snapshot) {
        return {
          frame: lastFrame,
          applied: false,
          skipReason: "not-configured",
          rawRig: lastFrame?.rig,
          neutralizedRig: lastFrame?.rig,
        }
      }
      return applyVideoNeutralToFrame(lastFrame, snapshot, enabled)
    },
    [isVideoTab, snapshot, enabled]
  )

  const getCanSetNeutral = useCallback(
    (lastFrame, videoFrameDebug) => canSetNeutralFromFrame(lastFrame, videoFrameDebug),
    []
  )

  const drainEvents = useCallback(() => {
    const list = eventsRef.current
    eventsRef.current = []
    return list
  }, [])

  const peekEvents = useCallback(() => [...eventsRef.current], [])

  return {
    snapshot,
    enabled,
    setEnabled,
    setNeutralFromFrame,
    clearNeutral,
    applyNeutralToFrame,
    getCanSetNeutral,
    drainEvents,
    peekEvents,
    hasSnapshot: Boolean(snapshot),
  }
}
