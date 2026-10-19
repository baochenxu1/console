/**
 * 右嘴角 Pad 可达区 Debug 叠加层（坐标：x 右、y 下，50/50 居中，与 Face Rig Pad 一致）。
 *
 * @param {object} props
 * @param {{ points: object[], validCount?: number, invalidCount?: number }} [props.reachabilityMap]
 * @param {ReturnType<import("../kinematics/mouthCornerFivebarDebug.js").evaluateRightMouthPadPoint>} [props.currentEval]
 * @param {number} [props.width]
 * @param {number} [props.height]
 * @param {boolean} [props.showInvalid]
 * @param {boolean} [props.showSafePoint]
 * @param {boolean} [props.showCmdPoint]
 */
export default function RightMouthFiveBarReachabilityOverlay({
  reachabilityMap,
  currentEval,
  width = 100,
  height = 100,
  showInvalid = true,
  showSafePoint = true,
  showCmdPoint = true,
}) {
  const points = reachabilityMap?.points || []
  const pr = currentEval?.padRaw
  const ps = currentEval?.padSafe
  const pc = currentEval?.padCmd

  const showRaw = pr && Number.isFinite(pr.x) && Number.isFinite(pr.y)
  const showSafe =
    showSafePoint && ps && Number.isFinite(ps.x) && Number.isFinite(ps.y)
  const showCmd =
    showCmdPoint && pc && Number.isFinite(pc.x) && Number.isFinite(pc.y)

  const dist = (a, b) => {
    if (!a || !b) {
      return Infinity
    }
    return Math.hypot(a.x - b.x, a.y - b.y)
  }
  const rawToSafe = showRaw && showSafe && dist(pr, ps) > 0.35
  const safeToCmd = showSafe && showCmd && dist(ps, pc) > 0.35

  return (
    <svg
      className="sdk-fivebar-reach-overlay"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      {points.map((p) => {
        if (!showInvalid && !p.rawReachable) {
          return null
        }
        const fill = p.rawReachable ? "rgba(147, 197, 253, 0.45)" : "rgba(253, 186, 116, 0.5)"
        const r = width >= 80 ? 1.2 : 0.9
        return (
          <circle
            key={`${p.padX}-${p.padY}`}
            cx={p.padX}
            cy={p.padY}
            r={r}
            fill={fill}
            stroke="none"
          />
        )
      })}

      {rawToSafe ? (
        <line
          x1={pr.x}
          y1={pr.y}
          x2={ps.x}
          y2={ps.y}
          className="sdk-fivebar-reach-overlay-line sdk-fivebar-reach-overlay-line--raw-safe"
        />
      ) : null}
      {safeToCmd ? (
        <line
          x1={ps.x}
          y1={ps.y}
          x2={pc.x}
          y2={pc.y}
          className="sdk-fivebar-reach-overlay-line sdk-fivebar-reach-overlay-line--safe-cmd"
        />
      ) : null}

      {showSafe ? (
        <circle
          cx={ps.x}
          cy={ps.y}
          r={2.8}
          className="sdk-fivebar-reach-overlay-marker sdk-fivebar-reach-overlay-marker--safe"
        />
      ) : null}
      {showCmd ? (
        <circle
          cx={pc.x}
          cy={pc.y}
          r={2.8}
          className="sdk-fivebar-reach-overlay-marker sdk-fivebar-reach-overlay-marker--cmd"
        />
      ) : null}
      {showRaw ? (
        <circle
          cx={pr.x}
          cy={pr.y}
          r={3.2}
          className="sdk-fivebar-reach-overlay-marker sdk-fivebar-reach-overlay-marker--raw"
        />
      ) : null}
    </svg>
  )
}
