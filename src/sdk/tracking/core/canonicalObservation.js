/**
 * Canonical MediaPipe Observation — Browser / Python Provider 统一观测契约。
 * 下游 Shared Semantic Core 不得根据 source 改变 Rig 数学。
 */

export const CANONICAL_OBSERVATION_VERSION = 1

export const FORMAL_BLENDSHAPE_KEYS = Object.freeze([
  "jawOpen",
  "eyeBlinkLeft",
  "eyeBlinkRight",
  "eyeWideLeft",
  "eyeWideRight",
  "mouthSmileLeft",
  "mouthSmileRight",
  "mouthUpperUpLeft",
  "mouthUpperUpRight",
  "mouthLowerDownLeft",
  "mouthLowerDownRight",
  "mouthPucker",
  "mouthFunnel",
  "mouthClose",
  "mouthOpen",
  "browInnerUp",
  "browOuterUpLeft",
  "browOuterUpRight",
  "eyeLookInLeft",
  "eyeLookOutLeft",
  "eyeLookUpLeft",
  "eyeLookDownLeft",
  "eyeLookInRight",
  "eyeLookOutRight",
  "eyeLookUpRight",
  "eyeLookDownRight",
])

/**
 * @typedef {object} CanonicalLandmark
 * @property {number} x
 * @property {number} y
 * @property {number} [z]
 */

/**
 * @typedef {object} CanonicalFacialMatrix
 * @property {"column-major"} layout
 * @property {4} rows
 * @property {4} cols
 * @property {number[]} values length 16
 */

/**
 * @typedef {object} CanonicalMediaPipeObservation
 * @property {number} version
 * @property {number} timestampMs
 * @property {number} frameId
 * @property {boolean} faceDetected
 * @property {CanonicalLandmark[]} landmarks  MediaPipe order, typically 478
 * @property {Record<string, number>} blendshapes
 * @property {CanonicalFacialMatrix|null} facialTransformationMatrix
 * @property {number|null} [faceDetectionConfidence]
 * @property {number|null} [facePresenceConfidence]
 * @property {number|null} [trackingConfidence]
 * @property {"browser"|"python"|string} source  debug only; must not change Rig math
 */

/**
 * @returns {CanonicalMediaPipeObservation}
 */
export function createEmptyObservation(overrides = {}) {
  return {
    version: CANONICAL_OBSERVATION_VERSION,
    timestampMs: 0,
    frameId: 0,
    faceDetected: false,
    landmarks: [],
    blendshapes: {},
    facialTransformationMatrix: null,
    faceDetectionConfidence: null,
    facePresenceConfidence: null,
    trackingConfidence: null,
    source: "browser",
    ...overrides,
  }
}

/**
 * @param {Array<{x?:number,y?:number,z?:number}>|null|undefined} landmarks
 * @returns {CanonicalLandmark[]}
 */
export function normalizeObservationLandmarks(landmarks) {
  if (!Array.isArray(landmarks)) return []
  return landmarks.map((p, i) => ({
    i,
    x: Number(p?.x) || 0,
    y: Number(p?.y) || 0,
    z: Number.isFinite(Number(p?.z)) ? Number(p.z) : 0,
  }))
}

/**
 * @param {Array<{categoryName?:string,score?:number}>|Record<string,number>|null|undefined} categories
 */
export function normalizeObservationBlendshapes(categories) {
  const out = {}
  for (const key of FORMAL_BLENDSHAPE_KEYS) {
    out[key] = 0
  }
  if (!categories) return out
  if (Array.isArray(categories)) {
    for (const item of categories) {
      const name = String(item?.categoryName || item?.displayName || "").trim()
      const score = Number(item?.score)
      if (!name || !Number.isFinite(score)) continue
      out[name] = score
    }
    return out
  }
  if (typeof categories === "object") {
    for (const [k, v] of Object.entries(categories)) {
      const score = Number(v)
      if (Number.isFinite(score)) out[k] = score
    }
  }
  return out
}

