import { playKeyframes } from "../../core/actionPlayer.js"
import { createNeutralCharacterPose } from "../../core/characterPose.js"
import { createKeyframe } from "../../core/frameProject.js"
import { dispatchCharacterHardware } from "./characterHardwareDispatch.js"
import { dispatchKeyframeToHardware } from "./keyframePlaybackDispatch.js"
import { buildPresetFrameProject } from "./expressionPresetClip.js"
import { getBuiltinDemoPreset, isClosedBuiltinPreset } from "./expressionPresetCatalog.js"
import {
  getExpressionPreset as getProductPreset,
  isClosedPlayablePreset,
} from "./expressionPresetRegistry.js"
import {
  PHYSICAL_MOTION_OWNERS,
  acquirePhysicalMotionOwner,
  describePresetPlaybackBlockReason,
  listPhysicalMotionOwners,
  releasePhysicalMotionOwner,
} from "./physicalMotionOwner.js"
import { canMutateSequence, createSequencePlaybackSnapshot } from "./expressionPresetSequence.js"

export const PRESET_PLAYBACK_STATES = Object.freeze({
  IDLE: "IDLE",
  PLAYING_PRESET: "PLAYING_PRESET",
  PLAYING_SEQUENCE: "PLAYING_SEQUENCE",
  STOPPING_TO_NEUTRAL: "STOPPING_TO_NEUTRAL",
  ERROR: "ERROR",
})

export const PRESET_REPEAT_MODES = Object.freeze({
  ONCE: "once",
  REPEAT: "repeat",
  INFINITE: "infinite",
})

function clampRepeat(n, fallback = 3) {
  const v = Math.round(Number(n))
  if (!Number.isFinite(v)) return fallback
  return Math.min(999, Math.max(1, v))
}

