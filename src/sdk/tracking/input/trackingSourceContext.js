/**
 * Phase 2.11 — 统一 tracking input source 判定（frame 优先，不依赖 tab/options 单独覆盖 frame）。
 */

/** @typedef {'camera' | 'video' | 'uploaded-video' | 'replay' | 'idle' | 'unknown'} ResolvedSourceType */

const KNOWN_TYPES = new Set(["camera", "video", "uploaded-video", "replay", "idle"])

/**
 * @param {unknown} v
 * @returns {ResolvedSourceType | null}
 */
function pickSourceType(v) {
  const t = String(v ?? "").toLowerCase()
  return KNOWN_TYPES.has(t) ? /** @type {ResolvedSourceType} */ (t) : null
}

/**
 * @param {object | null | undefined} frame — RigFrame 或 diagnostic compact frame
 * @param {Record<string, unknown>} [options]
 * @param {{ activeTab?: string, isVideoTab?: boolean, isCameraTab?: boolean }} [uiState]
 */
export function resolveTrackingSourceContext(frame, options = {}, uiState = {}) {
  let sourceType = null
  let sourceResolvedFrom = null

  /** @param {unknown} type @param {string} from */
  const assign = (type, from) => {
    const picked = pickSourceType(type)
    if (picked && !sourceType) {
      sourceType = picked
      sourceResolvedFrom = from
    }
  }

  assign(frame?.inputSource?.sourceType, "frame.inputSource.sourceType")
  assign(frame?.source?.sourceType, "frame.source.sourceType")
  assign(frame?.debug?.inputSource?.sourceType, "frame.debug.inputSource.sourceType")
  assign(options?.inputSourceType, "options.inputSourceType")

  if (!sourceType) {
    const tab = uiState?.activeTab ?? null
    if (tab === "video" || tab === "upload" || uiState?.isVideoTab === true) {
      sourceType = tab === "upload" ? "uploaded-video" : "video"
      sourceResolvedFrom = "uiState.activeTab"
    } else if (tab === "camera" || uiState?.isCameraTab === true) {
      sourceType = "camera"
      sourceResolvedFrom = "uiState.activeTab"
    }
  }

  if (!sourceType) {
    sourceType = "unknown"
    sourceResolvedFrom = "fallback-unknown"
  }

  const src = frame?.inputSource ?? frame?.debug?.inputSource ?? frame?.source ?? {}

  return {
    sourceType,
    isVideoSource: sourceType === "video" || sourceType === "uploaded-video",
    sourceId: src.sourceId ?? null,
    sourceSeq:
      src.sourceSeq != null && Number.isFinite(Number(src.sourceSeq))
        ? Number(src.sourceSeq)
        : frame?.sourceSeq ?? frame?.frameSeq ?? null,
    frameIndex:
      src.frameIndex != null && Number.isFinite(Number(src.frameIndex))
        ? Number(src.frameIndex)
        : null,
    videoTimeMs:
      src.videoTimeMs != null && Number.isFinite(Number(src.videoTimeMs))
        ? Number(src.videoTimeMs)
        : null,
    sourceEpoch:
      src.sourceEpoch != null && Number.isFinite(Number(src.sourceEpoch))
        ? Number(src.sourceEpoch)
        : null,
    sourceResolvedFrom,
    reason: sourceResolvedFrom,
  }
}

/**
 * @param {object | null | undefined} frame
 */
export function isVideoTrackingSourceContext(frame, options = {}, uiState = {}) {
  return resolveTrackingSourceContext(frame, options, uiState).isVideoSource
}
