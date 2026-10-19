import { useCallback, useEffect, useState } from "react"
import { formatRigScrubInt } from "../../../utils/formatRigDisplay.js"
import { clampScrubValue } from "./faceRigScrubMath.js"

/**
 * 与 face-rig-val-pill 同尺寸的一维数值输入；用于表情编排页精确录入，不占用额外布局空间。
 */
export default function FaceRigValInput({
  value,
  onChange,
  rangeMode = "signed",
  className = "face-rig-val-pill face-rig-val-pill--scrub",
  onSelect,
  ariaLabel = "控件数值",
}) {
  const [draft, setDraft] = useState(null)
  const [focused, setFocused] = useState(false)
  const formatted = formatRigScrubInt(value)

  useEffect(() => {
    if (!focused) {
      setDraft(null)
    }
  }, [formatted, focused])

  const commit = useCallback(
    (raw) => {
      const text = String(raw ?? "").trim()
      if (text === "" || text === "—") {
        setDraft(null)
        return
      }
      const n = Number.parseInt(text, 10)
      if (Number.isNaN(n)) {
        setDraft(null)
        return
      }
      onChange?.(clampScrubValue(n, rangeMode))
      setDraft(null)
    },
    [onChange, rangeMode]
  )

  return (
    <input
      type="text"
      inputMode="numeric"
      className={`face-rig-val-input ${className}`.trim()}
      value={focused && draft != null ? draft : formatted}
      aria-label={ariaLabel}
      title="点击输入精确数值"
      onFocus={(event) => {
        onSelect?.()
        setFocused(true)
        setDraft(formatted === "—" ? "" : formatted)
        event.target.select()
      }}
      onBlur={() => {
        commit(draft ?? formatted)
        setFocused(false)
      }}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === "Enter") {
          event.currentTarget.blur()
        }
        if (event.key === "Escape") {
          setDraft(null)
          event.currentTarget.blur()
        }
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    />
  )
}
