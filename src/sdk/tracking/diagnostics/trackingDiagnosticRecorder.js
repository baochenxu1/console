/**
 * Tracking Diagnostic Recorder — 按帧导出 MediaPipe → Mapping → Face Rig → Binding → Device 全链路。
 */

import { rigValuesFromEliteRig } from "../../../core/faceDofMapper.js"
import { buildTrackingDryRunResult } from "../../trackingPreview/buildTrackingDryRunResult.js"
import {
  getTrackingDiagnosticPipelineState,
  resetTrackingDiagnosticPipelineState,
} from "../../output/trackingBusPipelineState.js"
import {
  buildFrameConsistency,
  normalizeFrameSeq,
  resolveDeviceDebugForFrame,
  resolveRealSendSnapshotForFrame,
} from "../../trackingPreview/trackingFrameEnvelope.js"
import { buildBrowDebugFromFrame, buildBrowPipelineConsistency, mergeBrowChannelsFromDebug, resolveRuntimeBrowSource } from "../browDebugNormalize.js"
import { resolveInputSourceFromRigFrame } from "../input/trackingInputFrame.js"
import { resolveTrackingSourceContext } from "../input/trackingSourceContext.js"
import { calculateEyeBalanceFromFrames } from "./eyeBalanceCalibration.js"
import { buildCompactDiagnosticFrame, buildCompactDiagnosticSample, attachVideoDiagnosticFields, buildEyeGazeAiReviewFields } from "./trackingDiagnosticLite.js"
import {
  buildVideoNeutralCalibrationSummary,
  buildVideoNeutralEffectSummary,
} from "../videoNeutralCalibration.js"
import { COMPACT_DIAGNOSTIC_SAMPLE_MS, latencyStats, mergeActuatorRank, summarizeSafetyFromCommands, summarizeTwitchFromDebug } from "../../trackingPreview/deviceDriveDiagnostics.js"
import {
  buildActuatorProfileSnapshot,
  buildBindingProfileSnapshot,
} from "./diagnosticProfileSnapshots.js"
import {
  buildMappingGainAnalysis,
  buildVideoNeutralEffectP90,
  buildVideoTrackingDiagnosis,
} from "./mappingGainAnalyzer.js"
import {
  buildVideoSourceTuningEffectSummary,
  buildVideoSourceTuningDiagnosisNotes,
  buildVideoSourceTuningShadowCompareSummary,
  buildJawOutputSourceAnalysis,
} from "../videoSourceTuning.js"
import { logExportFrameAudit, resetVideoDiagnosticExportDebugFlags } from "../../trackingPreview/videoDiagnosticExportDebug.js"
import { isVideoFrameDebugComplete, mapSourcePointToCanvas } from "../../trackingPreview/videoFrameDebug.js"
import { DIAGNOSTIC_MODES } from "../../trackingPreview/trackingPreviewConstants.js"
import {
  buildAiReviewExportPayload,
  DIAGNOSTIC_EXPORT_MODES,
} from "./diagnosticAiReviewExport.js"

export const TRACKING_DIAGNOSTIC_SCHEMA = "tracking-diagnostic-v1"
export const TRACKING_DIAGNOSTIC_COMPACT_SCHEMA = "tracking-diagnostic-v1-compact"

/** MediaPipe Face Mesh 常用索引（selected landmarks 默认子集） */
const LANDMARK_REGIONS = {
  leftEye: [33, 133, 160, 159, 158, 157, 173, 144, 145, 153, 154, 155],
  rightEye: [362, 263, 387, 386, 385, 384, 398, 373, 374, 380, 381, 382],
  brows: [70, 63, 105, 66, 107, 300, 293, 334, 296, 336],
  mouth: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95],
  noseAnchor: [1, 2, 98, 327, 4, 5, 6],
  chin: [152, 175, 199, 200],
}

const DEFAULT_OPTIONS = {
  durationMs: 0,
  includeBlendshapes: true,
  /** 当前 Python 服务默认不发 landmarks，关闭可减体积 */
  includeSelectedLandmarks: false,
  includeAllLandmarks: false,
  /** video 录制：写入每帧 videoFrameDebug（含 fallback transform） */
  captureVideoFrameDebug: false,
  includeMappingDebug: true,
  includeFaceRigControls: true,
  includeFinalServoOutputs: true,
  includeDeviceCommands: true,
  /** 录制与导出时剔除重复 debug，保留 MediaPipe + 控件 + 指令主链路 */
  compact: true,
  /** 导出为 .json.gz（默认关闭，需显式开启） */
  exportGzip: false,
  exportPretty: false,
  maxFrames: 600,
  /** off | compact | full */
  diagnosticMode: DIAGNOSTIC_MODES.COMPACT,
  /** full | ai-review — 导出格式；录制仍保留完整帧，导出时 ai-review 剔除 landmark 等大字段 */
  diagnosticExportMode: DIAGNOSTIC_EXPORT_MODES.AI_REVIEW,
  /** ai-review 默认不包含 binding/actuator profile 快照 */
  includeBindingProfileInAiReview: false,
}

/** 诊断关心的 blendshape 子集（不全量导出） */
const ESSENTIAL_BLENDSHAPE_KEYS = [
  "jawOpen",
  "eyeBlinkLeft",
  "eyeBlinkRight",
  "eyeWideLeft",
  "eyeWideRight",
  "browInnerUp",
  "browOuterUpLeft",
  "browOuterUpRight",
  "mouthClose",
  "mouthSmileLeft",
  "mouthSmileRight",
  "mouthUpperUpLeft",
  "mouthUpperUpRight",
  "mouthLowerDownLeft",
  "mouthLowerDownRight",
  "mouthPucker",
  "mouthFunnel",
]

function roundNum(v, digits = 3) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  const f = 10 ** digits
  return Math.round(n * f) / f
}

function pickEssentialBlendshapes(blend) {
  if (!blend || typeof blend !== "object") return null
  const out = {}
  for (const k of ESSENTIAL_BLENDSHAPE_KEYS) {
    if (blend[k] != null) out[k] = roundNum(blend[k])
  }
  return Object.keys(out).length ? out : null
}

function slimLipGeometry(lg) {
  if (!lg) return null
  const ds = lg.deltaSmooth || lg.lipPipeline?.final || {}
  const pipe = lg.lipPipeline || {}
  return {
    upperL: roundNum(ds.upperL ?? lg.upperL),
    upperR: roundNum(ds.upperR ?? lg.upperR),
    lowerL: roundNum(ds.lowerL ?? lg.lowerL),
    lowerR: roundNum(ds.lowerR ?? lg.lowerR),
    scenario: lg.mouthScenario || lg.gateDecision?.finalScenario || null,
    neutralReady: Boolean(lg.neutralReady),
    headLock: Boolean(lg.closedHeadTurnLock?.active),
    lipGeometry: {
      raw: pipe.raw || lg.deltaRaw || null,
      afterSoftDeadzone: pipe.afterSoftDeadzone || null,
      afterSmallMotionBoost: pipe.afterSmallMotionBoost || null,
      afterGain: pipe.afterGain || null,
      afterGate: pipe.afterGate || lg.deltaAfterPoseGate || null,
      afterSmooth: pipe.afterSmooth || lg.deltaSmooth || null,
      final: pipe.final || lg.rigWrite || null,
    },
  }
}

function slimMouthDebug(md) {
  if (!md || typeof md !== "object") return null
  const axis4 = (s) =>
    s && typeof s === "object"
      ? {
          upperL: roundNum(s.upperL),
          upperR: roundNum(s.upperR),
          lowerL: roundNum(s.lowerL),
          lowerR: roundNum(s.lowerR),
        }
      : null
  const axis5 = (s) => {
    const a = axis4(s)
    if (!a) return null
    if (s.rawMouthScore != null) {
      a.rawMouthScore = roundNum(s.rawMouthScore)
    }
    return a
  }
  const geo = md.geometryRaw
  return {
    geometryRaw:
      geo && typeof geo === "object"
        ? {
            upperL: roundNum(geo.upperL),
            upperR: roundNum(geo.upperR),
            lowerL: roundNum(geo.lowerL),
            lowerR: roundNum(geo.lowerR),
            aperture: roundNum(geo.aperture),
            upperLip: roundNum(geo.upperLip),
            lowerLip: roundNum(geo.lowerLip),
            pucker: roundNum(geo.pucker),
            funnel: roundNum(geo.funnel),
          }
        : null,
    relative:
      md.relative && typeof md.relative === "object"
        ? {
            upperL: roundNum(md.relative.upperL),
            upperR: roundNum(md.relative.upperR),
            lowerL: roundNum(md.relative.lowerL),
            lowerR: roundNum(md.relative.lowerR),
            aperture: roundNum(md.relative.aperture),
          }
        : null,
    normalizedBeforeClamp: axis5(md.normalizedBeforeClamp),
    normalizedAfterClamp: axis5(md.normalizedAfterClamp),
    final: axis4(md.final),
  }
}

function slimJawGeometry(jg) {
  if (!jg) return null
  const curve = jg.curve || {}
  return {
    raw: roundNum(jg.raw),
    curved: roundNum(jg.curved ?? curve.afterCurve),
    smooth: roundNum(jg.jawSmooth ?? jg.stabilizer?.smooth),
    scenario: jg.mouthScenario || null,
    neutralReady: Boolean(jg.neutralReady),
    noseMotion: Boolean(jg.noseAnchorMotion),
    jawGeometry: {
      components: jg.components || null,
      curve: {
        rawInput: roundNum(curve.rawInput ?? jg.raw),
        afterDeadzone: roundNum(curve.afterDeadzone),
        afterCurve: roundNum(curve.afterCurve ?? jg.curved),
        target: roundNum(curve.target ?? jg.curved),
        afterSlew: roundNum(curve.afterSlew ?? jg.jawSmooth),
        final: roundNum(curve.final ?? jg.rigWrite?.jaw),
      },
      slew: jg.slew || null,
      gate: jg.gate || jg.gateDecision || null,
    },
  }
}

function slimMouthScenario(cls) {
  if (!cls) return null
  return {
    beforeScenario: cls.beforeScenario || null,
    finalScenario: cls.finalScenario || null,
    rawMouthScore: roundNum(cls.rawMouthEvidence?.score),
    headScore: roundNum(cls.headMotionEvidence?.score),
    headScoreVelocity: roundNum(cls.headScoreVelocity),
    headScoreStable: Boolean(cls.headScoreStable),
    reliable: Boolean(cls.reliableMouthEvidence?.reliable),
    artifactLock: Boolean(cls.immediateArtifactLock?.active),
    strongMouthOverride: Boolean(cls.strongMouthOverrideApplied ?? cls.strongMouthOverride),
    stableHeadMouthOverride: Boolean(cls.stableHeadMouthOverride),
    openCloseGuardActive: Boolean(cls.openCloseGuardActive ?? cls.openCloseGuard?.active),
    reason: cls.overrideReason || cls.decision?.reason || null,
    artifactReason: cls.immediateArtifactLock?.reason || null,
  }
}

function buildMouthCornerDebug(rigFinal, diagnostics, lastFrame) {
  const sideL = rigFinal?.mouth?.sideL || {}
  const sideR = rigFinal?.mouth?.sideR || {}
  const leftKin =
    diagnostics?.kinematics?.leftMouthFiveBar ||
    diagnostics?.kinematics?.leftMouthCornerFiveBar ||
    null
  const rightKin =
    diagnostics?.kinematics?.rightMouthFiveBar ||
    diagnostics?.kinematics?.rightMouthCornerFiveBar ||
    null
  const packCornerSide = (side, kin) => {
    const rawPadX = roundNum(kin?.rawPadX ?? side?.x ?? 0)
    const rawPadY = roundNum(kin?.rawPadY ?? side?.y ?? 0)
    const active = Boolean(kin?.ikOk || kin?.active)
    return {
      rawPadX,
      rawPadY,
      effectivePadX: roundNum(kin?.effectivePadX),
      effectivePadY: roundNum(kin?.effectivePadY),
      flipPadX: kin?.flipPadX ?? null,
      flipPadY: kin?.flipPadY ?? null,
      finalX: roundNum(side?.x),
      finalY: roundNum(side?.y),
      fiveBarA: roundNum(kin?.servoA?.logicalPwm ?? kin?.pwmA ?? kin?.logicalPwmA),
      fiveBarB: roundNum(kin?.servoB?.logicalPwm ?? kin?.pwmB ?? kin?.logicalPwmB),
      active,
      reason: kin?.skipReason || kin?.reason || (active ? "fivebar-active" : "corner-static"),
    }
  }
  return {
    left: packCornerSide(sideL, leftKin),
    right: packCornerSide(sideR, rightKin),
  }
}

function buildJawBindingWarnings(profile, busSkipped) {
  const warnings = []
  const skipped = Array.isArray(busSkipped) ? busSkipped : []
  for (const b of profile?.bindings || []) {
    if (b?.controlId !== "jaw" || b.enabled === false) continue
    const key = b.actuatorKey || (b.servoId != null ? `servo_${b.servoId}` : null)
    const skippedEntry = skipped.find((s) => s.actuatorKey === key || s.bindingId === b.bindingId)
    if (skippedEntry?.reason === "profile-not-found") {
      warnings.push(`active jaw binding has no actuator profile: ${key}`)
    }
  }
  return warnings
}

function slimBrowGate(bg) {
  if (!bg) return null
  return {
    gateAction: bg.gateAction || bg.action || null,
    decisionReason: bg.decisionReason || null,
    browAbsMax: roundNum(bg.browAbsMax),
    explicitBrowActive: Boolean(bg.explicitBrowActive),
    immediateArtifactLock: Boolean(bg.immediateArtifactLock),
    immediateArtifactReason: bg.immediateArtifactReason || null,
  }
}

function enrichBrowMappingExport(browDbg, frameDebug) {
  if (!browDbg) return null
  const slim = slimBrowDebug(browDbg, frameDebug)
  return {
    raw: browDbg.raw,
    gate: slim?.gate ?? slimBrowGate(browDbg.gate),
    final: browDbg.final,
    finalL: slim?.finalL ?? null,
    finalR: slim?.finalR ?? null,
    rawAbsMax: slim?.rawAbsMax ?? null,
    rawL: slim?.rawL ?? null,
    rawR: slim?.rawR ?? null,
  }
}

function resolveDeviceEnvelopeForDiagnostic(sourceSeq, deviceDriveDebug) {
  if (sourceSeq == null || !deviceDriveDebug?.getDeviceEnvelopeForSeq) {
    return null
  }
  const env = deviceDriveDebug.getDeviceEnvelopeForSeq(sourceSeq)
  if (!env) {
    return null
  }
  const envSeq = normalizeFrameSeq(env.frameSeq ?? env.device?.frameSeq)
  if (envSeq != null && envSeq !== sourceSeq) {
    return null
  }
  return env
}

function resolveFrameActuatorDiagnostics(frame) {
  if (isCompactLiteFrame(frame)) {
    return null
  }
  const real = frame.device?.real
  if (real?.sent) {
    const safety = real.safetyStats || summarizeSafetyFromCommands(real.busCommands || [])
    const twitch =
      real.twitchStats ||
      summarizeTwitchFromDebug(real.upperFaceTwitchGuard || [], real.frameSpikeDebug)
    return {
      safetyLimitedCountByRole: safety.safetyLimitedCountByRole,
      twitchGuardActionCountByRole: twitch.twitchGuardActionCountByRole,
      limitedActuatorRank: mergeActuatorRank(safety.limitedActuators, twitch.limitedActuators).slice(0, 12),
    }
  }
  const dryBus = frame.device?.dryRun?.busCommands || []
  if (dryBus.length) {
    const safety = summarizeSafetyFromCommands(dryBus)
    return {
      safetyLimitedCountByRole: safety.safetyLimitedCountByRole,
      twitchGuardActionCountByRole: null,
      limitedActuatorRank: safety.limitedActuators.slice(0, 12),
    }
  }
  return null
}

function aggregateRoleCounts(frames, pickCounts) {
  const totals = {}
  for (const f of frames) {
    const counts = pickCounts(f)
    if (!counts) continue
    for (const [role, n] of Object.entries(counts)) {
      totals[role] = (totals[role] || 0) + (Number(n) || 0)
    }
  }
  return totals
}

function slimBrowDebug(browDbg, frameDebug = null) {
  if (!browDbg) return null
  const rawL = browDbg.raw?.browL
  const rawR = browDbg.raw?.browR
  let finL = browDbg.final?.browL
  let finR = browDbg.final?.browR
  const merged = frameDebug ? mergeBrowChannelsFromDebug(frameDebug) : null
  if (merged) {
    finL = {
      tip: Math.abs(num(finL?.tip)) >= 1 ? num(finL?.tip) : merged.browL.tip,
      mid: Math.abs(num(finL?.mid)) >= 1 ? num(finL?.mid) : merged.browL.mid,
      tail: Math.abs(num(finL?.tail)) >= 1 ? num(finL?.tail) : merged.browL.tail,
    }
    finR = {
      tip: Math.abs(num(finR?.tip)) >= 1 ? num(finR?.tip) : merged.browR.tip,
      mid: Math.abs(num(finR?.mid)) >= 1 ? num(finR?.mid) : merged.browR.mid,
      tail: Math.abs(num(finR?.tail)) >= 1 ? num(finR?.tail) : merged.browR.tail,
    }
  }
  return {
    rawAbsMax: Math.max(rawL?.absMax ?? 0, rawR?.absMax ?? 0),
    rawL: rawL ? { tip: roundNum(rawL.tip), mid: roundNum(rawL.mid), tail: roundNum(rawL.tail) } : null,
    rawR: rawR ? { tip: roundNum(rawR.tip), mid: roundNum(rawR.mid), tail: roundNum(rawR.tail) } : null,
    gate: slimBrowGate(browDbg.gate),
    finalL: finL ? { tip: roundNum(finL.tip), mid: roundNum(finL.mid), tail: roundNum(finL.tail) } : null,
    finalR: finR ? { tip: roundNum(finR.tip), mid: roundNum(finR.mid), tail: roundNum(finR.tail) } : null,
  }
}

function slimServoOutput(o) {
  if (!o) return null
  const dbg = o.debug && typeof o.debug === "object" ? o.debug : {}
  return {
    actuatorKey: o.actuatorKey,
    logicalValue: roundNum(o.logicalValue, 2),
    pwmValue: roundNum(o.pwmValue, 1),
    sourceChannel: o.sourceChannel || null,
    rawControlValue: roundNum(o.rawControlValue ?? dbg.rawControlValue, 3),
    appliedControlValue: roundNum(o.appliedControlValue ?? o.controlValue ?? dbg.appliedControlValue, 3),
    filteredControlValue: roundNum(o.filteredControlValue ?? dbg.filteredControlValue, 3),
    bindingId: o.bindingId ?? null,
    neutralPwm: roundNum(o.neutralPwm ?? dbg.neutralPwm, 1),
    positiveTargetPwm: roundNum(o.positiveTargetPwm ?? dbg.positiveTargetPwm, 1),
    negativeTargetPwm: roundNum(o.negativeTargetPwm ?? dbg.negativeTargetPwm, 1),
    direction: o.direction ?? dbg.direction ?? null,
    curve: o.curve ?? dbg.curve ?? null,
    weight: o.weight ?? dbg.weight ?? null,
    sourceFrameIndex: o.sourceFrameIndex ?? dbg.sourceFrameIndex ?? null,
    sourceTimestampMs: o.sourceTimestampMs ?? dbg.sourceTimestampMs ?? null,
  }
}

