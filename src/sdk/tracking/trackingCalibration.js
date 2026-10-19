import { createInitialEliteRig } from "../../core/faceDofMapper.js"
import {
  DEFAULT_EYE_CALIBRATION,
  createEyeTrackState,
  eyeBlinkProxy,
  resetEyeTrackState,
  snapshotEyeBalanceGains,
  snapshotEyeReleaseState,
  stabilizeEyeSide,
  updatePairedReleaseState,
} from "./eyeReleaseStabilizer.js"
import { stabilizeEyesNormal } from "./eyeNormalStabilizer.js"
import { stabilizeEyeXY, DEFAULT_EYE_XY_STABILIZATION } from "./eyeXYStabilizer.js"
import { applyBrowGateTransition, DEFAULT_BROW_GATE_TRANSITION } from "./browGateTransition.js"
import { applyMouthScenarioTransition, DEFAULT_MOUTH_SCENARIO_TRANSITION } from "./mouthScenarioTransition.js"
import { applyLipOutputLimits, LIP_FINAL_ABS_LIMIT, LIP_GLOBAL_SCALE } from "./lipOutputLimits.js"
import { injectFrameDebugBrowIntoRig, applyRuntimeBrowToRigIfGatePass, applyUpperFaceMicroJitterFilter } from "./browDebugNormalize.js"
import { TRACKING_FRAME_TYPE, createEmptyRigFrame } from "./trackingTypes.js"

/** 眉毛 signed 通道专用稳定（零点死区 + 迟滞 + 自适应 EMA） */
export const DEFAULT_BROW_STABILIZATION = {
  enabled: true,
  /** |v| ≤ enter 时视为进入零点区 */
  zeroEnter: 3,
  /** 自零点区离开需 |v| ≥ exit（exit > enter，迟滞） */
  zeroExit: 5,
  /** 滤波后 |v| < snap 则钳为 0（tracking 宜小，避免抹掉微动） */
  snapToZero: 1,
  /** 零点附近滤波（tracking 需更快跟上） */
  alphaNearZero: 0.52,
  /** 大幅表情弱滤波（保持响应） */
  alphaLarge: 0.9,
  /** |v| 低于此用 alphaNearZero */
  motionThreshold: 6,
  /** |v| 高于此用 alphaLarge */
  motionFull: 24,
  /** 每帧最大 control 变化；最终输出仍由 applyRuntimeBrowToRigIfGatePass 直通 */
  maxControlDeltaPerFrame: 28,
}

/** Start / Stop / Set Neutral 时重置 eye release 状态机 */
export function resetTrackingEyeReleaseState(calibration) {
  const cal = calibration ?? createDefaultTrackingCalibration()
  cal.eyeState = resetEyeTrackState(cal.eyeState ?? createEyeTrackState())
  return cal
}

export function createDefaultTrackingCalibration() {
  return {
    smoothing: {
      enabled: false,
      alpha: 0.6,
    },
    deadzone: {
      enabled: true,
      defaultValue: 0.03,
    },
    gains: {},
    invert: {},
    brow: { ...DEFAULT_BROW_STABILIZATION },
    browGate: { ...DEFAULT_BROW_GATE_TRANSITION },
    mouthScenario: { ...DEFAULT_MOUTH_SCENARIO_TRANSITION },
    lipOutput: {
      globalScale: LIP_GLOBAL_SCALE,
      absLimit: LIP_FINAL_ABS_LIMIT,
    },
    eyeXY: { ...DEFAULT_EYE_XY_STABILIZATION },
    eye: { ...DEFAULT_EYE_CALIBRATION },
    eyeState: createEyeTrackState(),
  }
}

/** @param {number} prev @param {number} next @param {number} alpha */
function ema(prev, next, alpha) {
  const a = Math.max(0, Math.min(1, alpha))
  return prev + a * (next - prev)
}

function applyDeadzone(prev, next, enabled, dzNorm) {
  if (!enabled) {
    return next
  }
  const thr = dzNorm * 100
  if (Math.abs(next - prev) < thr) {
    return prev
  }
  return next
}

