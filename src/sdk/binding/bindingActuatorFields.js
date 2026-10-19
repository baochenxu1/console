import { actuatorKeyToLegacyIndex, legacyServoIndexToActuatorKey } from "../output/actuatorKeys.js"

/**
 * 将 servoId / legacyServoIndex / actuatorKey 对齐。
 * servoId 为 UI 改目标时的权威来源；陈旧 actuatorKey 会被覆盖。
 */
export function reconcileBindingActuatorFields(raw = {}) {
  const servoIdRaw = Number(raw.servoId)
  const legacyRaw = Number(raw.legacyServoIndex)

  const servoId = Number.isFinite(servoIdRaw)
    ? servoIdRaw
    : Number.isFinite(legacyRaw)
      ? legacyRaw
      : undefined

  const legacyServoIndex = Number.isFinite(servoId) ? servoId : legacyRaw

  let actuatorKey =
    typeof raw.actuatorKey === "string" && raw.actuatorKey.trim()
      ? raw.actuatorKey.trim()
      : Number.isFinite(legacyServoIndex)
        ? legacyServoIndexToActuatorKey(legacyServoIndex)
        : undefined

  if (Number.isFinite(servoId)) {
    const expected = legacyServoIndexToActuatorKey(servoId)
    const keyIdx = actuatorKeyToLegacyIndex(actuatorKey)
    if (!actuatorKey || keyIdx !== servoId) {
      actuatorKey = expected
    }
  }

  return {
    servoId: Number.isFinite(servoId) ? servoId : 0,
    /** 与 servoId / actuatorKey 数字一致，供 pose 与 bus 输出共用 */
    legacyServoIndex: Number.isFinite(servoId) ? servoId : legacyServoIndex,
    actuatorKey,
  }
}

/** 修改绑定目标舵机时同步写入的 patch */
export function bindingTargetPatch(nextServoLikeId) {
  const n = Number(nextServoLikeId)
  if (!Number.isFinite(n)) {
    return {}
  }
  return {
    servoId: n,
    legacyServoIndex: n,
    actuatorKey: legacyServoIndexToActuatorKey(n),
  }
}

export function traceBindingUpdateTarget({
  bindingId,
  prevServoId,
  prevActuatorKey,
  nextServoId,
  nextActuatorKey,
}) {
  if (typeof console !== "undefined" && console.info) {
    console.info("[FaceBinding:updateTarget]", {
      bindingId,
      prevServoId,
      prevActuatorKey,
      nextServoId,
      nextActuatorKey,
    })
  }
}

export function traceBindingNormalized(binding) {
  if (!binding || typeof console === "undefined" || !console.info) {
    return
  }
  console.info("[FaceBinding:normalized]", {
    bindingId: binding.bindingId,
    servoId: binding.servoId,
    legacyServoIndex: binding.legacyServoIndex,
    actuatorKey: binding.actuatorKey,
  })
}

export function traceFinalServoOutputs(outputs) {
  if (typeof console === "undefined" || !console.info) {
    return
  }
  console.info("[FaceBinding:finalOutputs]", outputs)
}