function buildServo6Debug(lastFrame, rigFinal, outputs, busCommands, diagnostics) {
  const lipGeo = lastFrame?.debug?.lipGeometry
  const mouthScenario =
    lastFrame?.debug?.mouthScenarioClassifier?.finalScenario ||
    lipGeo?.mouthScenario ||
    lipGeo?.gateDecision?.finalScenario ||
    null
  const headLock = Boolean(lipGeo?.closedHeadTurnLock?.active)
  const mouthURFinal = roundNum(rigFinal?.mouth?.UR)
  const out =
    (outputs || []).find((o) => o.actuatorKey === "servo_6" || o.sourceChannel === "mouth_ur.value") ||
    null
  const bus = (busCommands || []).find((c) => c.actuatorKey === "servo_6") || null
  const kin = diagnostics?.kinematics?.rightMouthCornerFivebar || diagnostics?.kinematics?.rightMouthCorner || null
  return {
    mouthScenario,
    headLock,
    mouthURFinal,
    mouthURAppliedToBinding: out?.appliedControlValue ?? out?.rawControlValue ?? null,
    rawControlValue: out?.rawControlValue ?? null,
    appliedControlValue: out?.appliedControlValue ?? null,
    filteredControlValue: out?.filteredControlValue ?? null,
    logicalValue: out?.logicalValue ?? null,
    pwmValue: out?.pwmValue ?? null,
    targetPosition: bus?.targetPosition ?? null,
    previousTargetPosition: bus?.previousTargetPosition ?? null,
    deltaTarget: bus?.deltaTarget ?? null,
    fiveBarServoA: kin?.servoAId ?? null,
    fiveBarServoB: kin?.servoBId ?? null,
    fiveBarOverridesLip: Boolean(
      (kin?.servoAId === 6 || kin?.servoBId === 6) && mouthURFinal !== 0
    ),
  }
}

function slimBusCommand(cmd, { txMode = "hybrid", sent = false } = {}) {
  if (!cmd) return null
  return {
    actuatorKey: cmd.actuatorKey,
    busServoId: cmd.busServoId,
    protocol: cmd.protocol ?? null,
    servoModel: cmd.servoModel ?? null,
    centerMode: cmd.centerMode ?? null,
    installedCenterPosition: cmd.installedCenterPosition ?? null,
    busLogical: roundNum(cmd.busLogical ?? cmd.logicalValue, 2),
    sourceChannel: cmd.sourceChannel ?? null,
    candidateTargetPosition: cmd.candidateTargetPosition ?? null,
    safetyTargetPosition: cmd.safetyTargetPosition ?? cmd.safety?.safeTarget ?? null,
    twitchGuardTargetPosition:
      cmd.twitchGuardTargetPosition ?? cmd.twitchGuard?.outputTarget ?? null,
    realSentTargetPosition: cmd.realSentTargetPosition ?? (cmd.sent ? cmd.targetPosition : null),
    sendMode: cmd.sendMode ?? null,
    targetPosition: cmd.targetPosition,
    previousTargetPosition: cmd.previousTargetPosition ?? cmd.safety?.previousSafeTarget ?? null,
    deltaTarget: cmd.deltaTarget ?? cmd.safety?.deltaTarget ?? null,
    isClamped: Boolean(cmd.isClamped),
    clampReason: cmd.clampReason ?? cmd.skippedReason ?? null,
    safety: cmd.safety
      ? {
          candidateTarget: cmd.safety.candidateTarget,
          safeTarget: cmd.safety.safeTarget,
          previousSafeTarget: cmd.safety.previousSafeTarget ?? null,
          deltaTarget: cmd.safety.deltaTarget ?? null,
          limited: Boolean(cmd.safety.limited),
          reason: cmd.safety.reason || null,
        }
      : null,
    sent: Boolean(cmd.sent ?? sent),
    txMode: cmd.txMode ?? txMode,
  }
}

function slimBusSkipped(skipped) {
  return (skipped || []).map((s) => ({
    actuatorKey: s.actuatorKey ?? null,
    legacyServoIndex: s.legacyServoIndex ?? null,
    reason: s.reason ?? s.message ?? "unknown",
    busServoId: s.busServoId ?? null,
  }))
}

/** @type {Set<(status: ReturnType<typeof getTrackingDiagnosticRecorderStatus>) => void>} */
const statusListeners = new Set()

let lastStatusNotifyAt = 0

export function subscribeTrackingDiagnosticRecorder(listener) {
  statusListeners.add(listener)
  return () => {
    statusListeners.delete(listener)
  }
}

function notifyTrackingDiagnosticRecorderStatus(force = false) {
  const now = Date.now()
  if (!force && now - lastStatusNotifyAt < 200) {
    return getTrackingDiagnosticRecorderStatus()
  }
  lastStatusNotifyAt = now
  const snapshot = getTrackingDiagnosticRecorderStatus()
  for (const listener of statusListeners) {
    try {
      listener(snapshot)
    } catch {
      /* ignore listener errors */
    }
  }
  return snapshot
}

/** @type {{ active: boolean, options: typeof DEFAULT_OPTIONS, frames: object[], startedAt: number, stoppedAt: number, frameIndex: number, droppedFrameCount: number, lastFrameTimestamp: number | null, lastExport: object | null, profile: object | null, actuatorProfiles: object[] | null, recordingSession: { lastAccepted: { sourceSeq: number | null, frameIndex: number | null, videoTimeMs: number | null } | null, staleFrameDroppedCount: number, negativeDeltaFrameCount: number, sessionResetCount: number } }} */
const state = {
  active: false,
  options: { ...DEFAULT_OPTIONS },
  frames: [],
  samples: [],
  lastSampleAt: 0,
  startedAt: 0,
  stoppedAt: 0,
  frameIndex: 0,
  droppedFrameCount: 0,
  lastFrameTimestamp: null,
  lastExport: null,
  profile: null,
  actuatorProfiles: null,
  events: [],
  recordingSession: {
    lastAccepted: null,
    staleFrameDroppedCount: 0,
    negativeDeltaFrameCount: 0,
    sessionResetCount: 0,
  },
}

