import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react"
import {
  attachDragSession,
  tryCapturePointer,
} from "./faceRigPointer.js"
import {
  FACE_RIG_PAD_INSET_PX,
  PAD_DRAG_GAIN,
  SCRUB_CLICK_SLOP_PX,
  applyPadWheelStep,
  applyRelativePadDelta,
} from "./faceRigScrubMath.js"
import { useFaceRigScrubAdjustGate } from "./useFaceRigScrubAdjustGate.js"

/**
 * 2D 嘴角 Pad：单击选定；双击进入可调；可调后相对拖动 / 滚轮微调。
 */
const FaceRigCornerPad = forwardRef(function FaceRigCornerPad(
  {
    x,
    y,
    onChange,
    onSelect,
    controlId = "",
    onDragControlChange,
    selected = false,
    onAdjustArmedChange = null,
    className = "",
    style = undefined,
    label = null,
    labelClassName = "",
    children = null,
  },
  ref
) {
  const padRef = useRef(null)
  const sessionRef = useRef(null)
  const xyRef = useRef({ x, y })
  const { adjustArmed, adjustArmedRef, isDoubleActivate, armAdjust, disarmAdjust } =
    useFaceRigScrubAdjustGate(selected)

  xyRef.current = { x, y }

  useImperativeHandle(ref, () => padRef.current, [])

  useEffect(() => {
    onAdjustArmedChange?.(adjustArmed)
  }, [adjustArmed, onAdjustArmedChange])

  const handlePointerDown = useCallback(
    (event) => {
      if (typeof event.button === "number" && event.button !== 0) {
        return
      }
      const pad = padRef.current
      if (!pad) return

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
      const startXY = {
        x: Number(xyRef.current.x),
        y: Number(xyRef.current.y),
      }
      sessionRef.current = {
        startClientX: cx0,
        startClientY: cy0,
        startXY: {
          x: Number.isFinite(startXY.x) ? startXY.x : 50,
          y: Number.isFinite(startXY.y) ? startXY.y : 50,
        },
        dragging: false,
        keepArmedOnTap: doubleActivate,
      }

      attachDragSession({
        onMove: (e) => {
          const sess = sessionRef.current
          if (!sess) return
          let cx = e.clientX
          let cy = e.clientY
          if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
            const t = e.touches?.[0] ?? e.changedTouches?.[0]
            if (t) {
              cx = t.clientX
              cy = t.clientY
            }
          }
          if (!Number.isFinite(cx) || !Number.isFinite(cy)) return

          const dx = cx - sess.startClientX
          const dy = cy - sess.startClientY
          if (!sess.dragging) {
            if (Math.hypot(dx, dy) < SCRUB_CLICK_SLOP_PX) return
            sess.dragging = true
            onDragControlChange?.(controlId || null)
          }

          const rect = pad.getBoundingClientRect()
          if (rect.width <= 0 || rect.height <= 0) return
          const usableW = Math.max(1, rect.width - FACE_RIG_PAD_INSET_PX * 2)
          const usableH = Math.max(1, rect.height - FACE_RIG_PAD_INSET_PX * 2)
          onChange(
            applyRelativePadDelta(sess.startXY, dx, dy, usableW, usableH, PAD_DRAG_GAIN)
          )
        },
        onEnd: () => {
          const sess = sessionRef.current
          sessionRef.current = null
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
      if (event.shiftKey) {
        onChange({ x: applyPadWheelStep(x, event.deltaY, event), y })
      } else {
        onChange({ x, y: applyPadWheelStep(y, event.deltaY, event) })
      }
    },
    [adjustArmedRef, onChange, onSelect, x, y]
  )

  return (
    <div
      ref={padRef}
      role="presentation"
      title={adjustArmed ? "可调节：拖动或滚轮" : "单击选定 · 双击后调节"}
      className={`face-rig-corner-pad face-rig-mouth-corner-pad face-rig-corner-pad--scrub${
        selected ? " is-selected" : ""
      }${adjustArmed ? " is-adjusting" : ""} ${className}`.trim()}
      style={style}
      onPointerDown={handlePointerDown}
      onWheel={handleWheel}
    >
      <div className="face-rig-corner-pad-grid" aria-hidden="true" />
      {children}
      <div
        className="face-rig-corner-cursor"
        style={{
          left: `calc(${FACE_RIG_PAD_INSET_PX}px + (100% - ${FACE_RIG_PAD_INSET_PX * 2}px) * ${Number(x) / 100})`,
          top: `calc(${FACE_RIG_PAD_INSET_PX}px + (100% - ${FACE_RIG_PAD_INSET_PX * 2}px) * ${Number(y) / 100})`,
        }}
      />
      {label ? <div className={labelClassName || "face-rig-corner-label"}>{label}</div> : null}
    </div>
  )
})

export default FaceRigCornerPad
