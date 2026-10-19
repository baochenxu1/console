import { useEffect, useRef, useState } from "react"

const SUCCESS_HOLD_MS = 2500

/**
 * 虹膜中心初始化提示（mediapipe_iris_only_v1）。
 * @param {{ gaze?: Record<string, unknown> | null }} props
 */
export default function NeutralInitOverlay({ gaze }) {
  const [successVisible, setSuccessVisible] = useState(false)
  const prevReadyRef = useRef(false)
  const hideTimerRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null))

  const mode = gaze?.gazeEstimatorMode != null ? String(gaze.gazeEstimatorMode) : ""
  const isIrisOnly = mode === "mediapipe_iris_only_v1"
  const state = gaze?.irisInitState != null ? String(gaze.irisInitState) : ""
  const ready = Boolean(gaze?.irisInitReady)

  const remainingMs = Number(gaze?.irisInitRemainingMs)
  const sampleCount = Number(gaze?.irisInitSampleCount)
  const required = Number(gaze?.irisInitRequiredSamples)
  const countdownSec = Number.isFinite(remainingMs)
    ? Math.max(0, remainingMs / 1000).toFixed(1)
    : "2.0"

  useEffect(() => {
    if (ready && !prevReadyRef.current) {
      setSuccessVisible(true)
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current)
      }
      hideTimerRef.current = setTimeout(() => {
        setSuccessVisible(false)
        hideTimerRef.current = null
      }, SUCCESS_HOLD_MS)
    }
    prevReadyRef.current = ready
    return () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current)
        hideTimerRef.current = null
      }
    }
  }, [ready])

  if (!isIrisOnly) {
    return null
  }

  if (successVisible && ready && state === "iris_tracking") {
    return (
      <div className="tp-neutral-init-overlay tp-neutral-init-overlay--success" role="status" aria-live="polite">
        <p className="tp-neutral-init-title">虹膜中心初始化完成</p>
      </div>
    )
  }

  if (state !== "iris_init_collecting") {
    return null
  }

  return (
    <div className="tp-neutral-init-overlay" role="status" aria-live="polite">
      <p className="tp-neutral-init-title">正在初始化虹膜中心，请目视摄像头 2 秒</p>
      <p className="tp-neutral-init-countdown">{countdownSec}s</p>
      {Number.isFinite(sampleCount) && Number.isFinite(required) ? (
        <p className="tp-neutral-init-hint">
          采样 {Math.round(sampleCount)} / {Math.round(required)}
        </p>
      ) : null}
    </div>
  )
}
