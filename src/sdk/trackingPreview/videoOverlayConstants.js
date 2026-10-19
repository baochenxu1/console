/**
 * Video Preview landmark overlay 显示模式。
 */
export const VIDEO_OVERLAY_MODES = /** @type {const} */ ({
  OFF: "off",
  SELECTED: "selected",
  MESH: "mesh",
  BOTH: "both",
})

export const VIDEO_OVERLAY_MODE_LABELS = {
  [VIDEO_OVERLAY_MODES.OFF]: "Off",
  [VIDEO_OVERLAY_MODES.SELECTED]: "Selected Landmarks",
  [VIDEO_OVERLAY_MODES.MESH]: "Full Face Mesh",
  [VIDEO_OVERLAY_MODES.BOTH]: "Both",
}

/** @typedef {(typeof VIDEO_OVERLAY_MODES)[keyof typeof VIDEO_OVERLAY_MODES]} VideoOverlayMode */
