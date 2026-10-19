/**
 * Browser Runtime — in-memory tracking-dataset-v1 session (no Python HTTP).
 */
import { TRACKING_DATASET_SCHEMA } from "./trackingDatasetRecorder.js"

/** @typedef {{ sessionId: string, metadataBlobUrl: string, framesBlobUrl: string }} BrowserDatasetExportUrls */

let activeSession = null
/** @type {BrowserDatasetExportUrls | null} */
let lastBrowserExport = null

function utcNowIso() {
  return new Date().toISOString()
}

export function newBrowserDatasetSessionId() {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "")
    .replace("T", "_")
  return `dataset_${stamp}`
}

function revokeExportUrls(exportUrls) {
  if (!exportUrls) return
  for (const key of ["metadataBlobUrl", "framesBlobUrl"]) {
    const url = exportUrls[key]
    if (url && typeof URL !== "undefined" && url.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(url)
      } catch {
        /* ignore */
      }
    }
  }
}

async function compressJsonl(jsonl, compression) {
  if (compression === "none") {
    return new TextEncoder().encode(jsonl)
  }
  if (typeof CompressionStream !== "undefined") {
    const stream = new Blob([jsonl]).stream().pipeThrough(new CompressionStream("gzip"))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  }
  // Fallback: uncompressed when gzip unavailable
  return new TextEncoder().encode(jsonl)
}

function buildSourceMetadata(sourceType, sourceState, request) {
  const out = {
    sourceType,
    sourceId: sourceState?.sourceId ?? (sourceType === "camera" ? "browser-mediapipe" : null),
    sourceEpoch: Number(sourceState?.sourceEpoch) || 0,
    videoStartMs: Number(request?.videoStartMs) || 0,
    playbackRate: Number(request?.playbackRate) || 1,
    trackingRuntime: "browser",
  }
  if (sourceType === "camera") {
    out.cameraId = sourceState?.cameraId ?? "browser-mediapipe"
    out.cameraLabel = sourceState?.cameraLabel ?? "Browser Camera"
  }
  for (const key of [
    "videoPathLabel",
    "videoFileName",
    "videoSourceHash",
    "uploadedVideoId",
    "cameraIndex",
    "cameraWidth",
    "cameraHeight",
    "cameraFps",
  ]) {
    if (sourceState?.[key] != null) out[key] = sourceState[key]
  }
  return out
}

/**
 * @param {{ sessionId: string, request: object, sourceState: object }} params
 */
export function startBrowserDatasetSession({ sessionId, request, sourceState }) {
  if (activeSession) {
    throw new Error("dataset-already-recording")
  }
  revokeExportUrls(lastBrowserExport)
  lastBrowserExport = null
  const wantGzip = request?.exportCompression !== "none"
  const canGzip = typeof CompressionStream !== "undefined"
  activeSession = {
    sessionId,
    request: { ...request },
    sourceState: { ...sourceState },
    createdAt: utcNowIso(),
    frames: [],
    frameCount: 0,
    bytesWritten: 0,
    firstTimestampMs: null,
    lastTimestampMs: null,
    compression: wantGzip && canGzip ? "gzip" : "none",
    datasetType: request?.datasetType ?? "camera-tracking-reference",
    sourceType: sourceState?.sourceType ?? "camera",
    sourceEpoch: Number(sourceState?.sourceEpoch) || 0,
  }
  return {
    ok: true,
    sessionId,
    datasetType: activeSession.datasetType,
    sourceType: activeSession.sourceType,
    sourceEpoch: activeSession.sourceEpoch,
    exportCompression: activeSession.compression,
  }
}

/**
 * @param {object} frame
 */
export function appendBrowserDatasetFrame(frame) {
  if (!activeSession) {
    return { ok: false, error: "dataset-not-recording" }
  }
  const sync = { ...(frame.sync || {}) }
  sync.appendServerReceiveTimeMs =
    typeof performance !== "undefined" ? performance.now() : Date.now()
  const next = { ...frame, sync }
  const line = JSON.stringify(next)
  activeSession.frames.push(next)
  activeSession.frameCount += 1
  activeSession.bytesWritten += line.length + 1
  const ts = next.source?.timestampMs
  if (ts != null && Number.isFinite(Number(ts))) {
    const tsv = Number(ts)
    if (activeSession.firstTimestampMs == null) activeSession.firstTimestampMs = tsv
    activeSession.lastTimestampMs = tsv
  }
  return { ok: true, frameCount: activeSession.frameCount }
}

