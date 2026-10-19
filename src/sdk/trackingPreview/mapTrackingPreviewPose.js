import { mapFaceRigToPose, rigValuesFromEliteRig } from "../../core/faceDofMapper.js"
import { normalizeFaceRigProfile } from "../../core/faceRigProfile.js"

/**
 * 轻量映射：仅 mapFaceRigToPose（Device Drive 热路径，不做 binding 诊断扫描）。
 */
export function mapTrackingPreviewPose({
  profile,
  rig,
  configs = [],
  mapFaceRigToPoseOptions,
} = {}) {
  const profileN = normalizeFaceRigProfile(profile || {})
  const rigValues = rigValuesFromEliteRig(rig)
  return mapFaceRigToPose(rigValues, profileN, configs, mapFaceRigToPoseOptions)
}
