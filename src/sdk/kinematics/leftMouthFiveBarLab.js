import { getMouthCornerLabSide } from "./mouthCornerFiveBarLabConfig.js"
import {
  buildLabKinematicsOverrideForSide,
  buildMouthFiveBarSendPreview,
  buildMouthRuntimeSnapshot,
  createDefaultMouthLabCalibration,
  loadMouthLabCalibration,
  sendMouthFiveBarPreview,
} from "./mouthCornerFiveBarLab.js"

const side = getMouthCornerLabSide("left")

export const LEFT_MOUTH_CALIB_STORAGE_KEY = side.calibStorageKey
export const LAB_HW_SERVO_A = side.labHwServoA
export const LAB_HW_SERVO_B = side.labHwServoB

export const createDefaultLeftMouthLabCalibration = () => createDefaultMouthLabCalibration("left")
export const loadLeftMouthLabCalibration = (raw) => loadMouthLabCalibration("left", raw)
export const sendLeftMouthFiveBarPreview = sendMouthFiveBarPreview
export const buildLeftMouthFiveBarSendPreview = (args) =>
  buildMouthFiveBarSendPreview({ sideId: "left", ...args })
export const buildLeftMouthRuntimeSnapshot = (profile, calibration, pad) =>
  buildMouthRuntimeSnapshot(profile, "left", calibration, pad)

export function buildLeftLabKinematicsOverride(calibration, outputModeOverride) {
  return buildLabKinematicsOverrideForSide("left", calibration, outputModeOverride)
}
