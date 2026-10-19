#!/usr/bin/env node
/**
 * Phase 2.5 — Mapping Gain Diagnostic 验收脚本
 *
 * Usage:
 *   node scripts/check-mapping-gain-diagnostic.js <diagnostic.json>
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

function loadJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"))
}

function main() {
  const path = process.argv[2]
  if (!path) {
    console.error("Usage: node scripts/check-mapping-gain-diagnostic.js <diagnostic.json>")
    process.exit(2)
  }

  const diagnostic = loadJson(path)
  const summary = diagnostic.summary ?? {}
  const mga = summary.mappingGainAnalysis ?? {}
  const mouth = mga.mouth ?? {}
  const jaw = mga.jaw ?? {}
  const brow = mga.brow ?? {}
  const eye = mga.eye ?? {}
  const diagnosis = summary.videoTrackingDiagnosis ?? {}
  const neutralP90 = summary.videoNeutralEffectP90 ?? {}
  const device = summary.device ?? {}

  const out = {
    file: path,
    frameCount: diagnostic.frameCount ?? summary.frameCount ?? null,
    mappingGainAnalysisPresent: Boolean(summary.mappingGainAnalysis),
    rawTrackingSignalsFrameCount: mga.rawTrackingSignalsFrameCount ?? null,
    compactFallbackMasksRaw: mga.compactFallbackMasksRaw ?? false,
    rawMouthScoreP90: mouth.rawMouthScoreP90 ?? null,
    rawMouthScoreP95: mouth.rawMouthScoreP95 ?? null,
    rawMouthScoreMax: mouth.rawMouthScoreMax ?? null,
    mouthScoreUnitScale: mouth.saturationUnitScale ?? null,
    mouthSaturationThreshold: mouth.saturationThreshold ?? null,
    faceRigMouthAbsMaxP90: mouth.faceRigMouthAbsMaxP90 ?? null,
    mouthEstimatedGain: mouth.estimatedGainRawScoreToOutput ?? null,
    blendshapeJawOpenP90: jaw.blendshapeJawOpenP90 ?? null,
    geometryJawSignalP90: jaw.geometryJawSignalP90 ?? null,
    finalJawBeforeTuningP90: jaw.finalJawBeforeTuningP90 ?? null,
    faceRigJawAbsMaxP90: jaw.faceRigJawAbsMaxP90 ?? null,
    jawEstimatedGain: jaw.estimatedGainBlendshapeToOutput ?? null,
    zeroBlendshapeJawButOutputFrameCount: jaw.zeroBlendshapeJawButOutputFrameCount ?? null,
    zeroBlendshapeJawButTunedOutputFrameCount: jaw.zeroBlendshapeJawButTunedOutputFrameCount ?? null,
    rawBrowLeftP90: brow.rawBrowLeftP90 ?? null,
    rawBrowRightP90: brow.rawBrowRightP90 ?? null,
    browInnerUpP90: brow.browInnerUpP90 ?? null,
    faceRigBrowAbsMaxP90: brow.faceRigBrowAbsMaxP90 ?? null,
    browEstimatedGain: brow.estimatedGainRawToOutput ?? null,
    eyeBlinkLeftP90: eye.eyeBlinkLeftP90 ?? null,
    eyeBlinkRightP90: eye.eyeBlinkRightP90 ?? null,
    faceRigEyeAbsMaxP90: eye.faceRigEyeAbsMaxP90 ?? null,
    eyeEstimatedGain: eye.estimatedGainBlinkToOutput ?? null,
    videoNeutralEffectP90: neutralP90.enabled
      ? {
          appliedFrameCount: neutralP90.appliedFrameCount,
          browReductionRatioP90: neutralP90.browReductionRatioP90,
          jawReductionRatioP90: neutralP90.jawReductionRatioP90,
          mouthReductionRatioP90: neutralP90.mouthReductionRatioP90,
          eyeReductionRatioP90: neutralP90.eyeReductionRatioP90,
        }
      : { enabled: false },
    likelyCauses: diagnosis.likelyCauses ?? [],
    confidence: diagnosis.confidence ?? null,
    notes: diagnosis.notes ?? [],
    previewOnly: {
      realSentFrameCount: device.realSentFrameCount ?? device.sendFrameCount ?? null,
      realTxCount: device.realTxCount ?? null,
      realBusPacketCountGlobal: device.realBusPacketCountGlobal ?? null,
    },
  }

  console.log(JSON.stringify(out, null, 2))

  const previewOk =
    (out.previewOnly.realSentFrameCount ?? 0) === 0 &&
    (out.previewOnly.realTxCount ?? 0) === 0
  if (!out.mappingGainAnalysisPresent) {
    console.error("FAIL: summary.mappingGainAnalysis missing")
    process.exit(1)
  }
  if (!previewOk) {
    console.error("WARN: video may not be preview-only (real send detected)")
  }
}

main()
