/** @typedef {{ up: number, lo: number }} EyePair */

/** @typedef {{ closedLatch: boolean, releasingFrames: number, openRecoveryFramesLeft: number, prevBlink: number, latchOnsetFrame: number }} EyeReleaseSideState */

export const DEFAULT_EYE_CALIBRATION = {
  enabled: true,

  /** Tracking 默认走 normal 路径，避免 release slew（4/帧）拖慢眼睑跟随 */
  releaseEnabled: false,
  openRecoveryEnabled: true,

  gain: 1.0,
  upperGain: 1.0,
  lowerGain: 1.0,
  leftGain: 1.0,
  rightGain: 1.0,
  leftUpperGain: 1.0,
  leftLowerGain: 1.0,
  rightUpperGain: 1.0,
  rightLowerGain: 1.0,

  upperCloseSign: -1,
  lowerCloseSign: 1,

  leftUpperCloseGain: 0.5,
  leftLowerCloseGain: 0.86,
  rightUpperCloseGain: 1.22,
  rightLowerCloseGain: 0.77,
  leftUpperOpenGain: 1.15,
  leftLowerOpenGain: 1.0,
  rightUpperOpenGain: 1.15,
  rightLowerOpenGain: 1.0,

  upGain: 1.0,
  loGain: 1.0,

  blinkGain: 1.0,
  openGain: 1.05,
  closeGain: 1.0,
  releaseAlpha: 0.85,
  closeAlpha: 0.65,
  snapToZero: 2.2,
  releaseSnapToZero: 2.0,
  disableSnapToZeroDuringActiveRelease: true,
  openRecoveryBoostEnabled: true,
  openRecoveryFrames: 6,
  openRecoveryBoost: 4.0,
  lowerLidReleaseScale: 1.3,

  /** neutral-relative blink depth 阈值（相对 neutralBlinkProxy） */
  closeLatchDepthThreshold: 18,
  closeLatchConfirmFrames: 2,
  releaseStartDepthThreshold: 8,
  releaseStartConfirmFrames: 2,
  releaseDoneDepthThreshold: 3,
  releaseReboundDepthThreshold: 14,
  releaseReboundDeltaThreshold: 5,

  /** 中性 baseline 学习速率（睁眼时缓慢跟踪 raw proxy） */
  neutralLearnAlpha: 0.06,
  /** 初始 neutral 估计（首次启动前） */
  neutralBlinkProxyLeftDefault: 32,
  neutralBlinkProxyRightDefault: 32,

  pairedBlinkRelease: true,
  pairedReleaseWindowFrames: 6,

  releaseControlSlewLimit: 4,
  releaseTargetSlewLimit: 15,

  releaseReboundCancelEnabled: true,
  releaseRefractoryFrames: 8,
  maxReleaseFrames: 5,

  /** 普通路径（Bypass Release）V3 jitter / spike 抑制 */
  zeroLatchEnabled: true,
  zeroEnterThreshold: 2.8,
  zeroExitThreshold: 6.5,
  zeroEnterConfirmFrames: 2,
  zeroExitConfirmFrames: 2,
  inactiveZeroEnterThreshold: 4,
  inactiveZeroExitThreshold: 8,
  normalStabilizerEnabled: true,
  inactiveAlpha: 0.42,
  activeCloseAlpha: 0.78,
  activeOpenAlpha: 0.55,
  inactiveControlSlewLimit: 10,
  activeCloseControlSlewLimit: 22,
  activeOpenControlSlewLimit: 14,
  blinkBlendshapeScale: 100,
  blinkActiveThreshold: 20,
  blinkInactiveThreshold: 10,
  blinkActiveConfirmFrames: 2,
  blinkInactiveConfirmFrames: 2,
  forceInactiveBelowThreshold: 3.5,
  blinkSpikeGuardEnabled: true,
  inactiveToActiveLargeJumpThreshold: 18,
  activeLargeJumpThreshold: 22,
  largeBlinkConfirmFrames: 3,
  firstLargeBlinkControlLimit: 6,
  secondLargeBlinkControlLimit: 9,
  confirmedLargeBlinkControlLimit: 12,
  spikeRecoverFrames: 4,
  spikeRecoverControlLimit: 8,
  /** @deprecated 使用 blinkActiveConfirmFrames */
  blinkEvidenceConfirmFrames: 2,
  /** @deprecated 使用 activeCloseAlpha */
  activeAlpha: 0.62,
  /** @deprecated 使用 inactiveControlSlewLimit */
  normalControlSlewLimit: 2.5,
  /** @deprecated 使用 activeCloseControlSlewLimit */
  blinkCloseControlSlewLimit: 12,

  /** @deprecated 深度模式不再使用绝对 raw 阈值 */
  closeLatchThreshold: 55,
  releaseStartThreshold: 50,
  releaseDoneThreshold: 16,
  pairedReleaseStartThreshold: 42,
  pairedReleaseDoneThreshold: 16,
  releaseAbortHoldFrames: 3,
  releaseHoldFrames: 8,
}

