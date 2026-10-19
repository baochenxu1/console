import { useCallback, useEffect, useState } from "react"
import { mapSourcePointToCanvas, measureVideoFrameDebugFromElement, buildVideoFrameDebugFromTrackingDebug, isVideoFrameDebugComplete } from "../../trackingPreview/videoFrameDebug.js"

/**
 * 测量 Video Preview MJPEG 显示变换，供 diagnostic / overlay 使用。
 * @param {import('react').RefObject<HTMLImageElement | null>} imgRef
 * @param {import('react').RefObject<HTMLElement | null>} [containerRef]
 * @param {object | null} [trackingDebug]
 * @param {boolean} [active]
 * @param {(dbg: object | null) => void} [onDebugChange]
 */
export function useVideoFrameDebug(imgRef, containerRef, trackingDebug, active = false, onDebugChange) {
  const [videoFrameDebug, setVideoFrameDebug] = useState(null)

  const remeasure = useCallback(() => {
    if (!active) {
      onDebugChange?.(null)
      setVideoFrameDebug(null)
      return
    }
    const img = imgRef?.current
    const container = containerRef?.current ?? img?.parentElement ?? null
    let dbg = measureVideoFrameDebugFromElement(img, trackingDebug, container)
    if (!isVideoFrameDebugComplete(dbg)) {
      dbg = buildVideoFrameDebugFromTrackingDebug(trackingDebug, dbg) ?? dbg
    }
    onDebugChange?.(dbg)
    setVideoFrameDebug(dbg)
  }, [active, imgRef, containerRef, trackingDebug, onDebugChange])

  useEffect(() => {
    remeasure()
    if (!active) {
      return undefined
    }
    const img = imgRef?.current
    const container = containerRef?.current ?? img?.parentElement
    if (!container && !img) {
      return undefined
    }
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(remeasure) : null
    if (ro) {
      if (container) ro.observe(container)
      if (img) ro.observe(img)
    }
    window.addEventListener("resize", remeasure)
    return () => {
      ro?.disconnect()
      window.removeEventListener("resize", remeasure)
    }
  }, [active, imgRef, containerRef, remeasure])

  return { videoFrameDebug, remeasure, mapSourcePointToCanvas }
}

export { mapSourcePointToCanvas }
