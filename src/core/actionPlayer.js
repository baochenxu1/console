/**
 * 表情关键帧播放：绝对时间轴 + Rig 采样下发。
 * 硬件层仍走外部传入的 sendKeyframe → dispatchKeyframeToHardware（协议无关）。
 */

import { getServoConfig, logicalToActualPwm } from "./servoConfig.js"
import { loadFaceRigProfile, normalizeFaceRigProfile } from "./faceRigProfile.js"
import { mapFaceRigToPose, rigValuesFromEliteRig } from "./faceDofMapper.js"
import { createRightMouthCornerFivebarState } from "../sdk/kinematics/mouthCornerFivebar.js"
import { buildMapFaceRigToPoseOptionsFromMouthRuntimes } from "../sdk/kinematics/mouthFiveBarRuntimeOptions.js"
import {
  buildExpressionTimeline,
  buildTransientKeyframeFromSample,
  resolveExpressionPlaybackWindow,
  sampleExpressionTimeline,
} from "./expressionTimelineSampler.js"

/** 与 RJ Motion Adapter minSendIntervalMs 对齐；动画层独立 cadence，不改协议实现 */
export const EXPRESSION_HARDWARE_SAMPLE_INTERVAL_MS = 20

const _keyframePlaybackRightFiveBarState = createRightMouthCornerFivebarState()
const _keyframePlaybackLeftFiveBarState = createRightMouthCornerFivebarState()

/**
 * 绝对时钟 → timeline 时间（支持 loop 取模，无累计漂移）。
 */
export function computePlaybackTimelineTime({
  nowMs,
  anchorClockMs,
  anchorTimelineMs,
  totalDurationMs,
  loop = false,
  paused = false,
  frozenTimelineMs = 0,
}) {
  if (paused) {
    return Number(frozenTimelineMs) || 0
  }

  const elapsed = Math.max(0, Number(nowMs) - Number(anchorClockMs))
  const raw = Number(anchorTimelineMs) + elapsed
  const total = Number(totalDurationMs)

  if (!(total > 0)) {
    return 0
  }

  if (loop) {
    return ((raw % total) + total) % total
  }

  return Math.min(raw, total)
}

/**
 * Latest-wins + 受控 cadence：窗口内多次 offer 只保留最新；到期 take 一次。
 */
export function createLatestWinsCadenceGate({
  intervalMs = EXPRESSION_HARDWARE_SAMPLE_INTERVAL_MS,
  now = () => performance.now(),
} = {}) {
  let lastSendAt = -Infinity
  let pending = null
  let sendCount = 0
  let offerCount = 0

  return {
    offer(sample) {
      pending = sample
      offerCount += 1
    },
    /** @returns {any|null} */
    takeIfDue() {
      if (pending == null) {
        return null
      }
      const t = now()
      if (t - lastSendAt < intervalMs) {
        return null
      }
      lastSendAt = t
      const out = pending
      pending = null
      sendCount += 1
      return out
    },
    peekPending() {
      return pending
    },
    getStats() {
      return { offerCount, sendCount, intervalMs, lastSendAt }
    },
    reset() {
      lastSendAt = -Infinity
      pending = null
      sendCount = 0
      offerCount = 0
    },
  }
}

export function getKeyframeFiveBarPlaybackNote(keyframe) {
  if (keyframe?.rigSnapshot && typeof keyframe.rigSnapshot === "object") {
    return ""
  }
  return "No rigSnapshot; mouth FiveBar (left/right) cannot be resolved from positions-only keyframe."
}

/**
 * 关键帧预览摘要（PWM 文本协议已移除；实发请走 sendKeyframe → Bus）。
 * @returns {string}
 */
