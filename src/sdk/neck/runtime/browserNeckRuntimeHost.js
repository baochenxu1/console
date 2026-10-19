/**
 * Main-thread Browser Neck Runtime Host (R4).
 *
 * Dedicated Worker: 100Hz planNeckPose + MotorProtocol → CanFrame
 *   ↓ postMessage txFrame
 * Main Thread: commandPriority → WebSerialSlcanTransport.sendFrame
 *
 * SerialPort cannot be transferred to Worker (DOMException) — ownership stays here.
 */

import { normalizeNeckRuntimeProfile, createLuviaReferenceProfile, exportNeckRuntimeProfile } from "../core/neckRuntimeProfile.js"
import { createCommandPriorityQueue, COMMAND_PRIORITY } from "./commandPriority.js"
import { createNeckRuntimeWorkerLogic } from "./neckRuntimeWorkerLogic.js"
import {
  BROWSER_NECK_RUNTIME_STATES,
  isBrowserNeckCalibratingNeutral,
  normalizeBrowserNeckRuntimeState,
} from "./browserNeckRuntimeStates.js"
import { HARDWARE_BACKEND_CONFLICT } from "../transport/neckHardwareBackend.js"
import {
  applyWorkingOffsetsToProfile,
  CALIBRATION_STATUS,
  createCalibrationSession,
  SOFTWARE_INSTALLATION_NEUTRAL_TYPE,
} from "../calibration/softwareNeutralCalibration.js"
import {
  loadActiveNeckProfile,
  saveActiveNeckProfile,
} from "../calibration/neckProfileStore.js"
import { getMotorProtocolAdapter } from "../protocol/motorProtocolRegistry.js"
import { mergeNeckSemanticLimits } from "../neckPose.js"

const HEARTBEAT_MS = 100

/** How the active profile was resolved (R4.2). */
export const NECK_PROFILE_SOURCE = Object.freeze({
  INDEXED_DB: "INDEXED_DB",
  IMPORT: "IMPORT",
  DEFAULT: "DEFAULT",
  FALLBACK_AFTER_ERROR: "FALLBACK_AFTER_ERROR",
  LOAD: "LOAD",
})

/**
 * In-process FakeWorker for Node tests — runs neckRuntimeWorkerLogic without real Worker.
 */
export function createFakeNeckRuntimeWorker(logicOpts = {}) {
  /** @type {((ev: { data: object }) => void)|null} */
  let onmessage = null
  const createScheduler =
    typeof logicOpts.createScheduler === "function"
      ? logicOpts.createScheduler
      : (opts) => {
          // Default: no real timers (avoids keeping Node test process alive)
          let running = false
          return {
            start() {
              running = true
            },
            stop() {
              running = false
            },
            isRunning: () => running,
            getStats: () => ({
              tickCount: 0,
              missedTickCount: 0,
              jitterMean: 0,
              jitterP95: 0,
              jitterMax: 0,
              tickHz: 0,
            }),
            _onTick: opts?.onTick,
          }
        }
  const logic = createNeckRuntimeWorkerLogic({
    delay: async () => {},
    ...logicOpts,
    createScheduler,
    postMessage: (msg) => {
      queueMicrotask(() => {
        onmessage?.({ data: msg })
      })
    },
  })
  return {
    postMessage(msg) {
      void logic.handleMessage(msg)
    },
    terminate() {
      void logic.handleMessage({ type: "dispose" })
    },
    set onmessage(fn) {
      onmessage = fn
    },
    get onmessage() {
      return onmessage
    },
    _logic: logic,
  }
}

function defaultCreateWorker() {
  // Dynamic Vite worker import — only resolved in browser bundler.
  // Tests inject createWorker / FakeWorker.
  return import("./neckRuntime.worker.js?worker").then((mod) => {
    const WorkerCtor = mod.default
    return new WorkerCtor()
  })
}

/**
 * @param {{
 *   getTransport: () => { sendFrame: Function, getState?: Function }|null,
 *   createWorker?: () => Worker|Promise<Worker>|ReturnType<typeof createFakeNeckRuntimeWorker>,
 *   heartbeatMs?: number,
 *   now?: () => number,
 *   profileStorage?: object,
 * }} opts
 */
