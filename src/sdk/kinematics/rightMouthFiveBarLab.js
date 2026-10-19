import { getMouthCornerLabSide } from "./mouthCornerFiveBarLabConfig.js"
import {
  buildLabKinematicsOverrideForSide,
  buildMouthFiveBarSendPreview,
  buildMouthRuntimeSnapshot,
  createDefaultMouthLabCalibration,
  loadMouthLabCalibration,
  sendMouthFiveBarPreview,
} from "./mouthCornerFiveBarLab.js"

const side = getMouthCornerLabSide("right")

export const RIGHT_MOUTH_CALIB_STORAGE_KEY = side.calibStorageKey
export const LAB_HW_SERVO_A = side.labHwServoA
export const LAB_HW_SERVO_B = side.labHwServoB

export const createDefaultRightMouthLabCalibration = () => createDefaultMouthLabCalibration("right")
export const loadRightMouthLabCalibration = (raw) => loadMouthLabCalibration("right", raw)
export const sendRightMouthFiveBarPreview = sendMouthFiveBarPreview
export const buildRightMouthFiveBarSendPreview = (args) =>
  buildMouthFiveBarSendPreview({ sideId: "right", ...args })
export const buildRightMouthRuntimeSnapshot = (profile, calibration, pad) =>
  buildMouthRuntimeSnapshot(profile, "right", calibration, pad)

export function buildLabKinematicsOverride(calibration, outputModeOverride) {
  return buildLabKinematicsOverrideForSide("right", calibration, outputModeOverride)
}
