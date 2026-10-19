/**
 * 右眉 Five-Bar Pair Servo（V2）：
 * - DISCRETE：qF/qD 共享 smoothstep（点击 / Reset / Preset）
 * - CONTINUOUS / FINAL_SETTLE：A 任务空间 Continuous Servo → 每 Tick 完整 IK(nextA)
 */

import {
  BROW_FIVEBAR_LEFT_ANCHORS,
  BROW_FIVEBAR_RIGHT_GEOMETRY,
  browFiveBarFkWorld,
  browPadToWorldA,
  createBrowFiveBarState,
  normalizeBrowFiveBarSideId,
  solveBrowFiveBarFromWorldA,
} from "./browFiveBarKinematics.js"

/**
 * 眉尖 Pair Servo 运动模式（左右共用）。
 * @typedef {"discrete" | "continuous" | "final_settle" | "direct" | "observe"} BrowFiveBarMotionMode
 */

/** @deprecated 兼容旧名 */
export const RIGHT_BROW_MOTION_MODE = Object.freeze({
  DISCRETE_TRAJECTORY: "discrete",
  CONTINUOUS_SERVO: "continuous",
  FINAL_SETTLE: "final_settle",
  DIRECT: "direct",
  OBSERVE: "observe",
})

export const BROW_FIVEBAR_MOTION_MODE = RIGHT_BROW_MOTION_MODE

/** 左右共用 Pair 控制默认配置 */
export const BROW_FIVEBAR_PAIR_SERVO_CONFIG = Object.freeze({
  maxServoHz: 150,
  continuousServoHz: 150,
  maxVelocityMmPerSec: 480,
  maxAccelerationMmPerSec2: 12000,
  arriveEpsMm: 0.04,
  continuousDeviceTimeMs: 0,
  continuousDeviceSpeed: 0,
  discreteNominalSpeedDegPerSec: 300,
  discreteMinDurationMs: 25,
  discreteMaxDurationMs: 160,
  finalSettleMinMs: 20,
  finalSettleMaxMs: 60,
  replanThresholdDeg: 0.02,
  arriveEpsDeg: 0.05,
  tickJitterSampleSize: 64,
  continuousMaxRateDegPerSec: 720,
})

/** @deprecated 兼容旧名 */
export const RIGHT_BROW_PAIR_SERVO_CONFIG = BROW_FIVEBAR_PAIR_SERVO_CONFIG

/** @deprecated */
export const RIGHT_BROW_SYNC_DEFAULTS = Object.freeze({
  maxRateDegPerSec: BROW_FIVEBAR_PAIR_SERVO_CONFIG.discreteNominalSpeedDegPerSec,
  minDurationMs: BROW_FIVEBAR_PAIR_SERVO_CONFIG.discreteMinDurationMs,
  maxDurationMs: BROW_FIVEBAR_PAIR_SERVO_CONFIG.discreteMaxDurationMs,
  replanEpsDeg: BROW_FIVEBAR_PAIR_SERVO_CONFIG.replanThresholdDeg,
  arriveEpsDeg: BROW_FIVEBAR_PAIR_SERVO_CONFIG.arriveEpsDeg,
})

export function smoothstep01(t) {
  const x = Math.max(0, Math.min(1, Number(t) || 0))
  return x * x * (3 - 2 * x)
}

export function lerp(a, b, u) {
  return Number(a) + (Number(b) - Number(a)) * u
}

function nearly(a, b, eps) {
  return Math.abs(Number(a) - Number(b)) <= eps
}

function resolveConfig(opts = {}) {
  return {
    ...BROW_FIVEBAR_PAIR_SERVO_CONFIG,
    ...RIGHT_BROW_SYNC_DEFAULTS,
    ...(opts || {}),
    discreteNominalSpeedDegPerSec:
      opts.discreteNominalSpeedDegPerSec ??
      opts.maxRateDegPerSec ??
      BROW_FIVEBAR_PAIR_SERVO_CONFIG.discreteNominalSpeedDegPerSec,
    discreteMinDurationMs:
      opts.discreteMinDurationMs ??
      opts.minDurationMs ??
      BROW_FIVEBAR_PAIR_SERVO_CONFIG.discreteMinDurationMs,
    discreteMaxDurationMs:
      opts.discreteMaxDurationMs ??
      opts.maxDurationMs ??
      BROW_FIVEBAR_PAIR_SERVO_CONFIG.discreteMaxDurationMs,
    replanThresholdDeg:
      opts.replanThresholdDeg ??
      opts.replanEpsDeg ??
      BROW_FIVEBAR_PAIR_SERVO_CONFIG.replanThresholdDeg,
    maxServoHz: opts.maxServoHz ?? opts.continuousServoHz ?? BROW_FIVEBAR_PAIR_SERVO_CONFIG.maxServoHz,
  }
}

