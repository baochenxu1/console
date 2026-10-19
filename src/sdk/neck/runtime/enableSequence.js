/**
 * Enable sequence — Luvia `_enable_open_loop_commissioning_exact` steps via MotorProtocolAdapter only.
 * Async staged runner (setTimeout/Promise) — NEVER sync sleep.
 */

import { planNeckPose, createNeckPlannerState } from "../core/planNeckPose.js"
import { createMotorCommandFromMotorTargets } from "../protocol/motorCommand.js"
import { createMotorProtocolAdapter } from "../protocol/motorProtocolRegistry.js"
import { createLuviaReferenceProfile, normalizeNeckRuntimeProfile } from "../core/neckRuntimeProfile.js"
import { COMMAND_PRIORITY } from "./commandPriority.js"

export const ENABLE_SETTLE_DEFAULTS = Object.freeze({
  disableMs: 150,
  modeMs: 150,
  preholdMs: 500,
  preholdFrames: 10,
  postholdMs: 200,
  postholdFrames: 5,
})

function asFrames(encoded) {
  if (!encoded) return []
  return Array.isArray(encoded) ? encoded : [encoded]
}

/**
 * User-zero raw from planNeckPose neutral (pose 0,0,0).
 * @param {object} profile
 */
export function resolveUserZeroMotorCommand(profile) {
  const prof = normalizeNeckRuntimeProfile(profile || createLuviaReferenceProfile())
  const plan = planNeckPose({
    pose: { pitch: 0, roll: 0, yaw: 0 },
    profile: prof,
    previousState: createNeckPlannerState(),
    applySafetyLimiter: false,
  })
  const raw = plan?.motorTargets?.raw || { id1: 0, id2: 0, id3: 0, id4: 0 }
  return createMotorCommandFromMotorTargets({
    raw,
    commandDeg: plan?.motorTargets?.moduleDeg,
  })
}

/**
 * Build enable sequence steps (pure). Frames via adapter.encode*.
 *
 * @param {{
 *   adapter?: object,
 *   profile?: object,
 *   motorIds?: number[],
 *   settle?: Partial<typeof ENABLE_SETTLE_DEFAULTS>,
 * }} [opts]
 */
export function buildEnableSequenceSteps(opts = {}) {
  const profile = normalizeNeckRuntimeProfile(opts.profile || createLuviaReferenceProfile())
  const adapter =
    opts.adapter && typeof opts.adapter.encodeDisableCommand === "function"
      ? opts.adapter
      : createMotorProtocolAdapter(profile)
  const motorIds = Array.isArray(opts.motorIds) && opts.motorIds.length
    ? opts.motorIds.map(Number)
    : [1, 2, 3]
  const settle = { ...ENABLE_SETTLE_DEFAULTS, ...(opts.settle || {}) }
  const zeroCmd = resolveUserZeroMotorCommand(profile)
  const zeroFrames = asFrames(adapter.encodePositionCommand(zeroCmd))

  /** @type {Array<object>} */
  const steps = []

  steps.push({
    id: "disable",
    kind: "disable",
    priority: COMMAND_PRIORITY.DISABLE_CONTROL,
    settleMs: settle.disableMs,
    frames: asFrames(adapter.encodeDisableCommand(motorIds)),
    meta: { motorIds },
  })

  for (const id of motorIds) {
    steps.push({
      id: `mode-${id}`,
      kind: "mode",
      priority: COMMAND_PRIORITY.ENABLE_STEP,
      settleMs: settle.modeMs,
      frames: asFrames(adapter.encodeControlModeCommand(id, "POSITION")),
      meta: { motorId: id, mode: "POSITION" },
    })
  }

  steps.push({
    id: "prehold",
    kind: "prehold",
    priority: COMMAND_PRIORITY.ENABLE_STEP,
    settleMs: settle.preholdMs,
    frames: zeroFrames,
    meta: {
      holdFrames: settle.preholdFrames,
      motorCommand: zeroCmd,
    },
  })

  steps.push({
    id: "enable",
    kind: "enable",
    priority: COMMAND_PRIORITY.ENABLE_STEP,
    settleMs: 0,
    frames: asFrames(adapter.encodeEnableCommand(motorIds)),
    meta: { motorIds },
  })

  steps.push({
    id: "posthold",
    kind: "posthold",
    priority: COMMAND_PRIORITY.ENABLE_STEP,
    settleMs: settle.postholdMs,
    frames: zeroFrames,
    meta: {
      holdFrames: settle.postholdFrames,
      motorCommand: zeroCmd,
    },
  })

  return Object.freeze(steps.map((s) => Object.freeze({ ...s, frames: Object.freeze([...s.frames]) })))
}

/**
 * Async enable sequence runner — abortable, non-blocking delays.
 *
 * @param {{
 *   sendFrame: (frame: object, meta?: object) => Promise<void>|void,
 *   delay?: (ms: number) => Promise<void>,
 * }} opts
 */
export function createEnableSequenceRunner(opts = {}) {
  const sendFrame = opts.sendFrame
  if (typeof sendFrame !== "function") {
    throw new Error("createEnableSequenceRunner requires sendFrame")
  }
  const delay =
    typeof opts.delay === "function"
      ? opts.delay
      : (ms) =>
          new Promise((resolve) => {
            setTimeout(resolve, Math.max(0, Number(ms) || 0))
          })

  let aborted = false
  let running = false

  return {
    abort() {
      aborted = true
    },
    isRunning() {
      return running
    },
    /**
     * @param {object[]} steps
     * @param {{ onProgress?: Function }} [runOpts]
     */
    async run(steps, runOpts = {}) {
      aborted = false
      running = true
      const onProgress = typeof runOpts.onProgress === "function" ? runOpts.onProgress : null
      const list = Array.isArray(steps) ? steps : []
      try {
        for (let i = 0; i < list.length; i++) {
          if (aborted) {
            return { ok: false, aborted: true, stepIndex: i, stepId: list[i]?.id }
          }
          const step = list[i]
          onProgress?.({
            phase: "step_start",
            stepIndex: i,
            stepId: step.id,
            kind: step.kind,
          })
          const frames = Array.isArray(step.frames) ? step.frames : []
          for (const frame of frames) {
            if (aborted) {
              return { ok: false, aborted: true, stepIndex: i, stepId: step.id }
            }
            try {
              await sendFrame(frame, {
                priority: step.priority,
                stepId: step.id,
                kind: step.kind,
                meta: step.meta,
              })
            } catch (err) {
              onProgress?.({
                phase: "step_fail",
                stepIndex: i,
                stepId: step.id,
                error: err,
              })
              return {
                ok: false,
                aborted: false,
                stepIndex: i,
                stepId: step.id,
                error: err,
              }
            }
          }
          onProgress?.({
            phase: "step_sent",
            stepIndex: i,
            stepId: step.id,
            kind: step.kind,
          })
          const settle = Number(step.settleMs) || 0
          if (settle > 0) {
            await delay(settle)
          }
          if (aborted) {
            return { ok: false, aborted: true, stepIndex: i, stepId: step.id }
          }
          onProgress?.({
            phase: "step_done",
            stepIndex: i,
            stepId: step.id,
            kind: step.kind,
          })
        }
        return { ok: true, aborted: false, stepIndex: list.length - 1 }
      } finally {
        running = false
      }
    },
  }
}
