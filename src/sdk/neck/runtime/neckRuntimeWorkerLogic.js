/**
 * Pure Neck Runtime Worker logic — usable in Dedicated Worker AND Node tests.
 * NO DOM / Web Serial / SLCAN.
 *
 * Architecture: planNeckPose + MotorProtocolAdapter → CanFrame objects emitted as txFrame.
 * SerialPort stays on main thread (cannot transfer to Worker).
 */

import { planNeckPose, createNeckPlannerState } from "../core/planNeckPose.js"
import {
  createLuviaReferenceProfile,
  normalizeNeckRuntimeProfile,
} from "../core/neckRuntimeProfile.js"
import { createMotorCommandFromMotorTargets } from "../protocol/motorCommand.js"
import { getMotorProtocolAdapter } from "../protocol/motorProtocolRegistry.js"
import { normalizeNeckPose } from "../neckPose.js"
import {
  BROWSER_NECK_RUNTIME_STATES,
  canAcceptBrowserNeckAnimationTarget,
  isBrowserNeckCalibratingNeutral,
  isBrowserNeckRuntimeMotionActive,
  normalizeBrowserNeckRuntimeState,
} from "./browserNeckRuntimeStates.js"
import { createRuntimeScheduler, NOMINAL_RUNTIME_PERIOD_MS } from "./runtimeScheduler.js"
import { COMMAND_PRIORITY } from "./commandPriority.js"
import {
  buildEnableSequenceSteps,
  createEnableSequenceRunner,
  resolveUserZeroMotorCommand,
} from "./enableSequence.js"

const DEFAULT_STALE_TIMEOUT_MS = 300
const DEFAULT_PERIOD_MS = NOMINAL_RUNTIME_PERIOD_MS

function defaultNow() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now()
}

/**
 * @param {{
 *   postMessage: (msg: object) => void,
 *   now?: () => number,
 *   delay?: (ms: number) => Promise<void>,
 *   createScheduler?: typeof createRuntimeScheduler,
 *   getAdapter?: typeof getMotorProtocolAdapter,
 *   staleTimeoutMs?: number,
 *   periodMs?: number,
 * }} opts
 */