function num(v, fallback = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function pickEyeSide(rig, side) {
  const e = side === "L" ? rig?.eyeL : rig?.eyeR
  return {
    up: num(e?.up),
    lo: num(e?.lo),
  }
}

function pickRadar(rig) {
  return { x: num(rig?.sharedRadar?.x, 50), y: num(rig?.sharedRadar?.y, 50) }
}

function lmPoint(lm, index) {
  if (!lm) return null
  const p = Array.isArray(lm) ? lm[index] : lm[index]
  if (!p || typeof p !== "object") return null
  const x = num(p.x, NaN)
  const y = num(p.y, NaN)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  const z = Number.isFinite(Number(p.z)) ? Number(p.z) : undefined
  return z != null ? { i: index, x, y, z } : { i: index, x, y }
}

export function extractSelectedLandmarks(landmarks, { includeAll = false } = {}) {
  if (!landmarks) {
    return null
  }
  if (!includeAll && !Array.isArray(landmarks) && typeof landmarks === "object") {
    const sample = landmarks[Object.keys(landmarks)[0]]
    if (sample && typeof sample === "object" && ("x" in sample || "px" in sample)) {
      return { ...landmarks }
    }
  }
  if (includeAll) {
    const all = []
    const seq = Array.isArray(landmarks) ? landmarks : Object.values(landmarks)
    for (let i = 0; i < seq.length; i += 1) {
      const pt = lmPoint(seq, i)
      if (pt) all.push(pt)
    }
    return { all }
  }
  const out = {}
  for (const [region, indices] of Object.entries(LANDMARK_REGIONS)) {
    const pts = []
    for (const idx of indices) {
      const pt = lmPoint(landmarks, idx)
      if (pt) pts.push(pt)
    }
    if (pts.length) out[region] = pts
  }
  return out
}

function resolveLandmarksSource(rawFrame) {
  if (!rawFrame || typeof rawFrame !== "object") return null
  const dbg = rawFrame.debug
  if (dbg?.trackingDebug?.selectedLandmarks) return dbg.trackingDebug.selectedLandmarks
  if (dbg?.landmarks) return dbg.landmarks
  if (dbg?.selectedLandmarks) return dbg.selectedLandmarks
  if (rawFrame.landmarks) return rawFrame.landmarks
  if (rawFrame.faceLandmarks) return rawFrame.faceLandmarks
  return null
}

const FALLBACK_CENTER_PWM = 1500

export const EYE_BALANCE_DEFAULTS = {
  blinkActiveThreshold: 25,
  minSamples: 5,
  unbalanceRatioWarning: 0.25,
  unbalanceRatioError: 0.4,
}

function findEyeOutput(outputs, controlId) {
  const sc = `${controlId}.value`
  return (outputs || []).find((o) => o.sourceChannel === sc) || null
}

/**
 * close magnitude = |targetPosition - installedCenter|。
 * center 优先 installedCenterPosition，其次 effectiveCenterPosition，最后 1500。
 */
function deviceCloseMagnitude(output, busCommands) {
  const bus = output
    ? (busCommands || []).find((c) => c.actuatorKey === output.actuatorKey)
    : null
  const target = bus?.targetPosition ?? output?.pwmValue ?? output?.logicalValue
  if (!Number.isFinite(Number(target))) {
    return { mag: 0, center: null, target: null }
  }
  const center =
    Number(bus?.installedCenterPosition) ||
    Number(bus?.effectiveCenterPosition) ||
    FALLBACK_CENTER_PWM
  return {
    mag: Math.abs(Number(target) - center),
    center,
    target: Number(target),
  }
}

export function eyeBalanceRatio(left, right, eps = 1) {
  const l = Math.abs(Number(left) || 0)
  const r = Math.abs(Number(right) || 0)
  return Math.abs(l - r) / Math.max(l, r, eps)
}

function eyeBalanceStatus(ratio, cfg = EYE_BALANCE_DEFAULTS) {
  if (ratio > cfg.unbalanceRatioError) return "error"
  if (ratio > cfg.unbalanceRatioWarning) return "warning"
  return "ok"
}

const EYE_GAIN_CLAMP_MIN = 0.45
const EYE_GAIN_CLAMP_MAX = 1.6

function clampEyeBalanceGain(g) {
  return Math.max(EYE_GAIN_CLAMP_MIN, Math.min(EYE_GAIN_CLAMP_MAX, Number(g) || 1))
}

function computeRecommendedEyeBalanceGains(device, currentGains) {
  const cur = currentGains || {}
  const lUp = num(device?.leftUpperCloseMag)
  const rUp = num(device?.rightUpperCloseMag)
  const lLo = num(device?.leftLowerCloseMag)
  const rLo = num(device?.rightLowerCloseMag)
  const eps = 1e-6
  const targetUpper = (lUp + rUp) / 2
  const targetLower = (lLo + rLo) / 2
  return {
    leftUpperCloseGain: clampEyeBalanceGain(
      num(cur.leftUpperCloseGain, 1) * (targetUpper / Math.max(lUp, eps))
    ),
    rightUpperCloseGain: clampEyeBalanceGain(
      num(cur.rightUpperCloseGain, 1) * (targetUpper / Math.max(rUp, eps))
    ),
    leftLowerCloseGain: clampEyeBalanceGain(
      num(cur.leftLowerCloseGain, 1) * (targetLower / Math.max(lLo, eps))
    ),
    rightLowerCloseGain: clampEyeBalanceGain(
      num(cur.rightLowerCloseGain, 1) * (targetLower / Math.max(rLo, eps))
    ),
  }
}

function buildEyeBalance(rigFinal, outputs, busCommands, lastFrame, eyeTrack) {
  const eyeL = rigFinal?.eyeL || {}
  const eyeR = rigFinal?.eyeR || {}
  const mapv = lastFrame?.debug?.mapping || {}
  const cfg = EYE_BALANCE_DEFAULTS

  const mapping = {
    leftUpperRange: roundNum(Math.abs(num(eyeL.up))),
    rightUpperRange: roundNum(Math.abs(num(eyeR.up))),
    leftLowerRange: roundNum(Math.abs(num(eyeL.lo))),
    rightLowerRange: roundNum(Math.abs(num(eyeR.lo))),
  }

  const blinkL = num(mapv.blinkLeft)
  const blinkR = num(mapv.blinkRight)
  const normalDbg = eyeTrack?.eyeNormalDebug || null
  const stabilizerBlink = normalDbg?.blinkActive || null
  const blinkActiveL = stabilizerBlink
    ? Boolean(stabilizerBlink.left)
    : blinkL > cfg.blinkActiveThreshold
  const blinkActiveR = stabilizerBlink
    ? Boolean(stabilizerBlink.right)
    : blinkR > cfg.blinkActiveThreshold
  const blinkActive = blinkActiveL || blinkActiveR

  const rUp = findEyeOutput(outputs, "eye_r_up")
  const rLo = findEyeOutput(outputs, "eye_r_lo")
  const lUp = findEyeOutput(outputs, "eye_l_up")
  const lLo = findEyeOutput(outputs, "eye_l_lo")

  const mLUp = deviceCloseMagnitude(lUp, busCommands)
  const mRUp = deviceCloseMagnitude(rUp, busCommands)
  const mLLo = deviceCloseMagnitude(lLo, busCommands)
  const mRLo = deviceCloseMagnitude(rLo, busCommands)

  const device = {
    leftUpperCloseMag: roundNum(mLUp.mag, 1),
    rightUpperCloseMag: roundNum(mRUp.mag, 1),
    leftLowerCloseMag: roundNum(mLLo.mag, 1),
    rightLowerCloseMag: roundNum(mRLo.mag, 1),
    leftUpperCenter: mLUp.center,
    rightUpperCenter: mRUp.center,
    leftLowerCenter: mLLo.center,
    rightLowerCenter: mRLo.center,
    leftUpperActuatorKey: lUp?.actuatorKey ?? null,
    rightUpperActuatorKey: rUp?.actuatorKey ?? null,
    leftLowerActuatorKey: lLo?.actuatorKey ?? null,
    rightLowerActuatorKey: rLo?.actuatorKey ?? null,
  }

  const upperRatio = eyeBalanceRatio(mLUp.mag, mRUp.mag)
  const lowerRatio = eyeBalanceRatio(mLLo.mag, mRLo.mag)
  const upperStatus = blinkActive ? eyeBalanceStatus(upperRatio, cfg) : "idle"
  const lowerStatus = blinkActive ? eyeBalanceStatus(lowerRatio, cfg) : "idle"

  const warnings = []
  if (blinkActive) {
    if (upperStatus === "error") {
      warnings.push({
        type: "eyelid-close-delta-severely-unbalanced",
        channel: "upper",
        message: `上眼睑闭合幅度严重不平衡：L=${roundNum(mLUp.mag, 1)} R=${roundNum(mRUp.mag, 1)} ratio=${roundNum(upperRatio, 3)}`,
      })
    } else if (upperStatus === "warning") {
      warnings.push({
        type: "eyelid-close-delta-unbalanced",
        channel: "upper",
        message: `上眼睑闭合幅度不平衡：L=${roundNum(mLUp.mag, 1)} R=${roundNum(mRUp.mag, 1)} ratio=${roundNum(upperRatio, 3)}`,
      })
    }
    if (lowerStatus === "error") {
      warnings.push({
        type: "eyelid-close-delta-severely-unbalanced",
        channel: "lower",
        message: `下眼睑闭合幅度严重不平衡：L=${roundNum(mLLo.mag, 1)} R=${roundNum(mRLo.mag, 1)} ratio=${roundNum(lowerRatio, 3)}`,
      })
    } else if (lowerStatus === "warning") {
      warnings.push({
        type: "eyelid-close-delta-unbalanced",
        channel: "lower",
        message: `下眼睑闭合幅度不平衡：L=${roundNum(mLLo.mag, 1)} R=${roundNum(mRLo.mag, 1)} ratio=${roundNum(lowerRatio, 3)}`,
      })
    }
  }

  return {
    mapping,
    device,
    blink: {
      blinkL: roundNum(blinkL),
      blinkR: roundNum(blinkR),
      blinkActive,
      blinkActiveL,
      blinkActiveR,
      blinkEvidence: normalDbg?.blinkEvidence || null,
    },
    upper: {
      leftCloseMag: device.leftUpperCloseMag,
      rightCloseMag: device.rightUpperCloseMag,
      ratio: roundNum(upperRatio, 3),
      status: upperStatus,
    },
    lower: {
      leftCloseMag: device.leftLowerCloseMag,
      rightCloseMag: device.rightLowerCloseMag,
      ratio: roundNum(lowerRatio, 3),
      status: lowerStatus,
    },
    gains: eyeTrack?.balanceGains || null,
    recommendedGains: blinkActive
      ? computeRecommendedEyeBalanceGains(device, eyeTrack?.balanceGains)
      : null,
    warnings,
  }
}

function buildRealSendSection(ctx) {
  const {
    driveMode,
    deviceResolved,
    matchedDeviceDebug,
    realSendSnapshot = null,
    realSent,
    realDeviceSeq,
    frameRealTxCount,
    realBusCommands,
    realBusCommandsRaw,
    pwmCommand,
    outputMode,
    compact,
  } = ctx

  const empty = {
    sent: false,
    realTxCount: 0,
    sendFrameCount: 0,
    sendCommandCount: 0,
  }

  if (driveMode !== "device-drive") {
    return { ...empty, reason: "recorder-dry-run-only" }
  }

  if (realSendSnapshot?.sent) {
    const deviceReal = realSendSnapshot
    const commandCount =
      Number(deviceReal.commandCountTotal) ||
      Number(deviceReal.commandCount) ||
      frameRealTxCount
    const packetCount =
      Number(deviceReal.packetCountTotal) || Number(deviceReal.packetCount) || null
    const writeDurationMs =
      Number(deviceReal.writeDurationMsTotal) || Number(deviceReal.writeDurationMs) || null
    const base = {
      sent: true,
      frameSeq: normalizeFrameSeq(deviceReal.frameSeq ?? realDeviceSeq),
      txMode: deviceReal.txMode ?? "hybrid",
      groups: deviceReal.groups ?? [],
      packetCount,
      packetCountTotal: packetCount,
      commandCount,
      commandCountTotal: commandCount,
      writeDurationMs,
      writeDurationMsTotal: writeDurationMs,
      sentServoIds: deviceReal.sentServoIds ?? [],
      skippedServoIds: deviceReal.skippedServoIds ?? [],
      packetHex: deviceReal.packetHex ?? "",
      realTxCount: commandCount,
      sendFrameCount: 1,
      sendCommandCount: commandCount,
      sendPacketCount: packetCount,
      sentAtMs: deviceReal.sentAtMs ?? null,
      sourceTimestampMs: deviceReal.sourceTimestampMs ?? deviceReal.timing?.sourceTimestampMs ?? null,
      timing: deviceReal.timing ?? null,
      safetyStats: deviceReal.safetyStats ?? null,
      twitchStats: deviceReal.twitchStats ?? null,
      busCommands: deviceReal.busCommands ?? realBusCommandsRaw,
    }
    if (compact) {
      return {
        ...base,
        pwm: "",
        bus: realBusCommands,
      }
    }
    return {
      ...base,
      pwmCommand: "",
      busCommands: realBusCommandsRaw,
    }
  }

  if (!matchedDeviceDebug) {
    return { ...empty, reason: deviceResolved?.reason || "not-sent-this-frame" }
  }

  if (!matchedDeviceDebug.armed) {
    return { ...empty, reason: "device-not-armed" }
  }

  if (!deviceResolved?.matched) {
    return {
      ...empty,
      reason: deviceResolved?.reason || "not-sent-this-frame",
    }
  }

  if (!realSent) {
    const skipReason =
      matchedDeviceDebug?.frameEnvelope?.device?.reason ||
      matchedDeviceDebug?.deviceDriveTiming?.reason ||
      matchedDeviceDebug?.lastSkipReason ||
      "not-sent-this-frame"
    return { ...empty, reason: skipReason }
  }

  const twitchGuard =
    matchedDeviceDebug?.frameEnvelope?.device?.upperFaceTwitchGuard ||
    matchedDeviceDebug?.frameEnvelope?.device?.eyeTwitchGuard ||
    null

  const deviceReal = matchedDeviceDebug?.frameEnvelope?.device?.real || null
  const txMeta = matchedDeviceDebug?.busOutputDebug?.tx || {}
  const txMode =
    deviceReal?.txMode ||
    matchedDeviceDebug?.frameEnvelope?.device?.txMode ||
    txMeta.txMode ||
    "hybrid"
  const packetCount =
    deviceReal?.packetCountTotal ??
    deviceReal?.packetCount ??
    matchedDeviceDebug?.frameEnvelope?.device?.packetCount ??
    txMeta.packetCountTotal ??
    txMeta.packetCount ??
    null
  const commandCount =
    deviceReal?.commandCountTotal ??
    deviceReal?.commandCount ??
    txMeta.commandCountTotal ??
    txMeta.commandCount ??
    frameRealTxCount
  const writeDurationMs =
    deviceReal?.writeDurationMsTotal ??
    deviceReal?.writeDurationMs ??
    matchedDeviceDebug?.frameEnvelope?.device?.writeDurationMs ??
    txMeta.writeDurationMsTotal ??
    txMeta.writeDurationMs ??
    matchedDeviceDebug?.serialWriteDebug?.writeDurationMs ??
    null
  const groups = deviceReal?.groups ?? txMeta.groups ?? []

  const base = {
    sent: true,
    frameSeq: realDeviceSeq,
    txMode,
    groups,
    packetCount,
    packetCountTotal: packetCount,
    commandCount,
    commandCountTotal: commandCount,
    writeDurationMs,
    writeDurationMsTotal: writeDurationMs,
    sentServoIds: deviceReal?.sentServoIds ?? txMeta.sentServoIds ?? [],
    skippedServoIds: deviceReal?.skippedServoIds ?? txMeta.skippedServoIds ?? [],
    packetHex:
      deviceReal?.packetHex ??
      matchedDeviceDebug?.frameEnvelope?.device?.packetHex ??
      txMeta.packetHex ??
      "",
    realTxCount: commandCount,
    sendFrameCount: 1,
    sendCommandCount: commandCount,
    sendPacketCount: packetCount,
    upperFaceTwitchGuard: twitchGuard,
    frameSpikeDebug: matchedDeviceDebug?.frameEnvelope?.device?.frameSpikeDebug || null,
    eyeTwitchGuard: twitchGuard,
    serialWriteDebug: matchedDeviceDebug?.serialWriteDebug || null,
  }

  if (compact) {
    return {
      ...base,
      pwm: "",
      bus: realBusCommands,
      timing: matchedDeviceDebug?.deviceDriveTiming || null,
    }
  }

  return {
    ...base,
    pwmCommand: matchedDeviceDebug?.commandPreview || pwmCommand || "",
    busCommands: realBusCommandsRaw,
    deviceDriveTiming: matchedDeviceDebug?.deviceDriveTiming || null,
    busOutputDebug: matchedDeviceDebug?.busOutputDebug || null,
    pipelineStateDebug: matchedDeviceDebug?.pipelineStateDebug || null,
    txDebug: {
      sendFps: matchedDeviceDebug?.sendFps ?? null,
      realSendFps: matchedDeviceDebug?.realSendFps ?? null,
      lastSkipReason: matchedDeviceDebug?.lastSkipReason || "",
    },
  }
}

function resolveFrameRealTxCount(frame) {
  if (isCompactLiteFrame(frame)) {
    if (!frame.drive?.sent) return 0
    return Number(frame.drive?.commandCount) || 0
  }
  const real = frame?.device?.real
  if (!real?.sent) return 0
  if (Number.isFinite(Number(real.realTxCount))) {
    return Math.max(0, Math.round(Number(real.realTxCount)))
  }
  const bus = real.busCommands || real.bus || []
  return Array.isArray(bus) ? bus.length : 0
}

function buildEyeMappingSection(lastFrame, previewRig, options, calibratedFrame = null) {
  const mapv = lastFrame?.debug?.mapping || {}
  const blend = lastFrame?.debug?.blendshapes || {}
  const gaze = lastFrame?.debug?.gaze || {}
  const gateRig = lastFrame?.rig || {}
  const finalRig = previewRig || gateRig
  const compact = Boolean(options.compact)

  const raw = {
    eyeLUp: roundNum(mapv.eyeLUp),
    eyeLLo: roundNum(mapv.eyeLLo),
    eyeRUp: roundNum(mapv.eyeRUp),
    eyeRLo: roundNum(mapv.eyeRLo),
    blinkL: roundNum(mapv.blinkLeft),
    blinkR: roundNum(mapv.blinkRight),
    eyeWideL: roundNum(blend.eyeWideLeft),
    eyeWideR: roundNum(blend.eyeWideRight),
    eyeLookX: roundNum(mapv.eyeLookX ?? gaze.eyeLookX),
    eyeLookY: roundNum(mapv.eyeLookY ?? gaze.eyeLookY),
    sharedRadarX: roundNum(mapv.sharedRadarX ?? gaze.emittedSharedRadarX, 2),
    sharedRadarY: roundNum(mapv.sharedRadarY ?? gaze.emittedSharedRadarY, 2),
  }
  if (!compact) {
    raw.eyeLookUpL = roundNum(gaze.leftEyeY)
    raw.eyeLookUpR = roundNum(gaze.rightEyeY)
    raw.eyeLookDownL = num(gaze.leftEyeY) < 0 ? Math.abs(num(gaze.leftEyeY)) : 0
    raw.eyeLookDownR = num(gaze.rightEyeY) < 0 ? Math.abs(num(gaze.rightEyeY)) : 0
  }

  const finalEye = {
    eyeL: pickEyeSide(finalRig, "L"),
    eyeR: pickEyeSide(finalRig, "R"),
    sharedRadar: pickRadar(finalRig),
  }

  const eyeTrack = calibratedFrame?.debug?.eyeTrack || lastFrame?.debug?.eyeTrack || null
  const out = { raw, final: finalEye }
  if (eyeTrack && options.includeMappingDebug) {
    const l = eyeTrack.left || {}
    const r = eyeTrack.right || {}
    const stage = (key) => ({
      eyeLUp: roundNum(l[key]?.up),
      eyeLLo: roundNum(l[key]?.lo),
      eyeRUp: roundNum(r[key]?.up),
      eyeRLo: roundNum(r[key]?.lo),
    })
    out.debug = {
      raw: stage("raw"),
      afterBaseGain: stage("afterBaseGain"),
      afterBalanceGain: stage("afterBalanceGain"),
      afterRelease: stage("afterRelease"),
      final: {
        eyeLUp: roundNum(finalEye.eyeL?.up),
        eyeLLo: roundNum(finalEye.eyeL?.lo),
        eyeRUp: roundNum(finalEye.eyeR?.up),
        eyeRLo: roundNum(finalEye.eyeR?.lo),
      },
      gains: eyeTrack.balanceGains || null,
      releaseState: eyeTrack.releaseState || null,
      eyeReleaseDebug: eyeTrack.eyeReleaseDebug || null,
      eyeNormalDebug: eyeTrack.eyeNormalDebug || null,
      openRecoveryActive: Boolean(l.openRecoveryActive || r.openRecoveryActive),
      left: l,
      right: r,
    }
  }
  if (!compact) {
    out.afterGate = {
      eyeL: pickEyeSide(gateRig, "L"),
      eyeR: pickEyeSide(gateRig, "R"),
      sharedRadar: pickRadar(gateRig),
    }
    out.afterSmooth = finalEye
    if (!out.debug && options.includeMappingDebug) {
      out.debug = {
        sourceBlendshapes: {
          eyeBlinkLeft: roundNum(blend.eyeBlinkLeft),
          eyeBlinkRight: roundNum(blend.eyeBlinkRight),
          eyeWideLeft: roundNum(blend.eyeWideLeft),
          eyeWideRight: roundNum(blend.eyeWideRight),
        },
        gazeAvailable: Boolean(gaze.available),
        frozenByBlink: Boolean(gaze.frozenByBlink),
      }
    }
  } else if (options.includeMappingDebug && !out.debug) {
    out.debug = {
      gazeAvailable: Boolean(gaze.available),
      frozenByBlink: Boolean(gaze.frozenByBlink),
    }
  }
  return out
}

function buildFaceRigControls(rig, lastFrame, options) {
  if (!options.includeFaceRigControls || !rig) {
    return null
  }
  const vals = rigValuesFromEliteRig(rig)
  const mapv = lastFrame?.debug?.mapping || {}
  const controls = {
    eye_l_up: roundNum(vals.eye_l_up?.value),
    eye_l_lo: roundNum(vals.eye_l_lo?.value),
    eye_r_up: roundNum(vals.eye_r_up?.value),
    eye_r_lo: roundNum(vals.eye_r_lo?.value),
    blink_l: roundNum(mapv.blinkLeft),
    blink_r: roundNum(mapv.blinkRight),
    sharedRadar: pickRadar(rig),
  }
  if (options.compact) {
    return controls
  }
  return { ...controls, all: vals }
}

function slimRigChannels(rig) {
  if (!rig) return null
  return {
    browL: rig.browL
      ? {
          tipA: roundNum(rig.browL.tipA ?? rig.browL.tip),
          tipB: roundNum(rig.browL.tipB),
          tip: roundNum(rig.browL.tipA ?? rig.browL.tip),
          mid: roundNum(rig.browL.mid),
          tail: roundNum(rig.browL.tail),
        }
      : null,
    browR: rig.browR
      ? {
          tipA: roundNum(rig.browR.tipA ?? rig.browR.tip),
          tipB: roundNum(rig.browR.tipB),
          tip: roundNum(rig.browR.tipA ?? rig.browR.tip),
          mid: roundNum(rig.browR.mid),
          tail: roundNum(rig.browR.tail),
        }
      : null,
    eyeL: pickEyeSide(rig, "L"),
    eyeR: pickEyeSide(rig, "R"),
    sharedRadar: pickRadar(rig),
    mouth: rig.mouth
      ? {
          UL: roundNum(rig.mouth.UL),
          UR: roundNum(rig.mouth.UR),
          LL: roundNum(rig.mouth.LL),
          LR: roundNum(rig.mouth.LR),
        }
      : null,
    jaw: rig.jaw ? { val: roundNum(rig.jaw.val) } : null,
  }
}

function filterEyeServoOutputs(outputs) {
  return (outputs || []).filter((o) => {
    const ch = String(o?.sourceChannel || "")
    return ch.startsWith("eye_l_") || ch.startsWith("eye_r_")
  })
}

function minMaxAvg(values) {
  const nums = (values || []).filter((v) => Number.isFinite(Number(v))).map(Number)
  if (!nums.length) {
    return { min: null, max: null, avg: null }
  }
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length
  return { min, max, avg }
}

function countBy(values, predicate) {
  return values.filter(predicate).length
}

/** 聚合所有 blink 活跃帧的 device close magnitude，计算不平衡比例与推荐 gain */
function buildEyeBalanceSummary(frames) {
  const cfg = EYE_BALANCE_DEFAULTS
  const active = frames.filter((f) => f.mapping?.eyes?.eyeBalance?.blink?.blinkActive)
  const dev = (f) => f.mapping?.eyes?.eyeBalance?.device || {}

  const lUp = active.map((f) => num(dev(f).leftUpperCloseMag))
  const rUp = active.map((f) => num(dev(f).rightUpperCloseMag))
  const lLo = active.map((f) => num(dev(f).leftLowerCloseMag))
  const rLo = active.map((f) => num(dev(f).rightLowerCloseMag))

  const mapRanges = {
    leftUpperRange: minMaxAvg(
      frames.map((f) => num(f.mapping?.eyes?.eyeBalance?.mapping?.leftUpperRange))
    ).max,
    rightUpperRange: minMaxAvg(
      frames.map((f) => num(f.mapping?.eyes?.eyeBalance?.mapping?.rightUpperRange))
    ).max,
    leftLowerRange: minMaxAvg(
      frames.map((f) => num(f.mapping?.eyes?.eyeBalance?.mapping?.leftLowerRange))
    ).max,
    rightLowerRange: minMaxAvg(
      frames.map((f) => num(f.mapping?.eyes?.eyeBalance?.mapping?.rightLowerRange))
    ).max,
  }

  const leftUpperCloseMag = minMaxAvg(lUp).avg
  const rightUpperCloseMag = minMaxAvg(rUp).avg
  const leftLowerCloseMag = minMaxAvg(lLo).avg
  const rightLowerCloseMag = minMaxAvg(rLo).avg
  const upperUnbalanceRatio = eyeBalanceRatio(leftUpperCloseMag, rightUpperCloseMag)
  const lowerUnbalanceRatio = eyeBalanceRatio(leftLowerCloseMag, rightLowerCloseMag)

  const lastGains =
    [...frames].reverse().find((f) => f.mapping?.eyes?.eyeBalance?.gains)?.mapping?.eyes
      ?.eyeBalance?.gains || null

  const warnings = []
  if (active.length >= cfg.minSamples) {
    const judge = (ratio, label) => {
      if (ratio > cfg.unbalanceRatioError) {
        warnings.push({
          type: "eyelid-close-delta-severely-unbalanced",
          channel: label,
          ratio: roundNum(ratio, 3),
        })
      } else if (ratio > cfg.unbalanceRatioWarning) {
        warnings.push({
          type: "eyelid-close-delta-unbalanced",
          channel: label,
          ratio: roundNum(ratio, 3),
        })
      }
    }
    judge(upperUnbalanceRatio, "upper")
    judge(lowerUnbalanceRatio, "lower")
  }

  const calibration = calculateEyeBalanceFromFrames(frames, {
    blinkActiveThreshold: cfg.blinkActiveThreshold,
    minSamples: cfg.minSamples,
    currentGains: lastGains || undefined,
  })

  return {
    mapping: mapRanges,
    device: {
      leftUpperCloseMag: roundNum(leftUpperCloseMag, 1),
      rightUpperCloseMag: roundNum(rightUpperCloseMag, 1),
      leftLowerCloseMag: roundNum(leftLowerCloseMag, 1),
      rightLowerCloseMag: roundNum(rightLowerCloseMag, 1),
      upperUnbalanceRatio: roundNum(upperUnbalanceRatio, 3),
      lowerUnbalanceRatio: roundNum(lowerUnbalanceRatio, 3),
      blinkActiveSampleCount: active.length,
    },
    gains: lastGains,
    recommendedGains: calibration.recommendedGains,
    calibrationConfidence: roundNum(calibration.confidence, 2),
    warnings,
  }
}

function isCompactLiteFrame(f) {
  return Boolean(f && f.drive != null && f.sourceSeq != null && f.summaryChannels != null)
}

/** @param {Record<string, unknown> | null | undefined} f */
function isDiagnosticStatusFrame(f) {
  if (!f || typeof f !== "object") {
    return false
  }
  return Boolean(
    f.diagnostic?.isStatusFrame ||
      f.diagnostic?.excludeFromSummary ||
      f.videoPlayback?.ended ||
      f.videoPlayback?.excludeFromSummary
  )
}

const VIDEO_RECORDING_FRAME_TOLERANCE_MS = 1000 / 30 + 2

function resolveFrameInputSource(frame) {
  return frame?.inputSource || frame?.source || {}
}

function resetRecordingSessionAccepted(session) {
  session.lastAccepted = null
}

function commitRecordingSessionAccepted(frame, session) {
  const src = resolveFrameInputSource(frame)
  session.lastAccepted = {
    sourceSeq:
      src.sourceSeq != null && Number.isFinite(Number(src.sourceSeq))
        ? Number(src.sourceSeq)
        : null,
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
  }
}

/**
 * 录制帧准入：过滤 seek 前 stale 帧，检测 backward jump 并重置 session。
 * @returns {{ accept: boolean, reason?: string, resetSession?: boolean }}
 */
function evaluateRecordingFrameAdmission(frame, options, session) {
  if (isDiagnosticStatusFrame(frame)) {
    return { accept: true, reason: "status-frame" }
  }

  const src = resolveFrameInputSource(frame)
  const sourceSeq =
    src.sourceSeq != null && Number.isFinite(Number(src.sourceSeq)) ? Number(src.sourceSeq) : null
  const inputFrameIndex =
    src.frameIndex != null && Number.isFinite(Number(src.frameIndex))
      ? Number(src.frameIndex)
      : null
  const videoTimeMs =
    src.videoTimeMs != null && Number.isFinite(Number(src.videoTimeMs))
      ? Number(src.videoTimeMs)
      : null

  const isVideo =
    resolveTrackingSourceContext(frame, options).isVideoSource ||
    Boolean(options.captureVideoFrameDebug) ||
    Boolean(options.forceVideoDiagnosticFields)

  const frameEpoch =
    src.sourceEpoch != null && Number.isFinite(Number(src.sourceEpoch))
      ? Number(src.sourceEpoch)
      : null
  const baselineEpoch =
    session.baselineSourceEpoch != null && Number.isFinite(Number(session.baselineSourceEpoch))
      ? Number(session.baselineSourceEpoch)
      : options.baselineSourceEpoch != null && Number.isFinite(Number(options.baselineSourceEpoch))
        ? Number(options.baselineSourceEpoch)
        : null
  if (
    baselineEpoch != null &&
    baselineEpoch > 0 &&
    frameEpoch != null &&
    frameEpoch > 0 &&
    frameEpoch !== baselineEpoch
  ) {
    session.staleFrameDroppedCount += 1
    return { accept: false, reason: "source-epoch-mismatch" }
  }

  if (isVideo && options.videoStartMs != null && videoTimeMs != null) {
    const startMs = Number(options.videoStartMs)
    const durationMs = Number(options.durationMs) || 0
    if (videoTimeMs < startMs - VIDEO_RECORDING_FRAME_TOLERANCE_MS) {
      session.staleFrameDroppedCount += 1
      return { accept: false, reason: "before-video-start-window" }
    }
    if (
      durationMs > 0 &&
      videoTimeMs > startMs + durationMs + VIDEO_RECORDING_FRAME_TOLERANCE_MS * 2
    ) {
      session.staleFrameDroppedCount += 1
      return { accept: false, reason: "after-video-end-window" }
    }
  }

  const prev = session.lastAccepted
  if (prev) {
    let backwardJump = false
    const prevEpoch =
      prev.sourceEpoch != null && Number.isFinite(Number(prev.sourceEpoch))
        ? Number(prev.sourceEpoch)
        : null
    if (
      prevEpoch != null &&
      frameEpoch != null &&
      prevEpoch > 0 &&
      frameEpoch > 0 &&
      frameEpoch !== prevEpoch
    ) {
      return { accept: true, reason: "source-epoch-changed-session-reset", resetSession: true }
    }
    if (sourceSeq != null && prev.sourceSeq != null && sourceSeq < prev.sourceSeq - 0.5) {
      backwardJump = true
    }
    if (
      inputFrameIndex != null &&
      prev.frameIndex != null &&
      inputFrameIndex < prev.frameIndex - 0.5
    ) {
      backwardJump = true
    }
    if (
      videoTimeMs != null &&
      prev.videoTimeMs != null &&
      videoTimeMs < prev.videoTimeMs - VIDEO_RECORDING_FRAME_TOLERANCE_MS
    ) {
      backwardJump = true
    }
    if (backwardJump) {
      return { accept: true, reason: "backward-jump-session-reset", resetSession: true }
    }
    if (sourceSeq != null && prev.sourceSeq != null && sourceSeq < prev.sourceSeq) {
      session.negativeDeltaFrameCount += 1
    }
    if (
      inputFrameIndex != null &&
      prev.frameIndex != null &&
      inputFrameIndex < prev.frameIndex
    ) {
      session.negativeDeltaFrameCount += 1
    }
    if (videoTimeMs != null && prev.videoTimeMs != null && videoTimeMs < prev.videoTimeMs) {
      session.negativeDeltaFrameCount += 1
    }
  }

  return { accept: true, reason: "accepted" }
}

/** @param {Record<string, unknown>[]} values */
function analyzeNumericSequence(values) {
  const nums = values.map((v) => Number(v)).filter((v) => Number.isFinite(v))
  if (!nums.length) {
    return {
      first: null,
      last: null,
      min: null,
      max: null,
      monotonic: true,
      gapCount: 0,
      negativeDeltaCount: 0,
    }
  }
  let monotonic = true
  let gapCount = 0
  let negativeDeltaCount = 0
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] < nums[i - 1]) {
      monotonic = false
      negativeDeltaCount += 1
    }
    if (nums[i] > nums[i - 1] + 1) {
      gapCount += 1
    }
  }
  return {
    first: nums[0],
    last: nums[nums.length - 1],
    min: Math.min(...nums),
    max: Math.max(...nums),
    monotonic,
    gapCount,
    negativeDeltaCount,
  }
}

