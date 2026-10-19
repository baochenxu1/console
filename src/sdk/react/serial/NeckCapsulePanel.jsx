import { useEffect, useRef, useState } from "react"
import "../../../styles/serial-capsule.css"

/**
 * Neck 胶囊：与 RJ/SC Offline 同款样式；点击后弹窗内连接串口与使能/失能电机。
 */
export default function NeckCapsulePanel({
  transportReady = false,
  motorsEnabled = false,
  connectBusy = false,
  locked = false,
  onConnect,
  onDisconnect,
  onEnableMotors,
  onDisableMotors,
  error = "",
  className = "",
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(/** @type {HTMLDivElement | null} */ (null))

  useEffect(() => {
    if (!open) return undefined
    const onDoc = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [open])

  const capsuleConnected = Boolean(transportReady)
  const capsuleLabel = !transportReady
    ? connectBusy
      ? "Neck …"
      : "Neck Offline"
    : motorsEnabled
      ? "Neck Ready"
      : "Neck Connected"

  return (
    <div className={`serial-capsule-wrap ${className}`.trim()} ref={rootRef}>
      <button
        type="button"
        className={`serial-capsule${open ? " serial-capsule--open" : ""}${
          capsuleConnected ? " serial-capsule--connected" : ""
        }`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={
          !transportReady
            ? "连接 Neck 串口与电机"
            : motorsEnabled
              ? "Neck 已连接且电机已使能"
              : "Neck 已连接，电机未使能"
        }
      >
        <span className="serial-capsule-dot" aria-hidden />
        <span className="serial-capsule-label">{capsuleLabel}</span>
      </button>
      {open ? (
        <div className="serial-capsule-popover" role="dialog" aria-label="Neck 连接">
          <div className="serial-compact-bar">
            <div className="serial-compact-protocol">
              <span className="serial-compact-protocol-label">Neck 串口</span>
              <p className="serial-compact-hint" style={{ color: "#64748b" }}>
                {transportReady
                  ? motorsEnabled
                    ? "已连接 · 电机已使能"
                    : "已连接 · 电机未使能（Neck Motors Off）"
                  : "未连接（将弹出 COM 口确认）"}
              </p>
            </div>

            <div className="serial-compact-actions">
              <button
                type="button"
                className="serial-compact-btn serial-compact-btn--open"
                disabled={locked || connectBusy || transportReady || typeof onConnect !== "function"}
                onClick={() => void onConnect?.()}
              >
                {connectBusy ? "连接中…" : "连接 Neck"}
              </button>
              <button
                type="button"
                className="serial-compact-btn serial-compact-btn--close"
                disabled={locked || !transportReady || typeof onDisconnect !== "function"}
                onClick={() => void onDisconnect?.()}
              >
                断开 Neck
              </button>
            </div>

            <div className="serial-compact-protocol">
              <span className="serial-compact-protocol-label">电机</span>
              <p
                className={`serial-compact-hint${motorsEnabled ? "" : " serial-compact-hint--warn"}`}
                style={motorsEnabled ? { color: "#15803d" } : undefined}
              >
                {motorsEnabled ? "Neck Motors On" : "Neck Motors Off"}
              </p>
            </div>

            <div className="serial-compact-actions">
              <button
                type="button"
                className="serial-compact-btn serial-compact-btn--primary"
                disabled={
                  locked ||
                  !transportReady ||
                  motorsEnabled ||
                  typeof onEnableMotors !== "function"
                }
                onClick={() => void onEnableMotors?.()}
                title="使能后实时预览播放才会驱动脖子"
              >
                使能电机
              </button>
              <button
                type="button"
                className="serial-compact-btn serial-compact-btn--close"
                disabled={
                  locked ||
                  !transportReady ||
                  !motorsEnabled ||
                  typeof onDisableMotors !== "function"
                }
                onClick={() => onDisableMotors?.()}
              >
                失能电机
              </button>
            </div>

            {error ? <p className="serial-compact-err">{error}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
