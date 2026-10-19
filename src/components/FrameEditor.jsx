import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  addKeyframe,
  buildFrameProjectExport,
  copyKeyframe,
  createDefaultFrameProject,
  createKeyframe,
  createPoseFromServos,
  deleteKeyframe,
  insertKeyframe,
  loadFrameProject,
  moveKeyframe,
  normalizeFrameProject,
  saveFrameProject,
  updateExpressionName,
  updateKeyframe,
} from "../core/frameProject.js"
import {
  EXPRESSION_HARDWARE_SAMPLE_INTERVAL_MS,
  createLatestWinsCadenceGate,
  playKeyframe,
  playKeyframes,
} from "../core/actionPlayer.js"
import {
  PHYSICAL_MOTION_OWNERS,
  acquirePhysicalMotionOwner,
  releasePhysicalMotionOwner,
} from "../sdk/expression/physicalMotionOwner.js"
import {
  buildExpressionTimeline,
  buildTransientKeyframeFromSample,
  sampleExpressionTimeline,
} from "../core/expressionTimelineSampler.js"
import { dispatchKeyframeToHardware } from "../sdk/expression/keyframePlaybackDispatch.js"
import {
  SERVO_COUNT,
  SERVO_LOGICAL_MAX_PWM,
  SERVO_LOGICAL_MIN_PWM,
  STANDARD_CENTER_PWM,
  getServoConfig,
  logicalToActualPwm,
} from "../core/servoConfig.js"
import { clampNumber, toInt } from "../utils/clamp.js"
import { buildSingleExpressionExportFilename, exportJsonFile } from "../utils/fileExport.js"
import SerialCapsulePanel from "../sdk/react/serial/SerialCapsulePanel.jsx"
import {
  sendLegacyLogicalPwmViaBus,
  sendAllBusProfilesToCenter,
} from "../sdk/output/adapters/legacyLogicalBusSend.js"
import {
  getActiveBusTransportLabel,
  isSharedBusWireConnected,
} from "../sdk/servoAdapters/busServo/resolveBusTransport.js"
import "../styles/frame-editor.css"

const DEFAULT_FRAME_MS = 500
const REALTIME_SEND_INTERVAL_MS = 80
const RESIZER_HEIGHT = 6
const MIN_TIMELINE_HEIGHT = 56
/** 底部时间轴默认高度（px）；与 frame-editor.css 中 .timeline-dock 的 height 保持一致 */
const DEFAULT_TIMELINE_HEIGHT = 220
const MIN_TOP_LAYER_HEIGHT = 420

const DEFAULT_PIXELS_PER_MS = 0.5
const MIN_PIXELS_PER_MS = 0.08
const MAX_PIXELS_PER_MS = 3
const ZOOM_RATIO = 1.25

const SERVO_GROUP_LABEL = {
  ungrouped: "未分组",
  brow: "眉部",
  eye: "眼部",
  mouth: "嘴部",
  cheek: "脸颊",
  aux: "辅助",
}
 
function servoGroupLabel(groupId) {
  return SERVO_GROUP_LABEL[groupId] || groupId || "未分组"
}

const EASING_LABEL_ZH = {
  linear: "线性",
}

