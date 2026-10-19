/**
 * Expression Preset Character Preview Stage — logical geometry contract.
 * Presentation only; no IK / servo math.
 */

export const CHARACTER_PRESET_STAGE_LOGICAL = Object.freeze({
  width: 860,
  height: 740,
  face: Object.freeze({
    x: 20,
    y: 8,
    width: 820,
    height: 548,
  }),
  neck: Object.freeze({
    padSize: 168,
    yawWidth: 300,
    clusterTop: 568,
  }),
})

/**
 * Uniform contain scale for a logical canvas inside a viewport.
 * Always scaleX === scaleY.
 */
export function computeUniformContainScale(
  availableWidth,
  availableHeight,
  logicalWidth = CHARACTER_PRESET_STAGE_LOGICAL.width,
  logicalHeight = CHARACTER_PRESET_STAGE_LOGICAL.height,
  padding = 8
) {
  const aw = Math.max(0, Number(availableWidth) - padding * 2)
  const ah = Math.max(0, Number(availableHeight) - padding * 2)
  const lw = Math.max(1, Number(logicalWidth) || 1)
  const lh = Math.max(1, Number(logicalHeight) || 1)
  if (aw < 1 || ah < 1) return 0
  return Math.min(aw / lw, ah / lh)
}

export function isUniformScale(scaleX, scaleY, epsilon = 1e-6) {
  return Math.abs(Number(scaleX) - Number(scaleY)) <= epsilon
}
