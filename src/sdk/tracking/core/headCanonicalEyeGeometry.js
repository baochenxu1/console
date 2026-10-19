/**
 * Head-Canonical Eye Geometry — Gaze V2.6
 *
 * Landmarks (478):
 *   x — normalized image horizontal [0, 1] (origin top-left, +x right)
 *   y — normalized image vertical   [0, 1] (origin top-left, +y down)
 *   z — depth relative to head centroid; SAME scale unit as x (i.e. multiply by image width)
 *
 * facialTransformationMatrix:
 *   4×4 column-major (see canonicalObservation.normalizeObservationMatrix — no transpose)
 *   col0 = head RIGHT axis in detection/camera space
 *   col1 = head UP axis
 *   col2 = head FORWARD axis (face normal)
 *   col3 = translation (mesh → detection); NOT used as gaze signal
 *   Convention: p_detection = M · p_canonical_mesh (MediaPipe docs)
 *   For relative vectors: p_head = R^T · p_camera_metric  (R orthogonal → inverse = transpose)
 *
 * browserTrackingNormalizer: preserves column-major matrix; inference flip is pixel-level only.
 * trackingSemanticCore: passes matrix through observation unchanged to gaze V2.
 */

/** Gaze-relevant landmark indices (mirrors GAZE_V2_LANDMARKS — no import to avoid cycles). */
const GAZE_EYE_LM = Object.freeze({
  left: Object.freeze({ outer: 33, inner: 133, upper: 159, lower: 145, iris: [468, 469, 470, 471, 472] }),
  right: Object.freeze({ outer: 263, inner: 362, upper: 386, lower: 374, iris: [473, 474, 475, 476, 477] }),
  faceMid: 168,
})

/** Default inference size when video dimensions unknown (relative geometry still valid). */
export const DEFAULT_INFERENCE_WIDTH = 640
export const DEFAULT_INFERENCE_HEIGHT = 480

