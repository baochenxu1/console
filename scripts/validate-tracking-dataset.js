#!/usr/bin/env node
/**
 * Validate tracking-dataset-v1 metadata + JSONL/JSONL.GZ (structure / coverage / timing only).
 *
 * Usage:
 *   node scripts/validate-tracking-dataset.js <metadata.json> [frames.jsonl|.jsonl.gz]
 */

import fs from "node:fs"
import path from "node:path"
import { gunzipSync } from "node:zlib"

const REQUIRED_METADATA = [
  "schemaVersion",
  "sessionId",
  "createdAt",
  "datasetType",
  "source",
  "safety",
  "trackingConfig",
  "frameSchema",
  "summary",
]

const REQUIRED_FRAME = [
  "sessionId",
  "record",
  "source",
  "sync",
  "tracking",
  "rig",
  "videoSourceTuning",
  "previewCommand",
  "quality",
]

const REQUIRED_RECORD = ["recordFrameIndex", "recordSeq", "recordTimeMs"]

const REQUIRED_SOURCE = ["sourceType", "sourceSeq", "sourceFrameIndex", "frameIndex"]

const REQUIRED_SYNC = [
  "timebase",
  "syncGroupId",
  "pairingKey",
  "frontendReceiveTimeMs",
  "appendSendTimeMs",
  "appendServerReceiveTimeMs",
]

const REQUIRED_NESTED = [
  "tracking.rawTrackingSignals.mouth.rawMouthScore",
  "tracking.rawTrackingSignals.mouth.scenario",
  "tracking.rawTrackingSignals.brow.rawBrowLeft",
  "tracking.rawTrackingSignals.brow.rawBrowRight",
  "tracking.rawTrackingSignals.brow.gateAction",
  "tracking.rawTrackingSignals.jaw.blendshapeJawOpen",
  "tracking.rawTrackingSignals.jaw.geometryJawSignal",
  "tracking.rawTrackingSignals.jaw.finalBeforeTuning",
  "tracking.rawTrackingSignals.jaw.finalAfterTuning",
  "tracking.rawTrackingSignals.jaw.jawOutputSource",
  "rig.untuned.browAbsMax",
  "rig.untuned.eyeAbsMax",
  "rig.untuned.jawAbsMax",
  "rig.untuned.mouthAbsMax",
  "rig.tuned.browAbsMax",
  "rig.tuned.eyeAbsMax",
  "rig.tuned.jawAbsMax",
  "rig.tuned.mouthAbsMax",
  "videoSourceTuning.enabled",
  "videoSourceTuning.applied",
  "videoSourceTuning.jaw.geometryGateApplied",
  "videoSourceTuning.jaw.geometryGateReason",
  "videoSourceTuning.mouth.rawMouthScoreBefore",
  "videoSourceTuning.mouth.rawMouthScoreAfter",
  "previewCommand.previewOnly",
  "previewCommand.driveSent",
  "previewCommand.finalServoOutputCount",
  "quality.faceCoverageRatio",
  "quality.inferenceInputFaceCoverageRatio",
  "quality.roiEnabled",
]

const VIDEO_LIKE_SOURCE_TYPES = new Set(["video", "uploaded-video"])
const CAMERA_SOURCE_TYPE = "camera"

function isCameraDataset(meta, frame) {
  const dt = meta?.datasetType ?? ""
  if (dt === "camera-tracking-reference") return true
  const srcType = frame?.source?.sourceType ?? meta?.source?.sourceType
  return srcType === CAMERA_SOURCE_TYPE
}

function getPath(obj, dotted) {
  return dotted.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj)
}

function fail(msg) {
  console.error(`FAIL: ${msg}`)
  process.exitCode = 1
}

function warn(msg) {
  console.warn(`WARN: ${msg}`)
}

