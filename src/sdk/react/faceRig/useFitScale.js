import { useLayoutEffect, useRef, useState } from "react"

/**
 * 将内容等比缩放到容器内完整可见（小屏缩小，大屏不超过 1）。
 */
export function useFitScale({ padding = 8, maxScale = 1, minScale = 0.42 } = {}) {
  const containerRef = useRef(/** @type {HTMLDivElement | null} */ (null))
  const contentRef = useRef(/** @type {HTMLDivElement | null} */ (null))
  const [scale, setScale] = useState(1)

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

      const baseW = Math.max(1, content.scrollWidth)
      const baseH = Math.max(1, content.scrollHeight)
      const next = Math.min(
        maxScale,
        Math.max(minScale, Math.min((cw - padding) / baseW, (ch - padding) / baseH))
      )

      setScale((prev) => (Math.abs(prev - next) < 0.004 ? prev : next))
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
  }, [padding, maxScale, minScale])

  return { containerRef, contentRef, scale }
}
