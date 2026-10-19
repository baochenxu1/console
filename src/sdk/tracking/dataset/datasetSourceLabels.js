/**
 * Resolve human-readable video labels from tracking source state / sourceId.
 */

/**
 * @param {string | null | undefined} sourceId
 */
export function parseVideoSourceIdLabels(sourceId) {
  const sid = String(sourceId || "")
  if (!sid.startsWith("video:")) {
    return {}
  }
  const parts = sid.split(":")
  if (parts.length < 4) {
    return {}
  }
  const videoFileName = parts[1]
  const videoSourceHash = parts[parts.length - 1]
  return {
    videoFileName,
    videoPathLabel: videoFileName,
    videoSourceHash,
  }
}

/**
 * @param {string | null | undefined} sourceId
 */
export function parseUploadedVideoSourceIdLabels(sourceId) {
  const sid = String(sourceId || "")
  const m = sid.match(/^uploaded-video:([^:]+):(.+)$/)
  if (!m) {
    return {}
  }
  const uploadedVideoId = m[1]
  const videoFileName = m[2]
  return {
    uploadedVideoId,
    videoFileName,
    videoPathLabel: videoFileName,
  }
}

/**
 * @param {object | null | undefined} sourceState
 * @param {object[]} [defaultVideos]
 */
export function resolveDatasetSourceLabels(sourceState, defaultVideos = []) {
  const sourceType = sourceState?.sourceType
  const sourceId = sourceState?.sourceId ?? null

  if (sourceType === "uploaded-video") {
    return parseUploadedVideoSourceIdLabels(sourceId)
  }

  if (sourceType === "camera") {
    return {
      cameraId: sourceState?.cameraId ?? sourceId ?? null,
      cameraIndex: sourceState?.cameraIndex ?? null,
      cameraLabel: sourceState?.cameraLabel ?? null,
      cameraWidth: sourceState?.cameraWidth ?? null,
      cameraHeight: sourceState?.cameraHeight ?? null,
      cameraFps: sourceState?.cameraFps ?? null,
    }
  }

  if (sourceType === "video") {
    const parsed = parseVideoSourceIdLabels(sourceId)
    if (parsed.videoFileName) {
      return parsed
    }
    for (const entry of defaultVideos) {
      const id = String(entry?.id || "")
      const label = String(entry?.label || "")
      if (id && sourceId && String(sourceId).includes(id) && label) {
        return {
          videoFileName: label,
          videoPathLabel: label,
          videoSourceHash: parsed.videoSourceHash ?? null,
        }
      }
    }
  }

  return {}
}
