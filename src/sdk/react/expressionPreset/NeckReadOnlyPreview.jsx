/**
 * Read-only Neck semantic preview for Preset Character Stage.
 * Square Pitch/Roll pad + compact Yaw; no hardware / editor chrome.
 */

import { NECK_SEMANTIC_LIMITS_FALLBACK, normalizeNeckPose } from "../../neck/neckPose.js"
import { CHARACTER_PRESET_STAGE_LOGICAL } from "../../expression/characterPresetPreviewStage.js"

export default function NeckReadOnlyPreview({
  pitch = 0,
  roll = 0,
  yaw = 0,
  neck = null,
  padSize = CHARACTER_PRESET_STAGE_LOGICAL.neck.padSize,
  yawWidth = CHARACTER_PRESET_STAGE_LOGICAL.neck.yawWidth,
  className = "",
}) {
  const limits = NECK_SEMANTIC_LIMITS_FALLBACK
  const pose = normalizeNeckPose(neck || { pitch, roll, yaw }, { limits })
  const pitchLim = limits.pitch
  const rollLim = limits.roll
  const yawLim = limits.yaw

  const rollN = (pose.roll - rollLim.min) / Math.max(rollLim.max - rollLim.min, 1e-6)
  const pitchN = (pitchLim.max - pose.pitch) / Math.max(pitchLim.max - pitchLim.min, 1e-6)
  const yawN = (pose.yaw - yawLim.min) / Math.max(yawLim.max - yawLim.min, 1e-6)

  return (
    <div
      className={`xp-neck-ro${className ? ` ${className}` : ""}`}
      aria-label="Neck Preview（只读）"
      data-readonly="true"
      style={{
        "--xp-neck-pad": `${padSize}px`,
        "--xp-neck-yaw-w": `${yawWidth}px`,
      }}
    >
      <header className="xp-neck-ro-head">
        <span className="xp-neck-ro-title">Neck</span>
        <span className="xp-neck-ro-vals">
          P {pose.pitch.toFixed(1)}° · R {pose.roll.toFixed(1)}° · Y {pose.yaw.toFixed(1)}°
        </span>
      </header>

      <div
        className="xp-neck-ro-pad"
        role="img"
        aria-label={`Pitch ${pose.pitch.toFixed(1)}°, Roll ${pose.roll.toFixed(1)}°`}
        title="Pitch / Roll（上=抬头，右=右倾）"
      >
        <span className="xp-neck-ro-cross" aria-hidden="true" />
        <span
          className="xp-neck-ro-knob"
          style={{ left: `${rollN * 100}%`, top: `${pitchN * 100}%` }}
          aria-hidden="true"
        />
      </div>

      <div className="xp-neck-ro-pr">
        <span>P {pose.pitch.toFixed(1)}°</span>
        <span>R {pose.roll.toFixed(1)}°</span>
      </div>

      <div className="xp-neck-ro-yaw" aria-label={`Yaw ${pose.yaw.toFixed(1)}°`}>
        <div className="xp-neck-ro-yaw-label">
          <span>Yaw</span>
          <span className="xp-neck-ro-yaw-val">{pose.yaw.toFixed(1)}°</span>
        </div>
        <div className="xp-neck-ro-yaw-track" aria-hidden="true">
          <span className="xp-neck-ro-yaw-range">−90</span>
          <span className="xp-neck-ro-yaw-bar">
            <i style={{ left: `${yawN * 100}%` }} />
          </span>
          <span className="xp-neck-ro-yaw-range">+90</span>
        </div>
      </div>
    </div>
  )
}
