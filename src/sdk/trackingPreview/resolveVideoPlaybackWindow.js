import { VIDEO_REAL_SEND_SMOKE_TEST_MAX_MS } from "./videoRealSendSmokeTest.js"

/**
 * @param {string} sourceId
 * @param {object[]} defaultVideos
 */
export function findDefaultVideoCatalogEntry(sourceId, defaultVideos = []) {
  const sid = String(sourceId || "").trim()
  if (!sid) {
    return null
  }
  let entry = defaultVideos.find(
    (v) =>
      String(v.id ?? "") === sid ||
      String(v.label ?? "") === sid ||
      String(v.path ?? "").endsWith(sid)
  )
  if (entry) {
    return entry
  }
  if (sid.startsWith("video:")) {
    const base = sid.split(":")[1] || ""
    const stem = base.replace(/\.mp4$/i, "")
    entry = defaultVideos.find(
      (v) =>
        String(v.label ?? "") === base ||
        String(v.id ?? "") === stem ||
        String(v.path ?? "").endsWith(base)
    )
  }
  return entry || null
}

/**
 * 下拉框 value：始终用 catalog id（如 test02），不用后端 video:file:size:mtime sourceId。
 * @param {object} sourceState
 * @param {object[]} [defaultVideos]
 */
export function resolveDefaultVideoSelectId(sourceState, defaultVideos = []) {
  const videos =
    defaultVideos?.length > 0
      ? defaultVideos
      : Array.isArray(sourceState?.defaultVideos)
        ? sourceState.defaultVideos
        : []
  const selected = String(sourceState?.selectedVideoId ?? "").trim()
  if (selected) {
    const bySelected = findDefaultVideoCatalogEntry(selected, videos)
    if (bySelected?.id != null) {
      return String(bySelected.id)
    }
  }
  if (sourceState?.sourceType === "video" && sourceState?.sourceId) {
    const bySource = findDefaultVideoCatalogEntry(sourceState.sourceId, videos)
    if (bySource?.id != null) {
      return String(bySource.id)
    }
  }
  return selected
}

/**
 * 解析当前视频源总时长（ms）。
 * @param {object} params
 */
export function resolveVideoTotalDurationMs({
  sourceType,
  sourceId,
  uploadedVideoId,
  videoDurationMs,
  defaultVideos = [],
  uploadedVideos = [],
} = {}) {
  const fromState = Number(videoDurationMs)
  if (Number.isFinite(fromState) && fromState > 0) {
    return fromState
  }
  if (sourceType === "uploaded-video" && uploadedVideoId) {
    const entry = uploadedVideos.find(
      (v) => String(v.uploadedVideoId ?? "") === String(uploadedVideoId)
    )
    const ms = Number(entry?.durationMs)
    if (Number.isFinite(ms) && ms > 0) {
      return ms
    }
  }
  if (sourceId) {
    const entry = findDefaultVideoCatalogEntry(sourceId, defaultVideos)
    const ms = Number(entry?.durationMs)
    if (Number.isFinite(ms) && ms > 0) {
      return ms
    }
  }
  return null
}

/**
 * 从 videoStartMs 到片尾的剩余播放窗口（ms）。
 * @param {object} params
 * @param {number} [params.fallbackMs] 无法解析时长时的回退值；0 = 不限时
 */
export function resolveVideoPlaybackRemainingMs(params = {}) {
  const startMs = Math.max(0, Number(params.videoStartMs) || 0)
  const totalMs = resolveVideoTotalDurationMs(params)
  if (!Number.isFinite(totalMs) || totalMs <= 0) {
    const fallback = Number(params.fallbackMs)
    if (Number.isFinite(fallback) && fallback >= 0) {
      return fallback
    }
    return VIDEO_REAL_SEND_SMOKE_TEST_MAX_MS
  }
  return Math.max(0, Math.ceil(totalMs - startMs))
}

/**
 * @param {number | null | undefined} remainingMs
 */
export function formatVideoPlaybackDurationLabel(remainingMs) {
  const ms = Number(remainingMs)
  if (!Number.isFinite(ms) || ms <= 0) {
    return "整段视频（至片尾自动停止）"
  }
  if (ms >= 60000) {
    return `${Math.round(ms / 1000)}s（整段视频）`
  }
  return `${Math.round(ms / 1000)}s`
}
