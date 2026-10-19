import { legacyServoIndexToActuatorKey } from "../output/actuatorKeys.js"

export const BINDING_DEDUPE_VERSION = "1"

/** 同一控件通道 + 同一 actuator 只保留一条绑定（保留先出现的）。 */
export function bindingControlChannelActuatorKey(binding) {
  const ak =
    binding?.actuatorKey ||
    (Number.isFinite(Number(binding?.servoId))
      ? legacyServoIndexToActuatorKey(binding.servoId)
      : "servo_?")
  return `${binding?.controlId ?? ""}|${binding?.channel ?? ""}|${ak}`
}

/**
 * 去掉重复绑定（同 controlId + channel + actuatorKey）。
 * @returns {{ bindings: object[], dropped: object[] }}
 */
export function dedupeBindingsByControlChannelActuator(bindings) {
  const seen = new Set()
  const kept = []
  const dropped = []
  for (const b of bindings || []) {
    const key = bindingControlChannelActuatorKey(b)
    if (seen.has(key)) {
      dropped.push(b)
      continue
    }
    seen.add(key)
    kept.push(b)
  }
  return { bindings: kept, dropped }
}

export function formatDedupeDroppedSummary(dropped) {
  if (!dropped?.length) {
    return ""
  }
  return dropped
    .map(
      (b) =>
        `${b.controlId}.${b.channel}→${b.actuatorKey ?? `servo_${b.servoId}`} (${b.bindingId})`
    )
    .join("；")
}