/**
 * @param {object} [safety]
 */
export async function finalizeBrowserDatasetSession(safety = {}) {
  if (!activeSession) {
    return { ok: false, error: "dataset-not-recording" }
  }
  const session = activeSession
  activeSession = null

  const safetyOut = {
    previewOnlyForced: true,
    realDeviceSendAllowed: false,
    realSentFrameCount: 0,
    realTxCount: 0,
    realBusPacketCount: 0,
    ...safety,
  }

  const jsonl = session.frames.map((f) => JSON.stringify(f)).join("\n")
  const jsonlBytes = await compressJsonl(jsonl, session.compression)

  const durationMs =
    session.firstTimestampMs != null &&
    session.lastTimestampMs != null &&
    session.lastTimestampMs > session.firstTimestampMs
      ? session.lastTimestampMs - session.firstTimestampMs
      : null

  const metadata = {
    schemaVersion: TRACKING_DATASET_SCHEMA,
    sessionId: session.sessionId,
    createdAt: session.createdAt,
    stoppedAt: utcNowIso(),
    datasetType: session.datasetType,
    exportCompression: session.compression,
    trackingRuntime: "browser",
    source: buildSourceMetadata(session.sourceType, session.sourceState, session.request),
    safety: safetyOut,
    trackingConfig: {
      samplingMode: session.request?.samplingMode ?? "source-fps",
      targetFps: session.request?.targetFps ?? 30,
      includeLandmarks: Boolean(session.request?.includeLandmarks),
      includeBlendshapes: session.request?.includeBlendshapes !== false,
      includeRawTrackingSignals: session.request?.includeRawTrackingSignals !== false,
      includeTunedRig: session.request?.includeTunedRig !== false,
      includePreviewCommand: session.request?.includePreviewCommand !== false,
      videoSourceTuningEnabled: false,
      videoNeutralEnabled: session.request?.videoNeutralEnabled !== false,
      roiEnabled: Boolean(session.request?.roiEnabled),
    },
    frameSchema: {
      format: "jsonl",
      oneLinePerFrame: true,
      chunked: false,
      ...(session.compression === "gzip" ? { compression: "gzip" } : {}),
    },
    summary: {
      frameCount: session.frameCount,
      bytesWritten: session.bytesWritten,
      framesSizeBytes: jsonlBytes.length,
      durationMs,
      processedFps:
        durationMs && durationMs > 0 && session.frameCount > 1
          ? Math.round((session.frameCount / (durationMs / 1000)) * 100) / 100
          : null,
    },
  }

  const metadataJson = JSON.stringify(metadata, null, 2)
  const metadataBlob = new Blob([metadataJson], { type: "application/json" })
  const framesBlob = new Blob([jsonlBytes], {
    type: session.compression === "gzip" ? "application/gzip" : "application/x-ndjson",
  })
  const metadataBlobUrl = URL.createObjectURL(metadataBlob)
  const framesBlobUrl = URL.createObjectURL(framesBlob)

  lastBrowserExport = {
    sessionId: session.sessionId,
    metadataBlobUrl,
    framesBlobUrl,
  }

  return {
    ok: true,
    sessionId: session.sessionId,
    frameCount: session.frameCount,
    exportCompression: session.compression,
    metadataPath: `${session.sessionId}.metadata.json`,
    framesPath:
      session.compression === "gzip"
        ? `${session.sessionId}.frames.jsonl.gz`
        : `${session.sessionId}.frames.jsonl`,
    browserExport: lastBrowserExport,
  }
}

/**
 * @param {string} sessionId
 * @param {'metadata' | 'frames'} fileKind
 */
export function buildBrowserDatasetDownloadUrl(sessionId, fileKind) {
  if (!lastBrowserExport || lastBrowserExport.sessionId !== sessionId) {
    return null
  }
  return fileKind === "metadata" ? lastBrowserExport.metadataBlobUrl : lastBrowserExport.framesBlobUrl
}

export function getBrowserDatasetExportUrls() {
  return lastBrowserExport
}
