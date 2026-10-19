function fmtFps(st) {
  if (st.pythonFps != null && Number.isFinite(Number(st.pythonFps))) {
    return String(Math.round(Number(st.pythonFps)))
  }
  const v = Number.isFinite(Number(st.rxFps)) ? st.rxFps : st.fps
  return v != null && Number.isFinite(Number(v)) ? String(Math.round(Number(v))) : "—"
}

/**
 * 视频画幅角标：source · running · FPS · Face · rx · Q
 * @param {object} props
 * @param {object} [props.status]
 */
export default function VideoStatusHud({ status = {} }) {
  const st = status
  const faceCount = st.faceDetected ? 1 : 0
  const source = st.source && st.source !== "none" ? st.source : "—"
  const running = st.running ? "on" : "off"

  return (
    <div className="tp-viewport-hud" aria-live="polite">
      <span>{source}</span>
      <span className="tp-viewport-hud-sep" aria-hidden>
        •
      </span>
      <span>run:{running}</span>
      <span className="tp-viewport-hud-sep" aria-hidden>
        •
      </span>
      <span>FPS:{fmtFps(st)}</span>
      <span className="tp-viewport-hud-sep" aria-hidden>
        •
      </span>
      <span>Face:{faceCount}</span>
      {Number.isFinite(Number(st.rx)) && Number(st.rx) > 0 ? (
        <>
          <span className="tp-viewport-hud-sep" aria-hidden>
            •
          </span>
          <span>rx:{st.rx}</span>
        </>
      ) : null}
      {typeof st.quality === "number" ? (
        <>
          <span className="tp-viewport-hud-sep" aria-hidden>
            •
          </span>
          <span>Q:{st.quality.toFixed(2)}</span>
        </>
      ) : null}
      {st.error ? <span className="tp-viewport-hud-err">{String(st.error)}</span> : null}
    </div>
  )
}