/** @param {Record<string, unknown>[]} frames */
function buildInputSourceSummary(frames) {
  const sourceTypeCounts = { camera: 0, video: 0, replay: 0, unknown: 0 }
  const sourceIdSet = new Set()
  const sourceSeqs = []
  const frameIndexes = []
  const timestampMsList = []
  const videoTimeMsList = []
  let timestampEqualsVideoTimeMsCount = 0
  let timestampVideoTimeMismatchCount = 0
  const playbackRates = []
  const seekEpochCounts = /** @type {Record<string, number>} */ ({})
  const sourceEpochCounts = /** @type {Record<string, number>} */ ({})

  for (const f of frames) {
    const src = f.inputSource || {}
    const type = String(src.sourceType || f.source?.sourceType || "unknown")
    if (type in sourceTypeCounts) {
      sourceTypeCounts[type] += 1
    } else {
      sourceTypeCounts.unknown += 1
    }
    if (src.sourceId) {
      sourceIdSet.add(String(src.sourceId))
    }
    if (src.sourceSeq != null) {
      sourceSeqs.push(Number(src.sourceSeq))
    }
    if (src.frameIndex != null) {
      frameIndexes.push(Number(src.frameIndex))
    }
    if (src.timestampMs != null) {
      timestampMsList.push(Number(src.timestampMs))
    }
    if (src.videoTimeMs != null) {
      videoTimeMsList.push(Number(src.videoTimeMs))
    }
    const ts = Number(src.timestampMs)
    const vt = Number(src.videoTimeMs)
    if (Number.isFinite(ts) && Number.isFinite(vt)) {
      if (Math.abs(ts - vt) < 0.05) {
        timestampEqualsVideoTimeMsCount += 1
      } else {
        timestampVideoTimeMismatchCount += 1
      }
    }
    if (src.playbackRate != null && Number.isFinite(Number(src.playbackRate))) {
      playbackRates.push(Number(src.playbackRate))
    }
    const epoch = src.seekEpoch != null ? String(src.seekEpoch) : "0"
    seekEpochCounts[epoch] = (seekEpochCounts[epoch] || 0) + 1
    const sourceEpoch = src.sourceEpoch != null ? String(src.sourceEpoch) : "0"
    sourceEpochCounts[sourceEpoch] = (sourceEpochCounts[sourceEpoch] || 0) + 1
  }

  const sourceSeqStats = analyzeNumericSequence(sourceSeqs)
  const frameIndexStats = analyzeNumericSequence(frameIndexes)
  const timestampStats = analyzeNumericSequence(timestampMsList)
  const videoTimeStats = analyzeNumericSequence(videoTimeMsList)
  const playbackMinMaxAvg =
    playbackRates.length > 0
      ? {
          min: Math.min(...playbackRates),
          max: Math.max(...playbackRates),
          avg: roundNum(
            playbackRates.reduce((a, b) => a + b, 0) / playbackRates.length,
            4
          ),
        }
      : { min: null, max: null, avg: null }

  return {
    sourceTypeCounts,
    sourceIdList: [...sourceIdSet],
    sourceSeqFirst: sourceSeqStats.first,
    sourceSeqLast: sourceSeqStats.last,
    sourceSeqMin: sourceSeqStats.min,
    sourceSeqMax: sourceSeqStats.max,
    sourceSeqMonotonic: sourceSeqStats.monotonic,
    sourceSeqGapCount: sourceSeqStats.gapCount,
    sourceSeqNegativeDeltaCount: sourceSeqStats.negativeDeltaCount,
    frameIndexFirst: frameIndexStats.first,
    frameIndexLast: frameIndexStats.last,
    frameIndexMin: frameIndexStats.min,
    frameIndexMax: frameIndexStats.max,
    frameIndexMonotonic: frameIndexStats.monotonic,
    frameIndexGapCount: frameIndexStats.gapCount,
    frameIndexNegativeDeltaCount: frameIndexStats.negativeDeltaCount,
    timestampMsFirst: timestampStats.first,
    timestampMsLast: timestampStats.last,
    timestampMsMin: timestampStats.min,
    timestampMsMax: timestampStats.max,
    timestampMsMonotonic: timestampStats.monotonic,
    timestampMsNegativeDeltaCount: timestampStats.negativeDeltaCount,
    videoTimeMsFirst: videoTimeStats.first,
    videoTimeMsLast: videoTimeStats.last,
    videoTimeMsMin: videoTimeStats.min,
    videoTimeMsMax: videoTimeStats.max,
    videoTimeMsMonotonic: videoTimeStats.monotonic,
    videoTimeMsNegativeDeltaCount: videoTimeStats.negativeDeltaCount,
    timestampEqualsVideoTimeMsCount,
    timestampVideoTimeMismatchCount,
    playbackRateMinMaxAvg: playbackMinMaxAvg,
    seekEpochCounts,
    sourceEpochCounts,
  }
}

function lmDistPx(a, b) {
  if (!a || !b) return null
  const ax = Number.isFinite(Number(a.px)) ? Number(a.px) : Number(a.x)
  const ay = Number.isFinite(Number(a.py)) ? Number(a.py) : Number(a.y)
  const bx = Number.isFinite(Number(b.px)) ? Number(b.px) : Number(b.x)
  const by = Number.isFinite(Number(b.py)) ? Number(b.py) : Number(b.y)
  if (![ax, ay, bx, by].every((v) => Number.isFinite(v))) return null
  return Math.hypot(ax - bx, ay - by)
}

function lmCenter(points) {
  const valid = (points || []).filter(Boolean)
  if (!valid.length) return null
  let sx = 0
  let sy = 0
  let n = 0
  for (const p of valid) {
    const x = Number.isFinite(Number(p.px)) ? Number(p.px) : Number(p.x)
    const y = Number.isFinite(Number(p.py)) ? Number(p.py) : Number(p.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    sx += x
    sy += y
    n += 1
  }
  if (!n) return null
  return { px: sx / n, py: sy / n }
}

function lmBoxCenterDist(a, b) {
  if (!a || !b) return null
  const ax = Number(a.centerXPx ?? a.centerX)
  const ay = Number(a.centerYPx ?? a.centerY)
  const bx = Number(b.centerXPx ?? b.centerX)
  const by = Number(b.centerYPx ?? b.centerY)
  if (![ax, ay, bx, by].every((v) => Number.isFinite(v))) return null
  return Math.hypot(ax - bx, ay - by)
}

function frameTrackingDebug(f) {
  if (f?.trackingDebug && typeof f.trackingDebug === "object") {
    return f.trackingDebug
  }
  if (f?.debug?.trackingDebug && typeof f.debug.trackingDebug === "object") {
    return f.debug.trackingDebug
  }
  if (f?.mediapipe?.selectedLandmarks) {
    return { selectedLandmarks: f.mediapipe.selectedLandmarks }
  }
  return null
}

/** 为 frames[] 补充 landmarkMotion / motionContext（基于相邻录制帧）。 */
export function enrichFramesWithLandmarkMotion(frames) {
  let prev = null
  for (const f of frames) {
    if (isDiagnosticStatusFrame(f)) continue
    const td = frameTrackingDebug(f)
    if (!td || typeof td !== "object") {
      prev = f
      continue
    }
    const prevTd = prev ? frameTrackingDebug(prev) : null
    const sel = td.selectedLandmarks || td
    const prevSel = prevTd?.selectedLandmarks || prevTd
    const src = f.inputSource || {}
    const prevSrc = prev?.inputSource || {}
    const deltaSourceSeq =
      src.sourceSeq != null && prevSrc.sourceSeq != null
        ? Number(src.sourceSeq) - Number(prevSrc.sourceSeq)
        : null
    const deltaFrameIndex =
      src.frameIndex != null && prevSrc.frameIndex != null
        ? Number(src.frameIndex) - Number(prevSrc.frameIndex)
        : null
    const deltaVideoTimeMs =
      src.videoTimeMs != null && prevSrc.videoTimeMs != null
        ? Number(src.videoTimeMs) - Number(prevSrc.videoTimeMs)
        : src.timestampMs != null && prevSrc.timestampMs != null
          ? Number(src.timestampMs) - Number(prevSrc.timestampMs)
          : null
    const skippedFrameLikely =
      (deltaSourceSeq != null && deltaSourceSeq > 1) ||
      (deltaFrameIndex != null && deltaFrameIndex > 1) ||
      (deltaVideoTimeMs != null && deltaVideoTimeMs > 50)
    const mouthCenter = lmCenter([sel.leftMouthCorner, sel.rightMouthCorner])
    const prevMouthCenter = prevSel
      ? lmCenter([prevSel.leftMouthCorner, prevSel.rightMouthCorner])
      : null
    const eyeCenter = lmCenter([
      sel.leftEyeOuter,
      sel.leftEyeInner,
      sel.rightEyeOuter,
      sel.rightEyeInner,
    ])
    const prevEyeCenter = prevSel
      ? lmCenter([
          prevSel.leftEyeOuter,
          prevSel.leftEyeInner,
          prevSel.rightEyeOuter,
          prevSel.rightEyeInner,
        ])
      : null
    const motion = {
      noseDeltaPx: lmDistPx(sel.noseTip, prevSel?.noseTip),
      mouthCenterDeltaPx: lmDistPx(mouthCenter, prevMouthCenter),
      eyeCenterDeltaPx: lmDistPx(eyeCenter, prevEyeCenter),
      faceBoxCenterDeltaPx: lmBoxCenterDist(
        resolveFeatureBox(td),
        resolveFeatureBox(prevTd)
      ),
      upperLipDeltaPx: lmDistPx(sel.upperLip, prevSel?.upperLip),
      lowerLipDeltaPx: lmDistPx(sel.lowerLip, prevSel?.lowerLip),
    }
    if (!f.trackingDebug || typeof f.trackingDebug !== "object") {
      f.trackingDebug = { ...td }
    } else {
      f.trackingDebug.landmarkMotion = motion
      f.trackingDebug.motionContext = {
        deltaSourceSeq,
        deltaFrameIndex,
        deltaVideoTimeMs,
        skippedFrameLikely,
      }
    }
    if (!f.trackingDebug.landmarkMotion) {
      f.trackingDebug.landmarkMotion = motion
    }
    if (!f.trackingDebug.motionContext) {
      f.trackingDebug.motionContext = {
        deltaSourceSeq,
        deltaFrameIndex,
        deltaVideoTimeMs,
        skippedFrameLikely,
      }
    }
    prev = f
  }
  return frames
}

function frameOverlayTransformMismatch(frame) {
  const td = frame?.trackingDebug
  const vfd = frame?.videoFrameDebug
  if (!isVideoFrameDebugComplete(vfd) || !td?.selectedLandmarks?.noseTip) {
    return false
  }
  const mapped = mapSourcePointToCanvas(td.selectedLandmarks.noseTip, vfd)
  if (!mapped) {
    return true
  }
  const margin = 24
  return (
    mapped.x < -margin ||
    mapped.y < -margin ||
    mapped.x > Number(vfd.canvasWidth) + margin ||
    mapped.y > Number(vfd.canvasHeight) + margin
  )
}

function buildVideoTrackingQuality(summaryFrames, inputSourceSummary) {
  const videoFrames = summaryFrames.filter(
    (f) => (f.inputSource?.sourceType || f.source?.sourceType) === "video"
  )
  if (!videoFrames.length) {
    return null
  }
  const iss = inputSourceSummary || {}
  const videoTimeSteps = []
  for (let i = 1; i < videoFrames.length; i += 1) {
    const a = videoFrames[i - 1]?.inputSource || {}
    const b = videoFrames[i]?.inputSource || {}
    const ta = Number(a.videoTimeMs ?? a.timestampMs)
    const tb = Number(b.videoTimeMs ?? b.timestampMs)
    if (Number.isFinite(ta) && Number.isFinite(tb) && tb > ta) {
      videoTimeSteps.push(tb - ta)
    }
  }
  const stepStats = latencyStats(videoTimeSteps)
  const first = videoFrames[0]?.inputSource || {}
  const last = videoFrames[videoFrames.length - 1]?.inputSource || {}
  const t0 = Number(iss.videoTimeMsFirst ?? first.videoTimeMs ?? first.timestampMs)
  const t1 = Number(iss.videoTimeMsLast ?? last.videoTimeMs ?? last.timestampMs)
  const wallSpanSec =
    Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0 ? (t1 - t0) / 1000 : null
  const processedFpsFromVideoTime =
    wallSpanSec && wallSpanSec > 0 && iss.videoTimeMsMonotonic !== false
      ? videoFrames.length / wallSpanSec
      : wallSpanSec && wallSpanSec > 0
        ? videoFrames.length / wallSpanSec
        : null

  const noseDeltas = []
  const mouthDeltas = []
  const eyeDeltas = []
  const faceBoxDeltas = []
  let skippedFrameLikelyCount = 0
  let overlayMissingCount = 0
  let overlayPresentCount = 0
  let overlayMismatchCount = 0
  let trackingDebugFrameCount = 0
  let selectedLandmarksFrameCount = 0
  let faceBoxFrameCount = 0
  let videoFrameDebugFrameCount = 0
  for (const f of videoFrames) {
    const td = frameTrackingDebug(f)
    if (td && typeof td === "object") {
      trackingDebugFrameCount += 1
      if (td.selectedLandmarks && typeof td.selectedLandmarks === "object") {
        selectedLandmarksFrameCount += 1
      }
      if (td.faceBox && typeof td.faceBox === "object") {
        faceBoxFrameCount += 1
      }
    }
    const lm = td?.landmarkMotion
    if (lm?.noseDeltaPx != null) noseDeltas.push(Number(lm.noseDeltaPx))
    if (lm?.mouthCenterDeltaPx != null) mouthDeltas.push(Number(lm.mouthCenterDeltaPx))
    if (lm?.eyeCenterDeltaPx != null) eyeDeltas.push(Number(lm.eyeCenterDeltaPx))
    if (lm?.faceBoxCenterDeltaPx != null) faceBoxDeltas.push(Number(lm.faceBoxCenterDeltaPx))
    if (td?.motionContext?.skippedFrameLikely) skippedFrameLikelyCount += 1
    if (isVideoFrameDebugComplete(f.videoFrameDebug)) {
      videoFrameDebugFrameCount += 1
      overlayPresentCount += 1
      if (frameOverlayTransformMismatch(f)) {
        overlayMismatchCount += 1
      }
    } else {
      overlayMissingCount += 1
    }
  }
  const noseStats = latencyStats(noseDeltas)
  const mouthStats = latencyStats(mouthDeltas)
  const eyeStats = latencyStats(eyeDeltas)
  const faceBoxStats = latencyStats(faceBoxDeltas)
  const frameCount = videoFrames.length
  const frameIndexGapCount = Number(iss.frameIndexGapCount) || 0
  const sourceSeqGapCount = Number(iss.sourceSeqGapCount) || 0
  const possibleFrameSkippingIssue = frameIndexGapCount > frameCount * 0.1
  const possibleTrackingJitter =
    (noseStats.p90 != null && noseStats.p90 > 8) ||
    (faceBoxStats.p90 != null && faceBoxStats.p90 > 10)
  const overlayTransformMissingIssue = overlayMissingCount > frameCount * 0.5
  const possibleOverlayTransformMismatch =
    overlayPresentCount > 0 &&
    !overlayTransformMissingIssue &&
    overlayMismatchCount > frameCount * 0.1

  return {
    processedFpsFromVideoTime:
      processedFpsFromVideoTime != null ? roundNum(processedFpsFromVideoTime, 2) : null,
    sourceSeqGapCount,
    frameIndexGapCount,
    videoTimeStepMsMin: stepStats.min,
    videoTimeStepMsAvg: stepStats.avg,
    videoTimeStepMsP50: stepStats.p50,
    videoTimeStepMsP90: stepStats.p90,
    videoTimeStepMsMax: stepStats.max,
    skippedFrameLikelyCount,
    trackingDebugFrameCount,
    selectedLandmarksFrameCount,
    faceBoxFrameCount,
    videoFrameDebugFrameCount,
    trackingDebugMissingCount: Math.max(0, frameCount - trackingDebugFrameCount),
    overlayTransformMissingCount: overlayMissingCount,
    overlayTransformMismatchCount: overlayMismatchCount,
    overlayTransformMissingIssue,
    noseDeltaPxMinMaxAvg: minMaxAvg(noseDeltas),
    noseDeltaPxP90: noseStats.p90,
    mouthCenterDeltaPxMinMaxAvg: minMaxAvg(mouthDeltas),
    mouthCenterDeltaPxP90: mouthStats.p90,
    eyeCenterDeltaPxMinMaxAvg: minMaxAvg(eyeDeltas),
    eyeCenterDeltaPxP90: eyeStats.p90,
    faceBoxCenterDeltaPxMinMaxAvg: minMaxAvg(faceBoxDeltas),
    faceBoxCenterDeltaPxP90: faceBoxStats.p90,
    possibleOverlayTransformMismatch,
    possibleTrackingJitter,
    possibleFrameSkippingIssue,
  }
}

function resolveFeatureBox(td) {
  if (!td || typeof td !== "object") return null
  if (td.selectedFeatureBox && typeof td.selectedFeatureBox === "object") {
    return td.selectedFeatureBox
  }
  if (td.faceBox && typeof td.faceBox === "object") {
    return td.faceBox
  }
  return null
}

function resolveFullFaceBox(td) {
  if (!td || typeof td !== "object") return null
  if (td.fullFaceBox && typeof td.fullFaceBox === "object") {
    return td.fullFaceBox
  }
  return null
}

function resolveFullFaceBoxAreaRatio(td) {
  const fs = td?.faceSize
  const fromSize = num(fs?.fullFaceBoxAreaRatio)
  if (fromSize > 0) return fromSize
  const box = resolveFullFaceBox(td)
  if (!box) return 0
  const w = num(box.width)
  const h = num(box.height)
  return w > 0 && h > 0 ? w * h : 0
}

function buildFaceScaleQuality(summaryFrames) {
  const selectedRatios = []
  const fullRatios = []
  const eyeDists = []
  const mouthWidths = []
  let fullFaceBoxFrameCount = 0

  for (const f of summaryFrames) {
    const td = frameTrackingDebug(f)
    if (!td) continue
    const fs = td.faceSize || {}
    const selectedRatio = num(fs.selectedFeatureBoxAreaRatio || fs.faceBoxAreaRatio)
    const fullRatio = resolveFullFaceBoxAreaRatio(td)
    if (selectedRatio > 0) selectedRatios.push(selectedRatio)
    if (fullRatio > 0) {
      fullRatios.push(fullRatio)
      fullFaceBoxFrameCount += 1
    }
    const eye = num(fs.eyeDistancePx)
    const mouth = num(fs.mouthWidthPx)
    if (eye > 0) eyeDists.push(eye)
    if (mouth > 0) mouthWidths.push(mouth)
  }

  const frameCount = summaryFrames.length || 0
  let faceSizeWarningBasis = "unavailable"
  if (frameCount > 0 && fullRatios.length >= frameCount * 0.5) {
    faceSizeWarningBasis = "full-face-box"
  }

  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null)

  const selectedAvg = avg(selectedRatios)
  const fullAvg = avg(fullRatios)
  const eyeAvg = avg(eyeDists)
  const mouthAvg = avg(mouthWidths)

  return {
    selectedFeatureBoxAreaRatio:
      selectedAvg != null ? roundNum(selectedAvg, 4) : null,
    ...(fullAvg != null ? { fullFaceBoxAreaRatio: roundNum(fullAvg, 4) } : {}),
    eyeDistancePx: eyeAvg != null ? roundNum(eyeAvg, 2) : null,
    mouthWidthPx: mouthAvg != null ? roundNum(mouthAvg, 2) : null,
    faceSizeWarningBasis,
    fullFaceBoxFrameCount,
    selectedFeatureBoxFrameCount: selectedRatios.length,
  }
}

