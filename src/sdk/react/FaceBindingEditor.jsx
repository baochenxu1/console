import { useEffect, useMemo, useState } from "react"
import FaceBindingInspector from "./FaceBindingInspector.jsx"
import FaceRigControls from "./FaceRigControls.jsx"
import BindingWorkbenchOutputPanel from "./BindingWorkbenchOutputPanel.jsx"
import EyesBindingDebugPanel from "./binding/EyesBindingDebugPanel.jsx"
import ServoOutputInspector from "./ServoOutputInspector.jsx"
import {
  BINDING_OUTPUT_MODES,
  normalizeBindingOutputMode,
} from "../output/bindingWorkbench/index.js"
import "../style.css"

const RAIL_OUTPUT_MODES = [BINDING_OUTPUT_MODES.BUS_SERVO]

function profileWorkspaceFingerprint(profile) {
  if (!profile) return ""
  return JSON.stringify({
    name: profile.name ?? "",
    bindings: profile.bindings ?? [],
  })
}

/** 高级操作确认弹窗文案（结构统一：标题 / 说明 / 确认按钮） */
function buildAdvancedConfirm(kind, bindingCount) {
  if (kind === "migrate") {
    return {
      title: "迁移为 Bus Servo 中位语义",
      lines: [
        "将当前绑定迁移为 Bus Servo 中位语义：",
        "• 补齐 actuatorKey",
        "• active binding 的 neutralPwm 归一到 1500（保留相对行程）",
        "• 默认禁用 tongue / servo_11",
        "机械零点仍由 actuator profile 的 installed_center 管理。",
      ],
      confirmLabel: "确认迁移",
      danger: false,
    }
  }
  if (kind === "resetProfile") {
    return {
      title: "恢复默认映射",
      lines: [
        "将用默认绑定替换当前配置，并立即写入本地。",
        "现有自定义绑定会丢失，且不可自动撤销。",
      ],
      confirmLabel: "确认恢复",
      danger: true,
    }
  }
  return {
    title: "清除全部绑定",
    lines: [
      `将清除当前全部 ${bindingCount} 条绑定，并立即写入本地。`,
      "不会自动恢复默认绑定；需自行新增绑定或恢复默认映射。",
      "嘴角五杆运行时基线也会一并清除。",
    ],
    confirmLabel: "确认清除",
    danger: true,
  }
}

/**
 * 面部绑定工作台：FaceRigControls + 绑定检视 + finalServoOutputs 诊断与输出。
 */
