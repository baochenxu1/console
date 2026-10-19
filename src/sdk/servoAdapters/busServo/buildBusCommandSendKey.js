/**
 * 全量命令指纹（用于去重限频，避免截断 preview 导致误判相同）。
 * @param {object[]} commands
 */
export function buildBusCommandSendKey(commands) {
  if (!Array.isArray(commands) || !commands.length) {
    return ""
  }
  return commands
    .map((c) => `${c.busServoId}:${c.targetPosition}`)
    .sort()
    .join("|")
}
