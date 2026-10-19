#!/usr/bin/env node
/**
 * Phase 2.12 — AI-Review diagnostic 字段覆盖率 / 体积校验（不输出调参结论）。
 *
 * Usage:
 *   node scripts/check-ai-review-diagnostic.js <diagnostic.json> [full-diagnostic.json]
 */
import { readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { validateAiReviewExportPayload } from "../src/sdk/tracking/diagnostics/diagnosticAiReviewExport.js"

function loadJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"))
}

function fileBytes(path) {
  try {
    return statSync(resolve(path)).size
  } catch {
    return null
  }
}

function main() {
  const aiReviewPath = process.argv[2]
  const fullPath = process.argv[3] ?? null
  if (!aiReviewPath) {
    console.error("Usage: node scripts/check-ai-review-diagnostic.js <ai-review.json> [full.json]")
    process.exit(2)
  }

  const payload = loadJson(aiReviewPath)
  const report = validateAiReviewExportPayload(payload)
  const inputBytes = fileBytes(aiReviewPath)
  const fullBytes = fullPath ? fileBytes(fullPath) : null

  const out = {
    file: aiReviewPath,
    mode: report.mode,
    schemaVersion: report.schemaVersion,
    inputBytes,
    outputBytes: report.outputBytes,
    fullInputBytes: fullBytes,
    compressionRatio:
      fullBytes != null && fullBytes > 0
        ? Math.round((report.outputBytes / fullBytes) * 1000) / 1000
        : null,
    frameSeriesRowCount: report.frameSeriesRowCount,
    columnCount: report.columnCount,
    requiredFieldsPresent: report.requiredFieldsPresent,
    missingRequiredFields: report.missingRequiredFields,
    forbiddenLargeFieldsPresent: report.forbiddenLargeFieldsPresent,
    frameSeriesBytes: report.frameSeriesBytes,
    eventSamplesBytes: report.eventSamplesBytes,
    eventSamplesLightweight: report.eventSamplesLightweight,
    eventSampleCounts: {
      jawSuspiciousFrames: payload.eventSamples?.jawSuspiciousFrames?.length ?? 0,
      highMouthScoreFrames: payload.eventSamples?.highMouthScoreFrames?.length ?? 0,
      highBrowFrames: payload.eventSamples?.highBrowFrames?.length ?? 0,
      highEyeFrames: payload.eventSamples?.highEyeFrames?.length ?? 0,
      highTrackingDeltaFrames: payload.eventSamples?.highTrackingDeltaFrames?.length ?? 0,
    },
    bindingComparisonSkippedCount: payload.summary?.bindingComparisonSkippedCount ?? null,
    bindingComparisonSkipReason: payload.summary?.bindingComparisonSkipReason ?? null,
    hasSummary: Boolean(payload.summary),
    summaryFrameCount: payload.summary?.frameCount ?? payload.frameCount ?? null,
  }

  console.log(JSON.stringify(out, null, 2))

  if (!report.requiredFieldsPresent) {
    console.error("FAIL: missing required frameSeries columns")
    process.exit(1)
  }
  if (report.forbiddenLargeFieldsPresent) {
    console.error("FAIL: ai-review export still contains forbidden large fields")
    process.exit(1)
  }
  if (!payload.frameSeries?.rows?.length) {
    console.error("FAIL: frameSeries.rows is empty")
    process.exit(1)
  }
  if (!report.eventSamplesLightweight) {
    console.error(
      `FAIL: eventSamples must be lightweight index refs (invalid group: ${report.eventSamplesInvalidGroup})`
    )
    process.exit(1)
  }
}

main()