export default function FrameEditor({
  project,
  configs,
  currentPose,
  onProjectChange,
  onCurrentPoseChange,
  servoConfigSnapshot = null,
  /** 仅渲染底部时间轴与播放条（用于表情编排页嵌入） */
  timelineOnly = false,
  /**
   * 与 timelineOnly 配合：把时间轴自带的「播放全部/单帧/区间/停止播放/循环」移到外部渲染；
   * 仍保留缩放、刻度尺与帧条区域的滚轮缩放；「停止全部舵机」在时间轴中也一并隐藏（由宿主工具栏承载）。
   */
  externalPlaybackBar = false,
  /** 可选：指向 `{ current }` 的可变对象，每帧同步当前播放/缩放等 API（供外部 ExpressionPlaybackBar 使用） */
  playbackExposeRef = null,
  /** 当 playbackExposeRef 更新时调用，便于外部组件强制重渲染以刷新禁用态 */
  onPlaybackUiBump = null,
  /** timelineOnly 时向宿主页面回传播放状态（成功/失败提示） */
  onPlaybackStatus = null,
  /** 与 {@link onSelectedFrameIndexChange} 同时传入时，由父组件控制当前选中关键帧索引 */
  selectedFrameIndex: selectedFrameIndexProp,
  onSelectedFrameIndexChange,
  /** 播放中 / 暂停状态变化（用于与手动 Face Rig realtime 互斥） */
  onPlayingChange = null,
  /** 时间轴采样（播放 / scrub）：宿主可据此更新 Face Rig 预览 */
  onTimelineSample = null,
  /** 为 true 时，scrub 可走受控 cadence 硬件预览 */
  hardwarePreviewArmed = false,
}) {
  const normalizedConfigs = useMemo(() => {
    if (Array.isArray(configs) && configs.length) return configs

    return Array.from({ length: SERVO_COUNT }, (_, servoId) => ({
      servoId,
      name: `舵机 ${servoId}`,
      enabled: true,
      actualMinPwm: 500,
      actualMaxPwm: 2500,
      mechanicalZeroPwm: STANDARD_CENTER_PWM,
      zeroOffsetPwm: 0,
      direction: 1,
    }))
  }, [configs])

  const normalized = useMemo(() => {
    return normalizeFrameProject(project, normalizedConfigs)
  }, [project, normalizedConfigs])

  const keyframes = normalized.keyframes || []
  const expressionTimeline = useMemo(() => buildExpressionTimeline(keyframes), [keyframes])
  const totalDuration = expressionTimeline.totalDurationMs

  const [internalSelectedFrameIndex, setInternalSelectedFrameIndex] = useState(0)
  const isControlledFrameIndex = typeof onSelectedFrameIndexChange === "function"
  const maxKeyframeIndex = Math.max(0, keyframes.length - 1)
  const selectedFrameIndex = isControlledFrameIndex
    ? clampNumber(toInt(selectedFrameIndexProp, 0), 0, maxKeyframeIndex)
    : clampNumber(internalSelectedFrameIndex, 0, maxKeyframeIndex)

  const setSelectedFrameIndex = useCallback(
    (next) => {
      const cur = isControlledFrameIndex
        ? clampNumber(toInt(selectedFrameIndexProp, 0), 0, maxKeyframeIndex)
        : internalSelectedFrameIndex
      const resolved = typeof next === "function" ? next(cur) : next
      const clamped = clampNumber(toInt(resolved, 0), 0, maxKeyframeIndex)
      if (isControlledFrameIndex) {
        onSelectedFrameIndexChange(clamped)
      } else {
        setInternalSelectedFrameIndex(clamped)
      }
    },
    [
      isControlledFrameIndex,
      selectedFrameIndexProp,
      internalSelectedFrameIndex,
      maxKeyframeIndex,
      onSelectedFrameIndexChange,
    ]
  )

  const [draftPose, setDraftPose] = useState({})
  const [durationMs, setDurationMs] = useState(DEFAULT_FRAME_MS)
  const [selectedRange, setSelectedRange] = useState(null)
  const [isLoop, setIsLoop] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [playheadPos, setPlayheadPos] = useState(0)
  const [statusText, setStatusText] = useState("")
  const [lastCommand, setLastCommand] = useState("")
  const [timelineHeight, setTimelineHeight] = useState(DEFAULT_TIMELINE_HEIGHT)
  const [isResizing, setIsResizing] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(240)
  const [isSidebarResizing, setIsSidebarResizing] = useState(false)
  const [pixelsPerMs, setPixelsPerMs] = useState(DEFAULT_PIXELS_PER_MS)
  /** 避免 number 输入在逐字输入时被 Math.max(20,…) 立刻钳死（如输入 500 时中间的 "5" 会变成 20） */
  const [defaultDurationDraft, setDefaultDurationDraft] = useState(null)
  const [keyframeDurationDraft, setKeyframeDurationDraft] = useState(null)

  const editorRef = useRef(null)
  const fileInputRef = useRef(null)
  const realtimeTimerRef = useRef(null)
  const realtimePendingRef = useRef(null)
  const realtimeBusyRef = useRef(false)
  const playAbortRef = useRef(null)
  const playControlRef = useRef(null)
  const scrubHwGateRef = useRef(
    createLatestWinsCadenceGate({ intervalMs: EXPRESSION_HARDWARE_SAMPLE_INTERVAL_MS })
  )
  const timelineScrollRef = useRef(null)
  const rulerScrollRef = useRef(null)
  const isSyncingScrollRef = useRef(false)
  const pendingScrollLeftRef = useRef(null)

  const SNAP_STEP_MS = 50
  const zoomPercent = Math.round((pixelsPerMs / DEFAULT_PIXELS_PER_MS) * 100)

  const bumpPlaybackExpose = useCallback(() => {
    onPlaybackUiBump?.()
  }, [onPlaybackUiBump])

  const keyframePlaybackOptions = useCallback(
    (signal) => ({
      sendKeyframe: ({ keyframe, configs: cfgs, signal: playSignal }) =>
        dispatchKeyframeToHardware({
          keyframe,
          configs: cfgs,
          signal: playSignal ?? signal,
          onCommandPreview: (preview) => setLastCommand(preview),
        }),
      signal,
    }),
    []
  )

  const reportPlaybackStatus = useCallback(
    (message) => {
      if (!message) return
      setStatusText(message)
      onPlaybackStatus?.(message)
    },
    [onPlaybackStatus]
  )

  const tickConfig = useMemo(() => {
    if (pixelsPerMs >= 2) {
      return {
        minorTickMs: 25,
        majorTickMs: 100,
      }
    }

    if (pixelsPerMs >= 1) {
      return {
        minorTickMs: 50,
        majorTickMs: 250,
      }
    }

    if (pixelsPerMs >= 0.4) {
      return {
        minorTickMs: 100,
        majorTickMs: 500,
      }
    }

    if (pixelsPerMs >= 0.18) {
      return {
        minorTickMs: 250,
        majorTickMs: 1000,
      }
    }

    return {
      minorTickMs: 500,
      majorTickMs: 2000,
    }
  }, [pixelsPerMs])

  const selectedKeyframe = keyframes[selectedFrameIndex] || null

  const getTimelineMaxHeight = useCallback(() => {
    const editorHeight = editorRef.current?.clientHeight || 0
    const minTop = timelineOnly ? 56 : MIN_TOP_LAYER_HEIGHT
    return Math.max(0, editorHeight - minTop - RESIZER_HEIGHT)
  }, [timelineOnly])

  const clampTimelineHeight = useCallback(
    (value) => {
      const maxHeight = getTimelineMaxHeight()
      const minHeight = Math.min(MIN_TIMELINE_HEIGHT, maxHeight)
      return Math.max(minHeight, Math.min(value, maxHeight))
    },
    [getTimelineMaxHeight]
  )

  useEffect(() => {
    if (selectedFrameIndex >= keyframes.length) {
      setSelectedFrameIndex(Math.max(0, keyframes.length - 1))
    }
  }, [keyframes.length, selectedFrameIndex, setSelectedFrameIndex])

  const draftSyncKey = useMemo(() => {
    if (!selectedKeyframe) return ""
    if (timelineOnly) {
      return `${selectedKeyframe.keyframeId}:${JSON.stringify(selectedKeyframe.positions)}`
    }
    return selectedKeyframe.keyframeId
  }, [timelineOnly, selectedKeyframe])

  useEffect(() => {
    if (selectedKeyframe) return
    const pose = createPoseFromServos(normalizedConfigs, currentPose)
    setDraftPose(pose)
    onCurrentPoseChange?.(pose)
  }, [selectedKeyframe, currentPose, normalizedConfigs, onCurrentPoseChange])

  useEffect(() => {
    if (!selectedKeyframe) return
    const pose = createPoseFromServos(normalizedConfigs, selectedKeyframe.positions)
    setDraftPose(pose)
    onCurrentPoseChange?.(pose)
  }, [draftSyncKey, selectedKeyframe, normalizedConfigs, onCurrentPoseChange])

  useEffect(() => {
    setKeyframeDurationDraft(null)
  }, [selectedKeyframe?.keyframeId])

  useEffect(() => {
    return () => {
      if (realtimeTimerRef.current) {
        window.clearTimeout(realtimeTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const resize = (mouseMoveEvent) => {
      if (!isResizing) return
      const editorRect = editorRef.current?.getBoundingClientRect()
      if (!editorRect) return
      const rawHeight = editorRect.bottom - mouseMoveEvent.clientY
      setTimelineHeight(clampTimelineHeight(rawHeight))
    }

    const stopResize = () => setIsResizing(false)

    window.addEventListener("mousemove", resize)
    window.addEventListener("mouseup", stopResize)

    return () => {
      window.removeEventListener("mousemove", resize)
      window.removeEventListener("mouseup", stopResize)
    }
  }, [isResizing, clampTimelineHeight])

  useEffect(() => {
    const resizeSidebar = (mouseMoveEvent) => {
      if (!isSidebarResizing) return
      const nextWidth = window.innerWidth - mouseMoveEvent.clientX
      const minWidth = 220
      const maxWidth = 560

      if (nextWidth >= minWidth && nextWidth <= maxWidth) {
        setSidebarWidth(nextWidth)
      }
    }

    const stopResize = () => setIsSidebarResizing(false)

    window.addEventListener("mousemove", resizeSidebar)
    window.addEventListener("mouseup", stopResize)

    return () => {
      window.removeEventListener("mousemove", resizeSidebar)
      window.removeEventListener("mouseup", stopResize)
    }
  }, [isSidebarResizing])

  function emitProjectChange(nextProject) {
    onProjectChange?.(normalizeFrameProject(nextProject, normalizedConfigs))
  }

  function getFrameOffset(index) {
    if (!keyframes.length || index <= 0) return 0
    const timeMs = expressionTimeline.keyframes[index]?.timeMs ?? 0
    return timeMs * pixelsPerMs
  }

  function snapMs(ms) {
    const safe = Math.max(0, toInt(ms, 0))
    return Math.round(safe / SNAP_STEP_MS) * SNAP_STEP_MS
  }

  function setPlayheadByMs(ms, { snap = false } = {}) {
    const clamped = clampNumber(Number(ms) || 0, 0, Math.max(0, totalDuration))
    setPlayheadPos(snap ? snapMs(clamped) : clamped)
  }

  function applyTimelineSample(sample, { sendHardware = false } = {}) {
    if (!sample) return

    setPlayheadByMs(sample.timelineTimeMs)

    if (sample.fromKeyframeIndex >= 0) {
      setSelectedFrameIndex(sample.fromKeyframeIndex)
    }

    onTimelineSample?.(sample)

    const hold = sample.holdKeyframe || sample.fromKeyframe
    if (hold?.positions) {
      const pose = createPoseFromServos(normalizedConfigs, hold.positions)
      setDraftPose(pose)
      onCurrentPoseChange?.(pose)
    }

    if (!sendHardware || !hardwarePreviewArmed || isPlaying) {
      return
    }

    scrubHwGateRef.current.offer(sample)
    const due = scrubHwGateRef.current.takeIfDue()
    if (!due) {
      return
    }

    const transient = buildTransientKeyframeFromSample(due, {
      moveTimeMs: EXPRESSION_HARDWARE_SAMPLE_INTERVAL_MS,
    })
    void dispatchKeyframeToHardware({
      keyframe: transient,
      configs: normalizedConfigs,
      onCommandPreview: (preview) => setLastCommand(preview),
    }).catch((error) => {
      setStatusText(`Scrub 下发失败：${error.message}`)
    })
  }

  function scrubToTimeMs(ms, { snap = false, sendHardware = true } = {}) {
    const clamped = clampNumber(Number(ms) || 0, 0, Math.max(0, totalDuration))
    const target = snap ? snapMs(clamped) : clamped
    const sample = sampleExpressionTimeline(keyframes, target)
    applyTimelineSample(sample, { sendHardware: sendHardware && !isPlaying })
  }

  function handleTimelineStripClick(event) {
    if (event.target.closest(".frame-block-pro")) {
      return
    }
    if (isPlaying && !isPaused) {
      return
    }
    const timeline = timelineScrollRef.current
    if (!timeline) {
      return
    }
    const rect = timeline.getBoundingClientRect()
    const x = event.clientX - rect.left + timeline.scrollLeft
    const ms = x / pixelsPerMs
    scrubToTimeMs(ms, { snap: false, sendHardware: true })
  }

  function getTimelineInnerWidthPx() {
    return Math.max(600, totalDuration * pixelsPerMs + 200)
  }

  function clampZoom(value) {
    const number = Number(value)

    if (Number.isNaN(number)) {
      return DEFAULT_PIXELS_PER_MS
    }

    return Math.max(MIN_PIXELS_PER_MS, Math.min(MAX_PIXELS_PER_MS, number))
  }

  /**
   * 同步时间轴和刻度尺横向位置。
   * 注意：只允许 timeline-track-pro 主导滚动，ruler 只是跟随。
   */
  function syncTimelineScrollLeft(left) {
    const timeline = timelineScrollRef.current
    const ruler = rulerScrollRef.current

    isSyncingScrollRef.current = true

    if (timeline) {
      timeline.scrollLeft = left
    }

    if (ruler) {
      ruler.scrollLeft = left
    }

    window.requestAnimationFrame(() => {
      isSyncingScrollRef.current = false
    })
  }

  /**
   * 时间轴缩放锚点：红色播放头。
   *
   * 核心公式：
   * 当前红线屏幕位置 = playheadPos * pixelsPerMs - scrollLeft
   * 缩放后 scrollLeft = playheadPos * nextZoom - 当前红线屏幕位置
   */
  function setZoomKeepingPlayhead(nextValue) {
    const nextZoom = clampZoom(nextValue)
    const timeline = timelineScrollRef.current

    if (!timeline) {
      setPixelsPerMs(nextZoom)
      return
    }

    const rawPlayheadViewportX = playheadPos * pixelsPerMs - timeline.scrollLeft

    /**
     * 如果红线当前可见，则保持红线当前位置。
     * 如果红线当前不可见，则缩放后把红线带回视图中心。
     */
    const playheadViewportX =
      rawPlayheadViewportX >= 0 && rawPlayheadViewportX <= timeline.clientWidth
        ? rawPlayheadViewportX
        : timeline.clientWidth / 2

    const nextScrollLeft = Math.max(0, playheadPos * nextZoom - playheadViewportX)

    pendingScrollLeftRef.current = nextScrollLeft
    setPixelsPerMs(nextZoom)
  }

  function handleTimelineWheel(event) {
    event.preventDefault()

    /**
     * 滚轮向上：deltaY < 0，放大
     * 滚轮向下：deltaY > 0，缩小
     */
    const zoomFactor = Math.exp(-event.deltaY * 0.0015)
    const nextZoom = pixelsPerMs * zoomFactor

    setZoomKeepingPlayhead(nextZoom)
  }

  function handleZoomReset() {
    setZoomKeepingPlayhead(DEFAULT_PIXELS_PER_MS)
  }

  function handleZoomFit() {
    const timeline = timelineScrollRef.current

    if (!timeline || totalDuration <= 0) {
      return
    }

    const availableWidth = Math.max(240, timeline.clientWidth - 80)
    const nextZoom = availableWidth / totalDuration

    /**
     * 适配模式的目标是看完整动作，所以这里不以红线锚定，
     * 而是直接从 0ms 开始显示完整时间轴。
     */
    pendingScrollLeftRef.current = 0
    setPixelsPerMs(clampZoom(nextZoom))
  }

  function updateDraftPoseAndCurrentFrame(nextPose, options = {}) {
    const normalizedPose = createPoseFromServos(normalizedConfigs, nextPose)

    setDraftPose(normalizedPose)
    onCurrentPoseChange?.(normalizedPose)

    if (selectedKeyframe) {
      const nextProject = updateKeyframe(
        normalized,
        selectedKeyframe.keyframeId,
        {
          positions: normalizedPose,
        },
        normalizedConfigs
      )

      emitProjectChange(nextProject)
    }

    if (options.statusText) {
      setStatusText(options.statusText)
    }
  }

  async function sendSingleServo(servoId, logicalPwm, quiet = false) {
    try {
      if (!isSharedBusWireConnected()) {
        if (!quiet) {
          setStatusText(`${getActiveBusTransportLabel()} 串口未连接，未发送。`)
        }
        return false
      }

      const config = getServoConfig(normalizedConfigs, servoId)

      if (config.enabled === false) {
        if (!quiet) setStatusText(`舵机 ${servoId} 已禁用。`)
        return false
      }

      const result = logicalToActualPwm(logicalPwm, config)
      const sendRes = await sendLegacyLogicalPwmViaBus(servoId, result.inputLogicalPwm, {
        timeMs: selectedKeyframe?.durationMs || durationMs,
        openIfNeeded: false,
      })

      setLastCommand(
        sendRes.ok
          ? `[Bus] legacy#${servoId} → bus#${sendRes.busServoId} logical=${sendRes.busLogical} pos=${sendRes.targetPosition}`
          : sendRes.error
      )

      if (!sendRes.ok) {
        if (!quiet) setStatusText(`发送失败：${sendRes.error}`)
        return false
      }

      if (!quiet) {
        setStatusText(`舵机 ${servoId}：${result.inputLogicalPwm} → bus ${sendRes.targetPosition}`)
      }

      return true
    } catch (error) {
      if (!quiet) setStatusText(`发送失败：${error.message}`)
      return false
    }
  }

  function requestRealtimeSend(servoId, logicalPwm) {
    realtimePendingRef.current = {
      servoId,
      logicalPwm,
    }

    if (realtimeTimerRef.current) {
      return
    }

    realtimeTimerRef.current = window.setTimeout(flushRealtimeSend, REALTIME_SEND_INTERVAL_MS)
  }

  async function flushRealtimeSend() {
    realtimeTimerRef.current = null

    if (realtimeBusyRef.current) {
      if (realtimePendingRef.current) {
        requestRealtimeSend(realtimePendingRef.current.servoId, realtimePendingRef.current.logicalPwm)
      }

      return
    }

    const pending = realtimePendingRef.current
    realtimePendingRef.current = null

    if (!pending) {
      return
    }

    realtimeBusyRef.current = true
    await sendSingleServo(pending.servoId, pending.logicalPwm, true)
    realtimeBusyRef.current = false

    if (realtimePendingRef.current) {
      requestRealtimeSend(realtimePendingRef.current.servoId, realtimePendingRef.current.logicalPwm)
    }
  }

  function updateServoValue(servoId, value, options = {}) {
    const key = String(servoId)
    const nextValue = clampNumber(
      toInt(value, STANDARD_CENTER_PWM),
      SERVO_LOGICAL_MIN_PWM,
      SERVO_LOGICAL_MAX_PWM
    )

    const nextPose = {
      ...draftPose,
      [key]: nextValue,
    }

    updateDraftPoseAndCurrentFrame(nextPose)

    if (options.realtime !== false) {
      requestRealtimeSend(servoId, nextValue)
    }
  }

  function handleNewExpression() {
    const nextProject = createDefaultFrameProject(normalizedConfigs)
    emitProjectChange(nextProject)
    setSelectedFrameIndex(0)
    setStatusText("已新建表情动作。")
  }

  function handleExpressionNameChange(value) {
    const nextProject = updateExpressionName(normalized, value, normalizedConfigs)
    emitProjectChange(nextProject)
  }

  function handleAddKeyframe() {
    if (isPlaying) return
    const nextFrame = createKeyframe({
      name: `关键帧 ${keyframes.length + 1}`,
      durationMs,
      positions: draftPose,
      configs: normalizedConfigs,
    })

    const nextProject = addKeyframe(normalized, nextFrame, normalizedConfigs)
    emitProjectChange(nextProject)
    setSelectedFrameIndex(nextProject.keyframes.length - 1)
    setStatusText("已新增关键帧。")
  }

  function handleCopyKeyframe() {
    if (isPlaying || !selectedKeyframe) return

    const nextProject = copyKeyframe(normalized, selectedKeyframe.keyframeId, normalizedConfigs)
    emitProjectChange(nextProject)
    setSelectedFrameIndex(Math.min(selectedFrameIndex + 1, nextProject.keyframes.length - 1))
    setStatusText("已复制关键帧。")
  }

  function handleDeleteKeyframe() {
    if (isPlaying || !selectedKeyframe) return

    const nextProject = deleteKeyframe(normalized, selectedKeyframe.keyframeId, normalizedConfigs)
    emitProjectChange(nextProject)
    setSelectedFrameIndex(Math.max(0, selectedFrameIndex - 1))
    setStatusText("已删除关键帧。")
  }

  function handleInsertKeyframe(offset) {
    if (isPlaying) return
    const targetIndex = selectedFrameIndex < 0 ? keyframes.length : selectedFrameIndex + offset

    const newFrame = createKeyframe({
      name: `插入帧 ${targetIndex + 1}`,
      durationMs,
      positions: draftPose,
      configs: normalizedConfigs,
    })

    const nextProject = insertKeyframe(normalized, targetIndex, newFrame, normalizedConfigs)
    emitProjectChange(nextProject)
    setSelectedFrameIndex(targetIndex)
    setStatusText("已插入关键帧。")
  }

  function handleMoveKeyframe(delta) {
    if (isPlaying || selectedFrameIndex < 0) return

    const nextIndex = selectedFrameIndex + delta
    const nextProject = moveKeyframe(normalized, selectedFrameIndex, nextIndex, normalizedConfigs)

    emitProjectChange(nextProject)
    setSelectedFrameIndex(nextIndex)
  }

  function updateSelectedKeyframeMeta(patch) {
    if (isPlaying || !selectedKeyframe) return

    const nextProject = updateKeyframe(
      normalized,
      selectedKeyframe.keyframeId,
      patch,
      normalizedConfigs
    )

    emitProjectChange(nextProject)
  }

  async function handleApplySelectedKeyframe() {
    if (!selectedKeyframe) return

    try {
      await playKeyframe({
        keyframe: selectedKeyframe,
        configs: normalizedConfigs,
        ...keyframePlaybackOptions(undefined),
      })

      const pose = createPoseFromServos(normalizedConfigs, selectedKeyframe.positions)
      setDraftPose(pose)
      onCurrentPoseChange?.(pose)
      setStatusText("已应用当前关键帧到舵机。")
    } catch (error) {
      setStatusText(`应用失败：${error.message}`)
    }
  }

  function handleUpdateSelectedFromCurrentPose() {
    if (!selectedKeyframe) return

    const nextProject = updateKeyframe(
      normalized,
      selectedKeyframe.keyframeId,
      {
        positions: draftPose,
      },
      normalizedConfigs
    )

    emitProjectChange(nextProject)
    setStatusText("已用当前姿态更新此关键帧。")
  }

  function abortPlayback() {
    if (playAbortRef.current) {
      playAbortRef.current.abort()
      playAbortRef.current = null
    }
    playControlRef.current = null
    setIsPlaying(false)
    setIsPaused(false)
  }

  function createPlaybackController() {
    abortPlayback()

    const controller = new AbortController()

    playAbortRef.current = controller
    setIsPlaying(true)
    setIsPaused(false)

    return controller
  }

  useEffect(() => {
    onPlayingChange?.({
      isPlaying,
      isPaused,
      blocksManualRealtime: isPlaying && !isPaused,
    })
  }, [isPlaying, isPaused, onPlayingChange])

  useEffect(() => {
    if (isPlaying) {
      acquirePhysicalMotionOwner(PHYSICAL_MOTION_OWNERS.TIMELINE_PLAYBACK)
    } else {
      releasePhysicalMotionOwner(PHYSICAL_MOTION_OWNERS.TIMELINE_PLAYBACK)
    }
    return () => releasePhysicalMotionOwner(PHYSICAL_MOTION_OWNERS.TIMELINE_PLAYBACK)
  }, [isPlaying])

  async function handlePlay(mode = "all") {
    if (!keyframes.length) {
      return
    }

    if (mode === "current" && !selectedKeyframe) {
      setStatusText("未选择关键帧。")
      return
    }

    if (mode === "range" && !selectedRange) {
      setStatusText("未选择播放区间。")
      return
    }

    const controller = createPlaybackController()

    let startIndex = 0
    let endIndex = keyframes.length - 1

    if (mode === "current") {
      startIndex = selectedFrameIndex
      endIndex = selectedFrameIndex
    }

    if (mode === "range" && selectedRange) {
      startIndex = Math.min(selectedRange.start, selectedRange.end)
      endIndex = Math.max(selectedRange.start, selectedRange.end)
    }

    try {
      /**
       * 单帧播放：只发送当前帧一次，不进入时间轴连续播放。
       */
      if (mode === "current") {
        const frame = keyframes[startIndex]

        setSelectedFrameIndex(startIndex)
        setPlayheadByMs(expressionTimeline.keyframes[startIndex]?.timeMs ?? 0)

        const pose = createPoseFromServos(normalizedConfigs, frame.positions)
        setDraftPose(pose)
        onCurrentPoseChange?.(pose)

        const played = await playKeyframe({
          keyframe: frame,
          configs: normalizedConfigs,
          ...keyframePlaybackOptions(controller.signal),
        })

        if (!played && !controller.signal.aborted) {
          reportPlaybackStatus("单帧播放失败：无可下发命令。")
          return
        }

        if (!controller.signal.aborted) {
          reportPlaybackStatus(`已发送单帧：${frame.name}`)
        }

        return
      }

      /**
       * 全部 / 区间：绝对时间轴连续采样 + 受控硬件 cadence。
       */
      await playKeyframes({
        keyframes,
        configs: normalizedConfigs,
        startIndex,
        endIndex,
        loop: isLoop,
        hardwareIntervalMs: EXPRESSION_HARDWARE_SAMPLE_INTERVAL_MS,
        controlRef: playControlRef,
        ...keyframePlaybackOptions(controller.signal),
        onSample: (sample) => {
          if (controller.signal.aborted) return
          setPlayheadByMs(sample.timelineTimeMs)
          if (sample.fromKeyframeIndex >= 0) {
            setSelectedFrameIndex(sample.fromKeyframeIndex)
          }
          onTimelineSample?.(sample)
          const hold = sample.holdKeyframe || sample.fromKeyframe
          if (hold?.positions && sample.legacyFallback) {
            const pose = createPoseFromServos(normalizedConfigs, hold.positions)
            setDraftPose(pose)
            onCurrentPoseChange?.(pose)
          }
        },
        onKeyframeStart: (frame, index) => {
          setSelectedFrameIndex(index)
          if (frame?.positions) {
            const pose = createPoseFromServos(normalizedConfigs, frame.positions)
            setDraftPose(pose)
            onCurrentPoseChange?.(pose)
          }
        },
      })

      if (!controller.signal.aborted) {
        reportPlaybackStatus(mode === "range" ? "区间播放完成。" : "全部播放完成。")
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        reportPlaybackStatus(`播放失败：${error.message}`)
      }
    } finally {
      if (playAbortRef.current === controller) {
        playAbortRef.current = null
        playControlRef.current = null
        setIsPlaying(false)
        setIsPaused(false)
      }
    }
  }

  function stopPlayback() {
    abortPlayback()
    setStatusText("播放已停止。")
  }

  function pausePlayback() {
    if (!isPlaying || isPaused) return
    playControlRef.current?.pause?.()
    setIsPaused(true)
    setStatusText("播放已暂停。")
  }

  function resumePlayback() {
    if (!isPlaying || !isPaused) return
    playControlRef.current?.resume?.()
    setIsPaused(false)
    setStatusText("继续播放。")
  }

  async function handleStopAll() {
    abortPlayback()

    try {
      if (!isSharedBusWireConnected()) {
        setStatusText(`${getActiveBusTransportLabel()} 串口未连接，无法回中停止。`)
        return
      }

      const res = await sendAllBusProfilesToCenter({ timeMs: 200 })
      setLastCommand(res.ok ? `[Bus] center ${res.sent} profiles` : res.error)
      if (!res.ok) {
        setStatusText(`停止失败：${res.error}`)
        return
      }
      setStatusText(`播放已停止，并已回中 ${res.sent} 路总线舵机。`)
    } catch (error) {
      setStatusText(`停止失败：${error.message}`)
    }
  }

  useEffect(() => {
    if (!playbackExposeRef) {
      return
    }
    playbackExposeRef.current = {
      playAll: () => handlePlay("all"),
      playCurrent: () => handlePlay("current"),
      playRange: () => handlePlay("range"),
      stop: () => stopPlayback(),
      pause: () => pausePlayback(),
      resume: () => resumePlayback(),
      stopAllServos: () => handleStopAll(),
      toggleLoop: () => setIsLoop((p) => !p),
      zoomPercent,
      zoomReset: handleZoomReset,
      zoomFit: handleZoomFit,
      totalDuration,
      playheadPos,
      pixelsPerMs,
      isPlaying,
      isPaused,
      isLoop,
      selectedRange,
      keyframeCount: keyframes.length,
      hasSelectedKeyframe: Boolean(selectedKeyframe),
    }
    bumpPlaybackExpose()
    // playback API 需在 handlePlay/isPlaying 等变化时刷新；不因闭包逐项列举 handlePlay（体量过大）。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 覆盖播放条所需 UI 快照
  }, [
    playbackExposeRef,
    bumpPlaybackExpose,
    keyframes,
    selectedFrameIndex,
    selectedKeyframe,
    isPlaying,
    isPaused,
    isLoop,
    selectedRange,
    zoomPercent,
    totalDuration,
    playheadPos,
    pixelsPerMs,
  ])

  function handleSaveProject() {
    const payload = saveFrameProject(normalized, normalizedConfigs)
    emitProjectChange(payload)
    setStatusText("表情动作已保存到浏览器本地。")
  }

  function handleLoadProject() {
    const loaded = loadFrameProject(normalizedConfigs)
    emitProjectChange(loaded)
    setSelectedFrameIndex(0)
    setStatusText("已从浏览器本地加载表情动作。")
  }

  function handleExportProject() {
    const payload = buildFrameProjectExport(normalized, servoConfigSnapshot, normalizedConfigs)
    const filename = buildSingleExpressionExportFilename(normalized.expressionName, normalized.expressionId)

    exportJsonFile(filename, payload)
    setStatusText(`工程已导出：${filename}`)
  }

  function handleImportClick() {
    fileInputRef.current?.click()
  }

  function handleImportFile(event) {
    const file = event.target.files?.[0]

    if (!file) return

    const reader = new FileReader()

    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result || "{}"))
        const imported = normalizeFrameProject(data, normalizedConfigs)

        emitProjectChange(imported)
        setSelectedFrameIndex(0)
        setStatusText(`已导入：${file.name}`)
      } catch (error) {
        setStatusText(`导入失败：${error.message}`)
      } finally {
        event.target.value = ""
      }
    }

    reader.readAsText(file)
  }

  function onDragStart(event, keyframeId) {
    event.dataTransfer.effectAllowed = "move"
    event.dataTransfer.setData("keyframeId", String(keyframeId))
  }

  function onDrop(event, targetKeyframeId) {
    if (isPlaying) return
    const draggedId = String(event.dataTransfer.getData("keyframeId") || "")
    if (!draggedId) return

    const fromIndex = keyframes.findIndex((frame) => frame.keyframeId === draggedId)
    const targetIndexRaw = keyframes.findIndex((frame) => frame.keyframeId === String(targetKeyframeId))
    if (fromIndex < 0 || targetIndexRaw < 0 || fromIndex === targetIndexRaw) return

    // 目标元素左/右半区决定插入前/后（更符合时间轴直觉）
    const rect = event.currentTarget.getBoundingClientRect()
    const dropAfter = event.clientX - rect.left > rect.width / 2
    let toIndex = targetIndexRaw + (dropAfter ? 1 : 0)

    // 删除自身后，插入位置需要回退一格，避免“越拖越偏”
    if (fromIndex < toIndex) {
      toIndex -= 1
    }

    toIndex = clampNumber(toInt(toIndex, targetIndexRaw), 0, Math.max(0, keyframes.length - 1))
    if (toIndex === fromIndex) return

    const nextProject = moveKeyframe(normalized, fromIndex, toIndex, normalizedConfigs)
    emitProjectChange(nextProject)
    setSelectedRange(null)
    setSelectedFrameIndex(toIndex)
    setPlayheadByMs(getFrameOffset(toIndex) / pixelsPerMs)
  }

  useEffect(() => {
    if (pendingScrollLeftRef.current === null) {
      return
    }

    const nextScrollLeft = pendingScrollLeftRef.current
    pendingScrollLeftRef.current = null

    window.requestAnimationFrame(() => {
      syncTimelineScrollLeft(nextScrollLeft)
    })
  }, [pixelsPerMs])

  function handleTimelineScroll(event) {
    if (isSyncingScrollRef.current) {
      return
    }

    const left = event.currentTarget.scrollLeft
    const ruler = rulerScrollRef.current

    if (ruler && ruler.scrollLeft !== left) {
      ruler.scrollLeft = left
    }
  }

  function handleRulerClick(event) {
    if (isPlaying && !isPaused) {
      return
    }
    const ruler = rulerScrollRef.current
    const timeline = timelineScrollRef.current

    if (!ruler) return

    const rect = ruler.getBoundingClientRect()
    const scrollLeft = timeline?.scrollLeft || ruler.scrollLeft || 0
    const x = event.clientX - rect.left + scrollLeft
    const ms = x / pixelsPerMs
    scrubToTimeMs(ms, { snap: false, sendHardware: true })
  }

  return (
    <section
      ref={editorRef}
      className={`frame-editor-panel pro-frame-editor${timelineOnly ? " frame-editor-timeline-only" : ""}`}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: "none" }}
        onChange={handleImportFile}
      />

      {!timelineOnly ? (
      <div
        className="editor-top-layer"
        style={{
          gridTemplateColumns: `var(--expression-rail-width, 240px) minmax(0, 1fr) 6px ${sidebarWidth}px var(--status-rail-width, 200px)`,
        }}
      >
        <aside className="editor-sidebar-left">
          <div className="frame-editor-serial-wrap">
            <SerialCapsulePanel />
          </div>
          <div className="panel-section panel-section-expression">
            <h3>单个表情动作</h3>

            <div className="form-row">
              <label>名称</label>
              <input
                value={normalized.expressionName}
                onChange={(event) => handleExpressionNameChange(event.target.value)}
              />
            </div>

            <div className="summary-grid">
              <div>关键帧：{keyframes.length}</div>
              <div>总时长：{totalDuration} 毫秒</div>
              <div>舵机数：{normalizedConfigs.filter((servo) => servo.enabled !== false).length}</div>
            </div>

            <div className="button-row button-row-expression">
              <button type="button" className="btn-secondary-full" onClick={handleNewExpression}>
                新建
              </button>

              <button type="button" className="btn-secondary-full" onClick={handleSaveProject}>
                保存
              </button>

              <button type="button" className="btn-secondary-full" onClick={handleLoadProject}>
                加载
              </button>

              <button type="button" className="btn-secondary-full" onClick={handleImportClick}>
                导入
              </button>

              <button type="button" className="btn-secondary-full" onClick={handleExportProject}>
                导出
              </button>
            </div>
          </div>
        </aside>

        <div className="servo-grid-viewport">
          <div className="servo-grid-container pro-density">
            {normalizedConfigs.map((servo) => {
              const key = String(servo.servoId)
              const currentValue = clampNumber(
                toInt(draftPose[key], STANDARD_CENTER_PWM),
                SERVO_LOGICAL_MIN_PWM,
                SERVO_LOGICAL_MAX_PWM
              )

              const config = getServoConfig(normalizedConfigs, servo.servoId)
              const actualResult = logicalToActualPwm(currentValue, config)

              return (
                <div
                  key={servo.servoId}
                  className="servo-mini-card"
                  data-enabled={servo.enabled !== false}
                  data-active={selectedKeyframe?.positions?.[key] !== undefined}
                >
                  <div className="card-header-row">
                    <span className="servo-id-tag">
                      {String(servo.servoId).padStart(2, "0")} 号
                    </span>

                    <input
                      type="number"
                      className="digital-input-pro"
                      value={currentValue}
                      onChange={(event) =>
                        updateServoValue(servo.servoId, event.target.value, {
                          realtime: false,
                        })
                      }
                      onBlur={() => sendSingleServo(servo.servoId, currentValue)}
                    />
                  </div>

                  <div className="slider-row">
                    <input
                      type="range"
                      className="huge-slider-pro"
                      min={SERVO_LOGICAL_MIN_PWM}
                      max={SERVO_LOGICAL_MAX_PWM}
                      value={currentValue}
                      onChange={(event) =>
                        updateServoValue(servo.servoId, event.target.value, {
                          realtime: true,
                        })
                      }
                    />
                  </div>

                  <div className="servo-actual-row">
                    <span>实际 {actualResult.actualPwm}</span>
                    <span>{servoGroupLabel(config.groupId)}</span>
                    <span>{config.direction === -1 ? "反向" : "正向"}</span>
                  </div>

                  <div className="card-footer-row">
                    <button
                      type="button"
                      className="btn-home-tiny"
                      title="回标准零位"
                      onClick={() => updateServoValue(servo.servoId, STANDARD_CENTER_PWM)}
                    >
                      ⌂
                    </button>

                    <span className="servo-name-tiny">{servo.name || `舵机 ${servo.servoId}`}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <div
          className={`sidebar-resizer ${isSidebarResizing ? "active" : ""}`}
          onMouseDown={() => setIsSidebarResizing(true)}
        />

        <aside className="editor-sidebar-pro">
          <div className="panel-section">
            <h3>关键帧操作</h3>

            <div className="form-row">
              <label>默认时长</label>
              <input
                type="number"
                min="20"
                value={defaultDurationDraft !== null ? defaultDurationDraft : String(durationMs)}
                onFocus={() => setDefaultDurationDraft(String(durationMs))}
                onChange={(event) => setDefaultDurationDraft(event.target.value)}
                onBlur={() => {
                  if (defaultDurationDraft === null) return
                  const raw = defaultDurationDraft.trim()
                  setDefaultDurationDraft(null)
                  if (raw === "") {
                    return
                  }
                  const n = Number.parseInt(raw, 10)
                  if (Number.isNaN(n)) {
                    return
                  }
                  setDurationMs(Math.max(20, n))
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.currentTarget.blur()
                  }
                }}
              />
            </div>

            <div className="button-row">
              <button type="button" className="btn-secondary-full" onClick={handleAddKeyframe}>
                新增关键帧
              </button>

              <button type="button" className="btn-secondary-full" onClick={handleCopyKeyframe} disabled={!selectedKeyframe}>
                复制当前帧
              </button>

              <button type="button" className="btn-ghost" onClick={() => handleInsertKeyframe(0)}>
                插入前
              </button>

              <button type="button" className="btn-ghost" onClick={() => handleInsertKeyframe(1)}>
                插入后
              </button>
            </div>
          </div>

          {selectedKeyframe ? (
            <div className="panel-section frame-props">
              <h3>当前关键帧 #{selectedFrameIndex + 1}</h3>

              <div className="form-row">
                <label>名称</label>
                <input
                  value={selectedKeyframe.name}
                  disabled={isPlaying}
                  onChange={(event) =>
                    updateSelectedKeyframeMeta({
                      name: event.target.value,
                    })
                  }
                />
              </div>

              <div className="form-row">
                <label>时长</label>
                <input
                  type="number"
                  min="20"
                  disabled={isPlaying}
                  value={
                    keyframeDurationDraft !== null
                      ? keyframeDurationDraft
                      : String(selectedKeyframe.durationMs)
                  }
                  onFocus={() => setKeyframeDurationDraft(String(selectedKeyframe.durationMs))}
                  onChange={(event) => setKeyframeDurationDraft(event.target.value)}
                  onBlur={() => {
                    if (isPlaying || keyframeDurationDraft === null) return
                    const raw = keyframeDurationDraft.trim()
                    setKeyframeDurationDraft(null)
                    if (raw === "") {
                      return
                    }
                    const n = Number.parseInt(raw, 10)
                    if (Number.isNaN(n)) {
                      return
                    }
                    updateSelectedKeyframeMeta({
                      durationMs: Math.max(20, n),
                    })
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.currentTarget.blur()
                    }
                  }}
                />
              </div>

              <div className="form-row">
                <label>缓动</label>
                <input
                  value={EASING_LABEL_ZH[selectedKeyframe.easing] ?? selectedKeyframe.easing ?? "线性"}
                  disabled
                />
              </div>

              <div className="summary-grid">
                <div>记录舵机：{Object.keys(selectedKeyframe.positions || {}).length}</div>
              </div>

              <div className="button-row">
                <button type="button" className="btn-secondary-full" onClick={handleApplySelectedKeyframe}>
                  应用到舵机
                </button>

                <button type="button" className="btn-secondary-full" onClick={handleUpdateSelectedFromCurrentPose}>
                  用当前姿态更新
                </button>

                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => handleMoveKeyframe(-1)}
                  disabled={selectedFrameIndex <= 0}
                >
                  上移
                </button>

                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => handleMoveKeyframe(1)}
                  disabled={selectedFrameIndex >= keyframes.length - 1}
                >
                  下移
                </button>

                <button type="button" className="danger" onClick={handleDeleteKeyframe}>
                  删除
                </button>
              </div>
            </div>
          ) : (
            <p className="hint">请选择一个关键帧。</p>
          )}
        </aside>

        <aside className="editor-sidebar-status" aria-label="状态与命令">
          <div className="panel-section panel-section-status">
            <h3>状态</h3>
            <p className="hint status-hint">{statusText || "调节舵机时会同步修改当前选中关键帧。"}</p>
            {lastCommand && (
              <p className="command-mini status-command" title={lastCommand}>
                命令：{lastCommand}
              </p>
            )}
          </div>
        </aside>
      </div>
      ) : null}

      <div
        className={`timeline-resizer ${isResizing ? "active" : ""}`}
        onMouseDown={() => setIsResizing(true)}
      />

      <div className="timeline-dock" style={{ height: `${timelineHeight}px` }}>
        <div className="transport-bar-pro">
          {!externalPlaybackBar ? (
            <>
          <button
            type="button"
            className="btn-t"
            onClick={() => handlePlay("all")}
            disabled={isPlaying || keyframes.length === 0}
            title="从第一帧开始播放全部关键帧"
          >
            ▶ 全部
          </button>

          <button
            type="button"
            className="btn-t"
            onClick={() => handlePlay("current")}
            disabled={isPlaying || !selectedKeyframe}
            title="只发送当前选中关键帧一次"
          >
            单帧
          </button>

          <button
            type="button"
            className="btn-t"
            onClick={() => handlePlay("range")}
            disabled={isPlaying || !selectedRange}
            title="播放 Shift 选择的关键帧区间"
          >
            区间
          </button>

          {isPaused ? (
            <button
              type="button"
              className="btn-t"
              onClick={resumePlayback}
              disabled={!isPlaying}
              title="从暂停时刻继续"
            >
              ▶ 继续
            </button>
          ) : (
            <button
              type="button"
              className="btn-t"
              onClick={pausePlayback}
              disabled={!isPlaying}
              title="暂停：冻结当前 timeline 时间"
            >
              ⏸ 暂停
            </button>
          )}

          <button
            type="button"
            className="btn-t"
            onClick={stopPlayback}
            disabled={!isPlaying}
            title="停止当前播放流程，不发送舵机停止命令"
          >
            ⏹ 停止
          </button>

          <button
            type="button"
            className="btn-t danger-text"
            onClick={handleStopAll}
            title="停止播放流程，并发送停止全部舵机命令"
          >
            停止全部舵机
          </button>

          <button
            type="button"
            className={`btn-t ${isLoop ? "active" : ""}`}
            onClick={() => setIsLoop((prev) => !prev)}
            disabled={isPlaying}
            title="循环播放全部或区间；单帧不受循环影响"
          >
            循环
          </button>
            </>
          ) : null}

          <div className="timeline-zoom-control">
            <span className="zoom-hint">滚轮缩放</span>

            <button type="button" className="btn-t" onClick={handleZoomReset} title="重置缩放">
              原始
            </button>

            <button type="button" className="btn-t" onClick={handleZoomFit} title="适配当前时间轴宽度">
              适配
            </button>

            <span className="zoom-percent">{zoomPercent}％</span>
          </div>

          <div className="divider" />

          <span className="time-display">
            {Math.floor(playheadPos)} / {totalDuration} 毫秒
          </span>

          {timelineOnly && statusText ? (
            <span className="timeline-playback-status hint" title={statusText}>
              {statusText}
            </span>
          ) : null}
        </div>

        <div
          ref={rulerScrollRef}
          className="timeline-ruler-pro"
          onWheel={handleTimelineWheel}
          onClick={handleRulerClick}
          title="点击刻度尺：播放头吸附定位；滚轮：以红线为锚点缩放时间轴"
        >
          <div className="timeline-ruler-inner" style={{ width: `${getTimelineInnerWidthPx()}px` }}>
            {Array.from(
              { length: Math.floor(totalDuration / tickConfig.minorTickMs) + 2 },
              (_, i) => {
                const ms = i * tickConfig.minorTickMs
                const isMajor = ms % tickConfig.majorTickMs === 0
                const left = ms * pixelsPerMs

                return (
                  <div
                    key={`tick_${ms}`}
                    className={`ruler-tick ${isMajor ? "major" : "minor"}`}
                    style={{ left: `${left}px` }}
                  >
                    {isMajor ? <span className="ruler-label">{ms} 毫秒</span> : null}
                  </div>
                )
              }
            )}
          </div>
        </div>

        <div
          ref={timelineScrollRef}
          className="timeline-track-pro"
          onWheel={handleTimelineWheel}
          onScroll={handleTimelineScroll}
        >
          <div
            className="timeline-track-inner"
            style={{ width: `${getTimelineInnerWidthPx()}px` }}
            onClick={handleTimelineStripClick}
            role="presentation"
          >
            <div className="playhead-pro" style={{ left: `${playheadPos * pixelsPerMs}px` }} />

            {keyframes.map((frame, index) => {
              const timeWidth = Math.max(2, frame.durationMs * pixelsPerMs)
              const left = getFrameOffset(index)
              const inRange = selectedRange && index >= selectedRange.start && index <= selectedRange.end
              const isCompact = timeWidth < 48
              const isTiny = timeWidth < 18

              return (
                <div
                  key={frame.keyframeId}
                  draggable={!isPlaying}
                  onDragStart={(event) => onDragStart(event, frame.keyframeId)}
                  onDragOver={(event) => {
                    if (isPlaying) return
                    event.preventDefault()
                  }}
                  onDrop={(event) => onDrop(event, frame.keyframeId)}
                  className={`frame-block-pro ${selectedFrameIndex === index ? "selected" : ""} ${
                    inRange ? "in-range" : ""
                  }`}
                  data-compact={isCompact}
                  data-tiny={isTiny}
                  style={{
                    width: `${timeWidth}px`,
                    left: `${left}px`,
                  }}
                  title={`${index + 1}. ${frame.name} — ${frame.durationMs} 毫秒`}
                  onClick={(event) => {
                    event.stopPropagation()
                    if (event.shiftKey && selectedFrameIndex >= 0) {
                      setSelectedRange({
                        start: Math.min(selectedFrameIndex, index),
                        end: Math.max(selectedFrameIndex, index),
                      })
                      return
                    }

                    setSelectedRange(null)
                    setSelectedFrameIndex(index)
                    setPlayheadByMs(getFrameOffset(index) / pixelsPerMs)
                  }}
                >
                  <div className="frame-block-body">
                    <span className="frame-index">{index + 1}</span>
                    <div className="frame-block-meta">
                      <span className="frame-name-line">{frame.name}</span>
                      <span className="frame-dur-line">{frame.durationMs} ms</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}
