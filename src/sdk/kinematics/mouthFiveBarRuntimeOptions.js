import { getLeftMouthFiveBarRuntime } from "./leftMouthFiveBarRuntime.js"
import { getRightMouthFiveBarRuntime } from "./rightMouthFiveBarRuntime.js"
import {
  resolveMouthCornerPadFlipFlags,
  resolveMouthCornerPadRotateCcwDeg,
} from "./mouthCornerFivebar.js"

function mouthRuntimeKinematicsSlice(rt, sideId) {
  const flip = resolveMouthCornerPadFlipFlags(rt.params, sideId)
  const padRotateCcwDeg = resolveMouthCornerPadRotateCcwDeg(rt.params, sideId)
  const sidePrefix = sideId === "left" ? "leftMouthCorner" : "rightMouthCorner"
  return {
    enabled: rt.enabled,
    runtimeOutputMode: rt.runtime.outputMode,
    ...rt.params,
    flipPadX: flip.flipPadX,
    flipPadY: flip.flipPadY,
    padRotateCcwDeg,
    [`${sidePrefix}PadFlipX`]: flip.flipPadX,
    [`${sidePrefix}PadFlipY`]: flip.flipPadY,
    [`${sidePrefix}PadRotateCcwDeg`]: padRotateCcwDeg,
  }
}

/**
 * @param {{ rightState: import("./mouthCornerFivebar.js").RightMouthFivebarState, leftState: import("./mouthCornerFivebar.js").RightMouthFivebarState }} states
 */
export function buildMapFaceRigToPoseOptionsFromMouthRuntimes({ rightState, leftState }) {
  const rightRt = getRightMouthFiveBarRuntime()
  const leftRt = getLeftMouthFiveBarRuntime()
  return {
    rightMouthCornerFivebarState: rightState,
    leftMouthCornerFivebarState: leftState,
    rightMouthRuntime: rightRt,
    leftMouthRuntime: leftRt,
    mouthFiveBarRuntimes: {
      right: rightRt,
      left: leftRt,
    },
    mouthFiveBarStates: {
      right: rightState,
      left: leftState,
    },
    kinematics: {
      rightMouthCornerFiveBar: mouthRuntimeKinematicsSlice(rightRt, "right"),
      leftMouthCornerFiveBar: mouthRuntimeKinematicsSlice(leftRt, "left"),
    },
  }
}

/**
 * @param {import("./mouthCornerFivebar.js").RightMouthFivebarState} fiveBarState
 */
export function buildMapFaceRigToPoseOptionsFromRuntime(fiveBarState) {
  return buildMapFaceRigToPoseOptionsFromMouthRuntimes({
    rightState: fiveBarState,
    leftState: fiveBarState,
  })
}
