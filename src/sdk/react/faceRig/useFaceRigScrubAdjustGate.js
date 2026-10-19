import { useCallback, useEffect, useRef, useState } from "react"

/** 触摸双击判定时间窗（ms）；鼠标优先用 event.detail */
export const SCRUB_DOUBLE_TAP_MS = 380
export const SCRUB_DOUBLE_TAP_SLOP_PX = 14

/**
 * 非 Hook 双击检测器（供 startRadar 等命令式回调使用）。
 */
export function createDoubleTapDetector() {
  let last = { t: 0, x: NaN, y: NaN }
  return {
    /**
     * @param {PointerEvent | MouseEvent | TouchEvent | { detail?: number }} event
     * @param {number} clientX
     * @param {number} clientY
     */
    isDouble(event, clientX, clientY) {
      if (typeof event.detail === "number" && event.detail >= 2) {
        last = { t: Date.now(), x: clientX, y: clientY }
        return true
      }
      const now = Date.now()
      const dt = now - last.t
      const dist =
        Number.isFinite(last.x) && Number.isFinite(last.y)
          ? Math.hypot(clientX - last.x, clientY - last.y)
          : Infinity
      const tapped =
        dt > 0 && dt <= SCRUB_DOUBLE_TAP_MS && dist <= SCRUB_DOUBLE_TAP_SLOP_PX
      last = { t: now, x: clientX, y: clientY }
      return tapped
    },
  }
}

/**
 * Face Rig 滑条门控：单击只选定；双击进入可调；可调态下才能拖/滚轮。
 * 可调态下再单击（无拖动）退出可调，仍保持选中。
 */
export function useFaceRigScrubAdjustGate(selected) {
  const [adjustArmed, setAdjustArmed] = useState(false)
  const adjustArmedRef = useRef(false)
  const detectorRef = useRef(null)
  if (!detectorRef.current) {
    detectorRef.current = createDoubleTapDetector()
  }

  adjustArmedRef.current = adjustArmed

  useEffect(() => {
    if (!selected) {
      setAdjustArmed(false)
    }
  }, [selected])

  const isDoubleActivate = useCallback((event, clientX, clientY) => {
    return detectorRef.current.isDouble(event, clientX, clientY)
  }, [])

  const armAdjust = useCallback(() => {
    setAdjustArmed(true)
  }, [])

  const disarmAdjust = useCallback(() => {
    setAdjustArmed(false)
  }, [])

  return {
    adjustArmed,
    adjustArmedRef,
    isDoubleActivate,
    armAdjust,
    disarmAdjust,
  }
}
