import { buildServoMovesFromLogicalPose } from "../../core/faceDofMapper.js"

/**
 * logicalPose → 逻辑舵机 moves（含 actualPwm 字段，供预览）。
 * PWM 文本协议已移除；实发请走 FinalServoOutput → Bus。
 */
export function buildServoMovesFromPose({ logicalPose, configs, timeMs = 500 }) {
  return buildServoMovesFromLogicalPose(logicalPose, configs, timeMs)
}

/** @deprecated 不再生成 `#idP…T…!`；返回预览摘要字符串。 */
export function buildServoCommandFromPose({ logicalPose, configs, timeMs = 500 }) {
  const moves = buildServoMovesFromPose({ logicalPose, configs, timeMs })
  if (!moves.length) {
    return ""
  }
  return `[Bus preview] ${moves.length} servos · T=${timeMs}ms`
}
