import { useEffect, useMemo, useRef, useState } from "react"
import {
  DEFAULT_GROUP_ID,
  SERVO_COUNT,
  getDirectionName,
  getServoConfig,
  loadServoConfigs,
  normalizeDirection,
  normalizeServoGroups,
  normalizeServoConfigs,
  resetServoConfig,
  saveServoConfigs,
  updateServoConfig,
} from "../core/servoConfig.js"
import { exportJsonFile } from "../utils/fileExport.js"
import { toInt } from "../utils/clamp.js"
import {
  BusServoConfigSection,
  BusServoControlSection,
  BusServoIdManagementSection,
  BusServoRjBaudrateSection,
  BusServoRjResponseSwitchSection,
  busWindowHint,
} from "./BusServoSections.jsx"
import { useBusServoProfile } from "../hooks/useBusServoProfile.js"
import {
  PROTOCOL,
  SERVO_MODEL,
  SERVO_MODEL_SPECS,
  RANGE_MODE,
  buildLabExportPayload,
  buildServoConfigExportFilename,
  importAndActivateServoConfigDocument,
  resetServoConfigDocumentToDefault,
  updateServoConfigDocumentName,
  saveScServoLabProject,
} from "../sdk/servoAdapters/index.js"
import {
  normalizeBusProtocol,
  busTransportFamilyForProtocol,
  busProtocolLabel,
} from "../sdk/servoAdapters/busServo/resolveBusTransport.js"

const DEFAULT_GROUP_OPTIONS = [
  { id: "ungrouped", label: "未分组" },
  { id: "brow", label: "眉部" },
  { id: "eye", label: "眼部" },
  { id: "mouth", label: "嘴部" },
  { id: "cheek", label: "脸颊" },
  { id: "aux", label: "辅助" },
]

