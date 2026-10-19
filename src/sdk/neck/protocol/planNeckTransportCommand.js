/**
 * R1 planNeckPose → MotorCommand → MotorProtocol Adapter → CanFrame → transport codec.
 * Convenience wrapper preserves outward result shape (accepted, plan, canFrame, slcanLine, ...).
 */

import { planNeckPose, createNeckPlannerState } from "../core/planNeckPose.js"
import {
  createLuviaReferenceProfile,
  normalizeNeckRuntimeProfile,
} from "../core/neckRuntimeProfile.js"
import { createMotorCommandFromMotorTargets } from "./motorCommand.js"
import { createMotorProtocolAdapter } from "./motorProtocolRegistry.js"
import { createProductionBmHmdProtocol } from "./bmHmdProtocol.js"
import { createBmHmdProtocolAdapter } from "./bmHmdProtocolAdapter.js"
import { dataToHex, assertProductionNeckTxFrame } from "./canFrame.js"
import {
  createLuviaTransportProfile,
  rejectBrsConfig,
  normalizeTransportConfig,
  toFlatTransportProfile,
} from "../transport/transportProfile.js"
import { createTransportCodec } from "../transport/slcanCodec.js"
import {
  validateProtocolTransportCompatibility,
} from "./motorProtocol.js"

function firstFrame(encoded) {
  if (Array.isArray(encoded)) return encoded[0] || null
  return encoded || null
}

/**
 * @param {{
 *   pose: object,
 *   profile?: object,
 *   previousState?: object,
 *   applySafetyLimiter?: boolean,
 *   dt?: number,
 *   transportProfile?: object,
 *   protocol?: import('./bmHmdProtocol.js').BmHmdProtocol,
 *   adapter?: object,
 * }} args
 */
export function planNeckTransportCommand({
  pose,
  profile = null,
  previousState = null,
  applySafetyLimiter = true,
  dt = null,
  transportProfile = null,
  protocol = null,
  adapter = null,
} = {}) {
  const runtimeProfile = normalizeNeckRuntimeProfile(
    profile || createLuviaReferenceProfile()
  )

  const transportNested = transportProfile
    ? normalizeTransportConfig(transportProfile)
    : runtimeProfile.transport
  const transportFlat = toFlatTransportProfile({
    ...transportNested,
    protocolProfileVersion:
      runtimeProfile.motorProtocol?.version ||
      createLuviaTransportProfile().protocolProfileVersion,
  })
  rejectBrsConfig(transportFlat)

  const plan = planNeckPose({
    pose,
    profile: runtimeProfile,
    previousState: previousState || createNeckPlannerState(),
    applySafetyLimiter,
    dt,
  })

  const transportDiagBase = {
    protocolProfileVersion: transportFlat.protocolProfileVersion,
    canFd: transportFlat.canFd,
    brs: transportFlat.brs,
    motorProtocolType: runtimeProfile.motorProtocol?.type,
    transportType: transportNested.type,
    canMode: transportNested.can?.mode,
  }

  if (!plan.accepted) {
    return {
      accepted: false,
      rejectReason: plan.rejectReason,
      plan,
      canFrame: null,
      slcanLine: null,
      motorRawSlots: null,
      motorCommand: null,
      nextState: plan.nextState,
      diagnostics: {
        ...plan.diagnostics,
        transport: transportDiagBase,
      },
    }
  }

  const raw = plan.motorTargets?.raw || { id1: 0, id2: 0, id3: 0 }
  const motorRawSlots = {
    motor1: Number(raw.id1) || 0,
    motor2: Number(raw.id2) || 0,
    motor3: Number(raw.id3) || 0,
    motor4: 0,
  }

  const motorCommand = createMotorCommandFromMotorTargets(plan.motorTargets)

  // Resolve adapter: explicit → registry from profile → legacy BmHmdProtocol wrapper
  let activeAdapter = adapter
  if (!activeAdapter && protocol && typeof protocol.encodePositionCommandFrameFromRaw === "function") {
    // Legacy R2 escape hatch: wrap class instance
    activeAdapter = {
      type: "bm-hmd",
      version: "bm-hmd-luvia-v1",
      capabilities: {
        modes: ["POSITION"],
        maxMotorsPerFrame: 4,
        supportsFeedback: true,
        requiresCanFd: true,
        requiresBrs: false,
      },
      encodePositionCommand() {
        return protocol.encodePositionCommandFrameFromRaw(
          motorRawSlots.motor1,
          motorRawSlots.motor2,
          motorRawSlots.motor3,
          motorRawSlots.motor4
        )
      },
      encodeEnableCommand() {
        throw new Error("legacy protocol wrapper: encodeEnableCommand not bound")
      },
      encodeDisableCommand() {
        throw new Error("legacy protocol wrapper: encodeDisableCommand not bound")
      },
      encodeControlModeCommand() {
        throw new Error("legacy protocol wrapper: encodeControlModeCommand not bound")
      },
      decodeFrame() {
        throw new Error("legacy protocol wrapper: decodeFrame not bound")
      },
    }
  }
  if (!activeAdapter) {
    activeAdapter = createMotorProtocolAdapter({
      ...runtimeProfile,
      transport: transportNested,
    })
  }

  validateProtocolTransportCompatibility({
    motorProtocol: runtimeProfile.motorProtocol,
    transport: transportNested,
    capabilities: activeAdapter.capabilities,
    adapter: activeAdapter,
  })

  const encoded = activeAdapter.encodePositionCommand(motorCommand)
  const canFrame = firstFrame(encoded)

  if (activeAdapter.capabilities?.requiresCanFd) {
    assertProductionNeckTxFrame(canFrame)
  }

  const codec = createTransportCodec(transportNested)
  const slcanLine = codec.encodeFrame(canFrame)

  return {
    accepted: true,
    rejectReason: "",
    plan,
    canFrame,
    slcanLine,
    motorRawSlots,
    motorCommand,
    adapterType: activeAdapter.type,
    nextState: plan.nextState,
    diagnostics: {
      ...plan.diagnostics,
      transport: {
        ...transportDiagBase,
        arbitrationId: canFrame.arbitrationId,
        isFd: canFrame.isFd,
        frameBrs: canFrame.brs,
        dataHex: dataToHex(canFrame.data),
        slcanLine,
      },
    },
  }
}

/** @deprecated internal helper kept for clarity in docs/tests */
export function createDefaultBmHmdStack() {
  return {
    adapter: createBmHmdProtocolAdapter(createLuviaReferenceProfile()),
    protocol: createProductionBmHmdProtocol(),
    codec: createTransportCodec({ type: "slcan" }),
  }
}
