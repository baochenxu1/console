import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { playKeyframes } from "../../core/actionPlayer.js"
import { dispatchKeyframeToHardware } from "../expression/keyframePlaybackDispatch.js"
import { dispatchCharacterHardware } from "../expression/characterHardwareDispatch.js"
import {
  PHYSICAL_MOTION_OWNERS,
  acquirePhysicalMotionOwner,
  releasePhysicalMotionOwner,
} from "../expression/physicalMotionOwner.js"
import {
  sampleExpressionTimeline,
} from "../../core/expressionTimelineSampler.js"
import {
  buildFaceKeySummaries,
  buildGroupKeySummaries,
  listTimelineGroups,
  isFullFaceKeyed,
} from "../../core/expressionTimelineChannels.js"
import {
  addChannelKeyAtTime,
  addFullFaceKeyAtTime,
  copyFullFaceKeyToTime,
  moveChannelKey,
  moveFullFaceKey,
  removeChannelKey,
  setTimelineDurationMs,
} from "../../core/expressionKeyframeOps.js"
import { createPoseFromServos } from "../../core/frameProject.js"
import {
  isExpressionChannelKeyMutationEnabled,
  isExpressionKeyTimeEditable,
  projectHasAdvancedChannelKeys,
  resolveFullFaceSelectionIndex,
} from "../../core/expressionCapabilities.js"

const DEFAULT_PX_PER_MS = 0.35
const LABEL_WIDTH = 156
const ROW_H = 18
const SNAP_PX = 6
const FIT_EDGE_PAD_PX = 8
/** 左右留白：保证 t=0 / 末帧菱形完整可见（含旋转后包围盒与选中描边） */
const TRACK_PAD_X = 14

function snapTimeMs(rawMs, anchors, pxPerMs) {
  const t = Math.max(0, Math.round(Number(rawMs) || 0))
  const thresh = Math.max(1, Math.round(SNAP_PX / Math.max(pxPerMs, 0.05)))
  let best = t
  let bestDist = Infinity
  for (const a of anchors) {
    const d = Math.abs(a - t)
    if (d < bestDist && d <= thresh) {
      bestDist = d
      best = a
    }
  }
  return best
}

/** 标尺 / 网格共用时间步长（ms） */
function pickTimelineGridStepMs(pxPerMs) {
  if (pxPerMs >= 1) return 100
  if (pxPerMs >= 0.4) return 250
  if (pxPerMs >= 0.2) return 500
  if (pxPerMs >= 0.1) return 1000
  return 2000
}

function computeFitPixelsPerMs(clientWidth, durationMs) {
  const usable = Math.max(80, (clientWidth || 600) - FIT_EDGE_PAD_PX - TRACK_PAD_X * 2)
  const dur = Math.max(1, Number(durationMs) || 1)
  return Math.min(4, Math.max(0.04, usable / dur))
}

function timeToX(timeMs, pxPerMs) {
  return TRACK_PAD_X + Math.max(0, Number(timeMs) || 0) * pxPerMs
}

function xToTime(x, pxPerMs, durationMs) {
  const raw = (x - TRACK_PAD_X) / Math.max(pxPerMs, 0.05)
  return Math.max(0, Math.min(durationMs, raw))
}

/**
 * AE 式 Dope Sheet：固定外高，内部纵向滚动；左侧通道名固定，右侧横向滚动。
 */
