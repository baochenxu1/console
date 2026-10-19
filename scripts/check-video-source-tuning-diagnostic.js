#!/usr/bin/env node
/**
 * Phase 2.6 — Video Source Tuning diagnostic 验收脚本
 *
 * Usage:
 *   node scripts/check-video-source-tuning-diagnostic.js <diagnostic.json>
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

function loadJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"))
}

function main() {
  const path = process.argv[2]
  if (!path) {
    console.error("Usage: node scripts/check-video-source-tuning-diagnostic.js <diagnostic.json>")
    process.exit(2)
  }

  const diagnostic = loadJson(path)
  const summary = diagnostic.summary ?? {}
  const vst = summary.videoSourceTuningEffect ?? {}
  const mga = summary.mappingGainAnalysis ?? {}
  const mouth = mga.mouth ?? {}
  const device = summary.device ?? {}
  const options = diagnostic.options ?? summary.options ?? {}

  const out = {
    file: path,
    frameCount: diagnostic.frameCount ?? summary.frameCount ?? null,
    videoSourceTuningEnabled: options.videoSourceTuningEnabled ?? null,
    videoSourceTuningAppliedFrameCount: vst.appliedFrameCount ?? 0,
    videoSourceTuningEffectPresent: Boolean(summary.videoSourceTuningEffect?.enabled),

    browBeforeP90: vst.brow?.beforeP90 ?? null,
    browAfterP90: vst.brow?.afterP90 ?? null,
    browReductionRatioP90: vst.brow?.reductionRatioP90 ?? null,

    eyeBeforeP90: vst.eye?.beforeP90 ?? null,
    eyeAfterP90: vst.eye?.afterP90 ?? null,
    eyeReductionRatioP90: vst.eye?.reductionRatioP90 ?? null,

    jawBeforeP90: vst.jaw?.beforeP90 ?? null,
    jawAfterP90: vst.jaw?.afterP90 ?? null,
    blockedRawZeroFrameCount: vst.jaw?.blockedRawZeroFrameCount ?? null,
    zeroRawButOutputFrameCount: mga.jaw?.zeroRawButOutputFrameCount ?? null,

    rawMouthScoreBeforeP90: vst.mouth?.rawMouthScoreBeforeP90 ?? mouth.rawMouthScoreP90 ?? null,
    rawMouthScoreAfterP90: vst.mouth?.rawMouthScoreAfterP90 ?? null,
    mouthSaturationThreshold:
      vst.mouth?.saturationThreshold ?? mouth.saturationThreshold ?? null,
    saturatedFrameRatioBefore:
      vst.mouth?.saturatedFrameRatioBefore ?? mouth.saturatedFrameRatioLegacy ?? null,
    saturatedFrameRatioAfter:
      vst.mouth?.saturatedFrameRatioAfter ?? mouth.saturatedFrameRatio ?? null,

    likelyCauses: summary.videoTrackingDiagnosis?.likelyCauses ?? [],
    tuningNotes: summary.videoTrackingDiagnosis?.notes ?? [],

    previewOnly: {
      realSentFrameCount: device.realSentFrameCount ?? device.sendFrameCount ?? null,
      realTxCount: device.realTxCount ?? null,
      realBusPacketCount: device.realBusPacketCountGlobal ?? null,
    },
  }

  console.log(JSON.stringify(out, null, 2))

  if (!out.videoSourceTuningEffectPresent && out.videoSourceTuningEnabled !== false) {
    console.error("WARN: videoSourceTuningEffect missing (tuning may be off or no video frames)")
  }
}

main()