function createSideReleaseState() {
  return {
    closedLatch: false,
    releasingFrames: 0,
    openRecoveryFramesLeft: 0,
    prevBlink: 0,
    latchOnsetFrame: -1,
  }
}

export function createEyeTrackState() {
  return {
    left: createSideReleaseState(),
    right: createSideReleaseState(),
    frameCounter: 0,
    prevBlinkL: 0,
    prevBlinkR: 0,
    neutralBlinkProxyL: null,
    neutralBlinkProxyR: null,
    prevReleaseDepthProxy: 0,
    releaseDepthProxyDelta: 0,
    releaseStartCandidateCount: 0,
    latchCandidateCount: 0,
    releaseRefractoryFramesLeft: 0,
    activeReleaseFrameCount: 0,
    lastReleaseFinishReason: "",
    lastReleaseCancelReason: "",
    lastDebugL: null,
    lastDebugR: null,
  }
}

/** Start / Stop / Set Neutral 时重置 release 状态机 */
export function resetEyeTrackState(state) {
  if (!state) {
    return createEyeTrackState()
  }
  state.left = createSideReleaseState()
  state.right = createSideReleaseState()
  state.frameCounter = 0
  state.prevBlinkL = 0
  state.prevBlinkR = 0
  state.neutralBlinkProxyL = null
  state.neutralBlinkProxyR = null
  state.prevReleaseDepthProxy = 0
  state.releaseDepthProxyDelta = 0
  state.releaseStartCandidateCount = 0
  state.latchCandidateCount = 0
  state.releaseRefractoryFramesLeft = 0
  state.activeReleaseFrameCount = 0
  state.lastReleaseFinishReason = ""
  state.lastReleaseCancelReason = ""
  state.lastDebugL = null
  state.lastDebugR = null
  state.normal = null
  state.browGateTransition = null
  state.eyeXY = null
  return state
}

function sideKey(side) {
  return side === "L" ? "left" : "right"
}

function getSideState(state, side) {
  const key = sideKey(side)
  if (!state[key]) {
    state[key] = createSideReleaseState()
  }
  return state[key]
}

function clampAlpha(a) {
  return Math.max(0, Math.min(1, Number(a) || 0))
}

function ema(prev, next, alpha) {
  const a = clampAlpha(alpha)
  return prev + a * (next - prev)
}

function approachZero(value, alpha) {
  return ema(Number(value) || 0, 0, alpha)
}

