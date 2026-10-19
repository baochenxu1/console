/**
 * MediaPipe Web FaceLandmarker result → FaceDEV Tracking 正式契约（tracking.rigFrame）。
 */

import { TRACKING_FRAME_TYPE } from "../trackingTypes.js"
import {
  analyzeObservationBlendshapes,
  mediaPipeResultToCanonicalObservation,
  normalizeObservationBlendshapes,
  normalizeObservationLandmarks,
  normalizeObservationMatrix,
} from "../core/canonicalObservation.js"
import { createTrackingSemanticRuntime } from "../core/trackingSemanticCore.js"
import { CAMERA_COORDINATE_CONVENTION } from "./browserCameraCoordinateConvention.js"

const fallbackSemanticRuntime = createTrackingSemanticRuntime()

const LIVE_SAMPLE_BLEND_KEYS = Object.freeze([
  "eyeBlinkLeft",
  "eyeBlinkRight",
  "browOuterUpLeft",
  "browOuterUpRight",
  "mouthSmileLeft",
  "mouthSmileRight",
  "jawOpen",
])

/**
 * @param {Array<{ categoryName?: string, score?: number }>|Record<string, number>|null|undefined} categories
 * @returns {Record<string, number>}
 */
export function normalizeBlendshapeCategories(categories) {
  return normalizeObservationBlendshapes(categories)
}

/**
 * 保留完整 landmark index；不重排、不截断。
 * @param {Array<{ x?: number, y?: number, z?: number }>|null|undefined} landmarks
 */
export function normalizeFaceLandmarks(landmarks) {
  return normalizeObservationLandmarks(landmarks)
}

/**
 * MediaPipe Web facialTransformationMatrixes 为 4x4 column-major Float32Array / number[]。
 * 输出与 Python 未序列化矩阵时约定一致：保留 column-major 一维 16 元数组，并标注 layout。
 * 禁止凭感觉转置。
 *
 * @param {Float32Array|number[]|{ data?: Float32Array|number[] }|null|undefined} matrix
 */
export function normalizeFacialTransformationMatrix(matrix) {
  return normalizeObservationMatrix(matrix)
}

/**
 * 从 raw MediaPipe categories 构建开发态 live sample（不含图像像素）。
 */
export function buildBrowserLiveObservationSample(mpResult, meta = {}) {
  const categories =
    mpResult?.faceBlendshapes?.[0]?.categories || mpResult?.faceBlendshapes?.[0] || []
  const analysis = analyzeObservationBlendshapes(categories)
  const landmarks0 = Array.isArray(mpResult?.faceLandmarks?.[0]) ? mpResult.faceLandmarks[0] : []
  const matrix0 =
    mpResult?.facialTransformationMatrixes?.[0] ??
    mpResult?.facialTransformationMatrices?.[0] ??
    null

  const rawBlendPeek = Array.isArray(categories)
    ? categories.map((c) => ({
        index: c?.index,
        categoryName: c?.categoryName ?? c?.displayName ?? null,
        score: Number(c?.score) || 0,
      }))
    : []

  const keyScores = {}
  for (const k of LIVE_SAMPLE_BLEND_KEYS) {
    keyScores[k] = Number(analysis.blendshapes[k]) || 0
  }

  return {
    timestampMs: Number(meta.timestampMs) || 0,
    frameId: Number(meta.frameId ?? meta.frameSeq) || 0,
    videoWidth: meta.videoWidth ?? null,
    videoHeight: meta.videoHeight ?? null,
    previewCssMirror: Boolean(
      meta.previewCssMirror ?? CAMERA_COORDINATE_CONVENTION.browserPreviewCssMirror
    ),
    inferenceFlipHorizontal: Boolean(
      meta.inferenceFlipHorizontal ?? CAMERA_COORDINATE_CONVENTION.browserInferenceFlipHorizontal
    ),
    cameraCoordinateConvention: CAMERA_COORDINATE_CONVENTION.id,
    landmarkCount: landmarks0.length,
    landmarksHead: landmarks0.slice(0, 3).map((p, i) => ({
      i,
      x: Number(p?.x) || 0,
      y: Number(p?.y) || 0,
      z: Number.isFinite(Number(p?.z)) ? Number(p.z) : 0,
    })),
    blendshapeRawPeek: rawBlendPeek.slice(0, 16),
    blendshapeKeyScores: keyScores,
    unknownBlendshapeKeys: analysis.unknownBlendshapeKeys,
    missingExpectedBlendshapeKeys: analysis.missingExpectedBlendshapeKeys,
    rawCategoryCount: analysis.rawCategoryCount,
    usedCategoryName: analysis.usedCategoryName,
    facialTransformationMatrix0: normalizeObservationMatrix(matrix0),
  }
}