export function buildKeyframeCommand({ keyframe, configs, profile }) {
  let positions = { ...(keyframe?.positions || {}) }
  if (keyframe?.rigSnapshot && typeof keyframe.rigSnapshot === "object") {
    const profileN = normalizeFaceRigProfile(profile || loadFaceRigProfile())
    const mapOpts = buildMapFaceRigToPoseOptionsFromMouthRuntimes({
      rightState: _keyframePlaybackRightFiveBarState,
      leftState: _keyframePlaybackLeftFiveBarState,
    })
    const mapped = mapFaceRigToPose(rigValuesFromEliteRig(keyframe.rigSnapshot), profileN, configs, mapOpts)
    positions = { ...positions, ...mapped.logicalPose }
  }

  const moves = []

  for (const [servoIdText, logicalPwm] of Object.entries(positions)) {
    const servoId = Number.parseInt(servoIdText, 10)
    const config = getServoConfig(configs, servoId)

    if (config.enabled === false) {
      continue
    }

    const result = logicalToActualPwm(logicalPwm, config)

    moves.push({
      servoId,
      logicalPwm: result.inputLogicalPwm,
      actualPwm: result.actualPwm,
      timeMs: keyframe.durationMs,
    })
  }

  if (moves.length === 0) {
    return ""
  }

  return `[Bus preview] ${moves.length} servos · T=${keyframe.durationMs || 0}ms · ids=${moves
    .map((m) => m.servoId)
    .join(",")}`
}

export async function playKeyframe({
  keyframe,
  configs,
  sendCommand,
  sendKeyframe,
  onCommand,
  signal,
}) {
  if (signal?.aborted) {
    return false
  }

  if (typeof sendKeyframe === "function") {
    if (signal?.aborted) {
      return false
    }
    await sendKeyframe({ keyframe, configs, signal })
    return !signal?.aborted
  }

  const command = buildKeyframeCommand({
    keyframe,
    configs,
  })

  if (!command) {
    return false
  }

  onCommand?.(command)

  if (signal?.aborted) {
    return false
  }

  if (typeof sendCommand === "function") {
    await sendCommand(command)
  }

  return !signal?.aborted
}

/**
 * 绝对时间轴连续播放（替代「dispatch → wait duration → next」累积等待模型）。
 *
 * @param {object} options
 * @param {object[]} options.keyframes
 * @param {object[]} [options.configs]
 * @param {number} [options.startIndex]
 * @param {number|null} [options.endIndex]
 * @param {boolean} [options.loop]
 * @param {AbortSignal} [options.signal]
 * @param {(args: { keyframe: object, configs: object[], signal?: AbortSignal, sample: object }) => Promise<void>} [options.sendKeyframe]
 * @param {(sample: object, meta: { timelineTimeMs: number, generation: number }) => void} [options.onSample]
 * @param {(neckPose: object, meta: { timelineTimeMs: number, sample: object, generation: symbol }) => void|Promise<void>} [options.dispatchNeck]
 *   与 Face 同 tick 分发；失败不得中断 Face。
 * @param {(keyframe: object, index: number) => void} [options.onKeyframeStart] 段起点变化时回调（兼容旧 UI）
 * @param {number} [options.hardwareIntervalMs]
 * @param {() => number} [options.clock]
 * @param {{ current: null | { pause: Function, resume: Function, isPaused: Function, getTimelineTime: Function } }} [options.controlRef]
 * @param {(cb: FrameRequestCallback) => number} [options.scheduleUi]
 * @param {(id: number) => void} [options.cancelUi]
 * @param {(cb: () => void, ms: number) => any} [options.scheduleHw]
 * @param {(id: any) => void} [options.clearHw]
 */
