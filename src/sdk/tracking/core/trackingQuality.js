/**
 * estimate_tracking_quality — mediapipe_to_rig.py
 * Face present: 0.8~1.0, scaled by blendshape completeness.
 */

function blendshapeCount(blendshapes, confidences) {
  if (confidences && Number.isFinite(Number(confidences.blendshapeCount))) {
    return Math.max(0, Math.trunc(Number(confidences.blendshapeCount)))
  }
  if (!blendshapes) return 0
  if (Array.isArray(blendshapes)) {
    return blendshapes.filter((item) => {
      if (item == null) return false
      if (typeof item === "number") return Number.isFinite(item)
      return Number.isFinite(Number(item.score))
    }).length
  }
  if (typeof blendshapes === "object") {
    return Object.values(blendshapes).filter((v) => Number.isFinite(Number(v))).length
  }
  return 0
}

/**
 * @param {object} args
 * @param {boolean} [args.faceDetected]
 * @param {Array} [args.landmarks]
 * @param {Record<string, number>|Array} [args.blendshapes]
 * @param {{ blendshapeCount?: number }} [args.confidences]
 */
export function estimateTrackingQuality({
  faceDetected,
  landmarks,
  blendshapes,
  confidences,
} = {}) {
  const detected =
    faceDetected != null
      ? Boolean(faceDetected)
      : Array.isArray(landmarks) && landmarks.length > 0
  if (!detected) return 0
  const n = blendshapeCount(blendshapes, confidences)
  if (n >= 48) return 0.96
  if (n >= 35) return 0.93
  if (n >= 12) return 0.88
  if (n > 0) return 0.82
  return 0.8
}
