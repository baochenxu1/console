/**
 * Neck Hardware 面板：多 Hardware Backend UI（R3.1 + R4 Browser Runtime）。
 * - luvia-bridge：现有 Runtime / Hardware / Enable 路径
 * - browser-slcan：Web Serial SLCAN + Browser Neck Runtime Host（Worker 100Hz）
 */

import { useEffect, useRef, useState } from "react"
import {
  mapBrowserRuntimePhysicalDebugView,
  mapBrowserSlcanPhysicalDebugView,
  mapNeckPhysicalDebugView,
} from "../neck/neckPhysicalDebug.js"
import {
  HARDWARE_BACKEND_CONFLICT,
  BACKEND_ACTIVE,
  NECK_HARDWARE_BACKEND,
  getDefaultNeckHardwareBackend,
  normalizeNeckHardwareBackend,
  canSwitchNeckHardwareBackend,
} from "../neck/transport/neckHardwareBackend.js"
import {
  BROWSER_MOTOR_CONTROL_R4_HINT,
  BROWSER_MOTOR_CONTROL_R4_HINT_ZH,
  canBrowserRuntimeControl,
  canClearBrowserEstop,
  canCloseBrowserSlcan,
  canConnectLuviaHardware,
  canEnableBrowserMotors,
  canOpenBrowserSlcan,
  canSelectBrowserCanAdapter,
  canSendBrowserSafeDisable,
  formatBrowserCanStatusLabel,
  getBackendSwitchConflict,
  isBrowserMotorControlAvailable,
} from "../neck/transport/neckHardwareBackendUi.js"
import { WEB_SERIAL_CAPABILITY } from "../neck/transport/webSerialCapability.js"

function userFacingError(snapshot) {
  const code = snapshot?.lastErrorObj?.code
  const msg = snapshot?.lastErrorObj?.message || snapshot?.lastError
  if (code === "LOCAL_NETWORK_PERMISSION_DENIED") return "Local Neck access denied"
  if (code === "BRIDGE_NOT_RUNNING") return "Local Neck Bridge not detected."
  if (code === "HARDWARE_NOT_CONNECTED") return "HARDWARE_NOT_CONNECTED"
  if (code === "HARDWARE_CONNECT_FAILED") {
    return msg || "Hardware connect failed."
  }
  if (code === "CHANNEL_REQUIRED") return "请先选择或输入 COM 端口"
  if (snapshot?.uiState === "STALE" || snapshot?.state === "STALE") {
    return "Neck Safe Hold / Stale"
  }
  return msg ? String(msg) : null
}

function DebugRow({ label, value, title }) {
  return (
    <div className="neck-physical-debug-row" title={title || undefined}>
      <span className="neck-physical-debug-label">{label}</span>
      <span className="neck-physical-debug-value">{value}</span>
    </div>
  )
}

