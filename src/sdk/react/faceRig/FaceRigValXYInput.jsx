import { useCallback, useEffect, useState } from "react"
import { formatRigNum } from "../../../utils/formatRigDisplay.js"
import { clampScrubValue } from "./faceRigScrubMath.js"

function parseAxis(raw, rangeMode) {
  const text = String(raw ?? "").trim()
  if (text === "" || text === "—") {
    return null
  }
  const n = Number.parseFloat(text)
  if (!Number.isFinite(n)) {
    return null
  }
  return clampScrubValue(Math.round(n), rangeMode)
}

/**
 * 二维 (x,y) 数值输入，外观与 face-rig-val-pill--radar / --corner 一致。
 */
export default function FaceRigValXYInput({
  x,
  y,
  onChange,
  rangeMode = "percent",
  className = "face-rig-val-pill",
  pillClassName = "",
  onSelect,
  ariaLabel = "平面坐标",
}) {
  const [draftX, setDraftX] = useState(null)
  const [draftY, setDraftY] = useState(null)
  const [focusedAxis, setFocusedAxis] = useState(null)
  const fx = formatRigNum(x, 0)
  const fy = formatRigNum(y, 0)

  useEffect(() => {
    if (!focusedAxis) {
      setDraftX(null)
      setDraftY(null)
    }
  }, [fx, fy, focusedAxis])

  const commitAxis = useCallback(
    (axis, raw) => {
      const nextVal = parseAxis(raw, rangeMode)
      if (nextVal == null) {
        return
      }
      if (axis === "x") {
        onChange?.({ x: nextVal, y: clampScrubValue(y, rangeMode) })
      } else {
        onChange?.({ x: clampScrubValue(x, rangeMode), y: nextVal })
      }
    },
    [onChange, rangeMode, x, y]
  )

  const pillCls = `${className} face-rig-val-input-wrap ${pillClassName}`.trim()

  return (
    <span className={pillCls} aria-label={ariaLabel}>
      <input
        type="text"
        inputMode="decimal"
        className="face-rig-val-input face-rig-val-input--axis"
        value={focusedAxis === "x" && draftX != null ? draftX : fx}
        aria-label={`${ariaLabel} X`}
        title="X"
        onFocus={(event) => {
          onSelect?.()
          setFocusedAxis("x")
          setDraftX(fx === "—" ? "" : fx)
          event.target.select()
        }}
        onBlur={() => {
          commitAxis("x", draftX ?? fx)
          setFocusedAxis(null)
        }}
        onChange={(event) => setDraftX(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === "Enter") event.currentTarget.blur()
          if (event.key === "Escape") {
            setDraftX(null)
            event.currentTarget.blur()
          }
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      />
      <span className="face-rig-val-input-sep" aria-hidden>
        ·
      </span>
      <input
        type="text"
        inputMode="decimal"
        className="face-rig-val-input face-rig-val-input--axis"
        value={focusedAxis === "y" && draftY != null ? draftY : fy}
        aria-label={`${ariaLabel} Y`}
        title="Y"
        onFocus={(event) => {
          onSelect?.()
          setFocusedAxis("y")
          setDraftY(fy === "—" ? "" : fy)
          event.target.select()
        }}
        onBlur={() => {
          commitAxis("y", draftY ?? fy)
          setFocusedAxis(null)
        }}
        onChange={(event) => setDraftY(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === "Enter") event.currentTarget.blur()
          if (event.key === "Escape") {
            setDraftY(null)
            event.currentTarget.blur()
          }
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      />
    </span>
  )
}
