import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createNeutralCharacterPose } from "../core/characterPose.js"
import { canDispatchNeckHardware, canDispatchNeckPhysical } from "../core/frameProject.js"
import { createBrowserNeckRuntimeHost } from "../sdk/neck/runtime/browserNeckRuntimeHost.js"
import { createConnectNeckService } from "../sdk/neck/product/connectNeckService.js"
import {
  getSharedBrowserSlcanTransport,
  releaseSharedBrowserSlcanTransport,
  subscribeBrowserSlcanState,
  notifyBrowserSlcanState,
} from "../sdk/neck/transport/browserSlcanTransportService.js"
import {
  buildPresetExportPayload,
  createUserPresetFromDraft,
  parseAndValidateExpressionImport,
  samplePresetRepresentativeCharacterPose,
} from "../sdk/expression/expressionPresetImport.js"
import {
  createExpressionPresetPlaybackController,
  PRESET_PLAYBACK_STATES,
  PRESET_REPEAT_MODES,
} from "../sdk/expression/expressionPresetPlaybackController.js"
import {
  addSequenceItem,
  moveSequenceItem,
  removeSequenceItem,
  removeSequenceItemsByPresetId,
  setSequenceItemRepeat,
} from "../sdk/expression/expressionPresetSequence.js"
import { PHYSICAL_MOTION_OWNERS, isPhysicalMotionOwnerActive } from "../sdk/expression/physicalMotionOwner.js"
import {
  deleteUserPreset,
  listUserPresets,
  replaceUserPresetAsset,
  saveUserPreset,
  updateUserPresetMetadata,
} from "../sdk/expression/expressionPresetUserStore.js"
import {
  getExpressionPreset,
  setUserPresetLibrary,
} from "../sdk/expression/expressionPresetRegistry.js"
import { dispatchKeyframeToHardware } from "../sdk/expression/keyframePlaybackDispatch.js"
import { exportJsonFile, buildSingleExpressionExportFilename } from "../utils/fileExport.js"
import ExpressionPresetLibrary from "../sdk/react/expressionPreset/ExpressionPresetLibrary.jsx"
import ExpressionPresetPlayer from "../sdk/react/expressionPreset/ExpressionPresetPlayer.jsx"
import ExpressionPresetSequence from "../sdk/react/expressionPreset/ExpressionPresetSequence.jsx"
import ExpressionPresetImportDialog from "../sdk/react/expressionPreset/ExpressionPresetImportDialog.jsx"
import FaceRealtimePreviewToggle from "../sdk/react/FaceRealtimePreviewToggle.jsx"
import SerialCapsulePanel from "../sdk/react/serial/SerialCapsulePanel.jsx"
import NeckCapsulePanel from "../sdk/react/serial/NeckCapsulePanel.jsx"
import "../styles/face-rig.css"
import "../styles/expression-preset.css"

function clampN(v, fallback = 3) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.min(999, Math.max(1, n))
}