export default function NeckBridgePanel({
  snapshot,
  onConnectRuntime,
  onDisconnectRuntime,
  onConnectHardware,
  onDisconnectHardware,
  onRefreshPorts,
  onEnable,
  onDisable,
  onEstop,
  onHold,
  onNeutral,
  onResume,
  hardwarePreview,
  onHardwarePreviewChange,
  disabled = false,
  /** @type {{ state?: string, supported?: boolean, message?: string }|null} */
  browserSerialCapability = null,
  /** @type {object|null} */
  browserSlcanState = null,
  onSelectBrowserCanAdapter = null,
  onOpenBrowserSlcan = null,
  onCloseBrowserSlcan = null,
  onSendBrowserSafeDisable = null,
  neckHardwareBackend = null,
  onNeckHardwareBackendChange = null,
  /** @type {{ code?: string, message?: string }|null} */
  backendSwitchError = null,
  /** @type {number} authorized ports from getPorts() */
  authorizedBrowserPortCount = 0,
  /** @type {object|null} Browser R4 runtime host snapshot */
  browserRuntimeSnapshot = null,
  onLoadBrowserProfile = null,
  onExportBrowserProfile = null,
  onEnableBrowserMotors = null,
  onDisableBrowserMotors = null,
  onBrowserHold = null,
  onBrowserResume = null,
  onBrowserEstop = null,
  onBrowserClearEstop = null,
  onBrowserHardwarePreviewChange = null,
  onEnterNeutralCalibration = null,
  onExitNeutralCalibration = null,
  onNudgeCalibrationOffset = null,
  onSetCalibrationOffset = null,
  onResetCalibrationTrim = null,
  onSaveCalibration = null,
  onCancelCalibration = null,
}) {
  const state = snapshot?.uiState || snapshot?.state || "DISCONNECTED"
  const productionReady = Boolean(snapshot?.productionReady)
  const safetyMode = snapshot?.runtimeSafetyMode || "—"
  const sessionActive = snapshot?.state === "SESSION_ACTIVE" || snapshot?.state === "STALE"
  const runtimeConnected = Boolean(snapshot?.runtimeConnected ?? sessionActive)
  const hardwareConnected = Boolean(snapshot?.hardwareConnected)
  const canResume = snapshot?.state === "STALE"
  const errText = userFacingError(snapshot)
  const access = snapshot?.access || {}
  const dbg = mapNeckPhysicalDebugView(snapshot?.neckState)
  const browserDbg = mapBrowserSlcanPhysicalDebugView(browserSlcanState)
  const runtimeDbg = mapBrowserRuntimePhysicalDebugView(browserRuntimeSnapshot)
  const ports = Array.isArray(snapshot?.hardwarePorts) ? snapshot.hardwarePorts : []
  const channelFromState = snapshot?.hardwareChannel || ""

  const [portDraft, setPortDraft] = useState(channelFromState || "")
  const [portsHint, setPortsHint] = useState("")
  const [calibrationOpen, setCalibrationOpen] = useState(false)
  const [side1Draft, setSide1Draft] = useState("")
  const [side2Draft, setSide2Draft] = useState("")
  const profileFileRef = useRef(null)

  useEffect(() => {
    if (channelFromState && !portDraft) setPortDraft(channelFromState)
  }, [channelFromState, portDraft])

  const backend = normalizeNeckHardwareBackend(
    neckHardwareBackend || getDefaultNeckHardwareBackend()
  )
  const isBrowser = backend === NECK_HARDWARE_BACKEND.BROWSER_SLCAN
  const isLuvia = backend === NECK_HARDWARE_BACKEND.LUVIA_BRIDGE

  const browserReady = Boolean(
    browserSlcanState?.slcanReady || browserSlcanState?.state === "READY"
  )
  const browserTransportState = browserSlcanState?.state || "CLOSED"
  const backendConflict = getBackendSwitchConflict({
    backend,
    browserSlcanReady: browserReady,
    browserTransportState,
    bridgeHardwareConnected: hardwareConnected,
  })

  const capState = browserSerialCapability?.state || WEB_SERIAL_CAPABILITY.UNSUPPORTED
  const capSupported = Boolean(browserSerialCapability?.supported)

  const selectEnabled =
    typeof onSelectBrowserCanAdapter === "function" &&
    canSelectBrowserCanAdapter({
      backend,
      webSerialSupported: capSupported,
      transportState: browserTransportState,
      disabled,
      bridgeHardwareConnected: hardwareConnected,
    })
  const openEnabled =
    typeof onOpenBrowserSlcan === "function" &&
    canOpenBrowserSlcan({
      backend,
      webSerialSupported: capSupported,
      portSelected: Boolean(browserSlcanState?.portSelected),
      transportState: browserTransportState,
      disabled,
      bridgeHardwareConnected: hardwareConnected,
    })
  const closeEnabled =
    typeof onCloseBrowserSlcan === "function" &&
    canCloseBrowserSlcan({
      backend,
      transportState: browserTransportState,
      disabled,
    })
  const safeDisableEnabled =
    typeof onSendBrowserSafeDisable === "function" &&
    canSendBrowserSafeDisable({
      backend,
      transportState: browserTransportState,
      slcanReady: browserReady,
      profileValid: Boolean(
        browserRuntimeSnapshot?.profile?.loaded || browserRuntimeSnapshot?.gates?.profileValid
      ),
      disabled,
    })

  const connectHwEnabled = canConnectLuviaHardware({
    backend,
    sessionActive,
    hardwareConnected,
    browserSlcanReady: browserReady,
    browserTransportState,
    disabled,
  })

  const enableBlockedReason = !sessionActive
    ? "需要 Runtime 已连接"
    : !hardwareConnected
      ? "HARDWARE_NOT_CONNECTED"
      : null

  const browserStatusLabel = formatBrowserCanStatusLabel(browserTransportState, {
    supported: capSupported,
    capabilityState: capState,
  })

  const portInfo = browserSlcanState?.portInfo
  const serialLine = browserSlcanState
    ? `${browserSlcanState.baudRate ?? 115200} ${browserSlcanState.dataBits ?? 8}${String(browserSlcanState.parity || "none")[0]?.toUpperCase() || "N"}${browserSlcanState.stopBits ?? 1}`
    : "115200 8N1"
  const canLine = `FD 1M/5M · BRS ${browserSlcanState?.brs ? "ON" : "OFF"}`

  const runtimeHostPresent = Boolean(browserRuntimeSnapshot) || typeof onEnableBrowserMotors === "function"
  const runtimeEnabled = Boolean(browserRuntimeSnapshot?.enabled)
  const runtimeEstop = Boolean(
    browserRuntimeSnapshot?.estop || browserRuntimeSnapshot?.estopLatched
  )
  const profileValid = Boolean(browserRuntimeSnapshot?.profile?.loaded || browserRuntimeSnapshot?.gates?.profileValid)
  const profileReady = browserRuntimeSnapshot?.profileReady !== false
  const workerReady = Boolean(browserRuntimeSnapshot?.workerReady ?? browserRuntimeSnapshot?.gates?.workerReady)
  const calPreview = browserRuntimeSnapshot?.calibration || {}
  const calActive = Boolean(browserRuntimeSnapshot?.calibratingNeutral || calPreview.active)
  const motorControlAvailable = isBrowserMotorControlAvailable({ runtimeHostReady: runtimeHostPresent })

  const switchFromBrowser = canSwitchNeckHardwareBackend({
    from: NECK_HARDWARE_BACKEND.BROWSER_SLCAN,
    to: NECK_HARDWARE_BACKEND.LUVIA_BRIDGE,
    browserTransportState,
    browserSlcanReady: browserReady,
    browserRuntimeEnabled: runtimeEnabled,
    browserCalibrating: calActive,
    browserEstop: runtimeEstop,
  })
  const switchFromLuvia = canSwitchNeckHardwareBackend({
    from: NECK_HARDWARE_BACKEND.LUVIA_BRIDGE,
    to: NECK_HARDWARE_BACKEND.BROWSER_SLCAN,
    bridgeHardwareConnected: hardwareConnected,
  })
  const canSelectLuviaBackend =
    isLuvia ||
    (typeof onNeckHardwareBackendChange === "function" && switchFromBrowser.ok)
  const canSelectBrowserBackend =
    isBrowser ||
    (typeof onNeckHardwareBackendChange === "function" && switchFromLuvia.ok)

  const enableMotorsEnabled =
    typeof onEnableBrowserMotors === "function" &&
    canEnableBrowserMotors({
      backend,
      transportReady: browserReady,
      profileValid,
      profileReady,
      workerReady,
      estop: runtimeEstop,
      backendConflict: backendConflict.conflict,
      calibrating: calActive,
      disabled,
    })
  const disableMotorsEnabled =
    typeof onDisableBrowserMotors === "function" &&
    canBrowserRuntimeControl({
      backend,
      runtimeHostPresent,
      disabled,
    })
  const holdEnabled =
    typeof onBrowserHold === "function" &&
    canBrowserRuntimeControl({
      backend,
      runtimeHostPresent,
      disabled,
      requireEnabled: true,
      enabled: runtimeEnabled,
      calibrating: calActive,
      blockWhileCalibrating: true,
    })
  const resumeEnabled =
    typeof onBrowserResume === "function" &&
    canBrowserRuntimeControl({
      backend,
      runtimeHostPresent,
      disabled,
      requireEnabled: true,
      enabled: runtimeEnabled || Boolean(browserRuntimeSnapshot?.stale),
      calibrating: calActive,
      blockWhileCalibrating: true,
    })
  const estopEnabled =
    typeof onBrowserEstop === "function" &&
    canBrowserRuntimeControl({
      backend,
      runtimeHostPresent,
      disabled,
    })
  const clearEstopEnabled =
    typeof onBrowserClearEstop === "function" &&
    canClearBrowserEstop({
      backend,
      runtimeHostPresent,
      estopLatched: runtimeEstop,
      transportReady: browserReady,
      calibrating: calActive,
      disabled,
    })

  const profileSummary = browserRuntimeSnapshot?.profile
  const offsetsLine = profileSummary?.mapping
    ? `s1=${profileSummary.mapping.side1OffsetDeg ?? 0} s2=${profileSummary.mapping.side2OffsetDeg ?? 0}`
    : "—"

  const cal = calPreview
  const calDirty = Boolean(cal.dirty)
  const calStatus = cal.status || "IDLE"
  const workingSide1 = Number(cal.workingOffsets?.side1 ?? 0)
  const workingSide2 = Number(cal.workingOffsets?.side2 ?? 0)
  const calEnterEnabled =
    typeof onEnterNeutralCalibration === "function" &&
    !disabled &&
    runtimeEnabled &&
    !runtimeEstop &&
    !calActive &&
    profileValid
  const calExitEnabled =
    typeof onExitNeutralCalibration === "function" && !disabled && calActive
  const calEditEnabled =
    calActive && !disabled && typeof onNudgeCalibrationOffset === "function"

  function confirmDiscardUnsaved(actionLabel) {
    if (!calDirty) return true
    if (typeof window === "undefined" || typeof window.confirm !== "function") return true
    return window.confirm(
      `有未保存的软件中性标定（UNSAVED）。确定要${actionLabel}并丢弃更改吗？`
    )
  }

  function handleCloseBrowser() {
    if (!confirmDiscardUnsaved("Close")) return
    void onCloseBrowserSlcan?.()
  }

  function handleDisableMotors() {
    if (!confirmDiscardUnsaved("Disable Motors")) return
    void onDisableBrowserMotors?.()
  }

  function handleCancelCalibration() {
    if (calDirty && !confirmDiscardUnsaved("Cancel Calibration")) return
    void onCancelCalibration?.()
  }

  function handleExitCalibration() {
    if (calDirty && !confirmDiscardUnsaved("Exit Calibration")) return
    void onExitNeutralCalibration?.({ discardUnsaved: calDirty })
  }

  return (
    <div className="neck-bridge-panel" aria-label="Neck Hardware">
      <div className="neck-bridge-panel-row">
        <strong>Neck Hardware</strong>
        <span className={`neck-bridge-state neck-bridge-state--${String(state).toLowerCase()}`}>
          {isBrowser ? browserStatusLabel : state}
        </span>
      </div>

      <div className="neck-hw-backend" aria-label="Hardware Backend">
        <div className="neck-bridge-panel-row">
          <strong>Hardware Backend</strong>
        </div>
        <div className="neck-hw-backend-seg" role="radiogroup" aria-label="Hardware Backend selector">
          <button
            type="button"
            role="radio"
            aria-checked={isLuvia}
            className={`neck-hw-backend-btn${isLuvia ? " is-active" : ""}`}
            disabled={
              disabled ||
              typeof onNeckHardwareBackendChange !== "function" ||
              (!isLuvia && !canSelectLuviaBackend)
            }
            title={
              !isLuvia && !switchFromBrowser.ok
                ? switchFromBrowser.message || BACKEND_ACTIVE
                : undefined
            }
            onClick={() => onNeckHardwareBackendChange?.(NECK_HARDWARE_BACKEND.LUVIA_BRIDGE)}
          >
            Luvia Bridge
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={isBrowser}
            className={`neck-hw-backend-btn${isBrowser ? " is-active" : ""}`}
            disabled={
              disabled ||
              typeof onNeckHardwareBackendChange !== "function" ||
              (!isBrowser && !canSelectBrowserBackend)
            }
            title={
              !isBrowser && !switchFromLuvia.ok
                ? switchFromLuvia.message || BACKEND_ACTIVE
                : undefined
            }
            onClick={() => onNeckHardwareBackendChange?.(NECK_HARDWARE_BACKEND.BROWSER_SLCAN)}
          >
            Browser CAN
          </button>
        </div>
        <div className="neck-bridge-hint">
          Active: {backend}
          {isLuvia ? " · default Character hardware path" : " · Browser Native Runtime R4"}
        </div>
        {backendSwitchError ? (
          <div className="neck-bridge-error" role="alert">
            {backendSwitchError.code || BACKEND_ACTIVE}: {backendSwitchError.message}
          </div>
        ) : null}
      </div>

      {backendConflict.conflict ? (
        <div className="neck-bridge-error" role="alert">
          {HARDWARE_BACKEND_CONFLICT}: {backendConflict.message}
          <div className="neck-bridge-hint">不自动切换/关闭另一 backend — 请显式 Disconnect / Close。</div>
        </div>
      ) : null}

      <details className="neck-physical-debug" open>
        <summary>Physical Debug · 真机状态</summary>
        <div className="neck-physical-debug-body" aria-label="Neck Physical Debug (read-only)">
          <DebugRow label="Active Backend" value={backend} />
          {isBrowser ? (
            <>
              <div className="neck-physical-debug-section">Browser Transport</div>
              <DebugRow label="state" value={browserDbg.state} />
              <DebugRow label="serialOpen" value={browserDbg.serialOpen} />
              <DebugRow label="slcanReady" value={browserDbg.slcanReady} />
              <DebugRow label="portSelected" value={browserDbg.portSelected} />
              <DebugRow label="usbVendorId" value={browserDbg.usbVendorId} />
              <DebugRow label="usbProductId" value={browserDbg.usbProductId} />
              <DebugRow label="canMode" value={browserDbg.canMode} />
              <DebugRow label="brs" value={browserDbg.brs} />
              <DebugRow label="baudRate" value={browserDbg.baudRate} />
              <DebugRow label="txFrameCount" value={browserDbg.txFrameCount} />
              <DebugRow label="rxFrameCount" value={browserDbg.rxFrameCount} />
              <DebugRow label="txByteCount" value={browserDbg.txByteCount} />
              <DebugRow label="rxByteCount" value={browserDbg.rxByteCount} />
              <DebugRow label="lastTxFrame" value={browserDbg.lastTxFrame} />
              <DebugRow label="lastRxFrame" value={browserDbg.lastRxFrame} />
              <DebugRow label="lastError" value={browserDbg.lastError} />
              <div className="neck-physical-debug-section">Browser Runtime</div>
              <DebugRow label="runtimeState" value={runtimeDbg.runtimeState} />
              <DebugRow label="enabled" value={runtimeDbg.enabled} />
              <DebugRow label="estop" value={runtimeDbg.estop} />
              <DebugRow label="stale" value={runtimeDbg.stale} />
              <DebugRow label="workerRunning" value={runtimeDbg.workerRunning} />
              <DebugRow label="tickHz" value={runtimeDbg.tickHz} />
              <DebugRow label="tickCount" value={runtimeDbg.tickCount} />
              <DebugRow label="jitterMean" value={runtimeDbg.jitterMean} />
              <DebugRow label="jitterP95" value={runtimeDbg.jitterP95} />
              <DebugRow label="missedTickCount" value={runtimeDbg.missedTickCount} />
              <DebugRow label="safetyLimited" value={runtimeDbg.safetyLimited} />
              <DebugRow label="safetyReason" value={runtimeDbg.safetyReason} />
              <DebugRow label="physicalTxCount" value={runtimeDbg.physicalTxCount} />
              <DebugRow label="lastWriteOk" value={runtimeDbg.lastWriteOk} />
              <DebugRow label="profileName" value={runtimeDbg.profileName} />
              <DebugRow label="profileVersion" value={runtimeDbg.profileVersion} />
              <div className="neck-physical-debug-section">Software Neutral Calibration</div>
              <DebugRow label="calibratingNeutral" value={runtimeDbg.calibratingNeutral} />
              <DebugRow label="calibrationStatus" value={runtimeDbg.calibrationStatus} />
              <DebugRow label="persistedOffsets" value={runtimeDbg.persistedOffsets} />
              <DebugRow label="workingOffsets" value={runtimeDbg.workingOffsets} />
            </>
          ) : (
            <>
              <div className="neck-physical-debug-section">Luvia Bridge</div>
              <DebugRow label="Connected" value={dbg.connected} />
              <DebugRow label="Enabled" value={dbg.enabled} />
              <DebugRow label="Streaming" value={dbg.streaming} />
              <DebugRow
                label="Hardware Exec"
                value={dbg.hardwareExec}
                title="CAD/production readiness diagnostic — not EXTERNAL_DIRECT commissioning TX gate"
              />
              <div className="neck-physical-debug-hint">
                Hardware Exec = CAD/production diagnostic（非 commissioning 真机 TX 硬门）
              </div>
              <div className="neck-physical-debug-section">Target</div>
              <DebugRow label="P" value={dbg.targetPitch} />
              <DebugRow label="R" value={dbg.targetRoll} />
              <DebugRow label="Y" value={dbg.targetYaw} />
              <DebugRow label="Command Loop Ticks" value={dbg.commandLoopTicks} />
              <DebugRow label="Last 0x32" value={dbg.last0x32} />
              <div className="neck-physical-debug-section">Transport</div>
              <DebugRow label="virtual" value={dbg.transportVirtual} />
              <DebugRow label="channel" value={dbg.transportChannel} />
              <div className="neck-physical-debug-section">Safety</div>
              <DebugRow label="limited" value={dbg.safetyLimited} />
              <DebugRow label="reason" value={dbg.safetyReason} />
              <div className="neck-physical-debug-section">Joints</div>
              <DebugRow label="ID1 online/enabled" value={dbg.joint1} />
              <DebugRow label="ID2 online/enabled" value={dbg.joint2} />
              <DebugRow label="ID3 online/enabled" value={dbg.joint3} />
              <div className="neck-physical-debug-section">Target Dispatch (FaceDEV)</div>
              <DebugRow
                label="Prepared"
                value={
                  snapshot?.targetDiagnostics?.targetPreparedCount != null
                    ? String(snapshot.targetDiagnostics.targetPreparedCount)
                    : "—"
                }
              />
              <DebugRow
                label="Send Attempts"
                value={
                  snapshot?.targetDiagnostics?.targetSendAttemptCount != null
                    ? String(snapshot.targetDiagnostics.targetSendAttemptCount)
                    : "—"
                }
              />
              <DebugRow
                label="Sent"
                value={
                  snapshot?.targetDiagnostics?.targetSentCount != null
                    ? String(snapshot.targetDiagnostics.targetSentCount)
                    : "—"
                }
              />
              <DebugRow
                label="Last Sequence"
                value={
                  snapshot?.targetDiagnostics?.lastTargetSequence != null
                    ? String(snapshot.targetDiagnostics.lastTargetSequence)
                    : "—"
                }
              />
              <DebugRow
                label="Last Timeline"
                value={
                  snapshot?.targetDiagnostics?.lastTargetTimelineTimeMs != null
                    ? String(snapshot.targetDiagnostics.lastTargetTimelineTimeMs)
                    : "—"
                }
              />
              <DebugRow
                label="Last Sent Pose P/R/Y"
                value={
                  snapshot?.targetDiagnostics?.lastTargetPose
                    ? `${Number(snapshot.targetDiagnostics.lastTargetPose.pitch || 0).toFixed(2)} / ${Number(snapshot.targetDiagnostics.lastTargetPose.roll || 0).toFixed(2)} / ${Number(snapshot.targetDiagnostics.lastTargetPose.yaw || 0).toFixed(2)}`
                    : "—"
                }
              />
              <DebugRow
                label="Dispatch Decision"
                value={snapshot?.lastTargetDispatchDecision || "—"}
              />
              <DebugRow
                label="Dispatch Reason"
                value={snapshot?.lastTargetDispatchReason || "—"}
              />
              <DebugRow
                label="Dispatch Source"
                value={snapshot?.lastTargetDispatchSource || "—"}
              />
            </>
          )}
        </div>
      </details>

      {isLuvia ? (
        <>
          <div className="neck-conn-layers" aria-label="Connection layers">
            <div className="neck-conn-layer">
              <span className="neck-conn-layer-label">Runtime</span>
              <span className={runtimeConnected ? "is-on" : "is-off"}>
                {runtimeConnected ? "Connected" : "Disconnected"}
              </span>
              <span className="neck-conn-layer-hint">Browser ↔ Bridge</span>
            </div>
            <div className="neck-conn-layer">
              <span className="neck-conn-layer-label">Hardware</span>
              <span className={hardwareConnected ? "is-on" : "is-off"}>
                {hardwareConnected ? "Connected" : "Disconnected"}
              </span>
              <span className="neck-conn-layer-hint">Bridge ↔ COM / CANable</span>
            </div>
          </div>

          <div className="neck-bridge-panel-row neck-bridge-access" title="HTTP / WS 独立诊断">
            <span>health:{access.health || "—"}</span>
            <span>caps:{access.capabilities || "—"}</span>
            <span>ws:{access.websocket || "—"}</span>
          </div>
          <div className="neck-bridge-panel-row neck-bridge-safety">
            <span className={productionReady ? "is-prod" : "is-commissioning"}>
              {productionReady ? "PRODUCTION READY" : safetyMode || "COMMISSIONING_OPEN_LOOP"}
            </span>
            {!productionReady ? (
              <span className="neck-bridge-hint">非生产就绪 · Enable 需显式操作</span>
            ) : null}
          </div>
          {snapshot?.actualPoseUnavailable !== false ? (
            <div className="neck-bridge-panel-row">
              <span className="neck-bridge-actual-warn">actualPose unavailable</span>
            </div>
          ) : null}
          {snapshot?.visibilityState ? (
            <div className="neck-bridge-panel-row neck-bridge-vis">
              <span>visibility:{snapshot.visibilityState}</span>
              <span>
                hbAge:
                {snapshot.lastHeartbeatSendAgeMs != null
                  ? `${Math.round(snapshot.lastHeartbeatSendAgeMs)}ms`
                  : "—"}
              </span>
            </div>
          ) : null}

          <div className="neck-hw-connect" aria-label="Hardware connection">
            <div className="neck-bridge-panel-row">
              <strong>Hardware Connection</strong>
            </div>
            <label className="neck-hw-port-row">
              <span>Port</span>
              <select
                className="neck-hw-port-select"
                disabled={disabled || !sessionActive}
                value={ports.includes(portDraft) ? portDraft : ""}
                onChange={(e) => setPortDraft(e.target.value)}
              >
                <option value="">— select —</option>
                {ports.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <input
                className="neck-hw-port-input"
                type="text"
                placeholder="COMxx"
                disabled={disabled || !sessionActive}
                value={portDraft}
                onChange={(e) => setPortDraft(e.target.value)}
                aria-label="COM port"
              />
              <button
                type="button"
                className="btn-secondary"
                disabled={disabled || !sessionActive}
                onClick={() => {
                  void (async () => {
                    const r = await onRefreshPorts?.()
                    if (r && r.ok === false) {
                      setPortsHint("端口列表不可用 · 请手动输入 COM")
                    } else {
                      setPortsHint(r?.ports?.length ? `${r.ports.length} ports` : "无端口 · 可手动输入")
                    }
                  })()
                }}
              >
                Refresh Ports
              </button>
            </label>
            {portsHint ? <div className="neck-bridge-hint">{portsHint}</div> : null}
            <div className="neck-bridge-panel-actions">
              <button
                type="button"
                className="btn-secondary"
                disabled={!connectHwEnabled}
                onClick={() => void onConnectHardware?.(portDraft.trim())}
                title={
                  backendConflict.blockBridgeHardware
                    ? backendConflict.message
                    : "Connect Luvia Bridge ↔ COM"
                }
              >
                Connect Hardware
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={disabled || !sessionActive || !hardwareConnected}
                onClick={() => void onDisconnectHardware?.()}
              >
                Disconnect Hardware
              </button>
            </div>
          </div>

          <div className="neck-bridge-panel-actions">
            <button type="button" className="btn-secondary" disabled={disabled} onClick={onConnectRuntime}>
              Connect Runtime
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={disabled}
              onClick={onDisconnectRuntime}
            >
              Disconnect Runtime
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={disabled || !canResume}
              onClick={onResume}
              title="Stale 后显式恢复 target 流"
            >
              Resume Neck
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={disabled || !sessionActive || !hardwareConnected}
              onClick={onEnable}
              title={enableBlockedReason || "Enable motors (after Hardware Connected)"}
            >
              Enable
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={disabled || !sessionActive}
              onClick={onDisable}
            >
              Disable
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={disabled || !sessionActive}
              onClick={onEstop}
            >
              ESTOP
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={disabled || !sessionActive}
              onClick={onHold}
            >
              Hold
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={disabled || !sessionActive}
              onClick={onNeutral}
            >
              Neutral
            </button>
          </div>
          {enableBlockedReason && sessionActive ? (
            <div className="neck-bridge-hint">Enable 需先 Connect Hardware · {enableBlockedReason}</div>
          ) : null}
          <label className="neck-bridge-hw-preview">
            <input
              type="checkbox"
              checked={Boolean(hardwarePreview)}
              disabled={disabled}
              onChange={(e) => onHardwarePreviewChange?.(e.target.checked)}
            />
            <span>Hardware Preview ON = 手动拖动下发；Timeline Playback 不依赖此项</span>
          </label>
          {errText ? (
            <div className="neck-bridge-error" role="alert">
              {errText}
              {(snapshot?.lastErrorObj?.code === "LOCAL_NETWORK_PERMISSION_DENIED" ||
                snapshot?.lastErrorObj?.code === "BRIDGE_NOT_RUNNING") && (
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={disabled}
                  onClick={onConnectRuntime}
                >
                  Retry
                </button>
              )}
            </div>
          ) : null}
        </>
      ) : null}

      {isBrowser ? (
        <div className="neck-browser-slcan" aria-label="Browser CAN">
          <div className="neck-bridge-panel-row">
            <strong>Browser CAN</strong>
            <span className="neck-bridge-hint">Web Serial · no localhost Runtime</span>
          </div>
          <div className="neck-bridge-panel-row">
            <span>
              Status: <strong>{browserStatusLabel}</strong>
            </span>
            <span>
              Transport: {browserTransportState}
              {browserReady ? " · slcanReady" : ""}
            </span>
          </div>
          <div className="neck-bridge-panel-row">
            <span>
              Runtime:{" "}
              <strong>
                {motorControlAvailable
                  ? browserRuntimeSnapshot?.state || "Ready"
                  : "NOT AVAILABLE"}
              </strong>
            </span>
            <span>
              {runtimeEnabled ? "ENABLED" : "motors off"}
              {runtimeEstop ? " · ESTOP" : ""}
              {browserRuntimeSnapshot?.stale ? " · STALE" : ""}
            </span>
          </div>
          <div className="neck-bridge-hint">{BROWSER_MOTOR_CONTROL_R4_HINT}</div>
          <div className="neck-bridge-hint">{BROWSER_MOTOR_CONTROL_R4_HINT_ZH}</div>
          {!capSupported ? (
            <div className="neck-bridge-error" role="status">
              Unsupported Browser — Web Serial unavailable. Luvia Bridge backend 仍可用。
            </div>
          ) : null}
          {authorizedBrowserPortCount > 0 && !browserReady ? (
            <div className="neck-bridge-hint">
              Authorized Adapter Available ({authorizedBrowserPortCount}) · 不自动 Open
            </div>
          ) : null}
          {browserSlcanState?.portSelected ? (
            <div className="neck-bridge-panel-row neck-bridge-hint">
              Port selected
              {portInfo?.usbVendorId != null
                ? ` · VID 0x${Number(portInfo.usbVendorId).toString(16)}`
                : ""}
              {portInfo?.usbProductId != null
                ? ` PID 0x${Number(portInfo.usbProductId).toString(16)}`
                : ""}
            </div>
          ) : null}
          {browserReady ? (
            <div className="neck-bridge-panel-row">
              <span>Serial: {serialLine}</span>
              <span>CAN: {canLine}</span>
            </div>
          ) : null}
          {profileSummary?.loaded ? (
            <div className="neck-bridge-panel-row neck-bridge-hint" aria-label="Profile summary">
              <span>
                Profile: {profileSummary.name || "—"} · {profileSummary.version || "—"}
              </span>
              <span>
                proto={profileSummary.motorProtocol?.type || "—"} · transport=
                {profileSummary.transport?.can?.mode || profileSummary.transport?.type || "—"} ·
                offsets {offsetsLine}
              </span>
            </div>
          ) : (
            <div className="neck-bridge-hint">Load Profile JSON before Enable Motors</div>
          )}
          {browserSlcanState?.lastError ? (
            <div className="neck-bridge-hint" role="status">
              lastError: {browserSlcanState.lastError.code || ""}{" "}
              {browserSlcanState.lastError.message || ""}
            </div>
          ) : null}
          {browserRuntimeSnapshot?.lastError ? (
            <div className="neck-bridge-hint" role="status">
              runtimeError: {browserRuntimeSnapshot.lastError.code || ""}{" "}
              {browserRuntimeSnapshot.lastError.message || ""}
            </div>
          ) : null}
          <div className="neck-bridge-panel-actions">
            <button
              type="button"
              className="btn-secondary"
              disabled={!selectEnabled}
              onClick={() => void onSelectBrowserCanAdapter?.()}
              title="User gesture: navigator.serial.requestPort"
            >
              Select CAN Adapter
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={!openEnabled}
              onClick={() => void onOpenBrowserSlcan?.()}
              title={
                backendConflict.blockBrowserOpen
                  ? backendConflict.message
                  : "Open Serial + SLCAN session"
              }
            >
              Open
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={!closeEnabled}
              onClick={handleCloseBrowser}
            >
              Close
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={!safeDisableEnabled}
              onClick={() => void onSendBrowserSafeDisable?.()}
              title="Development-only: protocol adapter DISABLE → sendFrame (explicit click)"
            >
              Send Safe Disable
            </button>
          </div>
          <div className="neck-bridge-panel-actions">
            <input
              ref={profileFileRef}
              type="file"
              accept="application/json,.json"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ""
                if (!file || typeof onLoadBrowserProfile !== "function") return
                const reader = new FileReader()
                reader.onload = () => {
                  void onLoadBrowserProfile(String(reader.result || ""))
                }
                reader.readAsText(file)
              }}
            />
            <button
              type="button"
              className="btn-secondary"
              disabled={disabled || typeof onLoadBrowserProfile !== "function"}
              onClick={() => profileFileRef.current?.click()}
              title="Load NeckRuntimeProfile JSON"
            >
              Load Profile
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={disabled || typeof onExportBrowserProfile !== "function" || !profileValid}
              onClick={() => onExportBrowserProfile?.()}
              title="Export current NeckRuntimeProfile JSON"
            >
              Export Profile
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={!enableMotorsEnabled}
              onClick={() => void onEnableBrowserMotors?.()}
              title={
                enableMotorsEnabled
                  ? "Enable Motors (commissioning sequence)"
                  : "Requires transport READY + valid profile + worker ready + no conflict/ESTOP"
              }
            >
              Enable Motors
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={!disableMotorsEnabled}
              onClick={handleDisableMotors}
            >
              Disable Motors
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={!holdEnabled}
              onClick={() => void onBrowserHold?.()}
            >
              Hold
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={!resumeEnabled}
              onClick={() => void onBrowserResume?.()}
            >
              Resume
            </button>
            <button
              type="button"
              className="btn-danger"
              disabled={!estopEnabled}
              onClick={() => void onBrowserEstop?.()}
              title="Highest priority ESTOP"
            >
              ESTOP
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={!clearEstopEnabled}
              onClick={() => void onBrowserClearEstop?.()}
              title="Clear ESTOP latch → DISABLED (does not auto Enable)"
            >
              Clear ESTOP
            </button>
          </div>
          <label className="neck-bridge-panel-row">
            <input
              type="checkbox"
              checked={Boolean(browserRuntimeSnapshot?.hardwarePreview)}
              disabled={disabled || typeof onBrowserHardwarePreviewChange !== "function" || calActive}
              onChange={(e) => onBrowserHardwarePreviewChange?.(e.target.checked)}
            />
            <span>Hardware Preview ON = 手动拖动下发（Browser Runtime）</span>
          </label>
          <div className="neck-bridge-hint">
            Timeline Play + ENABLED → Browser Runtime offerTarget（不经 Luvia Bridge）· 默认 backend 仍为
            luvia-bridge
          </div>

          <details
            className="neck-mechanical-neutral-cal"
            open={calibrationOpen || calActive}
            onToggle={(e) => setCalibrationOpen(e.currentTarget.open)}
          >
            <summary>Mechanical Neutral Calibration</summary>
            <div className="neck-bridge-hint">
              仅软件安装偏置（mapping.side*.offsetDeg）· Yaw 无安装偏置 · 禁止固件绝对零点 / FLASH
            </div>
            <div className="neck-bridge-panel-row">
              <span>
                Status: <strong>{calStatus}</strong>
                {calDirty ? " · UNSAVED" : ""}
                {calActive ? " · ACTIVE" : ""}
              </span>
              <span>limit ±{cal.limitDeg ?? 20}°</span>
            </div>
            <div className="neck-bridge-panel-actions">
              <button
                type="button"
                className="btn-secondary"
                disabled={!calEnterEnabled}
                onClick={() => void onEnterNeutralCalibration?.()}
              >
                Enter Calibration
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={!calExitEnabled}
                onClick={handleExitCalibration}
              >
                Exit
              </button>
            </div>
            <div className="neck-cal-side" aria-label="Side 1 software offset">
              <div className="neck-bridge-panel-row">
                <strong>Side 1 (Motor 2, Sign -1)</strong>
                <span>{workingSide1.toFixed(2)}°</span>
              </div>
              <div className="neck-bridge-panel-actions">
                {[-0.5, -0.1, 0.1, 0.5].map((d) => (
                  <button
                    key={`s1-${d}`}
                    type="button"
                    className="btn-secondary"
                    disabled={!calEditEnabled}
                    onClick={() => onNudgeCalibrationOffset?.("side1", d)}
                  >
                    {d > 0 ? `+${d}` : String(d)}
                  </button>
                ))}
                <input
                  type="number"
                  step="0.1"
                  value={side1Draft === "" ? workingSide1 : side1Draft}
                  disabled={!calEditEnabled || typeof onSetCalibrationOffset !== "function"}
                  onChange={(e) => setSide1Draft(e.target.value)}
                  onBlur={() => {
                    if (side1Draft === "") return
                    const v = Number(side1Draft)
                    setSide1Draft("")
                    if (Number.isFinite(v)) onSetCalibrationOffset?.("side1", v)
                  }}
                  aria-label="Side 1 offset degrees"
                  style={{ width: "4.5rem" }}
                />
              </div>
            </div>
            <div className="neck-cal-side" aria-label="Side 2 software offset">
              <div className="neck-bridge-panel-row">
                <strong>Side 2 (Motor 1, Sign +1)</strong>
                <span>{workingSide2.toFixed(2)}°</span>
              </div>
              <div className="neck-bridge-panel-actions">
                {[-0.5, -0.1, 0.1, 0.5].map((d) => (
                  <button
                    key={`s2-${d}`}
                    type="button"
                    className="btn-secondary"
                    disabled={!calEditEnabled}
                    onClick={() => onNudgeCalibrationOffset?.("side2", d)}
                  >
                    {d > 0 ? `+${d}` : String(d)}
                  </button>
                ))}
                <input
                  type="number"
                  step="0.1"
                  value={side2Draft === "" ? workingSide2 : side2Draft}
                  disabled={!calEditEnabled || typeof onSetCalibrationOffset !== "function"}
                  onChange={(e) => setSide2Draft(e.target.value)}
                  onBlur={() => {
                    if (side2Draft === "") return
                    const v = Number(side2Draft)
                    setSide2Draft("")
                    if (Number.isFinite(v)) onSetCalibrationOffset?.("side2", v)
                  }}
                  aria-label="Side 2 offset degrees"
                  style={{ width: "4.5rem" }}
                />
              </div>
            </div>
            <div className="neck-bridge-panel-actions">
              <button
                type="button"
                className="btn-secondary"
                disabled={!calEditEnabled || typeof onSaveCalibration !== "function"}
                onClick={() => void onSaveCalibration?.()}
              >
                Save Calibration
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={!calEditEnabled || typeof onCancelCalibration !== "function"}
                onClick={handleCancelCalibration}
              >
                Cancel Calibration
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={!calEditEnabled || typeof onResetCalibrationTrim !== "function"}
                onClick={() => void onResetCalibrationTrim?.()}
                title="Reset software trim working offsets to 0/0"
              >
                Reset Software Trim
              </button>
            </div>
            {cal.lastError ? (
              <div className="neck-bridge-hint" role="status">
                calError: {cal.lastError.code || ""} {cal.lastError.message || ""}
              </div>
            ) : null}
          </details>
        </div>
      ) : null}
    </div>
  )
}