function smoothSigned(prev, next, cal) {
  const raw = applyDeadzone(prev, next, cal.deadzone.enabled, cal.deadzone.defaultValue)
  if (!cal.smoothing.enabled) {
    return raw
  }
  return ema(prev, raw, cal.smoothing.alpha)
}

function smoothPct(prev, next, cal) {
  const raw = applyDeadzone(prev, next, cal.deadzone.enabled, cal.deadzone.defaultValue)
  if (!cal.smoothing.enabled) {
    return raw
  }
  return ema(prev, raw, cal.smoothing.alpha)
}

/**
 * @param {typeof DEFAULT_BROW_STABILIZATION} cfg
 */
function browAdaptiveAlpha(magnitude, cfg) {
  const t0 = Math.max(0, Number(cfg.motionThreshold) || 12)
  const t1 = Math.max(t0 + 1e-6, Number(cfg.motionFull) || 38)
  const a0 = Math.max(0, Math.min(1, Number(cfg.alphaNearZero) ?? 0.2))
  const a1 = Math.max(0, Math.min(1, Number(cfg.alphaLarge) ?? 0.78))
  const mag = Math.max(0, Math.abs(magnitude))
  if (mag <= t0) {
    return a0
  }
  if (mag >= t1) {
    return a1
  }
  const t = (mag - t0) / (t1 - t0)
  return a0 + t * (a1 - a0)
}

/**
 * 零点迟滞：小幅度在 0 附近锁零，离开需超过 exit。
 * @param {typeof DEFAULT_BROW_STABILIZATION} cfg
 */
function applyBrowZeroHysteresis(prev, next, cfg) {
  const enter = Math.max(0, Number(cfg.zeroEnter) ?? 5)
  const exit = Math.max(enter + 1e-6, Number(cfg.zeroExit) ?? 8)
  const an = Math.abs(next)
  const ap = Math.abs(prev)

  if (an <= enter) {
    return 0
  }
  if (ap < exit && an < exit) {
    return 0
  }
  return next
}

/**
 * 眉毛 signed 通道：专用稳定，不沿用全局 smoothing.alpha。
 * @param {typeof DEFAULT_BROW_STABILIZATION} browCfg
 */
function smoothBrowSigned(prev, next, cal, browCfg) {
  if (!browCfg?.enabled) {
    return smoothSigned(prev, next, cal)
  }

  const target = applyBrowZeroHysteresis(prev, next, browCfg)
  const motionHint = Math.max(Math.abs(target), Math.abs(target - prev) * 1.25)
  const alpha = browAdaptiveAlpha(motionHint, browCfg)
  let out = ema(prev, target, alpha)

  const snap = Math.max(0, Number(browCfg.snapToZero) ?? 2.5)
  if (Math.abs(out) < snap) {
    out = 0
  }

  const maxDelta = Math.max(0, Number(browCfg.maxControlDeltaPerFrame) ?? 8)
  if (maxDelta > 0) {
    const delta = Math.max(-maxDelta, Math.min(maxDelta, out - prev))
    out = prev + delta
  }
  return out
}

/** iris-only 模式：服务端已输出 sharedRadar，前端不再二次校准/稳定。 */
export function isIrisOnlyGaze(gaze) {
  if (!gaze || typeof gaze !== "object") return false
  if (String(gaze.gazeEstimatorMode || "") === "mediapipe_iris_only_v1") return true
  return gaze.irisOnlyActive === true && gaze.irisLocalMode === true
}