/**
 * @param {object} mpResult Worker/主线程序列化后的 MediaPipe 结果
 * @param {object} meta
 */
export function normalizeBrowserFaceLandmarkerResult(mpResult, meta = {}) {
  const captureTimestamp = Number(meta.captureTimestamp) || 0
  const inferenceStart = Number(meta.inferenceStart) || captureTimestamp
  const inferenceEnd = Number(meta.inferenceEnd) || inferenceStart
  const resultTimestamp =
    Number(meta.resultTimestamp) ||
    (typeof performance !== "undefined" ? performance.now() : Date.now())
  const frameSeq = Number(meta.frameSeq) || 0

  const categories =
    mpResult?.faceBlendshapes?.[0]?.categories || mpResult?.faceBlendshapes?.[0] || []
  const blendAnalysis = analyzeObservationBlendshapes(categories)

  const observation = mediaPipeResultToCanonicalObservation(mpResult, {
    timestampMs: captureTimestamp,
    frameId: frameSeq,
    source: "browser",
    faceDetectionConfidence: meta.faceDetectionConfidence,
    facePresenceConfidence: meta.facePresenceConfidence,
    trackingConfidence: meta.trackingConfidence,
  })
  const runtime = meta.semanticRuntime || fallbackSemanticRuntime
  const stateBefore = runtime.getState?.() || null
  const semantic = runtime.process(observation)
  const stateAfter = runtime.getState?.() || null
  const semanticEnd = typeof performance !== "undefined" ? performance.now() : Date.now()
  const captureToRigMs = Math.max(0, semanticEnd - captureTimestamp)

  const liveSample = buildBrowserLiveObservationSample(mpResult, {
    timestampMs: captureTimestamp,
    frameId: frameSeq,
    videoWidth: meta.videoWidth,
    videoHeight: meta.videoHeight,
    previewCssMirror: meta.previewCssMirror,
    inferenceFlipHorizontal: meta.inferenceFlipHorizontal,
  })

  const semanticPeek = {
    eyeL: semantic.rig?.eyeL ?? null,
    eyeR: semantic.rig?.eyeR ?? null,
    browL: semantic.rig?.browL ?? null,
    browR: semantic.rig?.browR ?? null,
    gaze: semantic.rig?.gaze ?? null,
    jaw: semantic.rig?.jaw ?? null,
    mouthCornerL: semantic.rig?.mouthCornerL ?? null,
    mouthCornerR: semantic.rig?.mouthCornerR ?? null,
    neutralReady: Boolean(stateAfter?.lip?.neutralReady && stateAfter?.jaw?.neutralReady),
    stateIdentityStable: stateBefore != null && stateBefore === stateAfter,
  }

  return {
    type: TRACKING_FRAME_TYPE,
    source: "mediapipe-web",
    timestampMs: captureTimestamp,
    frameSeq,
    serverSentAtMs: typeof Date !== "undefined" ? Date.now() : 0,
    faceDetected: observation.faceDetected,
    quality: semantic.quality,
    rig: semantic.rig,
    debug: {
      ...semantic.debug,
      canonicalObservation: observation,
      landmarks: observation.landmarks,
      landmarkCount: observation.landmarks.length,
      blendshapeDiagnostics: {
        unknownBlendshapeKeys: blendAnalysis.unknownBlendshapeKeys,
        missingExpectedBlendshapeKeys: blendAnalysis.missingExpectedBlendshapeKeys,
        rawCategoryCount: blendAnalysis.rawCategoryCount,
        usedCategoryName: blendAnalysis.usedCategoryName,
      },
      browserLiveSample: liveSample,
      browserSemanticPeek: semanticPeek,
      cameraCoordinateConvention: CAMERA_COORDINATE_CONVENTION,
      performance: {
        captureTimestamp,
        inferenceStart,
        inferenceEnd,
        resultTimestamp,
        inferenceMs: Math.max(0, inferenceEnd - inferenceStart),
        captureToResultMs: Math.max(0, resultTimestamp - captureTimestamp),
        semanticComputeMs: semantic.semanticComputeMs,
        captureToRigMs,
      },
      inputSource: meta.inputSource || { sourceType: "camera" },
    },
  }
}
