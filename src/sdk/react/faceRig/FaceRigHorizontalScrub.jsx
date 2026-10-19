import { useCallback, useEffect, useRef, useState } from "react"
import { attachDragSession, tryCapturePointer } from "./faceRigPointer.js"
import { formatRigScrubInt } from "../../../utils/formatRigDisplay.js"
import {
  FACE_RIG_JAW_LATERAL_TRACK_WIDTH,
  FACE_RIG_JAW_THUMB_PX,
  FACE_RIG_SCRUB_THUMB_PX,
  SCRUB_CLICK_SLOP_PX,
  SCRUB_DRAG_GAIN,
  applyRelativeScrubDelta,
  applyWheelStep,
  scrubTrackUsableSpanPx,
  valueToTrackFraction,
} from "./faceRigScrubMath.js"
import { useFaceRigScrubAdjustGate } from "./useFaceRigScrubAdjustGate.js"
import FaceRigValInput from "./FaceRigValInput.jsx"

/**
 * 横向 Face Rig 滑块。单击只选定；双击进入可调后再拖动/滚轮。
 */
export default function FaceRigHorizontalScrub({
  value,
  onChange,
  onSelect,
  controlId = "",
  onDragControlChange,
  selected = false,
  selectionChrome = "self",
  onAdjustArmedChange = null,
  variant = "jaw-lateral",
  rangeMode = "signed50",
  stackClassName = "",
  formatValue = formatRigScrubInt,
  trackWidthPx = FACE_RIG_JAW_LATERAL_TRACK_WIDTH,
  valueInput = false,
}) {
  const trackRef = useRef(null)
  const draggingRef = useRef(false)
  const sessionRef = useRef(null)
  const valueRef = useRef(value)
  const [dragValue, setDragValue] = useState(null)
  const displayValue = dragValue != null ? dragValue : value
  const thumbPx = variant === "jaw-lateral" ? FACE_RIG_JAW_THUMB_PX : FACE_RIG_SCRUB_THUMB_PX
  const fraction = valueToTrackFraction(displayValue, rangeMode)
  const thumbLeftPct = fraction * 100
  const valueMin = rangeMode === "signed50" ? -50 : rangeMode === "percent" ? 0 : -100
  const valueMax = rangeMode === "signed50" ? 50 : 100
  const { adjustArmed, adjustArmedRef, isDoubleActivate, armAdjust, disarmAdjust } =
    useFaceRigScrubAdjustGate(selected)

  valueRef.current = value

  useEffect(() => {
    onAdjustArmedChange?.(adjustArmed)
  }, [adjustArmed, onAdjustArmedChange])

  useEffect(() => {
    if (draggingRef.current) return
    setDragValue(null)
  }, [value])

  const handlePointerDown = useCallback(
    (event) => {
      if (typeof event.button === "number" && event.button !== 0) return
      const track = trackRef.current
      if (!track) return

      onSelect?.()
      event.preventDefault()
      event.stopPropagation()

      let startX = event.clientX
      let startY = event.clientY
      if (!Number.isFinite(startX) || !Number.isFinite(startY)) {
        const t = event.touches?.[0] ?? event.changedTouches?.[0]
        if (t) {
          startX = t.clientX
          startY = t.clientY
        }
      }
      const cx0 = Number.isFinite(startX) ? startX : 0
      const cy0 = Number.isFinite(startY) ? startY : 0
      const doubleActivate = isDoubleActivate(event, cx0, cy0)
      const wasArmed = adjustArmedRef.current

      if (doubleActivate) {
        armAdjust()
      } else if (!wasArmed) {
        return
      }

      tryCapturePointer(event.currentTarget, event.nativeEvent)
      const startValue = Number(valueRef.current)
      sessionRef.current = {
        startX: cx0,
        startValue: Number.isFinite(startValue) ? startValue : 0,
        dragging: false,
        keepArmedOnTap: doubleActivate,
      }
      draggingRef.current = false

      attachDragSession({
        onMove: (e) => {
          const sess = sessionRef.current
          if (!sess) return
          let cx = e.clientX
          if (!Number.isFinite(cx)) {
            const t = e.touches?.[0] ?? e.changedTouches?.[0]
            if (t) cx = t.clientX
          }
          if (!Number.isFinite(cx)) return

          const dx = cx - sess.startX
          if (!sess.dragging) {
            if (Math.abs(dx) < SCRUB_CLICK_SLOP_PX) return
            sess.dragging = true
            draggingRef.current = true
            onDragControlChange?.(controlId || null)
          }

          const rect = track.getBoundingClientRect()
          if (rect.width <= 0) return
          const usable = scrubTrackUsableSpanPx(rect, thumbPx, "x")
          const next = applyRelativeScrubDelta(
            sess.startValue,
            cx - sess.startX,
            usable,
            rangeMode,
            SCRUB_DRAG_GAIN
          )
          setDragValue(next)
          onChange(next)
        },
        onEnd: () => {
          const sess = sessionRef.current
          sessionRef.current = null
          draggingRef.current = false
          onDragControlChange?.(null)
          if (sess && !sess.dragging && !sess.keepArmedOnTap) {
            disarmAdjust()
          }
        },
      })
    },
    [
      adjustArmedRef,
      armAdjust,
      controlId,
      disarmAdjust,
      isDoubleActivate,
      onChange,
      onDragControlChange,
      onSelect,
      rangeMode,
      thumbPx,
    ]
  )

  const handleWheel = useCallback(
    (event) => {
      event.preventDefault()
      event.stopPropagation()
      onSelect?.()
      if (!adjustArmedRef.current) {
        return
      }
      const next = applyWheelStep(displayValue, event.deltaY, event, rangeMode)
      setDragValue(next)
      onChange(next)
    },
    [adjustArmedRef, displayValue, onChange, onSelect, rangeMode]
  )

  const showChrome = selectionChrome !== "none"

  return (
    <div
      className={`face-rig-scrub-stack face-rig-scrub-stack--horizontal${
        showChrome && selected ? " is-selected" : ""
      }${showChrome && adjustArmed ? " is-adjusting" : ""} ${stackClassName}`.trim()}
      title={adjustArmed ? "可调节：拖动或滚轮" : "单击选定 · 双击后调节"}
    >
      {valueInput ? (
        <FaceRigValInput
          value={displayValue}
          onChange={onChange}
          rangeMode={rangeMode}
          onSelect={onSelect}
          className="face-rig-val-pill face-rig-val-pill--scrub"
        />
      ) : (
        <span className="face-rig-val-pill face-rig-val-pill--scrub">{formatValue(displayValue)}</span>
      )}
      <div
        ref={trackRef}
        role="slider"
        aria-valuemin={valueMin}
        aria-valuemax={valueMax}
        aria-valuenow={Math.round(Number(displayValue) || 0)}
        aria-orientation="horizontal"
        aria-description={adjustArmed ? "已双击，可拖动调节" : "单击选定，双击后调节"}
        className={`face-rig-scrub-track face-rig-scrub-track--horizontal face-rig-scrub-track--${variant}${
          showChrome && selected ? " is-selected" : ""
        }${showChrome && adjustArmed ? " is-adjusting" : ""}`}
        style={{ width: `${trackWidthPx}px` }}
        onPointerDown={handlePointerDown}
        onWheel={handleWheel}
      >
        <div className="face-rig-scrub-rail" aria-hidden="true" />
        <div className="face-rig-scrub-end face-rig-scrub-end--left" aria-hidden="true" />
        <div className="face-rig-scrub-end face-rig-scrub-end--right" aria-hidden="true" />
        <div className="face-rig-scrub-center face-rig-scrub-center--horizontal" aria-hidden="true" />
        <div
          className="face-rig-scrub-thumb face-rig-scrub-thumb--horizontal face-rig-scrub-thumb--jaw"
          style={{ left: `${thumbLeftPct}%` }}
          aria-hidden="true"
        />
      </div>
    </div>
  )
}
