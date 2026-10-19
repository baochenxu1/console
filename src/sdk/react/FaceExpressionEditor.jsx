import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  buildFrameProjectExport,
  createDefaultFrameProject,
  createPoseFromServos,
  deleteKeyframe,
  isCenterOnlyLogicalPose,
  moveKeyframe,
  normalizeFrameProject,
  saveFrameProject,
  updateExpressionName,
  updateKeyframe,
  getProjectNeckModule,
  patchProjectNeckModule,
  canEditNeckPose,
  canDispatchNeckHardware,
  canDispatchNeckPhysical,
  shouldWriteNeckOnFullCharacterKey,
} from "../../core/frameProject.js"
import {
  approximateEliteRigFromKeyframePositions,
  createInitialEliteRig,
  mapFaceRigToPose,
  normalizeEliteRig,
  rigValuesFromEliteRig,
} from "../../core/faceDofMapper.js"
import { sampleExpressionTimeline } from "../../core/expressionTimelineSampler.js"
import {
  addFullFaceKeyAtTime,
} from "../../core/expressionKeyframeOps.js"
import { isFullFaceKeyed } from "../../core/expressionTimelineChannels.js"
import { createNeutralNeckPose, mergeNeckSemanticLimits, normalizeNeckPose } from "../neck/neckPose.js"
import { recordCharacterDispatchTiming } from "../neck/neckTimingDiagnostic.js"
import {
  detectWebSerialCapability,
} from "../neck/transport/index.js"
import {
  getSharedBrowserSlcanTransport,
  releaseSharedBrowserSlcanTransport,
  subscribeBrowserSlcanState,
  notifyBrowserSlcanState,
} from "../neck/transport/browserSlcanTransportService.js"
import {
  createBrowserNeckRuntimeHost,
} from "../neck/runtime/browserNeckRuntimeHost.js"
import { createConnectNeckService } from "../neck/product/connectNeckService.js"
import { useFaceRigInteraction } from "../../hooks/useFaceRigInteraction.js"
import {
  PHYSICAL_MOTION_OWNERS,
  acquirePhysicalMotionOwner,
  releasePhysicalMotionOwner,
} from "../expression/physicalMotionOwner.js"
import { buildSingleExpressionExportFilename, exportJsonFile } from "../../utils/fileExport.js"
import ExpressionFramePanel from "./ExpressionFramePanel.jsx"
import ExpressionDopeSheetTimeline from "./ExpressionDopeSheetTimeline.jsx"
import FaceRigControls from "./FaceRigControls.jsx"
import NeckExpressionControls from "./NeckExpressionControls.jsx"
import SerialCapsulePanel from "./serial/SerialCapsulePanel.jsx"
import FaceRealtimePreviewToggle from "./FaceRealtimePreviewToggle.jsx"
import {
  BINDING_OUTPUT_MODES,
  BINDING_OUTPUT_MODE_STORAGE_KEY,
  normalizeBindingOutputMode,
} from "../output/bindingWorkbench/index.js"
import "../style.css"

const RAIL_OUTPUT_MODES = [BINDING_OUTPUT_MODES.BUS_SERVO]

