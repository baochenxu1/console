/**
 * Browser Neck Core shadow diagnostic (R1 + R2 protocol).
 * Default OFF — does not send to hardware; only plans + stores snapshot fields.
 */

import { planNeckPose, createNeckPlannerState } from "./core/planNeckPose.js"
import { createLuviaReferenceProfile } from "./core/neckRuntimeProfile.js"
import { planNeckTransportCommand } from "./protocol/planNeckTransportCommand.js"
import { dataToHex } from "./protocol/canFrame.js"

const DEFAULT_SHADOW_EMIT_MIN_MS = 40 // ~25 Hz max diagnostic emit

function nowMs() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now()
}

/**
 * @param {{ enabled?: boolean, profile?: object, emitMinMs?: number, protocolShadow?: boolean }} [options]
 */
export function createNeckBrowserShadow(options = {}) {
  let enabled = Boolean(options.enabled)
  let profile = options.profile || createLuviaReferenceProfile()
  let plannerState = createNeckPlannerState()
  let lastShadowPlan = null
  let lastEmitAt = 0
  const emitMinMs = Math.max(0, Number(options.emitMinMs) || DEFAULT_SHADOW_EMIT_MIN_MS)
  // Protocol canFrame/slcan diagnostics: default OFF even when R1 shadow is on
  let protocolShadow = options.protocolShadow === true

  function setEnabled(v) {
    enabled = Boolean(v)
  }

  function isEnabled() {
    return enabled
  }

  function setProtocolShadow(v) {
    protocolShadow = Boolean(v)
  }

  function isProtocolShadowEnabled() {
    return protocolShadow
  }

  function reset(state) {
    plannerState = state || createNeckPlannerState()
    lastShadowPlan = null
  }

  /**
   * After offerTarget prepare — call with the same semantic pose.
   * @returns {object|null} compact shadow snapshot (or null if disabled / throttled)
   */
  function observePose(pose, { forceEmit = false } = {}) {
    if (!enabled) return null

    let transport = null
    if (protocolShadow) {
      transport = planNeckTransportCommand({
        pose,
        profile,
        previousState: plannerState,
        applySafetyLimiter: true,
      })
      if (transport.accepted) {
        plannerState = transport.nextState
      }
    } else {
      const plan = planNeckPose({
        pose,
        profile,
        previousState: plannerState,
        applySafetyLimiter: true,
      })
      if (plan.accepted) {
        plannerState = plan.nextState
      }
      transport = {
        accepted: plan.accepted,
        rejectReason: plan.rejectReason || "",
        plan,
        canFrame: null,
        slcanLine: null,
        motorRawSlots: null,
        nextState: plan.nextState,
        diagnostics: plan.diagnostics,
      }
    }

    const plan = transport.plan
    const protocolDiag =
      protocolShadow && transport.canFrame
        ? {
            accepted: transport.accepted,
            motorRawSlots: transport.motorRawSlots,
            can: {
              id: transport.canFrame.arbitrationId,
              isFd: transport.canFrame.isFd,
              brs: transport.canFrame.brs,
              dataHex: dataToHex(transport.canFrame.data),
            },
            slcan: { line: transport.slcanLine },
            parity: {
              luviaFrameAvailable: false,
              frameEqual: null,
            },
          }
        : null

    lastShadowPlan = {
      atMs: nowMs(),
      accepted: transport.accepted,
      rejectReason: transport.rejectReason || plan?.rejectReason || "",
      q1: plan?.joints?.q1 ?? 0,
      q2: plan?.joints?.q2 ?? 0,
      q3: plan?.joints?.q3 ?? 0,
      mappedRaw: plan?.motorTargets?.raw || { id1: 0, id2: 0, id3: 0 },
      branch: plan?.diagnostics?.branch || "",
      closureErrorMm: plan?.diagnostics?.closureErrorMm,
      safetyLimited: Boolean(plan?.diagnostics?.safetyLimited),
      safetyLimitReason: plan?.diagnostics?.safetyLimitReason || "",
      browserNativeProtocol: protocolDiag,
    }
    const t = nowMs()
    if (!forceEmit && t - lastEmitAt < emitMinMs) {
      return { ...lastShadowPlan, throttled: true }
    }
    lastEmitAt = t
    return { ...lastShadowPlan, throttled: false }
  }

  function getLastShadowPlan() {
    return lastShadowPlan
  }

  return {
    setEnabled,
    isEnabled,
    setProtocolShadow,
    isProtocolShadowEnabled,
    reset,
    observePose,
    getLastShadowPlan,
    setProfile(p) {
      profile = p
    },
  }
}

/** Env / options gate: options.browserCoreShadow === true or FACEDEV_NECK_BROWSER_SHADOW=1 */
export function resolveBrowserCoreShadowEnabled(options = {}) {
  if (options.browserCoreShadow === true) return true
  if (options.browserCoreShadow === false) return false
  try {
    if (typeof process !== "undefined" && process.env?.FACEDEV_NECK_BROWSER_SHADOW === "1") {
      return true
    }
  } catch {
    //
  }
  return false
}

/** Protocol shadow diagnostics (canFrame/slcan): default OFF; FACEDEV_NECK_BROWSER_PROTOCOL_SHADOW=1 */
export function resolveBrowserProtocolShadowEnabled(options = {}) {
  if (options.browserProtocolShadow === true) return true
  if (options.browserProtocolShadow === false) return false
  try {
    if (
      typeof process !== "undefined" &&
      process.env?.FACEDEV_NECK_BROWSER_PROTOCOL_SHADOW === "1"
    ) {
      return true
    }
  } catch {
    //
  }
  return false
}
