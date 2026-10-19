#!/usr/bin/env node
/**
 * 验收导出的 tracking diagnostic JSON（video trackingDebug / videoFrameDebug 落盘）。
 *
 * Usage:
 *   node scripts/check-video-diagnostic-fields.js path/to/tracking-diagnostic.json
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const MIN_RATIO = 0.9

function loadJson(path) {
  const raw = readFileSync(resolve(path), "utf8")
  return JSON.parse(raw)
}

function count(frames, pred) {
  return frames.filter(pred).length
}

function isCompleteVideoFrameDebug(vfd) {
  if (!vfd || typeof vfd !== "object") return false
  const keys = [
    "frameWidth",
    "frameHeight",
    "canvasWidth",
    "canvasHeight",
    "displayWidth",
    "displayHeight",
    "scaleX",
    "scaleY",
    "offsetX",
    "offsetY",
  ]
  if (!keys.every((k) => Number.isFinite(Number(vfd[k])))) return false
  return Boolean(vfd.objectFit) && Boolean(vfd.coordinateSpace)
}

function main() {
  const path = process.argv[2]
  if (!path) {
    console.error("Usage: node scripts/check-video-diagnostic-fields.js <diagnostic.json>")
    process.exit(2)
  }

  const diagnostic = loadJson(path)
  const frames = (diagnostic.frames ?? []).filter(
    (f) => !f?.diagnostic?.isStatusFrame && !f?.diagnostic?.excludeFromSummary
  )
  const n = frames.length
  const vtq = diagnostic.summary?.videoTrackingQuality ?? {}

  const stats = {
    frames: n,
    trackingDebug: count(frames, (f) => f.trackingDebug),
    selectedLandmarks: count(frames, (f) => f.trackingDebug?.selectedLandmarks),
    noseTipPx: count(frames, (f) => f.trackingDebug?.selectedLandmarks?.noseTip?.px != null),
    leftMouthPx: count(frames, (f) => f.trackingDebug?.selectedLandmarks?.leftMouthCorner?.px != null),
    rightMouthPx: count(frames, (f) => f.trackingDebug?.selectedLandmarks?.rightMouthCorner?.px != null),
    faceBox: count(frames, (f) => f.trackingDebug?.faceBox?.centerXPx != null),
    videoFrameDebug: count(frames, (f) => f.videoFrameDebug),
    videoFrameDebugComplete: count(frames, (f) => isCompleteVideoFrameDebug(f.videoFrameDebug)),
    overlayTransformMissingCount: Number(vtq.overlayTransformMissingCount) || 0,
    noseDeltaPxP90: vtq.noseDeltaPxP90 ?? null,
    mouthCenterDeltaPxP90: vtq.mouthCenterDeltaPxP90 ?? null,
    eyeCenterDeltaPxP90: vtq.eyeCenterDeltaPxP90 ?? null,
    faceBoxCenterDeltaPxP90: vtq.faceBoxCenterDeltaPxP90 ?? null,
    trackingDebugFrameCount: vtq.trackingDebugFrameCount ?? null,
    videoFrameDebugFrameCount: vtq.videoFrameDebugFrameCount ?? null,
    warnings: diagnostic.summary?.videoQualityWarnings ?? [],
  }

  console.log(JSON.stringify(stats, null, 2))

  const failures = []
  const need = (label, got) => {
    if (n === 0) {
      failures.push("no frames")
      return
    }
    if (got < n * MIN_RATIO) {
      failures.push(`${label}: ${got}/${n} < ${Math.ceil(n * MIN_RATIO)}`)
    }
  }

  need("trackingDebug", stats.trackingDebug)
  need("selectedLandmarks", stats.selectedLandmarks)
  need("noseTipPx", stats.noseTipPx)
  need("faceBox", stats.faceBox)
  need("videoFrameDebug", stats.videoFrameDebug)
  need("videoFrameDebugComplete", stats.videoFrameDebugComplete)

  if (stats.overlayTransformMissingCount > n * 0.1) {
    failures.push(
      `overlayTransformMissingCount: ${stats.overlayTransformMissingCount} > ${Math.ceil(n * 0.1)}`
    )
  }
  if (stats.warnings.includes("video-overlay-transform-missing")) {
    failures.push("videoQualityWarnings contains video-overlay-transform-missing")
  }
  if (stats.noseDeltaPxP90 == null && stats.noseTipPx >= n * MIN_RATIO) {
    failures.push("noseDeltaPxP90 is null despite selectedLandmarks present")
  }

  if (failures.length) {
    console.error("FAIL:", failures.join("; "))
    process.exit(1)
  }
  console.log("PASS")
}

main()
