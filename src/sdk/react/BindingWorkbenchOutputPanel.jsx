import { useMemo } from "react"
import {
  BINDING_OUTPUT_MODE_LABELS,
  BINDING_OUTPUT_MODES,
} from "../output/bindingWorkbench/index.js"
import { filterBindingsForInspector } from "../binding/browTipBindingUi.js"

function fmtInt(v) {
  if (v == null || Number.isNaN(Number(v))) return "—"
  return String(Math.round(Number(v)))
}

function bindingTraceFields(b) {
  if (!b) {
    return null
  }
  return {
    bindingId: b.bindingId,
    controlId: b.controlId,
    channel: b.channel,
    servoId: b.servoId,
    legacyServoIndex: b.legacyServoIndex ?? b.servoId,
    actuatorKey: b.actuatorKey,
    enabled: b.enabled !== false,
  }
}

function GateBanner({ gates, outputMode, driveArmed, busConnected, busFamilyLabel = "Bus" }) {
  const lines = []
  if (outputMode === BINDING_OUTPUT_MODES.PREVIEW) {
    lines.push("Preview Only — 不真实下发")
  } else if (!driveArmed) {
    lines.push("未 Arm — 仅诊断 / dry-run")
  } else if (gates?.canSend) {
    lines.push(`已 Arm · ${BINDING_OUTPUT_MODE_LABELS[outputMode] || outputMode} · 可下发`)
  } else {
    lines.push(gates?.note || gates?.reason || "不可下发")
  }
  lines.push(`${busFamilyLabel}: ${busConnected ? "已连接" : "未连接"}`)
  return (
    <div className="binding-wb-gate-banner">
      {lines.map((l) => (
        <div key={l}>{l}</div>
      ))}
    </div>
  )
}

/**
 * 绑定工作台四层输出诊断：Rig → Binding → Profile → Adapter
 */
