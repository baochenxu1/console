import { createInitialEliteRig } from "../../core/faceDofMapper.js"

/** @typedef {import("./buildTrackingDryRunResult.js")} DryRunResult */

export const EMPTY_DRY_RUN_RESULT = {
  logicalPose: {},
  actualPose: {},
  commandPreview: "",
  warnings: [],
  diagnostics: null,
}

/**
 * Stop 后 HUD / 状态条中性值（不写串口）。
 */
export function createNeutralTrackingStatus() {
  return {
    source: "none",
    running: false,
    faceDetected: false,
    quality: 0,
    fps: 0,
    pythonFps: null,
    rxFps: 0,
    rx: 0,
    error: "",
    lastAt: null,
    wsConnecting: false,
    wsOpen: false,
  }
}

/**
 * UI 回中：清空帧、重置 Rig、状态与 Dry Run 预览。
 * @param {object} deps
 * @param {() => void} deps.clearLastFrame
 * @param {React.Dispatch<React.SetStateAction<import("../../tracking/trackingTypes.js").RigFrame | null>>} [deps.setLastFrame]
 * @param {React.MutableRefObject<import("../../tracking/trackingTypes.js").RigFrame | null>} [deps.prevCalibratedRef]
 */
export function resetTrackingPreviewToNeutral(deps = {}) {
  const { clearLastFrame, setLastFrame, prevCalibratedRef } = deps

  if (typeof clearLastFrame === "function") {
    clearLastFrame()
  } else if (typeof setLastFrame === "function") {
    setLastFrame(null)
  }

  if (prevCalibratedRef) {
    prevCalibratedRef.current = null
  }

  return {
    previewRig: createInitialEliteRig(),
    trackingStatus: createNeutralTrackingStatus(),
    dryRunResult: { ...EMPTY_DRY_RUN_RESULT },
  }
}