export default function ExpressionDopeSheetTimeline({
  frameProject,
  configs = [],
  currentRig,
  currentNeck = null,
  writeNeckOnFullKey = true,
  logicalPose,
  selectedFrameIndex = 0,
  onSelectFrameIndex,
  onProjectChange,
  onTimelineSample,
  dispatchNeck = null,
  onPlayingChange,
  structureEditLocked = false,
  externalPlayheadMs = null,
}) {
  const project = frameProject
  const keyframes = project?.keyframes || []
  const timelineDurationMs = Math.max(0, Number(project?.timelineDurationMs) || 0)

  const [pixelsPerMs, setPixelsPerMs] = useState(DEFAULT_PX_PER_MS)
  const [autoFit, setAutoFit] = useState(true)
  const [playheadPos, setPlayheadPos] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [isLoop, setIsLoop] = useState(false)
  const [collapsed, setCollapsed] = useState(() => {
    // 默认只显示部位行，通道折叠
    const init = {}
    for (const g of listTimelineGroups()) {
      if (g.groupId !== "face") init[g.groupId] = true
    }
    return init
  })
  const [selectedKey, setSelectedKey] = useState(null) // { timeMs, channelId|null, kind:'face'|'group'|'channel' }
  const [timeDraft, setTimeDraft] = useState(null)
  const [durationDraft, setDurationDraft] = useState(null)

  const abortRef = useRef(null)
  const controlRef = useRef(null)
  const hScrollRef = useRef(null)
  const rulerScrollRef = useRef(null)
  const bodyScrollRef = useRef(null)
  const labelScrollRef = useRef(null)
  const syncingScroll = useRef(false)
  const autoFitRef = useRef(true)

  useEffect(() => {
    if (isPlaying) {
      acquirePhysicalMotionOwner(PHYSICAL_MOTION_OWNERS.TIMELINE_PLAYBACK)
    } else {
      releasePhysicalMotionOwner(PHYSICAL_MOTION_OWNERS.TIMELINE_PLAYBACK)
    }
    return () => releasePhysicalMotionOwner(PHYSICAL_MOTION_OWNERS.TIMELINE_PLAYBACK)
  }, [isPlaying])

  useEffect(() => {
    autoFitRef.current = autoFit
  }, [autoFit])

  useEffect(() => {
    if (externalPlayheadMs == null || isPlaying) return
    const t = Math.max(0, Math.round(Number(externalPlayheadMs) || 0))
    setPlayheadPos((prev) => (prev === t ? prev : t))
  }, [externalPlayheadMs, isPlaying])

  const groups = useMemo(() => listTimelineGroups(), [])

  const fitTimelineToWidth = useCallback(
    (widthOverride) => {
      const w = widthOverride ?? hScrollRef.current?.clientWidth
      if (!(w > 0) || !(timelineDurationMs > 0)) return
      const next = computeFitPixelsPerMs(w, timelineDurationMs)
      setPixelsPerMs((prev) => (Math.abs(prev - next) < 0.0005 ? prev : next))
    },
    [timelineDurationMs]
  )

  // 分辨率 / 容器变化、时长变化：自动铺满
  useEffect(() => {
    const el = hScrollRef.current
    if (!el) return undefined

    const apply = () => {
      if (!autoFitRef.current) return
      fitTimelineToWidth(el.clientWidth)
    }

    apply()
    const ro =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => apply())
        : null
    ro?.observe(el)
    window.addEventListener("resize", apply)
    return () => {
      ro?.disconnect()
      window.removeEventListener("resize", apply)
    }
  }, [fitTimelineToWidth, timelineDurationMs])

  const canvasWidth = Math.max(TRACK_PAD_X * 2 + 1, TRACK_PAD_X * 2 + timelineDurationMs * pixelsPerMs)
  const gridStepMs = pickTimelineGridStepMs(pixelsPerMs)
  const gridPx = Math.max(4, gridStepMs * pixelsPerMs)

  const snapAnchors = useMemo(() => {
    const set = new Set([0, playheadPos, timelineDurationMs])
    for (const kf of keyframes) set.add(Math.round(Number(kf.timeMs) || 0))
    return [...set]
  }, [keyframes, playheadPos, timelineDurationMs])

  const faceSummaries = useMemo(() => buildFaceKeySummaries(keyframes), [keyframes])

  const rows = useMemo(() => {
    const out = []
    for (const g of groups) {
      if (g.groupId === "face") {
        out.push({ type: "face", id: "face", label: g.label, summaries: faceSummaries })
        continue
      }
      const summaries = buildGroupKeySummaries(keyframes, g.channelIds)
      out.push({
        type: "group",
        id: g.groupId,
        label: g.label,
        channelIds: g.channelIds,
        summaries,
        collapsed: Boolean(collapsed[g.groupId]),
      })
      if (!collapsed[g.groupId]) {
        for (const ch of g.channels) {
          const times = keyframes
            .filter((kf) => (kf.keyedChannels || []).includes(ch.channelId))
            .map((kf) => Math.round(Number(kf.timeMs) || 0))
          out.push({
            type: "channel",
            id: ch.channelId,
            label: ch.label,
            groupId: g.groupId,
            times: [...new Set(times)].sort((a, b) => a - b),
          })
        }
      }
    }
    return out
  }, [groups, keyframes, collapsed, faceSummaries])

  const emitSampleAt = useCallback(
    (ms) => {
      const sample = sampleExpressionTimeline(project, ms)
      onTimelineSample?.(sample)
      // Scrub / click seek：勾选「硬件预览」时由 dispatchNeck 门控下发（播放路径另走 actionPlayer）
      if (typeof dispatchNeck === "function") {
        void Promise.resolve(
          dispatchNeck(sample?.characterPose?.neck || null, {
            timelineTimeMs: sample.timelineTimeMs,
            sample,
            fromScrub: true,
          })
        ).catch((err) => {
          console.warn("[dope] neck scrub dispatch failed:", err)
        })
      }
      return sample
    },
    [project, onTimelineSample, dispatchNeck]
  )

  const setPlayheadByMs = useCallback(
    (ms, { sample = true } = {}) => {
      const next = Math.max(0, Math.round(Number(ms) || 0))
      setPlayheadPos(next)
      if (sample && !isPlaying) {
        emitSampleAt(next)
      }
    },
    [isPlaying, emitSampleAt]
  )

  useEffect(() => {
    onPlayingChange?.({ isPlaying, blocksManualRealtime: isPlaying })
  }, [isPlaying, onPlayingChange])

  useEffect(() => {
    return () => {
      abortRef.current?.abort?.()
    }
  }, [])

  const syncHorizontal = useCallback((source) => {
    if (syncingScroll.current) return
    syncingScroll.current = true
    const left = source.scrollLeft
    if (hScrollRef.current && hScrollRef.current !== source) hScrollRef.current.scrollLeft = left
    if (rulerScrollRef.current && rulerScrollRef.current !== source) {
      rulerScrollRef.current.scrollLeft = left
    }
    syncingScroll.current = false
  }, [])

  const syncVertical = useCallback((source) => {
    if (syncingScroll.current) return
    syncingScroll.current = true
    const top = source.scrollTop
    if (bodyScrollRef.current && bodyScrollRef.current !== source) {
      bodyScrollRef.current.scrollTop = top
    }
    if (labelScrollRef.current && labelScrollRef.current !== source) {
      labelScrollRef.current.scrollTop = top
    }
    syncingScroll.current = false
  }, [])

  const handleStop = useCallback(() => {
    abortRef.current?.abort?.()
    abortRef.current = null
    controlRef.current = null
    setIsPlaying(false)
    setIsPaused(false)
  }, [])

  const handlePlayAll = useCallback(async () => {
    if (isPlaying || keyframes.length === 0) return
    handleStop()
    const ac = new AbortController()
    abortRef.current = ac
    setIsPlaying(true)
    setIsPaused(false)
    try {
      await playKeyframes({
        keyframes,
        frameProject: project,
        timelineDurationMs,
        configs,
        startIndex: 0,
        endIndex: null,
        loop: isLoop,
        signal: ac.signal,
        controlRef,
        onSample: (sample) => {
          setPlayheadPos(sample.timelineTimeMs)
          onTimelineSample?.(sample)
        },
        dispatchNeck: async (neck, meta) => {
          if (typeof dispatchNeck === "function") {
            return dispatchNeck(neck, meta)
          }
          return false
        },
        sendKeyframe: async ({ keyframe, configs: cfgs, signal, sample }) => {
          // Character 级隔离：Face 无 profile → SKIPPED，不 throw、不刷屏；Neck 由 actionPlayer 并行路径发送
          const result = await dispatchCharacterHardware({
            keyframe,
            configs: cfgs,
            signal,
            sample,
            timelineTimeMs: sample?.timelineTimeMs,
            // Neck 已在 actionPlayer.dispatchSample 并行调用；此处仅跑 Face，避免双发
            dispatchNeck: null,
            dispatchFaceImpl: dispatchKeyframeToHardware,
          })
          return result
        },
      })
    } finally {
      const aborted = ac.signal.aborted
      setIsPlaying(false)
      setIsPaused(false)
      abortRef.current = null
      // 正常播完：停在最后一帧（不继续跑完 timeline 空段）
      if (!aborted && keyframes.length > 0) {
        const lastT = Math.round(Number(keyframes[keyframes.length - 1].timeMs) || 0)
        setPlayheadPos(lastT)
        onTimelineSample?.(sampleExpressionTimeline(project, lastT))
      }
    }
  }, [
    isPlaying,
    keyframes,
    project,
    timelineDurationMs,
    configs,
    isLoop,
    handleStop,
    onTimelineSample,
    dispatchNeck,
  ])

  const handlePause = useCallback(() => {
    if (!isPlaying || isPaused) return
    controlRef.current?.pause?.()
    setIsPaused(true)
  }, [isPlaying, isPaused])

  const handleResume = useCallback(() => {
    if (!isPlaying || !isPaused) return
    controlRef.current?.resume?.()
    setIsPaused(false)
  }, [isPlaying, isPaused])

  /** 停止态 → 从头播；暂停态 → 继续（播放键始终是 ▶，不与暂停互换） */
  const handlePlayOrResume = useCallback(() => {
    if (isPlaying && isPaused) {
      handleResume()
      return
    }
    void handlePlayAll()
  }, [isPlaying, isPaused, handleResume, handlePlayAll])

  const emitProject = useCallback(
    (next) => {
      onProjectChange?.(next)
    },
    [onProjectChange]
  )

  const handleAddFullFace = useCallback(() => {
    if (structureEditLocked) return
    const next = addFullFaceKeyAtTime(
      project,
      playheadPos,
      currentRig,
      createPoseFromServos(configs, logicalPose),
      configs,
      { neck: writeNeckOnFullKey ? currentNeck : undefined, writeNeck: writeNeckOnFullKey }
    )
    emitProject(next)
    const idx = next.keyframes.findIndex((k) => Math.round(k.timeMs) === Math.round(playheadPos))
    if (idx >= 0) onSelectFrameIndex?.(idx)
  }, [
    structureEditLocked,
    project,
    playheadPos,
    currentRig,
    currentNeck,
    writeNeckOnFullKey,
    logicalPose,
    configs,
    emitProject,
    onSelectFrameIndex,
  ])

  const handleToggleChannelKey = useCallback(
    (channelId) => {
      if (!isExpressionChannelKeyMutationEnabled()) return
      if (structureEditLocked) return
      const t = Math.round(playheadPos)
      const existing = keyframes.find((k) => Math.round(k.timeMs) === t)
      const has = existing?.keyedChannels?.includes(channelId)
      let next
      if (has) {
        next = removeChannelKey(project, t, channelId, configs)
      } else {
        next = addChannelKeyAtTime(
          project,
          t,
          channelId,
          currentRig,
          createPoseFromServos(configs, logicalPose),
          configs
        )
      }
      emitProject(next)
    },
    [
      structureEditLocked,
      playheadPos,
      keyframes,
      project,
      configs,
      currentRig,
      logicalPose,
      emitProject,
    ]
  )

  /** Phase 1.1：子层点击一律选中所属整脸 Event，不进入 Channel selection */
  const selectFullFaceAtTime = useCallback(
    (timeMs) => {
      const t = Math.round(timeMs)
      setSelectedKey({ timeMs: t, channelId: null, kind: "face" })
      setPlayheadByMs(t, { sample: true })
      const fullIdx = resolveFullFaceSelectionIndex(keyframes, t)
      if (fullIdx >= 0) onSelectFrameIndex?.(fullIdx)
    },
    [keyframes, onSelectFrameIndex, setPlayheadByMs]
  )

  const onDiamondPointerDown = useCallback(
    (event, { timeMs, channelId = null, kind }) => {
      event.preventDefault()
      event.stopPropagation()

      // 正式模式：Group / Channel 只定位整脸；Advanced 下 Channel 仍可带 channelId
      if (!isExpressionChannelKeyMutationEnabled() || kind === "face" || kind === "group") {
        selectFullFaceAtTime(timeMs)
      } else {
        selectFullFaceAtTime(timeMs)
        if (channelId) {
          setSelectedKey({ timeMs: Math.round(timeMs), channelId, kind: "channel" })
        }
      }

      if (structureEditLocked || isPlaying) return

      const origin = Math.round(timeMs)
      const evAt = keyframes.find((k) => Math.round(k.timeMs) === origin)
      const canDrag = isExpressionKeyTimeEditable({
        rowKind: kind,
        channelId,
        keyedChannels: evAt?.keyedChannels,
      })
      if (!canDrag) return

      // Alt+拖动：复制；普通拖动：移动
      const copyMode = Boolean(event.altKey)
      const startX = event.clientX
      let latest = origin

      const onMove = (ev) => {
        const dx = ev.clientX - startX
        const raw = origin + dx / pixelsPerMs
        latest = snapTimeMs(raw, snapAnchors.filter((a) => a !== origin), pixelsPerMs)
        latest = Math.max(0, Math.min(timelineDurationMs, latest))
        setPlayheadPos(latest)
      }

      const onUp = (ev) => {
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onUp)
        if (latest === origin) return

        const doCopy = copyMode || Boolean(ev?.altKey)
        let next = null
        if (kind === "face" && !channelId) {
          next = doCopy
            ? copyFullFaceKeyToTime(project, origin, latest, configs)
            : moveFullFaceKey(project, origin, latest, configs)
        } else if (isExpressionChannelKeyMutationEnabled() && channelId) {
          next = moveChannelKey(project, origin, latest, channelId, configs)
        }
        if (next) {
          emitProject(next)
          setSelectedKey({ timeMs: latest, channelId: null, kind: "face" })
          emitSampleAt(latest)
          const idx = resolveFullFaceSelectionIndex(next.keyframes, latest)
          if (idx >= 0) onSelectFrameIndex?.(idx)
        }
      }

      window.addEventListener("pointermove", onMove)
      window.addEventListener("pointerup", onUp)
    },
    [
      selectFullFaceAtTime,
      structureEditLocked,
      isPlaying,
      pixelsPerMs,
      snapAnchors,
      timelineDurationMs,
      keyframes,
      project,
      configs,
      emitProject,
      emitSampleAt,
      onSelectFrameIndex,
    ]
  )

  const applySelectedTime = useCallback(() => {
    if (timeDraft == null || !selectedKey) return
    const n = Number.parseInt(String(timeDraft).trim(), 10)
    setTimeDraft(null)
    if (Number.isNaN(n)) return
    // Phase 1.1：仅整脸 Key 可改精确时间
    if (!isExpressionChannelKeyMutationEnabled() && selectedKey.kind !== "face") return
    const origin = selectedKey.timeMs
    const evAt = keyframes.find((k) => Math.round(k.timeMs) === Math.round(origin))
    if (
      !isExpressionKeyTimeEditable({
        rowKind: "face",
        channelId: null,
        keyedChannels: evAt?.keyedChannels,
      })
    ) {
      return
    }
    const target = Math.max(0, Math.min(timelineDurationMs, n))
    if (target === origin) return
    let next = null
    if (selectedKey.kind === "face" || !selectedKey.channelId) {
      next = moveFullFaceKey(project, origin, target, configs)
    } else if (isExpressionChannelKeyMutationEnabled() && selectedKey.channelId) {
      next = moveChannelKey(project, origin, target, selectedKey.channelId, configs)
    }
    if (next) {
      emitProject(next)
      setSelectedKey({ timeMs: target, channelId: null, kind: "face" })
      setPlayheadByMs(target)
    }
  }, [
    timeDraft,
    selectedKey,
    keyframes,
    timelineDurationMs,
    project,
    configs,
    emitProject,
    setPlayheadByMs,
  ])

  const hasAdvancedChannelKeys = useMemo(
    () => projectHasAdvancedChannelKeys(project),
    [project]
  )
  const channelMutationEnabled = isExpressionChannelKeyMutationEnabled()

  const applyDuration = useCallback(() => {
    if (durationDraft == null || structureEditLocked) return
    const n = Number.parseInt(String(durationDraft).trim(), 10)
    setDurationDraft(null)
    if (Number.isNaN(n)) return
    const next = setTimelineDurationMs(project, Math.max(0, n))
    if (next.timelineDurationMs !== timelineDurationMs) {
      setAutoFit(true)
      emitProject(next)
    }
    if (playheadPos > next.timelineDurationMs) {
      setPlayheadByMs(next.timelineDurationMs)
    }
  }, [
    durationDraft,
    structureEditLocked,
    project,
    timelineDurationMs,
    emitProject,
    playheadPos,
    setPlayheadByMs,
  ])

  const clientXToMs = useCallback(
    (clientX) => {
      const scroll = hScrollRef.current
      if (!scroll) return playheadPos
      const rect = scroll.getBoundingClientRect()
      const x = clientX - rect.left + scroll.scrollLeft
      return snapTimeMs(xToTime(x, pixelsPerMs, timelineDurationMs), snapAnchors, pixelsPerMs)
    },
    [playheadPos, pixelsPerMs, timelineDurationMs, snapAnchors]
  )

  /** 标尺 / 画布 / 红色指针：按下后可拖动 scrub */
  const onScrubPointerDown = useCallback(
    (event) => {
      if (event.button != null && event.button !== 0) return
      if (event.target.closest?.(".expr-dope-key")) return
      if (isPlaying) return

      event.preventDefault()
      event.stopPropagation()
      setPlayheadByMs(clientXToMs(event.clientX))

      const onMove = (ev) => {
        setPlayheadByMs(clientXToMs(ev.clientX))
      }
      const onUp = () => {
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onUp)
        window.removeEventListener("pointercancel", onUp)
      }
      window.addEventListener("pointermove", onMove)
      window.addEventListener("pointerup", onUp)
      window.addEventListener("pointercancel", onUp)
    },
    [isPlaying, clientXToMs, setPlayheadByMs]
  )

  const rulerMarks = useMemo(() => {
    const step = gridStepMs
    const marks = []
    for (let t = 0; t <= timelineDurationMs + 0.001; t += step) {
      marks.push(Math.round(t))
    }
    if (marks[marks.length - 1] !== Math.round(timelineDurationMs)) {
      marks.push(Math.round(timelineDurationMs))
    }
    return marks
  }, [gridStepMs, timelineDurationMs])

  const channelHasKeyAtPlayhead = useCallback(
    (channelId) => {
      const t = Math.round(playheadPos)
      const ev = keyframes.find((k) => Math.round(k.timeMs) === t)
      return Boolean(ev?.keyedChannels?.includes(channelId))
    },
    [keyframes, playheadPos]
  )

  return (
    <div className="expr-dope" aria-label="Expression Dope Sheet">
      {hasAdvancedChannelKeys ? (
        <div className="expr-dope-advanced-hint" role="status">
          工程包含高级属性关键帧；当前版本以只读方式保留。
        </div>
      ) : null}
      <div className="expr-dope-toolbar">
        <button
          type="button"
          className={`btn-t expr-dope-transport ${!isPlaying || isPaused ? "active" : ""}`}
          onClick={handlePlayOrResume}
          disabled={!keyframes.length || (isPlaying && !isPaused)}
          title={isPaused ? "继续" : "播放"}
          aria-label={isPaused ? "继续" : "播放"}
        >
          ▶
        </button>
        <button
          type="button"
          className={`btn-t expr-dope-transport ${isPlaying && !isPaused ? "active" : ""}`}
          onClick={handlePause}
          disabled={!isPlaying || isPaused}
          title="暂停"
          aria-label="暂停"
        >
          ⏸
        </button>
        <button
          type="button"
          className="btn-t expr-dope-transport"
          onClick={handleStop}
          disabled={!isPlaying}
          title="停止"
          aria-label="停止"
        >
          ⏹
        </button>
        <button
          type="button"
          className={`btn-t ${isLoop ? "active" : ""}`}
          onClick={() => setIsLoop((v) => !v)}
          disabled={isPlaying}
        >
          循环
        </button>
        <span className="expr-dope-time" title={`${Math.round(playheadPos)} / ${Math.round(timelineDurationMs)} ms`}>
          {String(Math.round(playheadPos)).padStart(5, "\u2007")} /{" "}
          {String(Math.round(timelineDurationMs)).padStart(5, "\u2007")} ms
        </span>
        <label className="expr-dope-time-edit">
          时长
          <input
            type="number"
            min={0}
            step={100}
            disabled={structureEditLocked || isPlaying}
            value={durationDraft != null ? durationDraft : String(Math.round(timelineDurationMs))}
            onFocus={() => setDurationDraft(String(Math.round(timelineDurationMs)))}
            onChange={(e) => setDurationDraft(e.target.value)}
            onBlur={applyDuration}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur()
            }}
          />
        </label>
        <label className="expr-dope-time-edit">
          时间
          <input
            type="number"
            min={0}
            disabled={
              structureEditLocked ||
              !selectedKey ||
              selectedKey.kind !== "face" ||
              !isExpressionKeyTimeEditable({
                rowKind: "face",
                keyedChannels: keyframes.find(
                  (k) => Math.round(k.timeMs) === Math.round(selectedKey.timeMs)
                )?.keyedChannels,
              })
            }
            value={timeDraft != null ? timeDraft : selectedKey ? String(selectedKey.timeMs) : ""}
            onFocus={() => selectedKey && setTimeDraft(String(selectedKey.timeMs))}
            onChange={(e) => setTimeDraft(e.target.value)}
            onBlur={applySelectedTime}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur()
            }}
          />
        </label>
        <button
          type="button"
          className="btn-t"
          onClick={() => {
            setAutoFit(false)
            setPixelsPerMs((p) => Math.min(4, p * 1.25))
          }}
        >
          +
        </button>
        <button
          type="button"
          className="btn-t"
          onClick={() => {
            setAutoFit(false)
            setPixelsPerMs((p) => Math.max(0.04, p / 1.25))
          }}
        >
          −
        </button>
        <button
          type="button"
          className="btn-t"
          onClick={() => {
            setAutoFit(true)
            fitTimelineToWidth()
          }}
        >
          适应
        </button>
      </div>

      <div className="expr-dope-ruler-row">
        <div className="expr-dope-corner" style={{ width: LABEL_WIDTH }} />
        <div
          className="expr-dope-ruler-scroll"
          ref={rulerScrollRef}
          onScroll={(e) => syncHorizontal(e.currentTarget)}
        >
          <div
            className="expr-dope-ruler"
            style={{ width: canvasWidth }}
            onPointerDown={onScrubPointerDown}
          >
            {rulerMarks.map((ms) => (
              <span key={ms} className="expr-dope-ruler-mark" style={{ left: timeToX(ms, pixelsPerMs) }}>
                {ms >= 1000 ? `${ms / 1000}s` : `${ms}`}
              </span>
            ))}
            <div
              className="expr-dope-playhead expr-dope-playhead--interactive"
              style={{ left: timeToX(playheadPos, pixelsPerMs) }}
              onPointerDown={onScrubPointerDown}
            />
          </div>
        </div>
      </div>

      <div className="expr-dope-body">
        <div
          className="expr-dope-labels"
          style={{ width: LABEL_WIDTH }}
          ref={labelScrollRef}
          onScroll={(e) => syncVertical(e.currentTarget)}
        >
          {rows.map((row) => (
            <div key={`L-${row.type}-${row.id}`} className={`expr-dope-label-row expr-dope-label-row--${row.type}`}>
              {row.type === "group" ? (
                <button
                  type="button"
                  className="expr-dope-collapse"
                  onClick={() => setCollapsed((c) => ({ ...c, [row.id]: !c[row.id] }))}
                  aria-label={row.collapsed ? "展开" : "折叠"}
                >
                  {row.collapsed ? "▶" : "▼"}
                </button>
              ) : (
                <span className="expr-dope-collapse-spacer" />
              )}
              <span className="expr-dope-label-text" title={row.label}>
                {row.type === "face" ? "● 角色" : row.label}
              </span>
              {row.type === "face" ? (
                <button
                  type="button"
                  className="expr-dope-key-toggle"
                  title="在 Playhead 写入 Character Key（Face + Neck）"
                  disabled={structureEditLocked}
                  onClick={handleAddFullFace}
                >
                  ●
                </button>
              ) : null}
              {row.type === "channel" && channelMutationEnabled ? (
                <button
                  type="button"
                  className={`expr-dope-key-toggle ${channelHasKeyAtPlayhead(row.id) ? "is-on" : ""}`}
                  title="通道关键帧"
                  disabled={structureEditLocked}
                  onClick={() => handleToggleChannelKey(row.id)}
                >
                  {channelHasKeyAtPlayhead(row.id) ? "◆" : "◇"}
                </button>
              ) : null}
            </div>
          ))}
        </div>

        <div
          className="expr-dope-canvas-scroll"
          ref={(el) => {
            hScrollRef.current = el
            bodyScrollRef.current = el
          }}
          onScroll={(e) => {
            syncHorizontal(e.currentTarget)
            syncVertical(e.currentTarget)
          }}
          onPointerDown={onScrubPointerDown}
        >
          <div
            className="expr-dope-canvas"
            style={{
              width: canvasWidth,
              height: rows.length * ROW_H,
              backgroundSize: `${gridPx}px 100%`,
              backgroundPosition: `${TRACK_PAD_X}px 0`,
            }}
          >
            {rows.map((row, rowIndex) => {
              const markers =
                row.type === "channel"
                  ? row.times.map((t) => ({ timeMs: t, kind: "solid" }))
                  : row.summaries || []
              const shape = row.type === "face" ? "dot" : "diamond"
              const isChildRow = row.type === "group" || row.type === "channel"
              return (
                <div
                  key={`C-${row.type}-${row.id}`}
                  className={`expr-dope-track expr-dope-track--${row.type}`}
                  style={{ top: rowIndex * ROW_H, height: ROW_H }}
                >
                  {markers.map((d) => {
                    const evAt = keyframes.find((k) => Math.round(k.timeMs) === Math.round(d.timeMs))
                    const timeEditable = isExpressionKeyTimeEditable({
                      rowKind: row.type,
                      channelId: row.type === "channel" ? row.id : null,
                      keyedChannels: evAt?.keyedChannels,
                    })
                    return (
                      <button
                        key={`${row.id}-${d.timeMs}-${d.kind}`}
                        type="button"
                        className={[
                          "expr-dope-key",
                          `expr-dope-key--${shape}`,
                          `expr-dope-key--${d.kind}`,
                          row.type === "face" ? "expr-dope-key--face" : "",
                          row.type === "group" ? "expr-dope-key--group" : "",
                          row.type === "channel" ? "expr-dope-key--channel" : "",
                          isChildRow ? "expr-dope-key--member" : "",
                          !timeEditable ? "expr-dope-key--readonly" : "expr-dope-key--editable",
                          selectedKey?.timeMs === d.timeMs &&
                          selectedKey?.kind === "face" &&
                          (row.type === "face" || isChildRow)
                            ? "is-selected"
                            : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        style={{ left: timeToX(d.timeMs, pixelsPerMs) }}
                        title={
                          row.type === "face"
                            ? `整脸关键帧 @ ${d.timeMs}ms（拖动移动 · Alt+拖动复制）`
                            : `整脸成员视图 · ${row.label} @ ${d.timeMs}ms（只读定位）`
                        }
                        onPointerDown={(ev) =>
                          onDiamondPointerDown(ev, {
                            timeMs: d.timeMs,
                            channelId: row.type === "channel" ? row.id : null,
                            kind: row.type,
                          })
                        }
                      />
                    )
                  })}
                </div>
              )
            })}
            <div
              className="expr-dope-playhead expr-dope-playhead--body expr-dope-playhead--interactive"
              style={{ left: timeToX(playheadPos, pixelsPerMs), height: rows.length * ROW_H }}
              onPointerDown={onScrubPointerDown}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
