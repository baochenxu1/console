import { useLayoutEffect, useRef, useState } from "react"
import {
  FACE_RIG_PREVIEW_REF_WIDTH,
  FACE_RIG_PREVIEW_REF_HEIGHT,
  FACE_RIG_PREVIEW_SAFE_PADDING,
} from "../../trackingPreview/trackingPreviewLayout.js"

/**
 * 撑满视口缩放：scale = min(可用W/baseW, 可用H/baseH)，无 1.0 上限。
 */
export function useFaceRigPreviewScale(remeasureDeps = [], options = {}) {
  const safePadding =
    Number.isFinite(options.safePadding) && options.safePadding >= 0
      ? Number(options.safePadding)
      : FACE_RIG_PREVIEW_SAFE_PADDING
  const containerRef = useRef(/** @type {HTMLDivElement | null} */ (null))
  const contentRef = useRef(/** @type {HTMLDivElement | null} */ (null))
  const [metrics, setMetrics] = useState(() => ({
    baseW: FACE_RIG_PREVIEW_REF_WIDTH,
    baseH: FACE_RIG_PREVIEW_REF_HEIGHT,
    scale: 1,
  }))

  useLayoutEffect(() => {
    const container = containerRef.current
    const content = contentRef.current
    if (!container || !content) {
      return undefined
    }

    const update = () => {
      const cw = container.clientWidth
      const ch = container.clientHeight
      if (cw < 8 || ch < 8) {
        return
      }

      const assembly = content.querySelector(".face-rig-assembly")
      const measureEl = /** @type {HTMLElement} */ (assembly || content)

      const measuredW = Math.ceil(
        measureEl.scrollWidth || measureEl.offsetWidth || FACE_RIG_PREVIEW_REF_WIDTH
      )
      const measuredH = Math.ceil(
        measureEl.scrollHeight || measureEl.offsetHeight || FACE_RIG_PREVIEW_REF_HEIGHT
      )

      const baseW = Math.max(280, measuredW)
      const baseH = Math.max(360, measuredH)

      const containerW = Math.max(0, cw - safePadding)
      const containerH = Math.max(0, ch - safePadding)

      const scaleW = containerW / baseW
      const scaleH = containerH / baseH
      const nextScale = Math.min(scaleW, scaleH)

      setMetrics((prev) => {
        if (
          Math.abs(prev.scale - nextScale) < 0.004 &&
          prev.baseW === baseW &&
          prev.baseH === baseH
        ) {
          return prev
        }
        return { baseW, baseH, scale: nextScale }
      })
    }

    update()
    const ro = new ResizeObserver(() => {
      window.requestAnimationFrame(update)
    })
    ro.observe(container)
    ro.observe(content)
    if (content.firstElementChild) {
      ro.observe(content.firstElementChild)
    }
    return () => ro.disconnect()
  }, [...remeasureDeps, safePadding])

  return {
    containerRef,
    contentRef,
    scale: metrics.scale,
    baseWidth: metrics.baseW,
    baseHeight: metrics.baseH,
  }
}