export default function ExpressionPresetPage({
  configs = [],
  frameProject,
  apiRef = null,
}) {
  const [groupId, setGroupId] = useState("all")
  const [selectedPresetId, setSelectedPresetId] = useState(null)
  const [presets, setPresets] = useState([])
  const [loadError, setLoadError] = useState("")
  const [statusToast, setStatusToast] = useState("")
  const [repeatMode, setRepeatMode] = useState(PRESET_REPEAT_MODES.ONCE)
  const [repeatCount, setRepeatCount] = useState(3)
  const [sequence, setSequence] = useState([])
  const [sequenceMode, setSequenceMode] = useState(PRESET_REPEAT_MODES.ONCE)
  const [sequenceRepeatCount, setSequenceRepeatCount] = useState(1)
  const [realtimePreview, setRealtimePreview] = useState(false)
  const [importState, setImportState] = useState(null)
  const [neckTransportState, setNeckTransportState] = useState(null)
  const [neckRuntimeSnap, setNeckRuntimeSnap] = useState(null)
  const [neckConnectBusy, setNeckConnectBusy] = useState(false)
  const [neckError, setNeckError] = useState("")
  const [snapshot, setSnapshot] = useState(() => ({
    state: PRESET_PLAYBACK_STATES.IDLE,
    selectedPresetId: null,
    playingPresetId: null,
    progress01: 0,
    lastCharacterPose: createNeutralCharacterPose(),
    blockReason: "",
    neckWarning: "",
    leaveStatus: "",
    sequenceIndex: -1,
    playingRepeatIndex: 0,
    playingRepeatTotal: 1,
    sequenceItemRepeatIndex: 0,
    sequenceItemRepeatTotal: 1,
  }))

  const browserRuntimeRef = useRef(null)
  const browserSlcanRef = useRef(null)
  const connectNeckServiceRef = useRef(null)
  const realtimePreviewRef = useRef(false)
  realtimePreviewRef.current = realtimePreview
  const projectRef = useRef(frameProject)
  projectRef.current = frameProject
  const importInputRef = useRef(null)
  const replaceTargetIdRef = useRef(null)

  const refreshLibrary = useCallback(async (preferSelectId = null) => {
    try {
      const list = await listUserPresets()
      setPresets(list)
      setUserPresetLibrary(list)
      setLoadError("")
      setSelectedPresetId((prev) => {
        if (preferSelectId && list.some((p) => p.id === preferSelectId)) {
          return preferSelectId
        }
        if (prev && list.some((p) => p.id === prev)) return prev
        return list[0]?.id || null
      })
      return list
    } catch (err) {
      setLoadError(err?.message || "读取本地预设失败")
      setPresets([])
      setUserPresetLibrary([])
      return []
    }
  }, [])

  useEffect(() => {
    void refreshLibrary()
  }, [refreshLibrary])

  const dispatchFaceImpl = useCallback(async (args) => {
    if (!realtimePreviewRef.current) {
      return false
    }
    return dispatchKeyframeToHardware(args)
  }, [])

  const dispatchNeck = useCallback(async (neck, meta) => {
    if (!neck) {
      return { attempted: false, status: "SKIPPED", sequence: null, error: null }
    }
    if (!realtimePreviewRef.current) {
      return { attempted: false, status: "SKIPPED", sequence: null, error: "HARDWARE_PREVIEW_OFF" }
    }
    // Preset playback: allow Neck TX when runtime is ready even if project modules.neck
    // was left Face-only — presets carry CharacterPose.neck independently.
    const host = browserRuntimeRef.current
    if (!host) {
      return { attempted: false, status: "SKIPPED", sequence: null, error: "SKIPPED_NO_HARDWARE" }
    }
    const snap = host.getSnapshot?.() || {}
    const moduleOk =
      canDispatchNeckHardware(projectRef.current) ||
      Boolean(snap.transportReady && snap.enabled)
    if (!moduleOk) {
      return { attempted: false, status: "SKIPPED", sequence: null, error: "NECK_MODULE_OFF" }
    }
    if (
      !canDispatchNeckPhysical({
        moduleEnabled: true,
        transportReady: Boolean(snap.transportReady),
        motorsEnabled: Boolean(snap.enabled),
        estop: Boolean(snap.estop || snap.estopLatched),
        calibrating: Boolean(snap.calibratingNeutral),
        hardwarePreview: Boolean(realtimePreviewRef.current),
        source: "timeline",
      })
    ) {
      return { attempted: false, status: "SKIPPED", sequence: null, error: "NECK_PHYSICAL_GATE" }
    }
    try {
      // Recover STALE so timeline targets are accepted after page switches.
      if (snap.stale || snap.state === "STALE_SAFE_HOLD") {
        host.resume?.()
      }
      const ok = host.offerTarget({
        pose: neck,
        timelineTimeMs: meta?.timelineTimeMs,
        source: "timeline",
      })
      return {
        attempted: true,
        status: ok ? "SENT" : "SKIPPED",
        sequence: null,
        error: ok ? null : "BROWSER_RUNTIME_SKIPPED",
      }
    } catch (err) {
      return {
        attempted: true,
        status: "FAILED",
        sequence: null,
        error: err?.message || String(err),
      }
    }
  }, [])

  const controller = useMemo(
    () =>
      createExpressionPresetPlaybackController({
        configs,
        dispatchNeck,
        dispatchFaceImpl,
        resolvePreset: (id) => getExpressionPreset(id),
        onSnapshot: setSnapshot,
      }),
    [configs, dispatchNeck, dispatchFaceImpl]
  )

  useEffect(() => {
    const transport = getSharedBrowserSlcanTransport()
    browserSlcanRef.current = transport
    let host = null
    try {
      host = createBrowserNeckRuntimeHost({
        getTransport: () => browserSlcanRef.current,
      })
      browserRuntimeRef.current = host
      connectNeckServiceRef.current = createConnectNeckService({
        get transport() {
          return browserSlcanRef.current
        },
        get host() {
          return browserRuntimeRef.current
        },
      })
      void host.resolveStartupProfile?.().catch(() => {})
    } catch {
      browserRuntimeRef.current = null
      connectNeckServiceRef.current = null
    }
    const unsubTransport = subscribeBrowserSlcanState((s) => {
      setNeckTransportState(s)
      if (!host) return
      if (s?.state === "READY" || s?.slcanReady) {
        host.notifyTransportReady()
      } else if (
        s?.state === "ERROR" ||
        s?.state === "DISCONNECTED" ||
        s?.state === "CLOSED"
      ) {
        const snap = host.getSnapshot?.() || {}
        if (snap.enabled || snap.estop || snap.calibratingNeutral || snap.transportReady) {
          host.notifyTransportLost()
        }
      }
    })
    const unsubRuntime = host?.subscribeSnapshot?.((snap) => setNeckRuntimeSnap({ ...snap }))
    return () => {
      unsubTransport?.()
      unsubRuntime?.()
      try {
        host?.setHardwarePreview?.(false)
        host?.disableMotors?.({ discardUnsaved: true })
      } catch {
        /* ignore */
      }
      try {
        host?.dispose?.()
      } catch {
        /* ignore */
      }
      browserRuntimeRef.current = null
      browserSlcanRef.current = null
      connectNeckServiceRef.current = null
      try {
        releaseSharedBrowserSlcanTransport()
      } catch {
        /* ignore */
      }
    }
  }, [])

  const handleRealtimePreviewChange = useCallback((checked) => {
    setRealtimePreview(Boolean(checked))
    const host = browserRuntimeRef.current
    host?.setHardwarePreview?.(Boolean(checked))
  }, [])

  const handleConnectNeck = useCallback(async () => {
    setNeckConnectBusy(true)
    setNeckError("")
    try {
      const result = await connectNeckServiceRef.current?.connectNeck?.()
      notifyBrowserSlcanState()
      if (!result?.ok) {
        setNeckError(result?.error?.message || "连接 Neck 失败")
      }
    } catch (err) {
      setNeckError(err?.message || String(err))
    } finally {
      setNeckConnectBusy(false)
    }
  }, [])

  const handleDisconnectNeck = useCallback(async () => {
    await connectNeckServiceRef.current?.disconnectNeck?.()
    notifyBrowserSlcanState()
    setNeckError("")
  }, [])

  const handleEnableNeckMotors = useCallback(async () => {
    setNeckError("")
    const r = await connectNeckServiceRef.current?.enableNeckMotors?.()
    if (r && r.ok === false) {
      setNeckError(r.error?.message || r.gates?.message || "使能电机失败")
    }
  }, [])

  const handleDisableNeckMotors = useCallback(() => {
    connectNeckServiceRef.current?.disableNeckMotors?.({ discardUnsaved: true })
  }, [])

  const prepareLeaveSafe = useCallback(async () => {
    await controller.prepareLeave()
    try {
      setRealtimePreview(false)
      browserRuntimeRef.current?.setHardwarePreview?.(false)
      if (
        browserRuntimeRef.current?.getSnapshot?.()?.stale ||
        browserRuntimeRef.current?.getSnapshot?.()?.state === "STALE_SAFE_HOLD"
      ) {
        browserRuntimeRef.current.resume?.()
      }
      connectNeckServiceRef.current?.disableNeckMotors?.({ discardUnsaved: true })
    } catch {
      /* ignore */
    }
  }, [controller])

  useEffect(() => {
    if (!apiRef || typeof apiRef !== "object") return undefined
    apiRef.current = {
      prepareLeave: () => prepareLeaveSafe(),
      getSnapshot: () => controller.getSnapshot(),
    }
    return () => {
      apiRef.current = null
    }
  }, [apiRef, controller, prepareLeaveSafe])

  useEffect(() => {
    return () => {
      void prepareLeaveSafe()
    }
  }, [prepareLeaveSafe])

  const neckTransportReady = Boolean(
    neckTransportState?.slcanReady || neckTransportState?.state === "READY"
  )
  const neckMotorsEnabled = Boolean(neckRuntimeSnap?.enabled)

  // Keep preview pose synced to selected preset when idle
  useEffect(() => {
    const busy =
      snapshot.state === PRESET_PLAYBACK_STATES.PLAYING_PRESET ||
      snapshot.state === PRESET_PLAYBACK_STATES.PLAYING_SEQUENCE ||
      snapshot.state === PRESET_PLAYBACK_STATES.STOPPING_TO_NEUTRAL
    if (busy) return
    const preset = getExpressionPreset(selectedPresetId)
    if (!preset) {
      setSnapshot((s) => ({
        ...s,
        lastCharacterPose: createNeutralCharacterPose(),
        selectedPresetId: null,
      }))
      return
    }
    const pose = samplePresetRepresentativeCharacterPose(preset)
    setSnapshot((s) => ({
      ...s,
      selectedPresetId: preset.id,
      lastCharacterPose: pose,
    }))
  }, [selectedPresetId, presets, snapshot.state])

  const selected = getExpressionPreset(selectedPresetId)
  const playing = getExpressionPreset(snapshot.playingPresetId) || selected
  const locked = controller.isBusy()
  const sequenceLocked = locked
  const headerStatus =
    snapshot.state === PRESET_PLAYBACK_STATES.PLAYING_PRESET
      ? "播放中"
      : snapshot.state === PRESET_PLAYBACK_STATES.PLAYING_SEQUENCE
        ? "序列播放中"
        : snapshot.state === PRESET_PLAYBACK_STATES.STOPPING_TO_NEUTRAL
          ? "正在回中"
          : "空闲"

  const showToast = (msg) => {
    setStatusToast(msg)
    window.setTimeout(() => setStatusToast(""), 2200)
  }

  const handleSelect = (id) => {
    setSelectedPresetId(id)
    controller.selectPreset(id)
  }

  const handlePlayPreset = (id = selectedPresetId) => {
    const preset = getExpressionPreset(id)
    if (!preset) return
    if (id && id !== selectedPresetId) {
      setSelectedPresetId(id)
      controller.selectPreset(id)
    }
    const mode =
      !preset.closedClip && repeatMode !== PRESET_REPEAT_MODES.ONCE
        ? PRESET_REPEAT_MODES.ONCE
        : repeatMode
    void controller.startPreset({
      presetId: id,
      mode,
      repeatCount,
    })
  }

  const openImportPicker = (replaceId = null) => {
    if (locked) return
    replaceTargetIdRef.current = replaceId
    importInputRef.current?.click()
  }

  const handleFileChosen = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    try {
      const text = await file.text()
      const result = parseAndValidateExpressionImport(text, {
        configs,
        fileName: file.name,
      })
      if (!result.ok) {
        showToast(result.message)
        console.warn("[expression-preset-import]", result.code, result.detail || "")
        return
      }
      setImportState({
        mode: replaceTargetIdRef.current ? "replace" : "import",
        replaceId: replaceTargetIdRef.current,
        draft: result.draft,
        name: result.draft.name,
        group: result.draft.group,
      })
    } catch (err) {
      showToast("无法读取文件。")
      console.warn("[expression-preset-import]", err)
    }
  }

  const confirmImport = async () => {
    if (!importState?.draft) return
    const draft = {
      ...importState.draft,
      name: importState.name,
      group: importState.group,
    }
    try {
      if (importState.mode === "replace" && importState.replaceId) {
        const updated = await replaceUserPresetAsset(importState.replaceId, draft)
        if (!updated) {
          showToast("替换失败，原预设仍保留。")
          return
        }
        await refreshLibrary(updated.id)
        showToast("✓ 已替换动画。")
      } else {
        const preset = createUserPresetFromDraft(draft)
        await saveUserPreset(preset)
        await refreshLibrary(preset.id)
        showToast("✓ 已导入。")
      }
      setImportState(null)
      replaceTargetIdRef.current = null
    } catch (err) {
      showToast(importState.mode === "replace" ? "替换失败，原预设仍保留。" : "保存失败。")
      console.warn("[expression-preset-import]", err)
    }
  }

  const handleRename = async (preset) => {
    if (locked) return
    const next = window.prompt("重命名预设", preset.name)
    if (next == null) return
    const name = String(next).trim()
    if (!name) return
    await updateUserPresetMetadata(preset.id, { name })
    await refreshLibrary(preset.id)
  }

  const handleChangeGroup = async (preset) => {
    if (locked) return
    const next = window.prompt("分类（日常 / 情绪 / 互动 / 其它）", preset.group)
    if (next == null) return
    const group = ["日常", "情绪", "互动", "其它"].includes(next.trim()) ? next.trim() : "其它"
    await updateUserPresetMetadata(preset.id, { group })
    await refreshLibrary(preset.id)
  }

  const handleExport = (preset) => {
    const payload = buildPresetExportPayload(preset, configs)
    const filename = buildSingleExpressionExportFilename(preset.name, preset.id)
    exportJsonFile(filename, payload)
  }

  const handleDelete = async (preset) => {
    if (locked) return
    const used = sequence.some((it) => it.presetId === preset.id)
    const ok = window.confirm(
      used
        ? "此预设已加入当前播放序列，删除后对应序列项也会移除。\n确认删除？"
        : `确认删除「${preset.name}」？`
    )
    if (!ok) return
    await deleteUserPreset(preset.id)
    setSequence((prev) => removeSequenceItemsByPresetId(prev, preset.id))
    await refreshLibrary()
    showToast("已删除。")
  }

  return (
    <section className="xp-page" aria-label="常用表情">
      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: "none" }}
        onChange={(e) => void handleFileChosen(e)}
      />
      <div className="xp-page-upper-dock face-expression-upper-dock">
        <div className="xp-page-top-cluster face-expression-top-cluster">
          <header
            className="xp-page-toolbar face-expression-toolbar face-expression-toolbar--merged"
            aria-label="常用表情工具栏"
          >
            <div className="xp-page-toolbar-left">
              <div className="xp-page-head-title">
                <h1>常用表情</h1>
                <p>导入表情编排导出的动作，快速播放</p>
              </div>
              <div className="xp-page-head-meta">
                <span className="xp-head-status">状态：{headerStatus}</span>
                {statusToast ? <span className="xp-owner-chip">{statusToast}</span> : null}
                {isPhysicalMotionOwnerActive(PHYSICAL_MOTION_OWNERS.PRESET_PLAYBACK) ? (
                  <span className="xp-owner-chip">已占用输出</span>
                ) : null}
              </div>
            </div>
            <div className="face-expression-toolbar-right" aria-label="串口与实时预览">
              <SerialCapsulePanel transportMode="bus" />
              <NeckCapsulePanel
                transportReady={neckTransportReady}
                motorsEnabled={neckMotorsEnabled}
                connectBusy={neckConnectBusy}
                locked={locked}
                onConnect={handleConnectNeck}
                onDisconnect={handleDisconnectNeck}
                onEnableMotors={handleEnableNeckMotors}
                onDisableMotors={handleDisableNeckMotors}
                error={neckError}
              />
              <FaceRealtimePreviewToggle
                checked={realtimePreview}
                onChange={handleRealtimePreviewChange}
                title="开启后预设播放才下发到总线舵机与已使能的 Neck"
              />
            </div>
          </header>
          {neckError ? (
            <div className="xp-neck-error" role="alert">
              {neckError}
            </div>
          ) : null}
          {snapshot.neckWarning ? (
            <div className="xp-neck-error" role="status">
              {snapshot.neckWarning}
            </div>
          ) : null}
        </div>
      </div>
      <div className="xp-page-body">
        <div className="xp-shell">
          <div className="xp-main">
            <div className="xp-left">
              <ExpressionPresetLibrary
                groupId={groupId}
                onGroupChange={setGroupId}
                selectedPresetId={selectedPresetId}
                playingPresetId={snapshot.playingPresetId}
                playLocked={locked}
                sequenceLocked={sequenceLocked}
                libraryLocked={locked}
                loadError={loadError}
                onRetryLoad={() => void refreshLibrary()}
                onImport={() => openImportPicker(null)}
                onSelect={handleSelect}
                onPlay={(id) => handlePlayPreset(id)}
                onAdd={(id) => {
                  const p = getExpressionPreset(id)
                  if (!p?.closedClip) return
                  setSequence((prev) => addSequenceItem(prev, id, 1))
                }}
                onRename={handleRename}
                onChangeGroup={handleChangeGroup}
                onReplace={(p) => openImportPicker(p.id)}
                onExport={handleExport}
                onDelete={handleDelete}
              />
              <ExpressionPresetSequence
                items={sequence}
                snapshot={snapshot}
                sequenceMode={sequenceMode}
                sequenceRepeatCount={sequenceRepeatCount}
                locked={sequenceLocked}
                onModeChange={setSequenceMode}
                onRepeatCountChange={(v) => setSequenceRepeatCount(clampN(v, 1))}
                onMove={(id, d) => setSequence((prev) => moveSequenceItem(prev, id, d))}
                onRemove={(id) => setSequence((prev) => removeSequenceItem(prev, id))}
                onClear={() => setSequence([])}
                onChangeItemRepeat={(id, n) =>
                  setSequence((prev) => setSequenceItemRepeat(prev, id, n))
                }
                onSelectItem={handleSelect}
                onPlay={() =>
                  void controller.startSequence({
                    items: sequence,
                    mode: sequenceMode,
                    repeatCount: sequenceRepeatCount,
                  })
                }
              />
            </div>
            <ExpressionPresetPlayer
              preset={playing}
              snapshot={snapshot}
              repeatMode={repeatMode}
              repeatCount={repeatCount}
              sequenceReadyCount={sequence.length}
              onRepeatModeChange={setRepeatMode}
              onRepeatCountChange={(v) => setRepeatCount(clampN(v, 3))}
              onPlay={() => handlePlayPreset(selectedPresetId)}
              onStop={() => void controller.stopToNeutral()}
              playLocked={locked}
            />
          </div>
        </div>
      </div>
      <ExpressionPresetImportDialog
        open={Boolean(importState)}
        title={importState?.mode === "replace" ? "替换动画" : "导入表情"}
        draft={importState?.draft}
        name={importState?.name || ""}
        group={importState?.group || "其它"}
        confirmLabel={importState?.mode === "replace" ? "替换" : "导入"}
        onNameChange={(v) => setImportState((s) => (s ? { ...s, name: v } : s))}
        onGroupChange={(v) => setImportState((s) => (s ? { ...s, group: v } : s))}
        onCancel={() => {
          setImportState(null)
          replaceTargetIdRef.current = null
        }}
        onConfirm={() => void confirmImport()}
      />
    </section>
  )
}
