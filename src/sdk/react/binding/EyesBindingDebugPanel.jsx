import { useMemo } from "react"
import { buildEyeBindingDebugRows } from "../../binding/eyeBindingDiagnostics.js"

function fmt(v, digits = 2) {
  if (v == null || Number.isNaN(Number(v))) return "—"
  return Number(v).toFixed(digits)
}

/**
 * 四路眼皮绑定诊断：control → PWM → Bus target，并检测 neutral 偏移。
 */
export default function EyesBindingDebugPanel({
  finalServoOutputs = [],
  bindings = [],
  busCommands = [],
  rigValues = null,
  title = "Eyes Binding Debug",
  compact = false,
}) {
  const rows = useMemo(
    () =>
      buildEyeBindingDebugRows({
        finalServoOutputs,
        bindings,
        busCommands,
        rigValues,
      }),
    [finalServoOutputs, bindings, busCommands, rigValues]
  )

  const warnCount = rows.filter((r) => r.warning).length

  return (
    <div className={`eyes-binding-debug${compact ? " eyes-binding-debug--compact" : ""}`}>
      <h4 className="eyes-binding-debug-title">
        {title}
        {warnCount > 0 ? (
          <span className="eyes-binding-debug-warn-badge"> {warnCount} neutral offset</span>
        ) : null}
      </h4>
      <div className="eyes-binding-debug-table-wrap">
        <table className="eyes-binding-debug-table">
          <thead>
            <tr>
              <th>通道</th>
              <th>control</th>
              <th>neutral</th>
              <th>pwm</th>
              <th>logical</th>
              <th>bus#</th>
              <th>pos</th>
              {!compact ? <th>actuator</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={r.warning ? "eyes-binding-debug-row--warn" : ""}>
                <td title={r.sourceChannel}>{r.label}</td>
                <td>{fmt(r.controlValue, 2)}</td>
                <td>{fmt(r.neutralPwm, 0)}</td>
                <td>{fmt(r.pwmValue, 0)}</td>
                <td>{fmt(r.logicalValue, 1)}</td>
                <td>{r.busServoId ?? "—"}</td>
                <td>{r.targetPosition ?? "—"}</td>
                {!compact ? <td>{r.actuatorKey ?? "—"}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.some((r) => r.warning) ? (
        <p className="hint eyes-binding-debug-hint">
          eye-binding-neutral-offset：控件接近中位但 PWM 远离 1500，请使用「迁移为 Bus Servo 中位语义」。
        </p>
      ) : null}
    </div>
  )
}