/** @param {ReturnType<typeof createInitialEliteRig>} prevRig @param {ReturnType<typeof createInitialEliteRig>} nextRig @param {ReturnType<typeof createDefaultTrackingCalibration>} cal @param {object} [frameCtx] */
function smoothRig(prevRig, nextRig, cal, frameCtx = null) {
  const p = prevRig
  const n = nextRig
  const browCfg = cal.brow ?? DEFAULT_BROW_STABILIZATION
  const browGateCfg = cal.browGate ?? DEFAULT_BROW_GATE_TRANSITION
  const eyeXYCfg = cal.eyeXY ?? DEFAULT_EYE_XY_STABILIZATION
  const eyeCfg = cal.eye ?? DEFAULT_EYE_CALIBRATION
  const eyeState = cal.eyeState ?? createEyeTrackState()
  cal.eyeState = eyeState

  const browGateDebug = frameCtx?.browGate || null
  const browTransition = applyBrowGateTransition(p, n, browGateDebug, eyeState, browGateCfg)
  const nBrow = browTransition.rig

  let eyeL = { up: p.eyeL.up, lo: p.eyeL.lo }
  let eyeR = { up: p.eyeR.up, lo: p.eyeR.lo }
  let eyeTrackDebug = null

  if (eyeCfg.enabled !== false) {
    const blend = frameCtx?.blendshapes || {}
    const blinkCtx = {
      blinkBlendL: Number(blend.eyeBlinkLeft) || 0,
      blinkBlendR: Number(blend.eyeBlinkRight) || 0,
    }

    if (eyeCfg.releaseEnabled === false) {
      const normal = stabilizeEyesNormal(p.eyeL, p.eyeR, n.eyeL, n.eyeR, eyeCfg, eyeState, blinkCtx)
      eyeL = normal.eyeL
      eyeR = normal.eyeR
      eyeTrackDebug = {
        left: normal.left,
        right: normal.right,
        eyeNormalDebug: normal.debug.eyeNormalDebug || normal.debug,
        eyeLatencyDebug: normal.debug.eyeLatencyDebug || null,
        balanceGains: snapshotEyeBalanceGains(eyeCfg),
        eyeReleaseDebug: {
          releaseEnabled: false,
          bypassed: true,
          blinkActive: normal.debug.blinkActive,
        },
      }
    } else {
    const pairedCtx = {
      rawBlinkProxyL: eyeBlinkProxy(n.eyeL.up, n.eyeL.lo),
      rawBlinkProxyR: eyeBlinkProxy(n.eyeR.up, n.eyeR.lo),
    }
    const sharedRelease = updatePairedReleaseState(eyeState, pairedCtx, eyeCfg)
    const l = stabilizeEyeSide(p.eyeL, n.eyeL, eyeCfg, eyeState, "L", sharedRelease)
    const r = stabilizeEyeSide(p.eyeR, n.eyeR, eyeCfg, eyeState, "R", sharedRelease)
    eyeL = { up: l.up, lo: l.lo }
    eyeR = { up: r.up, lo: r.lo }
    const pairedBlinkActive = Boolean(sharedRelease?.pairedBlinkActive)
    eyeTrackDebug = {
      left: l.debug,
      right: r.debug,
      releaseState: snapshotEyeReleaseState(eyeState),
      balanceGains: snapshotEyeBalanceGains(eyeCfg),
      eyeReleaseDebug: {
        releaseEnabled: eyeCfg.releaseEnabled !== false,
        bypassed: eyeCfg.releaseEnabled === false || Boolean(sharedRelease?.bypassed),
        rawBlinkProxyLeft: pairedCtx.rawBlinkProxyL,
        rawBlinkProxyRight: pairedCtx.rawBlinkProxyR,
        neutralBlinkProxyLeft: sharedRelease?.neutralBlinkProxyLeft ?? eyeState.neutralBlinkProxyL,
        neutralBlinkProxyRight: sharedRelease?.neutralBlinkProxyRight ?? eyeState.neutralBlinkProxyR,
        blinkDepthLeft: sharedRelease?.blinkDepthLeft ?? 0,
        blinkDepthRight: sharedRelease?.blinkDepthRight ?? 0,
        gainAdjustedBlinkProxyLeft: l.debug.gainAdjustedBlinkProxy,
        gainAdjustedBlinkProxyRight: r.debug.gainAdjustedBlinkProxy,
        releaseDepthProxy: sharedRelease?.releaseDepthProxy ?? 0,
        releaseDepthProxyDelta: sharedRelease?.releaseDepthProxyDelta ?? 0,
        releaseStartCandidateCount: sharedRelease?.releaseStartCandidateCount ?? 0,
        latchCandidateCount: sharedRelease?.latchCandidateCount ?? 0,
        releaseRefractoryFramesLeft: sharedRelease?.releaseRefractoryFramesLeft ?? 0,
        activeReleaseFrameCount: sharedRelease?.activeReleaseFrameCount ?? 0,
        leftClosedLatch: Boolean(eyeState.left?.closedLatch),
        rightClosedLatch: Boolean(eyeState.right?.closedLatch),
        pairedBlinkActive,
        pairedReleaseActive: pairedBlinkActive && Boolean(sharedRelease?.releasing),
        leftReleasing: Boolean(sharedRelease?.leftReleasing),
        rightReleasing: Boolean(sharedRelease?.rightReleasing),
        releaseReason: sharedRelease?.releaseReason ?? (eyeCfg.releaseEnabled === false ? "bypassed" : "idle"),
        releaseReboundCancelReason:
          sharedRelease?.releaseReason === "release-rebound-cancel" ? "release-rebound-cancel" : "",
        snapToZeroApplied: {
          left: Boolean(l.debug.snapToZeroApplied),
          right: Boolean(r.debug.snapToZeroApplied),
        },
        snapToZeroBlockedReason: {
          left: l.debug.snapToZeroBlockedReason || "",
          right: r.debug.snapToZeroBlockedReason || "",
        },
      },
    }
    }
  } else {
    eyeL = {
      up: smoothSigned(p.eyeL.up, n.eyeL.up, cal),
      lo: smoothSigned(p.eyeL.lo, n.eyeL.lo, cal),
    }
    eyeR = {
      up: smoothSigned(p.eyeR.up, n.eyeR.up, cal),
      lo: smoothSigned(p.eyeR.lo, n.eyeR.lo, cal),
    }
  }

  const eyeXY = isIrisOnlyGaze(frameCtx?.gaze)
    ? { x: n.sharedRadar.x, y: n.sharedRadar.y, debug: { bypassed: true, reason: "iris_only" } }
    : stabilizeEyeXY(p.sharedRadar, n.sharedRadar, eyeXYCfg, eyeState)

  // Tracking 本阶段不改 MediaPipe：共享 gaze 镜像到双眼
  const gazeX = eyeXY.x
  const gazeY = eyeXY.y

  const smoothed = {
    browL: {
      x: smoothSigned(p.browL.x ?? 0, nBrow.browL.x ?? 0, cal),
      y: smoothSigned(p.browL.y ?? 0, nBrow.browL.y ?? 0, cal),
      tipA: smoothBrowSigned(
        p.browL.tipA ?? p.browL.tip,
        nBrow.browL.tipA ?? nBrow.browL.tip,
        cal,
        browCfg
      ),
      tipB: smoothBrowSigned(p.browL.tipB ?? 0, nBrow.browL.tipB ?? 0, cal, browCfg),
      tip: smoothBrowSigned(
        p.browL.tipA ?? p.browL.tip,
        nBrow.browL.tipA ?? nBrow.browL.tip,
        cal,
        browCfg
      ),
      mid: smoothBrowSigned(p.browL.mid, nBrow.browL.mid, cal, browCfg),
      tail: smoothBrowSigned(p.browL.tail, nBrow.browL.tail, cal, browCfg),
    },
    browR: {
      x: smoothSigned(p.browR.x ?? 0, nBrow.browR.x ?? 0, cal),
      y: smoothSigned(p.browR.y ?? 0, nBrow.browR.y ?? 0, cal),
      tipA: smoothBrowSigned(
        p.browR.tipA ?? p.browR.tip,
        nBrow.browR.tipA ?? nBrow.browR.tip,
        cal,
        browCfg
      ),
      tipB: smoothBrowSigned(p.browR.tipB ?? 0, nBrow.browR.tipB ?? 0, cal, browCfg),
      tip: smoothBrowSigned(
        p.browR.tipA ?? p.browR.tip,
        nBrow.browR.tipA ?? nBrow.browR.tip,
        cal,
        browCfg
      ),
      mid: smoothBrowSigned(p.browR.mid, nBrow.browR.mid, cal, browCfg),
      tail: smoothBrowSigned(p.browR.tail, nBrow.browR.tail, cal, browCfg),
    },
    eyeL: { ...eyeL, x: gazeX, y: gazeY },
    eyeR: { ...eyeR, x: gazeX, y: gazeY },
    sharedRadar: {
      x: gazeX,
      y: gazeY,
    },
    noseL: { val: smoothSigned(p.noseL?.val ?? 0, n.noseL?.val ?? 0, cal) },
    noseR: { val: smoothSigned(p.noseR?.val ?? 0, n.noseR?.val ?? 0, cal) },
    mouth: {
      UL: smoothSigned(p.mouth.UL, n.mouth.UL, cal),
      UR: smoothSigned(p.mouth.UR, n.mouth.UR, cal),
      LL: smoothSigned(p.mouth.LL, n.mouth.LL, cal),
      LR: smoothSigned(p.mouth.LR, n.mouth.LR, cal),
      sideL: {
        x: smoothPct(p.mouth.sideL.x, n.mouth.sideL.x, cal),
        y: smoothPct(p.mouth.sideL.y, n.mouth.sideL.y, cal),
      },
      sideR: {
        x: smoothPct(p.mouth.sideR.x, n.mouth.sideR.x, cal),
        y: smoothPct(p.mouth.sideR.y, n.mouth.sideR.y, cal),
      },
    },
    // tongue 入站忽略（不下发）；字段置 0 以免旧链路误驱动
    tongue: { val: 0 },
    jaw: {
      val: smoothSigned(p.jaw.val, n.jaw.val, cal),
      lateral: Math.max(
        -50,
        Math.min(50, smoothSigned(p.jaw?.lateral ?? 0, n.jaw?.lateral ?? 0, cal))
      ),
    },
  }
  smoothed._eyeTrackDebug = eyeTrackDebug
  smoothed._browGateTransitionDebug = browTransition.debug
  smoothed._eyeXYDebug = eyeXY.debug
  return smoothed
}

