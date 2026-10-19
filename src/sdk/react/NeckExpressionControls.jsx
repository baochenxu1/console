/**
 * Product-level Neck controls embedded under mouth section.
 * Presentation only — authority remains BrowserNeckRuntimeHost / transport / project modules.
 *
 * Views: control | settings | calibration
 * Module OFF still shows controls (read-only), like a soft lock.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  NECK_SEMANTIC_LIMITS_FALLBACK,
  createNeutralNeckPose,
  normalizeNeckPose,
} from "../neck/neckPose.js"
import {
  getNeckSettingsGates,
  getNeckDeviceStatusLabel,
  getNeckConnectionStatusText,
  getNeckConnectionPillTone,
} from "../neck/product/neckProductUiGates.js"
import FaceRealtimePreviewToggle from "./FaceRealtimePreviewToggle.jsx"

export {
  getNeckSettingsGates,
  getNeckDeviceStatusLabel,
  getNeckConnectionStatusText,
  getNeckConnectionPillTone,
} from "../neck/product/neckProductUiGates.js"

/** Extensible calibration channel list (yaw reserved for future). */
export const NECK_CALIBRATION_CHANNELS = Object.freeze([
  Object.freeze({ id: "side1", label: "Side 1", hint: "Motor 2 · Sign −1" }),
  Object.freeze({ id: "side2", label: "Side 2", hint: "Motor 1 · Sign +1" }),
])

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n))
}

/** @typedef {"control"|"settings"|"calibration"} NeckView */

/**
 * @param {object} props
 */
