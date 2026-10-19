const DRAG_CAPTURE = true

/**
 * 拖动会话。同时挂 pointer + mouse（兼容层），但对同一坐标帧去重，避免双倍 setState。
 */
export function attachDragSession({ onMove, onEnd }) {
  const root = typeof document !== "undefined" ? document : window

  let lastCx = NaN
  let lastCy = NaN
  let lastTs = -1

  const move = (e) => {
    if (e.type === "touchmove") {
      e.preventDefault()
    }
    let cx = e.clientX
    let cy = e.clientY
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
      const t = e.touches?.[0] ?? e.changedTouches?.[0]
      if (t) {
        cx = t.clientX
        cy = t.clientY
      }
    }
    const ts = typeof e.timeStamp === "number" ? e.timeStamp : Date.now()
    /* pointer + mouse 常成对到达：同坐标且间隔极短则丢弃第二次 */
    if (
      Number.isFinite(cx) &&
      Number.isFinite(cy) &&
      cx === lastCx &&
      cy === lastCy &&
      ts - lastTs < 8
    ) {
      return
    }
    if (Number.isFinite(cx) && Number.isFinite(cy)) {
      lastCx = cx
      lastCy = cy
      lastTs = ts
    }
    onMove?.(e)
  }
  let ended = false
  const end = () => {
    if (ended) {
      return
    }
    ended = true
    root.removeEventListener("mousemove", move, DRAG_CAPTURE)
    root.removeEventListener("mouseup", end, DRAG_CAPTURE)
    root.removeEventListener("pointermove", move, DRAG_CAPTURE)
    root.removeEventListener("pointerup", end, DRAG_CAPTURE)
    root.removeEventListener("pointercancel", end, DRAG_CAPTURE)
    root.removeEventListener("touchend", end, DRAG_CAPTURE)
    root.removeEventListener("touchcancel", end, DRAG_CAPTURE)
    root.removeEventListener("touchmove", move, DRAG_CAPTURE)
    if (typeof window !== "undefined") {
      window.removeEventListener("blur", end)
    }
    onEnd?.()
  }

  root.addEventListener("pointermove", move, DRAG_CAPTURE)
  root.addEventListener("pointerup", end, DRAG_CAPTURE)
  root.addEventListener("pointercancel", end, DRAG_CAPTURE)
  root.addEventListener("mousemove", move, DRAG_CAPTURE)
  root.addEventListener("mouseup", end, DRAG_CAPTURE)
  root.addEventListener("touchmove", move, { capture: DRAG_CAPTURE, passive: false })
  root.addEventListener("touchend", end, DRAG_CAPTURE)
  root.addEventListener("touchcancel", end, DRAG_CAPTURE)

  if (typeof window !== "undefined") {
    window.addEventListener("blur", end)
  }
}

export function tryCapturePointer(target, nativeEvent) {
  const ne = nativeEvent
  const id = typeof ne?.pointerId === "number" ? ne.pointerId : undefined

  if (id !== undefined && typeof target?.setPointerCapture === "function") {
    try {
      target.setPointerCapture(id)
    } catch {
      //
    }
  }
}
