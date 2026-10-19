import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  buildTrackingApiBaseUrl,
  fetchDefaultVideos,
  fetchTrackingSourceState,
  postTrackingSourceSwitch,
} from "../../trackingPreview/trackingSourceApi.js"
import {
  listCameras,
  rescanCameras as postRescanCameras,
  testCamera,
  setPreferredCamera,
} from "../../trackingPreview/trackingCameraApi.js"
import {
  deleteUploadedVideo,
  listUploadedVideos,
  uploadVideo,
} from "../../trackingPreview/trackingVideoUploadApi.js"
import { DEFAULT_WS_CAMERA } from "../../trackingPreview/trackingPreviewConstants.js"
import { findDefaultVideoCatalogEntry } from "../../trackingPreview/resolveVideoPlaybackWindow.js"

const DEFAULT_VIDEO_ID = "test02"

function resolveCatalogVideoId(sourceId, defaultVideos = [], fallback = "") {
  const entry = findDefaultVideoCatalogEntry(sourceId, defaultVideos)
  if (entry?.id != null) {
    return String(entry.id)
  }
  const trimmed = String(sourceId || "").trim()
  if (trimmed.startsWith("video:")) {
    const base = trimmed.split(":")[1] || ""
    const stem = base.replace(/\.mp4$/i, "")
    if (stem) {
      return stem
    }
    return fallback
  }
  return trimmed || fallback
}

/**
 * Phase 3.0 — unified tracking source manager (frontend).
 * Python Runtime 专用权威源；Browser Runtime 应传 enabled=false，避免访问 8767。
 * @param {object} params
 * @param {string} [params.wsUrl]
 * @param {boolean} [params.enabled] — false 时不发起 Python REST（Browser Runtime）
 * @param {(payload: Record<string, unknown>) => void} [params.onBeforeSwitch]
 * @param {(payload: Record<string, unknown>) => void} [params.onAfterSwitch]
 */
