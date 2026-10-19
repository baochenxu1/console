/**
 * RJ Host Motion Adapter（Phase 1 core；Phase 2 整脸复用）
 *
 * RJ CMD08 是「一次角度运动任务」，不是微雪式实时目标跟随。
 * 本模块在 Host 侧做：最新目标覆盖 + 按全局速度估 timeMs + 无反馈状态估计。
 *
 * 调用方：
 * - Phase 1：舵机控制页滑条（BusServoSections）
 * - Phase 2：Face Rig / Tracking 经 sendBusServoCommands* → sendRjMultiPacketBatchTx
 *
 * 禁止为 Face / Tracking 再复制第二套 Motion Adapter。
 */

/**
 * @typedef {{
 *   velocityRatio: number,
 *   defaultVelocityDegS: number,
 *   minTimeMs: number,
 *   minSendIntervalMs: number,
 *   forceTimeMs?: number | null,
 * }} RjMotionConfig
 */

/**
 * 全局速度参数（不按单舵机配置）。
 * 规格约 100~140ms / 60° → 参考 ~400°/s，默认按 velocityRatio 能力运行。
 * 可在控制台 `patchRjMotionConfig({ velocityRatio: 0.7 })` 做参数验证。
 * forceTimeMs：有限时跳过速度估时（Face Rig 实时跟手用 0 = 尽快）。
 */
export const RJ_MOTION_CONFIG = {
  velocityRatio: 0.9,
  defaultVelocityDegS: 400,
  minTimeMs: 20,
  minSendIntervalMs: 20,
  forceTimeMs: null,
}

/**
 * @param {Partial<RjMotionConfig>} partial
 * @returns {RjMotionConfig}
 */
export function patchRjMotionConfig(partial = {}) {
  if (partial.velocityRatio != null && Number.isFinite(Number(partial.velocityRatio))) {
    RJ_MOTION_CONFIG.velocityRatio = Math.max(0.05, Math.min(1.5, Number(partial.velocityRatio)))
  }
  if (partial.defaultVelocityDegS != null && Number.isFinite(Number(partial.defaultVelocityDegS))) {
    RJ_MOTION_CONFIG.defaultVelocityDegS = Math.max(1, Number(partial.defaultVelocityDegS))
  }
  if (partial.minTimeMs != null && Number.isFinite(Number(partial.minTimeMs))) {
    RJ_MOTION_CONFIG.minTimeMs = Math.max(0, Math.round(Number(partial.minTimeMs)))
  }
  if (partial.minSendIntervalMs != null && Number.isFinite(Number(partial.minSendIntervalMs))) {
    RJ_MOTION_CONFIG.minSendIntervalMs = Math.max(0, Math.round(Number(partial.minSendIntervalMs)))
  }
  if (partial.forceTimeMs === null) {
    RJ_MOTION_CONFIG.forceTimeMs = null
  } else if (partial.forceTimeMs != null && Number.isFinite(Number(partial.forceTimeMs))) {
    RJ_MOTION_CONFIG.forceTimeMs = Math.max(0, Math.round(Number(partial.forceTimeMs)))
  }
  return { ...RJ_MOTION_CONFIG }
}

export function getRjMotionConfig() {
  return { ...RJ_MOTION_CONFIG }
}

/** ticks(0.1°) → 度 */
export function rjTicksToDegrees(ticks) {
  return Number(ticks) / 10
}

/** 度 → ticks(0.1°) */
export function rjDegreesToTicks(degrees) {
  return Math.round(Number(degrees) * 10)
}

/**
 * @typedef {{
 *   currentEstimateDeg: number | null,
 *   latestTargetDeg: number | null,
 *   lastSendTime: number,
 *   motion: null | { startAngle: number, targetAngle: number, startTime: number, duration: number },
 * }} RjHostMotionState
 */

/** @type {Map<number, RjHostMotionState>} */
const servoMotionStates = new Map()

function createEmptyState() {
  return {
    currentEstimateDeg: null,
    latestTargetDeg: null,
    lastSendTime: 0,
    motion: null,
  }
}

/**
 * @param {number} servoId
 * @returns {RjHostMotionState}
 */