/** 不修改入参 frame；返回新 RigFrame。 */
export function applyTrackingCalibration(frame, previousFrame, calibration) {
  const cal = calibration ?? createDefaultTrackingCalibration()

  const passthroughDebug =
    frame && typeof frame === "object" && frame.debug !== undefined && frame.debug !== null
      ? frame.debug
      : undefined

  if (!frame.faceDetected) {
    if (previousFrame) {
      return {
        ...previousFrame,
        type: TRACKING_FRAME_TYPE,
        timestampMs: frame.timestampMs,
        source: frame.source,
        faceDetected: false,
        quality: frame.quality,
        ...(passthroughDebug !== undefined ? { debug: passthroughDebug } : {}),
      }
    }
    const neutral = createEmptyRigFrame()
    return {
      ...neutral,
      source: frame.source,
      timestampMs: frame.timestampMs,
      faceDetected: false,
      quality: frame.quality,
      rig: createInitialEliteRig(),
      ...(passthroughDebug !== undefined ? { debug: passthroughDebug } : {}),
    }
  }

  const prevRig = previousFrame?.rig ?? createInitialEliteRig()
  const rigInjected = injectFrameDebugBrowIntoRig(frame.rig, passthroughDebug)
  const smoothed = smoothRig(prevRig, rigInjected.rig, cal, {
    blendshapes: passthroughDebug?.blendshapes || frame.debug?.blendshapes,
    browGate: passthroughDebug?.browGate || frame.debug?.browGate || null,
    gaze: passthroughDebug?.gaze || frame.debug?.gaze || null,
  })
  const postInject = injectFrameDebugBrowIntoRig(smoothed, passthroughDebug, { absThreshold: 1 })
  let rigOut = postInject.injected ? postInject.rig : smoothed

  const runtimeBrow = applyRuntimeBrowToRigIfGatePass(rigOut, passthroughDebug, { prevRig })
  if (runtimeBrow.applied) {
    rigOut = runtimeBrow.rig
  }

  const mouthScenarioCfg = cal.mouthScenario ?? DEFAULT_MOUTH_SCENARIO_TRANSITION
  const mouthTransition = applyMouthScenarioTransition(
    prevRig,
    rigOut,
    passthroughDebug,
    cal.eyeState,
    mouthScenarioCfg
  )
  rigOut = mouthTransition.rig

  const lipLimits = applyLipOutputLimits(rigOut, cal.lipOutput)
  rigOut = lipLimits.rig

  rigOut = applyUpperFaceMicroJitterFilter(rigOut, prevRig)

  if (isIrisOnlyGaze(passthroughDebug?.gaze || frame.debug?.gaze)) {
    const serverRadar = rigInjected.rig?.sharedRadar
    if (serverRadar && typeof serverRadar === "object") {
      rigOut = {
        ...rigOut,
        sharedRadar: {
          x: Number(serverRadar.x) || 50,
          y: Number(serverRadar.y) || 50,
        },
      }
    }
  }

  const browInjectMeta = postInject.browInjectionDebug || rigInjected.browInjectionDebug || null
  const eyeTrackDebug = smoothed._eyeTrackDebug
  const browGateTransitionDebug = smoothed._browGateTransitionDebug
  const eyeXYDebug = smoothed._eyeXYDebug
  const mouthScenarioTransitionDebug = mouthTransition.debug?.enabled ? mouthTransition.debug : null
  const lipOutputLimitDebug = lipLimits.applied
    ? { globalScale: lipLimits.globalScale, absLimit: lipLimits.absLimit }
    : null
  delete smoothed._eyeTrackDebug
  delete smoothed._browGateTransitionDebug
  delete smoothed._eyeXYDebug

  const debugOut =
    passthroughDebug !== undefined
      ? {
          ...passthroughDebug,
          ...(eyeTrackDebug ? { eyeTrack: eyeTrackDebug } : {}),
          ...(browGateTransitionDebug ? { browGateTransition: browGateTransitionDebug } : {}),
          ...(mouthScenarioTransitionDebug ? { mouthScenarioTransition: mouthScenarioTransitionDebug } : {}),
          ...(lipOutputLimitDebug ? { lipOutputLimit: lipOutputLimitDebug } : {}),
          ...(eyeXYDebug ? { eyeXYStabilizer: eyeXYDebug } : {}),
          ...(rigInjected.injected || postInject.injected || runtimeBrow.applied
            ? {
                browRigInject: {
                  sourcePath: runtimeBrow.sourcePath || postInject.sourcePath || rigInjected.sourcePath,
                  injected: true,
                  runtimeOverride: runtimeBrow.applied,
                  ...(browInjectMeta || {}),
                },
              }
            : {}),
        }
      : eyeTrackDebug || browGateTransitionDebug || mouthScenarioTransitionDebug || lipOutputLimitDebug || eyeXYDebug || rigInjected.injected || runtimeBrow.applied
        ? {
            ...(eyeTrackDebug ? { eyeTrack: eyeTrackDebug } : {}),
            ...(browGateTransitionDebug ? { browGateTransition: browGateTransitionDebug } : {}),
            ...(mouthScenarioTransitionDebug ? { mouthScenarioTransition: mouthScenarioTransitionDebug } : {}),
          ...(lipOutputLimitDebug ? { lipOutputLimit: lipOutputLimitDebug } : {}),
            ...(eyeXYDebug ? { eyeXYStabilizer: eyeXYDebug } : {}),
            ...(rigInjected.injected || postInject.injected || runtimeBrow.applied
              ? {
                  browRigInject: {
                    sourcePath: runtimeBrow.sourcePath || postInject.sourcePath || rigInjected.sourcePath,
                    injected: true,
                    runtimeOverride: runtimeBrow.applied,
                    ...(browInjectMeta || {}),
                  },
                }
              : {}),
          }
        : undefined

  return {
    type: TRACKING_FRAME_TYPE,
    source: frame.source,
    timestampMs: frame.timestampMs,
    faceDetected: true,
    quality: frame.quality,
    frameSeq: frame.frameSeq,
    rig: rigOut,
    ...(debugOut !== undefined ? { debug: debugOut } : {}),
  }
}