function numOr(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

function scale(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s]
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function norm(a) {
  return Math.sqrt(Math.max(1e-20, dot(a, a)))
}

function normalize(a) {
  const n = norm(a)
  if (n < 1e-9) return null
  return scale(a, 1 / n)
}

function getPoint3(landmarks, index) {
  if (!Array.isArray(landmarks) || index < 0 || index >= landmarks.length) return null
  const p = landmarks[index]
  if (p == null) return null
  let x
  let y
  let z = 0
  if (typeof p === "object" && !Array.isArray(p)) {
    x = p.x
    y = p.y
    z = p.z
  } else if (Array.isArray(p) && p.length >= 2) {
    x = p[0]
    y = p[1]
    z = p[2]
  }
  const xf = Number(x)
  const yf = Number(y)
  const zf = Number(z)
  if (!Number.isFinite(xf) || !Number.isFinite(yf)) return null
  return [xf, yf, Number.isFinite(zf) ? zf : 0]
}

function averagePoints(points) {
  const valid = points.filter(Boolean)
  if (!valid.length) return null
  const n = valid.length
  return [
    valid.reduce((s, p) => s + p[0], 0) / n,
    valid.reduce((s, p) => s + p[1], 0) / n,
    valid.reduce((s, p) => s + p[2], 0) / n,
  ]
}

/**
 * Normalized landmark → metric camera-like units (consistent x/y/z scale).
 * @param {[number,number,number]} p normalized x,y,z
 * @param {number} imageWidth
 * @param {number} imageHeight
 */
export function landmarkNormalizedToMetricCamera(p, imageWidth, imageHeight) {
  const w = Math.max(1, numOr(imageWidth, DEFAULT_INFERENCE_WIDTH))
  const h = Math.max(1, numOr(imageHeight, DEFAULT_INFERENCE_HEIGHT))
  return [p[0] * w, p[1] * h, p[2] * w]
}

/**
 * @param {object|null} facialMatrix canonical column-major matrix
 * @returns {{ right:[number,number,number], up:[number,number,number], forward:[number,number,number], valid:boolean, translation:[number,number,number]|null }|null}
 */
export function extractHeadRotationFromFacialMatrix(facialMatrix) {
  const values =
    facialMatrix?.values || facialMatrix?.data || (Array.isArray(facialMatrix) ? facialMatrix : null)
  if (!values || values.length < 16) return null
  const right = normalize([Number(values[0]), Number(values[1]), Number(values[2])])
  const up = normalize([Number(values[4]), Number(values[5]), Number(values[6])])
  const forward = normalize([Number(values[8]), Number(values[9]), Number(values[10])])
  if (!right || !up || !forward) return null
  if (norm(right) < 0.5 || Math.abs(dot(right, up)) > 0.95) return null
  const translation = [
    Number(values[12]) || 0,
    Number(values[13]) || 0,
    Number(values[14]) || 0,
  ]
  return { right, up, forward, valid: true, translation }
}

/**
 * Apply inverse head rotation to a metric relative vector: p_head = R^T · p_cam.
 * R columns = head axes expressed in camera space → projection via dot products.
 */
export function applyInverseHeadRotation(relativeCameraMetric, rotation) {
  const p = relativeCameraMetric
  return [
    dot(p, rotation.right),
    dot(p, rotation.up),
    dot(p, rotation.forward),
  ]
}

/**
 * Resolve stable face origin in metric camera space (nose bridge / face mid).
 */
export function resolveFaceOriginMetric(landmarks, imageWidth, imageHeight) {
  const mid =
    getPoint3(landmarks, GAZE_EYE_LM.faceMid) || getPoint3(landmarks, 1)
  if (!mid) return null
  return landmarkNormalizedToMetricCamera(mid, imageWidth, imageHeight)
}

/**
 * Full pipeline: normalized landmark → head-canonical metric point (relative to face origin).
 */
export function landmarkToHeadCanonical(
  landmarks,
  index,
  facialMatrix,
  imageWidth,
  imageHeight,
  originMetric = null
) {
  const p = getPoint3(landmarks, index)
  if (!p) return null
  const origin =
    originMetric || resolveFaceOriginMetric(landmarks, imageWidth, imageHeight)
  if (!origin) return null
  const cam = landmarkNormalizedToMetricCamera(p, imageWidth, imageHeight)
  const rel = sub(cam, origin)
  const rot = extractHeadRotationFromFacialMatrix(facialMatrix)
  if (!rot?.valid) return null
  return {
    cameraMetric: cam,
    head: applyInverseHeadRotation(rel, rot),
    relativeCamera: rel,
  }
}

/**
 * Legacy camera-space eye gaze (pre-V2.6 stable-plane) for leakage diagnostics.
 */
export function computeLegacyCameraSpaceEyeGaze(landmarks, side, faceNormal = null) {
  const idx = side === "right" ? GAZE_EYE_LM.right : GAZE_EYE_LM.left
  const outer = getPoint3(landmarks, idx.outer)
  const inner = getPoint3(landmarks, idx.inner)
  const irisPts = idx.iris.map((i) => getPoint3(landmarks, i))
  const irisCenter = averagePoints(irisPts)
  if (!outer || !inner || !irisCenter) return null
  const eyeCenter = scale(add(outer, inner), 0.5)
  const horizRaw = sub(inner, outer)
  const eyeWidth = norm(horizRaw)
  if (eyeWidth < 1e-6) return null
  let horizontalAxis = normalize(horizRaw)
  let verticalAxis = faceNormal ? normalize(cross(faceNormal, horizontalAxis)) : null
  if (!verticalAxis) verticalAxis = normalize([-horizontalAxis[1], horizontalAxis[0], 0])
  if (!verticalAxis) return null
  const imageUp = [0, -1, 0]
  if (dot(verticalAxis, imageUp) < 0) verticalAxis = scale(verticalAxis, -1)
  const delta = sub(irisCenter, eyeCenter)
  const nx = dot(delta, horizontalAxis) / eyeWidth
  const ny = dot(delta, verticalAxis) / eyeWidth
  const lookRightX = side === "right" ? -nx : nx
  return { normalizedX: lookRightX, normalizedY: ny, eyeWidth }
}

/**
 * Compute per-eye gaze in head-canonical 3D space.
 *
 * @returns {object|null}
 */
export function computeHeadCanonicalEyeGaze({
  landmarks,
  side,
  facialMatrix,
  imageWidth = DEFAULT_INFERENCE_WIDTH,
  imageHeight = DEFAULT_INFERENCE_HEIGHT,
  minEyeWidth = 0.003,
}) {
  const idx = side === "right" ? GAZE_EYE_LM.right : GAZE_EYE_LM.left
  const rot = extractHeadRotationFromFacialMatrix(facialMatrix)
  if (!rot?.valid) {
    return { available: false, reason: "matrix_invalid" }
  }

  const origin = resolveFaceOriginMetric(landmarks, imageWidth, imageHeight)
  if (!origin) return { available: false, reason: "origin_missing" }

  const outerN = getPoint3(landmarks, idx.outer)
  const innerN = getPoint3(landmarks, idx.inner)
  const upperN = getPoint3(landmarks, idx.upper)
  const lowerN = getPoint3(landmarks, idx.lower)
  const irisPtsN = idx.iris.map((i) => getPoint3(landmarks, i)).filter(Boolean)
  const irisCenterN = averagePoints(irisPtsN)
  if (!outerN || !innerN || !irisCenterN || irisPtsN.length < 2) {
    return { available: false, reason: "landmarks_missing" }
  }

  const toHead = (pn) => {
    const cam = landmarkNormalizedToMetricCamera(pn, imageWidth, imageHeight)
    return applyInverseHeadRotation(sub(cam, origin), rot)
  }

  const outerH = toHead(outerN)
  const innerH = toHead(innerN)
  const irisH = toHead(irisCenterN)
  const centerH = scale(add(outerH, innerH), 0.5)

  const horizRaw = sub(innerH, outerH)
  const eyeWidth = norm(horizRaw)
  if (eyeWidth < minEyeWidth * Math.max(imageWidth, 1)) {
    return { available: false, reason: "eye_too_small", eyeWidth }
  }

  const horizH = normalize(horizRaw)
  if (!horizH) return { available: false, reason: "degenerate_horizontal" }

  // Stable vertical in head XY plane (+headUp = LOOK_UP).
  let vertH = normalize([-horizH[1], horizH[0], 0])
  if (!vertH) vertH = [0, 1, 0]
  if (vertH[1] < 0) vertH = scale(vertH, -1)

  const deltaH = sub(irisH, centerH)
  const localX = dot(deltaH, horizH)
  const localY = dot(deltaH, vertH)
  const rawNormX = localX / eyeWidth
  const rawNormY = localY / eyeWidth
  // Per-eye frame uses outer→inner; mirror right eye for binocular look-right = +X.
  const canonicalX = side === "right" ? -rawNormX : rawNormX
  const canonicalY = rawNormY

  // Openness (metric head space, diagnostic only)
  let eyeOpennessRaw = 0.35
  let eyeHeight = eyeWidth * 0.35
  if (upperN && lowerN) {
    const upperH = toHead(upperN)
    const lowerH = toHead(lowerN)
    const lidDist = norm(sub(upperH, lowerH))
    eyeHeight = Math.max(lidDist, eyeWidth * 0.12)
    eyeOpennessRaw = lidDist / Math.max(eyeWidth, 1e-6)
  }

  const irisCamera = landmarkNormalizedToMetricCamera(irisCenterN, imageWidth, imageHeight)

  return {
    available: true,
    geometryMode: "head-canonical-3d",
    side,
    eyeWidth: eyeWidth / Math.max(imageWidth, 1),
    eyeWidthMetric: eyeWidth,
    eyeHeight: eyeHeight / Math.max(imageWidth, 1),
    eyeOpenness: eyeHeight / Math.max(eyeWidth, 1e-6),
    eyeOpennessRaw,
    irisValidCount: irisPtsN.length,
    localX,
    localY,
    normalizedX: canonicalX,
    normalizedY: canonicalY,
    canonicalX,
    canonicalY,
    rawNormX,
    rawNormY,
    irisCamera,
    irisHead: irisH,
    outerHead: outerH,
    innerHead: innerH,
    centerHead: centerH,
    headRight: rot.right,
    headUp: rot.up,
    headForward: rot.forward,
    rotationMatrix: {
      right: rot.right,
      up: rot.up,
      forward: rot.forward,
    },
    originMetric: origin,
    imageWidth,
    imageHeight,
  }
}

/**
 * Build head-canonical context shared by both eyes (matrix validity, pose diagnostics).
 */
export function resolveHeadCanonicalContext(landmarks, facialMatrix, imageWidth, imageHeight) {
  const rot = extractHeadRotationFromFacialMatrix(facialMatrix)
  const available = Boolean(rot?.valid)
  let headYawUsed = null
  let headPitchUsed = null
  let headRollUsed = null
  if (rot?.valid) {
    const roll = (Math.atan2(rot.right[1], rot.right[0]) * 180) / Math.PI
    const pitch =
      (Math.atan2(-rot.forward[1], Math.hypot(rot.forward[0], rot.forward[2])) * 180) / Math.PI
    const yaw = (Math.atan2(rot.forward[0], -rot.forward[2] || 1e-9) * 180) / Math.PI
    headYawUsed = Number.isFinite(yaw) ? yaw : null
    headPitchUsed = Number.isFinite(pitch) ? pitch : null
    headRollUsed = Number.isFinite(roll) ? roll : null
  }
  return {
    available,
    matrixValid: available,
    headCompensationMode: available ? "head-canonical-3d" : "eye-local-stable-plane",
    headRotationValid: available,
    headYawUsed,
    headPitchUsed,
    headRollUsed,
    headRight: rot?.right ?? null,
    headUp: rot?.up ?? null,
    headForward: rot?.forward ?? null,
    rotationMatrix: rot
      ? { right: rot.right, up: rot.up, forward: rot.forward }
      : null,
    imageWidth: numOr(imageWidth, DEFAULT_INFERENCE_WIDTH),
    imageHeight: numOr(imageHeight, DEFAULT_INFERENCE_HEIGHT),
  }
}