function numOr(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export function applyDirectionalEyeGain(value, closeSign, closeGain, openGain) {
  const v = Number(value) || 0
  if (v === 0) {
    return 0
  }
  const isCloseDirection = Math.sign(v) === Math.sign(Number(closeSign) || -1)
  return v * (isCloseDirection ? numOr(closeGain, 1) : numOr(openGain, 1))
}

function resolveBaseGains(cfg, side) {
  const isL = side === "L"
  const baseGain = numOr(cfg.gain, 1)
  const sideGain = numOr(isL ? cfg.leftGain : cfg.rightGain, 1)
  const upperGain = numOr(cfg.upperGain, 1) * numOr(cfg.upGain, 1)
  const lowerGain = numOr(cfg.lowerGain, 1) * numOr(cfg.loGain, 1)
  const upGain =
    baseGain * upperGain * sideGain * numOr(isL ? cfg.leftUpperGain : cfg.rightUpperGain, 1)
  const loGain =
    baseGain * lowerGain * sideGain * numOr(isL ? cfg.leftLowerGain : cfg.rightLowerGain, 1)
  return { upGain, loGain }
}

export function resolveBalanceGains(cfg, side) {
  const isL = side === "L"
  return {
    upperCloseGain: numOr(isL ? cfg.leftUpperCloseGain : cfg.rightUpperCloseGain, 1),
    lowerCloseGain: numOr(isL ? cfg.leftLowerCloseGain : cfg.rightLowerCloseGain, 1),
    upperOpenGain: numOr(isL ? cfg.leftUpperOpenGain : cfg.rightUpperOpenGain, 1),
    lowerOpenGain: numOr(isL ? cfg.leftLowerOpenGain : cfg.rightLowerOpenGain, 1),
    upperCloseSign: numOr(cfg.upperCloseSign, -1),
    lowerCloseSign: numOr(cfg.lowerCloseSign, 1),
  }
}

export function eyeBlinkProxy(up, lo) {
  return Math.max(0, -Number(up) || 0) + Math.max(0, Number(lo) || 0)
}

export function blinkDepth(rawBlink, neutralBlink) {
  return Math.max(0, numOr(rawBlink, 0) - numOr(neutralBlink, 0))
}

function resolveNeutral(state, rawL, rawR, cfg) {
  if (state.neutralBlinkProxyL == null) {
    state.neutralBlinkProxyL = numOr(cfg.neutralBlinkProxyLeftDefault, 32)
  }
  if (state.neutralBlinkProxyR == null) {
    state.neutralBlinkProxyR = numOr(cfg.neutralBlinkProxyRightDefault, 32)
  }
  return {
    neutralL: state.neutralBlinkProxyL,
    neutralR: state.neutralBlinkProxyR,
    depthL: blinkDepth(rawL, state.neutralBlinkProxyL),
    depthR: blinkDepth(rawR, state.neutralBlinkProxyR),
  }
}

/** 睁眼时缓慢学习 neutral baseline */
function updateNeutralBaseline(state, rawL, rawR, depthL, depthR, cfg, wasReleasing) {
  const learnAlpha = numOr(cfg.neutralLearnAlpha, 0.06)
  const openThr = numOr(cfg.releaseDoneDepthThreshold, 3)
  if (!wasReleasing && depthL < openThr) {
    state.neutralBlinkProxyL = ema(state.neutralBlinkProxyL, rawL, learnAlpha)
  }
  if (!wasReleasing && depthR < openThr) {
    state.neutralBlinkProxyR = ema(state.neutralBlinkProxyR, rawR, learnAlpha)
  }
}

function finishRelease(state, reason, cfg) {
  const left = getSideState(state, "L")
  const right = getSideState(state, "R")
  left.closedLatch = false
  right.closedLatch = false
  left.releasingFrames = 0
  right.releasingFrames = 0
  left.openRecoveryFramesLeft = 0
  right.openRecoveryFramesLeft = 0
  state.releaseStartCandidateCount = 0
  state.latchCandidateCount = 0
  state.activeReleaseFrameCount = 0
  state.releaseRefractoryFramesLeft = Math.max(
    0,
    Math.round(numOr(cfg.releaseRefractoryFrames, 8))
  )
  state.lastReleaseFinishReason = reason
}

function cancelRelease(state, reason, cfg) {
  finishRelease(state, reason, cfg)
  state.lastReleaseCancelReason = reason
}

function resolvePairedBlinkActive(state, left, right, depthL, depthR, cfg, frameCounter) {
  if (cfg.pairedBlinkRelease === false) {
    return false
  }
  const windowFrames = Math.max(0, Math.round(numOr(cfg.pairedReleaseWindowFrames, 6)))
  const latchThr = numOr(cfg.closeLatchDepthThreshold, 18)
  const leftWillLatch = left.closedLatch || depthL > latchThr
  const rightWillLatch = right.closedLatch || depthR > latchThr
  const leftOnset = left.closedLatch
    ? Number(left.latchOnsetFrame)
    : leftWillLatch
      ? frameCounter
      : -1
  const rightOnset = right.closedLatch
    ? Number(right.latchOnsetFrame)
    : rightWillLatch
      ? frameCounter
      : -1
  return (
    leftWillLatch &&
    rightWillLatch &&
    leftOnset >= 0 &&
    rightOnset >= 0 &&
    Math.abs(leftOnset - rightOnset) <= windowFrames
  )
}

/**
 * 双眼成对 release（neutral-relative blinkDepth + refractory + max frames）。
 */
export function updatePairedReleaseState(state, pairedCtx, cfg) {
  if (cfg.releaseEnabled === false) {
    return {
      bypassed: true,
      pairedBlinkActive: false,
      releaseProxy: 0,
      releaseDepthProxy: 0,
      releaseDepthProxyDelta: 0,
      blinkDepthLeft: 0,
      blinkDepthRight: 0,
      neutralBlinkProxyLeft: state.neutralBlinkProxyL,
      neutralBlinkProxyRight: state.neutralBlinkProxyR,
      releaseStartCandidateCount: 0,
      leftReleasing: false,
      rightReleasing: false,
      releasing: false,
      releaseReason: "bypassed",
    }
  }

  state.frameCounter = (Number(state.frameCounter) || 0) + 1
  const frameCounter = Number(state.frameCounter) || 0

  const rawL = numOr(pairedCtx.rawBlinkProxyL, 0)
  const rawR = numOr(pairedCtx.rawBlinkProxyR, 0)
  const left = getSideState(state, "L")
  const right = getSideState(state, "R")

  const { neutralL, neutralR, depthL, depthR } = resolveNeutral(state, rawL, rawR, cfg)
  const releaseDepthProxy = Math.max(depthL, depthR)
  const prevDepth = Number(state.prevReleaseDepthProxy) || 0
  const releaseDepthProxyDelta = releaseDepthProxy - prevDepth
  state.releaseDepthProxyDelta = releaseDepthProxyDelta

  const latchThr = numOr(cfg.closeLatchDepthThreshold, 18)
  const releaseStartThr = numOr(cfg.releaseStartDepthThreshold, 8)
  const releaseDoneThr = numOr(cfg.releaseDoneDepthThreshold, 3)
  const reboundThr = numOr(cfg.releaseReboundDepthThreshold, 14)
  const reboundDeltaThr = numOr(cfg.releaseReboundDeltaThreshold, 5)
  const latchConfirm = Math.max(1, Math.round(numOr(cfg.closeLatchConfirmFrames, 2)))
  const releaseConfirm = Math.max(1, Math.round(numOr(cfg.releaseStartConfirmFrames, 2)))
  const maxReleaseFrames = Math.max(1, Math.round(numOr(cfg.maxReleaseFrames, 5)))
  const openRecoveryFrames = Math.max(0, Math.round(numOr(cfg.openRecoveryFrames, 6)))

  let releaseReason = state.lastReleaseCancelReason || state.lastReleaseFinishReason || "idle"
  if (releaseReason !== "release-rebound-cancel" && releaseReason !== "max-release-frames") {
    releaseReason = "idle"
    state.lastReleaseCancelReason = ""
    state.lastReleaseFinishReason = ""
  } else {
    state.lastReleaseCancelReason = ""
    state.lastReleaseFinishReason = ""
  }

  const wasReleasing = left.releasingFrames > 0 || right.releasingFrames > 0

  updateNeutralBaseline(state, rawL, rawR, depthL, depthR, cfg, wasReleasing)

  if (state.releaseRefractoryFramesLeft > 0) {
    state.releaseRefractoryFramesLeft -= 1
  }

  // ---- closedLatch：depth 连续超过阈值 ----
  if (releaseDepthProxy > latchThr) {
    state.latchCandidateCount += 1
  } else if (!wasReleasing) {
    state.latchCandidateCount = 0
  }
  if (state.latchCandidateCount >= latchConfirm) {
    if (!left.closedLatch) {
      left.latchOnsetFrame = frameCounter
    }
    if (!right.closedLatch) {
      right.latchOnsetFrame = frameCounter
    }
    left.closedLatch = true
    right.closedLatch = true
  }

  const pairedBlinkActive = resolvePairedBlinkActive(
    state,
    left,
    right,
    depthL,
    depthR,
    cfg,
    frameCounter
  )

  // ---- rebound cancel ----
  if (
    wasReleasing &&
    cfg.releaseReboundCancelEnabled !== false &&
    (releaseDepthProxy > reboundThr || releaseDepthProxyDelta > reboundDeltaThr)
  ) {
    cancelRelease(state, "release-rebound-cancel", cfg)
    left.prevBlink = rawL
    right.prevBlink = rawR
    state.prevReleaseDepthProxy = releaseDepthProxy
    return buildReleaseResult(state, {
      pairedBlinkActive,
      releaseDepthProxy,
      releaseDepthProxyDelta,
      depthL,
      depthR,
      neutralL,
      neutralR,
      rawL,
      rawR,
      releaseReason: "release-rebound-cancel",
    })
  }

  // ---- release start（refractory 内禁止）----
  if (
    !wasReleasing &&
    state.releaseRefractoryFramesLeft <= 0 &&
    pairedBlinkActive &&
    left.closedLatch &&
    right.closedLatch &&
    releaseDepthProxy < releaseStartThr
  ) {
    state.releaseStartCandidateCount += 1
  } else if (!wasReleasing) {
    state.releaseStartCandidateCount = 0
  }

  if (state.releaseStartCandidateCount >= releaseConfirm) {
    left.releasingFrames = maxReleaseFrames
    right.releasingFrames = maxReleaseFrames
    if (cfg.openRecoveryEnabled !== false) {
      left.openRecoveryFramesLeft = Math.max(left.openRecoveryFramesLeft, openRecoveryFrames)
      right.openRecoveryFramesLeft = Math.max(right.openRecoveryFramesLeft, openRecoveryFrames)
    }
    state.releaseStartCandidateCount = 0
    state.activeReleaseFrameCount = 0
    releaseReason = "paired-release-start"
  }

  let releasing = left.releasingFrames > 0 || right.releasingFrames > 0
  if (releasing && releaseReason === "idle") {
    releaseReason = "paired-releasing"
  }

  if (releasing) {
    state.activeReleaseFrameCount += 1
    left.releasingFrames = Math.max(0, left.releasingFrames - 1)
    right.releasingFrames = Math.max(0, right.releasingFrames - 1)
    releasing = left.releasingFrames > 0 || right.releasingFrames > 0

    if (state.activeReleaseFrameCount >= maxReleaseFrames) {
      finishRelease(state, "max-release-frames", cfg)
      releasing = false
      releaseReason = "max-release-frames"
    }
  }

  if (releaseDepthProxy < releaseDoneThr && !releasing) {
    if (left.closedLatch || right.closedLatch) {
      finishRelease(state, "release-done", cfg)
      releaseReason = "release-done"
    }
  }

  left.prevBlink = rawL
  right.prevBlink = rawR
  state.prevReleaseDepthProxy = releaseDepthProxy

  return buildReleaseResult(state, {
    pairedBlinkActive,
    releaseDepthProxy,
    releaseDepthProxyDelta,
    depthL,
    depthR,
    neutralL,
    neutralR,
    rawL,
    rawR,
    releaseReason,
  })
}

function buildReleaseResult(state, ctx) {
  const left = getSideState(state, "L")
  const right = getSideState(state, "R")
  const releasing =
    ctx.releaseReason === "paired-release-start" ||
    left.releasingFrames > 0 ||
    right.releasingFrames > 0
  return {
    bypassed: false,
    pairedBlinkActive: ctx.pairedBlinkActive,
    releaseProxy: ctx.releaseDepthProxy,
    releaseDepthProxy: ctx.releaseDepthProxy,
    releaseDepthProxyDelta: ctx.releaseDepthProxyDelta,
    releaseProxyDelta: ctx.releaseDepthProxyDelta,
    blinkDepthLeft: ctx.depthL,
    blinkDepthRight: ctx.depthR,
    neutralBlinkProxyLeft: ctx.neutralL,
    neutralBlinkProxyRight: ctx.neutralR,
    rawBlinkProxyLeft: ctx.rawL,
    rawBlinkProxyRight: ctx.rawR,
    releaseStartCandidateCount: state.releaseStartCandidateCount,
    latchCandidateCount: state.latchCandidateCount,
    releaseRefractoryFramesLeft: state.releaseRefractoryFramesLeft,
    activeReleaseFrameCount: state.activeReleaseFrameCount,
    leftReleasing: releasing,
    rightReleasing: releasing,
    releasing,
    releaseReason: ctx.releaseReason,
    releaseDoneThr: numOr(DEFAULT_EYE_CALIBRATION.releaseDoneDepthThreshold, 3),
  }
}

function clampAbs(delta, limit) {
  if (!Number.isFinite(limit) || limit <= 0) {
    return delta
  }
  return Math.max(-limit, Math.min(limit, delta))
}

/** bypass：仅 base/balance gain + closeAlpha EMA + snap，无 release */
function stabilizeEyeSideBypass(prev, nextRaw, cfg, state, side) {
  const sk = side === "L" ? "L" : "R"
  const { upGain, loGain } = resolveBaseGains(cfg, side)
  const bal = resolveBalanceGains(cfg, side)
  const rawUp = Number(nextRaw.up) || 0
  const rawLo = Number(nextRaw.lo) || 0
  const rawBlink = eyeBlinkProxy(rawUp, rawLo)

  let upGained = applyDirectionalEyeGain(
    rawUp * upGain,
    bal.upperCloseSign,
    bal.upperCloseGain,
    bal.upperOpenGain
  )
  let loGained = applyDirectionalEyeGain(
    rawLo * loGain,
    bal.lowerCloseSign,
    bal.lowerCloseGain,
    bal.lowerOpenGain
  )

  const closeAlpha = numOr(cfg.closeAlpha, 0.65)
  const snap = numOr(cfg.snapToZero, 3)
  let up = ema(Number(prev.up) || 0, upGained, closeAlpha)
  let lo = ema(Number(prev.lo) || 0, loGained, closeAlpha)
  if (Math.abs(up) < snap) up = 0
  if (Math.abs(lo) < snap) lo = 0

  const debug = {
    raw: { up: rawUp, lo: rawLo },
    afterBalanceGain: { up: upGained, lo: loGained },
    rawBlinkProxy: rawBlink,
    releasing: false,
    releaseReason: "bypassed",
    final: { up, lo },
  }
  state[`lastDebug${sk}`] = debug
  return { up, lo, debug }
}

export function stabilizeEyeSide(prev, nextRaw, cfg, state, side, sharedRelease = null) {
  if (cfg.releaseEnabled === false) {
    return stabilizeEyeSideBypass(prev, nextRaw, cfg, state, side)
  }

  const sk = side === "L" ? "L" : "R"
  const sideState = getSideState(state, side)
  const { upGain, loGain } = resolveBaseGains(cfg, side)
  const bal = resolveBalanceGains(cfg, side)

  const rawUp = Number(nextRaw.up) || 0
  const rawLo = Number(nextRaw.lo) || 0
  const rawBlink = eyeBlinkProxy(rawUp, rawLo)

  let upGained = applyDirectionalEyeGain(
    rawUp * upGain,
    bal.upperCloseSign,
    bal.upperCloseGain,
    bal.upperOpenGain
  )
  let loGained = applyDirectionalEyeGain(
    rawLo * loGain,
    bal.lowerCloseSign,
    bal.lowerCloseGain,
    bal.lowerOpenGain
  )
  const afterBalanceUp = upGained
  const afterBalanceLo = loGained
  const gainAdjustedBlink = eyeBlinkProxy(upGained, loGained)

  const depthL = numOr(sharedRelease?.blinkDepthLeft, 0)
  const depthR = numOr(sharedRelease?.blinkDepthRight, 0)
  const myDepth = side === "L" ? depthL : depthR
  const releaseDoneThr = numOr(sharedRelease?.releaseDoneThr, 3)
  const pairedBlinkActive = Boolean(sharedRelease?.pairedBlinkActive)
  const releasing = Boolean(sharedRelease?.releasing)
  const releaseReason = sharedRelease?.releaseReason || "idle"
  const latchThr = numOr(cfg.closeLatchDepthThreshold, 18)
  const closing = myDepth >= latchThr && !releasing

  if (closing) {
    upGained *= numOr(cfg.closeGain, 1)
    loGained *= numOr(cfg.closeGain, 1)
    const bg = numOr(cfg.blinkGain, 1)
    if (bg !== 1) {
      upGained *= bg
      loGained *= bg
    }
  }

  const releaseAlpha = numOr(cfg.releaseAlpha, 0.85)
  const closeAlpha = numOr(cfg.closeAlpha, 0.65)
  const releaseSnap = numOr(cfg.releaseSnapToZero, 2)
  const snap = numOr(cfg.snapToZero, 3)
  const disableActiveSnap = cfg.disableSnapToZeroDuringActiveRelease !== false

  const prevUp = Number(prev.up) || 0
  const prevLo = Number(prev.lo) || 0
  let up
  let lo

  if (releasing) {
    upGained = 0
    loGained = 0
    up = approachZero(prevUp, releaseAlpha)
    lo = approachZero(prevLo, releaseAlpha)

    if (
      cfg.openRecoveryEnabled !== false &&
      cfg.openRecoveryBoostEnabled &&
      sideState.openRecoveryFramesLeft > 0
    ) {
      sideState.openRecoveryFramesLeft -= 1
      const boost = numOr(cfg.openRecoveryBoost, 0)
      if (boost > 0 && up < 0) {
        up = Math.min(0, up + boost * 0.35)
      }
      if (boost > 0 && lo > 0) {
        lo = Math.max(0, lo - boost * 0.25 * numOr(cfg.lowerLidReleaseScale, 1))
      }
    }
  } else {
    up = ema(prevUp, upGained, closeAlpha)
    lo = ema(prevLo, loGained, closeAlpha)
  }

  const afterReleaseUp = up
  const afterReleaseLo = lo

  let snapToZeroApplied = false
  let snapToZeroBlockedReason = ""

  if (releasing) {
    const depthConfirmsDone = myDepth < releaseDoneThr
    if (disableActiveSnap && !depthConfirmsDone) {
      if (Math.abs(up) < releaseSnap || Math.abs(lo) < releaseSnap) {
        snapToZeroBlockedReason = "active-release-depth-still-high"
      }
    } else {
      if (depthConfirmsDone && Math.abs(up) < releaseSnap) {
        up = 0
        snapToZeroApplied = true
      }
      if (depthConfirmsDone && Math.abs(lo) < releaseSnap) {
        lo = 0
        snapToZeroApplied = true
      }
    }
  } else {
    if (myDepth < releaseDoneThr && Math.abs(up) < snap) {
      up = 0
      snapToZeroApplied = true
    }
    if (myDepth < releaseDoneThr && Math.abs(lo) < snap) {
      lo = 0
      snapToZeroApplied = true
    }
  }

  const ctrlSlew = numOr(cfg.releaseControlSlewLimit, 4)
  let controlSlewApplied = false
  if (releasing && ctrlSlew > 0) {
    const slewedUp = prevUp + clampAbs(up - prevUp, ctrlSlew)
    const slewedLo = prevLo + clampAbs(lo - prevLo, ctrlSlew)
    if (slewedUp !== up || slewedLo !== lo) {
      controlSlewApplied = true
    }
    up = slewedUp
    lo = slewedLo
  }

  state[`prevBlink${sk}`] = rawBlink

  const debug = {
    raw: { up: rawUp, lo: rawLo },
    afterBalanceGain: { up: afterBalanceUp, lo: afterBalanceLo },
    rawBlinkProxy: rawBlink,
    blinkDepth: myDepth,
    gainAdjustedBlinkProxy: gainAdjustedBlink,
    releaseDepthProxy: numOr(sharedRelease?.releaseDepthProxy, 0),
    releaseDepthProxyDelta: numOr(sharedRelease?.releaseDepthProxyDelta, 0),
    pairedBlinkActive,
    releasing,
    releaseReason,
    releasingFramesLeft: sideState.releasingFrames,
    closedLatch: sideState.closedLatch,
    openRecoveryFramesLeft: sideState.openRecoveryFramesLeft,
    snapToZeroApplied,
    snapToZeroBlockedReason,
    controlSlewApplied,
    alpha: releasing ? releaseAlpha : closeAlpha,
    final: { up, lo },
  }
  state[`lastDebug${sk}`] = debug
  return { up, lo, debug }
}

export function snapshotEyeBalanceGains(cfg = DEFAULT_EYE_CALIBRATION) {
  return {
    leftUpperCloseGain: numOr(cfg.leftUpperCloseGain, 1),
    leftLowerCloseGain: numOr(cfg.leftLowerCloseGain, 1),
    rightUpperCloseGain: numOr(cfg.rightUpperCloseGain, 1),
    rightLowerCloseGain: numOr(cfg.rightLowerCloseGain, 1),
    leftUpperOpenGain: numOr(cfg.leftUpperOpenGain, 1),
    leftLowerOpenGain: numOr(cfg.leftLowerOpenGain, 1),
    rightUpperOpenGain: numOr(cfg.rightUpperOpenGain, 1),
    rightLowerOpenGain: numOr(cfg.rightLowerOpenGain, 1),
  }
}

export function snapshotEyeReleaseState(state) {
  const left = getSideState(state, "L")
  const right = getSideState(state, "R")
  return {
    left: { ...left },
    right: { ...right },
    neutralBlinkProxyL: state.neutralBlinkProxyL,
    neutralBlinkProxyR: state.neutralBlinkProxyR,
    releaseRefractoryFramesLeft: state.releaseRefractoryFramesLeft,
    activeReleaseFrameCount: state.activeReleaseFrameCount,
    L_releasing: left.releasingFrames,
    R_releasing: right.releasingFrames,
  }
}
