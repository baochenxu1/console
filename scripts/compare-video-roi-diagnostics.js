#!/usr/bin/env node
/**
 * Phase 2.4 — A/B/C 对比 full-frame vs roi-tracking vs stable-roi。
 *
 * Usage:
 *   node scripts/compare-video-roi-diagnostics.js full-frame.json roi-1.8x.json stable-roi-1.8x.json
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const ALIGN_MS_TOLERANCE = 50

function loadJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"))
}

function pickRange(diagnostic) {
  const iss = diagnostic.summary?.inputSourceSummary ?? diagnostic.summary?.inputSource ?? {}
  return {
    label: diagnostic.options?.exportLabel ?? null,
    frameCount: diagnostic.frameCount ?? null,
    videoTimeMsFirst: iss.videoTimeMsFirst ?? iss.videoTimeMsMin ?? null,
    videoTimeMsLast: iss.videoTimeMsLast ?? iss.videoTimeMsMax ?? null,
    videoTimeMsMin: iss.videoTimeMsMin ?? null,
    videoTimeMsMax: iss.videoTimeMsMax ?? null,
    frameIndexFirst: iss.frameIndexFirst ?? iss.frameIndexMin ?? null,
    frameIndexLast: iss.frameIndexLast ?? iss.frameIndexMax ?? null,
    videoStartMs: diagnostic.options?.videoStartMs ?? null,
  }
}

function pickMetrics(diagnostic) {
  const vtq = diagnostic.summary?.videoTrackingQuality ?? {}
  const fss = diagnostic.summary?.faceScaleStability ?? {}
  return {
    ...pickRange(diagnostic),
    trackingMode: fss.trackingMode ?? null,
    roiMultiplier: fss.roiMultiplier ?? null,
    noseDeltaPxP90: vtq.noseDeltaPxP90 ?? null,
    mouthCenterDeltaPxP90: vtq.mouthCenterDeltaPxP90 ?? null,
    eyeCenterDeltaPxP90: vtq.eyeCenterDeltaPxP90 ?? null,
    faceBoxCenterDeltaPxP90: vtq.faceBoxCenterDeltaPxP90 ?? null,
    inferenceInputFaceCoverageRatioP90: fss.inferenceInputFaceCoverageRatioP90 ?? null,
    roiCenterDeltaPxP90: fss.roiCenterDeltaPxP90 ?? null,
    roiTargetCenterDeltaPxP90: fss.roiTargetCenterDeltaPxP90 ?? null,
    roiSmoothedCenterDeltaPxP90: fss.roiSmoothedCenterDeltaPxP90 ?? null,
    roiJitterReductionRatio: fss.roiJitterReductionRatio ?? null,
    roiUpdateAppliedRatio: fss.roiUpdateAppliedRatio ?? null,
    roiClampCount: fss.roiClampCount ?? null,
  }
}

function absDelta(a, b) {
  if (a == null || b == null) return null
  return Math.abs(Number(b) - Number(a))
}

function checkAlignment(rows) {
  if (rows.length < 2) return { aligned: true, diffs: {} }
  const base = rows[0]
  const diffs = {
    videoTimeMsFirstDiff: rows.slice(1).map((r) => absDelta(base.videoTimeMsFirst, r.videoTimeMsFirst)),
    videoTimeMsLastDiff: rows.slice(1).map((r) => absDelta(base.videoTimeMsLast, r.videoTimeMsLast)),
    frameCountDiff: rows.slice(1).map((r) => absDelta(base.frameCount, r.frameCount)),
  }
  const aligned =
    diffs.videoTimeMsFirstDiff.every((d) => d != null && d <= ALIGN_MS_TOLERANCE) &&
    diffs.videoTimeMsLastDiff.every((d) => d != null && d <= ALIGN_MS_TOLERANCE)
  return { aligned, diffs }
}

function main() {
  const paths = process.argv.slice(2)
  if (paths.length < 2) {
    console.error(
      "Usage: node scripts/compare-video-roi-diagnostics.js <full-frame.json> [roi.json] [stable-roi.json]"
    )
    process.exit(2)
  }

  const rows = paths.map((p, i) => ({
    file: p,
    ...(pickMetrics(loadJson(p)) || {}),
    slot: i === 0 ? "A-full-frame" : i === 1 ? "B-roi-tracking" : "C-stable-roi",
  }))

  const alignment = checkAlignment(rows)

  const comparison = {
    alignment,
    rows,
    interpretation: [
      "stable-roi inferenceInputFaceCoverageRatioP90 应明显高于 full-frame。",
      "stable-roi roiCenterDeltaPxP90 应低于 roi-tracking。",
      "stable-roi landmark delta P90 应不高于 full-frame，理想低于 full-frame。",
    ],
  }

  console.log(JSON.stringify(comparison, null, 2))

  if (!alignment.aligned) {
    console.error(
      `WARN: videoTimeMs 区间未对齐 (tolerance ${ALIGN_MS_TOLERANCE}ms)`,
      alignment.diffs
    )
    process.exit(1)
  }
}

main()
