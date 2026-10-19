import { computeServoTargetFromLogical } from "../servoAdapters/core/servoProfileMath.js"
import { resolveActuatorProfile } from "./resolveActuatorProfile.js"

/**
 * 为诊断 UI 附加 outputType / bus 预览 targetPosition（不下发）。
 */
export function enrichFinalServoOutputsForPreview(finalOutputs, actuatorProfiles) {
  return (finalOutputs || []).map((out) => {
    const resolved = resolveActuatorProfile({
      actuatorKey: out.actuatorKey,
      legacyServoIndex: out.legacyServoIndex,
      profiles: actuatorProfiles,
    })

    if (!resolved.ok) {
      return {
        ...out,
        outputType: null,
        busServoId: null,
        protocol: null,
        targetPosition: null,
        centerMode: null,
        profileResolveReason: resolved.reason,
        profileResolveWarning: null,
        profileResolveWarningMessage: null,
      }
    }

    const ap = resolved.profile
    let targetPosition = null
    let centerMode = null
    let isClamped = false

    if (ap.outputType === "bus" && ap.busServoId > 0) {
      const plan = computeServoTargetFromLogical(ap, out.logicalValue)
      targetPosition = plan.targetPosition
      centerMode = plan.centerMode ?? ap.centerMode
      isClamped = Boolean(plan.isClamped)
    }

    return {
      ...out,
      outputType: ap.outputType,
      busServoId: ap.busServoId,
      protocol: ap.protocol,
      servoModel: ap.servoModel,
      targetPosition,
      centerMode,
      isClamped,
      installedCenterPosition: ap.installedCenterPosition,
      profileResolveReason: null,
      profileResolveWarning: resolved.warning ?? null,
      profileResolveWarningMessage: resolved.warningMessage ?? null,
    }
  })
}