export function createBrowserNeckRuntimeHost(opts = {}) {
  if (typeof opts.getTransport !== "function") {
    throw new Error("createBrowserNeckRuntimeHost requires getTransport")
  }
  const getTransport = opts.getTransport
  const createWorker =
    typeof opts.createWorker === "function" ? opts.createWorker : defaultCreateWorker
  const heartbeatMs = Number(opts.heartbeatMs) > 0 ? Number(opts.heartbeatMs) : HEARTBEAT_MS
  const now =
    typeof opts.now === "function"
      ? opts.now
      : () =>
          typeof performance !== "undefined" && typeof performance.now === "function"
            ? performance.now()
            : Date.now()
  const profileStorage = opts.profileStorage || null

  /** @type {any} */
  let worker = null
  let workerReady = false
  let disposed = false
  let heartbeatTimer = null
  let flushScheduled = false
  let sending = false
  let profile = null
  let profileValid = false
  /** @type {boolean} false until resolveStartupProfile / first successful load settles */
  let profileReady = false
  /** @type {string|null} */
  let profileSource = null
  let hardwarePreview = false
  let lastWorkerSnapshot = null
  let lastError = null
  let physicalTxCount = 0
  let lastWriteOk = null
  let backendConflict = false
  let hostState = BROWSER_NECK_RUNTIME_STATES.DISCONNECTED
  let estopLatched = false
  /** @type {ReturnType<typeof createCalibrationSession>|null} */
  let calibrationSession = null
  let calibrating = false

  const txQueue = createCommandPriorityQueue()
  /** @type {Set<(snap: object) => void>} */
  const listeners = new Set()

  function ensureCalibrationSession() {
    if (!calibrationSession) {
      calibrationSession = createCalibrationSession({
        persistedProfile: profile || createLuviaReferenceProfile(),
      })
    }
    return calibrationSession
  }

  function isCalibratingNow() {
    return calibrating || isBrowserNeckCalibratingNeutral(hostState)
  }

  function restorePersistedProfileToWorker(reason = "RESTORE_PERSISTED") {
    const wasCalibrating = isCalibratingNow()
    const session = ensureCalibrationSession()
    session.cancelRestore()
    const restored = applyWorkingOffsetsToProfile(
      profile || createLuviaReferenceProfile(),
      session.getPersistedOffsets()
    )
    profile = normalizeNeckRuntimeProfile({
      ...restored,
      calibration: profile?.calibration || restored.calibration,
    })
    profileValid = true
    if (worker) {
      if (wasCalibrating) {
        post({
          type: "exitNeutralCalibration",
          profile,
          exitTo: BROWSER_NECK_RUNTIME_STATES.HOLD,
        })
      } else {
        post({ type: "loadProfile", profile })
      }
    }
    session.exitToIdle()
    calibrating = false
    return { profile, reason }
  }

  function invalidateCalibrationSessionAfterEstop() {
    if (!calibrationSession && !calibrating) return
    const session = ensureCalibrationSession()
    // Do not save working trim; leave persisted as-is; close session
    session.exitToIdle()
    calibrating = false
  }

  function pushWorkingProfileToWorker() {
    const session = ensureCalibrationSession()
    const working = applyWorkingOffsetsToProfile(profile || createLuviaReferenceProfile(), {
      ...session.getWorkingOffsets(),
    })
    post({ type: "updateWorkingProfile", profile: working })
    return working
  }

  function notify() {
    const snap = getSnapshot()
    for (const fn of listeners) {
      try {
        fn(snap)
      } catch {
        /* ignore */
      }
    }
  }

  function post(msg) {
    if (!worker) return
    try {
      worker.postMessage(msg)
    } catch (err) {
      lastError = { code: "WORKER_POST_FAILED", message: err?.message || String(err) }
      notify()
    }
  }

  function startHeartbeat() {
    stopHeartbeat()
    heartbeatTimer = setInterval(() => {
      if (disposed) return
      post({ type: "heartbeat", at: now() })
    }, heartbeatMs)
  }

  function stopHeartbeat() {
    if (heartbeatTimer != null) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  async function flushTx() {
    if (sending || disposed) return
    sending = true
    try {
      while (!disposed) {
        const item = txQueue.takeNext()
        if (!item) break
        // Physical path: never call sendFrame unless transport is READY.
        // CLOSED / DISCONNECTED is a legal product state — skip, do not raise lastError.
        if (!transportIsReady()) {
          txQueue.clearAll()
          lastWriteOk = false
          break
        }
        const transport = getTransport()
        if (!transport || typeof transport.sendFrame !== "function") {
          lastWriteOk = false
          lastError = { code: "NO_TRANSPORT", message: "transport unavailable" }
          break
        }
        try {
          await transport.sendFrame(item.frame)
          physicalTxCount += 1
          lastWriteOk = true
        } catch (err) {
          lastWriteOk = false
          lastError = {
            code: err?.code || "SEND_FAILED",
            message: err?.message || String(err),
          }
          // Drop remaining periodic on hard failure; keep ESTOP attempts via re-submit
          if (item.priority === COMMAND_PRIORITY.PERIODIC_POSITION) {
            txQueue.clearPeriodic()
          }
          break
        }
      }
    } finally {
      sending = false
      flushScheduled = false
      // If more arrived while sending, schedule again
      if (txQueue.peekReady() && transportIsReady()) {
        scheduleFlush()
      }
      notify()
    }
  }

  function scheduleFlush() {
    if (flushScheduled || disposed) return
    flushScheduled = true
    queueMicrotask(() => {
      void flushTx()
    })
  }

  function onWorkerMessage(ev) {
    const msg = ev?.data
    if (!msg || typeof msg !== "object") return
    switch (msg.type) {
      case "ready":
        workerReady = true
        hostState = BROWSER_NECK_RUNTIME_STATES.DISABLED
        notify()
        break
      case "state":
        hostState = normalizeBrowserNeckRuntimeState(msg.state)
        calibrating = isBrowserNeckCalibratingNeutral(hostState)
        if (typeof msg.estop === "boolean") estopLatched = msg.estop
        if (hostState === BROWSER_NECK_RUNTIME_STATES.ESTOP) estopLatched = true
        if (hostState === BROWSER_NECK_RUNTIME_STATES.DISABLED && msg.reason === "CLEAR_ESTOP") {
          estopLatched = false
        }
        if (lastWorkerSnapshot) {
          lastWorkerSnapshot = { ...lastWorkerSnapshot, state: hostState, estop: estopLatched }
        }
        notify()
        break
      case "txFrame": {
        // Drop physical frames while transport is not READY (Module ON ≠ Connected).
        if (!transportIsReady()) {
          break
        }
        const priority = msg.priority || COMMAND_PRIORITY.PERIODIC_POSITION
        txQueue.submit({
          priority,
          frame: msg.frame,
          meta: msg.meta,
          replacePeriodic: priority === COMMAND_PRIORITY.PERIODIC_POSITION,
        })
        scheduleFlush()
        break
      }
      case "snapshot":
        lastWorkerSnapshot = msg
        hostState = normalizeBrowserNeckRuntimeState(msg.state)
        calibrating = isBrowserNeckCalibratingNeutral(hostState)
        if (typeof msg.estop === "boolean") estopLatched = Boolean(msg.estop)
        notify()
        break
      case "workingProfileUpdated":
        notify()
        break
      case "enableProgress":
        notify()
        break
      case "error":
        lastError = { code: msg.code || "WORKER_ERROR", message: msg.message || "error" }
        notify()
        break
      default:
        break
    }
  }

  async function startWorker(initProfile) {
    if (worker) return
    const w = await Promise.resolve(createWorker())
    worker = w
    worker.onmessage = onWorkerMessage
    const prof = initProfile || profile || createLuviaReferenceProfile()
    profile = normalizeNeckRuntimeProfile(prof)
    profileValid = true
    if (!profileSource) profileSource = NECK_PROFILE_SOURCE.DEFAULT
    profileReady = true
    post({ type: "init", profile })
    startHeartbeat()
  }

  function stopWorker() {
    stopHeartbeat()
    if (worker) {
      try {
        worker.postMessage({ type: "dispose" })
      } catch {
        /* ignore */
      }
      try {
        worker.terminate?.()
      } catch {
        /* ignore */
      }
      worker = null
    }
    workerReady = false
    txQueue.clearAll()
  }

  function transportIsReady() {
    const t = getTransport()
    const st = t?.getState?.()
    return Boolean(st?.slcanReady || st?.state === "READY")
  }

  /**
   * Enable gates (R4 §20 + R4.2 profileReady / ESTOP latch / calibration).
   */
  function getEnableGates({ conflict = false } = {}) {
    const transportReady = transportIsReady()
    const estop = estopLatched || hostState === BROWSER_NECK_RUNTIME_STATES.ESTOP
    const calActive = isCalibratingNow()
    return {
      transportReady,
      profileValid,
      profileReady,
      workerReady,
      noConflict: !conflict && !backendConflict,
      noEstop: !estop,
      noCalibration: !calActive,
      ok:
        transportReady &&
        profileValid &&
        profileReady &&
        workerReady &&
        !conflict &&
        !backendConflict &&
        !estop &&
        !calActive,
    }
  }

  function getSnapshot() {
    const ws = lastWorkerSnapshot || {}
    const transportReady = transportIsReady()
    const gates = getEnableGates()
    const calSnap = calibrationSession ? calibrationSession.snapshot() : null
    const semanticLimits =
      profileValid && profile?.semantic ? mergeNeckSemanticLimits(profile.semantic) : null
    return {
      backend: "browser-slcan",
      state: hostState,
      transportReady,
      profileReady,
      profileSource,
      enabled: Boolean(
        ws.enabled === true ||
          hostState === BROWSER_NECK_RUNTIME_STATES.ENABLED ||
          hostState === BROWSER_NECK_RUNTIME_STATES.RUNNING ||
          hostState === BROWSER_NECK_RUNTIME_STATES.HOLD ||
          hostState === BROWSER_NECK_RUNTIME_STATES.STALE_SAFE_HOLD ||
          hostState === BROWSER_NECK_RUNTIME_STATES.CALIBRATING_NEUTRAL
      ),
      estop: estopLatched || hostState === BROWSER_NECK_RUNTIME_STATES.ESTOP || Boolean(ws.estop),
      estopLatched,
      stale: hostState === BROWSER_NECK_RUNTIME_STATES.STALE_SAFE_HOLD || Boolean(ws.stale),
      calibratingNeutral: isCalibratingNow(),
      workerReady,
      worker: {
        running: Boolean(ws.worker?.running),
        tickHz: ws.worker?.tickHz ?? 0,
        tickCount: ws.worker?.tickCount ?? 0,
        missedTickCount: ws.worker?.missedTickCount ?? 0,
        jitterMean: ws.worker?.jitterMean ?? 0,
        jitterP95: ws.worker?.jitterP95 ?? 0,
        jitterMax: ws.worker?.jitterMax ?? 0,
      },
      target: ws.target || {
        latestPose: null,
        latestSequence: null,
        ageMs: null,
      },
      safety: ws.safety || { limited: false, reason: "" },
      command: {
        motorRaw: ws.command?.motorRaw || null,
        canFrameHex: ws.command?.canFrameHex || null,
        physicalTxCount,
        lastWriteOk,
        queue: txQueue.getStats(),
      },
      feedback: ws.feedback || { motors: {}, available: false },
      semanticLimits,
      profile: profileValid
        ? {
            loaded: true,
            name: profile?.name,
            version: profile?.version,
            motorProtocol: profile?.motorProtocol,
            transport: profile?.transport,
            calibration: profile?.calibration || null,
            semantic: profile?.semantic || null,
            mapping: profile?.mapping
              ? {
                  side1OffsetDeg: profile.mapping.side1?.offsetDeg,
                  side2OffsetDeg: profile.mapping.side2?.offsetDeg,
                }
              : null,
          }
        : { loaded: false },
      calibration: calSnap
        ? {
            status: calSnap.status,
            dirty: calSnap.dirty,
            persistedOffsets: calSnap.persistedOffsets,
            workingOffsets: calSnap.workingOffsets,
            limitDeg: calSnap.limitDeg,
            lastError: calSnap.lastError,
            active: isCalibratingNow(),
          }
        : {
            status: CALIBRATION_STATUS.IDLE,
            dirty: false,
            persistedOffsets: { side1: 0, side2: 0 },
            workingOffsets: { side1: 0, side2: 0 },
            limitDeg: 30,
            lastError: null,
            active: false,
          },
      gates,
      hardwarePreview,
      lastError,
      actualPoseAvailable: false,
    }
  }

  return {
    async ensureStarted() {
      if (!worker) await startWorker(profile)
    },

    /**
     * Resolve active profile at page mount: IndexedDB → else default 0/0.
     * Blocks Enable until profileReady.
     */
    async resolveStartupProfile() {
      profileReady = false
      profileSource = null
      notify()
      try {
        const loaded = await loadActiveNeckProfile(
          profileStorage ? { storage: profileStorage } : {}
        )
        if (loaded) {
          const result = await this.loadProfile(loaded, {
            source: NECK_PROFILE_SOURCE.INDEXED_DB,
            persist: false,
          })
          profileReady = true
          notify()
          return {
            ok: Boolean(result?.ok),
            source: NECK_PROFILE_SOURCE.INDEXED_DB,
            profile: result?.profile,
          }
        }
      } catch (err) {
        lastError = { code: "IDB_LOAD_FAILED", message: err?.message || String(err) }
        const result = await this.loadProfile(createLuviaReferenceProfile(), {
          source: NECK_PROFILE_SOURCE.FALLBACK_AFTER_ERROR,
          persist: false,
        })
        profileReady = true
        notify()
        return {
          ok: Boolean(result?.ok),
          source: NECK_PROFILE_SOURCE.FALLBACK_AFTER_ERROR,
          error: lastError,
          profile: result?.profile,
        }
      }
      const result = await this.loadProfile(createLuviaReferenceProfile(), {
        source: NECK_PROFILE_SOURCE.DEFAULT,
        persist: false,
      })
      profileReady = true
      notify()
      return {
        ok: Boolean(result?.ok),
        source: NECK_PROFILE_SOURCE.DEFAULT,
        profile: result?.profile,
      }
    },

    async loadProfile(json, opts = {}) {
      const persist = Boolean(opts.persist)
      const source = opts.source || (persist ? NECK_PROFILE_SOURCE.IMPORT : NECK_PROFILE_SOURCE.LOAD)
      try {
        const raw = typeof json === "string" ? JSON.parse(json) : json
        profile = normalizeNeckRuntimeProfile(raw)
        profileValid = true
        profileSource = source
        ensureCalibrationSession().syncPersistedProfile(profile)
        if (!worker) {
          await startWorker(profile)
        } else {
          post({ type: "loadProfile", profile })
        }
        if (persist) {
          try {
            await saveActiveNeckProfile(profile, profileStorage ? { storage: profileStorage } : {})
          } catch (err) {
            lastError = { code: "IDB_SAVE_FAILED", message: err?.message || String(err) }
            notify()
            return { ok: false, error: lastError, profile }
          }
        }
        lastError = null
        // Explicit loads outside startup also mark ready
        if (opts.markReady !== false) profileReady = true
        notify()
        return { ok: true, profile, source: profileSource }
      } catch (err) {
        profileValid = false
        lastError = { code: "PROFILE_INVALID", message: err?.message || String(err) }
        notify()
        return { ok: false, error: lastError }
      }
    },

    getProfile() {
      return profileValid ? profile : null
    },

    /** Export current canonical profile JSON (for UI download). */
    exportProfile() {
      if (!profileValid || !profile) return null
      return exportNeckRuntimeProfile(profile)
    },

    async loadPersistedActiveProfile() {
      try {
        const loaded = await loadActiveNeckProfile(
          profileStorage ? { storage: profileStorage } : {}
        )
        if (!loaded) return { ok: false, error: { code: "NO_STORED_PROFILE" } }
        return this.loadProfile(loaded, { source: NECK_PROFILE_SOURCE.INDEXED_DB, persist: false })
      } catch (err) {
        lastError = { code: "IDB_LOAD_FAILED", message: err?.message || String(err) }
        notify()
        return { ok: false, error: lastError }
      }
    },

    setHardwarePreview(on) {
      hardwarePreview = Boolean(on)
      notify()
    },

    getHardwarePreview() {
      return hardwarePreview
    },

    setBackendConflict(on) {
      backendConflict = Boolean(on)
      notify()
    },

    getEnableGates,

    offerTarget({ pose, sequence, timelineTimeMs, source } = {}) {
      if (!worker || !workerReady) return false
      if (estopLatched || hostState === BROWSER_NECK_RUNTIME_STATES.ESTOP) return false
      if (isCalibratingNow()) return false
      const snap = getSnapshot()
      if (!snap.enabled) return false
      // Manual editor path requires hardwarePreview (align Bridge semantics)
      if (source === "editor" && !hardwarePreview) return false
      post({
        type: "setTarget",
        pose,
        sequence,
        timelineTimeMs,
        source: source || "unknown",
      })
      return true
    },

    enterNeutralCalibration() {
      const transportReady = transportIsReady()
      const estop = estopLatched || hostState === BROWSER_NECK_RUNTIME_STATES.ESTOP
      // Recover from STALE before gate — calibration exit / heartbeat can leave motors enabled but STALE.
      if (
        hostState === BROWSER_NECK_RUNTIME_STATES.STALE_SAFE_HOLD &&
        !estop &&
        transportReady &&
        workerReady
      ) {
        post({ type: "resume" })
        hostState = BROWSER_NECK_RUNTIME_STATES.HOLD
      }
      const motionOk =
        hostState === BROWSER_NECK_RUNTIME_STATES.ENABLED ||
        hostState === BROWSER_NECK_RUNTIME_STATES.HOLD ||
        hostState === BROWSER_NECK_RUNTIME_STATES.RUNNING
      if (!transportReady || !profileValid || !workerReady || estop || !motionOk) {
        lastError = {
          code: "CALIBRATION_GATE",
          message: `enter blocked: transport=${transportReady} profile=${profileValid} worker=${workerReady} state=${hostState} estop=${estop}`,
        }
        notify()
        return { ok: false, error: lastError }
      }
      const session = ensureCalibrationSession()
      session.syncPersistedProfile(profile)
      session.enter()
      const working = applyWorkingOffsetsToProfile(profile, session.getWorkingOffsets())
      calibrating = true
      post({ type: "enterNeutralCalibration", profile: working })
      notify()
      return { ok: true, calibration: session.snapshot() }
    },

    nudgeCalibrationOffset(side, delta) {
      if (!isCalibratingNow()) {
        return { ok: false, error: { code: "NOT_CALIBRATING" } }
      }
      const session = ensureCalibrationSession()
      const result = session.nudge(side, delta)
      if (!result.ok) {
        lastError = { code: result.code, message: result.message || result.code }
        notify()
        return result
      }
      pushWorkingProfileToWorker()
      notify()
      return result
    },

    setCalibrationOffset(side, value) {
      if (!isCalibratingNow()) {
        return { ok: false, error: { code: "NOT_CALIBRATING" } }
      }
      const session = ensureCalibrationSession()
      const result = session.setOffset(side, value)
      if (!result.ok) {
        lastError = { code: result.code, message: result.lastError?.message || result.code }
        notify()
        return result
      }
      pushWorkingProfileToWorker()
      notify()
      return result
    },

    resetCalibrationTrim() {
      if (!isCalibratingNow()) {
        return { ok: false, error: { code: "NOT_CALIBRATING" } }
      }
      const session = ensureCalibrationSession()
      const result = session.resetTrimWorking()
      pushWorkingProfileToWorker()
      notify()
      return result
    },

    async saveCalibration() {
      if (!isCalibratingNow()) {
        return { ok: false, error: { code: "NOT_CALIBRATING" } }
      }
      const session = ensureCalibrationSession()
      const offsets = session.getWorkingOffsets()
      const next = applyWorkingOffsetsToProfile(profile || createLuviaReferenceProfile(), offsets)
      next.calibration = {
        type: SOFTWARE_INSTALLATION_NEUTRAL_TYPE,
        calibratedAt: new Date().toISOString(),
        status: CALIBRATION_STATUS.SAVED,
      }
      profile = normalizeNeckRuntimeProfile(next)
      profileValid = true
      session.syncPersistedProfile(profile)
      session.markSaved()
      try {
        await saveActiveNeckProfile(profile, profileStorage ? { storage: profileStorage } : {})
      } catch (err) {
        lastError = { code: "IDB_SAVE_FAILED", message: err?.message || String(err) }
        notify()
        return { ok: false, error: lastError, profile }
      }
      // Stay in calibration until explicit Exit (product preference)
      post({ type: "updateWorkingProfile", profile })
      lastError = null
      notify()
      return { ok: true, profile, calibration: session.snapshot() }
    },

    cancelCalibration() {
      const session = ensureCalibrationSession()
      session.cancelRestore()
      const restored = applyWorkingOffsetsToProfile(
        profile || createLuviaReferenceProfile(),
        session.getPersistedOffsets()
      )
      profile = normalizeNeckRuntimeProfile({
        ...restored,
        calibration: profile?.calibration || restored.calibration,
      })
      // Always leave calibration session — cancel alone must not leave host/worker stuck.
      post({
        type: "exitNeutralCalibration",
        profile,
        exitTo: BROWSER_NECK_RUNTIME_STATES.HOLD,
        force: true,
      })
      session.exitToIdle()
      calibrating = false
      notify()
      return { ok: true, calibration: session.snapshot() }
    },

    exitNeutralCalibration({ discardUnsaved = false } = {}) {
      const session = ensureCalibrationSession()
      if (session.hasUnsaved() && !discardUnsaved) {
        return {
          ok: false,
          error: { code: "UNSAVED_CALIBRATION", message: "unsaved calibration changes" },
          calibration: session.snapshot(),
        }
      }
      if (discardUnsaved) session.cancelRestore()
      const restored = applyWorkingOffsetsToProfile(
        profile || createLuviaReferenceProfile(),
        session.getPersistedOffsets()
      )
      // Align worker with persisted canonical offsets
      profile = normalizeNeckRuntimeProfile({
        ...restored,
        calibration: profile?.calibration || restored.calibration,
      })
      // If already STALE, resume path is folded into exitNeutralCalibration(force) on worker.
      if (hostState === BROWSER_NECK_RUNTIME_STATES.STALE_SAFE_HOLD) {
        post({ type: "resume" })
      }
      post({
        type: "exitNeutralCalibration",
        profile,
        exitTo: BROWSER_NECK_RUNTIME_STATES.HOLD,
        force: true,
      })
      session.exitToIdle()
      calibrating = false
      notify()
      return { ok: true, calibration: session.snapshot() }
    },

    hasUnsavedCalibration() {
      return Boolean(calibrationSession?.hasUnsaved?.())
    },

    getCalibrationSnapshot() {
      return ensureCalibrationSession().snapshot()
    },

    async enableMotors() {
      const gates = getEnableGates()
      if (!gates.ok) {
        lastError = {
          code: "ENABLE_GATES",
          message: `enable blocked: transport=${gates.transportReady} profile=${gates.profileValid} profileReady=${gates.profileReady} worker=${gates.workerReady} conflict=${gates.noConflict} estop=${gates.noEstop} cal=${gates.noCalibration}`,
        }
        notify()
        return { ok: false, gates }
      }
      if (isCalibratingNow()) {
        lastError = { code: "CALIBRATION_ACTIVE", message: "cannot enable while calibrating" }
        notify()
        return { ok: false, error: lastError }
      }
      const snap = getSnapshot()
      if (snap.enabled) {
        lastError = { code: "ALREADY_ENABLED", message: "motors already enabled" }
        notify()
        return { ok: false, error: lastError }
      }
      if (!worker) await startWorker(profile)
      post({ type: "enable" })
      return { ok: true }
    },

    /**
     * Disable motors. If calibration dirty and discardUnsaved=false → UNSAVED_CALIBRATION.
     * Discard path restores persisted offsets to Worker before disable.
     */
    disableMotors({ discardUnsaved = false } = {}) {
      if (hostState === BROWSER_NECK_RUNTIME_STATES.STALE_SAFE_HOLD && !estopLatched) {
        post({ type: "resume" })
        hostState = BROWSER_NECK_RUNTIME_STATES.HOLD
      }
      if (isCalibratingNow()) {
        const session = ensureCalibrationSession()
        if (session.hasUnsaved() && !discardUnsaved) {
          lastError = {
            code: "UNSAVED_CALIBRATION",
            message: "save or discard calibration before disable",
          }
          notify()
          return { ok: false, error: lastError }
        }
        restorePersistedProfileToWorker("DISABLE_DISCARD_CALIBRATION")
        // Ensure worker leaves calibration so Disable is not blocked.
        post({
          type: "exitNeutralCalibration",
          profile,
          exitTo: BROWSER_NECK_RUNTIME_STATES.HOLD,
          force: true,
        })
        session.exitToIdle()
        calibrating = false
      }
      post({ type: "disable" })
      notify()
      return { ok: true }
    },

    estop() {
      invalidateCalibrationSessionAfterEstop()
      // Best-effort: restore persisted profile memory (no auto-save of working)
      if (profileValid && profile) {
        const session = calibrationSession
        if (session) {
          const restored = applyWorkingOffsetsToProfile(profile, session.getPersistedOffsets())
          profile = normalizeNeckRuntimeProfile({
            ...restored,
            calibration: profile?.calibration || restored.calibration,
          })
        }
      }
      estopLatched = true
      post({ type: "estop" })
      notify()
    },

    /**
     * Explicit Clear ESTOP → DISABLED. Does not auto Enable / Resume.
     */
    clearEstop() {
      if (!estopLatched && hostState !== BROWSER_NECK_RUNTIME_STATES.ESTOP) {
        lastError = { code: "NOT_ESTOP", message: "estop not latched" }
        notify()
        return { ok: false, error: lastError }
      }
      if (!transportIsReady()) {
        lastError = {
          code: "TRANSPORT_NOT_READY",
          message: "clear ESTOP requires transport READY",
        }
        notify()
        return { ok: false, error: lastError }
      }
      if (isCalibratingNow()) {
        lastError = {
          code: "CALIBRATION_ACTIVE",
          message: "clear ESTOP blocked while calibrating",
        }
        notify()
        return { ok: false, error: lastError }
      }
      post({ type: "clearEstop" })
      // Optimistic host sync; worker state message confirms
      estopLatched = false
      hostState = BROWSER_NECK_RUNTIME_STATES.DISABLED
      lastError = null
      notify()
      return { ok: true }
    },

    resume() {
      if (isCalibratingNow()) {
        lastError = { code: "CALIBRATION_ACTIVE", message: "resume blocked while calibrating" }
        notify()
        return { ok: false, error: lastError }
      }
      if (estopLatched) {
        lastError = { code: "ESTOP_LATCHED", message: "clear ESTOP via clearEstop first" }
        notify()
        return { ok: false, error: lastError }
      }
      post({ type: "resume" })
      return { ok: true }
    },

    hold() {
      if (isCalibratingNow()) {
        lastError = { code: "CALIBRATION_ACTIVE", message: "hold blocked while calibrating" }
        notify()
        return { ok: false, error: lastError }
      }
      post({ type: "hold" })
      return { ok: true }
    },

    /** Timeline pause: keep heartbeat; hold target */
    onTimelinePause() {
      if (isCalibratingNow() || estopLatched) return { ok: false }
      post({ type: "hold" })
      return { ok: true }
    },

    /** Timeline stop: hold pose, no auto disable */
    onTimelineStop() {
      if (isCalibratingNow() || estopLatched) return { ok: false }
      post({ type: "stop" })
      return { ok: true }
    },

    /**
     * Safe Disable using active profile adapter (never invent a fresh reference profile).
     */
    async sendSafeDisable() {
      if (!profileValid || !profile) {
        lastError = { code: "INVALID_PROFILE", message: "active profile required for Safe Disable" }
        notify()
        return { ok: false, error: lastError }
      }
      if (!transportIsReady()) {
        lastError = { code: "TRANSPORT_NOT_READY", message: "transport not READY" }
        notify()
        return { ok: false, error: lastError }
      }
      const transport = getTransport()
      if (!transport || typeof transport.sendFrame !== "function") {
        lastError = { code: "NO_TRANSPORT", message: "transport unavailable" }
        notify()
        return { ok: false, error: lastError }
      }
      try {
        const adapter = getMotorProtocolAdapter(profile)
        const frame = adapter.encodeDisableCommand([1, 2, 3])
        await transport.sendFrame(frame)
        physicalTxCount += 1
        lastWriteOk = true
        lastError = null
        notify()
        return { ok: true, profileName: profile.name }
      } catch (err) {
        lastWriteOk = false
        lastError = { code: err?.code || "SAFE_DISABLE_FAILED", message: err?.message || String(err) }
        notify()
        return { ok: false, error: lastError }
      }
    },

    notifyTransportReady() {
      if (transportIsReady()) {
        if (hostState === BROWSER_NECK_RUNTIME_STATES.DISCONNECTED) {
          hostState = BROWSER_NECK_RUNTIME_STATES.TRANSPORT_READY
        }
        post({ type: "transportReady" })
        notify()
      }
    },

    notifyTransportLost() {
      // Unexpected loss or Close: discard working calib memory → restore persisted (no auto-save)
      if (isCalibratingNow() || calibrationSession?.hasUnsaved?.()) {
        restorePersistedProfileToWorker("TRANSPORT_LOST_DISCARD")
      } else if (isCalibratingNow()) {
        ensureCalibrationSession().exitToIdle()
        calibrating = false
      }
      txQueue.clearAll()
      // Stale CLOSED send faults are not actionable once transport is gone
      if (
        lastError?.code === "SEND_FAILED" ||
        lastError?.code === "NOT_READY" ||
        /sendFrame requires READY/i.test(String(lastError?.message || ""))
      ) {
        lastError = null
      }
      hostState = BROWSER_NECK_RUNTIME_STATES.ERROR
      post({ type: "transportLost" })
      notify()
    },

    requestSnapshot() {
      post({ type: "getSnapshot" })
    },

    getSnapshot,
    subscribeSnapshot(fn) {
      if (typeof fn !== "function") return () => {}
      listeners.add(fn)
      try {
        fn(getSnapshot())
      } catch {
        /* ignore */
      }
      return () => listeners.delete(fn)
    },

    async dispose() {
      disposed = true
      stopWorker()
      listeners.clear()
    },

    /** Expose queue for tests */
    _txQueue: txQueue,
    _getWorker: () => worker,
  }
}

export { HARDWARE_BACKEND_CONFLICT, COMMAND_PRIORITY, BROWSER_NECK_RUNTIME_STATES }