export function getRjHostMotionState(servoId) {
  const id = Number(servoId)
  if (!servoMotionStates.has(id)) {
    servoMotionStates.set(id, createEmptyState())
  }
  return servoMotionStates.get(id)
}

/** @param {number} [servoId] 省略则清空全部 */
export function resetRjHostMotionState(servoId) {
  if (servoId == null) {
    servoMotionStates.clear()
    return
  }
  servoMotionStates.delete(Number(servoId))
}

/**
 * 无反馈：按上一段已发送运动插值估计当前角（度）。
 * 不使用 latestTarget（那是期望终点，不是当前位置）。
 * @param {RjHostMotionState} state
 * @param {number} [nowMs]
 */
export function estimateCurrentAngleDeg(state, nowMs = performance.now()) {
  const motion = state?.motion
  if (motion && Number(motion.duration) > 0) {
    const u = (nowMs - motion.startTime) / motion.duration
    if (u >= 1) return motion.targetAngle
    if (u <= 0) return motion.startAngle
    return motion.startAngle + (motion.targetAngle - motion.startAngle) * u
  }
  if (state?.currentEstimateDeg != null && Number.isFinite(state.currentEstimateDeg)) {
    return state.currentEstimateDeg
  }
  /* Phase1 无反馈：未知时按 0°（协议中位 ticks=0） */
  return 0
}

function resolveEffectiveVelocityDegS(config = RJ_MOTION_CONFIG) {
  const base = Number(config.defaultVelocityDegS) || 400
  const ratio = Number(config.velocityRatio)
  const r = Number.isFinite(ratio) ? ratio : 0.9
  return Math.max(1, base * r)
}

/**
 * 计算 CMD08 timeMs（不做发送、不提交状态）。
 * @param {number} currentDeg
 * @param {number} targetDeg
 * @param {RjMotionConfig} [config]
 */
export function computeRjHostMotionTimeMs(currentDeg, targetDeg, config = RJ_MOTION_CONFIG) {
  const deltaDeg = Math.abs(Number(targetDeg) - Number(currentDeg))
  const velocityDegS = resolveEffectiveVelocityDegS(config)
  if (config.forceTimeMs != null && Number.isFinite(Number(config.forceTimeMs))) {
    return {
      timeMs: Math.max(0, Math.round(Number(config.forceTimeMs))),
      deltaDeg,
      velocityDegS,
      forced: true,
    }
  }
  const minTimeMs = Math.max(0, Math.round(Number(config.minTimeMs) || 0))
  if (!(deltaDeg > 0)) {
    return { timeMs: minTimeMs, deltaDeg: 0, velocityDegS }
  }
  const raw = (deltaDeg / velocityDegS) * 1000
  const timeMs = Math.max(minTimeMs, Math.ceil(raw))
  return { timeMs, deltaDeg, velocityDegS }
}

/**
 * 规划一次 RJ Host 运动（最新目标覆盖；无 FIFO）。
 *
 * @param {{
 *   servoId: number,
 *   targetPosition: number,
 *   protocol?: string,
 *   power?: number,
 *   nowMs?: number,
 *   config?: RjMotionConfig,
 * }} input
 *   targetPosition：协议角度 ticks（0.1°）
 */
