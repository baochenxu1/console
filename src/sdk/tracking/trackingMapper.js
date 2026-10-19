import {
  createInitialEliteRig,
  normalizeEliteRig as upgradeEliteRigStructure,
} from "../../core/faceDofMapper.js"
import { injectFrameDebugBrowIntoRig, resolveBrowFromRigPayload } from "./browDebugNormalize.js"
import { normalizeInputSource } from "./input/trackingInputFrame.js"
import { TRACKING_FRAME_TYPE, createEmptyRigFrame } from "./trackingTypes.js"

function clampSigned100(n) {
  return Math.max(-100, Math.min(100, Number(n) || 0))
}

function clampPct(n) {
  return Math.max(0, Math.min(100, Number(n) ?? 50))
}

function safeGazeNum(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) {
    return 0
  }
  return n
}

function safeGazeNumOrNull(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 保留 Python debug.gaze trace 字段（iris-only） */
function normalizeGazeDebug(gz) {
  if (!gz || typeof gz !== "object") {
    return undefined
  }
  const o = /** @type {Record<string, unknown>} */ (gz)
  const numKeys = [
    "irisLocalX",
    "irisLocalY",
    "irisLocalScale",
    "leftIrisLocalX",
    "leftIrisLocalY",
    "rightIrisLocalX",
    "rightIrisLocalY",
    "neutralIrisLocalX",
    "neutralIrisLocalY",
    "neutralIrisLocalScale",
    "irisLocalDx",
    "irisLocalDy",
    "irisGlobalDx",
    "irisGlobalDy",
    "irisLeftCx",
    "irisLeftCy",
    "irisRightCx",
    "irisRightCy",
    "irisCx",
    "irisCy",
    "irisScale",
    "neutralIrisCx",
    "neutralIrisCy",
    "neutralIrisScale",
    "irisXNorm",
    "irisYNorm",
    "candidateSharedRadarX",
    "candidateSharedRadarY",
    "emittedSharedRadarX",
    "emittedSharedRadarY",
    "sharedRadarX",
    "sharedRadarY",
    "irisInitSampleCount",
    "irisInitRequiredSamples",
    "irisInitRemainingMs",
    "landmarkCount",
  ]
  const out = {
    available: Boolean(o.available),
    irisOnlyActive: Boolean(o.irisOnlyActive),
    irisLocalMode: Boolean(o.irisLocalMode),
    gazeEstimatorMode: o.gazeEstimatorMode != null ? String(o.gazeEstimatorMode) : "",
    irisInitState: o.irisInitState != null ? String(o.irisInitState) : "",
    irisInitReady: Boolean(o.irisInitReady),
    outputMode: o.outputMode != null ? String(o.outputMode) : "",
    irisInvalidReason: o.irisInvalidReason != null ? String(o.irisInvalidReason) : "",
    safeCenterActive: Boolean(o.safeCenterActive),
  }
  for (const k of numKeys) {
    const v = safeGazeNumOrNull(o[k])
    if (v != null) {
      out[k] = v
    }
  }
  return out
}

/** @param {unknown} jg */
function normalizeJawGeometryDebug(jg) {
  if (!jg || typeof jg !== "object") {
    return undefined
  }
  const o = /** @type {Record<string, unknown>} */ (jg)
  const ns = o.neutralState && typeof o.neutralState === "object" ? o.neutralState : null
  const curve = o.curve && typeof o.curve === "object" ? o.curve : null
  const poseGate = o.poseGate && typeof o.poseGate === "object" ? o.poseGate : null
  return {
    enabled: Boolean(o.enabled),
    neutralReady: Boolean(o.neutralReady),
    semanticOpen: Number.isFinite(Number(o.semanticOpen)) ? Number(o.semanticOpen) : 0,
    rigWrite:
      Number.isFinite(Number(o.rigWrite))
        ? Number(o.rigWrite)
        : Number.isFinite(Number(o.rigWrite?.jaw))
          ? Number(o.rigWrite.jaw)
          : 0,
    smoothSemantic: Number.isFinite(Number(o.smoothSemantic)) ? Number(o.smoothSemantic) : 0,
    raw: Number.isFinite(Number(o.raw)) ? Number(o.raw) : Number.isFinite(Number(curve?.beforeCurve)) ? Number(curve?.beforeCurve) : 0,
    curved: Number.isFinite(Number(o.curved)) ? Number(o.curved) : Number.isFinite(Number(curve?.afterCurve)) ? Number(curve?.afterCurve) : 0,
    skipped: o.skipped != null ? String(o.skipped) : "",
    neutralState:
      ns && typeof ns === "object"
        ? {
            mode: String(ns.mode || "idle"),
            neutralReady: Boolean(ns.neutralReady),
            neutralCount: Number(ns.neutralCount) || 0,
            neutralWarmupCount: Number(ns.neutralWarmupCount) || 0,
          }
        : undefined,
    components: o.components && typeof o.components === "object" ? o.components : undefined,
    gating: o.gating && typeof o.gating === "object" ? o.gating : undefined,
    curve: curve || undefined,
    pose: o.pose && typeof o.pose === "object" ? o.pose : undefined,
    poseGate: poseGate || undefined,
    stabilizer:
      o.stabilizer && typeof o.stabilizer === "object" ? o.stabilizer : undefined,
    signConvention:
      o.signConvention && typeof o.signConvention === "object" ? o.signConvention : undefined,
    mouthScenario: o.mouthScenario != null ? String(o.mouthScenario) : undefined,
    noseAnchorMotion: o.noseAnchorMotion != null ? Boolean(o.noseAnchorMotion) : undefined,
    oldMouthPoseHeadMotionActive:
      o.oldMouthPoseHeadMotionActive != null ? Boolean(o.oldMouthPoseHeadMotionActive) : undefined,
    gateDecision:
      o.gateDecision && typeof o.gateDecision === "object" ? o.gateDecision : undefined,
    noseAnchor: o.noseAnchor && typeof o.noseAnchor === "object" ? o.noseAnchor : undefined,
  }
}

/** @param {unknown} na */
function normalizeNoseAnchorDebug(na) {
  if (!na || typeof na !== "object") {
    return undefined
  }
  const o = /** @type {Record<string, unknown>} */ (na)
  const obj = (v) => (v && typeof v === "object" ? v : undefined)
  return {
    enabled: Boolean(o.enabled),
    ok: Boolean(o.ok),
    coordinateMode: o.coordinateMode != null ? String(o.coordinateMode) : undefined,
    center: obj(o.center),
    scale: Number.isFinite(Number(o.scale)) ? Number(o.scale) : 0,
    vector: obj(o.vector),
    neutral: obj(o.neutral),
    neutralReady: Boolean(o.neutralReady),
    neutralState: obj(o.neutralState),
    calibrating: Boolean(o.calibrating),
    delta: obj(o.delta),
    motionScore: Number.isFinite(Number(o.motionScore)) ? Number(o.motionScore) : 0,
    motionActive: Boolean(o.motionActive),
    thresholds: obj(o.thresholds),
    error: o.error != null ? String(o.error) : "",
  }
}

/** @param {unknown} lg */
function lipAxisNum(lg, group, key) {
  if (!lg || typeof lg !== "object") {
    return null
  }
  const o = /** @type {Record<string, unknown>} */ (lg)
  const g = o[group]
  if (g && typeof g === "object") {
    const v = /** @type {Record<string, unknown>} */ (g)[key]
    if (Number.isFinite(Number(v))) {
      return Number(v)
    }
  }
  return null
}

/** @param {unknown} lg */
function lipAxisStage(o, includeScore = false) {
  if (!o || typeof o !== "object") {
    return undefined
  }
  const stage = {
    upperL: safeGazeNum(o.upperL),
    upperR: safeGazeNum(o.upperR),
    lowerL: safeGazeNum(o.lowerL),
    lowerR: safeGazeNum(o.lowerR),
  }
  if (includeScore && o.rawMouthScore != null) {
    stage.rawMouthScore = safeGazeNum(o.rawMouthScore)
  }
  return stage
}

/** @param {unknown} md */
function normalizeMouthDebug(md) {
  if (!md || typeof md !== "object") {
    return undefined
  }
  const o = /** @type {Record<string, unknown>} */ (md)
  const geo = o.geometryRaw
  if (!geo || typeof geo !== "object") {
    return undefined
  }
  const g = /** @type {Record<string, unknown>} */ (geo)
  const rel = o.relative && typeof o.relative === "object" ? o.relative : null
  return {
    geometryRaw: {
      upperL: safeGazeNum(g.upperL),
      upperR: safeGazeNum(g.upperR),
      lowerL: safeGazeNum(g.lowerL),
      lowerR: safeGazeNum(g.lowerR),
      aperture: safeGazeNum(g.aperture),
      upperLip: safeGazeNum(g.upperLip),
      lowerLip: safeGazeNum(g.lowerLip),
      pucker: safeGazeNum(g.pucker),
      funnel: safeGazeNum(g.funnel),
    },
    relative: rel
      ? {
          upperL: safeGazeNum(rel.upperL),
          upperR: safeGazeNum(rel.upperR),
          lowerL: safeGazeNum(rel.lowerL),
          lowerR: safeGazeNum(rel.lowerR),
          aperture: safeGazeNum(rel.aperture),
        }
      : undefined,
    normalizedBeforeClamp: lipAxisStage(o.normalizedBeforeClamp, true),
    normalizedAfterClamp: lipAxisStage(o.normalizedAfterClamp, true),
    final: lipAxisStage(o.final),
  }
}

function normalizeLipGeometryDebug(lg) {
  if (!lg || typeof lg !== "object") {
    return undefined
  }
  const o = /** @type {Record<string, unknown>} */ (lg)
  const pickSmooth = (k) => {
    const fromGroup = lipAxisNum(o, "deltaSmooth", k)
    if (fromGroup != null) {
      return fromGroup
    }
    const flat = o[k]
    if (Number.isFinite(Number(flat))) {
      return Number(flat)
    }
    return 0
  }
  const pickRaw = (k) => {
    const fromGroup = lipAxisNum(o, "deltaRaw", k)
    if (fromGroup != null) {
      return fromGroup
    }
    const legacy = o[`${k}Raw`] ?? o[`${k === "upperL" ? "upperLRaw" : k}`]
    if (k === "upperR" && o.upperRRaw != null) {
      return safeGazeNum(o.upperRRaw)
    }
    if (k === "lowerR" && o.lowerRRaw != null) {
      return safeGazeNum(o.lowerRRaw)
    }
    if (k === "upperL" && o.upperLRaw != null) {
      return safeGazeNum(o.upperLRaw)
    }
    if (k === "lowerL" && o.lowerLRaw != null) {
      return safeGazeNum(o.lowerLRaw)
    }
    return 0
  }
  const axis4 = (group) => ({
    upperL: lipAxisNum(o, group, "upperL") ?? 0,
    upperR: lipAxisNum(o, group, "upperR") ?? 0,
    lowerL: lipAxisNum(o, group, "lowerL") ?? 0,
    lowerR: lipAxisNum(o, group, "lowerR") ?? 0,
  })
  return {
    enabled: Boolean(o.enabled),
    neutralReady: Boolean(o.neutralReady),
    neutralCount:
      typeof o.neutralCount === "number" && Number.isFinite(o.neutralCount) ? o.neutralCount : 0,
    mouthWidth: safeGazeNum(o.mouthWidth),
    deltaSmooth: {
      upperL: pickSmooth("upperL"),
      upperR: pickSmooth("upperR"),
      lowerL: pickSmooth("lowerL"),
      lowerR: pickSmooth("lowerR"),
    },
    deltaRaw: {
      upperL: pickRaw("upperL"),
      upperR: pickRaw("upperR"),
      lowerL: pickRaw("lowerL"),
      lowerR: pickRaw("lowerR"),
    },
    deltaAfterPoseGate: axis4("deltaAfterPoseGate"),
    currentY: axis4("currentY"),
    neutralY: axis4("neutralY"),
    rigWrite: axis4("rigWrite"),
    blendshapeTerm: axis4("blendshapeTerm"),
    skipped: o.skipped != null ? String(o.skipped) : "",
    isolation:
      typeof o.isolation === "number" && Number.isFinite(o.isolation) ? o.isolation : undefined,
    crossTalk:
      o.crossTalk && typeof o.crossTalk === "object"
        ? {
            suppressedUpper: Boolean(o.crossTalk.suppressedUpper),
            suppressedLower: Boolean(o.crossTalk.suppressedLower),
          }
        : undefined,
    sourceBreakdown:
      o.sourceBreakdown && typeof o.sourceBreakdown === "object" ? o.sourceBreakdown : undefined,
    coordinateMode: o.coordinateMode != null ? String(o.coordinateMode) : undefined,
    pose: o.pose && typeof o.pose === "object" ? o.pose : undefined,
    poseNeutral: o.poseNeutral && typeof o.poseNeutral === "object" ? o.poseNeutral : undefined,
    poseGate: o.poseGate && typeof o.poseGate === "object" ? o.poseGate : undefined,
    closedHeadTurnLock:
      o.closedHeadTurnLock && typeof o.closedHeadTurnLock === "object"
        ? o.closedHeadTurnLock
        : undefined,
    gateDecision:
      o.gateDecision && typeof o.gateDecision === "object" ? o.gateDecision : undefined,
    mouthScenario: o.mouthScenario != null ? String(o.mouthScenario) : undefined,
    noseAnchorMotion: o.noseAnchorMotion != null ? Boolean(o.noseAnchorMotion) : undefined,
    noseAnchor: o.noseAnchor && typeof o.noseAnchor === "object" ? o.noseAnchor : undefined,
    signConvention:
      o.signConvention && typeof o.signConvention === "object"
        ? {
            upperOpenPositive: Boolean(o.signConvention.upperOpenPositive),
            lowerOpenNegative: Boolean(o.signConvention.lowerOpenNegative),
            upperSign: safeGazeNum(o.signConvention.upperSign) || 1,
            lowerSign: safeGazeNum(o.signConvention.lowerSign) || 1,
            yAxisTowardChin: Boolean(o.signConvention.yAxisTowardChin),
          }
        : undefined,
    neutralState:
      o.neutralState && typeof o.neutralState === "object"
        ? {
            mode: String(o.neutralState.mode || "idle"),
            neutralReady: Boolean(o.neutralState.neutralReady),
            neutralCount: Number(o.neutralState.neutralCount) || 0,
            neutralWarmupCount: Number(o.neutralState.neutralWarmupCount) || 0,
            stableCount: Number(o.neutralState.stableCount) || 0,
            autoCalibrateRequested: Boolean(o.neutralState.autoCalibrateRequested),
            forceRecalibrate: Boolean(o.neutralState.forceRecalibrate),
            lastCalibratedAt: safeGazeNum(o.neutralState.lastCalibratedAt),
          }
        : undefined,
    driftCorrection:
      o.driftCorrection && typeof o.driftCorrection === "object"
        ? {
            enabled: Boolean(o.driftCorrection.enabled),
            allowed: Boolean(o.driftCorrection.allowed),
            updated: Boolean(o.driftCorrection.updated),
            reason: String(o.driftCorrection.reason || ""),
            stepUpperL: safeGazeNum(o.driftCorrection.stepUpperL),
            stepUpperR: safeGazeNum(o.driftCorrection.stepUpperR),
            stepLowerL: safeGazeNum(o.driftCorrection.stepLowerL),
            stepLowerR: safeGazeNum(o.driftCorrection.stepLowerR),
          }
        : undefined,
    stabilizer:
      o.stabilizer && typeof o.stabilizer === "object"
        ? {
            lockedToZero: o.stabilizer.lockedToZero || {},
            raw: o.stabilizer.raw || {},
            smooth: o.stabilizer.smooth || {},
            velocity: o.stabilizer.velocity || {},
            alpha: o.stabilizer.alpha || {},
          }
        : undefined,
    lipPipeline:
      o.lipPipeline && typeof o.lipPipeline === "object"
        ? {
            raw: o.lipPipeline.raw || o.deltaRaw || undefined,
            afterSoftDeadzone: o.lipPipeline.afterSoftDeadzone || undefined,
            afterSmallMotionBoost: o.lipPipeline.afterSmallMotionBoost || undefined,
            afterGain: o.lipPipeline.afterGain || undefined,
            afterGate: o.lipPipeline.afterGate || o.deltaAfterPoseGate || undefined,
            afterSmooth: o.lipPipeline.afterSmooth || o.deltaSmooth || undefined,
            final: o.lipPipeline.final || o.rigWrite || undefined,
          }
        : undefined,
    upperL: pickSmooth("upperL"),
    upperR: pickSmooth("upperR"),
    lowerL: pickSmooth("lowerL"),
    lowerR: pickSmooth("lowerR"),
    upperLRaw: pickRaw("upperL"),
    upperRRaw: pickRaw("upperR"),
    lowerLRaw: pickRaw("lowerL"),
    lowerRRaw: pickRaw("lowerR"),
  }
}

/**
 * 将任意 JSON 中的 rig 片段归一成与 createInitialEliteRig 一致的结构。
 * @param {unknown} raw
 */
export function normalizeEliteRig(raw, debug = null) {
  const base = createInitialEliteRig()
  if (!raw || typeof raw !== "object") {
    return base
  }
  const o = raw
  const browResolved = resolveBrowFromRigPayload(o)
  const injected = injectFrameDebugBrowIntoRig(
    {
      ...base,
      ...o,
      browL: {
        tip: clampSigned100(browResolved.browL.tip),
        tipA: clampSigned100(browResolved.browL.tipA ?? browResolved.browL.tip),
        tipB: clampSigned100(browResolved.browL.tipB ?? 0),
        x: clampSigned100(browResolved.browL.x ?? browResolved.browL.tipB ?? 0),
        y: clampSigned100(browResolved.browL.y ?? browResolved.browL.tipA ?? browResolved.browL.tip ?? 0),
        mid: clampSigned100(browResolved.browL.mid),
        tail: clampSigned100(browResolved.browL.tail),
      },
      browR: {
        tip: clampSigned100(browResolved.browR.tip),
        tipA: clampSigned100(browResolved.browR.tipA ?? browResolved.browR.tip),
        tipB: clampSigned100(browResolved.browR.tipB ?? 0),
        x: clampSigned100(browResolved.browR.x ?? browResolved.browR.tipB ?? 0),
        y: clampSigned100(browResolved.browR.y ?? browResolved.browR.tipA ?? browResolved.browR.tip ?? 0),
        mid: clampSigned100(browResolved.browR.mid),
        tail: clampSigned100(browResolved.browR.tail),
      },
      eyeL: {
        up: clampSigned100(o.eyeL?.up),
        lo: clampSigned100(o.eyeL?.lo),
        // 若服务端已给左右独立坐标则保留；否则由 upgrade 从 sharedRadar 镜像
        ...(o.eyeL?.x != null ? { x: clampPct(o.eyeL.x) } : {}),
        ...(o.eyeL?.y != null ? { y: clampPct(o.eyeL.y) } : {}),
      },
      eyeR: {
        up: clampSigned100(o.eyeR?.up),
        lo: clampSigned100(o.eyeR?.lo),
        ...(o.eyeR?.x != null ? { x: clampPct(o.eyeR.x) } : {}),
        ...(o.eyeR?.y != null ? { y: clampPct(o.eyeR.y) } : {}),
      },
      sharedRadar: {
        x: clampPct(o.sharedRadar?.x ?? o.eye_xy?.x),
        y: clampPct(o.sharedRadar?.y ?? o.eye_xy?.y),
      },
      // 鼻子仅向上 0～100
      noseL: { val: Math.max(0, clampSigned100(o.noseL?.val)) },
      noseR: { val: Math.max(0, clampSigned100(o.noseR?.val)) },
      mouth: {
        UL: clampSigned100(o.mouth?.UL),
        UR: clampSigned100(o.mouth?.UR),
        LL: clampSigned100(o.mouth?.LL),
        LR: clampSigned100(o.mouth?.LR),
        sideL: {
          x: clampPct(o.mouth?.sideL?.x),
          y: clampPct(o.mouth?.sideL?.y),
        },
        sideR: {
          x: clampPct(o.mouth?.sideR?.x),
          y: clampPct(o.mouth?.sideR?.y),
        },
      },
      // tongue 入站忽略（不下发）；保留 0 以免旧链路误驱动
      tongue: { val: 0 },
      jaw: {
        val: clampSigned100(o.jaw?.val),
        lateral: Math.max(-50, Math.min(50, clampSigned100(o.jaw?.lateral ?? 0))),
      },
    },
    debug
  )

  // sharedRadar / 旧 eye_xy → eyeL+eyeR 镜像；补齐 nose / jaw.lateral
  return upgradeEliteRigStructure(injected.rig)
}

/**
 * 校验并归一 WebSocket / 外部 JSON 为 RigFrame；不合法时返回 null。
 * @param {unknown} data
 * @returns {import("./trackingTypes.js").RigFrame | null}
 */
export function normalizeRigFrameMessage(data) {
  if (!data || typeof data !== "object") {
    return null
  }
  if (data.type !== TRACKING_FRAME_TYPE) {
    return null
  }
  const source = typeof data.source === "string" ? data.source : "unknown"
  const timestampMs = Number.isFinite(Number(data.timestampMs)) ? Number(data.timestampMs) : performance.now()
  const frameSeq = Number.isFinite(Number(data.frameSeq)) ? Number(data.frameSeq) : undefined
  const serverSentAtMs =
    data.serverSentAtMs != null && Number.isFinite(Number(data.serverSentAtMs))
      ? Number(data.serverSentAtMs)
      : undefined
  const faceDetected = data.faceDetected !== false
  const quality =
    typeof data.quality === "number" && Number.isFinite(data.quality)
      ? Math.max(0, Math.min(1, data.quality))
      : 0
  const rig = normalizeEliteRig(data.rig, data.debug)

  /** @type {import("./trackingTypes.js").RigFrame["debug"] | undefined} */
  let debug
  if (data.debug && typeof data.debug === "object") {
    const b = data.debug.blendshapes
    const m = data.debug.mapping
    const blendshapes =
      b && typeof b === "object"
        ? {
            jawOpen: safeBlendNum(b.jawOpen),
            eyeBlinkLeft: safeBlendNum(b.eyeBlinkLeft),
            eyeBlinkRight: safeBlendNum(b.eyeBlinkRight),
            eyeWideLeft: safeBlendNum(b.eyeWideLeft),
            eyeWideRight: safeBlendNum(b.eyeWideRight),
            mouthSmileLeft: safeBlendNum(b.mouthSmileLeft),
            mouthSmileRight: safeBlendNum(b.mouthSmileRight),
            mouthUpperUpLeft: safeBlendNum(b.mouthUpperUpLeft),
            mouthUpperUpRight: safeBlendNum(b.mouthUpperUpRight),
            mouthLowerDownLeft: safeBlendNum(b.mouthLowerDownLeft),
            mouthLowerDownRight: safeBlendNum(b.mouthLowerDownRight),
            mouthPucker: safeBlendNum(b.mouthPucker),
            mouthFunnel: safeBlendNum(b.mouthFunnel),
            mouthClose: safeBlendNum(b.mouthClose),
            browInnerUp: safeBlendNum(b.browInnerUp),
            browOuterUpLeft: safeBlendNum(b.browOuterUpLeft),
            browOuterUpRight: safeBlendNum(b.browOuterUpRight),
          }
        : undefined
    const mapping =
      m && typeof m === "object"
        ? {
            jaw: safeMapNum(m.jaw),
            blinkLeft: safeMapNum(m.blinkLeft),
            blinkRight: safeMapNum(m.blinkRight),
            smileLeft: safeMapNum(m.smileLeft),
            smileRight: safeMapNum(m.smileRight),
            browLeft: safeMapNum(m.browLeft),
            browRight: safeMapNum(m.browRight),
            eyeOpenBiasLeft: safeMapNum(m.eyeOpenBiasLeft),
            eyeOpenBiasRight: safeMapNum(m.eyeOpenBiasRight),
            eyeLUp: safeMapNum(m.eyeLUp),
            eyeLLo: safeMapNum(m.eyeLLo),
            eyeRUp: safeMapNum(m.eyeRUp),
            eyeRLo: safeMapNum(m.eyeRLo),
            browInner: safeMapNum(m.browInner),
            browOuterLeft: safeMapNum(m.browOuterLeft),
            browOuterRight: safeMapNum(m.browOuterRight),
            browLeftTip: safeMapNum(m.browLeftTip),
            browLeftMid: safeMapNum(m.browLeftMid),
            browLeftTail: safeMapNum(m.browLeftTail),
            browRightTip: safeMapNum(m.browRightTip),
            browRightMid: safeMapNum(m.browRightMid),
            browRightTail: safeMapNum(m.browRightTail),
            upperLipLeft: safeMapNum(m.upperLipLeft),
            upperLipRight: safeMapNum(m.upperLipRight),
            lowerLipLeft: safeMapNum(m.lowerLipLeft),
            lowerLipRight: safeMapNum(m.lowerLipRight),
            lipGeoUpperL: safeMapNum(m.lipGeoUpperL),
            lipGeoUpperR: safeMapNum(m.lipGeoUpperR),
            lipGeoLowerL: safeMapNum(m.lipGeoLowerL),
            lipGeoLowerR: safeMapNum(m.lipGeoLowerR),
            mouthPucker: safeMapNum(m.mouthPucker),
            mouthFunnel: safeMapNum(m.mouthFunnel),
            ...(Number.isFinite(Number(m.eyeLookX)) ? { eyeLookX: Number(m.eyeLookX) } : {}),
            ...(Number.isFinite(Number(m.eyeLookY)) ? { eyeLookY: Number(m.eyeLookY) } : {}),
            ...(Number.isFinite(Number(m.sharedRadarX)) ? { sharedRadarX: Number(m.sharedRadarX) } : {}),
            ...(Number.isFinite(Number(m.sharedRadarY)) ? { sharedRadarY: Number(m.sharedRadarY) } : {}),
          }
        : undefined

    const lipGeometry = normalizeLipGeometryDebug(data.debug.lipGeometry)
    const mouthDebug =
      normalizeMouthDebug(data.debug.mouthDebug) ??
      normalizeMouthDebug(
        data.debug.lipGeometry && typeof data.debug.lipGeometry === "object"
          ? data.debug.lipGeometry.mouthDebug
          : undefined,
      )
    const jawGeometry = normalizeJawGeometryDebug(data.debug.jawGeometry)
    const noseAnchor = normalizeNoseAnchorDebug(data.debug.noseAnchor)
    const mouthScenarioClassifier =
      data.debug.mouthScenarioClassifier && typeof data.debug.mouthScenarioClassifier === "object"
        ? data.debug.mouthScenarioClassifier
        : undefined
    const mouthCornerGeometry =
      data.debug.mouthCornerGeometry && typeof data.debug.mouthCornerGeometry === "object"
        ? data.debug.mouthCornerGeometry
        : undefined
    const browGate =
      data.debug.browGate && typeof data.debug.browGate === "object"
        ? data.debug.browGate
        : undefined
    const brow =
      data.debug.brow && typeof data.debug.brow === "object" ? data.debug.brow : undefined
    const inputSource =
      normalizeInputSource(data.debug?.inputSource) ??
      normalizeInputSource(
        data.inputSource && typeof data.inputSource === "object" ? data.inputSource : undefined,
      )

    const gz = data.debug.gaze
    const gaze = normalizeGazeDebug(gz)

    const pr = data.debug && typeof data.debug === "object" ? data.debug.performance : null
    const trackingDebug =
      data.debug?.trackingDebug && typeof data.debug.trackingDebug === "object"
        ? data.debug.trackingDebug
        : undefined
    /** @type {Record<string, number | null> | undefined} */
    let performance
    if (pr && typeof pr === "object") {
      const num = (k) => {
        const v = pr[k]
        return typeof v === "number" && Number.isFinite(v) ? v : null
      }
      performance = {
        captureMs: num("captureMs"),
        capReadMs: num("capReadMs"),
        preprocessMs: num("preprocessMs"),
        inferenceMs: num("inferenceMs"),
        mappingMs: num("mappingMs"),
        broadcastMs: num("broadcastMs"),
        loopMs: num("loopMs"),
        jsonEncodeMs: num("jsonEncodeMs"),
        encodeMs: num("encodeMs"),
        sleepMs: num("sleepMs"),
        totalPeriodMs: num("totalPeriodMs"),
        targetIntervalMs: num("targetIntervalMs"),
        fps: num("fps"),
        broadcastFps: num("broadcastFps"),
        broadcastFrameSeq: num("broadcastFrameSeq"),
        captureFps: num("captureFps"),
        inferenceFps: num("inferenceFps"),
        mappingFps: num("mappingFps"),
        generatedFrameFps: num("generatedFrameFps"),
        jsonEncodeFps: num("jsonEncodeFps"),
        broadcastAttemptFps: num("broadcastAttemptFps"),
        broadcastSuccessFps: num("broadcastSuccessFps"),
        perClientSendFps: num("perClientSendFps"),
        clientCount: num("clientCount"),
        frameSeq: num("frameSeq"),
        broadcastSeq: num("broadcastSeq"),
      }
    }

    if (
      blendshapes ||
      mapping ||
      gaze ||
      lipGeometry ||
      mouthDebug ||
      jawGeometry ||
      noseAnchor ||
      mouthScenarioClassifier ||
      mouthCornerGeometry ||
      browGate ||
      brow ||
      performance ||
      inputSource ||
      trackingDebug ||
      (data.debug?.videoPlayback && typeof data.debug.videoPlayback === "object")
    ) {
      debug = {}
      if (blendshapes) {
        debug.blendshapes = blendshapes
      }
      if (mapping) {
        debug.mapping = mapping
      }
      if (gaze) {
        debug.gaze = gaze
      }
      if (lipGeometry) {
        debug.lipGeometry = lipGeometry
      }
      if (mouthDebug) {
        debug.mouthDebug = mouthDebug
      }
      if (jawGeometry) {
        debug.jawGeometry = jawGeometry
      }
      if (noseAnchor) {
        debug.noseAnchor = noseAnchor
      }
      if (mouthScenarioClassifier) {
        debug.mouthScenarioClassifier = mouthScenarioClassifier
      }
      if (mouthCornerGeometry) {
        debug.mouthCornerGeometry = mouthCornerGeometry
      }
      if (browGate) {
        debug.browGate = browGate
      }
      if (brow) {
        debug.brow = brow
      }
      if (performance) {
        debug.performance = performance
      }
      if (inputSource) {
        debug.inputSource = inputSource
      }
      if (trackingDebug) {
        debug.trackingDebug = trackingDebug
      }
      const videoPlayback =
        data.debug?.videoPlayback && typeof data.debug.videoPlayback === "object"
          ? data.debug.videoPlayback
          : undefined
      if (videoPlayback) {
        debug.videoPlayback = videoPlayback
      }
    }
  }

  /** @type {import("./trackingTypes.js").RigFrame} */
  const out = {
    type: TRACKING_FRAME_TYPE,
    source,
    timestampMs,
    faceDetected,
    quality,
    rig,
    ...(debug ? { debug } : {}),
  }
  if (frameSeq !== undefined) {
    out.frameSeq = frameSeq
  }
  if (serverSentAtMs !== undefined) {
    out.serverSentAtMs = serverSentAtMs
  }
  const diagnostic =
    data.diagnostic && typeof data.diagnostic === "object"
      ? data.diagnostic
      : undefined
  if (diagnostic) {
    out.diagnostic = diagnostic
  }
  return out
}

function safeBlendNum(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) {
    return 0
  }
  return Math.max(0, Math.min(1, n))
}

function safeMapNum(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) {
    return 0
  }
  return n
}

/** 容错：若无 type 但含 rig，则补上 type（便于测试网关）。 */
export function coerceToRigFrame(data) {
  const direct = normalizeRigFrameMessage(data)
  if (direct) {
    return direct
  }
  if (data && typeof data === "object" && data.rig && typeof data.rig === "object") {
    return normalizeRigFrameMessage({
      ...createEmptyRigFrame(),
      ...data,
      type: TRACKING_FRAME_TYPE,
      rig: data.rig,
    })
  }
  return null
}