/**
 * @param {Array<{categoryName?:string,displayName?:string,score?:number,index?:number}>|Record<string,number>|null|undefined} categories
 * @returns {{
 *   blendshapes: Record<string, number>,
 *   unknownBlendshapeKeys: string[],
 *   missingExpectedBlendshapeKeys: string[],
 *   rawCategoryCount: number,
 *   usedCategoryName: boolean,
 * }}
 */
export function analyzeObservationBlendshapes(categories) {
  const blendshapes = normalizeObservationBlendshapes(categories)
  const formalSet = new Set(FORMAL_BLENDSHAPE_KEYS)
  const seen = new Set()
  let rawCategoryCount = 0
  let usedCategoryName = false
  const unknownBlendshapeKeys = []

  if (Array.isArray(categories)) {
    for (const item of categories) {
      rawCategoryCount += 1
      const name = String(item?.categoryName || item?.displayName || "").trim()
      if (!name) continue
      usedCategoryName = true
      seen.add(name)
      if (!formalSet.has(name)) {
        unknownBlendshapeKeys.push(name)
      }
    }
  } else if (categories && typeof categories === "object") {
    for (const k of Object.keys(categories)) {
      rawCategoryCount += 1
      usedCategoryName = true
      seen.add(k)
      if (!formalSet.has(k)) unknownBlendshapeKeys.push(k)
    }
  }

  const missingExpectedBlendshapeKeys = FORMAL_BLENDSHAPE_KEYS.filter((k) => !seen.has(k))
  return {
    blendshapes,
    unknownBlendshapeKeys,
    missingExpectedBlendshapeKeys,
    rawCategoryCount,
    usedCategoryName,
  }
}

/**
 * MediaPipe Web matrix is column-major 4x4. Keep layout explicit; do not transpose.
 */
export function normalizeObservationMatrix(matrix) {
  if (!matrix) return null
  const data = Array.isArray(matrix)
    ? matrix
    : matrix instanceof Float32Array
      ? Array.from(matrix)
      : Array.isArray(matrix?.data)
        ? matrix.data
        : matrix?.data instanceof Float32Array
          ? Array.from(matrix.data)
          : null
  if (!data || data.length < 16) return null
  return {
    layout: "column-major",
    rows: 4,
    cols: 4,
    values: data.slice(0, 16).map((n) => Number(n) || 0),
  }
}

/**
 * Worker/Browser MediaPipe serialized result → Canonical Observation.
 */
export function mediaPipeResultToCanonicalObservation(mpResult, meta = {}) {
  const faceLandmarks = Array.isArray(mpResult?.faceLandmarks) ? mpResult.faceLandmarks : []
  const firstFace = faceLandmarks[0] || null
  const faceDetected = Array.isArray(firstFace) && firstFace.length > 0
  const classifications =
    mpResult?.faceBlendshapes?.[0]?.categories || mpResult?.faceBlendshapes?.[0] || []
  const matrixRaw =
    mpResult?.facialTransformationMatrixes?.[0] ??
    mpResult?.facialTransformationMatrices?.[0] ??
    null

  return createEmptyObservation({
    timestampMs: Number(meta.timestampMs) || 0,
    frameId: Number(meta.frameId ?? meta.frameSeq) || 0,
    faceDetected,
    landmarks: faceDetected ? normalizeObservationLandmarks(firstFace) : [],
    blendshapes: normalizeObservationBlendshapes(classifications),
    facialTransformationMatrix: normalizeObservationMatrix(matrixRaw),
    inferenceWidth: meta.videoWidth != null ? Number(meta.videoWidth) : meta.inferenceWidth ?? null,
    inferenceHeight: meta.videoHeight != null ? Number(meta.videoHeight) : meta.inferenceHeight ?? null,
    videoWidth: meta.videoWidth != null ? Number(meta.videoWidth) : null,
    videoHeight: meta.videoHeight != null ? Number(meta.videoHeight) : null,
    faceDetectionConfidence:
      meta.faceDetectionConfidence != null ? Number(meta.faceDetectionConfidence) : null,
    facePresenceConfidence:
      meta.facePresenceConfidence != null ? Number(meta.facePresenceConfidence) : null,
    trackingConfidence: meta.trackingConfidence != null ? Number(meta.trackingConfidence) : null,
    source: meta.source || "browser",
  })
}