function buildFaceScaleStability(summaryFrames) {
  const faceWidths = []
  const faceHeights = []
  const coverageRatios = []
  const inferenceCoverageRatios = []
  const roiCenterDeltas = []
  const roiBoxDeltas = []
  const roiTargetCenterDeltas = []
  const roiSmoothedCenterDeltas = []
  let roiEnabledFrameCount = 0
  let roiUpdateAppliedCount = 0
  let roiClampCount = 0
  let trackingMode = null
  let roiMultiplier = null
  let prevRoi = null
  let prevTarget = null
  let prevSmoothed = null

  for (const f of summaryFrames) {
    const td = frameTrackingDebug(f)
    const fs = td?.faceScale
    if (!fs || typeof fs !== "object") continue
    const fw = num(fs.faceWidthPx)
    const fh = num(fs.faceHeightPx)
    const cov = num(fs.faceCoverageRatio)
    const infCov = num(fs.inferenceInputFaceCoverageRatio)
    if (fw > 0) faceWidths.push(fw)
    if (fh > 0) faceHeights.push(fh)
    if (cov > 0) coverageRatios.push(cov)
    if (infCov > 0) inferenceCoverageRatios.push(infCov)
    if (fs.roiEnabled) roiEnabledFrameCount += 1
    if (fs.roiUpdateApplied) roiUpdateAppliedCount += 1
    if (fs.roiClampCount != null) roiClampCount += num(fs.roiClampCount)

    const cx =
      fs.roiCenterXPx != null
        ? num(fs.roiCenterXPx)
        : num(fs.roiX) + num(fs.roiWidthPx) / 2
    const cy =
      fs.roiCenterYPx != null
        ? num(fs.roiCenterYPx)
        : num(fs.roiY) + num(fs.roiHeightPx) / 2
    const tcx = num(fs.roiTargetCenterXPx)
    const tcy = num(fs.roiTargetCenterYPx)
    const scx = num(fs.roiSmoothedCenterXPx)
    const scy = num(fs.roiSmoothedCenterYPx)
    const rw = num(fs.roiWidthPx)
    const rh = num(fs.roiHeightPx)

    if (fs.roiEnabled && cx > 0 && cy > 0) {
      if (prevRoi) {
        roiCenterDeltas.push(Math.hypot(cx - prevRoi.cx, cy - prevRoi.cy))
        roiBoxDeltas.push(Math.max(Math.abs(rw - prevRoi.w), Math.abs(rh - prevRoi.h)))
      }
      prevRoi = { cx, cy, w: rw, h: rh }
    }
    if (tcx > 0 && tcy > 0) {
      if (prevTarget) {
        roiTargetCenterDeltas.push(Math.hypot(tcx - prevTarget.cx, tcy - prevTarget.cy))
      }
      prevTarget = { cx: tcx, cy: tcy }
    }
    if (scx > 0 && scy > 0) {
      if (prevSmoothed) {
        roiSmoothedCenterDeltas.push(Math.hypot(scx - prevSmoothed.cx, scy - prevSmoothed.cy))
      }
      prevSmoothed = { cx: scx, cy: scy }
    }
  }

  const src = summaryFrames.find((f) => f.inputSource?.trackingMode)?.inputSource
  if (src?.trackingMode) trackingMode = String(src.trackingMode)
  if (src?.roiMultiplier != null) roiMultiplier = num(src.roiMultiplier)

  const covStats = latencyStats(coverageRatios)
  const infCovStats = latencyStats(inferenceCoverageRatios)
  const roiCenterStats = latencyStats(roiCenterDeltas)
  const roiBoxStats = latencyStats(roiBoxDeltas)
  const roiTargetCenterStats = latencyStats(roiTargetCenterDeltas)
  const roiSmoothedCenterStats = latencyStats(roiSmoothedCenterDeltas)
  const targetP90 = roiTargetCenterStats.p90
  const smoothedP90 = roiSmoothedCenterStats.p90
  let roiJitterReductionRatio = null
  if (targetP90 != null && targetP90 > 0 && smoothedP90 != null) {
    roiJitterReductionRatio = roundNum(1 - smoothedP90 / targetP90, 4)
  }

  const out = {
    faceWidthPxMinMaxAvg: minMaxAvg(faceWidths),
    faceHeightPxMinMaxAvg: minMaxAvg(faceHeights),
    faceCoverageRatioMinMaxAvg: minMaxAvg(coverageRatios),
    faceCoverageRatioP90: covStats.p90,
    inferenceInputFaceCoverageRatioMinMaxAvg: minMaxAvg(inferenceCoverageRatios),
    inferenceInputFaceCoverageRatioP90: infCovStats.p90,
    roiCenterDeltaPxP90: roiCenterStats.p90,
    roiBoxStabilityP90: roiBoxStats.p90,
    roiTargetCenterDeltaPxP90: roiTargetCenterStats.p90,
    roiSmoothedCenterDeltaPxP90: roiSmoothedCenterStats.p90,
    roiJitterReductionRatio,
    roiUpdateAppliedRatio:
      roiEnabledFrameCount > 0
        ? roundNum(roiUpdateAppliedCount / roiEnabledFrameCount, 4)
        : null,
    roiClampCount,
    faceScaleFrameCount: coverageRatios.length,
    roiEnabledFrameCount,
  }
  if (trackingMode) out.trackingMode = trackingMode
  if (roiMultiplier != null) out.roiMultiplier = roundNum(roiMultiplier, 2)
  return out
}

function buildOverlayDiagnostics(summaryFrames, options = {}) {
  let serverDebugOverlayEnabled = null
  let serverOverlayStyle = null
  for (const f of summaryFrames) {
    const po = frameTrackingDebug(f)?.previewOverlay
    if (po && typeof po === "object") {
      serverDebugOverlayEnabled = Boolean(po.serverDebugOverlayEnabled)
      serverOverlayStyle =
        typeof po.serverOverlayStyle === "string"
          ? po.serverOverlayStyle
          : typeof po.style === "string"
            ? po.style
            : null
      break
    }
  }
  return {
    serverDebugOverlayEnabled,
    serverOverlayStyle,
    frontendOverlayMode:
      typeof options.frontendOverlayMode === "string" ? options.frontendOverlayMode : null,
  }
}

function buildVideoQualityWarnings(
  summaryFrames,
  videoTrackingQuality,
  compactFallbackUsed,
  faceScaleQuality,
  mappingGainAnalysis = null
) {
  const warnings = []
  const vtq = videoTrackingQuality
  if (!vtq) return warnings
  const frameCount = summaryFrames.length || 1
  if (vtq.possibleFrameSkippingIssue || vtq.frameIndexGapCount > frameCount * 0.1) {
    warnings.push("video-frame-skipping-detected")
  }
  if (vtq.processedFpsFromVideoTime != null && vtq.processedFpsFromVideoTime < 24) {
    warnings.push("video-processed-fps-low")
  }
  if (vtq.possibleTrackingJitter) {
    warnings.push("video-landmark-jitter-high")
  }
  if (vtq.overlayTransformMissingIssue) {
    warnings.push("video-overlay-transform-missing")
  }
  if (vtq.possibleOverlayTransformMismatch) {
    warnings.push("video-overlay-transform-mismatch")
  }
  const rawSignalsOk = (mappingGainAnalysis?.rawTrackingSignalsFrameCount ?? 0) > 0
  if (compactFallbackUsed && !rawSignalsOk) {
    warnings.push("legacy-summary-compact-fallback-used")
  }
  const isVideoSession = summaryFrames.some(
    (f) => (f.inputSource?.sourceType || f.source?.sourceType) === "video"
  )
  const fsq = faceScaleQuality
  if (isVideoSession && fsq) {
    if (fsq.faceSizeWarningBasis === "full-face-box" && fsq.fullFaceBoxAreaRatio != null) {
      if (fsq.fullFaceBoxAreaRatio < 0.05) {
        warnings.push("video-face-too-small")
      }
    } else if (fsq.faceSizeWarningBasis === "unavailable") {
      warnings.push("face-size-warning-unavailable")
    }
  }
  if (vtq.faceBoxCenterDeltaPxP90 != null && vtq.faceBoxCenterDeltaPxP90 > 12) {
    warnings.push("video-face-box-jitter-high")
  }
  return [...new Set(warnings)]
}

function buildCompactChannelFallbacks(summaryFrames) {
  const eyeAbs = summaryFrames.map((f) => num(f.summaryChannels?.eyeAbsMax))
  const mouthAbs = summaryFrames.map((f) => num(f.summaryChannels?.mouthAbsMax))
  const jawAbs = summaryFrames.map((f) => num(f.summaryChannels?.jawAbsMax))
  const browAbs = summaryFrames.map((f) =>
    num(f.brow?.faceRigAbsMax ?? f.summaryChannels?.browAbsMax)
  )
  const hasEye = eyeAbs.some((v) => v > 0)
  const hasMouth = mouthAbs.some((v) => v > 0)
  const hasJaw = jawAbs.some((v) => v > 0)
  const hasBrow = browAbs.some((v) => v > 0)
  const eyeZeroThr = 1
  const eyeActiveThr = 3
  const compactFallbackUsed = hasEye || hasMouth || hasJaw || hasBrow
  return {
    compactFallbackUsed,
    eyes: hasEye
      ? {
          faceRigEyeAbsMaxMinMaxAvg: minMaxAvg(eyeAbs),
          faceRigEyeAbsMaxP90: latencyStats(eyeAbs).p90,
          activeRatioFromSummaryChannels: eyeAbs.filter((v) => v >= eyeActiveThr).length / eyeAbs.length,
          zeroRatioFromSummaryChannels: eyeAbs.filter((v) => v < eyeZeroThr).length / eyeAbs.length,
          compactFallbackUsed: true,
        }
      : null,
    mouth: hasMouth
      ? {
          faceRigMouthAbsMaxMinMaxAvg: minMaxAvg(mouthAbs),
          faceRigMouthAbsMaxP90: latencyStats(mouthAbs).p90,
          rawMouthScoreUnavailable: true,
          finalScenarioUnavailable: true,
          compactFallbackUsed: true,
        }
      : null,
    jaw: hasJaw
      ? {
          faceRigJawAbsMaxMinMaxAvg: minMaxAvg(jawAbs),
          faceRigJawAbsMaxP90: latencyStats(jawAbs).p90,
          compactFallbackUsed: true,
        }
      : null,
    brows: hasBrow
      ? {
          faceRigBrowAbsMaxMinMaxAvg: minMaxAvg(browAbs),
          faceRigBrowAbsMaxP90: latencyStats(browAbs).p90,
          compactFallbackUsed: true,
        }
      : null,
  }
}

/** @param {Record<string, unknown>[]} frames @param {Record<string, unknown>[]} summaryFrames */
function buildDevicePreviewSafety(frames, summaryFrames, options = {}) {
  const videoFrameCount = summaryFrames.filter(
    (f) => (f.inputSource?.sourceType || f.source?.sourceType) === "video" ||
      (f.inputSource?.sourceType || f.source?.sourceType) === "uploaded-video"
  ).length
  const isVideoMode = videoFrameCount > 0
  const videoDryRunEnabled = Boolean(options.videoDeviceDryRunEnabled)
  const smokeTestEnabled = Boolean(options.videoRealSendSmokeTestEnabled)
  const smokeTestProfile = options.videoSmokeTestProfile || null
  const realSentFrameCount = countBy(summaryFrames, frameWasRealSent)
  const realTxCount = summaryFrames.reduce((sum, f) => sum + resolveFrameRealTxCount(f), 0)
  let realBusPacketCount = 0
  for (const f of summaryFrames) {
    if (!frameWasRealSent(f)) continue
    if (isCompactLiteFrame(f)) {
      realBusPacketCount += Number(f.drive?.packetCount) || 0
    } else {
      realBusPacketCount +=
        Number(f.device?.real?.packetCountTotal) ||
        Number(f.device?.real?.packetCount) ||
        0
    }
  }
  const hasSmokeTestModeFrame = summaryFrames.some(
    (f) => f.device?.deviceDriveMode === "real_smoke_test" || f.drive?.mode === "real_smoke_test"
  )
  let deviceDriveMode = "real"
  if (isVideoMode) {
    if (videoDryRunEnabled) {
      deviceDriveMode = "dry_run"
    } else if (smokeTestEnabled && (hasSmokeTestModeFrame || realSentFrameCount > 0)) {
      deviceDriveMode = "real_smoke_test"
    } else {
      deviceDriveMode = "off"
    }
  }
  return {
    inputSourceType: isVideoMode ? "video" : "camera",
    previewOnlyForced: isVideoMode && !videoDryRunEnabled && !smokeTestEnabled,
    deviceDriveMode,
    videoDeviceDryRunEnabled: videoDryRunEnabled,
    videoRealSendSmokeTestEnabled: smokeTestEnabled,
    smokeTestProfile: smokeTestEnabled ? smokeTestProfile : null,
    realSendBlockedReason: isVideoMode
      ? videoDryRunEnabled
        ? "video-preview-only-dry-run"
        : smokeTestEnabled
          ? realSentFrameCount > 0
            ? null
            : "smoke-test-armed"
          : "video-preview-only"
      : null,
    realSentFrameCount,
    realTxCount,
    realBusPacketCount,
  }
}

/** @param {Record<string, unknown>} summary */
function logVideoInputSmokeTest(summary) {
  const iss = summary?.inputSourceSummary
  const dps = summary?.devicePreviewSafety
  if (!iss || (iss.sourceTypeCounts?.video || 0) === 0) {
    return
  }
  const lines = [
    "Video input smoke test:",
    `sourceType = video`,
    `sourceId = ${(iss.sourceIdList && iss.sourceIdList[0]) || "unknown"}`,
    `frames = ${summary.frameCount ?? 0}`,
    `sourceSeq monotonic = ${iss.sourceSeqMonotonic}`,
    `frameIndex monotonic = ${iss.frameIndexMonotonic}`,
    `videoTimeMs monotonic = ${iss.videoTimeMsMonotonic}`,
    `timestampMs == videoTimeMs mismatch = ${iss.timestampVideoTimeMismatchCount ?? 0}`,
    `realSentFrameCount = ${dps?.realSentFrameCount ?? 0}`,
    `previewOnlyForced = ${dps?.previewOnlyForced ?? false}`,
    `statusFrameCount = ${summary.videoPlayback?.statusFrameCount ?? 0}`,
  ]
  console.info(lines.join("\n"))
}

function frameWasRealSent(f) {
  if (isCompactLiteFrame(f)) {
    return Boolean(f.drive?.sent)
  }
  return Boolean(f.device?.real?.sent)
}

