/**
 * 纯函数：关键帧 positions 合并（不修改入参对象）。
 */
export function mergeKeyframePositions(basePositions = {}, pose = {}) {
  return { ...basePositions, ...pose }
}
