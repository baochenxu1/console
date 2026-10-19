/**
 * Eye 普通路径（Bypass Release）V3：
 * neutral-relative geometry + blinkProxy + blendshape → blink evidence → spike guard → stabilizer → zero latch
 */

import {
  applyDirectionalEyeGain,
  eyeBlinkProxy,
  resolveBalanceGains,
} from "./eyeReleaseStabilizer.js"

function numOr(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function clampAlpha(a) {
  return Math.max(0, Math.min(1, Number(a) || 0))
}

function ema(prev, next, alpha) {
  const a = clampAlpha(alpha)
  return prev + a * (next - prev)
}

function clampAbs(delta, limit) {
  if (!Number.isFinite(limit) || limit <= 0) return delta
  return Math.max(-limit, Math.min(limit, delta))
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

function createZeroLatchChannel() {
  return { latched: false, enterCount: 0, exitCount: 0 }
}

function createSpikeGuardSide() {
  return {
    spikeState: "idle",
    spikeConfirmCount: 0,
    spikeRecoverFramesLeft: 0,
    previousStableBlinkEvidence: 0,
    previousStableControl: 0,
  }
}

function ensureNormalState(state) {
  if (!state.normal) {
    state.normal = {
      neutral: {
        lUp: 0,
        lLo: 0,
        rUp: 0,
        rLo: 0,
        blinkProxyL: 0,
        blinkProxyR: 0,
        eyeBlinkLeftBlendshape: 0,
        eyeBlinkRightBlendshape: 0,
      },
      zeroLatch: {
        lUp: createZeroLatchChannel(),
        lLo: createZeroLatchChannel(),
        rUp: createZeroLatchChannel(),
        rLo: createZeroLatchChannel(),
      },
      blinkActive: {
        left: false,
        right: false,
        leftEnter: 0,
        leftExit: 0,
        rightEnter: 0,
        rightExit: 0,
      },
      spikeGuard: { left: createSpikeGuardSide(), right: createSpikeGuardSide() },
      prevBlinkEvidence: { left: 0, right: 0 },
      prev: { lUp: 0, lLo: 0, rUp: 0, rLo: 0 },
    }
  }
  return state.normal
}

function initNeutralFromRaw(normal, raw, blinkCtx) {
  normal.neutral = {
    lUp: raw.lUp,
    lLo: raw.lLo,
    rUp: raw.rUp,
    rLo: raw.rLo,
    blinkProxyL: eyeBlinkProxy(raw.lUp, raw.lLo),
    blinkProxyR: eyeBlinkProxy(raw.rUp, raw.rLo),
    eyeBlinkLeftBlendshape: numOr(blinkCtx?.blinkBlendL, 0),
    eyeBlinkRightBlendshape: numOr(blinkCtx?.blinkBlendR, 0),
  }
}

/** @param {typeof import("./eyeReleaseStabilizer.js").DEFAULT_EYE_CALIBRATION} cfg */
export function sampleEyeNeutralFromRig(rig, cfg, state, blinkCtx = null) {
  const normal = ensureNormalState(state)
  const n = rig?.eyeL && rig?.eyeR ? rig : null
  if (!n) return normal.neutral
  normal.neutral = {
    lUp: Number(n.eyeL.up) || 0,
    lLo: Number(n.eyeL.lo) || 0,
    rUp: Number(n.eyeR.up) || 0,
    rLo: Number(n.eyeR.lo) || 0,
    blinkProxyL: eyeBlinkProxy(n.eyeL.up, n.eyeL.lo),
    blinkProxyR: eyeBlinkProxy(n.eyeR.up, n.eyeR.lo),
    eyeBlinkLeftBlendshape: numOr(blinkCtx?.blinkBlendL, 0),
    eyeBlinkRightBlendshape: numOr(blinkCtx?.blinkBlendR, 0),
  }
  return normal.neutral
}

function applyZeroLatch(value, latch, cfg, blinkActive) {
  if (cfg.zeroLatchEnabled === false) {
    return { value, latched: false }
  }

  const enterThr = blinkActive
    ? numOr(cfg.zeroEnterThreshold, 2.5)
    : numOr(cfg.inactiveZeroEnterThreshold, 4.0)
  const exitThr = blinkActive
    ? numOr(cfg.zeroExitThreshold, 7.0)
    : numOr(cfg.inactiveZeroExitThreshold, 9.0)
  const enterConfirm = Math.max(1, Math.round(numOr(cfg.zeroEnterConfirmFrames, 2)))
  const exitConfirm = Math.max(1, Math.round(numOr(cfg.zeroExitConfirmFrames, 3)))
  const mag = Math.abs(Number(value) || 0)

  if (!latch.latched) {
    if (mag < enterThr) {
      latch.enterCount += 1
      latch.exitCount = 0
    } else {
      latch.enterCount = 0
    }
    if (latch.enterCount >= enterConfirm) {
      latch.latched = true
      latch.enterCount = 0
    }
  } else {
    if (mag > exitThr) {
      latch.exitCount += 1
      latch.enterCount = 0
    } else {
      latch.exitCount = 0
    }
    if (latch.exitCount >= exitConfirm) {
      latch.latched = false
      latch.exitCount = 0
    }
  }

  return {
    value: latch.latched ? 0 : value,
    latched: latch.latched,
  }
}

function pickAlpha(cfg, blinkActive, isCloseDirection) {
  if (cfg.normalStabilizerEnabled === false) {
    return numOr(cfg.closeAlpha, 0.65)
  }
  if (!blinkActive) {
    return numOr(cfg.inactiveAlpha, 0.16)
  }
  if (isCloseDirection) {
    return numOr(cfg.activeCloseAlpha, 0.62)
  }
  return numOr(cfg.activeOpenAlpha, 0.35)
}

function resolveSlewLimit(cfg, blinkActive, isCloseDirection) {
  if (!blinkActive) {
    return numOr(cfg.inactiveControlSlewLimit, 2.5)
  }
  if (isCloseDirection) {
    return numOr(cfg.activeCloseControlSlewLimit, 12)
  }
  return numOr(cfg.activeOpenControlSlewLimit, 5)
}

function resolveBlinkEvidence(cfg, rel, relBlinkProxy, relBlendshape) {
  const scale = numOr(cfg.blinkBlendshapeScale, 100)
  return Math.max(
    Math.max(0, relBlendshape) * scale,
    Math.max(0, relBlinkProxy),
    Math.abs(rel.lUp),
    Math.abs(rel.lLo)
  )
}

function updateBlinkActiveSide(ba, side, evidence, cfg) {
  const key = side === "L" ? "left" : "right"
  const enterKey = side === "L" ? "leftEnter" : "rightEnter"
  const exitKey = side === "L" ? "leftExit" : "rightExit"

  const activeThr = numOr(cfg.blinkActiveThreshold, 20)
  const inactiveThr = numOr(cfg.blinkInactiveThreshold, 10)
  const forceThr = numOr(cfg.forceInactiveBelowThreshold, 4)
  const activeConfirm = Math.max(
    1,
    Math.round(
      numOr(cfg.blinkActiveConfirmFrames, numOr(cfg.blinkEvidenceConfirmFrames, 2))
    )
  )
  const inactiveConfirm = Math.max(
    1,
    Math.round(numOr(cfg.blinkInactiveConfirmFrames, 2))
  )

  if (evidence < forceThr) {
    ba[key] = false
    ba[enterKey] = 0
    ba[exitKey] = 0
    return
  }

  if (!ba[key]) {
    if (evidence >= activeThr) {
      ba[enterKey] += 1
    } else {
      ba[enterKey] = 0
    }
    ba[exitKey] = 0
    if (ba[enterKey] >= activeConfirm) {
      ba[key] = true
      ba[enterKey] = 0
    }
  } else {
    if (evidence < inactiveThr) {
      ba[exitKey] += 1
    } else {
      ba[exitKey] = 0
    }
    ba[enterKey] = 0
    if (ba[exitKey] >= inactiveConfirm) {
      ba[key] = false
      ba[exitKey] = 0
    }
  }
}

function updateBlinkActive(state, cfg, evidenceL, evidenceR) {
  const normal = ensureNormalState(state)
  const ba = normal.blinkActive
  updateBlinkActiveSide(ba, "L", evidenceL, cfg)
  updateBlinkActiveSide(ba, "R", evidenceR, cfg)
  return { left: ba.left, right: ba.right }
}

function resolveBlinkSpikeGuard(cfg, blinkActive, evidence, sideState, pairedSpike = false) {
  const disabled = cfg.blinkSpikeGuardEnabled === false
  const inactiveJumpThr = numOr(cfg.inactiveToActiveLargeJumpThreshold, 18)
  const activeJumpThr = numOr(cfg.activeLargeJumpThreshold, 22)
  const inactiveThr = numOr(cfg.blinkInactiveThreshold, 10)
  const confirmFrames = Math.max(1, Math.round(numOr(cfg.largeBlinkConfirmFrames, 3)))
  const firstLimit = numOr(cfg.firstLargeBlinkControlLimit, 6)
  const secondLimit = numOr(cfg.secondLargeBlinkControlLimit, 9)
  const confirmedLimit = numOr(cfg.confirmedLargeBlinkControlLimit, 12)
  const recoverFrames = Math.max(1, Math.round(numOr(cfg.spikeRecoverFrames, 4)))
  const recoverLimit = numOr(cfg.spikeRecoverControlLimit, 8)

  const evidenceBeforeUpdate = Number(sideState.previousStableBlinkEvidence) || 0
  const evidenceDelta = evidence - evidenceBeforeUpdate
  const largeJump = !blinkActive && evidenceDelta > inactiveJumpThr
  const intraActiveSpike = blinkActive && evidenceDelta > activeJumpThr

  let action = "idle-pass"
  let controlLimit = null

  if (disabled) {
    return buildSpikeGuardDebug({
      sideState,
      evidence,
      evidenceBeforeUpdate,
      evidenceDelta,
      largeJump,
      intraActiveSpike,
      pairedSpike,
      action: "disabled",
      controlLimit: null,
    })
  }

  if (largeJump || intraActiveSpike) {
    if (sideState.spikeState === "idle") {
      sideState.spikeState = "candidate"
      sideState.spikeConfirmCount = 1
      action = intraActiveSpike ? "intra-active-spike" : "spike-candidate"
    }
  }

  switch (sideState.spikeState) {
    case "candidate": {
      if (evidence >= inactiveThr || largeJump || intraActiveSpike) {
        if (!(largeJump || intraActiveSpike)) {
          sideState.spikeConfirmCount += 1
        }
        if (sideState.spikeConfirmCount >= confirmFrames) {
          sideState.spikeState = "confirmed"
          action = pairedSpike ? "spike-confirmed-paired" : "spike-confirmed"
        } else if (sideState.spikeConfirmCount >= 2) {
          action = "spike-confirming-2"
        } else {
          action = action === "idle-pass" ? "spike-confirming-1" : action
        }
        controlLimit =
          sideState.spikeConfirmCount >= confirmFrames
            ? confirmedLimit
            : sideState.spikeConfirmCount >= 2
              ? secondLimit
              : firstLimit
      } else {
        sideState.spikeState = "recovering"
        sideState.spikeRecoverFramesLeft = recoverFrames
        sideState.spikeConfirmCount = 0
        action = "spike-rejected"
        controlLimit = recoverLimit
      }
      break
    }
    case "confirmed": {
      controlLimit = confirmedLimit
      action = pairedSpike ? "spike-confirmed-paired" : "spike-confirmed"
      if (evidence < inactiveThr && evidenceDelta < inactiveJumpThr) {
        sideState.spikeState = "recovering"
        sideState.spikeRecoverFramesLeft = recoverFrames
        sideState.spikeConfirmCount = 0
        action = "spike-enter-recovering"
        controlLimit = recoverLimit
      }
      break
    }
    case "recovering": {
      controlLimit = recoverLimit
      action = "spike-recovering"
      sideState.spikeRecoverFramesLeft = Math.max(0, (sideState.spikeRecoverFramesLeft || 0) - 1)
      if (sideState.spikeRecoverFramesLeft <= 0) {
        sideState.spikeState = "idle"
        sideState.spikeConfirmCount = 0
        action = "spike-recover-done"
        controlLimit = null
      }
      break
    }
    default:
      break
  }

  if ((largeJump || intraActiveSpike) && sideState.spikeState === "candidate" && controlLimit == null) {
    controlLimit = firstLimit
  }

  return buildSpikeGuardDebug({
    sideState,
    evidence,
    evidenceBeforeUpdate,
    evidenceDelta,
    largeJump,
    intraActiveSpike,
    pairedSpike,
    action,
    controlLimit,
  })
}

function buildSpikeGuardDebug({
  sideState,
  evidence,
  evidenceBeforeUpdate,
  evidenceDelta,
  largeJump,
  intraActiveSpike,
  pairedSpike,
  action,
  controlLimit,
}) {
  return {
    spikeState: sideState.spikeState,
    confirmCount: sideState.spikeConfirmCount,
    spikeRecoverFramesLeft: sideState.spikeRecoverFramesLeft,
    evidenceBeforeUpdate,
    candidateBlinkEvidence: evidence,
    previousBlinkEvidence: evidenceBeforeUpdate,
    evidenceDelta,
    largeJump,
    intraActiveSpike,
    pairedSpike,
    action,
    controlLimit,
    active: sideState.spikeState !== "idle" || controlLimit != null,
  }
}

function stabilizeChannel({
  raw,
  neutral,
  prevStab,
  zeroLatch,
  cfg,
  side,
  channel,
  blinkActive,
  spikeControlLimit,
}) {
  const rel = raw - neutral
  const { upGain, loGain } = resolveBaseGains(cfg, side)
  const bal = resolveBalanceGains(cfg, side)
  const isUp = channel === "up"
  const baseGain = isUp ? upGain : loGain
  const closeSign = isUp ? bal.upperCloseSign : bal.lowerCloseSign
  const closeGain = isUp ? bal.upperCloseGain : bal.lowerCloseGain
  const openGain = isUp ? bal.upperOpenGain : bal.lowerOpenGain

  const afterBase = rel * baseGain
  const afterBalance = applyDirectionalEyeGain(afterBase, closeSign, closeGain, openGain)

  const beforeSpikeGuard = afterBalance
  let afterSpikeGuard = afterBalance
  let limitedBySpikeGuard = false
  if (spikeControlLimit != null && spikeControlLimit > 0) {
    const clamped = prevStab + clampAbs(afterBalance - prevStab, spikeControlLimit)
    limitedBySpikeGuard = Math.abs(clamped - afterBalance) > 1e-6
    afterSpikeGuard = clamped
  }

  const isCloseDirection =
    afterSpikeGuard !== 0 &&
    Math.sign(afterSpikeGuard) === Math.sign(Number(closeSign) || -1)
  const alpha = pickAlpha(cfg, blinkActive, isCloseDirection)
  let afterStabilizer = ema(prevStab, afterSpikeGuard, alpha)

  const slewLimit = resolveSlewLimit(cfg, blinkActive, isCloseDirection)
  let limitedByStabilizer = false
  if (slewLimit > 0) {
    const clamped = prevStab + clampAbs(afterStabilizer - prevStab, slewLimit)
    limitedByStabilizer = Math.abs(clamped - afterStabilizer) > 1e-6
    afterStabilizer = clamped
  }

  const zl = applyZeroLatch(afterStabilizer, zeroLatch, cfg, blinkActive)
  const final = zl.value

  return {
    raw,
    neutral,
    relative: rel,
    afterBaseGain: afterBase,
    afterBalanceGain: afterBalance,
    beforeSpikeGuard,
    afterSpikeGuard,
    afterStabilizer,
    afterZeroLatch: final,
    final,
    zeroLatched: zl.latched,
    blinkActive,
    alpha,
    limitedByStabilizer,
    limitedBySpikeGuard,
    changedByGuard: limitedBySpikeGuard,
    controlDeltaLimited: limitedBySpikeGuard,
    controlDelta: afterStabilizer - prevStab,
    targetDelta: afterSpikeGuard - prevStab,
  }
}

function learnNeutralWhenOpen(state, cfg, raw, rel, channelKey) {
  const normal = ensureNormalState(state)
  const learnAlpha = numOr(cfg.neutralLearnAlpha, 0.06)
  const openThr = numOr(cfg.inactiveZeroExitThreshold, 9)
  if (Math.abs(rel) < openThr) {
    normal.neutral[channelKey] = ema(normal.neutral[channelKey] || 0, raw, learnAlpha)
  }
}

function learnBlinkNeutralWhenOpen(state, cfg, rawVal, relVal, key) {
  const normal = ensureNormalState(state)
  const learnAlpha = numOr(cfg.neutralLearnAlpha, 0.06)
  const openThr = numOr(cfg.blinkInactiveThreshold, 7) / numOr(cfg.blinkBlendshapeScale, 100)
  if (Math.abs(relVal) < openThr) {
    normal.neutral[key] = ema(normal.neutral[key] || 0, rawVal, learnAlpha)
  }
}

/**
 * @param {object} blinkCtx { blinkBlendL?, blinkBlendR? } blendshape 0~1
 */
export function stabilizeEyesNormal(prevL, prevR, nextL, nextR, cfg, state, blinkCtx = null) {
  const normal = ensureNormalState(state)

  const raw = {
    lUp: Number(nextL.up) || 0,
    lLo: Number(nextL.lo) || 0,
    rUp: Number(nextR.up) || 0,
    rLo: Number(nextR.lo) || 0,
  }

  const rawBlinkProxy = {
    l: eyeBlinkProxy(raw.lUp, raw.lLo),
    r: eyeBlinkProxy(raw.rUp, raw.rLo),
  }
  const rawBlinkBlendshape = {
    l: numOr(blinkCtx?.blinkBlendL, 0),
    r: numOr(blinkCtx?.blinkBlendR, 0),
  }

  if (
    normal.neutral.lUp === 0 &&
    normal.neutral.lLo === 0 &&
    normal.neutral.rUp === 0 &&
    normal.neutral.rLo === 0
  ) {
    initNeutralFromRaw(normal, raw, blinkCtx)
  }

  const rel = {
    lUp: raw.lUp - normal.neutral.lUp,
    lLo: raw.lLo - normal.neutral.lLo,
    rUp: raw.rUp - normal.neutral.rUp,
    rLo: raw.rLo - normal.neutral.rLo,
  }

  const relBlinkProxy = {
    l: Math.max(0, rawBlinkProxy.l - normal.neutral.blinkProxyL),
    r: Math.max(0, rawBlinkProxy.r - normal.neutral.blinkProxyR),
  }
  const relBlinkBlendshape = {
    l: Math.max(0, rawBlinkBlendshape.l - normal.neutral.eyeBlinkLeftBlendshape),
    r: Math.max(0, rawBlinkBlendshape.r - normal.neutral.eyeBlinkRightBlendshape),
  }

  const evidenceL = resolveBlinkEvidence(cfg, { lUp: rel.lUp, lLo: rel.lLo }, relBlinkProxy.l, relBlinkBlendshape.l)
  const evidenceR = resolveBlinkEvidence(cfg, { lUp: rel.rUp, lLo: rel.rLo }, relBlinkProxy.r, relBlinkBlendshape.r)

  const blinkActive = updateBlinkActive(state, cfg, evidenceL, evidenceR)

  const spikeGuardL = resolveBlinkSpikeGuard(
    cfg,
    blinkActive.left,
    evidenceL,
    normal.spikeGuard.left,
    false
  )
  const spikeGuardR = resolveBlinkSpikeGuard(
    cfg,
    blinkActive.right,
    evidenceR,
    normal.spikeGuard.right,
    false
  )

  const pairedSpike = Boolean(spikeGuardL.largeJump && spikeGuardR.largeJump)
  if (pairedSpike) {
    spikeGuardL.pairedSpike = true
    spikeGuardR.pairedSpike = true
  }

  if (!blinkActive.left) {
    learnNeutralWhenOpen(state, cfg, raw.lUp, rel.lUp, "lUp")
    learnNeutralWhenOpen(state, cfg, raw.lLo, rel.lLo, "lLo")
    learnBlinkNeutralWhenOpen(state, cfg, rawBlinkProxy.l, relBlinkProxy.l, "blinkProxyL")
    learnBlinkNeutralWhenOpen(
      state,
      cfg,
      rawBlinkBlendshape.l,
      relBlinkBlendshape.l,
      "eyeBlinkLeftBlendshape"
    )
  }
  if (!blinkActive.right) {
    learnNeutralWhenOpen(state, cfg, raw.rUp, rel.rUp, "rUp")
    learnNeutralWhenOpen(state, cfg, raw.rLo, rel.rLo, "rLo")
    learnBlinkNeutralWhenOpen(state, cfg, rawBlinkProxy.r, relBlinkProxy.r, "blinkProxyR")
    learnBlinkNeutralWhenOpen(
      state,
      cfg,
      rawBlinkBlendshape.r,
      relBlinkBlendshape.r,
      "eyeBlinkRightBlendshape"
    )
  }

  const channels = [
    stabilizeChannel({
      raw: raw.lUp,
      neutral: normal.neutral.lUp,
      prevStab: normal.prev.lUp,
      zeroLatch: normal.zeroLatch.lUp,
      cfg,
      side: "L",
      channel: "up",
      blinkActive: blinkActive.left,
      spikeControlLimit: spikeGuardL.controlLimit,
    }),
    stabilizeChannel({
      raw: raw.lLo,
      neutral: normal.neutral.lLo,
      prevStab: normal.prev.lLo,
      zeroLatch: normal.zeroLatch.lLo,
      cfg,
      side: "L",
      channel: "lo",
      blinkActive: blinkActive.left,
      spikeControlLimit: spikeGuardL.controlLimit,
    }),
    stabilizeChannel({
      raw: raw.rUp,
      neutral: normal.neutral.rUp,
      prevStab: normal.prev.rUp,
      zeroLatch: normal.zeroLatch.rUp,
      cfg,
      side: "R",
      channel: "up",
      blinkActive: blinkActive.right,
      spikeControlLimit: spikeGuardR.controlLimit,
    }),
    stabilizeChannel({
      raw: raw.rLo,
      neutral: normal.neutral.rLo,
      prevStab: normal.prev.rLo,
      zeroLatch: normal.zeroLatch.rLo,
      cfg,
      side: "R",
      channel: "lo",
      blinkActive: blinkActive.right,
      spikeControlLimit: spikeGuardR.controlLimit,
    }),
  ]

  normal.prev = {
    lUp: channels[0].afterStabilizer,
    lLo: channels[1].afterStabilizer,
    rUp: channels[2].afterStabilizer,
    rLo: channels[3].afterStabilizer,
  }

  normal.spikeGuard.left.previousStableBlinkEvidence = evidenceL
  normal.spikeGuard.right.previousStableBlinkEvidence = evidenceR
  normal.prevBlinkEvidence = { left: evidenceL, right: evidenceR }

  const pick = (fn) => ({
    lUp: fn(channels[0]),
    lLo: fn(channels[1]),
    rUp: fn(channels[2]),
    rLo: fn(channels[3]),
  })

  const eyeNormalDebug = {
    raw,
    neutral: {
      lUp: normal.neutral.lUp,
      lLo: normal.neutral.lLo,
      rUp: normal.neutral.rUp,
      rLo: normal.neutral.rLo,
    },
    relative: rel,
    rawBlinkProxy,
    neutralBlinkProxy: {
      l: normal.neutral.blinkProxyL,
      r: normal.neutral.blinkProxyR,
    },
    relBlinkProxy,
    rawBlinkBlendshape,
    neutralBlinkBlendshape: {
      l: normal.neutral.eyeBlinkLeftBlendshape,
      r: normal.neutral.eyeBlinkRightBlendshape,
    },
    relBlinkBlendshape,
    blinkEvidence: { l: evidenceL, r: evidenceR, left: evidenceL, right: evidenceR },
    blinkActive,
    afterBaseGain: pick((c) => c.afterBaseGain),
    afterBalanceGain: pick((c) => c.afterBalanceGain),
    afterSpikeGuard: pick((c) => c.afterSpikeGuard),
    afterStabilizer: pick((c) => c.afterStabilizer),
    afterZeroLatch: pick((c) => c.afterZeroLatch),
    final: pick((c) => c.final),
    zeroLatch: {
      lUp: normal.zeroLatch.lUp.latched,
      lLo: normal.zeroLatch.lLo.latched,
      rUp: normal.zeroLatch.rUp.latched,
      rLo: normal.zeroLatch.rLo.latched,
    },
    blinkSpikeGuard: {
      left: spikeGuardL,
      right: spikeGuardR,
      pairedSpike,
      beforeSpikeGuard: pick((c) => c.beforeSpikeGuard),
      afterSpikeGuard: pick((c) => c.afterSpikeGuard),
      changedByGuard: channels.some((c) => c.changedByGuard),
      controlDeltaLimited: channels.some((c) => c.controlDeltaLimited),
    },
  }

  const eyeLatencyDebug = {
    controlDelta: pick((c) => roundCh(c.controlDelta)),
    targetDelta: pick((c) => roundCh(c.targetDelta)),
    limitedByStabilizer: pick((c) => c.limitedByStabilizer),
    limitedBySpikeGuard: pick((c) => c.limitedBySpikeGuard),
    limitedBySafety: false,
    zeroLatchHeld: pick((c) => c.zeroLatched),
    writeDurationMs: null,
  }

  const debug = {
    pipeline: {
      raw: eyeNormalDebug.raw,
      neutral: eyeNormalDebug.neutral,
      relative: eyeNormalDebug.relative,
      afterBaseGain: eyeNormalDebug.afterBaseGain,
      afterBalanceGain: eyeNormalDebug.afterBalanceGain,
      afterSpikeGuard: eyeNormalDebug.afterSpikeGuard,
      afterStabilizer: eyeNormalDebug.afterStabilizer,
      afterZeroLatch: eyeNormalDebug.afterZeroLatch,
      final: eyeNormalDebug.final,
    },
    eyeNormalDebug,
    blinkActive,
    blinkEvidence: eyeNormalDebug.blinkEvidence,
    blinkSpikeGuard: eyeNormalDebug.blinkSpikeGuard,
    zeroLatch: eyeNormalDebug.zeroLatch,
    eyeLatencyDebug,
  }

  return {
    eyeL: { up: channels[0].final, lo: channels[1].final },
    eyeR: { up: channels[2].final, lo: channels[3].final },
    debug,
    left: {
      raw: { up: raw.lUp, lo: raw.lLo },
      afterBaseGain: { up: channels[0].afterBaseGain, lo: channels[1].afterBaseGain },
      afterBalanceGain: { up: channels[0].afterBalanceGain, lo: channels[1].afterBalanceGain },
      afterSpikeGuard: { up: channels[0].afterSpikeGuard, lo: channels[1].afterSpikeGuard },
      final: { up: channels[0].final, lo: channels[1].final },
      releasing: false,
      releaseReason: "bypassed-normal",
    },
    right: {
      raw: { up: raw.rUp, lo: raw.rLo },
      afterBaseGain: { up: channels[2].afterBaseGain, lo: channels[3].afterBaseGain },
      afterBalanceGain: { up: channels[2].afterBalanceGain, lo: channels[3].afterBalanceGain },
      afterSpikeGuard: { up: channels[2].afterSpikeGuard, lo: channels[3].afterSpikeGuard },
      final: { up: channels[2].final, lo: channels[3].final },
      releasing: false,
      releaseReason: "bypassed-normal",
    },
  }
}

function roundCh(v) {
  return Math.round((Number(v) || 0) * 100) / 100
}