function buildSummary(frames, options, recordingSession = null) {
  const statusFrames = frames.filter(isDiagnosticStatusFrame)
  const summaryFrames = frames.filter((f) => !isDiagnosticStatusFrame(f))
  const endedStatusCount = statusFrames.filter(
    (f) => f.videoPlayback?.ended || f.diagnostic?.statusReason === "video-ended"
  ).length

  const faceDetectedCount = countBy(summaryFrames, (f) =>
    Boolean(f.source?.faceDetected ?? f.source?.fd)
  )
  const eyeLUp = summaryFrames.map((f) => f.mapping?.eyes?.final?.eyeL?.up ?? 0)
  const eyeRUp = summaryFrames.map((f) => f.mapping?.eyes?.final?.eyeR?.up ?? 0)
  const blinkL = summaryFrames.map((f) => f.mapping?.eyes?.raw?.blinkL ?? 0)
  const blinkR = summaryFrames.map((f) => f.mapping?.eyes?.raw?.blinkR ?? 0)
  const browRawAbs = summaryFrames.map((f) => {
    if (f.mapping?.brows?.rawAbsMax != null) return num(f.mapping.brows.rawAbsMax)
    const raw = f.mapping?.brows?.raw
    if (!raw) return 0
    return Math.max(num(raw.browL?.absMax), num(raw.browR?.absMax))
  })
  const browFinalAbs = summaryFrames.map((f) => {
    if (isCompactLiteFrame(f)) {
      return num(f.brow?.faceRigAbsMax ?? f.summaryChannels?.browAbsMax)
    }
    const fin = f.faceRig?.channels?.browL || f.faceRig?.brows?.browL || null
    const finR = f.faceRig?.channels?.browR || f.faceRig?.brows?.browR || null
    if (!fin && !finR) return 0
    const l = fin
      ? Math.max(Math.abs(num(fin.tip)), Math.abs(num(fin.mid)), Math.abs(num(fin.tail)))
      : 0
    const r = finR
      ? Math.max(Math.abs(num(finR.tip)), Math.abs(num(finR.mid)), Math.abs(num(finR.tail)))
      : 0
    return Math.max(l, r)
  })
  const mappingBrowFinalAbs = summaryFrames.map((f) => {
    if (isCompactLiteFrame(f)) {
      return num(f.brow?.mappingAbsMax)
    }
    const b = f.mapping?.brows
    if (!b) return 0
    const finL = b.finalL || b.final?.browL
    const finR = b.finalR || b.final?.browR
    const l = finL
      ? Math.max(Math.abs(num(finL.tip)), Math.abs(num(finL.mid)), Math.abs(num(finL.tail)))
      : 0
    const r = finR
      ? Math.max(Math.abs(num(finR.tip)), Math.abs(num(finR.mid)), Math.abs(num(finR.tail)))
      : 0
    return Math.max(l, r)
  })
  const gateActions = {}
  for (const f of summaryFrames) {
    const a =
      f.mapping?.brows?.gate?.gateAction ||
      f.mapping?.browGate?.gateAction ||
      f.mapping?.browGate?.action ||
      "unknown"
    gateActions[a] = (gateActions[a] || 0) + 1
  }
  const rawMouth = summaryFrames.map(
    (f) => num(f.mapping?.mouthScenario?.rawMouthScore ?? f.mapping?.mouthScenarioClassifier?.rawMouthEvidence?.score)
  )
  const scenarioCounts = {}
  for (const f of summaryFrames) {
    const s =
      f.mapping?.mouthScenario?.finalScenario ||
      f.mapping?.mouthScenarioClassifier?.finalScenario ||
      "unknown"
    scenarioCounts[s] = (scenarioCounts[s] || 0) + 1
  }
  const bindingOutputsOf = (f) => f.binding?.finalServoOutputs || f.binding?.outputs || []
  const outputCounts = summaryFrames.map((f) => bindingOutputsOf(f).length)
  const actuatorKeys = new Set()
  for (const f of summaryFrames) {
    for (const o of bindingOutputsOf(f)) {
      if (o?.actuatorKey) actuatorKeys.add(o.actuatorKey)
    }
  }
  const cmdCounts = summaryFrames.map((f) => {
    const dry = f.device?.dryRun
    const bus = dry?.bus?.length ?? dry?.busCommands?.length ?? 0
    if (bus > 0) return bus
    const pwm = dry?.pwm || dry?.pwmCommand
    return pwm ? 1 : 0
  })
  const outputModeCounts = {}
  for (const f of summaryFrames) {
    const m = f.device?.mode || f.device?.outputMode || "unknown"
    outputModeCounts[m] = (outputModeCounts[m] || 0) + 1
  }
  const realSentFrameCount = countBy(summaryFrames, frameWasRealSent)
  const sendCommandCount = summaryFrames.reduce((sum, f) => sum + resolveFrameRealTxCount(f), 0)
  const realTxCount = sendCommandCount
  const sendFrameCount = realSentFrameCount
  const blinkActiveLFrames = countBy(
    summaryFrames,
    (f) =>
      Boolean(
        f.mapping?.eyes?.eyeBalance?.blink?.blinkActiveL ??
          f.mapping?.eyes?.debug?.eyeNormalDebug?.blinkActive?.left
      )
  )
  const blinkActiveRFrames = countBy(
    summaryFrames,
    (f) =>
      Boolean(
        f.mapping?.eyes?.eyeBalance?.blink?.blinkActiveR ??
          f.mapping?.eyes?.debug?.eyeNormalDebug?.blinkActive?.right
      )
  )
  const sendSuccessCount = summaryFrames.reduce((sum, f) => {
    const n = f.device?.deviceDriveLoopDebug?.sendSuccessCount
    return sum + (Number.isFinite(Number(n)) ? Number(n) : 0)
  }, 0)
  const lastLoopDebug = [...summaryFrames]
    .reverse()
    .find((f) => f.device?.deviceDriveLoopDebug)?.device?.deviceDriveLoopDebug

  const sessionSentFrames = summaryFrames.filter(frameWasRealSent)
  const firstTs = num(summaryFrames[0]?.timestampMs ?? summaryFrames[0]?.ts)
  const lastTs = num(
    summaryFrames[summaryFrames.length - 1]?.timestampMs ??
      summaryFrames[summaryFrames.length - 1]?.ts
  )
  const sessionDurationSec = Math.max(
    0.001,
    lastTs > firstTs ? (lastTs - firstTs) / 1000 : summaryFrames.length / 25
  )
  const sessionSendFrameCount = sessionSentFrames.length
  const sessionSendPacketCount = sessionSentFrames.reduce((sum, f) => {
    if (isCompactLiteFrame(f)) {
      return sum + (Number(f.drive?.packetCount) || 0)
    }
    return (
      sum +
      (Number(f.device?.real?.packetCountTotal) ||
        Number(f.device?.real?.packetCount) ||
        0)
    )
  }, 0)
  const sessionSendCommandCount = sessionSentFrames.reduce((sum, f) => {
    if (isCompactLiteFrame(f)) {
      return sum + (Number(f.drive?.commandCount) || 0)
    }
    return (
      sum +
      (Number(f.device?.real?.commandCountTotal) ||
        Number(f.device?.real?.commandCount) ||
        0)
    )
  }, 0)
  const sessionWriteDurations = sessionSentFrames
    .map((f) => {
      if (isCompactLiteFrame(f)) {
        return Number(f.drive?.writeDurationMs)
      }
      return (
        Number(f.device?.real?.writeDurationMsTotal) ||
        Number(f.device?.real?.writeDurationMs) ||
        NaN
      )
    })
    .filter((v) => Number.isFinite(v))
  const sessionWriteDurationMsAvg = sessionWriteDurations.length
    ? Math.round(sessionWriteDurations.reduce((a, b) => a + b, 0) / sessionWriteDurations.length)
    : null
  const sessionInputUniqueFrameCount = new Set(
    summaryFrames
      .map((f) =>
        normalizeFrameSeq(
          f.inputSource?.sourceSeq ?? f.sourceSeq ?? f.source?.sourceSeq ?? f.source?.seq ?? f.frameSeq
        )
      )
      .filter((v) => v != null)
  ).size
  const sessionSendIntervalOver80msCount = sessionSentFrames.reduce((sum, f) => {
    const n = Number(f.device?.deviceDriveLoopDebugSession?.sendIntervalOver80msCount)
    return sum + (Number.isFinite(n) ? n : 0)
  }, 0)
  const sessionDroppedStale = sessionSentFrames.reduce((sum, f) => {
    const n = Number(f.device?.deviceDriveLoopDebugSession?.droppedStalePendingFrames)
    return sum + (Number.isFinite(n) ? n : 0)
  }, 0)

  const uniqueRealSentSeqs = new Set()
  let duplicateRealSnapshotAttachCount = 0
  let seqLagSum = 0
  let seqLagCount = 0
  let seqLagMax = 0
  for (const f of summaryFrames) {
    if (!frameWasRealSent(f)) continue
    if (isCompactLiteFrame(f)) {
      const sentSeq = normalizeFrameSeq(f.drive?.sentFrameSeq ?? f.sourceSeq)
      if (sentSeq != null) uniqueRealSentSeqs.add(sentSeq)
      if (
        f.drive?.sent &&
        f.sourceSeq != null &&
        f.drive?.sentFrameSeq != null &&
        f.drive.sentFrameSeq !== f.sourceSeq
      ) {
        duplicateRealSnapshotAttachCount += 1
      }
      if (Number.isFinite(Number(f.drive?.seqLag))) {
        const lag = Number(f.drive.seqLag)
        seqLagSum += lag
        seqLagCount += 1
        seqLagMax = Math.max(seqLagMax, lag)
      }
    } else {
      const sentSeq = normalizeFrameSeq(
        f.device?.real?.frameSeq ?? f.device?.real?.timing?.frameSeq ?? f.source?.seq ?? f.frameSeq
      )
      const srcSeq = normalizeFrameSeq(f.source?.frameSeq ?? f.source?.seq ?? f.frameIndex)
      if (sentSeq != null) uniqueRealSentSeqs.add(sentSeq)
      if (frameWasRealSent(f) && srcSeq != null && sentSeq != null) {
        const lag = srcSeq - sentSeq
        seqLagSum += lag
        seqLagCount += 1
        seqLagMax = Math.max(seqLagMax, lag)
      }
    }
  }

  const latencies = []
  const sendIntervals = []
  let prevSentAtMs = null
  for (const f of summaryFrames) {
    if (!frameWasRealSent(f)) continue
    if (isCompactLiteFrame(f)) {
      const ts = num(f.timestampMs)
      if (prevSentAtMs != null && ts > prevSentAtMs) {
        sendIntervals.push(ts - prevSentAtMs)
      }
      if (ts > 0) prevSentAtMs = ts
      continue
    }
    const timing = f.device?.real?.timing
    const totalLatency =
      timing?.totalLatencyMs ??
      (Number.isFinite(Number(f.device?.real?.sentAtMs)) && Number.isFinite(Number(f.timestampMs))
        ? Number(f.device.real.sentAtMs) - Number(f.timestampMs)
        : null)
    if (Number.isFinite(totalLatency)) {
      latencies.push(totalLatency)
    }
    const sentAt = Number(f.device?.real?.sentAtMs ?? timing?.sentAtMs)
    if (Number.isFinite(sentAt)) {
      if (prevSentAtMs != null && sentAt > prevSentAtMs) {
        sendIntervals.push(sentAt - prevSentAtMs)
      }
      prevSentAtMs = sentAt
    }
  }
  const latencySummary = latencyStats(latencies)
  const sendIntervalSummary = latencyStats(sendIntervals)
  const sendIntervalOver80msCount = sendIntervals.filter((v) => v > 80).length

  const frameConsistencyConsistentCount = countBy(summaryFrames, (f) => {
    const fc = f.frameConsistency
    if (!fc) return false
    if (fc.realSend) return Boolean(fc.realSend.consistent)
    return Boolean(fc.consistent)
  })
  const frameConsistencyCheckedCount = summaryFrames.filter((f) => f.frameConsistency).length

  const safetyLimitedCountByRole = aggregateRoleCounts(summaryFrames, (f) => {
    const counts = f.actuatorDiagnostics?.safetyLimitedCountByRole
    return counts && Object.keys(counts).length ? counts : null
  })
  const twitchGuardActionCountByRole = aggregateRoleCounts(summaryFrames, (f) => {
    const counts = f.actuatorDiagnostics?.twitchGuardActionCountByRole
    return counts && Object.keys(counts).length ? counts : null
  })
  const limitedActuatorRankMap = new Map()
  for (const f of summaryFrames) {
    for (const row of f.actuatorDiagnostics?.limitedActuatorRank || []) {
      const key = String(row.actuatorKey || "")
      if (!key) continue
      const prev = limitedActuatorRankMap.get(key) || {
        actuatorKey: key,
        sourceChannel: row.sourceChannel || null,
        limitedCount: 0,
        twitchHoldCount: 0,
        recoverSlewCount: 0,
      }
      prev.limitedCount += Number(row.limitedCount) || 0
      prev.twitchHoldCount += Number(row.twitchHoldCount) || 0
      prev.recoverSlewCount += Number(row.recoverSlewCount) || 0
      limitedActuatorRankMap.set(key, prev)
    }
  }
  const limitedActuatorRank = [...limitedActuatorRankMap.values()]
    .sort(
      (a, b) =>
        b.limitedCount +
        b.twitchHoldCount +
        b.recoverSlewCount -
        (a.limitedCount + a.twitchHoldCount + a.recoverSlewCount)
    )
    .slice(0, 20)

  const deviceDriveLoopDebugSession = {
    recordingStartFrameSeq: normalizeFrameSeq(
      summaryFrames[0]?.frameSeq ?? summaryFrames[0]?.source?.seq
    ),
    inputUniqueFrameCount: sessionInputUniqueFrameCount,
    sendFrameCount: sessionSendFrameCount,
    sendFrameFps: sessionSendFrameCount / sessionDurationSec,
    sendPacketCount: sessionSendPacketCount,
    sendCommandCount: sessionSendCommandCount,
    writeDurationMsAvg: sessionWriteDurationMsAvg,
    sendIntervalMsMin: sendIntervalSummary.min,
    sendIntervalMsAvg: sendIntervalSummary.avg,
    sendIntervalMsP50: sendIntervalSummary.p50,
    sendIntervalMsP90: sendIntervalSummary.p90,
    sendIntervalMsMax: sendIntervalSummary.max,
    sendIntervalOver80msCount: sendIntervalOver80msCount || sessionSendIntervalOver80msCount,
    droppedStalePendingFrames: sessionDroppedStale,
    writeInFlightCount: null,
  }

  const eyeZeroThr = 1
  const eyeActiveThr = 3
  const eyeFinalAbs = summaryFrames.flatMap((f) => [
    Math.abs(num(f.mapping?.eyes?.final?.eyeL?.up)),
    Math.abs(num(f.mapping?.eyes?.final?.eyeL?.lo)),
    Math.abs(num(f.mapping?.eyes?.final?.eyeR?.up)),
    Math.abs(num(f.mapping?.eyes?.final?.eyeR?.lo)),
  ])
  const releaseLFrames = countBy(
    summaryFrames,
    (f) => num(f.mapping?.eyes?.debug?.releaseState?.L_releasing) > 0
  )
  const releaseRFrames = countBy(
    summaryFrames,
    (f) => num(f.mapping?.eyes?.debug?.releaseState?.R_releasing) > 0
  )
  const eyeBalanceSummary = buildEyeBalanceSummary(summaryFrames)

  const inputSourceSummary = buildInputSourceSummary(summaryFrames)
  if (recordingSession) {
    inputSourceSummary.staleFrameDroppedCount = recordingSession.staleFrameDroppedCount ?? 0
    inputSourceSummary.negativeDeltaFrameCount = recordingSession.negativeDeltaFrameCount ?? 0
    inputSourceSummary.sessionResetCount = recordingSession.sessionResetCount ?? 0
  }
  inputSourceSummary.recordingFrameOrderOk = Boolean(
    inputSourceSummary.sourceSeqMonotonic &&
      inputSourceSummary.frameIndexMonotonic &&
      inputSourceSummary.videoTimeMsMonotonic
  )
  const devicePreviewSafety = buildDevicePreviewSafety(frames, summaryFrames, options)
  const compactFallbacks = buildCompactChannelFallbacks(summaryFrames)
  const videoTrackingQuality = buildVideoTrackingQuality(summaryFrames, inputSourceSummary)
  const faceScaleQuality = buildFaceScaleQuality(summaryFrames)
  const faceScaleStability = buildFaceScaleStability(summaryFrames)
  const overlayDiagnostics = buildOverlayDiagnostics(summaryFrames, options)
  const mappingGainAnalysis = buildMappingGainAnalysis(summaryFrames)
  const videoQualityWarnings = buildVideoQualityWarnings(
    summaryFrames,
    videoTrackingQuality,
    compactFallbacks.compactFallbackUsed,
    faceScaleQuality,
    mappingGainAnalysis
  )

  const videoNeutralFrameDiags = summaryFrames.map((f) => f.videoNeutral).filter(Boolean)
  const videoNeutralSnapshotMeta = options.videoNeutralSnapshot ?? null
  const videoNeutralEnabled = options.videoNeutralEnabled !== false
  const videoNeutralCalibration = buildVideoNeutralCalibrationSummary(
    videoNeutralSnapshotMeta,
    Boolean(videoNeutralSnapshotMeta && videoNeutralEnabled),
    videoNeutralFrameDiags
  )
  videoNeutralCalibration.resetEventCount = (state.events || []).filter(
    (e) => e?.type === "tracking-temporal-reset"
  ).length
  const videoNeutralEffect = buildVideoNeutralEffectSummary(videoNeutralFrameDiags)
  const videoNeutralEffectP90 = buildVideoNeutralEffectP90(
    videoNeutralFrameDiags,
    Boolean(videoNeutralSnapshotMeta && videoNeutralEnabled)
  )
  const videoSourceTuningEffect = buildVideoSourceTuningEffectSummary(summaryFrames)
  const videoSourceTuningShadowCompare = buildVideoSourceTuningShadowCompareSummary(summaryFrames)
  const jawOutputSourceAnalysis = buildJawOutputSourceAnalysis(summaryFrames)
  const videoTrackingDiagnosisBase = buildVideoTrackingDiagnosis(
    mappingGainAnalysis,
    videoNeutralEffectP90,
    faceScaleStability,
    videoTrackingQuality,
    videoSourceTuningEffect,
    videoSourceTuningShadowCompare
  )
  const tuningNotes = buildVideoSourceTuningDiagnosisNotes(videoSourceTuningEffect)
  const videoTrackingDiagnosis = {
    ...videoTrackingDiagnosisBase,
    notes: [...new Set([...(videoTrackingDiagnosisBase.notes || []), ...tuningNotes])],
  }

  const resolvedSourceContext = resolveTrackingSourceContext(summaryFrames[0] ?? null, options)
  const enrichedOptions = { ...options }
  if (resolvedSourceContext.isVideoSource) {
    enrichedOptions.inputSourceType = "video"
    enrichedOptions.forceVideoDiagnosticFields = true
  }
  const outputCountMax = outputCounts.length ? Math.max(...outputCounts) : 0
  const previewOnlyBindingSkip =
    devicePreviewSafety.inputSourceType === "video" &&
    devicePreviewSafety.previewOnlyForced === true &&
    !devicePreviewSafety.videoDeviceDryRunEnabled &&
    !devicePreviewSafety.videoRealSendSmokeTestEnabled &&
    outputCountMax === 0 &&
    (devicePreviewSafety.realSentFrameCount ?? 0) === 0
  const bindingComparisonSkippedCount = previewOnlyBindingSkip
    ? summaryFrames.length
    : summaryFrames.filter((f) => f.brow?.bindingComparisonSkipped).length
  const bindingComparisonSkipReason = previewOnlyBindingSkip
    ? "preview-only-no-binding-output"
    : summaryFrames.find((f) => f.brow?.bindingComparisonSkipReason)?.brow
        ?.bindingComparisonSkipReason ?? null

  const hasMappingGainRaw =
    (mappingGainAnalysis?.rawTrackingSignalsFrameCount ?? 0) > 0 &&
    !mappingGainAnalysis?.compactFallbackMasksRaw
  const legacyGateActionsCount = hasMappingGainRaw
    ? mappingGainAnalysis.brow?.gateActionCounts ?? gateActions
    : gateActions
  const legacyMouthUnavailable = hasMappingGainRaw
    ? Boolean(mappingGainAnalysis.mouth?.rawMouthScoreUnavailable)
    : !rawMouth.some((v) => v > 0)
  const legacyScenarioCounts = hasMappingGainRaw
    ? mappingGainAnalysis.mouth?.scenarioCounts ?? scenarioCounts
    : scenarioCounts
  const compactMouthSpread = compactFallbacks.mouth
    ? hasMappingGainRaw
      ? (({ rawMouthScoreUnavailable: _u, finalScenarioUnavailable: _f, ...rest }) => rest)(
          compactFallbacks.mouth
        )
      : compactFallbacks.mouth
    : null

  const videoNeutralSkipReason =
    summaryFrames.find((f) => f.videoNeutral?.skipReason)?.videoNeutral?.skipReason ?? null

  return {
    frameCount: summaryFrames.length,
    totalFrameCount: frames.length,
    statusFrameCount: statusFrames.length,
    faceDetectedCount,
    faceDetectedRatio: summaryFrames.length ? faceDetectedCount / summaryFrames.length : 0,
    eyes: {
      eyeLUpMinMaxAvg: minMaxAvg(eyeLUp),
      eyeRUpMinMaxAvg: minMaxAvg(eyeRUp),
      blinkLMinMaxAvg: minMaxAvg(blinkL),
      blinkRMinMaxAvg: minMaxAvg(blinkR),
      zeroRatio: eyeFinalAbs.length
        ? eyeFinalAbs.filter((v) => v < eyeZeroThr).length / eyeFinalAbs.length
        : 0,
      activeRatio: eyeFinalAbs.length
        ? eyeFinalAbs.filter((v) => v >= eyeActiveThr).length / eyeFinalAbs.length
        : 0,
      releaseLFrameCount: releaseLFrames,
      releaseRFrameCount: releaseRFrames,
      blinkActiveLFrameCount: blinkActiveLFrames,
      blinkActiveRFrameCount: blinkActiveRFrames,
      eyeBalance: eyeBalanceSummary,
      ...(compactFallbacks.eyes || {}),
    },
    brows: {
      rawAbsMax: browRawAbs.length ? Math.max(...browRawAbs) : 0,
      mappingBrowFinalAbsMax: mappingBrowFinalAbs.length ? Math.max(...mappingBrowFinalAbs) : 0,
      faceRigBrowFinalAbsMax: browFinalAbs.length ? Math.max(...browFinalAbs) : 0,
      /** @deprecated 使用 mappingBrowFinalAbsMax / faceRigBrowFinalAbsMax */
      finalAbsMax: browFinalAbs.length ? Math.max(...browFinalAbs) : 0,
      ...(compactFallbacks.brows || {}),
      gateActionsCount: legacyGateActionsCount,
    },
    mouth: {
      rawMouthScoreMinMaxAvg: rawMouth.some((v) => v > 0)
        ? minMaxAvg(rawMouth)
        : { min: null, max: null, avg: null },
      ...(compactMouthSpread || {}),
      rawMouthScoreUnavailable: legacyMouthUnavailable,
      finalScenarioCounts: legacyScenarioCounts,
    },
    ...(compactFallbacks.jaw ? { jaw: compactFallbacks.jaw } : {}),
    binding: {
      finalServoOutputCountMinMaxAvg: minMaxAvg(outputCounts),
      activeActuatorKeys: [...actuatorKeys],
    },
    device: {
      commandCountMinMaxAvg: minMaxAvg(cmdCounts),
      deviceDriveMode: devicePreviewSafety.deviceDriveMode ?? null,
      videoDeviceDryRunEnabled: Boolean(devicePreviewSafety.videoDeviceDryRunEnabled),
      videoRealSendSmokeTestEnabled: Boolean(devicePreviewSafety.videoRealSendSmokeTestEnabled),
      smokeTestProfile: devicePreviewSafety.smokeTestProfile ?? null,
      dryRunFrameCount: countBy(summaryFrames, (f) => {
        const n = f.binding?.finalServoOutputCount ?? f.binding?.outputs?.length ?? 0
        return n > 0
      }),
      dryRunCommandCount: summaryFrames.reduce((sum, f) => {
        const n =
          f.device?.dryRun?.bus?.length ??
          (f.binding?.outputs?.length || 0)
        return sum + (Number(n) || 0)
      }, 0),
      /** 实际串口 write 成功的 bus packet / command 总数（本次录制窗口） */
      realTxCount,
      sendCommandCount: sessionSendCommandCount || sendCommandCount,
      sendFrameCount: sessionSendFrameCount || sendFrameCount,
      /** @deprecated 使用 sendFrameCount */
      realSentFrameCount: sessionSendFrameCount || realSentFrameCount,
      realSendUniqueFrameCount: uniqueRealSentSeqs.size,
      realSendUniqueFrameFps: uniqueRealSentSeqs.size / sessionDurationSec,
      sourceSeqMinusSentSeqLagAvg: seqLagCount ? Math.round((seqLagSum / seqLagCount) * 100) / 100 : null,
      sourceSeqMinusSentSeqLagMax: seqLagCount ? seqLagMax : null,
      duplicateRealSnapshotAttachCount,
      sentFrameSeqList: [...uniqueRealSentSeqs].slice(-20),
      latencyMsMin: latencySummary.min,
      latencyMsAvg: latencySummary.avg,
      latencyMsP50: latencySummary.p50,
      latencyMsP90: latencySummary.p90,
      latencyMsMax: latencySummary.max,
      latencySampleCount: latencySummary.count,
      sendIntervalMsMin: sendIntervalSummary.min,
      sendIntervalMsAvg: sendIntervalSummary.avg,
      sendIntervalMsP50: sendIntervalSummary.p50,
      sendIntervalMsP90: sendIntervalSummary.p90,
      sendIntervalMsMax: sendIntervalSummary.max,
      sendIntervalOver80msCount: sendIntervalOver80msCount || sessionSendIntervalOver80msCount,
      frameConsistencyConsistentCount,
      frameConsistencyCheckedCount,
      frameConsistencyConsistentRatio: frameConsistencyCheckedCount
        ? frameConsistencyConsistentCount / frameConsistencyCheckedCount
        : 0,
      safetyLimitedCountByRole,
      twitchGuardActionCountByRole,
      limitedActuatorRank,
      /** 全局累计（仅末帧快照参考，勿作录制 summary 主指标） */
      sendSuccessCountGlobal:
        lastLoopDebug?.sendFrameCount ?? lastLoopDebug?.sendSuccessCount ?? sendSuccessCount,
      realBusPacketCountGlobal:
        lastLoopDebug?.realBusPacketCount ?? sessionSendPacketCount ?? sendCommandCount,
      deviceDriveLoopDebugSession,
      outputModeCounts,
    },
    videoPlayback: {
      ended: endedStatusCount > 0,
      endedFrameCount: endedStatusCount,
      statusFrameCount: statusFrames.length,
    },
    inputSourceSummary,
    devicePreviewSafety,
    ...(videoTrackingQuality ? { videoTrackingQuality } : {}),
    ...(faceScaleQuality ? { faceScaleQuality } : {}),
    ...(faceScaleStability?.faceScaleFrameCount ? { faceScaleStability } : {}),
    ...(overlayDiagnostics ? { overlayDiagnostics } : {}),
    ...(videoNeutralCalibration ? { videoNeutralCalibration } : {}),
    ...(Object.keys(videoNeutralEffect).length ? { videoNeutralEffect } : {}),
    videoNeutralEffectP90,
    mappingGainAnalysis,
    videoSourceTuningEffect,
    videoSourceTuningShadowCompare,
    jawOutputSourceAnalysis,
    videoTrackingDiagnosis,
    ...(videoQualityWarnings.length ? { videoQualityWarnings } : {}),
    resolvedSourceContext,
    bindingComparisonSkippedCount,
    bindingComparisonSkipReason,
    videoNeutralSkipReason,
    options: enrichedOptions,
  }
}

