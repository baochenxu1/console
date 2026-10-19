#!/usr/bin/env node
/**
 * Phase 2.2 — Video Neutral Calibration diagnostic 验收。
 *
 * Usage:
 *   node scripts/check-video-neutral-diagnostic.js path/to/tracking-diagnostic.json
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const MIN_RATIO = 0.9

function loadJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"))
}

function percentile(values, p) {
  const list = values.filter((v) => Number.isFinite(Number(v))).map(Number).sort((a, b) => a - b)
  if (!list.length) return null
  const idx = Math.min(list.length - 1, Math.max(0, Math.ceil((p / 100) * list.length) - 1))
  return list[idx]
}

function main() {
  const path = process.argv[2]
  if (!path) {
    console.error("Usage: node scripts/check-video-neutral-diagnostic.js <diagnostic.json>")
    process.exit(2)
  }

  const diagnostic = loadJson(path)
  const frames = (diagnostic.frames ?? []).filter(
    (f) => !f?.diagnostic?.isStatusFrame && !f?.diagnostic?.excludeFromSummary
  )
  const n = frames.length
  const summary = diagnostic.summary ?? {}
  const vnc = summary.videoNeutralCalibration ?? {}
  const events = diagnostic.events ?? []

  const appliedCount = frames.filter((f) => f.videoNeutral?.applied).length
  const enabledCount = frames.filter((f) => f.videoNeutral?.enabled).length
  const browRaw = frames.map((f) => f.videoNeutral?.rawSignals?.browAbsMax)
  const browNeu = frames.map((f) => f.videoNeutral?.neutralizedSignals?.browAbsMax)
  const jawRaw = frames.map((f) => f.videoNeutral?.rawSignals?.jawAbsMax)
  const jawNeu = frames.map((f) => f.videoNeutral?.neutralizedSignals?.jawAbsMax)
  const mouthRaw = frames.map((f) => f.videoNeutral?.rawSignals?.mouthAbsMax)
  const mouthNeu = frames.map((f) => f.videoNeutral?.neutralizedSignals?.mouthAbsMax)

  const stats = {
    frameCount: n,
    sourceTypeVideo: frames.filter((f) => f.inputSource?.sourceType === "video").length,
    videoNeutralCalibration: vnc,
    videoNeutralEffect: summary.videoNeutralEffect ?? {},
    neutralAppliedFrameCount: vnc.neutralAppliedFrameCount ?? appliedCount,
    neutralSkippedFrameCount: vnc.neutralSkippedFrameCount ?? 0,
    framesWithVideoNeutral: frames.filter((f) => f.videoNeutral).length,
    framesVideoNeutralApplied: appliedCount,
    framesVideoNeutralEnabled: enabledCount,
    eventTypes: [...new Set(events.map((e) => e.type))],
    realSentFrameCount: summary.realSend?.realSentFrameCount ?? summary.realSentFrameCount ?? null,
    browP90Raw: percentile(browRaw, 90),
    browP90Neutralized: percentile(browNeu, 90),
    jawP90Raw: percentile(jawRaw, 90),
    jawP90Neutralized: percentile(jawNeu, 90),
    mouthP90Raw: percentile(mouthRaw, 90),
    mouthP90Neutralized: percentile(mouthNeu, 90),
    rawTrackingSignalsFrameCount: frames.filter((f) => f.rawTrackingSignals).length,
  }

  console.log(JSON.stringify(stats, null, 2))

  const failures = []
  const need = (label, got, min = n * MIN_RATIO) => {
    if (n === 0) {
      failures.push("no frames")
      return
    }
    if (got < min) {
      failures.push(`${label}: ${got}/${n} < ${Math.ceil(min)}`)
    }
  }

  if (!vnc.enabled) failures.push("videoNeutralCalibration.enabled !== true")
  if (!vnc.calibrationId) failures.push("videoNeutralCalibration.calibrationId missing")
  if (vnc.frameIndex == null) failures.push("videoNeutralCalibration.frameIndex missing")
  if (vnc.videoTimeMs == null) failures.push("videoNeutralCalibration.videoTimeMs missing")
  if (vnc.sourceSeq == null) failures.push("videoNeutralCalibration.sourceSeq missing")

  need("framesWithVideoNeutral", stats.framesWithVideoNeutral)
  need("framesVideoNeutralApplied", stats.framesVideoNeutralApplied)
  need("rawTrackingSignals", stats.rawTrackingSignalsFrameCount)

  if (!events.some((e) => e.type === "video-neutral-set")) {
    failures.push("missing video-neutral-set event")
  }
  if (!events.some((e) => e.type === "tracking-temporal-reset")) {
    failures.push("missing tracking-temporal-reset event")
  }

  if (stats.realSentFrameCount != null && stats.realSentFrameCount > 0) {
    failures.push(`realSentFrameCount=${stats.realSentFrameCount} (expected 0)`)
  }

  if (failures.length) {
    console.error("FAIL:", failures.join("; "))
    process.exit(1)
  }
  console.log("PASS")
}

main()