function ok(msg) {
  console.log(`OK: ${msg}`)
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function resolveFramesPath(metaPath, meta, explicitPath) {
  if (explicitPath) return explicitPath
  const dir = path.dirname(metaPath)
  const sid = meta.sessionId
  const compression = meta.frameSchema?.compression || meta.exportCompression
  const gz = path.join(dir, `${sid}.frames.jsonl.gz`)
  const plain = path.join(dir, `${sid}.frames.jsonl`)
  if (compression === "gzip" && fs.existsSync(gz)) return gz
  if (fs.existsSync(gz)) return gz
  if (fs.existsSync(plain)) return plain
  return gz
}

function readFramesText(framesPath, meta) {
  const buf = fs.readFileSync(framesPath)
  const compressed =
    framesPath.endsWith(".gz") ||
    meta.frameSchema?.compression === "gzip" ||
    meta.exportCompression === "gzip"
  if (compressed) {
    return gunzipSync(buf).toString("utf8")
  }
  return buf.toString("utf8")
}

function validateMetadata(metaPath) {
  const meta = readJson(metaPath)
  if (meta.schemaVersion !== "tracking-dataset-v1") {
    fail(`schemaVersion must be tracking-dataset-v1, got ${meta.schemaVersion}`)
  }
  for (const key of REQUIRED_METADATA) {
    if (!(key in meta)) fail(`metadata missing ${key}`)
  }
  const summaryCount = meta.summary?.frameCount
  if (!Number.isFinite(Number(summaryCount))) {
    fail("metadata.summary.frameCount must be a number")
  }
  if (meta.safety?.previewOnlyForced !== true) {
    fail("metadata.safety.previewOnlyForced must be true")
  }
  if (meta.safety?.realDeviceSendAllowed !== false) {
    fail("metadata.safety.realDeviceSendAllowed must be false")
  }
  if (meta.datasetType === "camera-tracking-reference") {
    if (meta.source?.sourceType !== "camera") {
      fail("camera-tracking-reference metadata.source.sourceType must be camera")
    }
    if (meta.trackingConfig?.videoSourceTuningEnabled === true) {
      fail("camera dataset trackingConfig.videoSourceTuningEnabled must be false")
    }
    for (const key of ["cameraId", "cameraIndex", "cameraLabel"]) {
      if (meta.source?.[key] == null) {
        fail(`camera dataset metadata.source missing ${key}`)
      }
    }
  }
  if (meta.frameSchema?.chunked === true) {
    fail("frameSchema.chunked must be false in current phase")
  }
  ok(`metadata sessionId=${meta.sessionId} frameCount=${summaryCount}`)
  return meta
}

function validateFrames(framesPath, meta) {
  const text = readFramesText(framesPath, meta)
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  const report = {
    valid: process.exitCode !== 1,
    sessionId: meta.sessionId,
    frameCount: Number(meta.summary?.frameCount),
    jsonlLineCount: lines.length,
    framesPath: framesPath,
    compression: meta.frameSchema?.compression || meta.exportCompression || "none",
    recordFrameIndexContinuous: true,
    sourceSeqMonotonic: true,
    videoTimeMsMonotonic: true,
    sourceEpochConsistent: true,
    requiredFieldsPresent: true,
    missingRequiredFields: [],
    previewOnlyFrameCount: 0,
    driveSentFrameCount: 0,
    safetyOk: true,
    syncFieldsPresent: true,
    mediaTimeMatchesVideoTime: true,
    appendServerReceiveTimeMsMonotonic: true,
    syncGroupConsistent: true,
    warnings: [],
  }

  let lineNo = 0
  let firstEpoch = null
  let prevRecordFrameIndex = null
  let prevSourceSeq = null
  let prevVideoTimeMs = null
  let prevSourceFrameIndex = null
  let prevAppendServerMs = null
  let firstSyncGroupId = null
  const missingSet = new Set()

  for (const line of lines) {
    lineNo += 1
    let frame
    try {
      frame = JSON.parse(line)
    } catch (err) {
      fail(`frames line ${lineNo} invalid JSON: ${err.message}`)
      report.valid = false
      continue
    }

    for (const key of REQUIRED_FRAME) {
      if (!(key in frame)) {
        fail(`line ${lineNo} missing ${key}`)
        report.valid = false
      }
    }
    for (const key of REQUIRED_RECORD) {
      if (!(key in (frame.record || {}))) {
        fail(`line ${lineNo} record missing ${key}`)
        report.valid = false
      }
    }
    for (const key of REQUIRED_SOURCE) {
      if (!(key in (frame.source || {}))) {
        fail(`line ${lineNo} source missing ${key}`)
        report.valid = false
      }
    }
    for (const key of REQUIRED_SYNC) {
      if (frame.sync?.[key] == null) {
        missingSet.add(`sync.${key}`)
        report.syncFieldsPresent = false
      }
    }

    for (const dotted of REQUIRED_NESTED) {
      if (getPath(frame, dotted) == null) {
        missingSet.add(dotted)
        report.requiredFieldsPresent = false
      }
    }

    if (frame.sessionId !== meta.sessionId) {
      fail(`line ${lineNo} sessionId mismatch`)
      report.valid = false
    }

    const epoch = frame.source?.sourceEpoch
    if (epoch == null) {
      fail(`line ${lineNo} missing source.sourceEpoch`)
      report.valid = false
    } else if (firstEpoch == null) {
      firstEpoch = epoch
    } else if (epoch !== firstEpoch) {
      fail(`line ${lineNo} sourceEpoch ${epoch} != ${firstEpoch}`)
      report.sourceEpochConsistent = false
      report.valid = false
    }

    const syncGroupId = frame.sync?.syncGroupId
    if (syncGroupId) {
      if (firstSyncGroupId == null) firstSyncGroupId = syncGroupId
      else if (syncGroupId !== firstSyncGroupId) {
        fail(`line ${lineNo} sync.syncGroupId mismatch`)
        report.syncGroupConsistent = false
        report.valid = false
      }
    }
    if (frame.sync?.timebase !== "monotonic-ms") {
      fail(`line ${lineNo} sync.timebase must be monotonic-ms`)
      report.valid = false
    }
    if (!frame.sync?.pairingKey) {
      fail(`line ${lineNo} sync.pairingKey empty`)
      report.valid = false
    }

    const mediaTime = frame.sync?.mediaTimeMs
    const videoTime = frame.source?.videoTimeMs
    if (
      VIDEO_LIKE_SOURCE_TYPES.has(frame.source?.sourceType ?? meta.source?.sourceType) &&
      mediaTime != null &&
      videoTime != null &&
      Math.abs(Number(mediaTime) - Number(videoTime)) > 0.5
    ) {
      fail(`line ${lineNo} sync.mediaTimeMs != source.videoTimeMs`)
      report.mediaTimeMatchesVideoTime = false
      report.valid = false
    }

    const appendServerMs = frame.sync?.appendServerReceiveTimeMs
    if (appendServerMs != null) {
      if (prevAppendServerMs != null && Number(appendServerMs) < Number(prevAppendServerMs)) {
        fail(`line ${lineNo} sync.appendServerReceiveTimeMs not monotonic`)
        report.appendServerReceiveTimeMsMonotonic = false
        report.valid = false
      }
      prevAppendServerMs = appendServerMs
    }

    const recordFrameIndex = frame.record?.recordFrameIndex
    const recordSeq = frame.record?.recordSeq
    if (prevRecordFrameIndex == null) {
      if (recordFrameIndex !== 0) {
        fail(`line ${lineNo} record.recordFrameIndex must start at 0`)
        report.recordFrameIndexContinuous = false
        report.valid = false
      }
      if (recordSeq !== 1) {
        fail(`line ${lineNo} record.recordSeq must start at 1`)
        report.recordFrameIndexContinuous = false
        report.valid = false
      }
    } else if (recordFrameIndex !== prevRecordFrameIndex + 1) {
      fail(
        `line ${lineNo} record.recordFrameIndex ${recordFrameIndex} != ${prevRecordFrameIndex + 1}`
      )
      report.recordFrameIndexContinuous = false
      report.valid = false
    } else if (recordSeq !== prevRecordFrameIndex + 2) {
      fail(`line ${lineNo} record.recordSeq must equal recordFrameIndex + 1`)
      report.recordFrameIndexContinuous = false
      report.valid = false
    }
    prevRecordFrameIndex = recordFrameIndex

    const sourceSeq = frame.source?.sourceSeq
    if (sourceSeq != null && prevSourceSeq != null && Number(sourceSeq) <= Number(prevSourceSeq)) {
      fail(`line ${lineNo} source.sourceSeq not monotonic (${prevSourceSeq} -> ${sourceSeq})`)
      report.sourceSeqMonotonic = false
      report.valid = false
    }
    prevSourceSeq = sourceSeq

    const videoTimeMs = frame.source?.videoTimeMs
    if (
      videoTimeMs != null &&
      prevVideoTimeMs != null &&
      Number(videoTimeMs) < Number(prevVideoTimeMs)
    ) {
      fail(
        `line ${lineNo} source.videoTimeMs not monotonic (${prevVideoTimeMs} -> ${videoTimeMs})`
      )
      report.videoTimeMsMonotonic = false
      report.valid = false
    }
    if (videoTimeMs != null) prevVideoTimeMs = videoTimeMs

    const sourceFrameIndex = frame.source?.sourceFrameIndex
    if (
      sourceFrameIndex != null &&
      prevSourceFrameIndex != null &&
      Number(sourceFrameIndex) === Number(prevSourceFrameIndex) &&
      videoTimeMs != null &&
      prevVideoTimeMs != null &&
      Number(videoTimeMs) > Number(prevVideoTimeMs)
    ) {
      warn(
        `line ${lineNo} source.sourceFrameIndex repeated (${sourceFrameIndex}) while videoTimeMs advanced`
      )
      report.warnings.push(`line ${lineNo}: duplicate sourceFrameIndex with advancing videoTimeMs`)
    }
    if (sourceFrameIndex != null) prevSourceFrameIndex = sourceFrameIndex

    const srcType = frame.source?.sourceType ?? meta.source?.sourceType
    const cameraDataset = isCameraDataset(meta, frame)
    if (VIDEO_LIKE_SOURCE_TYPES.has(srcType)) {
      if (frame.previewCommand?.previewOnly !== true) {
        fail(`line ${lineNo} video-like frame previewCommand.previewOnly must be true`)
        report.valid = false
      } else {
        report.previewOnlyFrameCount += 1
      }
    }
    if (cameraDataset) {
      if (frame.videoSourceTuning?.applied === true) {
        fail(`line ${lineNo} camera frame videoSourceTuning.applied must be false`)
        report.valid = false
      }
      if (frame.source?.videoTimeMs != null) {
        warn(`line ${lineNo} camera frame source.videoTimeMs should be null`)
        report.warnings.push(`line ${lineNo}: camera source.videoTimeMs not null`)
      }
    }
    if (frame.previewCommand?.driveSent === true) {
      report.driveSentFrameCount += 1
    }
  }

  report.missingRequiredFields = [...missingSet].sort()
  if (report.missingRequiredFields.length) {
    fail(`missing required nested fields: ${report.missingRequiredFields.join(", ")}`)
    report.valid = false
  }

  if (lines.length !== Number(meta.summary.frameCount)) {
    fail(`frameCount mismatch: metadata=${meta.summary.frameCount} jsonl=${lines.length}`)
    report.valid = false
  } else {
    ok(`frames ${lines.length} lines parsed (${report.compression})`)
  }

  report.safetyOk =
    (meta.safety?.realSentFrameCount ?? 0) === 0 &&
    (meta.safety?.realTxCount ?? 0) === 0 &&
    (meta.safety?.realBusPacketCount ?? 0) === 0 &&
    report.driveSentFrameCount === 0

  report.valid = report.valid && process.exitCode !== 1
  return report
}

function main() {
  const metaPath = process.argv[2]
  if (!metaPath) {
    console.error(
      "Usage: node scripts/validate-tracking-dataset.js <metadata.json> [frames.jsonl|.jsonl.gz]"
    )
    process.exit(1)
  }
  const meta = validateMetadata(metaPath)
  const framesPath = resolveFramesPath(metaPath, meta, process.argv[3])
  if (!fs.existsSync(framesPath)) {
    fail(`frames file not found: ${framesPath}`)
    return
  }
  const report = validateFrames(framesPath, meta)
  console.log(JSON.stringify(report, null, 2))
  if (process.exitCode) {
    console.error("Validation failed.")
  } else {
    console.log("Validation passed.")
  }
}

main()
