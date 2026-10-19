function fmtDashFps(v) {
  return v != null && Number.isFinite(Number(v)) ? String(Math.round(Number(v))) : "-"
}

/**
 * @param {object} props
 * @param {object} [props.status]
 * @param {string} [props.sourceLabel]
 * @param {"footer" | "standalone"} [props.variant]
 */
export default function SourceStatusStrip({ status = {}, sourceLabel = "camera-mediapipe", variant = "footer" }) {
  const st = status
  const fps =
    st.pythonFps != null && Number.isFinite(Number(st.pythonFps))
      ? fmtDashFps(st.pythonFps)
      : fmtDashFps(Number.isFinite(Number(st.rxFps)) ? st.rxFps : st.fps)

  const faceLabel = st.faceDetected ? "detected" : "none"

  return (
    <div
      className={variant === "footer" ? "tp-status-footer" : "tp-source-status-strip"}
      aria-label="Source Status"
    >
      <span>FPS {fps}</span>
      <span>Face {faceLabel}</span>
      <span>Q {typeof st.quality === "number" ? st.quality.toFixed(2) : "—"}</span>
      <span className={st.error ? "tp-status-footer--err" : ""}>
        {st.error ? String(st.error) : "OK"}
      </span>
      <span className="tp-status-footer--muted">{st.source || sourceLabel}</span>
    </div>
  )
}