export default function FaceBindingEditor({ configs = [], rigApi }) {
  const rig = rigApi

  const outputMode = useMemo(() => {
    const mode = normalizeBindingOutputMode(rig.outputMode)
    return RAIL_OUTPUT_MODES.includes(mode) ? mode : BINDING_OUTPUT_MODES.BUS_SERVO
  }, [rig.outputMode])

  useEffect(() => {
    if (!RAIL_OUTPUT_MODES.includes(rig.outputMode)) {
      rig.setOutputMode(BINDING_OUTPUT_MODES.BUS_SERVO)
    }
  }, [rig.outputMode, rig.setOutputMode])

  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
  const [confirmKind, setConfirmKind] = useState(null)
  const [savedFingerprint, setSavedFingerprint] = useState(() =>
    profileWorkspaceFingerprint(rig.normalizedProfile)
  )

  useEffect(() => {
    function onDocClick() {
      setWorkspaceMenuOpen(false)
    }
    document.addEventListener("click", onDocClick)
    return () => document.removeEventListener("click", onDocClick)
  }, [])

  const currentFingerprint = profileWorkspaceFingerprint(rig.normalizedProfile)
  const hasUnsaved = currentFingerprint !== savedFingerprint
  const bindingCount = (rig.normalizedProfile?.bindings || []).length
  const confirmCopy = confirmKind ? buildAdvancedConfirm(confirmKind, bindingCount) : null

  useEffect(() => {
    const s = String(rig.sendStatus || "")
    if (
      s.includes("已导入") ||
      s.includes("已清除全部") ||
      s.includes("已迁移为 Bus Servo")
    ) {
      setSavedFingerprint(profileWorkspaceFingerprint(rig.normalizedProfile))
    }
  }, [rig.sendStatus, rig.normalizedProfile])

  function handleSaveLocal() {
    rig.handleSaveProfile()
    setSavedFingerprint(currentFingerprint)
  }

  function openAdvancedConfirm(kind) {
    setWorkspaceMenuOpen(false)
    setConfirmKind(kind)
  }

  function closeAdvancedConfirm() {
    setConfirmKind(null)
  }

  function runAdvancedConfirm() {
    const kind = confirmKind
    setConfirmKind(null)
    if (kind === "migrate") {
      rig.migrateToBusSemantics({ skipConfirm: true })
      return
    }
    if (kind === "resetProfile") {
      rig.handleResetProfile()
      window.setTimeout(() => {
        setSavedFingerprint(profileWorkspaceFingerprint(rig.normalizedProfile))
      }, 0)
      return
    }
    if (kind === "clearAll") {
      rig.handleClearAllBindings({ skipConfirm: true })
    }
  }

  return (
    <div className="face-rig-body">
      <aside className="face-rig-panel face-rig-panel-rail">
        <div className="face-rig-rail-top face-rig-rail-top--workflow" aria-label="工作台操作区">
          <div className="face-rig-logo-row">
            <span className="face-rig-logo">面部绑定工作台</span>
            <span
              className={`face-rig-workspace-save-status${
                hasUnsaved ? " is-dirty" : " is-saved"
              }`}
            >
              {hasUnsaved ? "有未保存修改" : "已保存"}
            </span>
          </div>

          <div className="face-rig-workspace-actions">
            <div className="face-rig-workspace-action-stack" role="group" aria-label="工作流操作">
              <button type="button" className="btn-secondary face-rig-workspace-action-full" onClick={rig.resetEngine}>
                重置工作台
              </button>
              <button type="button" className="btn-primary face-rig-workspace-action-full" onClick={handleSaveLocal}>
                保存到本地
              </button>
            </div>
            <div className="face-rig-workspace-action-row face-rig-workspace-action-row--files" role="group" aria-label="配置文件">
              <button type="button" className="btn-ghost btn-tiny" onClick={rig.handleImportClick}>
                导入配置
              </button>
              <button type="button" className="btn-ghost btn-tiny" onClick={rig.handleExportProfile}>
                导出配置
              </button>
            </div>

            <div className="face-rig-binding-menu-wrap face-rig-workspace-advanced">
              <button
                type="button"
                className="btn-ghost btn-tiny face-rig-workspace-advanced-trigger"
                onClick={(e) => {
                  e.stopPropagation()
                  setWorkspaceMenuOpen((v) => !v)
                }}
              >
                高级操作 ▾
              </button>
              {workspaceMenuOpen ? (
                <div
                  className="face-rig-binding-menu face-rig-binding-menu--advanced"
                  role="menu"
                  onClick={(e) => e.stopPropagation()}
                >
                  {outputMode === BINDING_OUTPUT_MODES.BUS_SERVO ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="face-rig-advanced-menu-item"
                      onClick={() => openAdvancedConfirm("migrate")}
                    >
                      <span className="face-rig-advanced-menu-item-title">迁移为 Bus Servo 中位语义</span>
                      <span className="face-rig-advanced-menu-item-desc">neutral → 1500，保留相对行程</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    role="menuitem"
                    className="face-rig-advanced-menu-item"
                    onClick={() => openAdvancedConfirm("resetProfile")}
                  >
                    <span className="face-rig-advanced-menu-item-title">恢复默认映射</span>
                    <span className="face-rig-advanced-menu-item-desc">替换为默认绑定并写入本地</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="face-rig-advanced-menu-item is-danger"
                    disabled={bindingCount === 0}
                    onClick={() => openAdvancedConfirm("clearAll")}
                  >
                    <span className="face-rig-advanced-menu-item-title">清除全部绑定</span>
                    <span className="face-rig-advanced-menu-item-desc">
                      {bindingCount === 0 ? "当前没有可清除的绑定" : `清除 ${bindingCount} 条并写入本地`}
                    </span>
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          {rig.sendStatus ? (
            <p className="face-rig-rail-hint face-rig-rail-hint--overlay" role="status">
              {rig.sendStatus}
            </p>
          ) : null}
        </div>

        <FaceBindingInspector
          controls={rig.normalizedProfile.controls}
          bindings={rig.normalizedProfile.bindings}
          contributions={rig.contributions}
          kinematics={rig.kinematics}
          selectedControlId={rig.selectedControlId}
          selectedChannel={rig.selectedChannel}
          onSelectChannel={rig.setSelectedChannel}
          rigValues={rig.rigValues}
          configs={configs}
          onBindingsReplace={rig.handleBindingsReplace}
          onCaptureBindingNeutral={rig.captureBindingNeutralFromWorkbench}
          outputMode={outputMode}
          driveArmed={rig.driveArmed}
        />
      </aside>

      {confirmCopy ? (
        <div
          className="face-rig-confirm-backdrop"
          role="presentation"
          onClick={closeAdvancedConfirm}
        >
          <div
            className="face-rig-confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="face-rig-confirm-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 id="face-rig-confirm-title" className="face-rig-confirm-title">
              {confirmCopy.title}
            </h4>
            <div className="face-rig-confirm-body">
              {confirmCopy.lines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
            <div className="face-rig-confirm-actions">
              <button type="button" className="btn-ghost btn-tiny" onClick={closeAdvancedConfirm}>
                取消
              </button>
              <button
                type="button"
                className={`btn-tiny ${confirmCopy.danger ? "face-rig-confirm-danger" : "btn-primary"}`}
                onClick={runAdvancedConfirm}
              >
                {confirmCopy.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <FaceRigControls
        rigState={rig.rig}
        onRigStateChange={rig.setRig}
        setSelectedControlId={rig.setSelectedControlId}
        setSelectedChannel={rig.setSelectedChannel}
        selectedControlId={rig.selectedControlId}
        draggingControlId={rig.draggingControlId}
        setDraggingControlId={rig.setDraggingControlId}
        padLRef={rig.padLRef}
        padRRef={rig.padRRef}
        startRadar={rig.startRadar}
        radarLCxPx={rig.radarLCxPx}
        radarLCyPx={rig.radarLCyPx}
        radarRCxPx={rig.radarRCxPx}
        radarRCyPx={rig.radarRCyPx}
        eyeRadarAdjustArmed={rig.eyeRadarAdjustArmed}
      />

      <div className="face-rig-panel face-rig-panel-preview">
        <div className="binding-wb-preview-head">
          <h3>输出诊断 · finalServoOutputs</h3>
          <button
            type="button"
            className="btn-ghost btn-tiny binding-wb-fix-align"
            onClick={rig.handleFixActuatorBusAlignment}
            title="将 actuatorKey servo_N 与 busServoId N 对齐并保存"
          >
            修复 actuatorKey 与 bus ID 对齐
          </button>
        </div>

        <div className="binding-wb-eye-quick-row">
          <span className="binding-wb-eye-quick-label">眼皮快速校验</span>
          {[
            ["neutral", "中位"],
            ["close", "闭眼"],
            ["open", "睁眼"],
            ["sync", "左右同步"],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              className="btn-ghost btn-tiny"
              onClick={() => rig.runEyeQuickTest(key)}
            >
              {label}
            </button>
          ))}
        </div>

        <EyesBindingDebugPanel
          finalServoOutputs={rig.workbenchState?.finalServoOutputs}
          bindings={rig.normalizedProfile.bindings}
          busCommands={rig.workbenchState?.adapterPreview?.commands}
          rigValues={rig.rigValues}
        />

        <BindingWorkbenchOutputPanel
          workbenchState={rig.workbenchState}
          outputMode={outputMode}
          driveArmed={rig.driveArmed}
          busSerialConnected={rig.serialStatus?.bus}
          busFamilyLabel={rig.serialStatus?.label || "Bus"}
          selectedControlId={rig.selectedControlId}
          selectedChannel={rig.selectedChannel}
          bindings={rig.normalizedProfile.bindings}
          rigValues={rig.rigValues}
          testMode={rig.testMode}
          lastDispatch={rig.lastDispatch}
          onMarkControlIgnored={rig.markControlIgnored}
          onUnmarkControlIgnored={rig.unmarkControlIgnored}
        />

        <details className="face-rig-diag-block" open>
          <summary>绑定行程 / 五杆 / 行程利用率（ServoOutputInspector）</summary>
          <ServoOutputInspector
            profile={rig.normalizedProfile}
            rig={rig.rig}
            configs={configs}
            suspendHeavy={Boolean(rig.draggingControlId)}
          />
        </details>
      </div>
    </div>
  )
}