export async function playKeyframes(options = {}) {
  const {
    keyframes,
    frameProject = null,
    timelineDurationMs = null,
    configs = [],
    startIndex = 0,
    endIndex = null,
    loop = false,
    sendCommand,
    sendKeyframe,
    onKeyframeStart,
    onSample,
    dispatchNeck,
    onCommand,
    signal,
    hardwareIntervalMs = EXPRESSION_HARDWARE_SAMPLE_INTERVAL_MS,
    clock = () => performance.now(),
    controlRef = null,
    scheduleUi = (cb) =>
      typeof requestAnimationFrame === "function" ? requestAnimationFrame(cb) : setTimeout(cb, 16),
    cancelUi = (id) => {
      if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(id)
      } else {
        clearTimeout(id)
      }
    },
    scheduleHw = (cb, ms) => setInterval(cb, ms),
    clearHw = (id) => clearInterval(id),
  } = options

  if (!Array.isArray(keyframes) || keyframes.length === 0) {
    return
  }

  const sampleSource =
    frameProject && typeof frameProject === "object"
      ? frameProject
      : {
          keyframes,
          timelineDurationMs:
            timelineDurationMs != null
              ? timelineDurationMs
              : frameProject?.timelineDurationMs,
        }

  const timeline = buildExpressionTimeline(sampleSource, {
    timelineDurationMs: timelineDurationMs ?? undefined,
  })
  const safeStart = Math.max(0, Math.min(startIndex, keyframes.length - 1))
  const safeEnd =
    endIndex === null
      ? keyframes.length - 1
      : Math.max(safeStart, Math.min(endIndex, keyframes.length - 1))

  const windowInfo = resolveExpressionPlaybackWindow(timeline, safeStart, safeEnd)
  const { startTimeMs } = windowInfo
  let { endTimeMs, windowDurationMs } = windowInfo

  if (windowDurationMs <= 0) {
    // 零长度窗口：至少打一次采样
    windowDurationMs = 0
    endTimeMs = startTimeMs
  }

  const generation = Symbol("expression-playback")
  let activeGeneration = generation
  let paused = false
  let frozenTimelineMs = startTimeMs
  let anchorClockMs = clock()
  let anchorTimelineMs = startTimeMs
  let lastReportedFromIndex = -1
  let hwBusy = false
  let finished = false

  const hwGate = createLatestWinsCadenceGate({
    intervalMs: hardwareIntervalMs,
    now: clock,
  })

  function getAbsoluteTimelineTime(nowMs = clock()) {
    if (paused) {
      return frozenTimelineMs
    }

    if (!(windowDurationMs > 0)) {
      return startTimeMs
    }

    const elapsed = Math.max(0, nowMs - anchorClockMs)
    const raw = anchorTimelineMs + elapsed

    if (loop) {
      const mod = ((raw - startTimeMs) % windowDurationMs + windowDurationMs) % windowDurationMs
      return startTimeMs + mod
    }

    return Math.min(raw, endTimeMs)
  }

  function isPastEnd(nowMs = clock()) {
    if (loop || !(windowDurationMs > 0)) {
      return false
    }
    if (paused) {
      return false
    }
    const elapsed = Math.max(0, nowMs - anchorClockMs)
    return anchorTimelineMs + elapsed >= endTimeMs
  }

  function pause() {
    if (paused || finished || signal?.aborted || activeGeneration !== generation) {
      return
    }
    frozenTimelineMs = getAbsoluteTimelineTime()
    paused = true
  }

  function resume() {
    if (!paused || finished || signal?.aborted || activeGeneration !== generation) {
      return
    }
    anchorTimelineMs = frozenTimelineMs
    anchorClockMs = clock()
    paused = false
  }

  if (controlRef && typeof controlRef === "object") {
    controlRef.current = {
      pause,
      resume,
      isPaused: () => paused,
      getTimelineTime: () => getAbsoluteTimelineTime(),
      getGeneration: () => generation,
    }
  }

  async function dispatchSample(sample) {
    if (signal?.aborted || activeGeneration !== generation || finished) {
      return
    }

    const transient = buildTransientKeyframeFromSample(sample, {
      moveTimeMs: hardwareIntervalMs,
    })

    const timelineTimeMs = sample?.timelineTimeMs

    // Face + Neck：并列独立；禁止 Promise.all（其一 reject 会拖垮整体）
    const faceTask = (async () => {
      try {
        if (typeof sendKeyframe === "function") {
          await sendKeyframe({
            keyframe: transient,
            configs,
            signal,
            sample,
          })
        } else {
          const command = buildKeyframeCommand({ keyframe: transient, configs })
          if (command) {
            onCommand?.(command)
            if (typeof sendCommand === "function") {
              await sendCommand(command)
            }
          }
        }
      } catch (err) {
        // 预期的 Face unavailable 由 sendKeyframe / characterHardwareDispatch 内部静默；
        // 此处仅兜底真正未捕获异常，且绝不阻断 Neck。
        console.warn("[playKeyframes] face hardware dispatch failed:", err)
      }
    })()

    const neckTask = (async () => {
      if (typeof dispatchNeck !== "function") return
      try {
        await dispatchNeck(sample?.characterPose?.neck || null, {
          timelineTimeMs,
          sample,
          generation,
        })
      } catch (err) {
        console.warn("[playKeyframes] neck dispatch failed:", err)
      }
    })()

    await Promise.allSettled([faceTask, neckTask])
  }

  function emitUiSample(sample) {
    if (signal?.aborted || activeGeneration !== generation) {
      return
    }

    onSample?.(sample, {
      timelineTimeMs: sample.timelineTimeMs,
      generation,
      paused,
    })

    const fromIdx = sample.fromKeyframeIndex
    if (fromIdx !== lastReportedFromIndex && fromIdx >= 0) {
      lastReportedFromIndex = fromIdx
      const kf = keyframes[fromIdx]
      if (kf) {
        onKeyframeStart?.(kf, fromIdx)
      }
    }
  }

  function tickUi() {
    if (signal?.aborted || activeGeneration !== generation || finished) {
      return
    }

    const nowMs = clock()
    const timelineTimeMs = getAbsoluteTimelineTime(nowMs)
    const sample = sampleExpressionTimeline(sampleSource, timelineTimeMs)
    emitUiSample(sample)
    hwGate.offer(sample)

    if (!loop && isPastEnd(nowMs)) {
      finished = true
      return
    }

    uiHandle = scheduleUi(tickUi)
  }

  async function tickHw() {
    if (signal?.aborted || activeGeneration !== generation || finished || paused || hwBusy) {
      return
    }

    // 发送瞬间再采样一次 → latest wins（不重放历史 FIFO）
    const nowMs = clock()
    const timelineTimeMs = getAbsoluteTimelineTime(nowMs)
    const live = sampleExpressionTimeline(sampleSource, timelineTimeMs)
    hwGate.offer(live)

    const due = hwGate.takeIfDue()
    if (!due) {
      return
    }

    hwBusy = true
    try {
      await dispatchSample(due)
    } finally {
      hwBusy = false
    }
  }

  let uiHandle = null
  const hwTimerIds = new Set()
  /** @type {null | (() => void)} */
  let resolveWaitLoop = null

  function trackHw(cb, ms) {
    const id = scheduleHw(cb, ms)
    hwTimerIds.add(id)
    return id
  }

  function clearTrackedHw(id) {
    if (id == null) return
    clearHw(id)
    hwTimerIds.delete(id)
  }

  trackHw(() => {
    void tickHw()
  }, hardwareIntervalMs)

  function cleanup() {
    activeGeneration = null
    finished = true
    if (uiHandle != null) {
      cancelUi(uiHandle)
      uiHandle = null
    }
    for (const id of [...hwTimerIds]) {
      clearTrackedHw(id)
    }
    if (controlRef && controlRef.current?.getGeneration?.() === generation) {
      controlRef.current = null
    }
    if (resolveWaitLoop) {
      const resolve = resolveWaitLoop
      resolveWaitLoop = null
      resolve()
    }
  }

  const onAbort = () => {
    cleanup()
  }
  signal?.addEventListener?.("abort", onAbort, { once: true })

  try {
    // 立即采样一次（t=start）
    const first = sampleExpressionTimeline(sampleSource, startTimeMs)
    emitUiSample(first)
    hwGate.offer(first)
    await dispatchSample(first)

    if (signal?.aborted || activeGeneration !== generation) {
      return
    }

    if (!(windowDurationMs > 0) && !loop) {
      return
    }

    uiHandle = scheduleUi(tickUi)

    await new Promise((resolve) => {
      resolveWaitLoop = resolve
      const doneWatch = trackHw(() => {
        if (signal?.aborted || activeGeneration !== generation) {
          clearTrackedHw(doneWatch)
          if (resolveWaitLoop) {
            const r = resolveWaitLoop
            resolveWaitLoop = null
            r()
          }
          return
        }
        if (!loop && (finished || (isPastEnd() && !paused))) {
          finished = true
          clearTrackedHw(doneWatch)
          if (resolveWaitLoop) {
            const r = resolveWaitLoop
            resolveWaitLoop = null
            r()
          }
        }
        // loop：仅 abort / stop 结束
      }, Math.max(8, Math.floor(hardwareIntervalMs / 2)))
    })
  } finally {
    signal?.removeEventListener?.("abort", onAbort)
    cleanup()
  }
}
