/**
 * Phase 2.2 — Video Manual Neutral Frame / Calibration Snapshot
 * 浏览器侧 video neutral：快照保存 + rig 相对校准（不修改 Python mapping 参数）。
 */

import { createInitialEliteRig } from "../../core/faceDofMapper.js"
import { summarizeRigChannels } from "../trackingPreview/deviceDriveDiagnostics.js"
import { resetTrackingEyeReleaseState } from "./trackingCalibration.js"

/** @typedef {{ px?: number, py?: number, x?: number, y?: number, z?: number }} LandmarkPoint */
/** @typedef {{ centerXPx?: number, centerYPx?: number, widthPx?: number, heightPx?: number, width?: number, height?: number }} FaceBox */

const RAW_BLENDSHAPE_KEYS = [
  "jawOpen",
  "mouthClose",
  "mouthFunnel",
  "mouthPucker",
  "mouthSmileLeft",
  "mouthSmileRight",
  "browInnerUp",
  "browDownLeft",
  "browDownRight",
  "eyeBlinkLeft",
  "eyeBlinkRight",
  "eyeWideLeft",
  "eyeWideRight",
]

function num(v, fallback = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function roundNum(v, digits = 4) {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  const f = 10 ** digits
  return Math.round(n * f) / f
}

function cloneRig(rig) {
  if (!rig || typeof rig !== "object") {
    return createInitialEliteRig()
  }
  return JSON.parse(JSON.stringify(rig))
}

function subVal(a, b) {
  return num(a) - num(b)
}

function subSide(side, base) {
  if (!side || typeof side !== "object") {
    return side
  }
  const b = base && typeof base === "object" ? base : {}
  const x = subVal(side.x ?? 0, b.x ?? 0)
  const y = subVal(side.y ?? 0, b.y ?? 0)
  const tipA = subVal(side.tipA ?? side.tip, b.tipA ?? b.tip)
  const tipB = subVal(side.tipB ?? 0, b.tipB ?? 0)
  return {
    x,
    y,
    tipA,
    tipB,
    tip: tipA,
    mid: subVal(side.mid, b.mid),
    tail: subVal(side.tail, b.tail),
  }
}

function subMouthCorner(corner, base) {
  if (!corner || typeof corner !== "object") {
    return corner
  }
  const b = base && typeof base === "object" ? base : {}
  return {
    x: subVal(corner.x, b.x),
    y: subVal(corner.y, b.y),
  }
}

/** rig 通道相对 neutral baseline 做减法。 */
export function subtractRigBaseline(rig, baseline) {
  const r = rig || {}
  const b = baseline || createInitialEliteRig()
  const sharedX = subVal(r.sharedRadar?.x, b.sharedRadar?.x)
  const sharedY = subVal(r.sharedRadar?.y, b.sharedRadar?.y)
  const out = {
    ...r,
    browL: subSide(r.browL, b.browL),
    browR: subSide(r.browR, b.browR),
    eyeL: {
      up: subVal(r.eyeL?.up, b.eyeL?.up),
      lo: subVal(r.eyeL?.lo, b.eyeL?.lo),
      x: subVal(r.eyeL?.x ?? r.sharedRadar?.x, b.eyeL?.x ?? b.sharedRadar?.x),
      y: subVal(r.eyeL?.y ?? r.sharedRadar?.y, b.eyeL?.y ?? b.sharedRadar?.y),
    },
    eyeR: {
      up: subVal(r.eyeR?.up, b.eyeR?.up),
      lo: subVal(r.eyeR?.lo, b.eyeR?.lo),
      x: subVal(r.eyeR?.x ?? r.sharedRadar?.x, b.eyeR?.x ?? b.sharedRadar?.x),
      y: subVal(r.eyeR?.y ?? r.sharedRadar?.y, b.eyeR?.y ?? b.sharedRadar?.y),
    },
    mouth: {
      UL: subVal(r.mouth?.UL, b.mouth?.UL),
      UR: subVal(r.mouth?.UR, b.mouth?.UR),
      LL: subVal(r.mouth?.LL, b.mouth?.LL),
      LR: subVal(r.mouth?.LR, b.mouth?.LR),
      sideL: subMouthCorner(r.mouth?.sideL, b.mouth?.sideL),
      sideR: subMouthCorner(r.mouth?.sideR, b.mouth?.sideR),
    },
    jaw: {
      val: subVal(r.jaw?.val, b.jaw?.val),
      lateral: subVal(r.jaw?.lateral ?? 0, b.jaw?.lateral ?? 0),
    },
    tongue: { val: 0 },
    noseL: { val: subVal(r.noseL?.val ?? 0, b.noseL?.val ?? 0) },
    noseR: { val: subVal(r.noseR?.val ?? 0, b.noseR?.val ?? 0) },
    sharedRadar: {
      x: sharedX,
      y: sharedY,
    },
  }
  // 共享 gaze 中性校准后仍镜像到双眼（Tracking 本阶段）
  out.eyeL = { ...out.eyeL, x: sharedX, y: sharedY }
  out.eyeR = { ...out.eyeR, x: sharedX, y: sharedY }
  return out
}

export function pickRawBlendshapeSignals(blendshapes) {
  if (!blendshapes || typeof blendshapes !== "object") {
    return null
  }
  const out = {}
  for (const k of RAW_BLENDSHAPE_KEYS) {
    if (blendshapes[k] != null && Number.isFinite(Number(blendshapes[k]))) {
      out[k] = roundNum(blendshapes[k], 4)
    }
  }
  return Object.keys(out).length ? out : null
}

export function extractRawSignalsFromFrame(frame) {
  const dbg = frame?.debug
  const blend = pickRawBlendshapeSignals(dbg?.blendshapes)
  const mapping = dbg?.mapping
  const lip = dbg?.lipGeometry
  const jaw = dbg?.jawGeometry
  const brow = dbg?.browGate
  const mouthDbg = dbg?.mouthDebug || lip?.mouthDebug

  const rawSignals = {}
  if (blend) {
    rawSignals.jawOpen = blend.jawOpen
    rawSignals.mouthClose = blend.mouthClose
    rawSignals.mouthFunnel = blend.mouthFunnel
    rawSignals.mouthPucker = blend.mouthPucker
    rawSignals.mouthSmileLeft = blend.mouthSmileLeft
    rawSignals.mouthSmileRight = blend.mouthSmileRight
    rawSignals.browInnerUp = blend.browInnerUp
    rawSignals.browDownLeft = blend.browDownLeft
    rawSignals.browDownRight = blend.browDownRight
    rawSignals.eyeBlinkLeft = blend.eyeBlinkLeft
    rawSignals.eyeBlinkRight = blend.eyeBlinkRight
    rawSignals.eyeWideLeft = blend.eyeWideLeft
    rawSignals.eyeWideRight = blend.eyeWideRight
  }

  return {
    blendshapes: blend,
    rawSignals: Object.keys(rawSignals).length ? rawSignals : null,
    mapping: mapping && typeof mapping === "object" ? { ...mapping } : null,
  }
}

export function canSetNeutralFromFrame(lastFrame, videoFrameDebug) {
  if (!lastFrame || typeof lastFrame !== "object") {
    return { ok: false, reason: "no-frame" }
  }
  const src = lastFrame.debug?.inputSource
  if (src?.sourceType !== "video") {
    return { ok: false, reason: "not-video" }
  }
  if (!lastFrame.faceDetected) {
    return { ok: false, reason: "no-face" }
  }
  const td = lastFrame.debug?.trackingDebug
  if (!td?.selectedLandmarks || typeof td.selectedLandmarks !== "object") {
    return { ok: false, reason: "no-selected-landmarks" }
  }
  if (!td.fullFaceBox || typeof td.fullFaceBox !== "object") {
    return { ok: false, reason: "no-full-face-box" }
  }
  if (!videoFrameDebug || typeof videoFrameDebug !== "object") {
    return { ok: false, reason: "no-video-frame-debug" }
  }
  return { ok: true, reason: null }
}

/**
 * @param {import("./trackingTypes.js").RigFrame} lastFrame
 * @param {object | null} videoFrameDebug
 */
export function buildVideoNeutralSnapshot(lastFrame, videoFrameDebug) {
  const check = canSetNeutralFromFrame(lastFrame, videoFrameDebug)
  if (!check.ok) {
    return null
  }
  const src = lastFrame.debug.inputSource
  const td = lastFrame.debug.trackingDebug
  const extracted = extractRawSignalsFromFrame(lastFrame)
  const calibrationId =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `vn-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

  return {
    calibrationId,
    createdAt: new Date().toISOString(),
    sourceType: "video",
    sourceId: String(src.sourceId ?? ""),
    sourceSeq: num(src.sourceSeq, num(lastFrame.frameSeq)),
    frameIndex: num(src.frameIndex),
    videoTimeMs: num(src.videoTimeMs, num(src.timestampMs)),
    timestampMs: num(src.timestampMs, num(lastFrame.timestampMs)),
    seekEpoch: src.seekEpoch != null ? num(src.seekEpoch) : undefined,
    faceDetected: true,
    facePresenceConfidence:
      td.facePresenceConfidence != null ? num(td.facePresenceConfidence) : num(lastFrame.quality),
    frameWidth: num(td.frameWidth),
    frameHeight: num(td.frameHeight),
    selectedLandmarks: { ...td.selectedLandmarks },
    selectedFeatureBox: td.selectedFeatureBox
      ? { ...td.selectedFeatureBox }
      : td.faceBox
        ? { ...td.faceBox }
        : undefined,
    fullFaceBox: td.fullFaceBox ? { ...td.fullFaceBox } : undefined,
    faceSize: td.faceSize ? { ...td.faceSize } : undefined,
    headMotion: td.headMotion ? { ...td.headMotion } : undefined,
    blendshapes: extracted.blendshapes ?? undefined,
    rawSignals: extracted.rawSignals ?? undefined,
    rigBaseline: cloneRig(lastFrame.rig),
    mappingBaseline: extracted.mapping ?? undefined,
    videoFrameDebug: videoFrameDebug ? { ...videoFrameDebug } : undefined,
  }
}

export function resolveVideoNeutralApply(frame, snapshot, enabled) {
  if (!enabled) {
    return { applied: false, skipReason: "disabled" }
  }
  if (!snapshot) {
    return { applied: false, skipReason: "not-configured" }
  }
  const src = frame?.debug?.inputSource
  if (!src || src.sourceType !== "video") {
    return { applied: false, skipReason: "not-video" }
  }
  if (String(src.sourceId ?? "") !== String(snapshot.sourceId ?? "")) {
    return { applied: false, skipReason: "source-id-mismatch" }
  }
  if (!frame.faceDetected) {
    return { applied: false, skipReason: "no-face" }
  }
  return { applied: true, skipReason: null }
}

/** 对 RigFrame 应用 video neutral（rig 相对 baseline）。 */
export function applyVideoNeutralToFrame(frame, snapshot, enabled) {
  const apply = resolveVideoNeutralApply(frame, snapshot, enabled)
  if (!apply.applied) {
    return { frame, ...apply, rawRig: frame?.rig, neutralizedRig: frame?.rig }
  }
  const rawRig = frame.rig || createInitialEliteRig()
  const neutralizedRig = subtractRigBaseline(rawRig, snapshot.rigBaseline)
  return {
    frame: {
      ...frame,
      rig: neutralizedRig,
      debug: {
        ...(frame.debug || {}),
        videoNeutralApply: {
          calibrationId: snapshot.calibrationId,
          basis: "rig-baseline-subtract",
        },
      },
    },
    applied: true,
    skipReason: null,
    rawRig,
    neutralizedRig,
  }
}

export function buildVideoNeutralFrameDiagnostic(frame, snapshot, enabled, applyResult) {
  const rawRig = applyResult?.rawRig ?? frame?.rig
  const neutralizedRig = applyResult?.neutralizedRig ?? frame?.rig
  const rawSignals = summarizeRigChannels(rawRig)
  const neutralizedSignals = summarizeRigChannels(neutralizedRig)
  const hasSnapshot = Boolean(snapshot)
  const enabledFlag = Boolean(enabled && hasSnapshot)

  return {
    enabled: enabledFlag,
    applied: Boolean(applyResult?.applied),
    calibrationId: snapshot?.calibrationId,
    neutralSourceId: snapshot?.sourceId,
    neutralFrameIndex: snapshot?.frameIndex,
    neutralVideoTimeMs: snapshot?.videoTimeMs,
    neutralSourceSeq: snapshot?.sourceSeq,
    skipReason: applyResult?.skipReason ?? (enabledFlag ? null : enabled ? "not-configured" : "disabled"),
    rawSignals,
    neutralizedSignals,
    deltas: {
      browDeltaAbsMax: roundNum(rawSignals.browAbsMax - neutralizedSignals.browAbsMax, 3),
      jawDeltaAbsMax: roundNum(rawSignals.jawAbsMax - neutralizedSignals.jawAbsMax, 3),
      mouthDeltaAbsMax: roundNum(rawSignals.mouthAbsMax - neutralizedSignals.mouthAbsMax, 3),
      eyeBlinkDeltaAbsMax: roundNum(rawSignals.eyeAbsMax - neutralizedSignals.eyeAbsMax, 3),
    },
  }
}

export function buildRawTrackingSignals(lastFrame, videoNeutralDiag = null) {
  const dbg = lastFrame?.debug
  if (!dbg) return null
  const blend = pickRawBlendshapeSignals(dbg.blendshapes)
  const lip = dbg.lipGeometry
  const jaw = dbg.jawGeometry
  const brow = dbg.browGate
  const mouthDbg = dbg.mouthDebug || lip?.mouthDebug
  const mapping = dbg.mapping

  const out = {}

  if (blend) {
    out.blendshapes = blend
  }

  const mouth = {}
  const rawMouthScore =
    mouthDbg?.rawMouthScore ??
    lip?.rawMouthScore ??
    mapping?.mouthPucker ??
    mapping?.mouthSmileLeft
  if (rawMouthScore != null && Number.isFinite(Number(rawMouthScore))) {
    mouth.rawMouthScore = roundNum(rawMouthScore, 4)
  }
  const mouthOpenRatio = lip?.mouthOpenRatio ?? mouthDbg?.mouthOpenRatio
  if (mouthOpenRatio != null && Number.isFinite(Number(mouthOpenRatio))) {
    mouth.mouthOpenRatio = roundNum(mouthOpenRatio, 4)
  }
  const td = dbg.trackingDebug
  if (td?.faceSize?.mouthWidthPx != null) {
    mouth.mouthWidthPx = roundNum(td.faceSize.mouthWidthPx, 2)
  }
  const scenario =
    dbg.mouthScenarioClassifier?.finalScenario ??
    dbg.mouthScenarioClassifier?.scenario ??
    lip?.mouthScenario
  if (scenario) {
    mouth.scenario = String(scenario)
  }
  if (Object.keys(mouth).length) {
    out.mouth = mouth
  }

  const browOut = {}
  if (brow?.rawBrowLeft != null) browOut.rawBrowLeft = roundNum(brow.rawBrowLeft, 3)
  if (brow?.rawBrowRight != null) browOut.rawBrowRight = roundNum(brow.rawBrowRight, 3)
  if (mapping?.browLeft != null && browOut.rawBrowLeft == null) {
    browOut.rawBrowLeft = roundNum(mapping.browLeft, 3)
  }
  if (mapping?.browRight != null && browOut.rawBrowRight == null) {
    browOut.rawBrowRight = roundNum(mapping.browRight, 3)
  }
  if (brow?.gateAction) browOut.gateAction = String(brow.gateAction)
  if (brow?.suppressed != null) browOut.suppressed = Boolean(brow.suppressed)
  if (Object.keys(browOut).length) {
    out.brow = browOut
  }

  const jawOut = {}
  if (blend?.jawOpen != null && Number.isFinite(Number(blend.jawOpen))) {
    jawOut.blendshapeJawOpen = roundNum(blend.jawOpen, 4)
  }
  if (videoNeutralDiag?.neutralizedSignals?.jawAbsMax != null) {
    jawOut.neutralizedJawOpen = roundNum(videoNeutralDiag.neutralizedSignals.jawAbsMax, 3)
  }
  if (Object.keys(jawOut).length) {
    out.jaw = jawOut
  }

  return Object.keys(out).length ? out : null
}

export function createVideoNeutralSetEvent(snapshot) {
  if (!snapshot) return null
  return {
    type: "video-neutral-set",
    calibrationId: snapshot.calibrationId,
    sourceId: snapshot.sourceId,
    sourceSeq: snapshot.sourceSeq,
    frameIndex: snapshot.frameIndex,
    videoTimeMs: snapshot.videoTimeMs,
    facePresenceConfidence: snapshot.facePresenceConfidence,
    fullFaceBoxAreaRatio: snapshot.faceSize?.fullFaceBoxAreaRatio,
    headMotion: snapshot.headMotion ?? null,
  }
}

export function createVideoNeutralClearedEvent(calibrationId) {
  return {
    type: "video-neutral-cleared",
    calibrationId: calibrationId ?? null,
  }
}

export function createTrackingTemporalResetEvent({ reason, calibrationId, resetModules }) {
  return {
    type: "tracking-temporal-reset",
    reason: reason ?? "unknown",
    calibrationId: calibrationId ?? null,
    resetModules: Array.isArray(resetModules) ? resetModules : [],
  }
}

/**
 * best-effort 重置 JS 侧 temporal 状态（video neutral set/clear）。
 * @param {object} ctx
 */
export function resetTrackingTemporalState(ctx = {}) {
  const resetModules = []
  const { calibrationRef, prevCalibratedRef } = ctx

  if (calibrationRef?.current) {
    resetTrackingEyeReleaseState(calibrationRef.current)
    resetModules.push(
      "mouthSmooth",
      "jawSmooth",
      "browGate",
      "eyeStabilizer",
      "mouthScenario",
      "openCloseGuard"
    )
  }
  if (prevCalibratedRef) {
    prevCalibratedRef.current = null
    resetModules.push("previousFrameMotionCache")
  }

  return createTrackingTemporalResetEvent({
    reason: ctx.reason ?? "video-neutral-set",
    calibrationId: ctx.calibrationId ?? null,
    resetModules,
  })
}

export function buildVideoNeutralCalibrationSummary(snapshot, enabled, frameDiagnostics = []) {
  const applied = frameDiagnostics.filter((d) => d?.applied)
  const skipped = frameDiagnostics.filter((d) => d && !d.applied && d.enabled)
  const skipReasonCounts = {}
  for (const d of skipped) {
    const r = d.skipReason || "unknown"
    skipReasonCounts[r] = (skipReasonCounts[r] || 0) + 1
  }

  if (!snapshot) {
    return {
      enabled: false,
      neutralAppliedFrameCount: 0,
      neutralSkippedFrameCount: 0,
      neutralSkipReasonCounts: skipReasonCounts,
      resetEventCount: 0,
    }
  }

  return {
    enabled: Boolean(enabled),
    calibrationId: snapshot.calibrationId,
    sourceId: snapshot.sourceId,
    frameIndex: snapshot.frameIndex,
    videoTimeMs: snapshot.videoTimeMs,
    sourceSeq: snapshot.sourceSeq,
    seekEpoch: snapshot.seekEpoch,
    facePresenceConfidence: snapshot.facePresenceConfidence,
    fullFaceBoxAreaRatio: snapshot.faceSize?.fullFaceBoxAreaRatio,
    selectedFeatureBoxAreaRatio: snapshot.faceSize?.selectedFeatureBoxAreaRatio,
    eyeDistancePx: snapshot.faceSize?.eyeDistancePx,
    mouthWidthPx: snapshot.faceSize?.mouthWidthPx,
    headMotion: snapshot.headMotion ?? null,
    neutralAppliedFrameCount: applied.length,
    neutralSkippedFrameCount: skipped.length,
    neutralSkipReasonCounts: skipReasonCounts,
    resetEventCount: 0,
  }
}

function minMaxAvg(values) {
  const list = values.filter((v) => Number.isFinite(Number(v))).map(Number)
  if (!list.length) return null
  const min = Math.min(...list)
  const max = Math.max(...list)
  const avg = list.reduce((a, b) => a + b, 0) / list.length
  return { min: roundNum(min, 3), max: roundNum(max, 3), avg: roundNum(avg, 3) }
}

function reductionRatio(rawAvg, neutralAvg) {
  if (rawAvg == null || neutralAvg == null || rawAvg <= 0) return null
  return roundNum(1 - neutralAvg / rawAvg, 4)
}

export function buildVideoNeutralEffectSummary(frameDiagnostics = []) {
  const applied = frameDiagnostics.filter((d) => d?.applied)
  if (!applied.length) {
    return {}
  }
  const browRaw = applied.map((d) => d.rawSignals?.browAbsMax)
  const browNeu = applied.map((d) => d.neutralizedSignals?.browAbsMax)
  const jawRaw = applied.map((d) => d.rawSignals?.jawAbsMax)
  const jawNeu = applied.map((d) => d.neutralizedSignals?.jawAbsMax)
  const mouthRaw = applied.map((d) => d.rawSignals?.mouthAbsMax)
  const mouthNeu = applied.map((d) => d.neutralizedSignals?.mouthAbsMax)
  const eyeRaw = applied.map((d) => d.rawSignals?.eyeAbsMax)
  const eyeNeu = applied.map((d) => d.neutralizedSignals?.eyeAbsMax)

  const browRawStats = minMaxAvg(browRaw)
  const browNeuStats = minMaxAvg(browNeu)
  const jawRawStats = minMaxAvg(jawRaw)
  const jawNeuStats = minMaxAvg(jawNeu)
  const mouthRawStats = minMaxAvg(mouthRaw)
  const mouthNeuStats = minMaxAvg(mouthNeu)
  const eyeRawStats = minMaxAvg(eyeRaw)
  const eyeNeuStats = minMaxAvg(eyeNeu)

  return {
    ...(browRawStats
      ? {
          browRawAbsMaxMinMaxAvg: browRawStats,
          browNeutralizedAbsMaxMinMaxAvg: browNeuStats,
          browReductionRatio: reductionRatio(browRawStats.avg, browNeuStats?.avg),
        }
      : {}),
    ...(jawRawStats
      ? {
          jawRawAbsMaxMinMaxAvg: jawRawStats,
          jawNeutralizedAbsMaxMinMaxAvg: jawNeuStats,
          jawReductionRatio: reductionRatio(jawRawStats.avg, jawNeuStats?.avg),
        }
      : {}),
    ...(mouthRawStats
      ? {
          mouthRawAbsMaxMinMaxAvg: mouthRawStats,
          mouthNeutralizedAbsMaxMinMaxAvg: mouthNeuStats,
          mouthReductionRatio: reductionRatio(mouthRawStats.avg, mouthNeuStats?.avg),
        }
      : {}),
    ...(eyeRawStats
      ? {
          eyeRawAbsMaxMinMaxAvg: eyeRawStats,
          eyeNeutralizedAbsMaxMinMaxAvg: eyeNeuStats,
          eyeReductionRatio: reductionRatio(eyeRawStats.avg, eyeNeuStats?.avg),
        }
      : {}),
  }
}
