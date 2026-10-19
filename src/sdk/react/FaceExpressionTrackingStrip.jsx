import { useEffect, useState } from "react"
import { pickExtendedAdapterFields } from "./useTrackingAdapterController.js"

/**
 * 表情编排页极简 Tracking 条：仅开关 + 连接状态，不含 WS URL / 性能指标。
 */
export default function FaceExpressionTrackingStrip({
  adapter,
  trackingEnabled,
  onTrackingEnabledChange,
  driveRigEnabled,
  onDriveRigEnabledChange,
  onFrame,
}) {
  const [status, setStatus] = useState(() => adapter?.getStatus?.() ?? { running: false, faceDetected: false, error: null })

  useEffect(() => {
    if (!trackingEnabled || !onFrame || !adapter?.onFrame) {
      return undefined
    }
    adapter.onFrame(onFrame)
    return () => adapter.offFrame?.(onFrame)
  }, [adapter, trackingEnabled, onFrame])

  useEffect(() => {
    const tick = () => {
      try {
        const raw = adapter?.getStatus?.() ?? {}
        setStatus({
          running: Boolean(raw.running),
          faceDetected: Boolean(raw.faceDetected),
          error: raw.error != null ? String(raw.error) : null,
          ...pickExtendedAdapterFields(raw),
        })
      } catch {
        setStatus((p) => ({ ...p, error: "status 读取失败" }))
      }
    }
    tick()
    const id = window.setInterval(tick, 200)
    return () => window.clearInterval(id)
  }, [adapter])

  const connected = status.running
  const dotClass = connected
    ? status.faceDetected
      ? "face-expression-tracking-dot face-expression-tracking-dot--ok"
      : "face-expression-tracking-dot face-expression-tracking-dot--warn"
    : "face-expression-tracking-dot face-expression-tracking-dot--off"

  return (
    <div className="face-expression-tracking-strip" aria-label="Tracking 控制">
      <label className="face-expression-tracking-strip-toggle">
        <input
          type="checkbox"
          checked={trackingEnabled}
          onChange={(e) => onTrackingEnabledChange(e.target.checked)}
        />
        Tracking
      </label>
      <label className="face-expression-tracking-strip-toggle">
        <input
          type="checkbox"
          checked={driveRigEnabled}
          disabled={!trackingEnabled}
          onChange={(e) => onDriveRigEnabledChange(e.target.checked)}
        />
        Drive Rig
      </label>
      <span className={dotClass} title={connected ? "WebSocket 已连接" : "未连接"} aria-hidden />
      <span className="face-expression-tracking-strip-status">
        {connected ? (status.faceDetected ? "已连接 · 有人脸" : "已连接 · 无人脸") : "未连接"}
        {status.error ? ` · ${status.error}` : ""}
      </span>
    </div>
  )
}