export function createExpressionPresetPlaybackController(options = {}) {
  const {
    configs = [],
    playClip,
    dispatchNeutral,
    getBlockingOwners = listPhysicalMotionOwners,
    acquireOwner = acquirePhysicalMotionOwner,
    releaseOwner = releasePhysicalMotionOwner,
    onSnapshot,
    dispatchNeck = null,
    dispatchFaceImpl = dispatchKeyframeToHardware,
    resolvePreset = null,
  } = options

  const runFaceDispatch =
    typeof dispatchFaceImpl === "function" ? dispatchFaceImpl : dispatchKeyframeToHardware

  function lookupPreset(id) {
    if (typeof resolvePreset === "function") {
      return resolvePreset(id)
    }
    return getProductPreset(id) || getBuiltinDemoPreset(id)
  }

  function hasPlayableAsset(preset) {
    if (!preset) return false
    if (preset.animation && Array.isArray(preset.animation.keyframes) && preset.animation.keyframes.length) {
      return true
    }
    if (preset.clip && Array.isArray(preset.clip.keyframes) && preset.clip.keyframes.length) {
      return true
    }
    return false
  }

  function isClosed(preset) {
    return isClosedPlayablePreset(preset) || isClosedBuiltinPreset(preset)
  }

  let generation = 0
  let abort = null
  let playLoop = null
  let snapshot = makeSnapshot()
  /** @type {object|null} immutable sequence playback snapshot */
  let activeSequenceSnapshot = null

  function makeSnapshot(partial = {}) {
    return {
      state: PRESET_PLAYBACK_STATES.IDLE,
      selectedPresetId: null,
      playingPresetId: null,
      playingMode: PRESET_REPEAT_MODES.ONCE,
      playingRepeatTotal: 1,
      playingRepeatIndex: 0,
      sequenceIndex: -1,
      sequenceItemCount: 0,
      sequenceItemRepeatIndex: 0,
      sequenceItemRepeatTotal: 1,
      sequenceCycleIndex: 0,
      sequenceCycleTotal: 1,
      sequenceRunId: null,
      progress01: 0,
      clipDurationMs: 0,
      clipTimeMs: 0,
      lastCharacterPose: createNeutralCharacterPose(),
      blockReason: "",
      neckWarning: "",
      leaveStatus: "",
      error: "",
      ...partial,
    }
  }

  function emit(partial) {
    snapshot = { ...snapshot, ...partial }
    onSnapshot?.(snapshot)
    return snapshot
  }

  function bumpGeneration() {
    generation += 1
    abort?.abort()
    abort = null
    activeSequenceSnapshot = null
    return generation
  }

  function isStale(gen) {
    return gen !== generation
  }

  async function defaultPlayClip({ preset, signal, onSample }) {
    const project = buildPresetFrameProject(preset, configs)
    await playKeyframes({
      keyframes: project.keyframes,
      frameProject: project,
      timelineDurationMs: project.timelineDurationMs,
      configs,
      loop: false,
      signal,
      onSample,
      dispatchNeck,
      sendKeyframe: async ({ keyframe, configs: cfgs, signal: sig, sample }) => {
        const result = await dispatchCharacterHardware({
          keyframe,
          configs: cfgs,
          signal: sig,
          sample,
          timelineTimeMs: sample?.timelineTimeMs,
          dispatchNeck: null,
          dispatchFaceImpl: runFaceDispatch,
        })
        const neckStatus = result?.neck?.status
        if (
          preset.scope === "character" &&
          (neckStatus === "SKIPPED" ||
            neckStatus === "FAILED" ||
            neckStatus === "DISCONNECTED" ||
            result?.neck?.error)
        ) {
          emit({ neckWarning: "Neck 输出不可用，颈部动作已跳过。" })
        }
        return result
      },
    })
  }

  async function defaultDispatchNeutral() {
    const pose = createNeutralCharacterPose()
    const keyframe = createKeyframe({
      name: "neutral",
      timeMs: 0,
      characterPose: pose,
      rigSnapshot: pose.face,
      configs,
    })
    const sample = {
      timelineTimeMs: 0,
      characterPose: pose,
      rigSnapshot: pose.face,
    }
    await dispatchCharacterHardware({
      keyframe,
      configs,
      sample,
      timelineTimeMs: 0,
      dispatchNeck,
      dispatchFaceImpl: runFaceDispatch,
    })
    emit({ lastCharacterPose: pose, progress01: 0, clipTimeMs: 0 })
  }

  const runClip = typeof playClip === "function" ? playClip : defaultPlayClip
  const runNeutral = typeof dispatchNeutral === "function" ? dispatchNeutral : defaultDispatchNeutral

  function rejectIfBusyOrBlocked() {
    if (
      snapshot.state === PRESET_PLAYBACK_STATES.PLAYING_PRESET ||
      snapshot.state === PRESET_PLAYBACK_STATES.PLAYING_SEQUENCE ||
      snapshot.state === PRESET_PLAYBACK_STATES.STOPPING_TO_NEUTRAL
    ) {
      return "预设正在播放，请等待完成或停止并回中。"
    }
    const owners = getBlockingOwners().filter((id) => id !== PHYSICAL_MOTION_OWNERS.PRESET_PLAYBACK)
    return describePresetPlaybackBlockReason(owners)
  }

  async function playOnePreset(preset, mode, repeatCount, gen) {
    const total =
      mode === PRESET_REPEAT_MODES.ONCE
        ? 1
        : mode === PRESET_REPEAT_MODES.INFINITE
          ? Number.POSITIVE_INFINITY
          : clampRepeat(repeatCount, 3)
    let i = 0
    while (!isStale(gen)) {
      if (Number.isFinite(total) && i >= total) break
      i += 1
      emit({
        playingPresetId: preset.id,
        playingRepeatIndex: i,
        playingRepeatTotal: Number.isFinite(total) ? total : 0,
        progress01: 0,
        clipDurationMs: preset.durationMs,
        clipTimeMs: 0,
      })
      const ac = new AbortController()
      abort = ac
      await runClip({
        preset,
        signal: ac.signal,
        onSample: (sample) => {
          if (isStale(gen)) return
          const dur = Number(preset.durationMs) || 1
          const t = Number(sample?.timelineTimeMs) || 0
          emit({
            lastCharacterPose: sample?.characterPose || snapshot.lastCharacterPose,
            clipTimeMs: t,
            progress01: Math.min(1, t / dur),
          })
        },
      })
      if (isStale(gen) || ac.signal.aborted) {
        return "cancelled"
      }
    }
    return isStale(gen) ? "cancelled" : "complete"
  }

  async function startPreset({ presetId, mode = PRESET_REPEAT_MODES.ONCE, repeatCount = 3 }) {
    const preset = lookupPreset(presetId)
    if (!preset || !hasPlayableAsset(preset)) {
      return emit({
        state: PRESET_PLAYBACK_STATES.ERROR,
        error: "预设不可用。",
        blockReason: "预设不可用。",
      })
    }
    if (!isClosed(preset) && mode !== PRESET_REPEAT_MODES.ONCE) {
      return emit({
        blockReason: "非闭环动作仅支持单次播放。",
      })
    }
    const blocked = rejectIfBusyOrBlocked()
    if (blocked) {
      return emit({ blockReason: blocked })
    }
    const gen = bumpGeneration()
    acquireOwner(PHYSICAL_MOTION_OWNERS.PRESET_PLAYBACK)
    emit({
      state: PRESET_PLAYBACK_STATES.PLAYING_PRESET,
      playingPresetId: preset.id,
      playingMode: mode,
      blockReason: "",
      error: "",
      neckWarning: "",
      leaveStatus: "",
    })
    playLoop = (async () => {
      try {
        const result = await playOnePreset(preset, mode, repeatCount, gen)
        if (isStale(gen)) return
        if (result === "complete") {
          await runNeutral()
          if (isStale(gen)) return
          releaseOwner(PHYSICAL_MOTION_OWNERS.PRESET_PLAYBACK)
          emit({
            state: PRESET_PLAYBACK_STATES.IDLE,
            playingPresetId: null,
            playingRepeatIndex: 0,
            progress01: 0,
          })
        }
      } catch (err) {
        if (isStale(gen)) return
        releaseOwner(PHYSICAL_MOTION_OWNERS.PRESET_PLAYBACK)
        emit({
          state: PRESET_PLAYBACK_STATES.ERROR,
          error: "播放失败",
          playingPresetId: null,
        })
      }
    })()
    return snapshot
  }

  async function startSequence({
    items = [],
    mode = PRESET_REPEAT_MODES.ONCE,
    repeatCount = 1,
  }) {
    const created = createSequencePlaybackSnapshot({
      items,
      mode,
      repeatCount,
      resolvePreset: lookupPreset,
    })
    if (!created.ok) {
      return emit({
        blockReason: created.message || "序列无法播放。",
        error: created.code || "",
      })
    }
    const blocked = rejectIfBusyOrBlocked()
    if (blocked) {
      return emit({ blockReason: blocked })
    }

    // Freeze active snapshot before generation bump side-effects clear it.
    const runSnapshot = created.snapshot
    const gen = bumpGeneration()
    activeSequenceSnapshot = runSnapshot
    acquireOwner(PHYSICAL_MOTION_OWNERS.PRESET_PLAYBACK)
    const cycles =
      runSnapshot.mode === PRESET_REPEAT_MODES.ONCE
        ? 1
        : runSnapshot.mode === PRESET_REPEAT_MODES.INFINITE
          ? Number.POSITIVE_INFINITY
          : clampRepeat(runSnapshot.repeatCount, 1)
    emit({
      state: PRESET_PLAYBACK_STATES.PLAYING_SEQUENCE,
      playingMode: runSnapshot.mode,
      sequenceRunId: runSnapshot.sequenceRunId,
      sequenceItemCount: runSnapshot.items.length,
      sequenceCycleTotal: Number.isFinite(cycles) ? cycles : 0,
      sequenceIndex: -1,
      blockReason: "",
      error: "",
      neckWarning: "",
    })
    playLoop = (async () => {
      try {
        let cycle = 0
        while (!isStale(gen) && activeSequenceSnapshot?.sequenceRunId === runSnapshot.sequenceRunId) {
          if (Number.isFinite(cycles) && cycle >= cycles) break
          cycle += 1
          emit({ sequenceCycleIndex: cycle })
          for (let i = 0; i < runSnapshot.items.length; i += 1) {
            if (isStale(gen) || activeSequenceSnapshot?.sequenceRunId !== runSnapshot.sequenceRunId) {
              return
            }
            const item = runSnapshot.items[i]
            const preset = lookupPreset(item.presetId)
            if (!preset || !isClosed(preset)) {
              throw new Error(`序列第 ${i + 1} 项不可用`)
            }
            const itemTimes = clampRepeat(item.repeatCount, 1)
            emit({
              sequenceIndex: i,
              playingPresetId: preset.id,
              sequenceItemRepeatTotal: itemTimes,
              clipDurationMs: preset.durationMs,
            })
            for (let r = 1; r <= itemTimes; r += 1) {
              if (isStale(gen) || activeSequenceSnapshot?.sequenceRunId !== runSnapshot.sequenceRunId) {
                return
              }
              emit({ sequenceItemRepeatIndex: r, progress01: 0 })
              const ac = new AbortController()
              abort = ac
              await runClip({
                preset,
                signal: ac.signal,
                onSample: (sample) => {
                  if (isStale(gen)) return
                  if (activeSequenceSnapshot?.sequenceRunId !== runSnapshot.sequenceRunId) return
                  const dur = Number(preset.durationMs) || 1
                  const t = Number(sample?.timelineTimeMs) || 0
                  emit({
                    lastCharacterPose: sample?.characterPose || snapshot.lastCharacterPose,
                    clipTimeMs: t,
                    clipDurationMs: dur,
                    progress01: Math.min(1, t / dur),
                  })
                },
              })
              if (isStale(gen) || ac.signal.aborted) return
              if (activeSequenceSnapshot?.sequenceRunId !== runSnapshot.sequenceRunId) return
            }
          }
        }
        if (isStale(gen)) return
        await runNeutral()
        if (isStale(gen)) return
        releaseOwner(PHYSICAL_MOTION_OWNERS.PRESET_PLAYBACK)
        activeSequenceSnapshot = null
        emit({
          state: PRESET_PLAYBACK_STATES.IDLE,
          playingPresetId: null,
          sequenceIndex: -1,
          sequenceRunId: null,
          progress01: 0,
          lastCharacterPose: createNeutralCharacterPose(),
        })
      } catch (err) {
        if (isStale(gen)) return
        try {
          await runNeutral()
        } catch {
          /* best effort */
        }
        releaseOwner(PHYSICAL_MOTION_OWNERS.PRESET_PLAYBACK)
        activeSequenceSnapshot = null
        emit({
          state: PRESET_PLAYBACK_STATES.ERROR,
          error: "序列播放失败",
          blockReason: err?.message || "序列播放失败",
          playingPresetId: null,
          sequenceRunId: null,
        })
      }
    })()
    return snapshot
  }

  async function stopToNeutral({ leaving = false } = {}) {
    const gen = bumpGeneration()
    emit({
      state: PRESET_PLAYBACK_STATES.STOPPING_TO_NEUTRAL,
      leaveStatus: leaving ? "正在停止表情并回中…" : "",
    })
    try {
      await runNeutral()
    } catch {
      /* still release */
    }
    if (isStale(gen) && generation !== gen) {
      /* a newer stop/start won */
    }
    releaseOwner(PHYSICAL_MOTION_OWNERS.PRESET_PLAYBACK)
    activeSequenceSnapshot = null
    emit({
      state: PRESET_PLAYBACK_STATES.IDLE,
      playingPresetId: null,
      sequenceIndex: -1,
      sequenceRunId: null,
      progress01: 0,
      leaveStatus: "",
      blockReason: "",
      lastCharacterPose: createNeutralCharacterPose(),
    })
    return snapshot
  }

  async function prepareLeave() {
    if (
      snapshot.state === PRESET_PLAYBACK_STATES.PLAYING_PRESET ||
      snapshot.state === PRESET_PLAYBACK_STATES.PLAYING_SEQUENCE ||
      snapshot.state === PRESET_PLAYBACK_STATES.STOPPING_TO_NEUTRAL
    ) {
      await stopToNeutral({ leaving: true })
    }
    return snapshot
  }

  return {
    getSnapshot: () => snapshot,
    getGeneration: () => generation,
    getActiveSequenceSnapshot: () => activeSequenceSnapshot,
    canMutateSequence: () => canMutateSequence(snapshot.state),
    isBusy: () =>
      snapshot.state === PRESET_PLAYBACK_STATES.PLAYING_PRESET ||
      snapshot.state === PRESET_PLAYBACK_STATES.PLAYING_SEQUENCE ||
      snapshot.state === PRESET_PLAYBACK_STATES.STOPPING_TO_NEUTRAL,
    selectPreset(id) {
      emit({ selectedPresetId: id })
    },
    startPreset,
    startSequence,
    stopToNeutral,
    prepareLeave,
    waitForPlayLoop: () => playLoop || Promise.resolve(),
  }
}