export function planRjHostMotion(input = {}) {
  const protocol = String(input.protocol || "RJ").toUpperCase()
  const isRj = protocol === "RJ" || protocol === "RJ_SBUS"
  if (!isRj) {
    return {
      ok: false,
      skipped: true,
      error: `planRjHostMotion 仅支持 RJ，收到 ${protocol}`,
    }
  }

  const servoId = Number(input.servoId)
  if (!Number.isFinite(servoId)) {
    return { ok: false, error: "非法 servoId" }
  }

  const config = input.config ? { ...RJ_MOTION_CONFIG, ...input.config } : RJ_MOTION_CONFIG
  const nowMs = Number.isFinite(Number(input.nowMs)) ? Number(input.nowMs) : performance.now()
  const targetTicks = Math.round(Number(input.targetPosition))
  if (!Number.isFinite(targetTicks)) {
    return { ok: false, error: `非法 targetPosition：${input.targetPosition}` }
  }

  const state = getRjHostMotionState(servoId)
  const targetDeg = rjTicksToDegrees(targetTicks)
  const sendIntervalMs = state.lastSendTime > 0 ? nowMs - state.lastSendTime : null
  const minInterval = Math.max(0, Math.round(Number(config.minSendIntervalMs) || 0))

  /* 先估当前位置，再覆盖最新目标（禁止用 latestTarget 冒充 current） */
  const currentEstimateDeg = estimateCurrentAngleDeg(state, nowMs)
  state.latestTargetDeg = targetDeg

  if (state.lastSendTime > 0 && sendIntervalMs != null && sendIntervalMs < minInterval) {
    return {
      ok: true,
      deferred: true,
      servoId,
      retryAfterMs: Math.max(1, Math.ceil(minInterval - sendIntervalMs)),
      position: targetTicks,
      timeMs: null,
      power: input.power,
      diag: {
        servoId,
        currentEstimate: currentEstimateDeg,
        target: targetDeg,
        delta: null,
        generatedTimeMs: null,
        sendIntervalMs,
        deferred: true,
      },
    }
  }

  const { timeMs, deltaDeg, velocityDegS } = computeRjHostMotionTimeMs(
    currentEstimateDeg,
    targetDeg,
    config
  )

  const power =
    input.power != null && Number.isFinite(Number(input.power))
      ? Math.max(0, Math.round(Number(input.power)))
      : undefined

  /* timeMs=0 不建插值；forceTimeMs 跟手仍带短 duration 供报文，commit 会 snap */
  const motion =
    timeMs > 0
      ? {
          startAngle: currentEstimateDeg,
          targetAngle: targetDeg,
          startTime: nowMs,
          duration: timeMs,
        }
      : null

  return {
    ok: true,
    deferred: false,
    servoId,
    position: targetTicks,
    timeMs,
    power,
    currentEstimateDeg,
    targetDeg,
    deltaDeg,
    velocityDegS,
    nowMs,
    motion,
    diag: {
      servoId,
      currentEstimate: currentEstimateDeg,
      target: targetDeg,
      delta: deltaDeg,
      generatedTimeMs: timeMs,
      sendIntervalMs,
      forcedTime: config.forceTimeMs != null && Number.isFinite(Number(config.forceTimeMs)),
    },
  }
}

/**
 * 发送成功后提交状态（开始按 timeMs 估计运动）。
 * @param {number} servoId
 * @param {ReturnType<typeof planRjHostMotion>} plan
 */
export function commitRjHostMotionSend(servoId, plan) {
  if (!plan?.ok || plan.deferred) return
  const state = getRjHostMotionState(servoId)
  state.latestTargetDeg = plan.targetDeg
  state.lastSendTime = plan.nowMs
  /* 跟手强制短时：估计直接落到目标，避免下一帧仍按长轨迹插值拖尾 */
  if (plan.diag?.forcedTime || !plan.motion || !(Number(plan.motion.duration) > 0)) {
    state.currentEstimateDeg = plan.targetDeg
    state.motion = null
    return
  }
  state.currentEstimateDeg = plan.currentEstimateDeg
  state.motion = plan.motion
}

/**
 * 格式化诊断一行（通信日志 / console）。
 * @param {object} diag
 */
export function formatRjHostMotionDiag(diag) {
  if (!diag) return "[RJ Motion] (no diag)"
  if (diag.deferred) {
    return (
      `[RJ Motion] id=${diag.servoId} DEFER ` +
      `est=${Number(diag.currentEstimate).toFixed(1)}° ` +
      `tgt=${Number(diag.target).toFixed(1)}° ` +
      `interval=${diag.sendIntervalMs != null ? Number(diag.sendIntervalMs).toFixed(1) : "—"}ms`
    )
  }
  return (
    `[RJ Motion] id=${diag.servoId} ` +
    `est=${Number(diag.currentEstimate).toFixed(1)}° ` +
    `tgt=${Number(diag.target).toFixed(1)}° ` +
    `Δ=${Number(diag.delta).toFixed(1)}° ` +
    `time=${diag.generatedTimeMs}ms ` +
    `interval=${diag.sendIntervalMs != null ? Number(diag.sendIntervalMs).toFixed(1) : "首包"}ms`
  )
}