/**
 * 从 Tracking Preview 管线上下文构建单帧诊断结构。
 */
export function buildTrackingDiagnosticFrame(ctx) {
  const options = { ...DEFAULT_OPTIONS, ...ctx.options }
  const mode =
    options.diagnosticMode ??
    (options.compact ? DIAGNOSTIC_MODES.COMPACT : DIAGNOSTIC_MODES.FULL)

  if (mode === DIAGNOSTIC_MODES.OFF) {
    return null
  }

  const inputSource = resolveInputSourceFromRigFrame(ctx.lastFrame)
  const sourceSeq = normalizeFrameSeq(inputSource?.sourceSeq ?? ctx.lastFrame?.frameSeq)
  const frameCtx = {
    ...ctx,
    options,
    frameIndex: ctx.frameIndex ?? 0,
    wireSourceSeq: sourceSeq,
    wireSnapshot: {
      wireTrackingDebug: ctx.wireSnapshot?.wireTrackingDebug ?? null,
      wireInputSource: inputSource,
    },
  }

  const frame =
    mode === DIAGNOSTIC_MODES.COMPACT
      ? buildCompactDiagnosticFrame(frameCtx)
      : buildTrackingDiagnosticFrameFull(frameCtx)

  if (!frame) {
    return null
  }
  return attachVideoDiagnosticFields(frame, frameCtx, options)
}

/**
 * 从 Tracking Preview 管线上下文构建单帧完整诊断结构（full 模式）。
 */
function buildTrackingDiagnosticFrameFull(ctx) {
  const {
    lastFrame,
    calibratedFrame = null,
    previewRig = null,
    dryRunResult = null,
    profile = null,
    configs = [],
    actuatorProfiles = null,
    trackingStatus = null,
    driveMode = "preview-only",
    outputMode = "bus-servo",
    deviceDriveDebug = null,
    browDebug = null,
    frameIndex = 0,
    options = DEFAULT_OPTIONS,
  } = ctx

  if (!lastFrame) {
    return null
  }

  const opts = { ...DEFAULT_OPTIONS, ...options }
  const ts = num(lastFrame.timestampMs, Date.now())
  const rigGate = lastFrame.rig || {}
  const rigFinal = previewRig || rigGate
  const browDbg = browDebug || buildBrowDebugFromFrame(lastFrame, calibratedFrame?.rig ?? null)

  const compact = Boolean(opts.compact)
  const blendFull = lastFrame.debug?.blendshapes || null
  const blendshapes = opts.includeBlendshapes
    ? compact
      ? pickEssentialBlendshapes(blendFull)
      : blendFull
    : null
  const landmarksRaw = resolveLandmarksSource(lastFrame)
  let selectedLandmarks = null
  if (opts.includeSelectedLandmarks || opts.includeAllLandmarks) {
    selectedLandmarks = extractSelectedLandmarks(landmarksRaw, {
      includeAll: opts.includeAllLandmarks,
    })
  }

  const lipGeo = lastFrame.debug?.lipGeometry
  const jawGeo = lastFrame.debug?.jawGeometry
  const mouthCls = lastFrame.debug?.mouthScenarioClassifier
  const browGateRaw = lastFrame.debug?.browGate
  const inputSource = resolveInputSourceFromRigFrame(lastFrame)

  const sourceSeq = normalizeFrameSeq(inputSource?.sourceSeq ?? lastFrame.frameSeq)
  const eyeDbg =
    calibratedFrame?.debug?.eyeTrack?.eyeReleaseDebug ||
    lastFrame?.debug?.eyeTrack?.eyeReleaseDebug ||
    null
  const eyeReleasing = Boolean(eyeDbg?.leftReleasing || eyeDbg?.rightReleasing)
  const recorderPipeline = getTrackingDiagnosticPipelineState()

  const effectiveDryRun =
    opts.includeFinalServoOutputs && profile && rigFinal
      ? buildTrackingDryRunResult({
          profile,
          rig: rigFinal,
          configs,
          outputMode,
          actuatorProfiles,
          sourceFrameIndex: sourceSeq,
          sourceTimestampMs: ts,
          busPipelineState: recorderPipeline,
          eyeReleasing,
        })
      : dryRunResult

  const deviceResolved = resolveDeviceDebugForFrame(sourceSeq, deviceDriveDebug)
  const sendSnapshotRes = resolveRealSendSnapshotForFrame(
    sourceSeq,
    deviceDriveDebug?.realSendSnapshots
  )
  let realSendSnapshot = sendSnapshotRes.matched ? sendSnapshotRes.snapshot : null
  if (realSendSnapshot && !realSendSnapshot.sent) {
    realSendSnapshot = null
  }
  const seqEnvelope =
    realSendSnapshot?.sent
      ? resolveDeviceEnvelopeForDiagnostic(sourceSeq, deviceDriveDebug)
      : null
  const matchedDeviceDebug =
    deviceResolved.matched && deviceResolved.deviceDebug?.frameSeq === sourceSeq
      ? deviceResolved.deviceDebug
      : null

  const finalOutputsForBalance = effectiveDryRun?.finalServoOutputs || []
  const busForBalance = effectiveDryRun?.busDryRun?.busCommands || []
  const eyeTrackForBalance =
    calibratedFrame?.debug?.eyeTrack || lastFrame?.debug?.eyeTrack || null
  const eyeBalance =
    opts.includeMappingDebug && rigFinal
      ? buildEyeBalance(
          rigFinal,
          finalOutputsForBalance,
          busForBalance,
          lastFrame,
          eyeTrackForBalance
        )
      : null

  const busSkippedForWarnings = effectiveDryRun?.busDryRun?.skipped || []

  const pickBrowBindingRaw = (outputs) => {
    const pick = (ch) => {
      const o = (outputs || []).find((x) => x.sourceChannel === ch)
      const v = o?.rawControlValue ?? o?.appliedControlValue ?? o?.controlValue
      return Number.isFinite(Number(v)) ? Number(v) : null
    }
    return {
      lTipA: pick("brow_l_tip_a.value") ?? pick("brow_l_tip.value"),
      lTipB: pick("brow_l_tip_b.value"),
      lTip: pick("brow_l_tip_a.value") ?? pick("brow_l_tip.value"),
      lTail: pick("brow_l_tail.value"),
      rTipA: pick("brow_r_tip_a.value") ?? pick("brow_r_tip.value"),
      rTipB: pick("brow_r_tip_b.value"),
      rTip: pick("brow_r_tip_a.value") ?? pick("brow_r_tip.value"),
      rTail: pick("brow_r_tail.value"),
    }
  }

  const browPipelineConsistency =
    opts.includeMappingDebug && browDbg
      ? buildBrowPipelineConsistency({
          mappingFinal:
            resolveRuntimeBrowSource(lastFrame.debug) || browDbg?.raw,
          faceRigChannel: { browL: rigFinal?.browL, browR: rigFinal?.browR },
          bindingRawControl: pickBrowBindingRaw(finalOutputsForBalance),
        })
      : null

  const mapping = opts.includeMappingDebug
    ? compact
      ? {
          eyes: {
            ...buildEyeMappingSection(lastFrame, rigFinal, opts, calibratedFrame),
            ...(eyeBalance ? { eyeBalance } : {}),
          },
          brows: slimBrowDebug(browDbg, lastFrame.debug),
          mouth: {
            ...slimLipGeometry(lipGeo),
            mouthDebug: slimMouthDebug(lastFrame?.debug?.mouthDebug),
            mouthUR: roundNum(rigFinal?.mouth?.UR),
            headLock: Boolean(lipGeo?.closedHeadTurnLock?.active),
            mouthCornerDebug: buildMouthCornerDebug(rigFinal, lastFrame?.debug, lastFrame),
          },
          jaw: slimJawGeometry(jawGeo),
          mouthScenario: slimMouthScenario(mouthCls),
          browGate: slimBrowGate(browGateRaw),
          browPipelineConsistency,
          jawBindingWarnings: buildJawBindingWarnings(profile, busSkippedForWarnings),
        }
      : {
          eyes: {
            ...buildEyeMappingSection(lastFrame, rigFinal, opts, calibratedFrame),
            ...(eyeBalance ? { eyeBalance } : {}),
          },
          brows: enrichBrowMappingExport(browDbg, lastFrame.debug),
          mouth: lipGeo
            ? {
                ...lipGeo,
                mouthCornerDebug: buildMouthCornerDebug(rigFinal, lastFrame?.debug, lastFrame),
              }
            : null,
          jaw: jawGeo || null,
          mouthScenarioClassifier: mouthCls || null,
          jawBindingWarnings: buildJawBindingWarnings(profile, busSkippedForWarnings),
          noseAnchor:
            lastFrame.debug?.noseAnchor || lipGeo?.noseAnchor || jawGeo?.noseAnchor || null,
          browGate: browGateRaw || null,
          browPipelineConsistency,
          mappingScalars: lastFrame.debug?.mapping || null,
          gaze: lastFrame.debug?.gaze || null,
        }
    : null

  const controls = buildFaceRigControls(rigFinal, lastFrame, opts)
  const finalOutputsRaw = opts.includeFinalServoOutputs
    ? effectiveDryRun?.finalServoOutputs || []
    : []
  const finalOutputs = compact
    ? finalOutputsRaw.map(slimServoOutput).filter(Boolean)
    : finalOutputsRaw
  const eyeOutputs = filterEyeServoOutputs(finalOutputsRaw).map((o) =>
    compact ? slimServoOutput(o) : o
  )

  const busBuilt = effectiveDryRun?.busDryRun || null
  const busCommandsRaw = opts.includeDeviceCommands ? busBuilt?.busCommands || [] : []
  const busSkippedRaw = opts.includeDeviceCommands ? busBuilt?.skipped || [] : []
  const dryRunBusCommands = compact
    ? busCommandsRaw.map((c) => slimBusCommand(c, { txMode: "dry-run", sent: false })).filter(Boolean)
    : busCommandsRaw
  const busSkipped = compact ? slimBusSkipped(busSkippedRaw) : busSkippedRaw
  const pwmCommand = opts.includeDeviceCommands ? effectiveDryRun?.commandPreview || "" : ""
  const bindingSeq = normalizeFrameSeq(effectiveDryRun?.frameSeq ?? sourceSeq)

  const realEnvelope = seqEnvelope
  const realSent = Boolean(realSendSnapshot?.sent)
  const realBusTxMode = realSendSnapshot?.txMode || "hybrid"
  const realBusCommandsRaw = realSent ? realSendSnapshot?.busCommands || [] : []
  const realBusCommands = compact
    ? (realSent ? realBusCommandsRaw : []).map((c) =>
        slimBusCommand(c, { txMode: realBusTxMode, sent: true })
      ).filter(Boolean)
    : realSent
      ? realBusCommandsRaw
      : []
  const frameRealTxCount = realSent
    ? Number(realSendSnapshot?.commandCountTotal) ||
      Number(realSendSnapshot?.commandCount) ||
      realBusCommandsRaw.length ||
      0
    : 0

  const dryRunConsistency = buildFrameConsistency({
    sourceSeq,
    mappingSeq: sourceSeq,
    faceRigSeq: sourceSeq,
    bindingSeq,
  })

  const realDeviceSeq = realSent ? normalizeFrameSeq(realSendSnapshot?.frameSeq) : null
  const realTimingSeq = realSent ? realDeviceSeq : null
  const realSafetySeq =
    realSent && seqEnvelope?.safety?.frameSeq != null
      ? normalizeFrameSeq(seqEnvelope.safety.frameSeq)
      : null
  const realSendConsistency = realSent
    ? buildFrameConsistency({
        sourceSeq,
        bindingSeq,
        deviceSeq: realDeviceSeq,
        safetySeq: realSafetySeq ?? realDeviceSeq,
        timingSeq: realTimingSeq,
      })
    : {
        sourceSeq,
        mappingSeq: sourceSeq,
        faceRigSeq: sourceSeq,
        bindingSeq,
        deviceSeq: null,
        safetySeq: null,
        timingSeq: null,
        consistent: false,
        mismatchFields: ["deviceSeq"],
        reason: sendSnapshotRes.reason || "not-sent-this-frame",
      }

  const diagnosticSnapshot = {
    sourceSeq,
    sourceTimestampMs: ts,
    mappingSeq: sourceSeq,
    faceRigSeq: sourceSeq,
    bindingSeq,
    deviceSeq: realDeviceSeq,
    safetySeq: realSafetySeq,
    timingSeq: realTimingSeq,
    realSendSeq: realDeviceSeq,
    missingReason: realSent ? null : sendSnapshotRes.reason || "not-sent-this-frame",
  }

  const frameConsistency = {
    dryRun: dryRunConsistency,
    realSend: realSendConsistency,
    diagnosticSnapshot,
    /** @deprecated 使用 dryRun / realSend */
    ...dryRunConsistency,
  }

  const busSchedulerDebug = null

  const frame = {
    frameIndex: inputSource?.frameIndex ?? frameIndex,
    timestampMs: inputSource?.timestampMs ?? ts,
    inputSource: inputSource || null,
    source: compact
      ? {
          fd: Boolean(lastFrame.faceDetected),
          q: roundNum(lastFrame.quality, 3),
          seq: sourceSeq,
          sourceSeq,
          frameSeq: lastFrame.frameSeq ?? null,
          sourceType: inputSource?.sourceType ?? "camera",
          sourceId: inputSource?.sourceId ?? null,
          timestampMs: inputSource?.timestampMs ?? ts,
        }
      : {
          type: inputSource?.sourceType ?? (trackingStatus?.source?.includes("video")
            ? "video"
            : trackingStatus?.source?.includes("motion")
              ? "motion-track"
              : "camera"),
          sourceId: inputSource?.sourceId ?? null,
          sourceSeq,
          fps: num(trackingStatus?.fps),
          faceDetected: Boolean(lastFrame.faceDetected),
          quality: num(lastFrame.quality),
          wsRxCount: num(trackingStatus?.rx),
          frameSeq: lastFrame.frameSeq ?? null,
        },
    mediapipe: {
      blendshapes,
      ...(selectedLandmarks ? { selectedLandmarks } : {}),
      ...(!compact && (lastFrame.debug?.faceTransform || lastFrame.faceTransform)
        ? { faceTransform: lastFrame.debug?.faceTransform || lastFrame.faceTransform }
        : {}),
      ...(!compact
        ? {
            rawDebug: {
              performance: lastFrame.debug?.performance || null,
              landmarksAvailable: Boolean(landmarksRaw),
            },
          }
        : landmarksRaw
          ? { rawDebug: { landmarksAvailable: true } }
          : {}),
    },
    mapping,
    faceRig: opts.includeFaceRigControls
      ? compact
        ? { controls, channels: slimRigChannels(rigFinal) }
        : {
            controls,
            brows: rigFinal.browL || rigFinal.browR ? { browL: rigFinal.browL, browR: rigFinal.browR } : null,
            eyes: { eyeL: rigFinal.eyeL, eyeR: rigFinal.eyeR, sharedRadar: rigFinal.sharedRadar },
            mouth: rigFinal.mouth,
            jaw: rigFinal.jaw,
            rawRigFrame: { beforeCalibration: rigGate, afterCalibration: rigFinal },
          }
      : null,
    binding: opts.includeFinalServoOutputs
      ? compact
        ? { outputs: finalOutputs, eyeOutputs }
        : {
            finalServoOutputs: finalOutputs,
            eyeServoOutputs: eyeOutputs,
            skippedFinalOutputs:
              dryRunResult?.busDryRun?.skipped || dryRunResult?.diagnostics?.skipped || [],
            bindingDiagnostics: dryRunResult?.diagnostics
              ? {
                  warnings: dryRunResult.diagnostics.warnings,
                  currentIssues: dryRunResult.diagnostics.currentIssues,
                  motionSummary: dryRunResult.diagnostics.motionSummary,
                }
              : null,
          }
      : null,
    device: opts.includeDeviceCommands
      ? compact
        ? {
            mode: outputMode,
            drive: driveMode,
            dryRun: {
              frameSeq: bindingSeq,
              pwm: "",
              bus: dryRunBusCommands,
            skipped: busSkipped,
            },
            real: buildRealSendSection({
              driveMode,
              deviceResolved,
              matchedDeviceDebug,
              realSendSnapshot,
              realSent,
              realDeviceSeq,
              frameRealTxCount,
              realBusCommands,
              realBusCommandsRaw,
              pwmCommand,
              outputMode,
              compact: true,
            }),
            deviceDriveLoopDebug: matchedDeviceDebug?.deviceDriveLoopDebug || null,
            deviceDriveLoopDebugSession: deviceDriveDebug?.deviceDriveLoopDebugSession || null,
            deviceMatch: {
              ...deviceResolved,
              sendSnapshotReason: sendSnapshotRes.reason,
            },
          }
        : {
            outputMode,
            driveMode,
            armed: Boolean(matchedDeviceDebug?.armed),
            dryRun: {
              frameSeq: bindingSeq,
            pwmCommand: "",
              busCommands: outputMode === "bus-servo" ? busCommandsRaw : [],
              skipped: busSkipped,
              pipelineStateDebug: effectiveDryRun?.busDryRun?.pipelineStateDebug || null,
            },
            real: buildRealSendSection({
              driveMode,
              deviceResolved,
              matchedDeviceDebug,
              realSendSnapshot,
              realSent,
              realDeviceSeq,
              frameRealTxCount,
              realBusCommands,
              realBusCommandsRaw,
              pwmCommand,
              outputMode,
              compact: false,
            }),
            deviceDriveLoopDebug: matchedDeviceDebug?.deviceDriveLoopDebug || null,
            serialWriteDebug: matchedDeviceDebug?.serialWriteDebug || null,
            deviceMatch: deviceResolved,
          }
      : null,
    frameConsistency,
  }
  if (!compact) {
    frame.rawFrameSummary = {
      frameSeq: lastFrame.frameSeq ?? null,
      serverSentAtMs: lastFrame.serverSentAtMs ?? null,
      source: lastFrame.source || null,
    }
  }

  frame.debug = {
    servo6: buildServo6Debug(
      lastFrame,
      rigFinal,
      finalOutputsRaw,
      busCommandsRaw,
      effectiveDryRun?.diagnostics
    ),
  }

  const actuatorDiagnostics = realSent
    ? (() => {
        const safety =
          realSendSnapshot?.safetyStats || summarizeSafetyFromCommands(realBusCommandsRaw)
        const twitch =
          realSendSnapshot?.twitchStats ||
          summarizeTwitchFromDebug(
            seqEnvelope?.device?.upperFaceTwitchGuard || [],
            seqEnvelope?.device?.frameSpikeDebug
          )
        return {
          safetyLimitedCountByRole: safety.safetyLimitedCountByRole,
          twitchGuardActionCountByRole: twitch.twitchGuardActionCountByRole,
          limitedActuatorRank: mergeActuatorRank(
            safety.limitedActuators,
            twitch.limitedActuators
          ).slice(0, 12),
        }
      })()
    : busCommandsRaw.length
      ? (() => {
          const safety = summarizeSafetyFromCommands(busCommandsRaw)
          return {
            safetyLimitedCountByRole: safety.safetyLimitedCountByRole,
            twitchGuardActionCountByRole: null,
            limitedActuatorRank: safety.limitedActuators.slice(0, 12),
          }
        })()
      : null
  if (actuatorDiagnostics) {
    frame.actuatorDiagnostics = actuatorDiagnostics
  }

  const videoPlayback =
    lastFrame.debug?.videoPlayback && typeof lastFrame.debug.videoPlayback === "object"
      ? lastFrame.debug.videoPlayback
      : null
  const wireDiagnostic =
    lastFrame.diagnostic && typeof lastFrame.diagnostic === "object"
      ? lastFrame.diagnostic
      : null
  const isStatusFrame = Boolean(
    wireDiagnostic?.isStatusFrame ||
      wireDiagnostic?.excludeFromSummary ||
      videoPlayback?.ended ||
      videoPlayback?.excludeFromSummary
  )
  if (videoPlayback) {
    frame.videoPlayback = videoPlayback
  }
  frame.diagnostic = {
    isStatusFrame,
    excludeFromSummary: isStatusFrame,
    statusReason: isStatusFrame
      ? String(wireDiagnostic?.statusReason || (videoPlayback?.ended ? "video-ended" : "status"))
      : null,
  }

  const eyeGazeAiReview = buildEyeGazeAiReviewFields(
    lastFrame,
    rigFinal,
    calibratedFrame ?? null
  )
  frame.debug = { ...(frame.debug || {}), ...eyeGazeAiReview.debug }
  frame.rig = { ...(frame.rig || {}), ...eyeGazeAiReview.rig }
  frame.eye_xy = eyeGazeAiReview.eye_xy
  frame.eyeXYStabilizer = eyeGazeAiReview.eyeXYStabilizer
  frame.faceRigUi = eyeGazeAiReview.faceRigUi
  if (eyeGazeAiReview.exportFields) {
    Object.assign(frame, eyeGazeAiReview.exportFields)
  }

  return frame
}

