import { useCallback, useState } from "react"
import FaceRigVerticalScrub from "./FaceRigVerticalScrub.jsx"

/**
 * 鼻子左右并排滑块（仅向上 0～100）+ 下方居中同步开关。
 */
export default function FaceRigNosePair({
  noseL = 0,
  noseR = 0,
  onChangeNose,
  setSelectedControlId,
  setDraggingControlId,
  selectedControlId = null,
  draggingControlId = null,
  compact = false,
  valueInput = false,
}) {
  const [synced, setSynced] = useState(true)

  const scrubProps = useCallback(
    (controlId) => ({
      controlId,
      variant: "nose",
      rangeMode: "upward",
      selected: selectedControlId === controlId || draggingControlId === controlId,
      onSelect: () => setSelectedControlId?.(controlId),
      onDragControlChange: setDraggingControlId,
      stackClassName: `face-rig-handle-stack face-rig-handle-stack--nose${
        compact ? " face-rig-handle-stack--nose-compact" : ""
      }${selectedControlId === controlId || draggingControlId === controlId ? " is-val-visible" : ""}`.trim(),
    }),
    [compact, draggingControlId, selectedControlId, setDraggingControlId, setSelectedControlId]
  )

  const changeSide = useCallback(
    (side, value) => {
      const v = Math.max(0, Math.min(100, Math.round(Number(value) || 0)))
      if (synced) {
        onChangeNose?.({ noseL: v, noseR: v })
        return
      }
      if (side === "L") onChangeNose?.({ noseL: v, noseR })
      else onChangeNose?.({ noseL, noseR: v })
    },
    [noseL, noseR, onChangeNose, synced]
  )

  return (
    <div className="face-rig-nose-pair" aria-label="鼻子">
      <div className="face-rig-nose-scrubs">
        <FaceRigVerticalScrub
          value={noseL}
          onChange={(v) => changeSide("L", v)}
          valueInput={valueInput}
          {...scrubProps("nose_l")}
        />
        <FaceRigVerticalScrub
          value={noseR}
          onChange={(v) => changeSide("R", v)}
          valueInput={valueInput}
          {...scrubProps("nose_r")}
        />
      </div>
      <button
        type="button"
        className={`face-rig-nose-sync${synced ? " is-synced" : ""}`}
        aria-pressed={synced}
        aria-label={synced ? "鼻子左右已同步，点击取消同步" : "鼻子左右独立，点击开启同步"}
        title={synced ? "同步调节（开）" : "同步调节（关）"}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setSynced((prev) => {
            const next = !prev
            if (next) {
              const avg = Math.round(((Number(noseL) || 0) + (Number(noseR) || 0)) / 2)
              onChangeNose?.({ noseL: avg, noseR: avg })
            }
            return next
          })
        }}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          {synced ? (
            <>
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </>
          ) : (
            <>
              <path d="M10 13a5 5 0 0 0 7.54.54l1.5-1.5" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-1.5 1.5" />
              <path d="M8 8l8 8" />
            </>
          )}
        </svg>
      </button>
    </div>
  )
}
