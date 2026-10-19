import { buildTrackingApiBaseUrl } from "./trackingSourceApi.js"
import { resolveVideoTotalDurationMs } from "./resolveVideoPlaybackWindow.js"

/**
 * @param {object} [sourceState]
 * @param {object[]} [defaultVideos]
 * @param {string} [fallbackVideoId]
 */
export function resolveCatalogVideoFileId(
  sourceState = {},
  defaultVideos = [],
  fallbackVideoId = ""
) {
  const st = sourceState || {}
  const candidates = [
    fallbackVideoId,
    st.selectedVideoId,
    st.sourceId,
  ]
    .map((v) => String(v || "").trim())
    .filter(Boolean)

  for (const key of candidates) {
    const direct = defaultVideos.find(
      (v) => String(v.id) === key || String(v.label) === key
    )
    if (direct?.id) {
      return String(direct.id)
    }
    if (key.startsWith("video:")) {
      const parts = key.split(":")
      const base = parts[1] || ""
      const stem = base.replace(/\.mp4$/i, "")
      const matched = defaultVideos.find(
        (v) =>
          String(v.label) === base ||
          String(v.id) === stem ||
          String(v.path || "").endsWith(base)
      )
      if (matched?.id) {
        return String(matched.id)
      }
    }
  }
  return fallbackVideoId ? String(fallbackVideoId) : null
}

/**
 * @param {string} [wsUrl]
 * @param {object} [sourceState]
 * @param {object} [options]
 * @param {string} [options.fallbackVideoId]
 * @param {object[]} [options.defaultVideos]
 */
export function buildVideoPreviewMediaUrl(wsUrl, sourceState = {}, options = {}) {
  const baseUrl = buildTrackingApiBaseUrl(wsUrl)
  const st = sourceState || {}
  if (st.sourceType === "uploaded-video" && st.uploadedVideoId) {
    return `${baseUrl}/api/tracking/videos/uploads/${encodeURIComponent(String(st.uploadedVideoId))}/file`
  }
  const catalogId = resolveCatalogVideoFileId(
    st,
    options.defaultVideos ?? [],
    options.fallbackVideoId ?? ""
  )
  if (catalogId) {
    return `${baseUrl}/api/tracking/videos/file/${encodeURIComponent(String(catalogId))}`
  }
  return null
}

/**
 * @param {object} params
 */
export function resolveVideoPreviewDurationMs({
  sourceState = {},
  defaultVideos = [],
  uploadedVideos = [],
  lastFrame = null,
  fallbackVideoId = "",
} = {}) {
  const st = sourceState || {}
  const fromState = resolveVideoTotalDurationMs({
    sourceType: st.sourceType,
    sourceId: st.sourceId,
    uploadedVideoId: st.uploadedVideoId,
    videoDurationMs: st.videoDurationMs,
    defaultVideos,
    uploadedVideos,
  })
  if (fromState != null && Number.isFinite(fromState) && fromState > 0) {
    return fromState
  }
  const catalogId = resolveCatalogVideoFileId(st, defaultVideos, fallbackVideoId)
  if (catalogId) {
    const entry = defaultVideos.find((v) => String(v.id) === String(catalogId))
    const ms = Number(entry?.durationMs)
    if (Number.isFinite(ms) && ms > 0) {
      return ms
    }
  }
  const src = lastFrame?.debug?.inputSource ?? lastFrame?.inputSource
  const fromFrame = Number(src?.videoDurationMs)
  if (Number.isFinite(fromFrame) && fromFrame > 0) {
    return fromFrame
  }
  return 0
}
