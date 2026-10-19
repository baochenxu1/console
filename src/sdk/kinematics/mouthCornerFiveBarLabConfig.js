/** @typedef {"right" | "left"} MouthCornerLabSideId */

import { MOUTH_CORNER_FROZEN_VERSION } from "./mouthCornerFrozenConfig.js"

export { MOUTH_CORNER_FROZEN_VERSION }

/**
 * Kinematics Lab 左右嘴角机构配置（复用同一套 FiveBar FK/IK，镜像由符号参数完成）。
 * 全站嘴角语义冻结点 — 修改后请 bump mouthCornerFrozenConfig.FROZEN_VERSION。
 */
export const MOUTH_CORNER_LAB_SIDES = {
  right: {
    id: /** @type {const} */ ("right"),
    mechanismId: "rightMouthFiveBar",
    label: "Right Mouth",
    controlId: "mouth_corner_r",
    rigSideKey: "sideR",
    rigValuesKey: "mouth_corner_r",
    profileBindingPrefix: "mouth_corner_r",
    calibStorageKey: "facedev.rightMouthFivebar.calibration.v1",
    baselineStorageKey: "facedev.rightMouthFivebar.runtimeBaseline.v1",
    baselineChangedEvent: "facedev:rightMouthFivebarBaselineChanged",
    mediaPipeDriveKey: "mediaPipeRightMouthDriveEnabled",
    diagnosticsSource: "rightMouthFiveBar",
    labHwServoA: 7,
    labHwServoB: 8,
    defaultCalibration: {
      Kx: 7,
      Ky: 7,
      xSign: 1,
      ySign: 1,
      qSignA: 1,
      qSignB: 1,
      qGainA: 1,
      qGainB: 1,
      servoSwap: false,
      flipPadX: false,
      flipPadY: false,
      /** Pad 在 flip 之后再绕中心逆时针旋转（度，90 的倍数） */
      padRotateCcwDeg: 0,
      neutralPwmA: 2009,
      neutralPwmB: 1618,
    },
  },
  left: {
    id: /** @type {const} */ ("left"),
    mechanismId: "leftMouthFiveBar",
    label: "Left Mouth",
    controlId: "mouth_corner_l",
    rigSideKey: "sideL",
    rigValuesKey: "mouth_corner_l",
    profileBindingPrefix: "mouth_corner_l",
    calibStorageKey: "facedev.leftMouthFivebar.calibration.v1",
    baselineStorageKey: "facedev.leftMouthFivebar.runtimeBaseline.v1",
    baselineChangedEvent: "facedev:leftMouthFivebarBaselineChanged",
    mediaPipeDriveKey: "mediaPipeLeftMouthDriveEnabled",
    diagnosticsSource: "leftMouthFiveBar",
    labHwServoA: 16,
    labHwServoB: 17,
    defaultCalibration: {
      Kx: 7,
      Ky: 7,
      /**
       * flipX + 逆时针 90° 后：UI 上下→effectiveX(xSign)，UI 左右→effectiveY(ySign)。
       * 上下对、左右反 → 只改 ySign。
       */
      xSign: 1,
      ySign: -1,
      qSignA: 1,
      qSignB: 1,
      qGainA: 1,
      qGainB: 1,
      servoSwap: false,
      flipPadX: true,
      flipPadY: false,
      padRotateCcwDeg: 90,
      neutralPwmA: null,
      neutralPwmB: null,
    },
  },
}

/** @param {MouthCornerLabSideId | string} sideId */
export function getMouthCornerLabSide(sideId) {
  return MOUTH_CORNER_LAB_SIDES[sideId] || MOUTH_CORNER_LAB_SIDES.right
}