export function createNeckRuntimeWorkerLogic(opts = {}) {
  const postMessage = opts.postMessage
  if (typeof postMessage !== "function") {
    throw new Error("createNeckRuntimeWorkerLogic requires postMessage")
  }
  const now = typeof opts.now === "function" ? opts.now : defaultNow
  const delay =
    typeof opts.delay === "function"
      ? opts.delay
      : (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)))
  const createScheduler =
    typeof opts.createScheduler === "function" ? opts.createScheduler : createRuntimeScheduler
  const resolveAdapter =
    typeof opts.getAdapter === "function" ? opts.getAdapter : getMotorProtocolAdapter

  let staleTimeoutMs =
    Number(opts.staleTimeoutMs) > 0 ? Number(opts.staleTimeoutMs) : DEFAULT_STALE_TIMEOUT_MS
  let periodMs = Number(opts.periodMs) > 0 ? Number(opts.periodMs) : DEFAULT_PERIOD_MS

  let disposed = false
  let state = BROWSER_NECK_RUNTIME_STATES.DISCONNECTED
  let profile = null
  let adapter = null
  let plannerState = createNeckPlannerState()
  /** @type {{ pose: object, sequence: number|null, timelineTimeMs: number|null, source: string, at: number }|null} */
  let latestTarget = null
  /** Last safe hold pose used for STALE / HOLD periodic */
  let holdPose = { pitch: 0, roll: 0, yaw: 0 }
  let lastMotorRaw = { id1: 0, id2: 0, id3: 0, id4: 0 }
  let lastCanFrame = null
  let lastSafety = { limited: false, reason: "" }
  let lastHeartbeatAt = 0
  let enabled = false
  let estopLatched = false
  let acceptAnimationTargets = true
  let sequenceCounter = 0
  let physicalTxHint = 0
  /** @type {Map<number, object>} */
  const feedbackByMotor = new Map()
  let enableRunner = null
  let scheduler = null
  let loopActive = false

  function emit(msg) {
    if (disposed) return
    try {
      postMessage(msg)
    } catch {
      /* ignore */
    }
  }

  function setState(next, reason = "") {
    const n = normalizeBrowserNeckRuntimeState(next)
    if (n === state && !reason) return
    state = n
    emit({ type: "state", state, reason: reason || null, enabled, estop: estopLatched })
  }

  function emitTx(priority, frame, meta = {}) {
    if (!frame) return
    physicalTxHint += 1
    lastCanFrame = frame
    emit({
      type: "txFrame",
      priority,
      frame,
      meta: { ...meta, at: now() },
    })
  }

  function ensureAdapter() {
    if (!profile) {
      throw new Error("profile required")
    }
    adapter = resolveAdapter(profile)
    return adapter
  }

  function poseForTick() {
    // R4.1: lock semantic target at mechanical neutral while calibrating
    if (isBrowserNeckCalibratingNeutral(state)) {
      return { pitch: 0, roll: 0, yaw: 0 }
    }
    if (
      state === BROWSER_NECK_RUNTIME_STATES.STALE_SAFE_HOLD ||
      state === BROWSER_NECK_RUNTIME_STATES.HOLD ||
      !acceptAnimationTargets
    ) {
      return holdPose
    }
    if (latestTarget?.pose) return latestTarget.pose
    return holdPose
  }

  function encodePeriodicPosition(pose, dtMs) {
    const ad = ensureAdapter()
    const plan = planNeckPose({
      pose,
      profile,
      previousState: plannerState,
      applySafetyLimiter: true,
      dt: dtMs != null ? Number(dtMs) / 1000 : null,
    })
    if (plan.accepted) {
      plannerState = plan.nextState
      holdPose = { ...plan.semanticPose }
      lastMotorRaw = { ...(plan.motorTargets?.raw || lastMotorRaw) }
      lastSafety = {
        limited: Boolean(plan.diagnostics?.safetyLimited),
        reason: plan.diagnostics?.safetyLimitReason || "",
      }
      const cmd = createMotorCommandFromMotorTargets(plan.motorTargets)
      const frame = ad.encodePositionCommand(cmd)
      return { frame, plan, cmd }
    }
    // Rejected plan — hold previous safe
    lastSafety = { limited: true, reason: plan.rejectReason || "PLAN_REJECTED" }
    const cmd = createMotorCommandFromMotorTargets({ raw: lastMotorRaw })
    const frame = ad.encodePositionCommand(cmd)
    return { frame, plan, cmd }
  }

  function onSchedulerTick(info) {
    if (disposed || !loopActive) return
    // Heartbeat stale check — never force STALE while calibrating (exit/resume would break).
    if (lastHeartbeatAt > 0 && now() - lastHeartbeatAt > staleTimeoutMs) {
      if (
        state !== BROWSER_NECK_RUNTIME_STATES.STALE_SAFE_HOLD &&
        !isBrowserNeckCalibratingNeutral(state) &&
        enabled &&
        !estopLatched
      ) {
        acceptAnimationTargets = false
        setState(BROWSER_NECK_RUNTIME_STATES.STALE_SAFE_HOLD, "HEARTBEAT_TIMEOUT")
      }
    }

    if (!isBrowserNeckRuntimeMotionActive(state) || estopLatched) {
      return
    }
    if (
      state !== BROWSER_NECK_RUNTIME_STATES.RUNNING &&
      state !== BROWSER_NECK_RUNTIME_STATES.HOLD &&
      state !== BROWSER_NECK_RUNTIME_STATES.STALE_SAFE_HOLD &&
      state !== BROWSER_NECK_RUNTIME_STATES.ENABLED &&
      state !== BROWSER_NECK_RUNTIME_STATES.CALIBRATING_NEUTRAL
    ) {
      return
    }

    try {
      const pose = poseForTick()
      const { frame } = encodePeriodicPosition(pose, info.dtMs)
      emitTx(COMMAND_PRIORITY.PERIODIC_POSITION, frame, {
        kind: "periodic",
        state,
      })
      // Promote ENABLED → RUNNING once animation targets flow
      if (
        state === BROWSER_NECK_RUNTIME_STATES.ENABLED &&
        acceptAnimationTargets &&
        latestTarget &&
        canAcceptBrowserNeckAnimationTarget(BROWSER_NECK_RUNTIME_STATES.RUNNING)
      ) {
        // stay ENABLED until explicit motion; periodic hold at neutral is fine in ENABLED
      }
    } catch (err) {
      emit({
        type: "error",
        code: "TICK_ERROR",
        message: err?.message || String(err),
      })
    }
  }

  function startLoop() {
    if (loopActive) return
    loopActive = true
    scheduler = createScheduler({
      now,
      periodMs,
      onTick: onSchedulerTick,
    })
    scheduler.start(now())
  }

  function stopLoop() {
    loopActive = false
    scheduler?.stop?.()
    scheduler = null
  }

  function snapshot() {
    const stats = scheduler?.getStats?.() || {
      tickCount: 0,
      missedTickCount: 0,
      jitterMean: 0,
      jitterP95: 0,
      jitterMax: 0,
      tickHz: 0,
    }
    const ageMs = latestTarget ? Math.max(0, now() - latestTarget.at) : null
    return {
      type: "snapshot",
      state,
      enabled,
      estop: estopLatched,
      stale: state === BROWSER_NECK_RUNTIME_STATES.STALE_SAFE_HOLD,
      transportReady: state !== BROWSER_NECK_RUNTIME_STATES.DISCONNECTED,
      profile: profile
        ? {
            loaded: true,
            name: profile.name,
            version: profile.version,
            motorProtocol: profile.motorProtocol,
            transport: profile.transport,
          }
        : { loaded: false },
      worker: {
        running: loopActive,
        tickHz: stats.tickHz,
        tickCount: stats.tickCount,
        missedTickCount: stats.missedTickCount,
        jitterMean: stats.jitterMean,
        jitterP95: stats.jitterP95,
        jitterMax: stats.jitterMax,
      },
      target: {
        latestPose: latestTarget?.pose || holdPose,
        latestSequence: latestTarget?.sequence ?? null,
        ageMs,
        source: latestTarget?.source || null,
      },
      safety: { ...lastSafety },
      command: {
        motorRaw: { ...lastMotorRaw },
        canFrameHex: lastCanFrame?.data
          ? Array.from(lastCanFrame.data instanceof Uint8Array ? lastCanFrame.data : [])
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("")
              .toUpperCase()
          : null,
        arbitrationId: lastCanFrame?.arbitrationId ?? null,
        physicalTxCount: physicalTxHint,
      },
      feedback: {
        motors: Object.fromEntries(feedbackByMotor.entries()),
        available: feedbackByMotor.size > 0,
      },
      heartbeatAgeMs: lastHeartbeatAt ? now() - lastHeartbeatAt : null,
      staleTimeoutMs,
      acceptAnimationTargets,
      calibratingNeutral: isBrowserNeckCalibratingNeutral(state),
    }
  }

  async function runEnable() {
    if (estopLatched) {
      emit({ type: "error", code: "ESTOP_LATCHED", message: "cannot enable while ESTOP" })
      return { ok: false }
    }
    if (!profile) {
      emit({ type: "error", code: "PROFILE_REQUIRED", message: "valid profile required" })
      return { ok: false }
    }
    setState(BROWSER_NECK_RUNTIME_STATES.ENABLING, "ENABLE_START")
    try {
      const ad = ensureAdapter()
      const steps = buildEnableSequenceSteps({ adapter: ad, profile, motorIds: [1, 2, 3] })
      enableRunner = createEnableSequenceRunner({
        sendFrame: async (frame, meta) => {
          emitTx(meta?.priority || COMMAND_PRIORITY.ENABLE_STEP, frame, meta)
        },
        delay,
      })
      const result = await enableRunner.run(steps, {
        onProgress: (p) => emit({ type: "enableProgress", ...p }),
      })
      enableRunner = null
      if (!result.ok) {
        enabled = false
        setState(BROWSER_NECK_RUNTIME_STATES.DISABLED, result.aborted ? "ENABLE_ABORTED" : "ENABLE_FAILED")
        emit({ type: "error", code: "ENABLE_FAILED", message: result.error?.message || "enable failed" })
        return result
      }
      // Seed hold at user-zero
      const zeroCmd = resolveUserZeroMotorCommand(profile)
      lastMotorRaw = Object.fromEntries(
        zeroCmd.motors.map((m) => [`id${m.logicalMotorId}`, m.positionRaw])
      )
      holdPose = { pitch: 0, roll: 0, yaw: 0 }
      plannerState = createNeckPlannerState()
      enabled = true
      acceptAnimationTargets = true
      setState(BROWSER_NECK_RUNTIME_STATES.ENABLED, "ENABLE_OK")
      startLoop()
      return { ok: true }
    } catch (err) {
      enabled = false
      setState(BROWSER_NECK_RUNTIME_STATES.DISABLED, "ENABLE_ERROR")
      emit({ type: "error", code: "ENABLE_ERROR", message: err?.message || String(err) })
      return { ok: false, error: err }
    }
  }

  async function runDisable() {
    enableRunner?.abort?.()
    try {
      const ad = ensureAdapter()
      // Hold then DISABLE
      if (enabled) {
        const { frame } = encodePeriodicPosition(holdPose, periodMs)
        emitTx(COMMAND_PRIORITY.DISABLE_CONTROL, frame, { kind: "disable_hold" })
      }
      const dis = ad.encodeDisableCommand([1, 2, 3])
      emitTx(COMMAND_PRIORITY.DISABLE_CONTROL, dis, { kind: "disable" })
    } catch (err) {
      emit({ type: "error", code: "DISABLE_ERROR", message: err?.message || String(err) })
    }
    enabled = false
    acceptAnimationTargets = false
    stopLoop()
    if (!estopLatched) {
      setState(BROWSER_NECK_RUNTIME_STATES.DISABLED, "DISABLE")
    }
  }

  async function runEstop() {
    enableRunner?.abort?.()
    estopLatched = true
    acceptAnimationTargets = false
    try {
      const ad = profile ? ensureAdapter() : null
      if (ad) {
        try {
          const { frame } = encodePeriodicPosition(holdPose, periodMs)
          emitTx(COMMAND_PRIORITY.ESTOP, frame, { kind: "estop_hold" })
        } catch {
          /* best effort */
        }
        const dis = ad.encodeDisableCommand([1, 2, 3])
        emitTx(COMMAND_PRIORITY.ESTOP, dis, { kind: "estop_disable" })
      }
    } catch (err) {
      emit({ type: "error", code: "ESTOP_ERROR", message: err?.message || String(err) })
    }
    enabled = false
    stopLoop()
    setState(BROWSER_NECK_RUNTIME_STATES.ESTOP, "ESTOP")
  }