export function computeRightBrowSyncDurationMs(deltaF, deltaD, opts = {}) {
  const cfg = resolveConfig(opts)
  const maxDelta = Math.max(Math.abs(Number(deltaF) || 0), Math.abs(Number(deltaD) || 0))
  if (maxDelta < 1e-9) return 0
  const t = (maxDelta / Math.max(1e-6, cfg.discreteNominalSpeedDegPerSec)) * 1000
  return Math.max(cfg.discreteMinDurationMs, Math.min(cfg.discreteMaxDurationMs, Math.round(t)))
}

export function computeFinalSettleDurationMs(deltaF, deltaD, opts = {}) {
  const cfg = resolveConfig(opts)
  const maxDelta = Math.max(Math.abs(Number(deltaF) || 0), Math.abs(Number(deltaD) || 0))
  if (maxDelta < 1e-9) return 0
  const t = (maxDelta / Math.max(1e-6, cfg.discreteNominalSpeedDegPerSec)) * 1000
  return Math.max(cfg.finalSettleMinMs, Math.min(cfg.finalSettleMaxMs, Math.round(t)))
}

/** @deprecated q-space；测试兼容 */
export function computeSharedPairStep(deltaF, deltaD, maxStepDeg, arriveEpsDeg = 0.05) {
  const dF = Number(deltaF) || 0
  const dD = Number(deltaD) || 0
  const maxAbs = Math.max(Math.abs(dF), Math.abs(dD))
  if (maxAbs <= arriveEpsDeg) {
    return { sharedStep: 1, maxAbs, stepF: dF, stepD: dD }
  }
  const cap = Math.max(0, Number(maxStepDeg) || 0)
  const sharedStep = cap <= 0 ? 0 : Math.min(1, cap / maxAbs)
  return { sharedStep, maxAbs, stepF: sharedStep * dF, stepD: sharedStep * dD }
}

/**
 * A 任务空间二维向量伺服：X/Y 共用同一方向，禁止分轴独立 slew。
 * Retarget 不强制 velocity=0。
 */
