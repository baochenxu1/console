import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { readJsonStorage, writeJsonStorage } from "../../../utils/storage.js"
import { formatVideoClock } from "../../trackingPreview/formatVideoClock.js"
import {
  buildTrackingApiBaseUrl,
  postVideoPause,
  postVideoSeek,
} from "../../trackingPreview/trackingSourceApi.js"
import {
  buildVideoPreviewMediaUrl,
  resolveVideoPreviewDurationMs,
} from "../../trackingPreview/videoPreviewMediaUrl.js"

const VIDEO_PREVIEW_VOLUME_STORAGE_KEY = "facedev.tracking.videoPreviewVolume"
const SYNC_THRESHOLD_SEC = 0.75
const SEEK_SETTLE_MS = 400
const AUDIO_AHEAD_PAUSE_SEC = 0.35
const PLAYBACK_RATE_MIN = 0.4
const PLAYBACK_RATE_MAX = 1.0
const PLAYBACK_RATE_SMOOTH = 0.18

function clampVolume(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) {
    return 0.8
  }
  return Math.max(0, Math.min(1, n))
}

/**
 * @param {object} params
 */
export function useVideoPreviewPlayback({
  wsUrl,
  sourceState = {},
  defaultVideos = [],
  uploadedVideos = [],
  lastFrame = null,
  trackingEnabled = false,
  videoEnded = false,
  sendTrackingControl,
  fallbackVideoId = "",
  selectedVideoId = "",
}) {
  const audioRef = useRef(/** @type {HTMLVideoElement | null} */ (null))
  const scrubbingRef = useRef(false)
  const scrubValueRef = useRef(0)
  const pendingSeekRef = useRef(/** @type {number | null} */ (null))
  const liveMsTrackerRef = useRef({ ms: 0, seekEpoch: -1, sourceEpoch: -1 })
  const lastAudioSyncMsRef = useRef(0)
  const playbackRateTrackerRef = useRef({ wallAt: 0, liveMs: 0, rate: 1 })
  const apiBaseUrl = useMemo(() => buildTrackingApiBaseUrl(wsUrl), [wsUrl])

  const [volume, setVolumeState] = useState(() =>
    clampVolume(readJsonStorage(VIDEO_PREVIEW_VOLUME_STORAGE_KEY, 0.8))
  )
  const [muted, setMuted] = useState(false)
  const [scrubMs, setScrubMs] = useState(null)
  const [pendingSeekMs, setPendingSeekMs] = useState(null)
  const [mediaDurationMs, setMediaDurationMs] = useState(0)
  const [videoPaused, setVideoPaused] = useState(false)

  const mediaUrl = useMemo(
    () =>
      buildVideoPreviewMediaUrl(wsUrl, sourceState, {
        fallbackVideoId: selectedVideoId || fallbackVideoId,
        defaultVideos,
      }),
    [wsUrl, sourceState, selectedVideoId, fallbackVideoId, defaultVideos]
  )

  const totalDurationMs = useMemo(
    () =>
      resolveVideoPreviewDurationMs({
        sourceState,
        defaultVideos,
        uploadedVideos,
        lastFrame,
        fallbackVideoId: selectedVideoId || fallbackVideoId,
      }),
    [sourceState, defaultVideos, uploadedVideos, lastFrame, selectedVideoId, fallbackVideoId]
  )

  const durationMs = Math.max(totalDurationMs || 0, mediaDurationMs || 0, 1)

  const liveMs = useMemo(() => {
    const src = lastFrame?.debug?.inputSource ?? lastFrame?.inputSource
    const t = src?.videoTimeMs
    const seekEpoch = Number(src?.seekEpoch) || 0
    const sourceEpoch = Number(sourceState?.sourceEpoch) || 0
    const tracker = liveMsTrackerRef.current

    let raw = 0
    if (t != null && Number.isFinite(Number(t))) {
      raw = Math.max(0, Number(t))
    } else {
      const start = Number(sourceState?.videoStartMs)
      raw = Number.isFinite(start) && start >= 0 ? Math.max(0, start) : 0
    }

    if (
      seekEpoch !== tracker.seekEpoch ||
      sourceEpoch !== tracker.sourceEpoch
    ) {
      tracker.seekEpoch = seekEpoch
      tracker.sourceEpoch = sourceEpoch
      tracker.ms = raw
    } else {
      tracker.ms = Math.max(tracker.ms, raw)
    }

    return Math.max(0, Math.min(durationMs, tracker.ms))
  }, [
    lastFrame,
    sourceState?.videoStartMs,
    sourceState?.sourceEpoch,
    durationMs,
  ])

  useEffect(() => {
    if (pendingSeekMs == null) {
      return
    }
    if (Math.abs(liveMs - pendingSeekMs) <= SEEK_SETTLE_MS) {
      setPendingSeekMs(null)
      pendingSeekRef.current = null
    }
  }, [liveMs, pendingSeekMs])

  const displayMs = Math.min(
    durationMs,
    scrubMs != null ? scrubMs : pendingSeekMs != null ? pendingSeekMs : liveMs
  )

  const syncAudioTime = useCallback((ms, { tryPlay = false } = {}) => {
    const el = audioRef.current
    if (!el) {
      return
    }
    const sec = Math.max(0, Number(ms) || 0) / 1000
    const apply = () => {
      try {
        if (Math.abs(el.currentTime - sec) > 0.05) {
          el.currentTime = sec
        }
      } catch {
        /* ignore seek before metadata */
      }
      if (tryPlay && !muted) {
        el.play().catch(() => {})
      }
    }
    if (el.readyState >= 1) {
      apply()
    } else {
      const onMeta = () => {
        el.removeEventListener("loadedmetadata", onMeta)
        apply()
      }
      el.addEventListener("loadedmetadata", onMeta)
    }
  }, [muted])

  useEffect(() => {
    const src = lastFrame?.debug?.inputSource ?? lastFrame?.inputSource
    if (src?.paused != null) {
      setVideoPaused(Boolean(src.paused))
    }
  }, [lastFrame?.debug?.inputSource?.paused, lastFrame?.inputSource?.paused])

  const setPaused = useCallback(
    async (nextPaused) => {
      const paused = Boolean(nextPaused)
      setVideoPaused(paused)
      sendTrackingControl?.({
        action: paused ? "pauseVideo" : "resumeVideo",
        reason: "ui-playback",
      })
      try {
        await postVideoPause(apiBaseUrl, paused)
      } catch {
        /* WS may still succeed */
      }
      const el = audioRef.current
      if (!el) {
        return
      }
      if (paused) {
        el.pause()
        return
      }
      if (trackingEnabled && !videoEnded && !muted) {
        syncAudioTime(displayMs, { tryPlay: true })
      }
    },
    [
      sendTrackingControl,
      apiBaseUrl,
      trackingEnabled,
      videoEnded,
      muted,
      syncAudioTime,
      displayMs,
    ]
  )

  const togglePause = useCallback(() => {
    void setPaused(!videoPaused)
  }, [setPaused, videoPaused])

  const seekTo = useCallback(
    async (ms, { syncAudio = true, tryPlay = false } = {}) => {
      const next = Math.max(0, Math.min(durationMs, Number(ms) || 0))
      setPendingSeekMs(next)
      pendingSeekRef.current = next

      sendTrackingControl?.({
        action: "seekVideo",
        videoTimeMs: next,
        reason: "ui-scrub",
      })

      try {
        await postVideoSeek(apiBaseUrl, next)
      } catch {
        /* WS seek may still succeed; REST requires tracking service restart */
      }

      if (syncAudio) {
        syncAudioTime(next, { tryPlay })
        lastAudioSyncMsRef.current = next
        playbackRateTrackerRef.current = { wallAt: 0, liveMs: next, rate: 1 }
      }
      return next
    },
    [durationMs, sendTrackingControl, apiBaseUrl, syncAudioTime]
  )

  const primeAudioFromUserGesture = useCallback(() => {
    const el = audioRef.current
    if (!el || muted) {
      return
    }
    el.play().catch(() => {})
    el.pause()
    syncAudioTime(displayMs)
  }, [muted, syncAudioTime, displayMs])

  const resumePreviewAudio = useCallback(() => {
    if (!trackingEnabled || videoEnded || videoPaused) {
      return
    }
    syncAudioTime(displayMs, { tryPlay: true })
  }, [trackingEnabled, videoEnded, videoPaused, syncAudioTime, displayMs])

  const playAfterUserGesture = useCallback(() => {
    if (muted) {
      return
    }
    resumePreviewAudio()
  }, [muted, resumePreviewAudio])

  const setVolume = useCallback((next) => {
    const v = clampVolume(next)
    setVolumeState(v)
    writeJsonStorage(VIDEO_PREVIEW_VOLUME_STORAGE_KEY, v)
    if (audioRef.current) {
      audioRef.current.volume = v
    }
  }, [])

  const beginScrub = useCallback(() => {
    scrubbingRef.current = true
    audioRef.current?.pause()
    const start = pendingSeekMs != null ? pendingSeekMs : liveMs
    scrubValueRef.current = start
    setScrubMs(start)

    const finishScrub = () => {
      document.removeEventListener("pointerup", finishScrub)
      document.removeEventListener("mouseup", finishScrub)
      if (!scrubbingRef.current) {
        return
      }
      scrubbingRef.current = false
      const target = scrubValueRef.current
      setScrubMs(null)
      void seekTo(target, { syncAudio: true, tryPlay: false })
    }
    document.addEventListener("pointerup", finishScrub)
    document.addEventListener("mouseup", finishScrub)
  }, [liveMs, pendingSeekMs, seekTo])

  const scrubTo = useCallback(
    (ms) => {
      const next = Math.max(0, Math.min(durationMs, Number(ms) || 0))
      scrubValueRef.current = next
      setScrubMs(next)
    },
    [durationMs]
  )

  useEffect(() => {
    setMediaDurationMs(0)
    setPendingSeekMs(null)
    pendingSeekRef.current = null
    liveMsTrackerRef.current = { ms: 0, seekEpoch: -1, sourceEpoch: -1 }
    lastAudioSyncMsRef.current = 0
    playbackRateTrackerRef.current = { wallAt: 0, liveMs: 0, rate: 1 }
    setVideoPaused(false)
  }, [mediaUrl, sourceState?.sourceEpoch])

  useEffect(() => {
    const el = audioRef.current
    if (!el) {
      return
    }
    el.volume = volume
    el.muted = muted
  }, [volume, muted, mediaUrl])

  useEffect(() => {
    const el = audioRef.current
    if (!el || !mediaUrl) {
      return
    }
    el.pause()
    try {
      el.currentTime = (pendingSeekMs ?? liveMs) / 1000
    } catch {
      /* ignore */
    }
  }, [mediaUrl])

  useEffect(() => {
    const el = audioRef.current
    if (!el || scrubbingRef.current || scrubMs != null) {
      return
    }
    if (!trackingEnabled || videoEnded || videoPaused) {
      el.playbackRate = 1
      el.pause()
      return
    }

    const now = performance.now()
    const rateTracker = playbackRateTrackerRef.current
    const driftSec = el.currentTime - liveMs / 1000

    if (rateTracker.wallAt > 0) {
      const dWallSec = (now - rateTracker.wallAt) / 1000
      const dLiveSec = (liveMs - rateTracker.liveMs) / 1000
      if (dWallSec > 0.35 && dLiveSec > 0.005) {
        const measured = dLiveSec / dWallSec
        const target = Math.max(
          PLAYBACK_RATE_MIN,
          Math.min(PLAYBACK_RATE_MAX, measured * 0.96)
        )
        rateTracker.rate += (target - rateTracker.rate) * PLAYBACK_RATE_SMOOTH
        el.playbackRate = rateTracker.rate
      }
    }
    rateTracker.wallAt = now
    rateTracker.liveMs = liveMs

    if (driftSec < -SYNC_THRESHOLD_SEC) {
      syncAudioTime(liveMs)
      lastAudioSyncMsRef.current = liveMs
    } else if (driftSec > AUDIO_AHEAD_PAUSE_SEC) {
      el.pause()
      return
    }

    if (!muted && el.paused) {
      el.play().catch(() => {})
    }
  }, [trackingEnabled, videoEnded, videoPaused, liveMs, muted, scrubMs, syncAudioTime])

  return {
    audioRef,
    mediaUrl,
    durationMs,
    displayMs,
    liveMs,
    volume,
    muted,
    videoPaused,
    canTogglePause: trackingEnabled && !videoEnded,
    setVolume,
    setMuted,
    setMediaDurationMs,
    setPaused,
    togglePause,
    seekTo,
    beginScrub,
    scrubTo,
    playAfterUserGesture,
    primeAudioFromUserGesture,
    resumePreviewAudio,
    timeLabel: `${formatVideoClock(displayMs)} / ${formatVideoClock(durationMs)}`,
    scrubbing: scrubMs != null,
  }
}