/**
 * Pure Clear ESTOP — does NOT auto-enable or resume motion.
 * Host must gate transport READY + no active calibration before posting clearEstop.
 */
  function runClearEstop() {
    if (!estopLatched && state !== BROWSER_NECK_RUNTIME_STATES.ESTOP) {
      emit({ type: "error", code: "NOT_ESTOP", message: "estop not latched" })
      return { ok: false, code: "NOT_ESTOP" }
    }
    if (isBrowserNeckCalibratingNeutral(state)) {
      emit({
        type: "error",
        code: "CALIBRATION_ACTIVE",
        message: "clear ESTOP blocked while calibrating",
      })
      return { ok: false, code: "CALIBRATION_ACTIVE" }
    }
    estopLatched = false
    enabled = false
    acceptAnimationTargets = false
    stopLoop()
    setState(BROWSER_NECK_RUNTIME_STATES.DISABLED, "CLEAR_ESTOP")
    emit(snapshot())
    return { ok: true }
  }

  /**
   * Handle host → worker message.
   * @param {object} msg
   */
  async function handleMessage(msg) {
    if (disposed || !msg || typeof msg !== "object") return
    const type = msg.type

    switch (type) {
      case "init": {
        try {
          profile = normalizeNeckRuntimeProfile(msg.profile || createLuviaReferenceProfile())
          adapter = resolveAdapter(profile)
          if (Number(msg.staleTimeoutMs) > 0) staleTimeoutMs = Number(msg.staleTimeoutMs)
          if (Number(msg.periodMs) > 0) periodMs = Number(msg.periodMs)
          lastHeartbeatAt = now()
          setState(BROWSER_NECK_RUNTIME_STATES.TRANSPORT_READY, "INIT")
          setState(BROWSER_NECK_RUNTIME_STATES.DISABLED, "INIT")
          emit({ type: "ready", profile: { name: profile.name, version: profile.version } })
        } catch (err) {
          profile = null
          adapter = null
          setState(BROWSER_NECK_RUNTIME_STATES.ERROR, "INIT_FAILED")
          emit({ type: "error", code: "INIT_FAILED", message: err?.message || String(err) })
        }
        break
      }
      case "setTarget": {
        if (estopLatched) break
        // R4.1: Timeline/editor targets rejected while software neutral calibration
        if (isBrowserNeckCalibratingNeutral(state)) break
        if (!acceptAnimationTargets || !canAcceptBrowserNeckAnimationTarget(state)) {
          // Still overwrite latest for resume, but do not promote RUNNING
          if (msg.pose && state === BROWSER_NECK_RUNTIME_STATES.STALE_SAFE_HOLD) {
            // ignore animation while stale
            break
          }
          if (!acceptAnimationTargets) break
        }
        const pose = normalizeNeckPose(msg.pose || { pitch: 0, roll: 0, yaw: 0 }, { clamp: false })
        sequenceCounter += 1
        latestTarget = {
          pose,
          sequence: msg.sequence ?? sequenceCounter,
          timelineTimeMs: msg.timelineTimeMs ?? null,
          source: msg.source || "unknown",
          at: now(),
        }
        if (enabled && acceptAnimationTargets && !estopLatched) {
          if (
            state === BROWSER_NECK_RUNTIME_STATES.ENABLED ||
            state === BROWSER_NECK_RUNTIME_STATES.HOLD
          ) {
            setState(BROWSER_NECK_RUNTIME_STATES.RUNNING, "TARGET")
          }
        }
        break
      }
      case "heartbeat": {
        lastHeartbeatAt = now()
        break
      }
      case "enable": {
        if (isBrowserNeckCalibratingNeutral(state)) {
          emit({
            type: "error",
            code: "CALIBRATION_ACTIVE",
            message: "cannot enable while CALIBRATING_NEUTRAL",
          })
          break
        }
        if (enabled && !estopLatched) {
          emit({
            type: "error",
            code: "ALREADY_ENABLED",
            message: "motors already enabled",
          })
          break
        }
        await runEnable()
        break
      }
      case "disable": {
        await runDisable()
        break
      }
      case "estop": {
        await runEstop()
        break
      }
      case "clearEstop": {
        runClearEstop()
        break
      }
      case "resume": {
        if (isBrowserNeckCalibratingNeutral(state)) {
          emit({
            type: "error",
            code: "CALIBRATION_ACTIVE",
            message: "resume blocked while CALIBRATING_NEUTRAL",
          })
          break
        }
        if (estopLatched) {
          emit({
            type: "error",
            code: "ESTOP_LATCHED",
            message: "clear ESTOP via clearEstop first",
          })
          break
        }
        lastHeartbeatAt = now()
        acceptAnimationTargets = true
        if (enabled) {
          setState(BROWSER_NECK_RUNTIME_STATES.HOLD, "RESUME")
          startLoop()
        }
        break
      }
      case "hold": {
        if (isBrowserNeckCalibratingNeutral(state)) {
          emit({
            type: "error",
            code: "CALIBRATION_ACTIVE",
            message: "hold blocked while CALIBRATING_NEUTRAL",
          })
          break
        }
        if (enabled && !estopLatched) {
          acceptAnimationTargets = true
          setState(BROWSER_NECK_RUNTIME_STATES.HOLD, "HOLD")
          startLoop()
        }
        break
      }
      case "start": {
        if (isBrowserNeckCalibratingNeutral(state)) {
          emit({
            type: "error",
            code: "CALIBRATION_ACTIVE",
            message: "start blocked while CALIBRATING_NEUTRAL",
          })
          break
        }
        if (enabled && !estopLatched) {
          startLoop()
          if (state === BROWSER_NECK_RUNTIME_STATES.ENABLED) {
            setState(BROWSER_NECK_RUNTIME_STATES.HOLD, "START")
          }
        }
        break
      }
      case "stop": {
        if (isBrowserNeckCalibratingNeutral(state)) {
          emit({
            type: "error",
            code: "CALIBRATION_ACTIVE",
            message: "stop blocked while CALIBRATING_NEUTRAL",
          })
          break
        }
        // Hold pose, keep enabled, no auto disable
        if (enabled && !estopLatched) {
          setState(BROWSER_NECK_RUNTIME_STATES.HOLD, "STOP")
        }
        break
      }
      case "loadProfile": {
        try {
          profile = normalizeNeckRuntimeProfile(msg.profile)
          adapter = resolveAdapter(profile)
          emit({ type: "ready", profile: { name: profile.name, version: profile.version } })
        } catch (err) {
          emit({ type: "error", code: "PROFILE_INVALID", message: err?.message || String(err) })
        }
        break
      }
      case "enterNeutralCalibration": {
        if (estopLatched || !enabled) {
          emit({
            type: "error",
            code: "CALIBRATION_GATE",
            message: "enterNeutralCalibration requires enabled && !estop",
          })
          break
        }
        if (
          state !== BROWSER_NECK_RUNTIME_STATES.ENABLED &&
          state !== BROWSER_NECK_RUNTIME_STATES.RUNNING &&
          state !== BROWSER_NECK_RUNTIME_STATES.HOLD
        ) {
          emit({
            type: "error",
            code: "CALIBRATION_GATE",
            message: `cannot enter calibration from ${state}`,
          })
          break
        }
        if (msg.profile) {
          try {
            profile = normalizeNeckRuntimeProfile(msg.profile)
            adapter = resolveAdapter(profile)
          } catch (err) {
            emit({
              type: "error",
              code: "PROFILE_INVALID",
              message: err?.message || String(err),
            })
            break
          }
        }
        acceptAnimationTargets = false
        holdPose = { pitch: 0, roll: 0, yaw: 0 }
        latestTarget = {
          pose: { pitch: 0, roll: 0, yaw: 0 },
          sequence: null,
          timelineTimeMs: null,
          source: "neutral-calibration",
          at: now(),
        }
        setState(BROWSER_NECK_RUNTIME_STATES.CALIBRATING_NEUTRAL, "ENTER_NEUTRAL_CALIBRATION")
        startLoop()
        emit(snapshot())
        break
      }
      case "updateWorkingProfile": {
        // Atomic replace profile snapshot for next tick (offsets-only expected from host)
        try {
          profile = normalizeNeckRuntimeProfile(msg.profile)
          adapter = resolveAdapter(profile)
          if (isBrowserNeckCalibratingNeutral(state)) {
            // Keep locked at 0/0/0; safety limiter still applies on next tick
            holdPose = { pitch: 0, roll: 0, yaw: 0 }
          }
          emit({
            type: "workingProfileUpdated",
            mapping: {
              side1OffsetDeg: profile.mapping?.side1?.offsetDeg,
              side2OffsetDeg: profile.mapping?.side2?.offsetDeg,
            },
          })
        } catch (err) {
          emit({
            type: "error",
            code: "WORKING_PROFILE_INVALID",
            message: err?.message || String(err),
          })
        }
        break
      }
      case "exitNeutralCalibration": {
        // Allow exit even if heartbeat already promoted to STALE while host still calibrating.
        const fromCal = isBrowserNeckCalibratingNeutral(state)
        const fromStale =
          state === BROWSER_NECK_RUNTIME_STATES.STALE_SAFE_HOLD && enabled && !estopLatched
        if (!fromCal && !fromStale && !msg.force) break
        if (msg.profile) {
          try {
            profile = normalizeNeckRuntimeProfile(msg.profile)
            adapter = resolveAdapter(profile)
          } catch (err) {
            emit({
              type: "error",
              code: "PROFILE_INVALID",
              message: err?.message || String(err),
            })
          }
        }
        lastHeartbeatAt = now()
        acceptAnimationTargets = true
        const exitTo =
          msg.exitTo === BROWSER_NECK_RUNTIME_STATES.ENABLED
            ? BROWSER_NECK_RUNTIME_STATES.ENABLED
            : BROWSER_NECK_RUNTIME_STATES.HOLD
        setState(exitTo, fromCal ? "EXIT_NEUTRAL_CALIBRATION" : "EXIT_CALIBRATION_FROM_STALE")
        startLoop()
        emit(snapshot())
        break
      }
      case "feedback": {
        // Optional RX decode result from host
        const fb = msg.feedback
        if (fb && fb.motorId != null) {
          feedbackByMotor.set(Number(fb.motorId), fb)
        }
        break
      }
      case "transportReady": {
        if (!estopLatched && state === BROWSER_NECK_RUNTIME_STATES.DISCONNECTED) {
          setState(BROWSER_NECK_RUNTIME_STATES.TRANSPORT_READY, "TRANSPORT")
          setState(BROWSER_NECK_RUNTIME_STATES.DISABLED, "TRANSPORT")
        }
        break
      }
      case "transportLost": {
        enabled = false
        stopLoop()
        setState(BROWSER_NECK_RUNTIME_STATES.ERROR, "TRANSPORT_LOST")
        break
      }
      case "getSnapshot": {
        emit(snapshot())
        break
      }
      case "dispose": {
        enableRunner?.abort?.()
        stopLoop()
        setState(BROWSER_NECK_RUNTIME_STATES.DISCONNECTED, "DISPOSE")
        disposed = true
        break
      }
      default:
        break
    }
  }

  return {
    handleMessage,
    getState: () => state,
    getSnapshot: snapshot,
    /** Test helpers */
    _test: {
      getLatestTarget: () => latestTarget,
      setHeartbeatAge: (ageMs) => {
        lastHeartbeatAt = now() - ageMs
      },
      tickOnce: () => onSchedulerTick({ dtMs: periodMs, expectedAt: now(), actualAt: now(), missed: false }),
      getScheduler: () => scheduler,
    },
  }
}