export default function ServoControlPanel({
  onCurrentPoseChange: _onCurrentPoseChange,
  onConfigsChange,
  onTransportFamilyChange,
  onTransportModeChange,
}) {
  const [activeTab, setActiveTab] = useState("control")
  const [configs, setConfigs] = useState(() => loadServoConfigs())
  const [selectedServoId, setSelectedServoId] = useState(0)
  const [idDraft, setIdDraft] = useState("0")
  const [lastMessage, setLastMessage] = useState("")
  const [lastCommand, setLastCommand] = useState("")
  const [, setDirty] = useState(false)

  const importFileRef = useRef(null)
  const maxServoId = Math.max(0, (configs.length || SERVO_COUNT) - 1)

  useEffect(() => {
    setIdDraft(String(selectedServoId))
  }, [selectedServoId])

  function commitServoIdDraft(raw) {
    const text = String(raw ?? "")
      .trim()
      .replace(/^id/i, "")
    const parsed = toInt(text, selectedServoId)
    const next = Math.min(maxServoId, Math.max(0, parsed))
    setSelectedServoId(next)
    setIdDraft(String(next))
  }

  const selectedConfig = useMemo(() => getServoConfig(configs, selectedServoId), [configs, selectedServoId])
  const busProtocol = normalizeBusProtocol(selectedConfig.protocol)
  const busConfig = useMemo(
    () => ({ ...selectedConfig, protocol: busProtocol }),
    [selectedConfig, busProtocol]
  )
  const bus = useBusServoProfile(busConfig, busProtocol)

  const lastFamilyRef = useRef(/** @type {string | null} */ (null))

  useEffect(() => {
    const family = busTransportFamilyForProtocol(busProtocol)
    if (lastFamilyRef.current === family) {
      return
    }
    lastFamilyRef.current = family
    onTransportFamilyChange?.(family)
  }, [busProtocol, onTransportFamilyChange])

  // 兼容旧 prop；勿放进 effect，避免 unstable 回调反复触发父级状态重置
  void onTransportModeChange

  const selectedServoGroupId = selectedConfig.groupId || DEFAULT_GROUP_ID
  const normalizedGroupOptions = useMemo(
    () =>
      normalizeServoGroups(
        DEFAULT_GROUP_OPTIONS.map((item, idx) => ({
          groupId: item.id,
          name: item.label,
          order: idx,
        }))
      ),
    []
  )

  useEffect(() => {
    if (typeof onConfigsChange === "function") {
      onConfigsChange(configs)
    }
  }, [configs, onConfigsChange])

  function patchSelectedConfig(patch) {
    const next = updateServoConfig(configs, selectedServoId, patch)
    setConfigs(next)
    setDirty(true)
  }

  function handleSaveConfigs() {
    const coerced = configs.map((c) => ({
      ...c,
      protocol: normalizeBusProtocol(c.protocol),
    }))
    saveServoConfigs(coerced)
    setConfigs(coerced)
    const res = bus.saveProfile()
    if (!res.ok) {
      setLastMessage(res.error || "总线 Profile 保存失败")
      return
    }
    setDirty(false)
    setLastMessage("舵机配置与总线 Profile 已保存。")
  }

  function isBusServoConfigDocument(parsed) {
    if (!parsed || typeof parsed !== "object") return false
    if (parsed.projectType === "robot-face-servo-config") return true
    const ver = String(parsed.version || "")
    if (ver.includes("servoConfigDocument") || ver.includes("servoProfiles")) {
      return Boolean(parsed.profiles)
    }
    return false
  }

  function handleDocumentNameChange(name) {
    const next = updateServoConfigDocumentName(bus.labProject, name)
    bus.setLabProject(next)
    setDirty(true)
  }

  function handleNewServoConfigDocument() {
    if (
      !window.confirm(
        "新建将清空本地当前舵机配置文档（每 ID 一条 Profile），旧内容全部失效。是否继续？"
      )
    ) {
      return
    }
    const doc = resetServoConfigDocumentToDefault()
    bus.setLabProject(doc)
    setDirty(false)
    setLastMessage("已新建默认舵机配置文档，并清除历史存储残留。")
  }

  function handleSaveServoConfigDocument() {
    const saved = saveScServoLabProject(bus.labProject)
    bus.setLabProject(saved)
    setDirty(false)
    setLastMessage(`舵机配置文档已保存：${saved.documentName}`)
  }

  function handleExportConfigs() {
    const payload = buildLabExportPayload(bus.labProject)
    const filename = buildServoConfigExportFilename(payload.documentName)
    exportJsonFile(filename, payload)
    setLastMessage(`已导出舵机配置：${filename}`)
  }

  function handleImportConfigsClick() {
    importFileRef.current?.click()
  }

  async function handleImportConfigsChange(event) {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file) return

    try {
      const text = await file.text()
      const parsed = JSON.parse(text)

      if (isBusServoConfigDocument(parsed)) {
        const project = importAndActivateServoConfigDocument(parsed)
        bus.setLabProject(project)
        setDirty(false)
        setLastMessage(
          `已导入并生效「${project.documentName}」（${Object.keys(project.profiles).length} 条）；本地旧配置已全部失效`
        )
        return
      }

      let incomingConfigs
      if (Array.isArray(parsed)) {
        incomingConfigs = parsed
      } else if (parsed && Array.isArray(parsed.servos)) {
        incomingConfigs = parsed.servos
      } else {
        throw new Error("文件格式不正确：需要舵机配置文档（profiles）或 PWM 表数组。")
      }

      const next = normalizeServoConfigs(incomingConfigs).map((c) => ({
        ...c,
        protocol: normalizeBusProtocol(c.protocol),
      }))
      setConfigs(next)
      saveServoConfigs(next)
      setDirty(false)

      setLastMessage(`已导入 PWM 表配置：${file.name}`)
    } catch (error) {
      setLastMessage(`导入失败：${error.message}`)
    }
  }

  function handleResetSelectedConfig() {
    const next = resetServoConfig(configs, selectedServoId)
    const coerced = next.map((c) =>
      c.servoId === selectedServoId ? { ...c, protocol: PROTOCOL.SCSCL } : c
    )
    setConfigs(coerced)
    setDirty(true)
    setLastMessage(`舵机 ${selectedServoId}：已恢复默认，请保存。`)
  }

  function handleProtocolChange(nextProtocol) {
    const protocol = normalizeBusProtocol(nextProtocol)
    patchSelectedConfig({
      protocol,
      busId: selectedConfig.busId ?? selectedServoId,
    })
    bus.applyProtocolDefaults(protocol)
  }

  const protocolSelect = (
    <div className="protocol-inline-select">
      <label htmlFor="servo-protocol-select">控制协议</label>
      <select
        id="servo-protocol-select"
        value={busProtocol}
        onChange={(event) => handleProtocolChange(event.target.value)}
      >
        <option value={PROTOCOL.SCSCL}>{busProtocolLabel(PROTOCOL.SCSCL)}</option>
        <option value={PROTOCOL.SMS_STS}>{busProtocolLabel(PROTOCOL.SMS_STS)}</option>
        <option value={PROTOCOL.RJ_SBUS}>{busProtocolLabel(PROTOCOL.RJ_SBUS)}</option>
      </select>
    </div>
  )

  const tabPanelClass = "view-control"

  return (
    <div className="servo-panel-v2">
      <header className="panel-header">
        <div className="header-left">
          <div className="field-inline servo-id-field">
            <label htmlFor="servo-target-id-input">IDx</label>
            <div className="servo-id-input">
              <span className="servo-id-prefix" aria-hidden="true">
                ID
              </span>
              <input
                id="servo-target-id-input"
                type="number"
                inputMode="numeric"
                min={0}
                max={maxServoId}
                step={1}
                value={idDraft}
                aria-label="IDx，输入数字切换舵机"
                onChange={(event) => {
                  const raw = event.target.value
                  setIdDraft(raw)
                  if (raw === "") return
                  const n = Number(raw)
                  if (Number.isInteger(n) && n >= 0 && n <= maxServoId) {
                    setSelectedServoId(n)
                  }
                }}
                onBlur={() => commitServoIdDraft(idDraft)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault()
                    commitServoIdDraft(idDraft)
                    event.currentTarget.blur()
                  }
                }}
              />
            </div>
          </div>
        </div>

        <div className="mode-switcher">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "control"}
            className={activeTab === "control" ? "active" : ""}
            onClick={() => setActiveTab("control")}
          >
            舵机控制
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "config"}
            className={activeTab === "config" ? "active" : ""}
            onClick={() => setActiveTab("config")}
          >
            参数配置
          </button>
        </div>
      </header>

      <main className="panel-content card" style={{ position: "relative" }}>
        {activeTab === "control" ? (
          <div className={tabPanelClass}>
            <BusServoControlSection
              profile={bus.profile}
              protocolControl={protocolSelect}
              onMessage={({ text, error }) => setLastMessage(error ? `错误：${text}` : text)}
              onLastCommand={setLastCommand}
            />
          </div>
        ) : (
          <div className="view-config">
            <div className="view-header">
              <h3>参数配置</h3>
            </div>

            <div className="config-horizontal-block">
              <div className="config-col">
                <div className="field-input-wrapper">
                  <div className="field">
                    <label>舵机 ID</label>
                    <input
                      type="number"
                      min={0}
                      max={busProtocol === PROTOCOL.RJ_SBUS ? 254 : 252}
                      value={bus.profile.id}
                      onChange={(event) => {
                        const id = toInt(event.target.value, bus.profile.id)
                        patchSelectedConfig({ busId: id, protocol: busProtocol })
                        bus.patchProfile({ id })
                      }}
                    />
                  </div>
                  <div className="field">
                    <label>舵机模型</label>
                    <select
                      value={bus.profile.servoModel}
                      onChange={(event) => {
                        const sm = event.target.value
                        if (sm === SERVO_MODEL.CUSTOM) {
                          bus.patchProfile({ servoModel: sm, rangeMode: RANGE_MODE.MODE_CUSTOM })
                          return
                        }
                        const spec = SERVO_MODEL_SPECS[sm]
                        bus.patchProfile({
                          servoModel: sm,
                          positionMin: spec.positionMin,
                          positionMax: spec.positionMax,
                          positionCenter: spec.logicalPositionCenter ?? spec.positionCenter,
                          angleRangeDeg: spec.angleRangeDeg,
                        })
                      }}
                    >
                      {Object.entries(SERVO_MODEL_SPECS).map(([k, s]) => (
                        <option key={k} value={k}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <p className="hint-text" style={{ margin: "0 0 8px" }}>
                    {busWindowHint(bus.profile)}
                  </p>
                  <BusServoIdManagementSection
                    profile={bus.profile}
                    patchProfile={bus.patchProfile}
                    labProject={bus.labProject}
                    persistProject={bus.persistProject}
                    showPingScan={false}
                    showChangeId
                    title={null}
                    onMessage={({ text, error }) =>
                      setLastMessage(error ? `错误：${text}` : text)
                    }
                  />
                  {busProtocol === PROTOCOL.RJ_SBUS ? (
                    <>
                      <BusServoRjBaudrateSection
                        profile={bus.profile}
                        onMessage={({ text, error }) =>
                          setLastMessage(error ? `错误：${text}` : text)
                        }
                      />
                      <BusServoRjResponseSwitchSection
                        profile={bus.profile}
                        patchProfile={bus.patchProfile}
                        onMessage={({ text, error }) =>
                          setLastMessage(error ? `错误：${text}` : text)
                        }
                      />
                    </>
                  ) : null}
                  <details className="bus-advanced-section">
                    <summary>可选 · 逻辑名称 / 分组 / 方向</summary>
                    <div className="bus-advanced-body">
                      <div className="field">
                        <label>逻辑名称</label>
                        <input
                          value={selectedConfig.name}
                          onChange={(event) => {
                            patchSelectedConfig({ name: event.target.value })
                            bus.patchProfile({ label: event.target.value })
                          }}
                        />
                      </div>
                      <div className="field-group">
                        <div className="field">
                          <label>归属分组</label>
                          <select
                            value={selectedServoGroupId}
                            onChange={(event) =>
                              patchSelectedConfig({ groupId: event.target.value })
                            }
                          >
                            {normalizedGroupOptions.map((group) => (
                              <option key={group.groupId} value={group.groupId}>
                                {group.name}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="field">
                          <label>舵机方向</label>
                          <select
                            value={normalizeDirection(selectedConfig.direction)}
                            onChange={(event) => {
                              const direction = normalizeDirection(event.target.value)
                              patchSelectedConfig({ direction })
                              bus.patchProfile({ direction })
                            }}
                          >
                            <option value="1">正向（{getDirectionName(1)}）</option>
                            <option value="-1">反向（{getDirectionName(-1)}）</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  </details>
                  <details className="bus-advanced-section">
                    <summary>高级 · Ping / Scan ID</summary>
                    <div className="bus-advanced-body">
                      <BusServoIdManagementSection
                        profile={bus.profile}
                        patchProfile={bus.patchProfile}
                        labProject={bus.labProject}
                        persistProject={bus.persistProject}
                        showPingScan
                        showChangeId={false}
                        title="ID 探测"
                        onMessage={({ text, error }) =>
                          setLastMessage(error ? `错误：${text}` : text)
                        }
                      />
                    </div>
                  </details>
                  <div className="field-inline">
                    <input
                      type="checkbox"
                      id="enable-servo"
                      checked={selectedConfig.enabled}
                      onChange={(event) => patchSelectedConfig({ enabled: event.target.checked })}
                    />
                    <label htmlFor="enable-servo">启用此舵机</label>
                  </div>
                </div>
                <div className="config-btn-group">
                  <div className="field">
                    <label>舵机配置文档名称</label>
                    <input
                      type="text"
                      value={bus.labProject?.documentName || ""}
                      onChange={(event) => handleDocumentNameChange(event.target.value)}
                      placeholder="未命名舵机配置"
                    />
                  </div>
                  <button type="button" className="btn-secondary-full" onClick={handleSaveConfigs}>
                    保存限位配置
                  </button>
                  <button type="button" className="btn-secondary-full" onClick={handleSaveServoConfigDocument}>
                    保存文档
                  </button>
                  <input
                    ref={importFileRef}
                    type="file"
                    accept=".json,application/json"
                    style={{ display: "none" }}
                    onChange={handleImportConfigsChange}
                  />
                  <div className="config-export-row">
                    <button type="button" className="btn-outline" onClick={handleImportConfigsClick}>
                      导入并生效
                    </button>
                    <button type="button" className="btn-outline" onClick={handleExportConfigs}>
                      导出文档
                    </button>
                  </div>
                  <div className="config-export-row">
                    <button type="button" className="btn-outline" onClick={handleNewServoConfigDocument}>
                      新建文档
                    </button>
                    <button type="button" className="btn-text-danger" onClick={handleResetSelectedConfig}>
                      重置默认
                    </button>
                  </div>
                </div>
              </div>

              <div className="config-col">
                <BusServoConfigSection
                  profile={bus.profile}
                  patchProfile={bus.patchProfile}
                  onSaveProfile={(explicitProfile) => bus.saveProfile(explicitProfile)}
                  labProject={bus.labProject}
                  persistProject={bus.persistProject}
                  onMessage={({ text, error }) => setLastMessage(error ? `错误：${text}` : text)}
                />
              </div>
            </div>
          </div>
        )}
      </main>

      <details className="compact-log">
        <summary className="compact-log-summary">
          <span className="compact-log-message">最近动作：{lastMessage || "等待操作…"}</span>
        </summary>
        {lastCommand ? <code className="compact-log-command">{lastCommand}</code> : null}
      </details>
    </div>
  )
}
