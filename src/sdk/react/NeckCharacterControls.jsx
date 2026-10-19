/**
 * Neck pad + yaw slider（独立 Character / Neck section，不改 Face Rig 布局）。
 * Pad: X=roll, Y=pitch；screen-up = 抬头 → semantic pitch 取反（pitch>0 = NOSE_DOWN）。
 */

import { useCallback, useRef } from "react"
import { NECK_SEMANTIC_LIMITS_FALLBACK, normalizeNeckPose } from "../neck/neckPose.js"

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n))
}

export default function NeckCharacterControls({
  neckPose,
  onNeckChange,
  limits = NECK_SEMANTIC_LIMITS_FALLBACK,
  disabled = false,
  bridgeStatus = null,
}) {
  const pose = normalizeNeckPose(neckPose, { limits })
  const padRef = useRef(null)

  const pitchLim = limits.pitch || NECK_SEMANTIC_LIMITS_FALLBACK.pitch
  const rollLim = limits.roll || NECK_SEMANTIC_LIMITS_FALLBACK.roll
  const yawLim = limits.yaw || NECK_SEMANTIC_LIMITS_FALLBACK.yaw

  const emit = useCallback(
    (patch) => {
      if (disabled) return
      onNeckChange?.(normalizeNeckPose({ ...pose, ...patch }, { limits }))
    },
    [disabled, onNeckChange, pose, limits]
  )

  const applyPadPointer = useCallback(
    (clientX, clientY) => {
      const el = padRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const nx = clamp((clientX - rect.left) / Math.max(rect.width, 1), 0, 1)
      const ny = clamp((clientY - rect.top) / Math.max(rect.height, 1), 0, 1)
      // X → roll；Y：屏上=抬头 → semantic pitch 取反
      const roll = rollLim.min + nx * (rollLim.max - rollLim.min)
      const pitch = pitchLim.max - ny * (pitchLim.max - pitchLim.min)
      emit({ roll, pitch })
    },
    [emit, pitchLim, rollLim]
  )

  const onPadDown = useCallback(
    (e) => {
      if (disabled) return
      e.preventDefault()
      applyPadPointer(e.clientX, e.clientY)
      const move = (ev) => applyPadPointer(ev.clientX, ev.clientY)
      const up = () => {
        window.removeEventListener("pointermove", move)
        window.removeEventListener("pointerup", up)
      }
      window.addEventListener("pointermove", move)
      window.addEventListener("pointerup", up)
    },
    [disabled, applyPadPointer]
  )

  const rollN = (pose.roll - rollLim.min) / Math.max(rollLim.max - rollLim.min, 1e-6)
  const pitchN = (pitchLim.max - pose.pitch) / Math.max(pitchLim.max - pitchLim.min, 1e-6)

  const safetyMode = bridgeStatus?.runtimeSafetyMode
  const productionReady = bridgeStatus?.productionReady

  return (
    <section className="neck-character-controls" aria-label="Neck Character Controls">
      <header className="neck-character-controls-head">
        <h3 className="neck-character-controls-title">Neck</h3>
        <span className="neck-character-controls-vals">
          P {pose.pitch.toFixed(1)}° · R {pose.roll.toFixed(1)}° · Y {pose.yaw.toFixed(1)}°
        </span>
      </header>

      {bridgeStatus ? (
        <div className="neck-bridge-status" role="status">
          <span>Bridge: {bridgeStatus.state || "—"}</span>
          <span
            className={
              productionReady ? "neck-bridge-badge is-prod" : "neck-bridge-badge is-commissioning"
            }
          >
            {productionReady ? "PRODUCTION READY" : safetyMode || "COMMISSIONING"}
          </span>
          {bridgeStatus.actualPoseUnavailable ? (
            <span className="neck-bridge-actual-warn">actualPose unavailable</span>
          ) : null}
        </div>
      ) : null}

      <div className="neck-character-controls-body">
        <div
          className={`neck-pad ${disabled ? "is-disabled" : ""}`}
          ref={padRef}
          onPointerDown={onPadDown}
          role="presentation"
          title="Pitch / Roll（上=抬头，右=右倾）"
        >
          <span className="neck-pad-cross" />
          <span
            className="neck-pad-knob"
            style={{ left: `${rollN * 100}%`, top: `${pitchN * 100}%` }}
          />
        </div>
        <label className="neck-yaw-row">
          <span>Yaw</span>
          <input
            type="range"
            min={yawLim.min}
            max={yawLim.max}
            step={0.5}
            disabled={disabled}
            value={pose.yaw}
            onChange={(e) => emit({ yaw: Number(e.target.value) })}
          />
          <span className="neck-yaw-val">{pose.yaw.toFixed(1)}°</span>
        </label>
      </div>
    </section>
  )
}