export default function FaceExpressionEditor({
  configs = [],
  frameProject,
  onFrameProjectChange,
  currentPose,
  onCurrentPoseChange,
  servoConfigSnapshot = null,
  apiRef = null,
}) {
  const expressionPlaybackActiveRef = useRef(false)
  const [timelinePlaying, setTimelinePlaying] = useState(false)
  const [neckPose, setNeckPose] = useState(() => createNeutralNeckPose())
  const browserSlcanRef = useRef(null)
  const browserRuntimeRef = useRef(null)
  const connectNeckServiceRef = useRef(null)
  const [browserSlcanState, setBrowserSlcanState] = useState(null)
  const [browserRuntimeSnap, setBrowserRuntimeSnap] = useState(null)
  const [connectBusy, setConnectBusy] = useState(false)
  const [connectError, setConnectError] = useState(null)

  useEffect(() => {
    detectWebSerialCapability()
    const transport = getSharedBrowserSlcanTransport()
    browserSlcanRef.current = transport
    const host = createBrowserNeckRuntimeHost({
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
    // Lazy profile resolve on Connect — avoid Face-only noise; still OK to prefetch silently
    void host.resolveStartupProfile().catch(() => {})
    const unsubTransport = subscribeBrowserSlcanState((s) => {
      setBrowserSlcanState(s)
      if (s?.state === "READY" || s?.slcanReady) {
        host.notifyTransportReady()
      } else if (
        s?.state === "ERROR" ||
        s?.state === "DISCONNECTED" ||
        s?.state === "CLOSED"
      ) {
        const snap = host.getSnapshot?.() || {}
        // CLOSED at cold start is legal; only tear down when we had physical activity
        if (snap.enabled || snap.estop || snap.calibratingNeutral || snap.transportReady) {
          host.notifyTransportLost()
        }
      }
    })
    const unsubRuntime = host.subscribeSnapshot((snap) => setBrowserRuntimeSnap({ ...snap }))
    return () => {
      unsubTransport()
      unsubRuntime()
      try {
        const hostSnap = host.getSnapshot?.() || {}
        if (hostSnap.calibratingNeutral) {
          host.exitNeutralCalibration?.({ discardUnsaved: true })
        }
        if (hostSnap.stale || hostSnap.state === "STALE_SAFE_HOLD") {
          host.resume?.()
        }
        host.setHardwarePreview?.(false)
        host.disableMotors?.({ discardUnsaved: true })
      } catch {
        /* ignore */
      }
      browserSlcanRef.current = null
      browserRuntimeRef.current = null
      connectNeckServiceRef.current = null
      void host.dispose()
      void releaseSharedBrowserSlcanTransport()
    }
  }, [])

  useEffect(() => {
    if (browserRuntimeSnap?.calibratingNeutral) {
      acquirePhysicalMotionOwner(PHYSICAL_MOTION_OWNERS.NECK_CALIBRATION)
    } else {
      releasePhysicalMotionOwner(PHYSICAL_MOTION_OWNERS.NECK_CALIBRATION)
    }
    return () => releasePhysicalMotionOwner(PHYSICAL_MOTION_OWNERS.NECK_CALIBRATION)
  }, [browserRuntimeSnap?.calibratingNeutral])

  const rig = useFaceRigInteraction(configs, {
    blockRealtimeHardwareRef: expressionPlaybackActiveRef,
  })

  const prepareLeave = useCallback(async () => {
    // Leaving expression control page: stop face/neck live drive for safety.
    try {
      rig.setRealtimePreview?.(false)
    } catch {
      /* ignore */
    }
    const host = browserRuntimeRef.current
    try {
      host?.setHardwarePreview?.(false)
    } catch {
      /* ignore */
    }
    try {
      if (host?.getSnapshot?.()?.calibratingNeutral) {
        host.exitNeutralCalibration?.({ discardUnsaved: true })
      }
    } catch {
      /* ignore */
    }
    try {
      if (host?.getSnapshot?.()?.stale || host?.getSnapshot?.()?.state === "STALE_SAFE_HOLD") {
        host.resume?.()
      }
    } catch {
      /* ignore */
    }
    try {
      connectNeckServiceRef.current?.disableNeckMotors?.({ discardUnsaved: true })
    } catch {
      /* ignore */
    }
  }, [rig])

  useEffect(() => {
    if (!apiRef || typeof apiRef !== "object") return undefined
    apiRef.current = {
      prepareLeave,
    }
    return () => {
      apiRef.current = null
    }
  }, [apiRef, prepareLeave])

  const neckLimits = useMemo(
    () =>
      mergeNeckSemanticLimits(
        browserRuntimeSnap?.semanticLimits || browserRuntimeSnap?.profile?.semantic
      ),
    [browserRuntimeSnap]
  )

  const handlePlayingChange = useCallback((state) => {
    const blocks =
      state && typeof state === "object"
        ? Boolean(state.blocksManualRealtime)
        : Boolean(state)
    const playing =
      state && typeof state === "object" ? Boolean(state.isPlaying) : Boolean(state)
    const wasPlaying = expressionPlaybackActiveRef.current
    expressionPlaybackActiveRef.current = blocks
    setTimelinePlaying(playing)
    const host = browserRuntimeRef.current
    if (host && canDispatchNeckHardware(frameProject)) {
      if (!playing && wasPlaying) {
        host.onTimelinePause()
      }
      if (!playing && !blocks && wasPlaying) {
        host.onTimelineStop()
      }
    }
  }, [frameProject])

  const handleTimelineSample = useCallback(
    (sample) => {
      if (!sample) return
      if (Number.isFinite(Number(sample.timelineTimeMs))) {
        setTimelinePlayheadMs(Math.round(sample.timelineTimeMs))
      }
      const neck = sample.characterPose?.neck
      if (neck && typeof neck === "object") {
        setNeckPose(normalizeNeckPose(neck, { limits: neckLimits }))
      }
      if (sample.rigSnapshot && typeof sample.rigSnapshot === "object") {
        const nextRig = normalizeEliteRig(sample.rigSnapshot)
        rig.setRig(nextRig)
        const logical = mapFaceRigToPose(
          rigValuesFromEliteRig(nextRig),
          rig.normalizedProfile,
          configs,
          rig.mapFaceRigToPoseOptions
        ).logicalPose
        onCurrentPoseChange?.({ ...(currentPose || {}), ...logical })
        return
      }
      const hold = sample.holdKeyframe || sample.fromKeyframe
      if (hold?.positions) {
        onCurrentPoseChange?.({ ...(currentPose || {}), ...hold.positions })
      }
    },
    [
      configs,
      currentPose,
      neckLimits,
      onCurrentPoseChange,
      rig.mapFaceRigToPoseOptions,
      rig.normalizedProfile,
      rig.setRig,
    ]
  )

  const handleDispatchNeck = useCallback(
    async (neck, meta) => {
      if (!neck) {
        return { attempted: false, status: "SKIPPED", sequence: null, error: null }
      }
      if (!canDispatchNeckHardware(frameProject)) {
        return { attempted: false, status: "SKIPPED", sequence: null, error: "NECK_MODULE_OFF" }
      }
      const host = browserRuntimeRef.current
      if (!host) {
        return { attempted: false, status: "SKIPPED", sequence: null, error: null }
      }
      const snap = host.getSnapshot?.() || {}
      const fromScrub = Boolean(meta?.fromScrub)
      // Scrub/click：等同手动编辑，需勾选「硬件预览」；播放路径不强制该门控
      const source = fromScrub ? "editor" : "timeline"
      const hardwarePreviewGate = fromScrub ? Boolean(snap.hardwarePreview) : true
      if (fromScrub && !snap.hardwarePreview) {
        return {
          attempted: false,
          status: "SKIPPED",
          sequence: null,
          error: "HARDWARE_PREVIEW_OFF",
        }
      }
      if (
        !canDispatchNeckPhysical({
          project: frameProject,
          transportReady: Boolean(snap.transportReady),
          motorsEnabled: Boolean(snap.enabled),
          estop: Boolean(snap.estop || snap.estopLatched),
          calibrating: Boolean(snap.calibratingNeutral),
          hardwarePreview: hardwarePreviewGate,
          source,
        })
      ) {
        return { attempted: false, status: "SKIPPED", sequence: null, error: "NECK_PHYSICAL_GATE" }
      }
      const characterSampleAt = performance.now()
      const ok = host.offerTarget({
        pose: neck,
        timelineTimeMs: meta?.timelineTimeMs,
        source,
      })
      const after = host.getSnapshot()
      recordCharacterDispatchTiming({
        timelineTimeMs: meta?.timelineTimeMs,
        characterSampleAt,
        faceDispatchAt: characterSampleAt,
        neckTargetPreparedAt: characterSampleAt,
        neckSocketSendAt: performance.now(),
        sequence: after.target?.latestSequence,
        bridgeLastAcceptedSequence: null,
      })
      return {
        attempted: true,
        status: ok ? "SENT" : "SKIPPED",
        sequence: after.target?.latestSequence ?? null,
        error: ok ? null : "BROWSER_RUNTIME_SKIPPED",
      }
    },
    [frameProject]
  )

  const syncDriveArm = useCallback(
    (mode, realtimeOn) => {
      rig.setDriveArmed(Boolean(realtimeOn && RAIL_OUTPUT_MODES.includes(mode)))
    },
    [rig]
  )

  const resolveRailOutputMode = useCallback(() => {
    const current = normalizeBindingOutputMode(rig.outputMode)
    if (RAIL_OUTPUT_MODES.includes(current)) {
      return current
    }
    try {
      const stored = localStorage.getItem(BINDING_OUTPUT_MODE_STORAGE_KEY)
      if (stored) {
        const normalized = normalizeBindingOutputMode(stored)
        if (RAIL_OUTPUT_MODES.includes(normalized)) {
          return normalized
        }
      }
    } catch {
      //
    }
    return BINDING_OUTPUT_MODES.BUS_SERVO
  }, [rig.outputMode])

  useEffect(() => {
    if (!RAIL_OUTPUT_MODES.includes(rig.outputMode)) {
      rig.setOutputMode(resolveRailOutputMode())
    }
  }, [rig.outputMode, rig.setOutputMode, resolveRailOutputMode])

  const handleRealtimePreviewChange = useCallback(
    (checked) => {
      const mode = resolveRailOutputMode()
      if (!RAIL_OUTPUT_MODES.includes(rig.outputMode)) {
        rig.setOutputMode(mode)
      }
      rig.setRealtimePreview(checked)
      syncDriveArm(mode, checked)
    },
    [rig, resolveRailOutputMode, syncDriveArm]
  )

  const [selectedFrameIndex, setSelectedFrameIndex] = useState(0)
  const [mergeHint, setMergeHint] = useState("")
  const [defaultDurationMs, setDefaultDurationMs] = useState(500)
  const [timelinePlayheadMs, setTimelinePlayheadMs] = useState(0)
  const [sideTab, setSideTab] = useState("frame")
  const [keyframeTimeDraft, setKeyframeTimeDraft] = useState(null)
  const projectFileInputRef = useRef(null)
  const committedLogicalPoseJsonRef = useRef("")
  const lastKeyframeSyncTokenRef = useRef("")
  const [hasUnsavedRigPose, setHasUnsavedRigPose] = useState(false)

  const handleNeckChange = useCallback(
    (next) => {
      if (!canEditNeckPose(frameProject)) return
      const pose = normalizeNeckPose(next, { limits: neckLimits })
      setNeckPose(pose)
      const host = browserRuntimeRef.current
      const snap = host?.getSnapshot?.() || {}
      if (
        !canDispatchNeckPhysical({
          project: frameProject,
          transportReady: Boolean(snap.transportReady),
          motorsEnabled: Boolean(snap.enabled),
          estop: Boolean(snap.estop || snap.estopLatched),
          calibrating: Boolean(snap.calibratingNeutral),
          hardwarePreview: Boolean(snap.hardwarePreview),
          source: "editor",
        })
      ) {
        return
      }
      host.offerTarget?.({
        pose,
        timelineTimeMs: timelinePlayheadMs,
        source: "editor",
      })
    },
    [neckLimits, timelinePlayheadMs, frameProject]
  )

  useEffect(() => {
    const cur = JSON.stringify(rig.logicalPose)
    setHasUnsavedRigPose(cur !== committedLogicalPoseJsonRef.current)
  }, [rig.logicalPose])

  const commitRigPoseBaseline = useCallback(() => {
    committedLogicalPoseJsonRef.current = JSON.stringify(rig.logicalPose)
    setHasUnsavedRigPose(false)
  }, [rig.logicalPose])

  const currentControlInspect = useMemo(() => {
    const id = rig.selectedControlId
    if (!id) {
      return null
    }
    const ctrl = rig.normalizedProfile.controls.find((c) => c.controlId === id)
    const label = ctrl?.label ?? id
    const paths = rig.contributions.filter((c) => c.controlId === id)
    const servoIds = [...new Set(paths.map((p) => Number(p.servoId)))].sort((a, b) => a - b)
    const rv = rig.rigValues[id] || {}
    const parts = []
    const chans = ctrl?.channels || {}
    if (Object.prototype.hasOwnProperty.call(chans, "value")) {
      const v = rv.value
      parts.push(`value: ${v === undefined || v === null || Number.isNaN(Number(v)) ? "—" : String(v)}`)
    }
    if (Object.prototype.hasOwnProperty.call(chans, "x")) {
      const v = rv.x
      parts.push(`x: ${v === undefined || v === null || Number.isNaN(Number(v)) ? "—" : String(v)}`)
    }
    if (Object.prototype.hasOwnProperty.call(chans, "y")) {
      const v = rv.y
      parts.push(`y: ${v === undefined || v === null || Number.isNaN(Number(v)) ? "—" : String(v)}`)
    }
    const ch = rig.selectedChannel
    return {
      label,
      controlId: id,
      channelTag: `${id}.${ch}`,
      valueText: parts.length ? parts.join(" · ") : "—",
      outputPathCount: paths.length,
      servoIds,
    }
  }, [rig.selectedControlId, rig.normalizedProfile, rig.contributions, rig.rigValues, rig.selectedChannel])

  const normalizedProject = useMemo(
    () => normalizeFrameProject(frameProject, configs),
    [frameProject, configs]
  )
  const keyframes = normalizedProject.keyframes || []
  const fullFaceKeyframes = useMemo(
    () => keyframes.filter((kf) => isFullFaceKeyed(kf.keyedChannels)),
    [keyframes]
  )
  const totalDurationMs = Math.max(0, Number(normalizedProject.timelineDurationMs) || 0)

  useEffect(() => {
    if (selectedFrameIndex >= keyframes.length) {
      setSelectedFrameIndex(Math.max(0, keyframes.length - 1))
    }
  }, [keyframes.length, selectedFrameIndex])

  useEffect(() => {
    const d = normalizedProject.timelineDurationMs
    if (Number.isFinite(d) && d >= 20) {
      setDefaultDurationMs(Math.min(d, 1000))
    }
  }, [normalizedProject.expressionId, normalizedProject.timelineDurationMs])

  const selectedKeyframe = keyframes[selectedFrameIndex] || null
  const selectedIsFullFace = selectedKeyframe ? isFullFaceKeyed(selectedKeyframe.keyedChannels) : false

  useEffect(() => {
    setKeyframeTimeDraft(null)
  }, [selectedKeyframe?.keyframeId])

  useLayoutEffect(() => {
    if (timelinePlaying) {
      return
    }
    if (!selectedKeyframe) {
      lastKeyframeSyncTokenRef.current = ""
      return
    }
    const token = `${selectedKeyframe.keyframeId}:${selectedKeyframe.timeMs}:${JSON.stringify(selectedKeyframe.keyedChannels)}`
    if (lastKeyframeSyncTokenRef.current === token) {
      return
    }
    lastKeyframeSyncTokenRef.current = token

    // 正式预览必须用 Timeline Sample @ time（不可直接灌 partial event.rigSnapshot）
    const sample = sampleExpressionTimeline(normalizedProject, selectedKeyframe.timeMs)
    let approx = null
    if (sample?.rigSnapshot && typeof sample.rigSnapshot === "object") {
      approx = normalizeEliteRig(sample.rigSnapshot)
    } else if (selectedKeyframe.rigSnapshot && typeof selectedKeyframe.rigSnapshot === "object") {
      approx = normalizeEliteRig(selectedKeyframe.rigSnapshot)
    } else if (isCenterOnlyLogicalPose(selectedKeyframe.positions)) {
      approx = createInitialEliteRig()
    } else {
      approx = approximateEliteRigFromKeyframePositions(
        selectedKeyframe.positions,
        rig.normalizedProfile,
        configs
      )
    }
    rig.setRig(approx)
    const neckFromSample = sample?.characterPose?.neck
    if (neckFromSample) {
      setNeckPose(normalizeNeckPose(neckFromSample, { limits: neckLimits }))
    } else if (selectedKeyframe.characterPose?.neck) {
      setNeckPose(normalizeNeckPose(selectedKeyframe.characterPose.neck, { limits: neckLimits }))
    } else {
      setNeckPose(createNeutralNeckPose())
    }
    const logicalSynced = mapFaceRigToPose(
      rigValuesFromEliteRig(approx),
      rig.normalizedProfile,
      configs,
      rig.mapFaceRigToPoseOptions
    ).logicalPose
    committedLogicalPoseJsonRef.current = JSON.stringify(logicalSynced)
    setHasUnsavedRigPose(false)
    setTimelinePlayheadMs(Math.round(Number(selectedKeyframe.timeMs) || 0))
    rig.setSelectedControlId(null)
  }, [
    selectedKeyframe,
    timelinePlaying,
    normalizedProject,
    rig.normalizedProfile,
    configs,
    rig.mapFaceRigToPoseOptions,
    rig.setRig,
    rig.setSelectedControlId,
    neckLimits,
  ])

  const emitProject = useCallback(
    (next) => {
      onFrameProjectChange?.(normalizeFrameProject(next, configs))
    },
    [onFrameProjectChange, configs]
  )

  const flashHint = useCallback((msg) => {
    setMergeHint(msg)
    window.setTimeout(() => setMergeHint(""), 2800)
  }, [])

  const handleWriteCurrentKeyframe = useCallback(() => {
    // 在当前 Playhead upsert 整脸 Key（无则创建，有则更新为完整 ALL）
    const t = Math.max(0, Math.round(Number(timelinePlayheadMs) || 0))
    const writeNeck = shouldWriteNeckOnFullCharacterKey(normalizedProject)
    const next = addFullFaceKeyAtTime(
      normalizedProject,
      t,
      rig.rig,
      createPoseFromServos(configs, {
        ...(selectedIsFullFace && selectedKeyframe ? selectedKeyframe.positions : {}),
        ...rig.logicalPose,
      }),
      configs,
      {
        name: selectedIsFullFace && selectedKeyframe ? selectedKeyframe.name : `Key @${t}`,
        neck: writeNeck ? neckPose : undefined,
        writeNeck,
      }
    )
    emitProject(next)
    const idx = next.keyframes.findIndex(
      (k) => Math.round(k.timeMs) === t && isFullFaceKeyed(k.keyedChannels)
    )
    setSelectedFrameIndex(idx >= 0 ? idx : next.keyframes.length - 1)
    const nextPose = { ...currentPose, ...rig.logicalPose }
    onCurrentPoseChange?.(nextPose)
    flashHint(
      writeNeck
        ? `已写入 Character Key @ ${t} ms（Face + Neck）。`
        : `已写入 Character Key @ ${t} ms（Face；Neck 未覆盖）。`
    )
    commitRigPoseBaseline()
  }, [
    timelinePlayheadMs,
    selectedIsFullFace,
    selectedKeyframe,
    rig.logicalPose,
    rig.rig,
    neckPose,
    normalizedProject,
    configs,
    emitProject,
    currentPose,
    onCurrentPoseChange,
    flashHint,
    commitRigPoseBaseline,
  ])

  const handleExpressionNameChange = useCallback(
    (value) => {
      emitProject(updateExpressionName(normalizedProject, value, configs))
    },
    [normalizedProject, configs, emitProject]
  )

  const handleNewExpression = useCallback(() => {
    emitProject(createDefaultFrameProject(configs))
    setSelectedFrameIndex(0)
    flashHint("已新建表情工程。")
  }, [configs, emitProject, flashHint])

  const handleSaveProject = useCallback(() => {
    const payload = saveFrameProject(normalizedProject, configs)
    emitProject(payload)
    flashHint("表情动作已保存到浏览器本地。")
  }, [normalizedProject, configs, emitProject, flashHint])

  const handleClearProject = useCallback(() => {
    emitProject(createDefaultFrameProject(configs))
    setSelectedFrameIndex(0)
    setTimelinePlayheadMs(0)
    flashHint("已清空当前表情工程。")
  }, [configs, emitProject, flashHint])

  const handleExportProject = useCallback(() => {
    const payload = buildFrameProjectExport(normalizedProject, servoConfigSnapshot, configs)
    const filename = buildSingleExpressionExportFilename(
      normalizedProject.expressionName,
      normalizedProject.expressionId
    )
    exportJsonFile(filename, payload)
    flashHint(`工程已导出：${filename}`)
  }, [normalizedProject, servoConfigSnapshot, configs, flashHint])

  const handleProjectImportFile = useCallback(
    (event) => {
      const file = event.target.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        try {
          const data = JSON.parse(String(reader.result || "{}"))
          const imported = normalizeFrameProject(data, configs)
          emitProject(imported)
          setSelectedFrameIndex(0)
          flashHint(`已导入：${file.name}`)
        } catch (error) {
          flashHint(`导入失败：${error.message}`)
        } finally {
          event.target.value = ""
        }
      }
      reader.readAsText(file)
    },
    [configs, emitProject, flashHint]
  )

  const updateSelectedKeyframeMeta = useCallback(
    (patch) => {
      if (!selectedKeyframe) return
      emitProject(updateKeyframe(normalizedProject, selectedKeyframe.keyframeId, patch, configs))
    },
    [selectedKeyframe, normalizedProject, configs, emitProject]
  )

  const handleInsertKeyframe = useCallback(
    (offset) => {
      const baseTime = selectedKeyframe ? Number(selectedKeyframe.timeMs) || 0 : timelinePlayheadMs
      const t = Math.max(0, baseTime + (offset > 0 ? defaultDurationMs : 0))
      const writeNeck = shouldWriteNeckOnFullCharacterKey(normalizedProject)
      const next = addFullFaceKeyAtTime(
        normalizedProject,
        t,
        rig.rig,
        createPoseFromServos(configs, rig.logicalPose),
        configs,
        {
          name: `Key ${fullFaceKeyframes.length + 1}`,
          neck: writeNeck ? neckPose : undefined,
          writeNeck,
        }
      )
      emitProject(next)
      const idx = next.keyframes.findIndex(
        (k) => Math.round(k.timeMs) === Math.round(t) && isFullFaceKeyed(k.keyedChannels)
      )
      setSelectedFrameIndex(idx >= 0 ? idx : selectedFrameIndex)
      flashHint(offset > 0 ? "已在后方插入 Character Key。" : "已在当前时间写入 Character Key。")
    },
    [
      selectedKeyframe,
      timelinePlayheadMs,
      defaultDurationMs,
      normalizedProject,
      rig.rig,
      rig.logicalPose,
      neckPose,
      configs,
      fullFaceKeyframes.length,
      emitProject,
      selectedFrameIndex,
      flashHint,
    ]
  )

  const handleDeleteKeyframe = useCallback(() => {
    if (!selectedKeyframe) return
    if (!isFullFaceKeyed(selectedKeyframe.keyedChannels)) {
      flashHint("侧栏仅删除整脸关键帧；单属性 Key 请在 Dope Sheet 中操作。")
      return
    }
    const next = deleteKeyframe(normalizedProject, selectedKeyframe.keyframeId, configs)
    emitProject(next)
    setSelectedFrameIndex(Math.max(0, selectedFrameIndex - 1))
    flashHint("已删除整脸关键帧。")
  }, [selectedKeyframe, normalizedProject, configs, emitProject, selectedFrameIndex, flashHint])

  const handleMoveKeyframe = useCallback(
    (delta) => {
      if (selectedFrameIndex < 0) return
      const nextIndex = selectedFrameIndex + delta
      const next = moveKeyframe(normalizedProject, selectedFrameIndex, nextIndex, configs)
      emitProject(next)
      setSelectedFrameIndex(nextIndex)
    },
    [selectedFrameIndex, normalizedProject, configs, emitProject]
  )

  const handleResetFullRig = useCallback(() => {
    rig.setRig(createInitialEliteRig())
    flashHint("已重置全部面控。")
  }, [rig.setRig, flashHint])

  const handleResetEyesOnly = useCallback(() => {
    const fresh = createInitialEliteRig()
    rig.setRig((prev) => ({
      ...prev,
      browL: fresh.browL,
      browR: fresh.browR,
      eyeL: fresh.eyeL,
      eyeR: fresh.eyeR,
      noseL: fresh.noseL,
      noseR: fresh.noseR,
      sharedRadar: fresh.sharedRadar,
    }))
    flashHint("已重置眼部控件。")
  }, [rig.setRig, flashHint])

  const handleResetMouthOnly = useCallback(() => {
    const fresh = createInitialEliteRig()
    rig.setRig((prev) => ({
      ...prev,
      mouth: fresh.mouth,
      tongue: fresh.tongue,
      jaw: fresh.jaw,
    }))
    flashHint("已重置口部控件。")
  }, [rig.setRig, flashHint])

  const neckModule = getProjectNeckModule(normalizedProject)

  const handleNeckModuleEnabledChange = useCallback(
    (on) => {
      emitProject(patchProjectNeckModule(normalizedProject, { enabled: Boolean(on) }))
      setConnectError(null)
      flashHint(on ? "已启用 Neck 模块" : "已关闭 Neck 模块")
    },
    [emitProject, normalizedProject, flashHint]
  )

  const handleConnectNeck = useCallback(async () => {
    setConnectBusy(true)
    setConnectError(null)
    try {
      const result = await connectNeckServiceRef.current?.connectNeck?.()
      notifyBrowserSlcanState()
      if (!result?.ok) {
        setConnectError(result?.error?.message || "连接 Neck 失败")
      } else {
        flashHint("Neck 已连接 · 电机未使能")
      }
    } catch (err) {
      setConnectError(err?.message || String(err))
    } finally {
      setConnectBusy(false)
    }
  }, [flashHint])

  const handleDisconnectNeck = useCallback(async () => {
    await connectNeckServiceRef.current?.disconnectNeck?.()
    notifyBrowserSlcanState()
    setConnectError(null)
    flashHint("Neck 已断开")
  }, [flashHint])

  const neckSlot = (
    <NeckExpressionControls
      moduleEnabled={neckModule.enabled}
      onModuleEnabledChange={handleNeckModuleEnabledChange}
      neckPose={neckPose}
      onNeckChange={handleNeckChange}
      limits={neckLimits}
      timelinePlaying={timelinePlaying}
      runtimeSnapshot={browserRuntimeSnap}
      transportState={browserSlcanState}
      onConnectNeck={handleConnectNeck}
      onDisconnectNeck={handleDisconnectNeck}
      onEnableMotors={async () => {
        setConnectError(null)
        const r = await connectNeckServiceRef.current?.enableNeckMotors?.()
        if (r && r.ok === false) {
          setConnectError(r.error?.message || "使能电机失败")
        } else {
          flashHint("电机已使能 · 就绪")
        }
      }}
      onDisableMotors={() => {
        connectNeckServiceRef.current?.disableNeckMotors?.({ discardUnsaved: true })
        flashHint("电机已失能")
      }}
      onEstop={() => connectNeckServiceRef.current?.estop?.()}
      onClearEstop={() => {
        setConnectError(null)
        const r = connectNeckServiceRef.current?.clearEstop?.()
        if (r && r.ok === false) {
          setConnectError(r.error?.message || "清除 ESTOP 失败")
        } else {
          flashHint("ESTOP 已清除 · 电机仍未使能")
        }
      }}
      onEnterCalibration={() => {
        setConnectError(null)
        const r = browserRuntimeRef.current?.enterNeutralCalibration?.()
        if (r && r.ok === false) {
          setConnectError(r.error?.message || "无法进入标定")
        }
      }}
      onExitCalibration={(opts) => browserRuntimeRef.current?.exitNeutralCalibration?.(opts)}
      onNudgeCalibration={(side, delta) =>
        browserRuntimeRef.current?.nudgeCalibrationOffset?.(side, delta)
      }
      onResetCalibrationTrim={() => browserRuntimeRef.current?.resetCalibrationTrim?.()}
      onSaveCalibration={async () => {
        setConnectError(null)
        const r = await browserRuntimeRef.current?.saveCalibration?.()
        if (r && r.ok === false) {
          setConnectError(r.error?.message || "标定保存失败")
          return r
        }
        flashHint("机械中位已保存")
        return r || { ok: true }
      }}
      onCancelCalibration={() => browserRuntimeRef.current?.cancelCalibration?.()}
      hardwarePreview={Boolean(browserRuntimeSnap?.hardwarePreview)}
      onHardwarePreviewChange={(on) => browserRuntimeRef.current?.setHardwarePreview?.(on)}
      connectBusy={connectBusy}
      connectError={neckModule.enabled ? connectError : null}
      onNotify={flashHint}
    />
  )

  return (
    <section className="face-expression-page">
      <div className="face-expression-upper-dock">
        <div className="face-expression-top-cluster">
          <header className="face-expression-toolbar face-expression-toolbar--merged" aria-label="表情动画编辑器工具栏">
            <label className="face-expression-toolbar-name">
              <span className="face-expression-toolbar-label">表情名称</span>
              <input
                type="text"
                value={normalizedProject.expressionName}
                onChange={(e) => handleExpressionNameChange(e.target.value)}
              />
            </label>
            <div className="face-expression-toolbar-stats">
              <span>关键帧 {keyframes.length}</span>
              <span>总时长 {totalDurationMs} ms</span>
            </div>
            <div className="face-expression-toolbar-right">
              <SerialCapsulePanel transportMode="bus" />
              <FaceRealtimePreviewToggle
                checked={rig.realtimePreview}
                onChange={handleRealtimePreviewChange}
              />
            </div>
          </header>
        </div>
      </div>

      <div className="face-expression-main">
        <div className="face-expression-rig-actions" aria-label="Face Rig 快捷操作">
          <div className="face-expression-rig-actions-reset">
            <button type="button" className="btn-secondary face-expression-rig-reset-btn" onClick={handleResetFullRig}>
              重置面控
            </button>
            <button type="button" className="btn-secondary face-expression-rig-reset-btn" onClick={handleResetEyesOnly}>
              重置眼部
            </button>
            <button type="button" className="btn-secondary face-expression-rig-reset-btn" onClick={handleResetMouthOnly}>
              重置口部
            </button>
          </div>
        </div>
        <FaceRigControls
          variant="console"
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
          neckSlot={neckSlot}
        />

        <div className="face-expression-side-stack" aria-label="当前帧与动作工程">
          <ExpressionFramePanel
            sideTab={sideTab === "project" ? "frame" : sideTab}
            setSideTab={setSideTab}
            mergeHint={mergeHint}
            hasUnsavedRigPose={hasUnsavedRigPose}
            rig={rig}
            keyframes={fullFaceKeyframes}
            selectedKeyframe={selectedIsFullFace ? selectedKeyframe : null}
            selectedFrameIndex={selectedFrameIndex}
            keyframeTimeDraft={keyframeTimeDraft}
            setKeyframeTimeDraft={setKeyframeTimeDraft}
            updateSelectedKeyframeMeta={updateSelectedKeyframeMeta}
            handleWriteCurrentKeyframe={handleWriteCurrentKeyframe}
            currentControlInspect={currentControlInspect}
            handleInsertKeyframe={handleInsertKeyframe}
            handleMoveKeyframe={handleMoveKeyframe}
            handleDeleteKeyframe={handleDeleteKeyframe}
            defaultDurationMs={defaultDurationMs}
            setDefaultDurationMs={setDefaultDurationMs}
            handleNewExpression={handleNewExpression}
            handleSaveProject={handleSaveProject}
            handleClearProject={handleClearProject}
            handleExportProject={handleExportProject}
            handleProjectImportFile={handleProjectImportFile}
            projectFileInputRef={projectFileInputRef}
            structureEditLocked={timelinePlaying}
          />
        </div>
      </div>

      <div className="face-expression-bottom face-expression-timeline-dock">
        <ExpressionDopeSheetTimeline
          frameProject={normalizedProject}
          configs={configs}
          currentRig={rig.rig}
          currentNeck={neckPose}
          writeNeckOnFullKey={shouldWriteNeckOnFullCharacterKey(normalizedProject)}
          logicalPose={rig.logicalPose}
          selectedFrameIndex={selectedFrameIndex}
          onSelectFrameIndex={setSelectedFrameIndex}
          onProjectChange={emitProject}
          onTimelineSample={handleTimelineSample}
          dispatchNeck={handleDispatchNeck}
          externalPlayheadMs={timelinePlayheadMs}
          onPlayingChange={handlePlayingChange}
          structureEditLocked={false}
        />
      </div>
    </section>
  )
}
