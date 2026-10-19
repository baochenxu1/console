function fmtDashFps(v) {
  return v != null && Number.isFinite(Number(v)) ? String(Math.round(Number(v))) : "-"
}

function Stat({ label, value, err }) {
  return (
    <div className={`tp-stat${err ? " tp-stat--err" : ""}`}>
      <span className="tp-stat-k">{label}</span>
      <span className="tp-stat-v">{value}</span>
    </div>
  )
}

/**
 * @param {object} props
 * @param {object} [props.status]
 * @param {string} [props.sourceLabel]
 */
export default function SourceStatusCard({ status = {}, sourceLabel = "camera-mediapipe" }) {
  const st = status
  const pythonFps =
    st.pythonFps != null && Number.isFinite(Number(st.pythonFps)) ? Number(st.pythonFps) : null

  return (
    <section className="tp-card tp-source-status">
      <h4 className="tp-card-title tp-card-title--sm">Source Status</h4>
      <div className="tp-stat-grid">
        <Stat label="source" value={String(st.source || sourceLabel)} />
        <Stat label="running" value={st.running ? "yes" : "no"} />
        <Stat label="faceDetected" value={st.faceDetected ? "yes" : "no"} />
        <Stat label="quality" value={typeof st.quality === "number" ? st.quality.toFixed(2) : "0.00"} />
        <Stat label="tracking FPS" value={fmtDashFps(pythonFps ?? st.fps)} />
        <Stat label="RX" value={fmtDashFps(Number.isFinite(Number(st.rxFps)) ? st.rxFps : st.fps)} />
        <Stat label="error" value={st.error ?? "—"} err={Boolean(st.error)} />
      </div>
    </section>
  )
}