export function useTrackingSourceManager({
  wsUrl = DEFAULT_WS_CAMERA,
  enabled = true,
  onBeforeSwitch,
  onAfterSwitch,
} = {}) {
  const apiBaseUrl = useMemo(() => buildTrackingApiBaseUrl(wsUrl), [wsUrl])
  const expectedEpochRef = useRef(/** @type {number | null} */ (null))
  const [state, setState] = useState(() => ({
    sourceType: /** @type {import("../../trackingPreview/trackingSourceApi.js").TrackingSourceType} */ (
      "idle"
    ),
    sourceId: null,
    sourceEpoch: 0,
    status: "idle",
    previewOnlyForced: false,
    videoSourceTuningEnabled: false,
    videoDeviceDryRunEnabled: false,
    switching: false,
    switchTarget: null,
    error: null,
    defaultVideos: /** @type {Record<string, unknown>[]} */ ([]),
    uploadedVideos: /** @type {Record<string, unknown>[]} */ ([]),
    selectedVideoId: DEFAULT_VIDEO_ID,
    selectedUploadedVideoId: null,
    uploadedVideoId: null,
    videoStartMs: null,
    videoDurationMs: null,
    playbackRate: null,
    cameras: /** @type {Record<string, unknown>[]} */ ([]),
    preferredCameraId: null,
    selectedCameraId: null,
    cameraId: null,
    cameraIndex: null,
    cameraLabel: null,
    cameraWidth: null,
    cameraHeight: null,
    cameraFps: null,
  }))

  const mergeCameraFields = useCallback((prev, remote) => ({
    cameraId: remote?.cameraId ?? prev.cameraId,
    cameraIndex: remote?.cameraIndex ?? prev.cameraIndex,
    cameraLabel: remote?.cameraLabel ?? prev.cameraLabel,
    cameraWidth: remote?.cameraWidth ?? prev.cameraWidth,
    cameraHeight: remote?.cameraHeight ?? prev.cameraHeight,
    cameraFps: remote?.cameraFps ?? prev.cameraFps,
  }), [])

  const refreshSourceState = useCallback(async () => {
    try {
      const remote = await fetchTrackingSourceState(apiBaseUrl)
      expectedEpochRef.current =
        remote?.sourceEpoch != null && Number.isFinite(Number(remote.sourceEpoch))
          ? Number(remote.sourceEpoch)
          : expectedEpochRef.current
      setState((prev) => ({
        ...prev,
        sourceType: remote.sourceType ?? prev.sourceType,
        sourceId: remote.sourceId ?? null,
        sourceEpoch: Number(remote.sourceEpoch) || 0,
        status: remote.status ?? "idle",
        previewOnlyForced: Boolean(remote.previewOnlyForced),
        videoSourceTuningEnabled: Boolean(remote.videoSourceTuningEnabled),
        videoDeviceDryRunEnabled: Boolean(remote.videoDeviceDryRunEnabled),
        uploadedVideoId: remote.uploadedVideoId ?? null,
        videoStartMs:
          remote.videoStartMs != null && Number.isFinite(Number(remote.videoStartMs))
            ? Number(remote.videoStartMs)
            : prev.videoStartMs,
        videoDurationMs:
          remote.videoDurationMs != null && Number.isFinite(Number(remote.videoDurationMs))
            ? Number(remote.videoDurationMs)
            : prev.videoDurationMs,
        playbackRate:
          remote.playbackRate != null && Number.isFinite(Number(remote.playbackRate))
            ? Number(remote.playbackRate)
            : prev.playbackRate,
        ...mergeCameraFields(prev, remote),
        selectedVideoId:
          remote.sourceType === "video"
            ? resolveCatalogVideoId(remote.sourceId, prev.defaultVideos, prev.selectedVideoId)
            : prev.selectedVideoId,
        error: null,
      }))
      return remote
    } catch (err) {
      setState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : String(err),
      }))
      return null
    }
  }, [apiBaseUrl, mergeCameraFields])

  const loadCameras = useCallback(async () => {
    try {
      const data = await listCameras(apiBaseUrl)
      const cameras = Array.isArray(data?.cameras) ? data.cameras : []
      const preferredCameraId = data?.preferredCameraId ?? null
      setState((prev) => ({
        ...prev,
        cameras,
        preferredCameraId,
        selectedCameraId:
          prev.selectedCameraId ??
          preferredCameraId ??
          cameras[0]?.cameraId ??
          null,
        error: null,
      }))
      return data
    } catch (err) {
      setState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : String(err),
      }))
      return null
    }
  }, [apiBaseUrl])

  const rescanCameras = useCallback(async () => {
    try {
      const data = await postRescanCameras(apiBaseUrl)
      const cameras = Array.isArray(data?.cameras) ? data.cameras : []
      setState((prev) => ({
        ...prev,
        cameras,
        preferredCameraId: data?.preferredCameraId ?? prev.preferredCameraId,
        selectedCameraId:
          prev.selectedCameraId && cameras.some((c) => c.cameraId === prev.selectedCameraId)
            ? prev.selectedCameraId
            : data?.preferredCameraId ?? cameras[0]?.cameraId ?? null,
        error: null,
      }))
      return data
    } catch (err) {
      setState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : String(err),
      }))
      throw err
    }
  }, [apiBaseUrl])

  const testCameraById = useCallback(
    async (cameraId) => testCamera(apiBaseUrl, cameraId),
    [apiBaseUrl]
  )

  const setPreferredCameraById = useCallback(
    async (cameraId) => {
      const result = await setPreferredCamera(apiBaseUrl, cameraId)
      setState((prev) => ({
        ...prev,
        preferredCameraId: result.preferredCameraId ?? cameraId,
        cameras: prev.cameras.map((c) => ({
          ...c,
          isPreferred: c.cameraId === (result.preferredCameraId ?? cameraId),
        })),
        error: null,
      }))
      return result
    },
    [apiBaseUrl]
  )

  const loadDefaultVideos = useCallback(async () => {
    try {
      const videos = await fetchDefaultVideos(apiBaseUrl)
      setState((prev) => ({
        ...prev,
        defaultVideos: videos,
        selectedVideoId: resolveCatalogVideoId(
          prev.sourceType === "video"
            ? prev.sourceId || prev.selectedVideoId
            : prev.selectedVideoId,
          videos,
          prev.selectedVideoId
        ),
        error: null,
      }))
      return videos
    } catch (err) {
      setState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : String(err),
      }))
      return []
    }
  }, [apiBaseUrl])

  const loadUploadedVideos = useCallback(async () => {
    try {
      const videos = await listUploadedVideos(apiBaseUrl)
      setState((prev) => ({ ...prev, uploadedVideos: videos, error: null }))
      return videos
    } catch (err) {
      setState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : String(err),
      }))
      return []
    }
  }, [apiBaseUrl])

  useEffect(() => {
    if (!enabled) {
      return
    }
    void refreshSourceState()
    void loadDefaultVideos()
    void loadUploadedVideos()
    void loadCameras()
  }, [enabled, refreshSourceState, loadDefaultVideos, loadUploadedVideos, loadCameras])

  const switchSource = useCallback(
    async (request) => {
      if (!enabled) {
        throw new Error("python-source-manager-disabled")
      }
      onBeforeSwitch?.(request)
      setState((prev) => ({ ...prev, switching: true, switchTarget: request.sourceType ?? null, error: null }))
      try {
        const result = await postTrackingSourceSwitch(apiBaseUrl, request)
        const epoch = Number(result.sourceEpoch) || 0
        expectedEpochRef.current = epoch
        setState((prev) => ({
          ...prev,
          sourceType: result.sourceType ?? prev.sourceType,
          sourceId: result.sourceId ?? null,
          sourceEpoch: epoch,
          status: result.status ?? "running",
          previewOnlyForced: Boolean(result.previewOnlyForced),
          videoSourceTuningEnabled: Boolean(result.videoSourceTuningEnabled),
          videoDeviceDryRunEnabled: Boolean(result.videoDeviceDryRunEnabled),
          uploadedVideoId: result.uploadedVideoId ?? prev.uploadedVideoId,
          ...mergeCameraFields(prev, result),
          selectedCameraId:
            request.sourceType === "camera"
              ? String(request.cameraId || result.cameraId || prev.selectedCameraId)
              : prev.selectedCameraId,
          selectedUploadedVideoId:
            request.sourceType === "uploaded-video"
              ? String(request.uploadedVideoId || result.uploadedVideoId || prev.selectedUploadedVideoId)
              : prev.selectedUploadedVideoId,
          switching: false,
          switchTarget: null,
          error: null,
          selectedVideoId:
            request.sourceType === "video"
              ? resolveCatalogVideoId(
                  request.sourceId || result.sourceId,
                  prev.defaultVideos,
                  prev.selectedVideoId
                )
              : prev.selectedVideoId,
        }))
        onAfterSwitch?.(result)
        return result
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setState((prev) => ({ ...prev, switching: false, switchTarget: null, error: message }))
        throw err
      }
    },
    [apiBaseUrl, enabled, onBeforeSwitch, onAfterSwitch, mergeCameraFields]
  )

  const switchToIdle = useCallback(() => switchSource({ sourceType: "idle" }), [switchSource])

  const switchToCamera = useCallback(
    (cameraIdOrIndex) => {
      if (typeof cameraIdOrIndex === "string" && cameraIdOrIndex.startsWith("camera:")) {
        return switchSource({ sourceType: "camera", cameraId: cameraIdOrIndex })
      }
      if (typeof cameraIdOrIndex === "number" && Number.isFinite(cameraIdOrIndex)) {
        return switchSource({ sourceType: "camera", cameraIndex: cameraIdOrIndex })
      }
      const cameraId = state.selectedCameraId ?? state.preferredCameraId
      if (cameraId) {
        return switchSource({ sourceType: "camera", cameraId })
      }
      return switchSource({ sourceType: "camera" })
    },
    [switchSource, state.selectedCameraId, state.preferredCameraId]
  )

  const switchToDefaultVideo = useCallback(
    (videoId = state.selectedVideoId, videoStartMs = 3000) => {
      const catalogId = resolveCatalogVideoId(
        videoId,
        state.defaultVideos,
        DEFAULT_VIDEO_ID
      )
      const entry =
        state.defaultVideos.find(
          (v) =>
            String(v.id ?? "") === catalogId ||
            String(v.label ?? "") === catalogId ||
            String(v.id ?? "") === String(videoId) ||
            String(v.label ?? "") === String(videoId)
        ) ?? findDefaultVideoCatalogEntry(videoId, state.defaultVideos)
      const startMs = Number(entry?.defaultVideoStartMs ?? videoStartMs) || 0
      const request = {
        sourceType: "video",
        sourceId: entry?.id != null ? String(entry.id) : catalogId,
        videoStartMs: startMs,
        playbackRate: 1,
        deterministic: false,
        videoMode: "realtime",
      }
      if (entry?.path) {
        request.videoPath = String(entry.path)
      }
      return switchSource(request)
    },
    [switchSource, state.selectedVideoId, state.defaultVideos]
  )

  const switchToUploadedVideo = useCallback(
    (uploadedVideoId, options = {}) =>
      switchSource({
        sourceType: "uploaded-video",
        uploadedVideoId,
        videoStartMs: options.videoStartMs ?? 0,
        playbackRate: options.playbackRate ?? 1,
        deterministic: options.deterministic ?? false,
        videoMode: options.videoMode ?? "realtime",
      }),
    [switchSource]
  )

  const uploadVideoFile = useCallback(
    async (file, onProgress) => {
      const result = await uploadVideo(apiBaseUrl, file, onProgress)
      await loadUploadedVideos()
      return result
    },
    [apiBaseUrl, loadUploadedVideos]
  )

  const deleteUploadedVideoById = useCallback(
    async (uploadedVideoId) => {
      const result = await deleteUploadedVideo(apiBaseUrl, uploadedVideoId)
      await loadUploadedVideos()
      await refreshSourceState()
      return result
    },
    [apiBaseUrl, loadUploadedVideos, refreshSourceState]
  )

  const applySourceChangedEvent = useCallback((payload) => {
    if (!payload || typeof payload !== "object") {
      return
    }
    const epoch = Number(payload.sourceEpoch) || 0
    expectedEpochRef.current = epoch
    setState((prev) => ({
      ...prev,
      sourceType: payload.sourceType ?? prev.sourceType,
      sourceId: payload.sourceId ?? prev.sourceId,
      sourceEpoch: epoch,
      status: payload.status ?? prev.status,
      previewOnlyForced: Boolean(payload.previewOnlyForced),
      videoSourceTuningEnabled: Boolean(payload.videoSourceTuningEnabled),
      videoDeviceDryRunEnabled: Boolean(payload.videoDeviceDryRunEnabled),
      uploadedVideoId: payload.uploadedVideoId ?? prev.uploadedVideoId,
      videoStartMs:
        payload.videoStartMs != null && Number.isFinite(Number(payload.videoStartMs))
          ? Number(payload.videoStartMs)
          : prev.videoStartMs,
      videoDurationMs:
        payload.videoDurationMs != null && Number.isFinite(Number(payload.videoDurationMs))
          ? Number(payload.videoDurationMs)
          : prev.videoDurationMs,
      playbackRate:
        payload.playbackRate != null && Number.isFinite(Number(payload.playbackRate))
          ? Number(payload.playbackRate)
          : prev.playbackRate,
      ...mergeCameraFields(prev, payload),
      switching: false,
      switchTarget: null,
      error: null,
    }))
  }, [mergeCameraFields])

  const isFrameEpochValid = useCallback((frame) => {
    const expected = expectedEpochRef.current
    if (expected == null || expected <= 0) {
      return true
    }
    const frameEpoch = Number(frame?.debug?.inputSource?.sourceEpoch)
    if (!Number.isFinite(frameEpoch) || frameEpoch <= 0) {
      return true
    }
    return frameEpoch === expected
  }, [])

  return {
    apiBaseUrl,
    trackingSourceState: state,
    expectedSourceEpochRef: expectedEpochRef,
    refreshSourceState,
    loadDefaultVideos,
    loadCameras,
    rescanCameras,
    testCamera: testCameraById,
    setPreferredCamera: setPreferredCameraById,
    switchSource,
    switchToIdle,
    switchToCamera,
    switchToDefaultVideo,
    switchToUploadedVideo,
    uploadVideo: uploadVideoFile,
    deleteUploadedVideo: deleteUploadedVideoById,
    loadUploadedVideos,
    applySourceChangedEvent,
    isFrameEpochValid,
    setSelectedVideoId: (id) => setState((prev) => ({ ...prev, selectedVideoId: id })),
    setSelectedCameraId: (id) => setState((prev) => ({ ...prev, selectedCameraId: id })),
  }
}