export function stepTaskSpaceAServo({
  currentA,
  velocityA,
  desiredA,
  dtSec,
  maxVelocityMmPerSec,
  maxAccelerationMmPerSec2,
  arriveEpsMm = 0.04,
} = {}) {
  const cur = {
    x: Number(currentA?.x) || 0,
    y: Number(currentA?.y) || 0,
  }
  const des = {
    x: Number(desiredA?.x) || 0,
    y: Number(desiredA?.y) || 0,
  }
  const vel = {
    x: Number(velocityA?.x) || 0,
    y: Number(velocityA?.y) || 0,
  }
  const dt = Math.max(1e-4, Number(dtSec) || 1e-3)
  const maxV = Math.max(1e-6, Number(maxVelocityMmPerSec) || 1)
  const maxA = Math.max(1e-6, Number(maxAccelerationMmPerSec2) || 1)
  const eps = Math.max(0, Number(arriveEpsMm) || 0)

  const dx = des.x - cur.x
  const dy = des.y - cur.y
  const dist = Math.hypot(dx, dy)
  if (dist <= eps) {
    return {
      nextA: { x: des.x, y: des.y },
      velocityA: { x: 0, y: 0 },
      arrived: true,
      aErrorMm: dist,
      stepMm: 0,
    }
  }

  const ux = dx / dist
  const uy = dy / dist
  const vAlong = vel.x * ux + vel.y * uy

  /* 制动距离：沿目标方向减速到 0 */
  const brakeDist = vAlong > 0 ? (vAlong * vAlong) / (2 * maxA) : 0
  let targetSpeed = maxV
  if (dist <= brakeDist) {
    targetSpeed = Math.sqrt(Math.max(0, 2 * maxA * dist))
  }

  let newVAlong = vAlong
  if (vAlong < targetSpeed) {
    newVAlong = Math.min(targetSpeed, vAlong + maxA * dt)
  } else {
    newVAlong = Math.max(targetSpeed, vAlong - maxA * dt)
  }
  newVAlong = Math.max(-maxV, Math.min(maxV, newVAlong))

  let step = newVAlong * dt
  let next = { x: cur.x + ux * step, y: cur.y + uy * step }

  /* 越过目标则钳到 desired，速度沿向清零 */
  const toDesAfter = { x: des.x - next.x, y: des.y - next.y }
  if (toDesAfter.x * dx + toDesAfter.y * dy <= 0) {
    next = { x: des.x, y: des.y }
    newVAlong = 0
    step = dist
  }

  return {
    nextA: next,
    velocityA: { x: ux * newVAlong, y: uy * newVAlong },
    arrived: Math.hypot(des.x - next.x, des.y - next.y) <= eps,
    aErrorMm: dist,
    stepMm: step,
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

function pushSendSample(g, intervalMs) {
  if (!Number.isFinite(intervalMs) || intervalMs < 0) return
  const size = BROW_FIVEBAR_PAIR_SERVO_CONFIG.tickJitterSampleSize
  if (!Array.isArray(g.sendIntervalSamples)) g.sendIntervalSamples = []
  g.sendIntervalSamples.push(intervalMs)
  if (g.sendIntervalSamples.length > size) {
    g.sendIntervalSamples.splice(0, g.sendIntervalSamples.length - size)
  }
  g.sendCount = (Number(g.sendCount) || 0) + 1
  const elapsed = Math.max(
    1e-3,
    (g.lastSendTimestampMs || 0) - (g.controlSessionStartMs || g.lastSendTimestampMs || 0)
  )
  if (g.controlSessionStartMs != null && g.sendCount > 1) {
    g.actualSendHz = ((g.sendCount - 1) * 1000) / elapsed
  }
  const sorted = [...g.sendIntervalSamples].sort((a, b) => a - b)
  g.sendIntervalP50 = percentile(sorted, 50)
  g.sendIntervalP95 = percentile(sorted, 95)
  const mean =
    g.sendIntervalSamples.reduce((s, v) => s + v, 0) / Math.max(1, g.sendIntervalSamples.length)
  let maxJ = 0
  for (const v of g.sendIntervalSamples) maxJ = Math.max(maxJ, Math.abs(v - mean))
  g.maxSendIntervalMs = sorted.length ? sorted[sorted.length - 1] : null
  g.maxTickJitterMs = maxJ
  g.tickIntervalP50 = g.sendIntervalP50
  g.tickIntervalP95 = g.sendIntervalP95
  g.actualTickHz = g.actualSendHz
}

function sideA0(sideId) {
  return normalizeBrowFiveBarSideId(sideId) === "left"
    ? BROW_FIVEBAR_LEFT_ANCHORS.A0
    : BROW_FIVEBAR_RIGHT_GEOMETRY.A0
}

/**
 * 左右共用 Brow Five-Bar Pair Servo。
 * @param {"left"|"right"} [sideId]
 * @param {object} [seed]
 */
export function createBrowFiveBarPairServo(sideId = "right", seed = null) {
  const side = normalizeBrowFiveBarSideId(sideId)
  const A0 = sideA0(side)
  const cfg = BROW_FIVEBAR_PAIR_SERVO_CONFIG
  return {
    sideId: side,
    seq: 0,
    pairSeq: 0,
    mode: BROW_FIVEBAR_MOTION_MODE.DISCRETE_TRAJECTORY,
    space: "q",
    active: false,
    startTimeMs: 0,
    durationMs: 0,
    startF: 0,
    startD: 0,
    targetF: 0,
    targetD: 0,
    desiredF: 0,
    desiredD: 0,
    currentF: 0,
    currentD: 0,
    velocityF: 0,
    velocityD: 0,
    sharedStep: 1,
    sharedProgress: 1,
    nextF: 0,
    nextD: 0,
    desiredA: { x: A0[0], y: A0[1] },
    nextA: { x: A0[0], y: A0[1] },
    commandedA: { x: A0[0], y: A0[1] },
    lastSuccessfullySentA: { x: A0[0], y: A0[1] },
    velocityA: { x: 0, y: 0 },
    aErrorMm: 0,
    actualDtMs: null,
    targetX: 0,
    targetY: 0,
    fFinished: true,
    dFinished: true,
    groupFinished: true,
    finalSettleActive: false,
    batchSendCount: 0,
    lastBatchSendTimeMs: null,
    plannedEndTimeMs: null,
    lastReplanReason: "init",
    lastIkOk: true,
    lastRejectReason: "",
    latestTargetSeq: 0,
    latestTargetTimeMs: null,
    latestTargetAgeMs: null,
    lastScheduledF: 0,
    lastScheduledD: 0,
    lastSuccessfullySentF: 0,
    lastSuccessfullySentD: 0,
    lastSendTimestampMs: null,
    lastTickMs: null,
    controlSessionStartMs: null,
    requestedTickHz: cfg.maxServoHz,
    maxServoHz: cfg.maxServoHz,
    actualTickHz: null,
    actualSendHz: null,
    tickIntervalP50: null,
    tickIntervalP95: null,
    sendIntervalP50: null,
    sendIntervalP95: null,
    maxSendIntervalMs: null,
    maxTickJitterMs: null,
    tickIntervalSamples: [],
    sendIntervalSamples: [],
    tickCount: 0,
    sendCount: 0,
    sendStartTimeMs: null,
    fSendTimeMs: null,
    dSendTimeMs: null,
    syncWrite: false,
    syncWriteDurationMs: null,
    servoInternalTime: null,
    servoInternalSpeed: null,
    fivebarState: createBrowFiveBarState(),
    ...(seed && typeof seed === "object" ? seed : {}),
    sideId: side,
  }
}

/** @deprecated 右眉别名 */
export function createRightBrowFiveBarSyncGroup(seed = null) {
  return createBrowFiveBarPairServo("right", seed)
}

export function createLeftBrowFiveBarPairServo(seed = null) {
  return createBrowFiveBarPairServo("left", seed)
}

function authoritativeCurrentA(g) {
  const a = g.lastSuccessfullySentA
  if (a && Number.isFinite(Number(a.x)) && Number.isFinite(Number(a.y))) {
    return { x: Number(a.x), y: Number(a.y) }
  }
  const A0 = sideA0(g.sideId)
  return { x: A0[0], y: A0[1] }
}

function noteLatestPadTarget(g, padX, padY, desiredA, nowMs) {
  const ax = Number(desiredA?.x)
  const ay = Number(desiredA?.y)
  const changed =
    !nearly(padX, g.targetX, 1e-6) ||
    !nearly(padY, g.targetY, 1e-6) ||
    !nearly(ax, g.desiredA?.x, 1e-6) ||
    !nearly(ay, g.desiredA?.y, 1e-6)
  g.targetX = padX
  g.targetY = padY
  g.desiredA = { x: ax, y: ay }
  if (changed) {
    g.latestTargetSeq = (Number(g.latestTargetSeq) || 0) + 1
    g.latestTargetTimeMs = nowMs
  }
  if (g.latestTargetTimeMs != null) {
    g.latestTargetAgeMs = Math.max(0, nowMs - g.latestTargetTimeMs)
  }
  return changed
}

function beginDiscreteTrajectory(g, startF, startD, qFTarget, qDTarget, nowMs, durationMs, reason) {
  g.seq += 1
  g.pairSeq = g.seq
  g.space = "q"
  g.active = true
  g.finalSettleActive = reason === "final-settle-q"
  g.startTimeMs = nowMs
  g.durationMs = durationMs
  g.startF = startF
  g.startD = startD
  g.targetF = qFTarget
  g.targetD = qDTarget
  g.desiredF = qFTarget
  g.desiredD = qDTarget
  g.plannedEndTimeMs = durationMs > 0 ? nowMs + durationMs : nowMs
  g.lastReplanReason = reason
  g.sharedProgress = durationMs <= 0 ? 1 : 0
  g.sharedStep = durationMs <= 0 ? 1 : 0
}

function stepDiscreteLike(g, nowMs) {
  let progress = 1
  if (g.durationMs > 0) {
    const u = (nowMs - g.startTimeMs) / g.durationMs
    progress = smoothstep01(u)
  }
  const qF = lerp(g.startF, g.targetF, progress)
  const qD = lerp(g.startD, g.targetD, progress)
  const dt = Math.max(1e-6, (nowMs - (g.lastTickMs ?? nowMs)) / 1000)
  if (g.lastTickMs != null) {
    g.velocityF = (qF - g.currentF) / dt
    g.velocityD = (qD - g.currentD) / dt
  }
  g.sharedProgress = progress
  g.sharedStep = progress
  g.nextF = qF
  g.nextD = qD
  g.lastScheduledF = qF
  g.lastScheduledD = qD
  g.currentF = qF
  g.currentD = qD
  const cfgArrive = BROW_FIVEBAR_PAIR_SERVO_CONFIG.arriveEpsDeg
  g.fFinished = nearly(qF, g.targetF, cfgArrive) || progress >= 1 - 1e-9
  g.dFinished = nearly(qD, g.targetD, cfgArrive) || progress >= 1 - 1e-9
  g.groupFinished = g.fFinished && g.dFinished
  if (g.groupFinished) {
    g.currentF = g.targetF
    g.currentD = g.targetD
    g.nextF = g.targetF
    g.nextD = g.targetD
    g.lastScheduledF = g.targetF
    g.lastScheduledD = g.targetD
    g.sharedProgress = 1
    g.sharedStep = 1
    g.velocityF = 0
    g.velocityD = 0
    g.active = false
    g.finalSettleActive = false
  }
  return { qF: g.currentF, qD: g.currentD, progress: g.sharedProgress }
}

/**
 * Continuous / settle：A-space → IK(nextA) → qF/qD
 */
function stepASpaceContinuous(g, args, cfg, nowMs, settle) {
  const side = normalizeBrowFiveBarSideId(g.sideId || args.sideId || "right")
  g.sideId = side
  const padX = Number(args.targetX)
  const padY = Number(args.targetY)
  let desiredA = args.desiredA
  if (
    !desiredA ||
    !Number.isFinite(Number(desiredA.x)) ||
    !Number.isFinite(Number(desiredA.y))
  ) {
    const world = browPadToWorldA(
      {
        x: Number.isFinite(padX) ? padX : g.targetX,
        y: Number.isFinite(padY) ? padY : g.targetY,
      },
      side
    )
    desiredA = { x: world[0], y: world[1] }
  }

  noteLatestPadTarget(
    g,
    Number.isFinite(padX) ? padX : g.targetX,
    Number.isFinite(padY) ? padY : g.targetY,
    desiredA,
    nowMs
  )

  const dtMsRaw =
    g.lastSendTimestampMs != null
      ? nowMs - g.lastSendTimestampMs
      : g.lastTickMs != null
        ? nowMs - g.lastTickMs
        : 1000 / Math.max(1, cfg.maxServoHz)
  const dtMs = Math.max(0.5, dtMsRaw)
  g.actualDtMs = dtMs

  if (g.controlSessionStartMs == null) g.controlSessionStartMs = nowMs

  const currentA = authoritativeCurrentA(g)
  const maxV = settle ? cfg.maxVelocityMmPerSec * 1.25 : cfg.maxVelocityMmPerSec
  const maxAcc = settle ? cfg.maxAccelerationMmPerSec2 * 1.5 : cfg.maxAccelerationMmPerSec2

  const stepped = stepTaskSpaceAServo({
    currentA,
    velocityA: g.velocityA || { x: 0, y: 0 },
    desiredA: g.desiredA,
    dtSec: dtMs / 1000,
    maxVelocityMmPerSec: maxV,
    maxAccelerationMmPerSec2: maxAcc,
    arriveEpsMm: cfg.arriveEpsMm,
  })

  g.velocityA = stepped.velocityA
  g.nextA = stepped.nextA
  g.commandedA = stepped.nextA
  g.aErrorMm = stepped.aErrorMm
  g.space = "A"
  g.finalSettleActive = Boolean(settle)
  g.lastReplanReason = settle ? "a-space-final-settle" : "a-space-continuous"
  /* Face Rig 实机走 single-write；Host 成对调度 */
  g.syncWrite = false
  g.servoInternalTime = cfg.continuousDeviceTimeMs
  g.servoInternalSpeed = cfg.continuousDeviceSpeed

  const ik = solveBrowFiveBarFromWorldA(
    [stepped.nextA.x, stepped.nextA.y],
    side,
    g.fivebarState || createBrowFiveBarState()
  )
  if (!ik.ok || !Number.isFinite(ik.qFDeg) || !Number.isFinite(ik.qDDeg)) {
    g.lastIkOk = false
    g.lastRejectReason = ik.message || "ik-failed"
    const authF = g.lastSuccessfullySentF
    const authD = g.lastSuccessfullySentD
    return {
      group: g,
      qF: authF,
      qD: authD,
      accept: false,
      reason: g.lastRejectReason,
      nextA: stepped.nextA,
      desiredA: g.desiredA,
      sharedStep: 0,
      progress: 0,
      seq: g.seq,
      pairSeq: g.pairSeq,
      mode: g.mode,
      space: "A",
    }
  }

  g.lastIkOk = true
  g.lastRejectReason = ""
  g.pairSeq = (Number(g.pairSeq) || 0) + 1
  g.seq = g.pairSeq
  g.nextF = ik.qFDeg
  g.nextD = ik.qDDeg
  g.lastScheduledF = ik.qFDeg
  g.lastScheduledD = ik.qDDeg
  g.desiredF = ik.qFDeg
  g.desiredD = ik.qDDeg
  g.targetF = ik.qFDeg
  g.targetD = ik.qDDeg
  g.sharedStep = stepped.arrived ? 1 : Math.min(1, Math.abs(stepped.stepMm) / Math.max(1e-9, stepped.aErrorMm))
  g.sharedProgress = g.sharedStep
  g.active = !stepped.arrived
  g.fFinished = stepped.arrived
  g.dFinished = stepped.arrived
  g.groupFinished = stepped.arrived
  if (stepped.arrived) {
    g.finalSettleActive = false
    g.velocityA = { x: 0, y: 0 }
  }
  g.lastTickMs = nowMs

  return {
    group: g,
    qF: ik.qFDeg,
    qD: ik.qDDeg,
    accept: true,
    reason: "",
    nextA: stepped.nextA,
    desiredA: g.desiredA,
    sharedStep: g.sharedStep,
    progress: g.sharedProgress,
    seq: g.seq,
    pairSeq: g.pairSeq,
    mode: g.mode,
    space: "A",
    ik,
  }
}

/**
 * @param {ReturnType<typeof createRightBrowFiveBarSyncGroup>} group
 * @param {object} args
 */
export function stepRightBrowFiveBarSyncGroup(group, args = {}) {
  const g = group || createRightBrowFiveBarSyncGroup()
  const now = Number(args.nowMs)
  const nowMs = Number.isFinite(now) ? now : performance.now()
  const cfg = resolveConfig(args.opts)
  g.requestedTickHz = cfg.maxServoHz
  g.maxServoHz = cfg.maxServoHz

  let motionMode = String(args.mode || g.mode || RIGHT_BROW_MOTION_MODE.DISCRETE_TRAJECTORY)
  if (motionMode === "host") motionMode = RIGHT_BROW_MOTION_MODE.CONTINUOUS_SERVO
  if (motionMode === "direct") motionMode = RIGHT_BROW_MOTION_MODE.DIRECT
  if (args.beginFinalSettle) motionMode = RIGHT_BROW_MOTION_MODE.FINAL_SETTLE
  g.mode = motionMode

  const qFTarget = Number(args.qFTarget)
  const qDTarget = Number(args.qDTarget)

  if (
    motionMode !== RIGHT_BROW_MOTION_MODE.CONTINUOUS_SERVO &&
    motionMode !== RIGHT_BROW_MOTION_MODE.FINAL_SETTLE &&
    motionMode !== RIGHT_BROW_MOTION_MODE.OBSERVE &&
    (args.ikOk === false || !Number.isFinite(qFTarget) || !Number.isFinite(qDTarget))
  ) {
    g.lastIkOk = false
    g.lastRejectReason = args.ikOk === false ? "ik-failed" : "invalid-qd"
    return {
      group: g,
      qF: g.lastSuccessfullySentF,
      qD: g.lastSuccessfullySentD,
      accept: false,
      reason: g.lastRejectReason,
      sharedStep: 0,
      progress: g.sharedProgress,
      seq: g.seq,
      pairSeq: g.pairSeq,
      mode: g.mode,
    }
  }

  if (args.ikOk === false && (motionMode === RIGHT_BROW_MOTION_MODE.CONTINUOUS_SERVO || motionMode === RIGHT_BROW_MOTION_MODE.FINAL_SETTLE)) {
    g.lastIkOk = false
    g.lastRejectReason = "ik-failed"
    const a = authoritativeCurrentA(g)
    return {
      group: g,
      qF: g.lastSuccessfullySentF,
      qD: g.lastSuccessfullySentD,
      accept: false,
      reason: "ik-failed",
      nextA: a,
      desiredA: g.desiredA,
      mode: g.mode,
      space: "A",
    }
  }

  g.lastIkOk = true
  g.lastRejectReason = ""

  if (motionMode === RIGHT_BROW_MOTION_MODE.OBSERVE) {
    g.latestTargetAgeMs =
      g.latestTargetTimeMs != null ? Math.max(0, nowMs - g.latestTargetTimeMs) : null
    return {
      group: g,
      qF: g.lastSuccessfullySentF,
      qD: g.lastSuccessfullySentD,
      accept: true,
      reason: "observe",
      sharedStep: g.sharedStep,
      progress: g.sharedProgress,
      seq: g.seq,
      pairSeq: g.pairSeq,
      mode: g.mode,
      space: g.space,
      nextA: g.nextA,
      desiredA: g.desiredA,
    }
  }

  if (
    motionMode === RIGHT_BROW_MOTION_MODE.CONTINUOUS_SERVO ||
    motionMode === RIGHT_BROW_MOTION_MODE.FINAL_SETTLE
  ) {
    if (Number.isFinite(Number(args.targetX))) g.targetX = Number(args.targetX)
    if (Number.isFinite(Number(args.targetY))) g.targetY = Number(args.targetY)
    return stepASpaceContinuous(
      g,
      args,
      cfg,
      nowMs,
      motionMode === RIGHT_BROW_MOTION_MODE.FINAL_SETTLE || Boolean(args.beginFinalSettle)
    )
  }

  if (motionMode === RIGHT_BROW_MOTION_MODE.DIRECT) {
    const authF = Number.isFinite(g.lastSuccessfullySentF) ? g.lastSuccessfullySentF : 0
    const authD = Number.isFinite(g.lastSuccessfullySentD) ? g.lastSuccessfullySentD : 0
    beginDiscreteTrajectory(g, authF, authD, qFTarget, qDTarget, nowMs, 0, "direct-jump")
    g.velocityF = 0
    g.velocityD = 0
    g.sharedStep = 1
    g.sharedProgress = 1
    g.currentF = qFTarget
    g.currentD = qDTarget
    g.nextF = qFTarget
    g.nextD = qDTarget
    g.lastScheduledF = qFTarget
    g.lastScheduledD = qDTarget
    g.fFinished = true
    g.dFinished = true
    g.groupFinished = true
    g.active = false
    g.finalSettleActive = false
    g.space = "q"
    g.syncWrite = false
    g.lastTickMs = nowMs
    return {
      group: g,
      qF: qFTarget,
      qD: qDTarget,
      accept: true,
      reason: "",
      sharedStep: 1,
      progress: 1,
      seq: g.seq,
      pairSeq: g.pairSeq,
      mode: g.mode,
      space: "q",
    }
  }

  /* DISCRETE q-space */
  const prevTargetF = g.targetF
  const prevTargetD = g.targetD
  g.desiredF = qFTarget
  g.desiredD = qDTarget
  g.targetF = qFTarget
  g.targetD = qDTarget
  const targetMoved =
    !nearly(qFTarget, prevTargetF, cfg.replanThresholdDeg) ||
    !nearly(qDTarget, prevTargetD, cfg.replanThresholdDeg)
  const needReplan = !g.active || targetMoved || g.space === "A"

  if (needReplan) {
    const startF = Number.isFinite(g.lastSuccessfullySentF) ? g.lastSuccessfullySentF : g.currentF || 0
    const startD = Number.isFinite(g.lastSuccessfullySentD) ? g.lastSuccessfullySentD : g.currentD || 0
    const durationMs = computeRightBrowSyncDurationMs(qFTarget - startF, qDTarget - startD, cfg)
    beginDiscreteTrajectory(g, startF, startD, qFTarget, qDTarget, nowMs, durationMs, "discrete-replan")
  }

  if (g.controlSessionStartMs == null) g.controlSessionStartMs = nowMs
  const stepped = stepDiscreteLike(g, nowMs)
  g.lastTickMs = nowMs
  g.pairSeq = g.seq
  g.syncWrite = false
  g.servoInternalTime = g.durationMs
  return {
    group: g,
    qF: stepped.qF,
    qD: stepped.qD,
    accept: true,
    reason: "",
    sharedStep: g.sharedStep,
    progress: stepped.progress,
    seq: g.seq,
    pairSeq: g.pairSeq,
    mode: g.mode,
    space: "q",
  }
}

/**
 * 成功 SyncWrite / 发送后：用 FK(qF,qD) 对齐权威 currentA。
 */
export function markRightBrowFiveBarSyncBatchSent(group, nowMs = performance.now(), pair = null) {
  if (!group) return group
  const t = Number(nowMs)
  if (group.lastSendTimestampMs != null) {
    pushSendSample(group, t - group.lastSendTimestampMs)
  }
  group.batchSendCount = (Number(group.batchSendCount) || 0) + 1
  group.lastBatchSendTimeMs = t
  group.lastSendTimestampMs = t

  const f =
    pair && Number.isFinite(Number(pair.qF))
      ? Number(pair.qF)
      : Number(group.lastScheduledF)
  const d =
    pair && Number.isFinite(Number(pair.qD))
      ? Number(pair.qD)
      : Number(group.lastScheduledD)

  group.lastSuccessfullySentF = f
  group.lastSuccessfullySentD = d
  group.currentF = f
  group.currentD = d

  if (pair?.A && Number.isFinite(Number(pair.A.x)) && Number.isFinite(Number(pair.A.y))) {
    group.lastSuccessfullySentA = { x: Number(pair.A.x), y: Number(pair.A.y) }
  } else if (Number.isFinite(f) && Number.isFinite(d)) {
    const fk = browFiveBarFkWorld(d, f, group.sideId || "right")
    if (fk.ok && fk.Aworld) {
      group.lastSuccessfullySentA = { x: fk.Aworld[0], y: fk.Aworld[1] }
    } else if (group.nextA) {
      group.lastSuccessfullySentA = { x: group.nextA.x, y: group.nextA.y }
    }
  }
  group.commandedA = { ...group.lastSuccessfullySentA }

  if (pair?.sendStartTimeMs != null) group.sendStartTimeMs = pair.sendStartTimeMs
  if (pair?.syncWrite != null) group.syncWrite = Boolean(pair.syncWrite)
  if (pair?.syncWriteDurationMs != null) group.syncWriteDurationMs = pair.syncWriteDurationMs
  if (pair?.servoInternalTime != null) group.servoInternalTime = pair.servoInternalTime
  if (pair?.servoInternalSpeed != null) group.servoInternalSpeed = pair.servoInternalSpeed
  if (pair?.fSendTimeMs != null) group.fSendTimeMs = pair.fSendTimeMs
  if (pair?.dSendTimeMs != null) group.dSendTimeMs = pair.dSendTimeMs
  return group
}

export function getRightBrowFiveBarSyncDiagnostics(group) {
  if (!group) {
    return { enabled: false, message: "无同步 Group" }
  }
  const now =
    typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()
  const age =
    group.latestTargetTimeMs != null
      ? Math.max(0, now - group.latestTargetTimeMs)
      : group.latestTargetAgeMs
  return {
    enabled: true,
    mode: group.mode,
    space: group.space,
    groupSeq: group.seq,
    pairSeq: group.pairSeq,
    latestTargetSeq: group.latestTargetSeq,
    latestTargetAgeMs: age,
    maxServoHz: group.maxServoHz,
    requestedTickHz: group.requestedTickHz,
    actualTickHz: group.actualTickHz,
    actualSendHz: group.actualSendHz,
    tickIntervalP50: group.tickIntervalP50,
    tickIntervalP95: group.tickIntervalP95,
    sendIntervalP50: group.sendIntervalP50,
    sendIntervalP95: group.sendIntervalP95,
    maxSendIntervalMs: group.maxSendIntervalMs,
    tickJitterMs: group.maxTickJitterMs,
    maxTickJitterMs: group.maxTickJitterMs,
    actualDtMs: group.actualDtMs,
    desiredA: group.desiredA,
    nextA: group.nextA,
    commandedA: group.commandedA,
    lastSuccessfullySentA: group.lastSuccessfullySentA,
    aErrorMm: group.aErrorMm,
    velocityA: group.velocityA,
    targetX: group.targetX,
    targetY: group.targetY,
    startF: group.startF,
    startD: group.startD,
    desiredF: group.desiredF,
    desiredD: group.desiredD,
    targetF: group.targetF,
    targetD: group.targetD,
    currentF:
      group.lastSuccessfullySentF != null && Number.isFinite(Number(group.lastSuccessfullySentF))
        ? group.lastSuccessfullySentF
        : group.currentF,
    currentD:
      group.lastSuccessfullySentD != null && Number.isFinite(Number(group.lastSuccessfullySentD))
        ? group.lastSuccessfullySentD
        : group.currentD,
    velocityF: group.velocityF,
    velocityD: group.velocityD,
    nextF: group.nextF,
    nextD: group.nextD,
    qF: group.nextF,
    qD: group.nextD,
    sharedStep: group.sharedStep,
    sharedProgress: group.sharedProgress,
    lastSuccessfullySentF: group.lastSuccessfullySentF,
    lastSuccessfullySentD: group.lastSuccessfullySentD,
    lastScheduledF: group.lastScheduledF,
    lastScheduledD: group.lastScheduledD,
    lastSendTimestampMs: group.lastSendTimestampMs,
    finalSettleActive: group.finalSettleActive,
    plannedDurationMs: group.durationMs,
    plannedStartTime: group.startTimeMs,
    plannedEndTime: group.plannedEndTimeMs,
    batchSendCount: group.batchSendCount,
    lastBatchSendTime: group.lastBatchSendTimeMs,
    fFinished: group.fFinished,
    dFinished: group.dFinished,
    groupFinished: group.groupFinished,
    lastReplanReason: group.lastReplanReason,
    lastIkOk: group.lastIkOk,
    lastRejectReason: group.lastRejectReason,
    active: group.active,
    syncWrite: group.syncWrite,
    syncWriteDurationMs: group.syncWriteDurationMs,
    servoInternalTime: group.servoInternalTime,
    servoInternalSpeed: group.servoInternalSpeed,
    sideId: group.sideId || "right",
    ID1: group.sideId === "left" ? 24 : 1,
    ID2: group.sideId === "left" ? 23 : 2,
    sendStartTimeMs: group.sendStartTimeMs,
    fSendTimeMs: group.fSendTimeMs,
    dSendTimeMs: group.dSendTimeMs,
  }
}

export function isRightBrowTipDragControlId(controlId) {
  const id = String(controlId || "")
  return (
    id === "brow_r_tip" ||
    id === "brow_r_F" ||
    id === "brow_r_D" ||
    id === "brow_r_tip_a" ||
    id === "brow_r_tip_b" ||
    id.startsWith("brow_r_tip")
  )
}

export function isLeftBrowTipDragControlId(controlId) {
  const id = String(controlId || "")
  return (
    id === "brow_l_tip" ||
    id === "brow_l_F" ||
    id === "brow_l_D" ||
    id === "brow_l_tip_a" ||
    id === "brow_l_tip_b" ||
    id.startsWith("brow_l_tip")
  )
}

export function isBrowTipDragControlId(controlId) {
  return isRightBrowTipDragControlId(controlId) || isLeftBrowTipDragControlId(controlId)
}

export function resolveRightBrowControlIntervalMs(config = BROW_FIVEBAR_PAIR_SERVO_CONFIG) {
  const hz = Number(config.maxServoHz || config.continuousServoHz) || BROW_FIVEBAR_PAIR_SERVO_CONFIG.maxServoHz
  return Math.max(4, Math.round(1000 / Math.max(1, hz)))
}

export const stepBrowFiveBarPairServo = stepRightBrowFiveBarSyncGroup
export const markBrowFiveBarPairServoSent = markRightBrowFiveBarSyncBatchSent
export const getBrowFiveBarPairServoDiagnostics = getRightBrowFiveBarSyncDiagnostics
export const resolveBrowFiveBarControlIntervalMs = resolveRightBrowControlIntervalMs
