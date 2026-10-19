import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"

const VOLUME_POPOVER_GAP_PX = 12
const VOLUME_HIDE_DELAY_MS = 120

/**
 * @param {object} props
 * @param {ReturnType<import("./useVideoPreviewPlayback.js").useVideoPreviewPlayback>} props.playback
 * @param {boolean} [props.disabled]
 * @param {boolean} [props.overlay] 悬浮于视频预览框底部
 */
export default function VideoPreviewPlaybackBar({
  playback,
  disabled = false,
  overlay = false,
}) {
  const muteRef = useRef(null)
  const hideTimerRef = useRef(null)
  const [volumeOpen, setVolumeOpen] = useState(false)
  const [volumeAnchor, setVolumeAnchor] = useState(
    /** @type {{ left: number; bottom: number } | null} */ (null)
  )

  const syncVolumeAnchor = useCallback(() => {
    const btn = muteRef.current
    if (!btn) {
      return
    }
    const rect = btn.getBoundingClientRect()
    setVolumeAnchor({
      left: rect.left + rect.width / 2,
      bottom: window.innerHeight - rect.top + VOLUME_POPOVER_GAP_PX,
    })
  }, [])

  const showVolumePopover = useCallback(() => {
    if (hideTimerRef.current != null) {
      clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
    syncVolumeAnchor()
    setVolumeOpen(true)
  }, [syncVolumeAnchor])

  const scheduleHideVolumePopover = useCallback(() => {
    if (hideTimerRef.current != null) {
      clearTimeout(hideTimerRef.current)
    }
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null
      setVolumeOpen(false)
    }, VOLUME_HIDE_DELAY_MS)
  }, [])

  useLayoutEffect(() => {
    if (!volumeOpen) {
      return
    }
    syncVolumeAnchor()
  }, [volumeOpen, syncVolumeAnchor])

  useEffect(() => {
    if (!volumeOpen) {
      return undefined
    }
    const onReposition = () => syncVolumeAnchor()
    window.addEventListener("scroll", onReposition, true)
    window.addEventListener("resize", onReposition)
    return () => {
      window.removeEventListener("scroll", onReposition, true)
      window.removeEventListener("resize", onReposition)
    }
  }, [volumeOpen, syncVolumeAnchor])

  useEffect(
    () => () => {
      if (hideTimerRef.current != null) {
        clearTimeout(hideTimerRef.current)
      }
    },
    []
  )

  if (!playback?.mediaUrl) {
    return null
  }

  const {
    durationMs,
    displayMs,
    volume,
    muted,
    videoPaused,
    setVolume,
    setMuted,
    beginScrub,
    scrubTo,
    resumePreviewAudio,
    togglePause,
    canTogglePause,
    timeLabel,
  } = playback

  const pct =
    durationMs > 0 ? Math.max(0, Math.min(100, (displayMs / durationMs) * 100)) : 0

  const rootClass = overlay
    ? "tp-video-playback-overlay"
    : "tp-video-playback-bar"

  const volumePopover =
    volumeOpen && volumeAnchor
      ? createPortal(
          <div
            className="tp-video-playback-volume-wrap tp-video-playback-volume-wrap--portal"
            style={{
              left: `${volumeAnchor.left}px`,
              bottom: `${volumeAnchor.bottom}px`,
            }}
            onMouseEnter={showVolumePopover}
            onMouseLeave={scheduleHideVolumePopover}
          >
            <input
              type="range"
              className="tp-video-playback-volume"
              min={0}
              max={100}
              step={1}
              value={Math.round(volume * 100)}
              disabled={disabled}
              aria-label="Volume"
              aria-orientation="vertical"
              onChange={(e) => {
                setVolume(Number(e.target.value) / 100)
              }}
            />
          </div>,
          document.body
        )
      : null

  return (
    <div className={rootClass} aria-label="Video playback">
      <video
        ref={playback.audioRef}
        className="tp-video-playback-audio"
        src={playback.mediaUrl}
        preload="metadata"
        playsInline
        crossOrigin="anonymous"
        onLoadedMetadata={(e) => {
          const dur = Number(e.currentTarget.duration)
          if (Number.isFinite(dur) && dur > 0) {
            playback.setMediaDurationMs?.(dur * 1000)
          }
        }}
        aria-hidden
        tabIndex={-1}
      />
      <div className="tp-video-playback-panel">
        <div className="tp-video-playback-main">
          <div className="tp-video-playback-time-row">
            <button
              type="button"
              className="tp-video-playback-pause"
              disabled={disabled || !canTogglePause}
              aria-pressed={videoPaused}
              aria-label={videoPaused ? "继续播放" : "暂停"}
              title={videoPaused ? "继续" : "暂停"}
              onClick={() => togglePause?.()}
            >
              {videoPaused ? (
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
                  <path fill="currentColor" d="M8 5v14l11-7z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
                  <path fill="currentColor" d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                </svg>
              )}
            </button>
            <span className="tp-video-playback-time">{timeLabel}</span>
          </div>
          <input
            type="range"
            className="tp-video-playback-seek"
            min={0}
            max={Math.max(1, Math.round(durationMs))}
            step={50}
            value={Math.round(displayMs)}
            disabled={disabled || durationMs <= 0}
            aria-label="Video timeline"
            onPointerDown={() => beginScrub()}
            onInput={(e) => scrubTo(Number(e.target.value))}
            onChange={(e) => scrubTo(Number(e.target.value))}
            style={{ "--seek-pct": `${pct}%` }}
          />
        </div>
        <div className="tp-video-playback-side">
          <div
            className="tp-video-playback-volume-popover"
            onMouseEnter={showVolumePopover}
            onMouseLeave={scheduleHideVolumePopover}
            onFocus={showVolumePopover}
            onBlur={scheduleHideVolumePopover}
          >
            <button
              ref={muteRef}
              type="button"
              className="tp-video-playback-mute"
              disabled={disabled}
              aria-pressed={muted}
              aria-label={muted ? "取消静音" : "静音"}
              title={muted ? "取消静音" : "音量（悬停调节）"}
              onClick={() => {
                const nextMuted = !muted
                setMuted(nextMuted)
                if (!nextMuted) {
                  resumePreviewAudio?.()
                }
              }}
            >
              {muted ? (
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
                  <path
                    fill="currentColor"
                    d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"
                  />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
                  <path
                    fill="currentColor"
                    d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"
                  />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
      {volumePopover}
    </div>
  )
}