export default function BindingWorkbenchOutputPanel({
  workbenchState,
  outputMode,
  driveArmed,
  busSerialConnected,
  busFamilyLabel = "Bus",
  selectedControlId,
  selectedChannel,
  bindings = [],
  rigValues,
  testMode,
  lastDispatch,
  onMarkControlIgnored,
  onUnmarkControlIgnored,
}) {
  const {
    finalServoOutputs = [],
    enrichedOutputs = [],
    adapterPreview,
    gates,
    bindingAnalysis,
    actuatorProfileAnalysis,
  } = workbenchState || {}

  const analysis = bindingAnalysis
  const profileAnalysis = actuatorProfileAnalysis

  const rigRow = useMemo(() => {
    if (!selectedControlId) {
      return null
    }
    const raw = rigValues?.[selectedControlId]?.[selectedChannel]
    return {
      channel: `${selectedControlId}.${selectedChannel}`,
      raw,
    }
  }, [selectedControlId, selectedChannel, rigValues])

  const selectedChannelBindings = useMemo(
    () => filterBindingsForInspector(bindings, selectedControlId, selectedChannel),
    [bindings, selectedControlId, selectedChannel]
  )

  const selectedBindingTrace = useMemo(() => {
    const primary = selectedChannelBindings[0]
    if (!primary) {
      return null
    }
    const normalized = bindingTraceFields(primary)
    const finalOut =
      finalServoOutputs.find((o) => o.bindingId === primary.bindingId) ||
      finalServoOutputs.find((o) => o.actuatorKey === primary.actuatorKey) ||
      null
    const enriched =
      enrichedOutputs.find((o) => o.actuatorKey === primary.actuatorKey) || null
    const busCmd =
      (adapterPreview?.commands || []).find(
        (c) => c.actuatorKey === primary.actuatorKey
      ) || null
    const adapterSkipped = adapterPreview?.skipped?.find(
      (s) => s.actuatorKey === primary.actuatorKey
    )
    const skipped =
      enriched?.profileResolveWarning ||
      adapterSkipped?.reason ||
      (!finalOut && primary.enabled !== false
        ? enriched?.profileResolveReason === "profile-not-found"
          ? "actuator-profile-not-found"
          : "no-final-output"
        : null)

    const adapterDisplay = busCmd
      ? {
          actuatorKey: busCmd.actuatorKey,
          busServoId: busCmd.busServoId,
          protocol: busCmd.protocol,
          targetPosition: busCmd.targetPosition,
          centerMode: busCmd.centerMode,
        }
      : null

    return {
      raw: normalized,
      normalized,
      finalOut,
      enriched,
      busCmd,
      adapterDisplay,
      skipped,
      skippedMessage:
        enriched?.profileResolveWarningMessage ||
        adapterSkipped?.message ||
        null,
    }
  }, [
    selectedChannelBindings,
    finalServoOutputs,
    enrichedOutputs,
    adapterPreview,
  ])

  return (
    <div className="binding-wb-output-panel">
      <GateBanner
        gates={gates}
        outputMode={outputMode}
        driveArmed={driveArmed}
        busConnected={busSerialConnected}
        busFamilyLabel={busFamilyLabel}
      />

      {testMode ? (
        <p className="hint binding-wb-test-hint">
          单控件测试模式：<strong>{testMode}</strong>（仅输出选中 binding 对应 actuator）
        </p>
      ) : null}

      {selectedBindingTrace ? (
        <section className="binding-wb-layer binding-wb-layer--selected-trace">
          <h4>选中 Binding 链路</h4>
          <div className="binding-wb-trace-grid">
            <div>
              <h5>Raw Binding</h5>
              <pre className="binding-wb-json">
                {JSON.stringify(selectedBindingTrace.raw, null, 2)}
              </pre>
            </div>
            <div>
              <h5>Normalized Binding</h5>
              <pre className="binding-wb-json">
                {JSON.stringify(selectedBindingTrace.normalized, null, 2)}
              </pre>
            </div>
            <div>
              <h5>finalServoOutput</h5>
              <pre className="binding-wb-json">
                {selectedBindingTrace.finalOut
                  ? JSON.stringify(selectedBindingTrace.finalOut, null, 2)
                  : `skipped: ${selectedBindingTrace.skipped || "no-output"}`}
              </pre>
            </div>
            <div>
              <h5>Adapter Command</h5>
              <pre className="binding-wb-json">
                {selectedBindingTrace.adapterDisplay
                  ? JSON.stringify(selectedBindingTrace.adapterDisplay, null, 2)
                  : `skipped: ${selectedBindingTrace.skipped || "no-command"}`}
              </pre>
              {selectedBindingTrace.skippedMessage ? (
                <p className="binding-wb-analysis-errors binding-wb-mismatch-warn">
                  {selectedBindingTrace.skippedMessage}
                </p>
              ) : null}
            </div>
          </div>
        </section>
      ) : selectedControlId ? (
        <p className="hint muted">当前通道无 binding，无法展示链路诊断</p>
      ) : null}

      {profileAnalysis && !profileAnalysis.aligned ? (
        <section className="binding-wb-layer binding-wb-layer--profile-mismatch">
          <h4>Actuator Profile 偏移诊断</h4>
          <ul className="binding-wb-analysis-errors">
            {profileAnalysis.mismatches.map((m) => (
              <li key={m.actuatorKey}>{m.message}</li>
            ))}
          </ul>
          <p className="hint">
            当前 actuatorKey 与实际 bus ID 不一致，可能是旧 +1 迁移残留。请使用上方「修复
            actuatorKey 与 bus ID 对齐」按钮。
          </p>
        </section>
      ) : null}

      {analysis ? (
        <section className="binding-wb-layer binding-wb-layer--analysis">
          <h4>绑定配置诊断</h4>
          <ul className="binding-wb-analysis-stats">
            <li>active bindings: {analysis.activeBindings?.length ?? 0}</li>
            <li>disabled bindings: {analysis.disabledBindings?.length ?? 0}</li>
            <li>finalServoOutputs: {finalServoOutputs.length}</li>
            <li>active actuators: {analysis.activeActuatorKeys?.length ?? 0}</li>
          </ul>
          {analysis.errors?.length ? (
            <ul className="binding-wb-analysis-errors">
              {analysis.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          ) : null}
          {analysis.warnings?.length ? (
            <ul className="binding-wb-analysis-warnings">
              {analysis.warnings.slice(0, 12).map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
          {analysis.missingControls?.length ? (
            <div className="binding-wb-missing-controls">
              <span>未绑定控件：</span>
              {analysis.missingControls.map((id) => (
                <span key={id} className="binding-wb-missing-chip">
                  {id}
                  {onMarkControlIgnored ? (
                    <button
                      type="button"
                      className="btn-ghost btn-tiny"
                      onClick={() => onMarkControlIgnored(id)}
                    >
                      暂不使用
                    </button>
                  ) : null}
                </span>
              ))}
            </div>
          ) : null}
          {analysis.ignoredControls?.length ? (
            <div className="binding-wb-ignored-controls">
              <span>已标记暂不使用：</span>
              {analysis.ignoredControls.map((id) => (
                <span key={id} className="binding-wb-ignored-chip">
                  {id}
                  {onUnmarkControlIgnored ? (
                    <button
                      type="button"
                      className="btn-ghost btn-tiny"
                      onClick={() => onUnmarkControlIgnored(id)}
                    >
                      取消
                    </button>
                  ) : null}
                </span>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="binding-wb-layer">
        <h4>Binding 层（active）</h4>
        <div className="binding-wb-scroll">
          <table className="binding-wb-table">
            <thead>
              <tr>
                <th>channel</th>
                <th>actuatorKey</th>
                <th>legacy</th>
                <th>N</th>
                <th>+T</th>
                <th>-T</th>
                <th>en</th>
              </tr>
            </thead>
            <tbody>
              {(analysis?.activeBindings || []).length === 0 ? (
                <tr>
                  <td colSpan={7} className="hint muted">
                    无 active binding
                  </td>
                </tr>
              ) : (
                analysis.activeBindings.map((b) => (
                  <tr key={b.bindingId}>
                    <td>
                      {b.controlId}.{b.channel}
                    </td>
                    <td>{b.actuatorKey}</td>
                    <td>{fmtInt(b.legacyServoIndex ?? b.servoId)}</td>
                    <td>{fmtInt(b.neutralPwm)}</td>
                    <td>{fmtInt(b.positiveTargetPwm)}</td>
                    <td>{fmtInt(b.negativeTargetPwm)}</td>
                    <td>{b.enabled !== false ? "yes" : "no"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {(analysis?.disabledBindings || []).length > 0 ? (
          <p className="hint binding-wb-disabled-note">
            disabled:{" "}
            {analysis.disabledBindings
              .map(
                (b) =>
                  `${b.controlId}.${b.channel}→${b.actuatorKey}${b.disabledReason ? ` (${b.disabledReason})` : ""}`
              )
              .join(" · ")}
          </p>
        ) : null}
      </section>

      <section className="binding-wb-layer">
        <h4>1 · Face Rig</h4>
        {rigRow ? (
          <table className="binding-wb-table">
            <tbody>
              <tr>
                <th>channel</th>
                <td>{rigRow.channel}</td>
              </tr>
              <tr>
                <th>raw</th>
                <td>{fmtInt(rigRow.raw)}</td>
              </tr>
            </tbody>
          </table>
        ) : (
          <p className="hint muted">未选中控件通道</p>
        )}
      </section>

      <section className="binding-wb-layer">
        <h4>2 · finalServoOutputs ({finalServoOutputs.length})</h4>
        <div className="binding-wb-scroll">
          <table className="binding-wb-table">
            <thead>
              <tr>
                <th>actuatorKey</th>
                <th>legacy</th>
                <th>sourceChannel</th>
                <th>logical</th>
                <th>pwm</th>
              </tr>
            </thead>
            <tbody>
              {enrichedOutputs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="hint muted">
                    {finalServoOutputs.length === 0
                      ? "无输出（检查绑定启用与 rig 数值）"
                      : "—"}
                  </td>
                </tr>
              ) : (
                enrichedOutputs.map((o) => (
                  <tr key={o.actuatorKey}>
                    <td>{o.actuatorKey}</td>
                    <td>{fmtInt(o.legacyServoIndex)}</td>
                    <td>{o.sourceChannel ?? "—"}</td>
                    <td>{fmtInt(o.logicalValue)}</td>
                    <td>{fmtInt(o.pwmValue)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="binding-wb-layer">
        <h4>3 · Actuator Profile</h4>
        <div className="binding-wb-scroll">
          <table className="binding-wb-table">
            <thead>
              <tr>
                <th>actuatorKey</th>
                <th>outputType</th>
                <th>busId</th>
                <th>protocol</th>
                <th>centerMode</th>
                <th>instCenter</th>
                <th>enabled</th>
                <th>reason</th>
              </tr>
            </thead>
            <tbody>
              {enrichedOutputs.length === 0 ? (
                <tr>
                  <td colSpan={8} className="hint muted">
                    —
                  </td>
                </tr>
              ) : (
                enrichedOutputs.map((o) => (
                  <tr key={`p-${o.actuatorKey}`}>
                    <td>{o.actuatorKey}</td>
                    <td>{o.outputType ?? "—"}</td>
                    <td>{o.busServoId != null ? fmtInt(o.busServoId) : "—"}</td>
                    <td>{o.protocol ?? "—"}</td>
                    <td>{o.centerMode ?? "—"}</td>
                    <td>
                      {o.installedCenterPosition != null
                        ? fmtInt(o.installedCenterPosition)
                        : "—"}
                    </td>
                    <td>
                      {o.profileResolveReason
                        ? "—"
                        : o.outputType
                          ? "yes"
                          : "—"}
                    </td>
                    <td className="binding-wb-reason">
                      {o.profileResolveWarning === "actuator-bus-id-mismatch"
                        ? `⚠ ${o.profileResolveWarningMessage || "actuator-bus-id-mismatch"}`
                        : o.profileResolveReason === "profile-not-found"
                          ? "actuator-profile-not-found"
                          : o.profileResolveReason === "actuator-disabled"
                            ? "profile-disabled"
                            : o.profileResolveReason || ""}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="binding-wb-layer">
        <h4>4 · Adapter（Bus Servo）</h4>
        <div className="binding-wb-scroll">
          <table className="binding-wb-table">
            <thead>
              <tr>
                <th>actuatorKey</th>
                <th>busId</th>
                <th>protocol</th>
                <th>logical</th>
                <th>targetPos</th>
                <th>clamp</th>
                <th>sent</th>
              </tr>
            </thead>
            <tbody>
              {(adapterPreview?.commands || []).length === 0 ? (
                <tr>
                  <td colSpan={7} className="hint muted">
                    无 bus 命令
                  </td>
                </tr>
              ) : (
                adapterPreview.commands.map((c) => (
                  <tr key={`b-${c.actuatorKey}-${c.busServoId}`}>
                    <td>{c.actuatorKey}</td>
                    <td>{fmtInt(c.busServoId)}</td>
                    <td>{c.protocol}</td>
                    <td>{fmtInt(c.busLogical ?? c.logicalValue)}</td>
                    <td>{fmtInt(c.targetPosition)}</td>
                    <td>{c.isClamped ? "yes" : ""}</td>
                    <td>{lastDispatch?.sent ? "yes" : "dryRun"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {adapterPreview?.commandPreview ? (
            <pre className="binding-wb-cmd-preview">{adapterPreview.commandPreview}</pre>
          ) : null}
          <p className="hint">
            状态：
            {outputMode === BINDING_OUTPUT_MODES.PREVIEW
              ? "Preview Only"
              : lastDispatch?.sent
                ? "已发送"
                : gates?.reason || "dry-run"}
          </p>
        </div>
      </section>
    </div>
  )
}