export default function NeckExpressionControls({
  moduleEnabled = false,
  onModuleEnabledChange,
  neckPose,
  onNeckChange,
  limits = NECK_SEMANTIC_LIMITS_FALLBACK,
  timelinePlaying = false,
  runtimeSnapshot = null,
  transportState = null,
  onConnectNeck,
  onDisconnectNeck,
  onEnableMotors,
  onDisableMotors,
  onEstop,
  onClearEstop,
  onEnterCalibration,
  onExitCalibration,
  onNudgeCalibration,
  onResetCalibrationTrim,
  onSaveCalibration,
  onCancelCalibration,
  hardwarePreview = false,
  onHardwarePreviewChange,
  connectBusy = false,
  connectError = null,
  onNotify = null,
}) {
  /** @type {[NeckView, Function]} */
  const [neckView, setNeckView] = useState("control")
  const padRef = useRef(null)

  const pose = normalizeNeckPose(neckPose, { limits })
  const pitchLim = limits.pitch || NECK_SEMANTIC_LIMITS_FALLBACK.pitch
  const rollLim = limits.roll || NECK_SEMANTIC_LIMITS_FALLBACK.roll
  const yawLim = limits.yaw || NECK_SEMANTIC_LIMITS_FALLBACK.yaw

  const editBlocked = !moduleEnabled || timelinePlaying
  const transportReady = Boolean(
    transportState?.slcanReady || transportState?.state === "READY"
  )
  const motorsEnabled = Boolean(runtimeSnapshot?.enabled)
  const estop = Boolean(runtimeSnapshot?.estop || runtimeSnapshot?.estopLatched)
  const cal = runtimeSnapshot?.calibration || {}
  const calActive = Boolean(runtimeSnapshot?.calibratingNeutral || cal.active)
  const calDirty = Boolean(cal.dirty)
  const limitDeg = Number(cal.limitDeg ?? 30)
  const hostState = String(runtimeSnapshot?.state || "")

  const settingsGates = useMemo(
    () =>
      getNeckSettingsGates({
        transportReady,
        motorsEnabled,
        estop,
        calibrating: calActive,
      }),
    [transportReady, motorsEnabled, estop, calActive]
  )

  const deviceLabel = useMemo(
    () =>
      getNeckDeviceStatusLabel({
        moduleEnabled,
        transportReady,
        motorsEnabled,
        estop,
        hostState,
      }),
    [moduleEnabled, transportReady, motorsEnabled, estop, hostState]
  )

  const connectionStatusText = useMemo(
    () =>
      getNeckConnectionStatusText({
        moduleEnabled,
        transportReady,
        motorsEnabled,
        estop,
        hardwarePreview,
      }),
    [moduleEnabled, transportReady, motorsEnabled, estop, hardwarePreview]
  )

  const connectionPillTone = useMemo(
    () =>
      getNeckConnectionPillTone({
        moduleEnabled,
        transportReady,
        motorsEnabled,
        estop,
        hostState,
      }),
    [moduleEnabled, transportReady, motorsEnabled, estop, hostState]
  )

  useEffect(() => {
    if (!moduleEnabled) setNeckView("control")
  }, [moduleEnabled])

  useEffect(() => {
    if (calActive) setNeckView("calibration")
  }, [calActive])

  useEffect(() => {
    if (neckView === "calibration" && !calActive && !motorsEnabled) {
      setNeckView("control")
    }
  }, [neckView, calActive, motorsEnabled])

  const emit = useCallback(
    (patch) => {
      if (editBlocked) return
      onNeckChange?.(normalizeNeckPose({ ...pose, ...patch }, { limits }))
    },
    [editBlocked, onNeckChange, pose, limits]
  )

  const applyPadPointer = useCallback(
    (clientX, clientY) => {
      if (editBlocked) return
      const el = padRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const nx = clamp((clientX - rect.left) / Math.max(rect.width, 1), 0, 1)
      const ny = clamp((clientY - rect.top) / Math.max(rect.height, 1), 0, 1)
      const roll = rollLim.min + nx * (rollLim.max - rollLim.min)
      const pitch = pitchLim.max - ny * (pitchLim.max - pitchLim.min)
      emit({ roll, pitch })
    },
    [editBlocked, emit, pitchLim, rollLim]
  )

  const onPadDown = useCallback(
    (e) => {
      if (editBlocked) return
      e.currentTarget.setPointerCapture?.(e.pointerId)
      applyPadPointer(e.clientX, e.clientY)
      const move = (ev) => applyPadPointer(ev.clientX, ev.clientY)
      const up = () => {
        window.removeEventListener("pointermove", move)
        window.removeEventListener("pointerup", up)
      }
      window.addEventListener("pointermove", move)
      window.addEventListener("pointerup", up)
    },
    [editBlocked, applyPadPointer]
  )

  const rollN = (pose.roll - rollLim.min) / Math.max(rollLim.max - rollLim.min, 1e-6)
  const pitchN = (pitchLim.max - pose.pitch) / Math.max(pitchLim.max - pitchLim.min, 1e-6)

  function confirmDiscard(label) {
    if (!calDirty) return true
    if (typeof window === "undefined" || typeof window.confirm !== "function") return true
    return window.confirm(`有未保存的软件中性标定。确定要${label}并丢弃更改吗？`)
  }

  function enterCalibration() {
    if (!settingsGates.showCalibration) return
    const r = onEnterCalibration?.()
    if (r && r.ok === false) return
    setNeckView("calibration")
  }

  function exitCalibration(discard) {
    if (discard && !confirmDiscard("退出标定")) return
    onExitCalibration?.({ discardUnsaved: Boolean(discard && calDirty) })
    setNeckView("control")
  }

  function handleCloseModule() {
    if (!settingsGates.canCloseModule) {
      onNotify?.("请先失能电机并断开 Neck，再关闭模块")
      return
    }
    onModuleEnabledChange?.(false)
    setNeckView("control")
  }

  const activeView = calActive || neckView === "calibration" ? "calibration" : neckView
  const neutralDisabled = editBlocked || !transportReady
  const estopClickable = Boolean(motorsEnabled || estop)
  const previewToggleable = Boolean(moduleEnabled && transportReady && motorsEnabled && !estop)

  return (
    <section
      className={`neck-expression-controls is-view-${activeView}${
        !moduleEnabled ? " is-module-off" : ""
      }`}
      data-neck-view={activeView}
      data-module-enabled={moduleEnabled ? "1" : "0"}
      aria-label="Neck"
    >
      <header
        className={`neck-expression-header${
          activeView === "control" ? " neck-expression-header--control" : ""
        }`}
      >
        {activeView === "control" ? (
          <>
            <div className="neck-expression-header-side is-start">
              <span
                className={`neck-expression-pill neck-expression-pill--capsule is-${connectionPillTone}`}
                data-testid="neck-connection-pill"
              >
                <span className="neck-expression-pill-dot" aria-hidden="true" />
                <span className="neck-expression-pill-label">{deviceLabel}</span>
              </span>
            </div>
            <div className="neck-expression-header-center">
              <span className="neck-expression-pad-label">Pitch / Roll</span>
            </div>
            <div className="neck-expression-header-side is-end">
              {moduleEnabled ? (
                <button
                  type="button"
                  className="btn-secondary neck-expression-btn neck-expression-btn--caution"
                  disabled={timelinePlaying || !settingsGates.canCloseModule}
                  title={
                    settingsGates.canCloseModule
                      ? "关闭 Neck"
                      : "请先失能电机并断开 Neck"
                  }
                  onClick={handleCloseModule}
                >
                  关闭 Neck
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-secondary neck-expression-btn"
                  disabled={timelinePlaying}
                  onClick={() => onModuleEnabledChange?.(true)}
                >
                  启用 Neck
                </button>
              )}
              <button
                type="button"
                className="btn-secondary neck-expression-btn"
                disabled={timelinePlaying || !moduleEnabled}
                onClick={() => setNeckView("settings")}
              >
                设置
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="neck-expression-header-left">
              <h4 className="neck-expression-title">
                {activeView === "settings" ? "Neck 设置" : "Neck"}
              </h4>
              {calDirty && activeView === "calibration" ? (
                <span className="neck-expression-pill is-warn">未保存</span>
              ) : null}
            </div>
            <div className="neck-expression-header-actions">
              {activeView === "settings" ? (
                <button
                  type="button"
                  className="btn-secondary neck-expression-btn"
                  onClick={() => setNeckView("control")}
                >
                  返回
                </button>
              ) : null}
            </div>
          </>
        )}
      </header>

      {activeView === "control" ? (
        <div className="neck-expression-connection-block">
          <p
            className={`neck-expression-connection-status is-${connectionPillTone}`}
            role="status"
          >
            {connectionStatusText}
          </p>
          <FaceRealtimePreviewToggle
            className="neck-expression-hardware-preview"
            label="硬件预览"
            title={
              previewToggleable
                ? "开启后，拖动 Pad / 时间轴 scrub 会下发到 Neck 硬件"
                : !moduleEnabled
                  ? "请先启用 Neck"
                  : !transportReady
                    ? "请先连接 Neck"
                    : !motorsEnabled
                      ? "请先使能电机"
                      : estop
                        ? "ESTOP 锁存中不可预览"
                        : "硬件预览暂不可用"
            }
            checked={hardwarePreview}
            disabled={!previewToggleable || timelinePlaying}
            onChange={(on) => onHardwarePreviewChange?.(on)}
          />
        </div>
      ) : null}

      {connectError ? (
        <div className="neck-expression-error" role="alert">
          {connectError}
        </div>
      ) : null}

      {estop && activeView !== "calibration" ? (
        <div className="neck-expression-estop-banner" role="status">
          <span>ESTOP 已锁存</span>
          <button
            type="button"
            className="btn-secondary neck-expression-btn"
            onClick={() => onClearEstop?.()}
          >
            清除 ESTOP
          </button>
        </div>
      ) : null}

      {activeView === "settings" ? (
        <div className="neck-expression-settings" data-testid="neck-settings-view">
          <p className="neck-expression-settings-status">当前状态：{deviceLabel}</p>
          {settingsGates.showCalibration ? (
            <button
              type="button"
              className="btn-secondary neck-expression-btn"
              disabled={timelinePlaying}
              onClick={() => enterCalibration()}
            >
              机械中位标定
            </button>
          ) : (
            <p className="neck-expression-calib-hint">
              机械中位标定需设备已连接且电机已使能
            </p>
          )}
        </div>
      ) : null}

      {activeView === "calibration" ? (
        <div
          className="neck-expression-calib"
          data-testid="neck-calibration-view"
          aria-label="机械中位标定"
        >
          <button
            type="button"
            className="btn-secondary neck-expression-btn"
            onClick={() => exitCalibration(true)}
          >
            ← 机械中位标定
          </button>
          <p className="neck-expression-calib-hint">
            仅软件安装偏置 · limit ±{limitDeg}° · 禁止固件绝对零点
          </p>
          {NECK_CALIBRATION_CHANNELS.map((ch) => {
            const working = Number(cal.workingOffsets?.[ch.id] ?? 0)
            const atMin = working <= -limitDeg + 1e-9
            const atMax = working >= limitDeg - 1e-9
            return (
              <div key={ch.id} className="neck-expression-calib-channel">
                <div className="neck-expression-calib-channel-head">
                  <strong>
                    {ch.label}
                    {atMin ? " · 已达下限" : atMax ? " · 已达上限" : ""}
                  </strong>
                  <span>{working.toFixed(2)}°</span>
                </div>
                <span className="neck-expression-calib-hint">{ch.hint}</span>
                <div className="neck-expression-calib-nudge">
                  {[-0.5, -0.1, 0.1, 0.5].map((d) => {
                    const blocked = (d < 0 && atMin) || (d > 0 && atMax)
                    return (
                      <button
                        key={`${ch.id}-${d}`}
                        type="button"
                        className="btn-secondary neck-expression-btn neck-expression-btn--nudge"
                        disabled={blocked || timelinePlaying}
                        onClick={() => onNudgeCalibration?.(ch.id, d)}
                      >
                        {d > 0 ? `+${d}` : String(d)}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
          <div className="neck-expression-actions neck-expression-actions--calib">
            <button
              type="button"
              className="btn-secondary neck-expression-btn neck-expression-btn--caution"
              disabled={timelinePlaying}
              onClick={() => onResetCalibrationTrim?.()}
            >
              重置 Trim
            </button>
            <button
              type="button"
              className="btn-secondary neck-expression-btn"
              disabled={timelinePlaying}
              onClick={() => {
                if (!confirmDiscard("取消")) return
                onCancelCalibration?.()
                setNeckView("control")
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="btn-primary neck-expression-btn"
              disabled={timelinePlaying}
              onClick={() => {
                void Promise.resolve(onSaveCalibration?.()).then((r) => {
                  if (r && r.ok === false) return
                  // Save keeps offsets; leave calibration session so control resumes cleanly.
                  onExitCalibration?.({ discardUnsaved: false })
                  setNeckView("control")
                })
              }}
            >
              保存
            </button>
          </div>
        </div>
      ) : null}

      {activeView === "control" ? (
        <div className="neck-expression-column" data-testid="neck-control-view">
          <div className={`neck-expression-body${editBlocked ? " is-locked" : ""}`}>
            <div
              className={`neck-expression-pad${editBlocked ? " is-disabled" : ""}`}
              ref={padRef}
              onPointerDown={onPadDown}
              role="presentation"
              title="Pitch / Roll（上=抬头，右=右倾）"
              aria-label="Pitch / Roll"
            >
              <span className="neck-expression-pad-cross" />
              <span
                className="neck-expression-pad-knob"
                style={{ left: `${rollN * 100}%`, top: `${pitchN * 100}%` }}
              />
            </div>
            <div className="neck-expression-pose-meta">
              <span>P {pose.pitch.toFixed(1)}°</span>
              <span>R {pose.roll.toFixed(1)}°</span>
              {!moduleEnabled ? (
                <span className="neck-expression-lock-tag">模块未启用</span>
              ) : null}
            </div>
            <label className="neck-expression-yaw">
              <span className="neck-expression-yaw-label">Yaw</span>
              <input
                type="range"
                min={yawLim.min}
                max={yawLim.max}
                step={0.5}
                disabled={editBlocked}
                value={pose.yaw}
                onChange={(e) => emit({ yaw: Number(e.target.value) })}
              />
              <span className="neck-expression-yaw-value">{pose.yaw.toFixed(1)}°</span>
            </label>
          </div>

          <div className="neck-expression-actions neck-expression-actions--primary">
            <button
              type="button"
              className="btn-secondary neck-expression-btn"
              disabled={neutralDisabled}
              title={
                !moduleEnabled
                  ? "请先启用 Neck"
                  : !transportReady
                    ? "未连接时不可回中"
                    : undefined
              }
              onClick={() => emit(createNeutralNeckPose())}
            >
              回中
            </button>
            {!transportReady ? (
              <button
                type="button"
                className="btn-primary neck-expression-btn"
                disabled={
                  !moduleEnabled ||
                  timelinePlaying ||
                  connectBusy ||
                  typeof onConnectNeck !== "function"
                }
                onClick={() => void onConnectNeck?.()}
              >
                {connectBusy ? "连接中…" : "连接 Neck"}
              </button>
            ) : (
              <button
                type="button"
                className="btn-secondary neck-expression-btn"
                disabled={!moduleEnabled || timelinePlaying || typeof onDisconnectNeck !== "function"}
                onClick={() => {
                  if (!confirmDiscard("断开")) return
                  void onDisconnectNeck?.()
                }}
              >
                断开 Neck
              </button>
            )}
            {transportReady && motorsEnabled ? (
              <button
                type="button"
                className="btn-secondary neck-expression-btn neck-expression-btn--disable"
                disabled={!moduleEnabled || timelinePlaying || typeof onDisableMotors !== "function"}
                onClick={() => {
                  if (!confirmDiscard("失能电机")) return
                  onDisableMotors?.()
                }}
              >
                失能电机
              </button>
            ) : (
              <button
                type="button"
                className="btn-secondary neck-expression-btn neck-expression-btn--enable"
                disabled={
                  !moduleEnabled ||
                  !transportReady ||
                  estop ||
                  timelinePlaying ||
                  typeof onEnableMotors !== "function"
                }
                onClick={() => void onEnableMotors?.()}
              >
                使能电机
              </button>
            )}
          </div>
          <div className="neck-expression-actions neck-expression-actions--estop">
            <button
              type="button"
              className="btn-danger neck-expression-btn neck-expression-btn--estop"
              disabled={!estopClickable || (timelinePlaying && !estop)}
              title={!estopClickable ? "电机使能后可急停" : "ESTOP"}
              onClick={() => onEstop?.()}
            >
              急停
            </button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
