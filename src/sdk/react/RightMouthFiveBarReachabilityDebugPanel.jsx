import { useState } from "react"
import RightMouthFiveBarReachabilityOverlay from "./RightMouthFiveBarReachabilityOverlay.jsx"
import { useRightMouthPadFiveBarDebug } from "../hooks/useRightMouthPadFiveBarDebug.js"

function fmt2(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) {
    return "—"
  }
  return Number(v).toFixed(2)
}

function fmtPt(p) {
  if (!p || !Array.isArray(p) || p.length < 2) {
    return "—"
  }
  return `[${fmt2(p[0])}, ${fmt2(p[1])}]`
}

function fmtPad(p) {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
    return "—"
  }
  return `${fmt2(p.x)} / ${fmt2(p.y)}`
}

function DiagRow({ label, value }) {
  return (
    <div className="sdk-fivebar-test-row">
      <span className="sdk-fivebar-test-k">{label}</span>
      <span className="sdk-fivebar-test-v">{value}</span>
    </div>
  )
}

/**
 * @param {object} props
 * @param {object} props.profile
 * @param {object[]} [props.configs]
 * @param {{ x: number, y: number }} props.pad
 * @param {boolean} [props.compact]
 */
export default function RightMouthFiveBarReachabilityDebugPanel({
  profile,
  configs = [],
  pad,
  compact = false,
}) {
  const [showFkMap, setShowFkMap] = useState(false)
  const debug = useRightMouthPadFiveBarDebug({
    profile,
    configs,
    pad,
    enabled: true,
    outputMode: "static-target",
    mapStep: 2,
  })
  const ev = debug.currentEval
  const map = debug.reachabilityMap

  if (!debug.resolved.enabled) {
    return <p className="sdk-servo-inspector-hint">右嘴角五杆 IK 未启用。</p>
  }
  if (!debug.resolved.readyForIk) {
    return (
      <p className="sdk-servo-inspector-hint">
        {debug.resolved.skipReason || "绑定未就绪"}
      </p>
    )
  }

  return (
    <div className={`sdk-fivebar-reach-debug ${compact ? "sdk-fivebar-reach-debug--compact" : ""}`}>
      <h4 className="sdk-servo-inspector-subtitle">Right Mouth FiveBar Reachability Debug</h4>
      <div className="sdk-fivebar-reach-debug-grid">
        <div className="sdk-fivebar-reach-debug-readout">
          <DiagRow label="rawReachable" value={ev ? String(ev.rawReachable) : "—"} />
          <DiagRow label="scale" value={fmt2(ev?.scale)} />
          <DiagRow label="padRaw" value={fmtPad(ev?.padRaw)} />
          <DiagRow label="padSafe" value={fmtPad(ev?.padSafe)} />
          <DiagRow label="padCmd" value={fmtPad(ev?.padCmd)} />
          <DiagRow label="DRaw" value={fmtPt(ev?.DRaw)} />
          <DiagRow label="DSafe" value={fmtPt(ev?.DSafe)} />
          <DiagRow label="DCmd" value={fmtPt(ev?.DCmd)} />
          <DiagRow
            label="qRaw A/B（°）"
            value={
              ev?.qRaw ? `${fmt2(ev.qRaw.qA_deg)} / ${fmt2(ev.qRaw.qB_deg)}` : "—"
            }
          />
          <DiagRow
            label="qSend A/B（°）"
            value={
              ev?.qSend ? `${fmt2(ev.qSend.qA_deg)} / ${fmt2(ev.qSend.qB_deg)}` : "—"
            }
          />
          <DiagRow
            label="logicalPwm A/B"
            value={`${ev?.logicalPwmA ?? "—"} / ${ev?.logicalPwmB ?? "—"}`}
          />
          <DiagRow
            label="actualPwm A/B"
            value={`${ev?.actualPwmA ?? "—"} / ${ev?.actualPwmB ?? "—"}`}
          />
          {ev?.message ? <p className="sdk-servo-inspector-hint">{ev.message}</p> : null}
          {map ? (
            <p className="sdk-servo-inspector-hint">
              可达图：valid {map.validCount} / invalid {map.invalidCount}（step=2）
            </p>
          ) : null}
          <div className="sdk-fivebar-reach-debug-fk-actions">
            <button
              type="button"
              className="btn-ghost btn-tiny"
              disabled={debug.fkProjectionBusy}
              onClick={() => {
                setShowFkMap(true)
                debug.rebuildFkProjection()
              }}
            >
              {debug.fkProjectionBusy ? "生成 FK 投影…" : "生成 FK→Pad 投影图"}
            </button>
          </div>
        </div>
        <div className="sdk-fivebar-reach-debug-mini-pad">
          <div className="sdk-fivebar-reach-debug-mini-pad-inner">
            <RightMouthFiveBarReachabilityOverlay
              reachabilityMap={map}
              currentEval={ev}
              width={100}
              height={100}
            />
            <span className="sdk-fivebar-reach-legend sdk-fivebar-reach-legend--valid">可达</span>
            <span className="sdk-fivebar-reach-legend sdk-fivebar-reach-legend--invalid">不可达</span>
            <span className="sdk-fivebar-reach-legend sdk-fivebar-reach-legend--raw">目标</span>
            <span className="sdk-fivebar-reach-legend sdk-fivebar-reach-legend--safe">clamp</span>
            <span className="sdk-fivebar-reach-legend sdk-fivebar-reach-legend--cmd">命令</span>
          </div>
        </div>
      </div>
      {showFkMap && debug.fkProjectionMap ? (
        <p className="sdk-servo-inspector-hint">
          FK 投影：成功 {debug.fkProjectionMap.fkSuccessCount}，失败{" "}
          {debug.fkProjectionMap.fkFailCount}，Pad 内{" "}
          {debug.fkProjectionMap.fkInsidePadPoints.length} 点
        </p>
      ) : null}
    </div>
  )
}