export function refreshTrackingDiagnosticSnapshots(snapshots = {}) {
  if (snapshots.profile != null) {
    state.profile = snapshots.profile
  }
  if (snapshots.actuatorProfiles != null) {
    state.actuatorProfiles = snapshots.actuatorProfiles
  }
}

export function getTrackingDiagnosticRecorderStatus() {
  const now = Date.now()
  const elapsedMs = state.active
    ? now - state.startedAt
    : state.stoppedAt > state.startedAt
      ? state.stoppedAt - state.startedAt
      : 0
  return {
    recording: state.active,
    elapsedMs,
    frameCount: state.frames.filter((f) => !isDiagnosticStatusFrame(f)).length,
    totalFrameCount: state.frames.length,
    statusFrameCount: state.frames.filter(isDiagnosticStatusFrame).length,
    sampleCount: state.frames.filter((f) => !isDiagnosticStatusFrame(f)).length,
    periodicDetailSampleCount: state.samples.length,
    droppedFrameCount: state.droppedFrameCount,
    staleFrameDroppedCount: state.recordingSession.staleFrameDroppedCount,
    lastFrameTimestamp: state.lastFrameTimestamp,
    options: { ...state.options },
    startedAt: state.startedAt || null,
    hasExport: Boolean(state.lastExport || state.frames.length),
  }
}

export function startTrackingDiagnosticRecording(options = {}, snapshots = {}) {
  resetTrackingDiagnosticPipelineState()
  resetVideoDiagnosticExportDebugFlags()
  const mode = options.diagnosticMode ?? DEFAULT_OPTIONS.diagnosticMode
  if (mode === DIAGNOSTIC_MODES.OFF) {
    state.active = false
    state.options = { ...DEFAULT_OPTIONS, ...options, diagnosticMode: mode }
    return notifyTrackingDiagnosticRecorderStatus(true)
  }
  state.active = true
  const isVideoInput = Boolean(
    options.inputSourceType === "video" ||
      options.captureVideoFrameDebug ||
      options.forceVideoDiagnosticFields
  )
  state.options = {
    ...DEFAULT_OPTIONS,
    ...options,
    diagnosticMode: mode,
    compact: mode === DIAGNOSTIC_MODES.COMPACT ? true : options.compact !== false,
    includeSelectedLandmarks:
      options.includeSelectedLandmarks ?? (isVideoInput ? true : DEFAULT_OPTIONS.includeSelectedLandmarks),
    captureVideoFrameDebug:
      options.captureVideoFrameDebug ?? (isVideoInput ? true : DEFAULT_OPTIONS.captureVideoFrameDebug),
    forceVideoDiagnosticFields: Boolean(options.forceVideoDiagnosticFields || isVideoInput),
  }
  state.frames = []
  state.samples = []
  state.events = []
  state.lastSampleAt = 0
  state.startedAt = Date.now()
  state.stoppedAt = 0
  state.frameIndex = 0
  state.droppedFrameCount = 0
  state.lastFrameTimestamp = null
  state.lastExport = null
  state.profile = snapshots.profile ?? null
  state.actuatorProfiles = snapshots.actuatorProfiles ?? null
  state.recordingSession = {
    lastAccepted: null,
    staleFrameDroppedCount: 0,
    negativeDeltaFrameCount: 0,
    sessionResetCount: 0,
    baselineSourceEpoch:
      options.baselineSourceEpoch != null && Number.isFinite(Number(options.baselineSourceEpoch))
        ? Number(options.baselineSourceEpoch)
        : null,
  }
  return notifyTrackingDiagnosticRecorderStatus(true)
}

export function stopTrackingDiagnosticRecording() {
  state.active = false
  state.stoppedAt = Date.now()
  if (state.frames.length > 0) {
    try {
      exportTrackingDiagnosticRecording()
    } catch {
      /* export cache is best-effort */
    }
  }
  return notifyTrackingDiagnosticRecorderStatus(true)
}

/** Wall-clock 录制时长到期则停止（不依赖帧是否成功 append）。 */
export function tickTrackingDiagnosticRecordingDurationLimit() {
  if (!state.active) {
    return false
  }
  const durationMs = Number(state.options.durationMs) || 0
  if (durationMs > 0 && Date.now() - state.startedAt >= durationMs) {
    stopTrackingDiagnosticRecording()
    return true
  }
  return false
}

function finishRecordingDurationIfDue() {
  if (tickTrackingDiagnosticRecordingDurationLimit()) {
    return true
  }
  notifyTrackingDiagnosticRecorderStatus()
  return false
}

export function appendDiagnosticSample(sample) {
  if (!sample) return false
  if (!state.active && !state.frames.length) return false
  state.samples.push(sample)
  const maxSamples = Math.max(20, Math.ceil((state.options.durationMs || 10000) / COMPACT_DIAGNOSTIC_SAMPLE_MS) + 2)
  if (state.samples.length > maxSamples) {
    state.samples.shift()
  }
  return true
}

export function appendTrackingDiagnosticEvents(events) {
  if (!Array.isArray(events) || !events.length) {
    return
  }
  state.events = [...(state.events || []), ...events]
}

export function updateTrackingDiagnosticRecordingOptions(partial = {}) {
  if (!partial || typeof partial !== "object") {
    return
  }
  state.options = { ...state.options, ...partial }
}

export function appendTrackingDiagnosticFrame(frame) {
  if (!frame) {
    return false
  }
  if (!state.active) {
    return false
  }

  const admission = evaluateRecordingFrameAdmission(frame, state.options, state.recordingSession)
  if (!admission.accept) {
    if (admission.reason === "after-video-end-window") {
      stopTrackingDiagnosticRecording()
      return false
    }
    finishRecordingDurationIfDue()
    return false
  }

  if (admission.resetSession) {
    const dropped = state.frames.length
    state.frames = []
    state.frameIndex = 0
    state.recordingSession.staleFrameDroppedCount += dropped
    state.recordingSession.sessionResetCount += 1
    resetRecordingSessionAccepted(state.recordingSession)
  }

  const max = Math.max(1, Number(state.options.maxFrames) || 600)
  if (state.frames.length >= max) {
    state.frames.shift()
    state.droppedFrameCount += 1
  }
  const stamped = {
    ...frame,
    frameIndex: state.frameIndex,
  }
  state.frames.push(stamped)
  state.frameIndex += 1
  state.lastFrameTimestamp = frame.timestampMs ?? frame.ts ?? null
  commitRecordingSessionAccepted(frame, state.recordingSession)

  finishRecordingDurationIfDue()
  return true
}

export function exportTrackingDiagnosticRecording() {
  enrichFramesWithLandmarkMotion(state.frames)
  const stoppedAt = state.stoppedAt || Date.now()
  const durationMs = state.startedAt ? stoppedAt - state.startedAt : 0
  const compact = Boolean(state.options.compact)
  const mode = state.options.diagnosticMode ?? DIAGNOSTIC_MODES.COMPACT
  const exportMode = state.options.diagnosticExportMode ?? DIAGNOSTIC_EXPORT_MODES.FULL
  const contentFrameCount = state.frames.filter((f) => !isDiagnosticStatusFrame(f)).length
  const summary = buildSummary(state.frames, state.options, state.recordingSession)

  if (exportMode === DIAGNOSTIC_EXPORT_MODES.AI_REVIEW) {
    const aiReview = buildAiReviewExportPayload({
      frames: state.frames,
      summary,
      options: {
        ...state.options,
        ...(state.options.includeBindingProfileInAiReview
          ? {
              _bindingProfileSnapshot: buildBindingProfileSnapshot(state.profile),
              _actuatorProfileSnapshot: buildActuatorProfileSnapshot(state.actuatorProfiles),
            }
          : {}),
      },
      durationMs,
      createdAt: new Date().toISOString(),
      frameCount: contentFrameCount,
      diagnosticMode: mode,
    })
    logVideoInputSmokeTest(aiReview.summary)
    state.lastExport = aiReview
    return aiReview
  }

  const payload = {
    schemaVersion:
      mode === DIAGNOSTIC_MODES.COMPACT
        ? TRACKING_DIAGNOSTIC_COMPACT_SCHEMA
        : compact
          ? TRACKING_DIAGNOSTIC_COMPACT_SCHEMA
          : TRACKING_DIAGNOSTIC_SCHEMA,
    createdAt: new Date().toISOString(),
    durationMs,
    frameCount: state.frames.filter((f) => !isDiagnosticStatusFrame(f)).length,
    totalFrameCount: state.frames.length,
    statusFrameCount: state.frames.filter(isDiagnosticStatusFrame).length,
    sampleCount: state.frames.filter((f) => !isDiagnosticStatusFrame(f)).length,
    periodicDetailSampleCount: state.samples.length,
    encoding: mode === DIAGNOSTIC_MODES.COMPACT ? "compact-lite" : compact ? "compact-per-frame" : "full",
    diagnosticMode: mode,
    channelsIncluded: {
      mediapipeBlendshapes: Boolean(state.options.includeBlendshapes),
      faceRigControls: Boolean(state.options.includeFaceRigControls),
      finalServoOutputs: Boolean(state.options.includeFinalServoOutputs),
      deviceCommands: Boolean(state.options.includeDeviceCommands),
    },
    bindingProfileSnapshot: buildBindingProfileSnapshot(state.profile),
    actuatorProfileSnapshot: buildActuatorProfileSnapshot(state.actuatorProfiles),
    options: { ...state.options },
    summary,
    frames: state.frames,
    ...(state.samples.length ? { samples: state.samples } : {}),
    ...(state.events?.length ? { events: state.events } : {}),
  }
  logExportFrameAudit(payload.frames)
  logVideoInputSmokeTest(payload.summary)
  state.lastExport = payload
  return payload
}

function canGzipExport() {
  return typeof CompressionStream !== "undefined" && typeof Blob !== "undefined"
}

async function gzipText(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))
  const ab = await new Response(stream).arrayBuffer()
  return new Blob([ab], { type: "application/gzip" })
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.style.display = "none"
  a.rel = "noopener"
  document.body.appendChild(a)
  a.click()
  window.setTimeout(() => {
    if (a.parentNode) {
      a.parentNode.removeChild(a)
    }
  URL.revokeObjectURL(url)
  }, 200)
}

export async function downloadTrackingDiagnosticRecording(filename) {
  if (!state.frames.length && !state.lastExport) {
    throw new Error(
      "没有可导出的诊断数据：录制期间未捕获到帧。请确认 Tracking 已运行且 Diagnostic Mode 不是 Off。"
    )
  }
  const data = exportTrackingDiagnosticRecording()
  const hasFrames = Boolean(data?.frames?.length)
  const hasSeries = Boolean(data?.frameSeries?.rows?.length)
  if (!hasFrames && !hasSeries) {
    throw new Error("诊断帧为空，请确认 camera 已运行且 diagnostic mode 不是 off")
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const pretty = Boolean(state.options.exportPretty)
  const wantGzip = Boolean(state.options.exportGzip) && canGzipExport()
  const isAiReview = data?.diagnosticExportMode === DIAGNOSTIC_EXPORT_MODES.AI_REVIEW
  const baseName =
    filename ||
    (isAiReview ? `tracking-diagnostic-ai-review-${stamp}` : `tracking-diagnostic-${stamp}`)
  const jsonText = JSON.stringify(data, null, pretty ? 2 : undefined)

  if (wantGzip) {
    const gzBlob = await gzipText(jsonText)
    triggerDownload(gzBlob, baseName.endsWith(".gz") ? baseName : `${baseName}.json.gz`)
  } else {
    triggerDownload(
      new Blob([jsonText], { type: "application/json;charset=utf-8" }),
      baseName.endsWith(".json") ? baseName : `${baseName}.json`
    )
  }
  return data
}
