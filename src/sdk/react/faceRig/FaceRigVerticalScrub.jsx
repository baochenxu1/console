import { useCallback, useEffect, useRef, useState } from "react"
import {
  attachDragSession,
  tryCapturePointer,
} from "./faceRigPointer.js"
import { formatRigScrubInt } from "../../../utils/formatRigDisplay.js"
import {
  FACE_RIG_JAW_THUMB_PX,
  FACE_RIG_SCRUB_THUMB_PX,
  FACE_RIG_SCRUB_TRACK_HEIGHT,
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
 * 带可见轨道的一维 Face Rig 滑块。
 * 单击只选定；双击进入可调；可调后相对拖动（带增益）或滚轮微调。
 */
export default function FaceRigVerticalScrub({
  value,
  onChange,
  onSelect,
  controlId = "",
  onDragControlChange,
  selected = false,
  /** "self" = 本控件描边；"none" = 由父级胶囊统一描边（如下颌翼） */
  selectionChrome = "self",
  onAdjustArmedChange = null,
  variant = "brow",
  rangeMode = "signed",
  stackClassName = "",
  formatValue = formatRigScrubInt,
  /** 表情编排：pill 改为可输入，不改变轨道拖动行为 */
  valueInput = false,
}) {
  const trackRef = useRef(null)
  const draggingRef = useRef(false)
  const sessionRef = useRef(null)
  const valueRef = useRef(value)
  const [dragValue, setDragValue] = useState(null)
  const displayValue = dragValue != null ? dragValue : value
  const trackHeight = FACE_RIG_SCRUB_TRACK_HEIGHT[variant] ?? FACE_RIG_SCRUB_TRACK_HEIGHT.brow
  const thumbPx = variant === "jaw" ? FACE_RIG_JAW_THUMB_PX : FACE_RIG_SCRUB_THUMB_PX
  const fraction = valueToTrackFraction(displayValue, rangeMode)
  const thumbTopPct = (1 - fraction) * 100
  const showCenter = rangeMode === "signed"
  const valueMin = rangeMode === "signed" ? -100 : 0
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
      if (typeof event.button === "number" && event.button !== 0) {
        return
      }
      const track = trackRef.current
      if (!track) return

      onSelect?.()
      event.preventDefault()
      event.stopPropagation()

      let startY = event.clientY
      let startX = event.clientX
      if (!Number.isFinite(startY) || !Number.isFinite(startX)) {
        const t = event.touches?.[0] ?? event.changedTouches?.[0]
        if (t) {
          startY = t.clientY
          startX = t.clientX
        }
      }
      const cx0 = Number.isFinite(startX) ? startX : 0
      const cy0 = Number.isFinite(startY) ? startY : 0
      const doubleActivate = isDoubleActivate(event, cx0, cy0)
      const wasArmed = adjustArmedRef.current

      if (doubleActivate) {
        armAdjust()
      } else if (!wasArmed) {
        /* 单击且未可调：只选定 */
        return
      }

      tryCapturePointer(event.currentTarget, event.nativeEvent)
      const startValue = Number(valueRef.current)
      sessionRef.current = {
        startY: cy0,
        startValue: Number.isFinite(startValue) ? startValue : 0,
        dragging: false,
        /* 双击当次松开且未拖：保持可调；可调态下单击未拖：退出可调 */
        keepArmedOnTap: doubleActivate,
      }
      draggingRef.current = false

      attachDragSession({
        onMove: (e) => {
          const sess = sessionRef.current
          if (!sess) return
          let cy = e.clientY
          if (!Number.isFinite(cy)) {
            const t = e.touches?.[0] ?? e.changedTouches?.[0]
            if (t) cy = t.clientY
          }
          if (!Number.isFinite(cy)) return

          const dy = cy - sess.startY
          if (!sess.dragging) {
            if (Math.abs(dy) < SCRUB_CLICK_SLOP_PX) return
            sess.dragging = true
            draggingRef.current = true
            onDragControlChange?.(controlId || null)
          }

          const rect = track.getBoundingClientRect()
          if (rect.height <= 0) return
          const usable = scrubTrackUsableSpanPx(rect, thumbPx, "y")
          const next = applyRelativeScrubDelta(
            sess.startValue,
            -(cy - sess.startY),
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
      className={`face-rig-scrub-stack${showChrome && selected ? " is-selected" : ""}${
        showChrome && adjustArmed ? " is-adjusting" : ""
      } ${stackClassName}`.trim()}
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
        aria-valuemax={100}
        aria-valuenow={Math.round(Number(displayValue) || 0)}
        aria-orientation="vertical"
        aria-description={adjustArmed ? "已双击，可拖动调节" : "单击选定，双击后调节"}
        className={`face-rig-scrub-track face-rig-scrub-track--${variant}${
          rangeMode !== "signed" ? " face-rig-scrub-track--unipolar" : ""
        }${showChrome && selected ? " is-selected" : ""}${
          showChrome && adjustArmed ? " is-adjusting" : ""
        }`}
        style={{ height: `${trackHeight}px` }}
        onPointerDown={handlePointerDown}
        onWheel={handleWheel}
      >
        <div className="face-rig-scrub-rail" aria-hidden="true" />
        <div className="face-rig-scrub-end face-rig-scrub-end--top" aria-hidden="true" />
        <div className="face-rig-scrub-end face-rig-scrub-end--bottom" aria-hidden="true" />
        {showCenter ? <div className="face-rig-scrub-center" aria-hidden="true" /> : null}
        <div
          className={`face-rig-scrub-thumb${variant === "jaw" ? " face-rig-scrub-thumb--jaw" : ""}`}
          style={{ top: `${thumbTopPct}%` }}
          aria-hidden="true"
        />
      </div>
    </div>
  )
}
