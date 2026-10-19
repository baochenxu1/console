import { useCallback, useRef, useState } from "react"

/**
 * Uploaded Video Source panel — upload / list / switch / delete.
 */
export default function UploadedVideoSourcePanel({
  sourceManager,
  onPlayUploadedVideo,
  previewOnlyForced = false,
}) {
  const fileInputRef = useRef(null)
  const [uploadProgress, setUploadProgress] = useState(null)
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState("")

  const st = sourceManager?.trackingSourceState ?? {}
  const videos = st.uploadedVideos ?? []
  const selectedId = st.selectedUploadedVideoId ?? null
  const currentUploadedId =
    st.sourceType === "uploaded-video" ? st.uploadedVideoId ?? selectedId : null
  const currentVideo = videos.find((v) => v.uploadedVideoId === currentUploadedId)

  const refreshList = useCallback(async () => {
    await sourceManager?.loadUploadedVideos?.()
  }, [sourceManager])

  const handlePickFile = () => {
    setLocalError("")
    fileInputRef.current?.click()
  }

  const handleFileChange = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file || !sourceManager?.uploadVideo) return
    setBusy(true)
    setLocalError("")
    setUploadProgress(0)
    try {
      const result = await sourceManager.uploadVideo(file, setUploadProgress)
      const uploaded = result?.uploadedVideo
      if (uploaded?.uploadedVideoId) {
        await sourceManager.switchToUploadedVideo(uploaded.uploadedVideoId, {
          autoStart: true,
        })
        onPlayUploadedVideo?.(uploaded)
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      setUploadProgress(null)
    }
  }

  const handleSwitch = async (uploadedVideoId) => {
    if (!uploadedVideoId || busy) return
    setBusy(true)
    setLocalError("")
    try {
      await sourceManager.switchToUploadedVideo(uploadedVideoId, { autoStart: true })
      onPlayUploadedVideo?.({ uploadedVideoId })
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (uploadedVideoId) => {
    if (!uploadedVideoId || busy || !sourceManager?.deleteUploadedVideo) return
    setBusy(true)
    setLocalError("")
    try {
      await sourceManager.deleteUploadedVideo(uploadedVideoId)
      await refreshList()
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="tp-uploaded-video-panel">
      <header className="tp-uploaded-video-panel__header">
        <h3>Uploaded Video</h3>
        {previewOnlyForced || st.sourceType === "uploaded-video" ? (
          <span className="tp-uploaded-video-panel__badge">Preview Only</span>
        ) : null}
      </header>

      <div className="tp-uploaded-video-panel__actions">
        <input
          ref={fileInputRef}
          type="file"
          accept=".mp4,.mov,.avi,.mkv,.webm,video/*"
          hidden
          onChange={handleFileChange}
        />
        <button type="button" className="tp-uploaded-video-panel__btn" disabled={busy} onClick={handlePickFile}>
          Upload Video
        </button>
        <button type="button" className="tp-uploaded-video-panel__btn" disabled={busy} onClick={refreshList}>
          Refresh List
        </button>
      </div>

      {uploadProgress != null ? (
        <div className="tp-uploaded-video-panel__progress">Uploading… {uploadProgress}%</div>
      ) : null}
      {localError ? <div className="tp-uploaded-video-panel__error">{localError}</div> : null}
      {st.error ? <div className="tp-uploaded-video-panel__error">{st.error}</div> : null}

      {currentUploadedId ? (
        <div className="tp-uploaded-video-panel__current">
          <div>Current Source: Uploaded Video</div>
          <div>File: {currentVideo?.filename ?? currentUploadedId}</div>
          <div>Preview Only: true</div>
        </div>
      ) : null}

      <ul className="tp-uploaded-video-panel__list">
        {videos.length === 0 ? (
          <li className="tp-uploaded-video-panel__empty">No uploaded videos yet.</li>
        ) : (
          videos.map((video) => {
            const id = video.uploadedVideoId
            const active = currentUploadedId === id
            return (
              <li key={id} className={`tp-uploaded-video-panel__item${active ? " is-active" : ""}`}>
                <div className="tp-uploaded-video-panel__meta">
                  <strong>{video.filename}</strong>
                  <span>
                    {Math.round(Number(video.durationMs) || 0)} ms · {video.fps ?? "?"} fps ·{" "}
                    {video.width ?? "?"}×{video.height ?? "?"}
                  </span>
                </div>
                <div className="tp-uploaded-video-panel__item-actions">
                  <button type="button" disabled={busy} onClick={() => handleSwitch(id)}>
                    {active ? "Active" : "Play"}
                  </button>
                  <button type="button" disabled={busy || active} onClick={() => handleDelete(id)}>
                    Delete
                  </button>
                </div>
              </li>
            )
          })
        )}
      </ul>
    </section>
  )
}
