/**
 * Gaze V2.4 — Head-pose decoupling + unified head-local eye frame.
 *
 * V2.1: Stable Eye Plane + Gaze-Specific Reliability.
 * V2.2: disagreement is per-axis diagnostic / reliability arbitration.
 * V2.3: relative eye openness + true-closure hysteresis.
 * V2.4a: Face Rig Y polarity (+ = LOOK_UP), closure contract, directional Y map.
 * V2.4b: Canonical head-local eye coordinates (eliminate yaw/pitch/roll leakage)
 *        BEFORE neutral → arbitration → OneEuro → directional mapping.
 *
 * Face Rig contract (useFaceRigInteraction):
 *   sharedRadar.y > 50  ⇒ LOOK_UP  (UI dot moves up)
 *   sharedRadar.y < 50  ⇒ LOOK_DOWN
 */

import { clamp, clampPct, safeFloat } from "./trackingMath.js"
import { createOneEuroFilter2D } from "./oneEuroFilter.js"
import {
  computeHeadCanonicalEyeGaze,
  computeLegacyCameraSpaceEyeGaze,
  resolveHeadCanonicalContext,
  DEFAULT_INFERENCE_WIDTH,
  DEFAULT_INFERENCE_HEIGHT,
} from "./headCanonicalEyeGeometry.js"

/** @typedef {'eye-local-v2' | 'legacy'} GazeAlgorithmId */

export const GAZE_ALGORITHM_V2 = "eye-local-v2"
export const GAZE_ALGORITHM_LEGACY = "legacy"

export const GAZE_V2_LANDMARKS = Object.freeze({
  left: Object.freeze({
    outer: 33,
    inner: 133,
    upper: 159,
    lower: 145,
    iris: Object.freeze([468, 469, 470, 471, 472]),
  }),
  right: Object.freeze({
    outer: 263,
    inner: 362,
    upper: 386,
    lower: 374,
    iris: Object.freeze([473, 474, 475, 476, 477]),
  }),
  /** Stable face-plane anchors (not eyelids).*/
  faceMid: 168,
})

/**
 * Frozen V2 defaults — V2.1 must not retune these.
 * Only reliability / plane thresholds may be additive.
 */
export const DEFAULT_GAZE_V2_CONFIG = Object.freeze({
  enabled: true,
  prefer3D: true,
  maxRelativeZSpan: 2.5,
  neutralWarmupSamples: 24,
  neutralMaxWaitFrames: 60,
  horizontalGain: 55,
  verticalGain: 65,
  deadZoneX: 0.008,
  deadZoneY: 0.008,
  oneEuro: Object.freeze({
    minCutoff: 1.0,
    beta: 0.02,
    dCutoff: 1.0,
  }),
  binocularDisagreementThreshold: 0.12,
  /** Kept for backward compat / diagnostics; NOT used as gaze hold truth. */
  blinkEnterThreshold: 0.48,
  blinkReleaseThreshold: 0.38,
  minEyeWidth: 0.003,
  minEyeHeight: 0.0015,
  minLandmarkCount: 478,
  outputCenter: 50,
  /** V2.1: Y normalization denominator. */
  verticalScaleMode: "eyeWidth",
  /** Gaze-specific reliability hold (not expression blink). */
  reliabilityHoldThreshold: 0.22,
  eyeClosedOpennessRatio: 0.2,
  preferFacialMatrix: true,
  /**
   * V2.2: eye is "usable" for arbitration (dominant-eye selection).
   * Does not change hold threshold; disagreement never amplitude-suppresses.
   */
  usableReliabilityThreshold: 0.45,
  /**
   * V2.3: true-closure (relative openness + iris/geometry + temporal).
   * Absolute eyeClosedOpennessRatio kept for compat diagnostics only — not hold truth.
   */
  closureOpennessRatioEnter: 0.32,
  closureOpennessRatioHard: 0.18,
  closureOpennessRatioRelease: 0.45,
  closureEnterFrames: 3,
  closureReleaseFrames: 2,
  /**
   * V2.4: when trackingValid+irisValid, openness factor never below this.
   * Prevents vertical lid-narrow from weighted_fusion_low_reliability.
   */
  opennessReliabilityFloor: 0.65,
  /**
   * V2.4 directional vertical mapping (replaces verticalGain for eye-local-v2 output).
   * verticalGain kept for config/legacy compat — NOT applied to V2 Y output.
   * Calibrated from Browser EYE_VERTICAL real data (2026-09-01).
   */
  verticalUpFullScale: 0.075,
  verticalDownFullScale: 0.14,
  verticalOutputHalfRange: 40,
  /** V2.6: inference dimensions for landmark metric scaling (when video size unknown). */
  defaultImageWidth: 640,
  defaultImageHeight: 480,
})

export function normalizeGazeV2Config(config = {}) {
  const d = DEFAULT_GAZE_V2_CONFIG
  const src = config && typeof config === "object" ? config : {}
  const oe = { ...d.oneEuro, ...(src.oneEuro && typeof src.oneEuro === "object" ? src.oneEuro : {}) }
  return {
    ...d,
    ...src,
    oneEuro: {
      minCutoff: safeFloat(oe.minCutoff, d.oneEuro.minCutoff),
      beta: safeFloat(oe.beta, d.oneEuro.beta),
      dCutoff: safeFloat(oe.dCutoff, d.oneEuro.dCutoff),
    },
    prefer3D: src.prefer3D !== false,
    preferFacialMatrix: src.preferFacialMatrix !== false,
    neutralWarmupSamples: Math.max(4, Math.trunc(safeFloat(src.neutralWarmupSamples, d.neutralWarmupSamples))),
    neutralMaxWaitFrames: Math.max(8, Math.trunc(safeFloat(src.neutralMaxWaitFrames, d.neutralMaxWaitFrames))),
    horizontalGain: safeFloat(src.horizontalGain, d.horizontalGain),
    verticalGain: safeFloat(src.verticalGain, d.verticalGain),
    deadZoneX: Math.max(0, safeFloat(src.deadZoneX, d.deadZoneX)),
    deadZoneY: Math.max(0, safeFloat(src.deadZoneY, d.deadZoneY)),
    binocularDisagreementThreshold: Math.max(
      0.01,
      safeFloat(src.binocularDisagreementThreshold, d.binocularDisagreementThreshold)
    ),
    blinkEnterThreshold: safeFloat(src.blinkEnterThreshold, d.blinkEnterThreshold),
    blinkReleaseThreshold: safeFloat(src.blinkReleaseThreshold, d.blinkReleaseThreshold),
    minEyeWidth: Math.max(1e-6, safeFloat(src.minEyeWidth, d.minEyeWidth)),
    minEyeHeight: Math.max(1e-6, safeFloat(src.minEyeHeight, d.minEyeHeight)),
    maxRelativeZSpan: Math.max(0.1, safeFloat(src.maxRelativeZSpan, d.maxRelativeZSpan)),
    outputCenter: safeFloat(src.outputCenter, d.outputCenter),
    verticalScaleMode: src.verticalScaleMode === "neutralEyeHeight" ? "neutralEyeHeight" : "eyeWidth",
    reliabilityHoldThreshold: clamp(safeFloat(src.reliabilityHoldThreshold, d.reliabilityHoldThreshold), 0.05, 0.8),
    eyeClosedOpennessRatio: clamp(safeFloat(src.eyeClosedOpennessRatio, d.eyeClosedOpennessRatio), 0.05, 0.6),
    usableReliabilityThreshold: clamp(
      safeFloat(src.usableReliabilityThreshold, d.usableReliabilityThreshold),
      0.15,
      0.9
    ),
    closureOpennessRatioEnter: clamp(
      safeFloat(src.closureOpennessRatioEnter, d.closureOpennessRatioEnter),
      0.05,
      0.8
    ),
    closureOpennessRatioHard: clamp(
      safeFloat(src.closureOpennessRatioHard, d.closureOpennessRatioHard),
      0.05,
      0.6
    ),
    closureOpennessRatioRelease: clamp(
      safeFloat(src.closureOpennessRatioRelease, d.closureOpennessRatioRelease),
      0.1,
      1.0
    ),
    closureEnterFrames: Math.max(1, Math.trunc(safeFloat(src.closureEnterFrames, d.closureEnterFrames))),
    closureReleaseFrames: Math.max(1, Math.trunc(safeFloat(src.closureReleaseFrames, d.closureReleaseFrames))),
    opennessReliabilityFloor: clamp(
      safeFloat(src.opennessReliabilityFloor, d.opennessReliabilityFloor),
      0.2,
      0.95
    ),
    verticalUpFullScale: Math.max(1e-4, safeFloat(src.verticalUpFullScale, d.verticalUpFullScale)),
    verticalDownFullScale: Math.max(1e-4, safeFloat(src.verticalDownFullScale, d.verticalDownFullScale)),
    verticalOutputHalfRange: clamp(
      safeFloat(src.verticalOutputHalfRange, d.verticalOutputHalfRange),
      5,
      50
    ),
    defaultImageWidth: Math.max(1, safeFloat(src.defaultImageWidth, d.defaultImageWidth)),
    defaultImageHeight: Math.max(1, safeFloat(src.defaultImageHeight, d.defaultImageHeight)),
  }
}

/**
 * V2.2 per-axis binocular arbitration.
 * Disagreement is a consistency flag — never multiplies signal amplitude.
 * Both eyes usable → reliability-weighted fusion (diagnostic only if disagree).
 * One eye unusable → dominant reliable eye.
 */
export function arbitrateBinocularAxis({
  valueLeft,
  valueRight,
  relL,
  relR,
  disagreement,
  usableThreshold,
} = {}) {
  const rL = Math.max(0, safeFloat(relL, 0))
  const rR = Math.max(0, safeFloat(relR, 0))
  const usable = Math.max(0.15, safeFloat(usableThreshold, 0.45))
  const leftOk = rL >= usable
  const rightOk = rR >= usable
  const wSum = rL + rR
  const weighted =
    wSum > 1e-6 ? (rL * valueLeft + rR * valueRight) / wSum : null

  if (leftOk && rightOk && weighted != null) {
    return {
      value: weighted,
      leftWeight: rL,
      rightWeight: rR,
      arbitrationMode: disagreement ? "weighted_fusion_diagnostic" : "weighted_fusion",
    }
  }
  if (leftOk && !rightOk) {
    return {
      value: valueLeft,
      leftWeight: rL,
      rightWeight: rR,
      arbitrationMode: "dominant_left",
    }
  }
  if (rightOk && !leftOk) {
    return {
      value: valueRight,
      leftWeight: rL,
      rightWeight: rR,
      arbitrationMode: "dominant_right",
    }
  }
  if (weighted != null) {
    return {
      value: weighted,
      leftWeight: rL,
      rightWeight: rR,
      arbitrationMode: "weighted_fusion_low_reliability",
    }
  }
  if (Number.isFinite(valueLeft)) {
    return { value: valueLeft, leftWeight: rL, rightWeight: rR, arbitrationMode: "left_only" }
  }
  if (Number.isFinite(valueRight)) {
    return { value: valueRight, leftWeight: rL, rightWeight: rR, arbitrationMode: "right_only" }
  }
  return { value: null, leftWeight: rL, rightWeight: rR, arbitrationMode: "unavailable" }
}

function median(values) {
  const s = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b)
  if (!s.length) return null
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
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

function applyDeadzone(v, dz) {
  const x = safeFloat(v, 0)
  const d = Math.max(0, safeFloat(dz, 0))
  if (Math.abs(x) <= d) return 0
  return Math.sign(x) * (Math.abs(x) - d)
}

/**
 * Column-major 4x4 facialTransformationMatrix → face axes in landmark/camera space.
 * MediaPipe face model: col0≈right, col1≈up, col2≈forward.
 */
export function extractFaceAxesFromMatrix(facialMatrix) {
  const values = facialMatrix?.values || facialMatrix?.data || (Array.isArray(facialMatrix) ? facialMatrix : null)
  if (!values || values.length < 12) return null
  const right = normalize([Number(values[0]), Number(values[1]), Number(values[2])])
  const up = normalize([Number(values[4]), Number(values[5]), Number(values[6])])
  const forward = normalize([Number(values[8]), Number(values[9]), Number(values[10])])
  if (!right || !up || !forward) return null
  // Reject garbage / placeholder matrices (e.g. flat 99 fill in tests).
  if (norm(right) < 0.5 || Math.abs(dot(right, up)) > 0.95) return null
  return { right, up, forward, normal: forward }
}

/**
 * Landmark face plane from stable points (eye outers + mid face), not eyelids.
 */
export function extractFaceNormalFromLandmarks(landmarks) {
  const left = getPoint3(landmarks, GAZE_V2_LANDMARKS.left.outer)
  const right = getPoint3(landmarks, GAZE_V2_LANDMARKS.right.outer)
  const mid = getPoint3(landmarks, GAZE_V2_LANDMARKS.faceMid) || getPoint3(landmarks, 1)
  if (!left || !right || !mid) return null
  const across = sub(right, left)
  const upish = sub(mid, scale(add(left, right), 0.5))
  let normal = normalize(cross(across, upish))
  if (!normal) return null
  return normal
}

/**
 * Approximate Euler angles (deg) from head axes for diagnostics only — not a gaze signal.
 * Image convention: x→right, y→down. Upright face ≈ right=(1,0,*), up≈(0,-1,*).
 */
export function estimateHeadPoseDegFromAxes({ right, up, forward } = {}) {
  if (!right || !up || !forward) {
    return { yaw: null, pitch: null, roll: null }
  }
  const roll = (Math.atan2(right[1], right[0]) * 180) / Math.PI
  const pitch = (Math.atan2(-forward[1], Math.hypot(forward[0], forward[2])) * 180) / Math.PI
  const yaw = (Math.atan2(forward[0], -forward[2] || 1e-9) * 180) / Math.PI
  return {
    yaw: Number.isFinite(yaw) ? yaw : null,
    pitch: Number.isFinite(pitch) ? pitch : null,
    roll: Number.isFinite(roll) ? roll : null,
  }
}

/**
 * Build shared head-local orthonormal frame in camera/landmark space.
 * Prefer facial matrix; fallback to landmark eye-outers + mid-face.
 */
export function resolveHeadLocalFrame(landmarks, facialMatrix, cfg) {
  let right = null
  let up = null
  let forward = null
  let mode = "image-plane-fallback"
  let rotationValid = false

  if (cfg.preferFacialMatrix !== false) {
    const axes = extractFaceAxesFromMatrix(facialMatrix)
    if (axes?.right && axes?.up && axes?.forward) {
      right = axes.right
      up = axes.up
      forward = axes.forward
      mode = "facial-matrix"
      rotationValid = true
    }
  }

  if (!right || !up || !forward) {
    const leftO = getPoint3(landmarks, GAZE_V2_LANDMARKS.left.outer)
    const rightO = getPoint3(landmarks, GAZE_V2_LANDMARKS.right.outer)
    const mid = getPoint3(landmarks, GAZE_V2_LANDMARKS.faceMid) || getPoint3(landmarks, 1)
    if (leftO && rightO && mid) {
      const across = sub(rightO, leftO)
      right = normalize(across)
      const midEyes = scale(add(leftO, rightO), 0.5)
      const upish = sub(mid, midEyes)
      forward = normalize(cross(across, upish))
      if (right && forward) {
        up = normalize(cross(forward, right))
        if (up) {
          // Forehead (mid) should lie in +headUp from eye midpoint.
          if (dot(upish, up) < 0) {
            up = scale(up, -1)
            forward = scale(forward, -1)
          }
          mode = "landmark-face-plane"
          rotationValid = true
        }
      }
    }
  }

  if (!right || !up || !forward) {
    right = [1, 0, 0]
    up = [0, -1, 0]
    forward = [0, 0, -1]
    mode = "image-plane-fallback"
    rotationValid = false
  }

  // Re-orthonormalize (Gram-Schmidt) for numerical stability.
  right = normalize(right)
  forward = normalize(sub(forward, scale(right, dot(forward, right))))
  if (!forward) forward = normalize(cross(right, up)) || [0, 0, -1]
  up = normalize(cross(forward, right))
  if (!up) up = [0, -1, 0]

  const pose = estimateHeadPoseDegFromAxes({ right, up, forward })
  return {
    headRight: right,
    headUp: up,
    headForward: forward,
    faceNormal: forward,
    faceUp: up,
    verticalReferenceSource: mode,
    headCompensationMode: mode,
    headRotationValid: rotationValid,
    headYawUsed: pose.yaw,
    headPitchUsed: pose.pitch,
    headRollUsed: pose.roll,
  }
}

/**
 * Resolve stable face normal for eye-plane construction (compat wrapper).
 */
export function resolveFaceVerticalReference(landmarks, facialMatrix, cfg) {
  const head = resolveHeadLocalFrame(landmarks, facialMatrix, cfg)
  const headCtx = resolveHeadCanonicalContext(
    landmarks,
    facialMatrix,
    cfg?.defaultImageWidth,
    cfg?.defaultImageHeight
  )
  return {
    faceNormal: head.faceNormal,
    faceUp: head.faceUp,
    verticalReferenceSource: headCtx.available
      ? headCtx.headCompensationMode
      : head.verticalReferenceSource,
    headRight: head.headRight,
    headUp: head.headUp,
    headForward: head.headForward,
    headCompensationMode: headCtx.headCompensationMode,
    headRotationValid: headCtx.headRotationValid,
    headYawUsed: headCtx.headYawUsed,
    headPitchUsed: headCtx.headPitchUsed,
    headRollUsed: headCtx.headRollUsed,
    facialMatrix,
    imageWidth: headCtx.imageWidth,
    imageHeight: headCtx.imageHeight,
  }
}

/** Project camera-space point into head-local coordinates (origin-free; use deltas). */
function toHeadCoords(p, head) {
  return [
    dot(p, head.headRight),
    dot(p, head.headUp),
    dot(p, head.headForward),
  ]
}

/**
 * Build one eye local frame. V2.6: head-canonical-3d when matrix valid;
 * fallback eye-local-stable-plane (landmark face plane).
 * @returns {object | null}
 */
export function computeEyeLocalGaze(landmarks, side, cfg, faceCtx = {}) {
  const idx = side === "right" ? GAZE_V2_LANDMARKS.right : GAZE_V2_LANDMARKS.left
  const outer = getPoint3(landmarks, idx.outer)
  const inner = getPoint3(landmarks, idx.inner)
  const upper = getPoint3(landmarks, idx.upper)
  const lower = getPoint3(landmarks, idx.lower)
  const irisPts = idx.iris.map((i) => getPoint3(landmarks, i))
  const irisValidCount = irisPts.filter(Boolean).length
  const irisCenter = averagePoints(irisPts)
  if (!outer || !inner || !irisCenter || irisValidCount < 2) {
    return null
  }

  const eyeCenter = scale(add(outer, inner), 0.5)
  const eyeWidthNorm = norm(sub(inner, outer))
  if (eyeWidthNorm < cfg.minEyeWidth) return null

  const facialMatrix = faceCtx.facialMatrix ?? null
  const imageWidth = faceCtx.imageWidth ?? cfg.defaultImageWidth ?? DEFAULT_INFERENCE_WIDTH
  const imageHeight = faceCtx.imageHeight ?? cfg.defaultImageHeight ?? DEFAULT_INFERENCE_HEIGHT

  const faceNormal = faceCtx.faceNormal || faceCtx.headForward || null
  const legacy = computeLegacyCameraSpaceEyeGaze(landmarks, side, faceNormal)
  const preHeadCompensationX = legacy?.normalizedX ?? null
  const preHeadCompensationY = legacy?.normalizedY ?? null

  // ---- V2.6 Head-Canonical 3D (metric scaling + inverse rotation) ----
  if (cfg.preferFacialMatrix !== false && facialMatrix) {
    const canon = computeHeadCanonicalEyeGaze({
      landmarks,
      side,
      facialMatrix,
      imageWidth,
      imageHeight,
      minEyeWidth: cfg.minEyeWidth,
    })
    if (canon?.available) {
      return {
        side,
        valid: true,
        geometryMode: "head-canonical-3d",
        verticalReferenceSource: "head-canonical-3d",
        eyeCenter,
        irisCenter,
        eyeWidth: canon.eyeWidth,
        eyeHeight: canon.eyeHeight,
        eyeOpenness: canon.eyeOpenness,
        eyeOpennessRaw: canon.eyeOpennessRaw,
        irisValidCount: canon.irisValidCount,
        localX: canon.localX,
        localY: canon.localY,
        normalizedX: canon.normalizedX,
        normalizedY: canon.normalizedY,
        canonicalX: canon.canonicalX,
        canonicalY: canon.canonicalY,
        preHeadCompensationX,
        preHeadCompensationY,
        postHeadCompensationX: canon.canonicalX,
        postHeadCompensationY: canon.canonicalY,
        scaleUsed: "eyeWidth",
        horizontalAxis: canon.headRight,
        verticalAxis: canon.headUp,
        headCompensationMode: "head-canonical-3d",
        headCanonical: {
          irisCamera: canon.irisCamera,
          irisHead: canon.irisHead,
          outerHead: canon.outerHead,
          innerHead: canon.innerHead,
        },
      }
    }
  }

  // ---- Fallback: eye-local-stable-plane (no valid matrix) ----
  const head =
    faceCtx?.headRight && faceCtx?.headUp && faceCtx?.headForward
      ? faceCtx
      : resolveHeadLocalFrame(landmarks, facialMatrix, cfg)

  const geometryMode = "eye-local-stable-plane"
  const verticalReferenceSource = head.verticalReferenceSource || "landmark-face-plane"

  const outerH = toHeadCoords(outer, head)
  const innerH = toHeadCoords(inner, head)
  const irisH = toHeadCoords(irisCenter, head)
  const centerH = toHeadCoords(eyeCenter, head)

  const horizH = normalize(sub(innerH, outerH))
  if (!horizH) return null
  let vertH = normalize([-horizH[1], horizH[0], 0])
  if (!vertH) vertH = [0, 1, 0]
  if (vertH[1] < 0) vertH = scale(vertH, -1)

  const deltaH = sub(irisH, centerH)
  const localX = dot(deltaH, horizH)
  const localY = dot(deltaH, vertH)
  const rawNormX = localX / eyeWidthNorm
  const rawNormY = localY / eyeWidthNorm
  const canonicalX = side === "right" ? -rawNormX : rawNormX
  const canonicalY = rawNormY

  const lidRaw = upper && lower ? sub(upper, lower) : null
  const lidDist = lidRaw ? norm(lidRaw) : null
  const eyeOpennessRaw =
    lidDist != null ? lidDist / Math.max(eyeWidthNorm, 1e-6) : eyeWidthNorm > 0 ? 0.35 : 0
  const eyeHeight = lidDist != null ? Math.max(lidDist, eyeWidthNorm * 0.12) : eyeWidthNorm * 0.35
  const eyeOpenness = eyeHeight / Math.max(eyeWidthNorm, 1e-6)

  if (!Number.isFinite(canonicalX) || !Number.isFinite(canonicalY)) return null
  if (Math.abs(canonicalX) > 3 || Math.abs(canonicalY) > 3) return null

  return {
    side,
    valid: true,
    geometryMode,
    verticalReferenceSource,
    eyeCenter,
    irisCenter,
    eyeWidth: eyeWidthNorm,
    eyeHeight,
    eyeOpenness,
    eyeOpennessRaw,
    irisValidCount,
    localX,
    localY,
    normalizedX: canonicalX,
    normalizedY: canonicalY,
    canonicalX,
    canonicalY,
    preHeadCompensationX,
    preHeadCompensationY,
    postHeadCompensationX: canonicalX,
    postHeadCompensationY: canonicalY,
    scaleUsed: "eyeWidth",
    horizontalAxis: normalize(
      add(
        add(scale(head.headRight, horizH[0]), scale(head.headUp, horizH[1])),
        scale(head.headForward, horizH[2])
      )
    ),
    verticalAxis: normalize(
      add(
        add(scale(head.headRight, vertH[0]), scale(head.headUp, vertH[1])),
        scale(head.headForward, vertH[2])
      )
    ),
    headCompensationMode: head.headCompensationMode || "eye-local-stable-plane",
    headCanonical: null,
  }
}

/**
 * Gaze tracking validity — geometry / iris based, NOT absolute eyelid openness.
 */
export function isGazeEyeTrackingValid(eye, cfg) {
  if (!eye?.valid) return false
  if (!Number.isFinite(eye.eyeWidth) || eye.eyeWidth < cfg.minEyeWidth) return false
  if (!Number.isFinite(eye.normalizedX) || !Number.isFinite(eye.normalizedY)) return false
  if (!eye.irisCenter || !Number.isFinite(eye.irisCenter[0]) || !Number.isFinite(eye.irisCenter[1])) {
    return false
  }
  return safeFloat(eye.irisValidCount, 0) >= 2
}

/**
 * V2.4 gaze closure evaluation (per eye). Pure function — no temporal state.
 *
 * Contract: if geometryValid && trackingValid && irisValid → closureCandidate=false
 * regardless of opennessRatio. Openness never drives global hold.
 */
export function evaluateGazeEyeClosure({ eye, opennessRatio, cfg } = {}) {
  void cfg
  const ratio = Number.isFinite(Number(opennessRatio)) ? Number(opennessRatio) : 1
  const geometryValid = Boolean(eye?.valid)
  const trackingValid = isGazeEyeTrackingValid(eye, cfg || DEFAULT_GAZE_V2_CONFIG)
  const irisCount = safeFloat(eye?.irisValidCount, 0)
  const irisValid = trackingValid && irisCount >= 2

  if (!geometryValid) {
    return {
      closureCandidate: true,
      closureConfidence: 0.92,
      trackingValid: false,
      geometryValid: false,
      irisValid: false,
      reason: "geometry_invalid",
      opennessRatio: ratio,
    }
  }
  if (!trackingValid || !irisValid) {
    return {
      closureCandidate: true,
      closureConfidence: 0.88,
      trackingValid: false,
      geometryValid: true,
      irisValid: false,
      reason: "tracking_invalid",
      opennessRatio: ratio,
    }
  }

  // trackingValid + irisValid + geometryValid ⇒ NEVER closed (openness ignored).
  return {
    closureCandidate: false,
    closureConfidence: 0,
    trackingValid: true,
    geometryValid: true,
    irisValid: true,
    reason: "tracking_valid_openness_ignored",
    opennessRatio: ratio,
  }
}

/**
 * Gaze-specific reliability 0..1 — independent of expression blink blendshapes.
 * V2.4: openness floor >= 0.65 when trackingValid; openness cannot collapse reliability.
 */
export function computeGazeEyeReliability(eye, quality, cfg, opts = {}) {
  if (!eye?.valid) return 0
  const trackingValid =
    opts.trackingValid != null ? Boolean(opts.trackingValid) : isGazeEyeTrackingValid(eye, cfg)
  if (!trackingValid) return 0.08

  let r = 1
  if (eye.irisValidCount < 2) r *= 0.15
  else if (eye.irisValidCount < 4) r *= 0.85

  const ratio = Number.isFinite(Number(opts.opennessRatio))
    ? Number(opts.opennessRatio)
    : 1
  const floor = cfg.opennessReliabilityFloor
  const openFactor = clamp(0.7 + 0.3 * clamp(ratio, 0, 1.25), floor, 1)
  r *= openFactor

  r *= clamp(safeFloat(quality, 1), 0.25, 1)
  return clamp(r, 0, 1)
}

/**
 * V2.4 directional vertical response after deadzone + OneEuro.
 * +filteredY = LOOK_UP (Face Rig). Does not apply verticalGain.
 */
export function mapVerticalDirectionalResponse(filteredY, cfg) {
  const fy = safeFloat(filteredY, 0)
  const upScale = Math.max(1e-6, safeFloat(cfg.verticalUpFullScale, 0.075))
  const downScale = Math.max(1e-6, safeFloat(cfg.verticalDownFullScale, 0.14))
  const half = safeFloat(cfg.verticalOutputHalfRange, 40)
  const center = safeFloat(cfg.outputCenter, 50)
  const fullScaleUsed = fy >= 0 ? upScale : downScale
  const response = clamp(fy / fullScaleUsed, -1, 1)
  const mappedY = clampPct(center + response * half)
  let direction = "CENTER"
  if (response > 1e-4) direction = "LOOK_UP"
  else if (response < -1e-4) direction = "LOOK_DOWN"
  return {
    filteredY: fy,
    fullScaleUsed,
    responseNormalized: response,
    mappedY,
    direction,
    polarity: "plus_y_look_up",
  }
}

export function createGazeV2State() {
  return {
    neutralReady: false,
    neutralX: null,
    neutralY: null,
    samplesX: [],
    samplesY: [],
    samplesOpenL: [],
    samplesOpenR: [],
    neutralEyeOpennessLeft: null,
    neutralEyeOpennessRight: null,
    warmupFrames: 0,
    /** Legacy field: true when true-closure hold is active. */
    blinkFrozen: false,
    holdReason: null,
    trueClosureActive: false,
    closureEnterCount: 0,
    closureReleaseCount: 0,
    lastReliableAtClosureStart: null,
    filter: createOneEuroFilter2D(DEFAULT_GAZE_V2_CONFIG.oneEuro),
    lastReliable: { x: 50, y: 50 },
    lastFiltered: { x: 50, y: 50 },
    lastTimestampMs: null,
  }
}

export function resetGazeV2State(state) {
  const fresh = createGazeV2State()
  if (state && typeof state === "object") {
    for (const k of Object.keys(state)) delete state[k]
    Object.assign(state, fresh)
    return state
  }
  return fresh
}

function buildEyeDebug(eye, weight, reliability, extras = {}) {
  if (!eye) return null
  return {
    eyeCenter: eye.eyeCenter,
    irisCenter: eye.irisCenter,
    localX: eye.localX,
    localY: eye.localY,
    normalizedX: eye.normalizedX,
    normalizedY: eye.normalizedY,
    canonicalX: eye.canonicalX ?? eye.normalizedX,
    canonicalY: eye.canonicalY ?? eye.normalizedY,
    preHeadCompensationX: eye.preHeadCompensationX ?? null,
    preHeadCompensationY: eye.preHeadCompensationY ?? null,
    postHeadCompensationX: eye.postHeadCompensationX ?? eye.canonicalX ?? eye.normalizedX,
    postHeadCompensationY: eye.postHeadCompensationY ?? eye.canonicalY ?? eye.normalizedY,
    eyeWidth: eye.eyeWidth,
    eyeHeight: eye.eyeHeight,
    eyeOpenness: eye.eyeOpenness,
    opennessRatio: extras.opennessRatio ?? null,
    trackingValid: extras.trackingValid ?? null,
    geometryValid: extras.geometryValid ?? null,
    irisValid: extras.irisValid ?? null,
    closureCandidate: extras.closureCandidate ?? null,
    closureConfidence: extras.closureConfidence ?? null,
    closureReason: extras.closureReason ?? null,
    reliability,
    verticalAxis: eye.verticalAxis,
    scaleUsed: eye.scaleUsed,
    weight,
    geometryMode: eye.geometryMode,
  }
}

/**
 * @param {object} args
 * @param {Array} args.landmarks
 * @param {Record<string, number>} [args.blendshapes] unused for hold (expression blink untouched elsewhere)
 * @param {object|null} [args.facialTransformationMatrix]
 * @param {number} [args.imageWidth]
 * @param {number} [args.imageHeight]
 */
export function processEyeLocalGazeV2({
  landmarks,
  blendshapes = {},
  facialTransformationMatrix = null,
  imageWidth = null,
  imageHeight = null,
  state,
  config,
  timestampMs,
  quality = 1,
  faceDetected = true,
} = {}) {
  void blendshapes // Expression blink must not drive gaze hold — evidence only below.
  const cfg = normalizeGazeV2Config(config)
  const st = state && typeof state === "object" ? state : createGazeV2State()
  if (!st.filter || typeof st.filter.filter !== "function") {
    st.filter = createOneEuroFilter2D(cfg.oneEuro)
  } else {
    st.filter.setParams(cfg.oneEuro)
  }

  const ts = Number.isFinite(Number(timestampMs)) ? Number(timestampMs) : Date.now()
  const center = cfg.outputCenter

  const emptyDebug = {
    algorithm: GAZE_ALGORITHM_V2,
    geometryMode: null,
    left: null,
    right: null,
    fused: { normalizedX: null, normalizedY: null },
    frame: {
      faceNormal: null,
      verticalReferenceSource: null,
    },
    fusion: {
      leftWeight: 0,
      rightWeight: 0,
      bothEyesUnreliable: false,
      disagreementX: false,
      disagreementY: false,
      fusedBeforeDisagreementX: null,
      fusedBeforeDisagreementY: null,
      fusedAfterDisagreementX: null,
      fusedAfterDisagreementY: null,
      arbitrationModeX: null,
      arbitrationModeY: null,
    },
    output: { holdReason: null },
    neutral: {
      x: st.neutralX,
      y: st.neutralY,
      ready: Boolean(st.neutralReady),
      sampleCount: Array.isArray(st.samplesX) ? st.samplesX.length : 0,
    },
    signal: { preDeadzoneX: null, preDeadzoneY: null, postDeadzoneX: null, postDeadzoneY: null },
    filter: { outputX: null, outputY: null },
    final: { sharedRadarX: center, sharedRadarY: center },
    binocularDisagreement: false,
    disagreementX: false,
    disagreementY: false,
    blinkFrozen: false,
    outputMode: "unavailable",
    leftWeight: 0,
    rightWeight: 0,
  }

  if (!faceDetected || !Array.isArray(landmarks) || landmarks.length < cfg.minLandmarkCount) {
    st.blinkFrozen = false
    st.holdReason = "face_lost"
    return {
      gazeX: st.lastReliable?.x ?? center,
      gazeY: st.lastReliable?.y ?? center,
      sharedRadarX: st.lastReliable?.x ?? center,
      sharedRadarY: st.lastReliable?.y ?? center,
      available: false,
      debug: { ...emptyDebug, outputMode: "face_lost", output: { holdReason: "face_lost" } },
      nextState: st,
    }
  }

  const faceRef = resolveFaceVerticalReference(landmarks, facialTransformationMatrix, cfg)
  const headCtx = resolveHeadCanonicalContext(
    landmarks,
    facialTransformationMatrix,
    imageWidth ?? cfg.defaultImageWidth,
    imageHeight ?? cfg.defaultImageHeight
  )
  const eyeFaceCtx = {
    ...faceRef,
    ...headCtx,
    facialMatrix: facialTransformationMatrix,
    imageWidth: headCtx.imageWidth,
    imageHeight: headCtx.imageHeight,
  }
  const left = computeEyeLocalGaze(landmarks, "left", cfg, eyeFaceCtx)
  const right = computeEyeLocalGaze(landmarks, "right", cfg, eyeFaceCtx)

  const legacyLeft = computeLegacyCameraSpaceEyeGaze(landmarks, "left", faceRef.faceNormal)
  const legacyRight = computeLegacyCameraSpaceEyeGaze(landmarks, "right", faceRef.faceNormal)
  let legacyLocalFusedX = null
  let legacyLocalFusedY = null
  if (legacyLeft && legacyRight) {
    legacyLocalFusedX = (legacyLeft.normalizedX + legacyRight.normalizedX) / 2
    legacyLocalFusedY = (legacyLeft.normalizedY + legacyRight.normalizedY) / 2
  } else if (legacyLeft) {
    legacyLocalFusedX = legacyLeft.normalizedX
    legacyLocalFusedY = legacyLeft.normalizedY
  } else if (legacyRight) {
    legacyLocalFusedX = legacyRight.normalizedX
    legacyLocalFusedY = legacyRight.normalizedY
  }

  const epsOpen = 1e-4
  const opennessRatioLeft =
    left?.valid &&
    st.neutralReady &&
    Number.isFinite(st.neutralEyeOpennessLeft) &&
    st.neutralEyeOpennessLeft > epsOpen
      ? safeFloat(left.eyeOpennessRaw ?? left.eyeOpenness, 0) / st.neutralEyeOpennessLeft
      : left?.valid
        ? 1
        : 0
  const opennessRatioRight =
    right?.valid &&
    st.neutralReady &&
    Number.isFinite(st.neutralEyeOpennessRight) &&
    st.neutralEyeOpennessRight > epsOpen
      ? safeFloat(right.eyeOpennessRaw ?? right.eyeOpenness, 0) / st.neutralEyeOpennessRight
      : right?.valid
        ? 1
        : 0

  const leftClosure = evaluateGazeEyeClosure({
    eye: left,
    opennessRatio: opennessRatioLeft,
    cfg,
  })
  const rightClosure = evaluateGazeEyeClosure({
    eye: right,
    opennessRatio: opennessRatioRight,
    cfg,
  })

  const relL = computeGazeEyeReliability(left, quality, cfg, {
    opennessRatio: opennessRatioLeft,
    trackingValid: leftClosure.trackingValid,
    closureCandidate: leftClosure.closureCandidate,
  })
  const relR = computeGazeEyeReliability(right, quality, cfg, {
    opennessRatio: opennessRatioRight,
    trackingValid: rightClosure.trackingValid,
    closureCandidate: rightClosure.closureCandidate,
  })

  // V2.4: global hold only when BOTH eyes tracking/geometry invalid (temporal hysteresis).
  // Openness NEVER enters hold. bothClosureCandidates ≡ both tracking invalid.
  const bothClosureCandidates =
    Boolean(leftClosure.closureCandidate) && Boolean(rightClosure.closureCandidate)
  const bothGeometryInvalid = !left?.valid && !right?.valid
  const bothTrackingInvalid =
    !leftClosure.trackingValid && !rightClosure.trackingValid

  // Diagnostic only (compat): low reliability on both eyes — does NOT drive hold by itself.
  const bothUnreliable =
    relL < cfg.reliabilityHoldThreshold && relR < cfg.reliabilityHoldThreshold

  if (typeof st.trueClosureActive !== "boolean") st.trueClosureActive = Boolean(st.blinkFrozen)
  if (!Number.isFinite(st.closureEnterCount)) st.closureEnterCount = 0
  if (!Number.isFinite(st.closureReleaseCount)) st.closureReleaseCount = 0

  if (!st.neutralReady) {
    st.trueClosureActive = false
    st.blinkFrozen = false
    st.holdReason = null
    st.closureEnterCount = 0
    st.closureReleaseCount = 0
  } else if (!st.trueClosureActive) {
    if (bothTrackingInvalid || bothGeometryInvalid) {
      if (st.closureEnterCount === 0) {
        st.lastReliableAtClosureStart = {
          x: st.lastReliable?.x ?? center,
          y: st.lastReliable?.y ?? center,
        }
      }
      st.closureEnterCount += 1
      st.closureReleaseCount = 0
    } else {
      st.closureEnterCount = 0
      st.lastReliableAtClosureStart = null
    }
    if (st.closureEnterCount >= cfg.closureEnterFrames) {
      st.trueClosureActive = true
      st.blinkFrozen = true
      st.holdReason = "both_eyes_tracking_invalid"
      if (st.lastReliableAtClosureStart) {
        st.lastReliable = { ...st.lastReliableAtClosureStart }
      }
    } else {
      st.blinkFrozen = false
      st.holdReason = null
    }
  } else {
    // Release: at least one eye tracking-valid again.
    const releaseOk = leftClosure.trackingValid || rightClosure.trackingValid
    if (releaseOk) {
      st.closureReleaseCount += 1
      st.closureEnterCount = 0
    } else {
      st.closureReleaseCount = 0
    }
    if (st.closureReleaseCount >= cfg.closureReleaseFrames) {
      st.trueClosureActive = false
      st.blinkFrozen = false
      st.holdReason = null
      st.closureReleaseCount = 0
    } else {
      st.blinkFrozen = true
      st.holdReason = "both_eyes_tracking_invalid"
    }
  }

  const shouldHold = Boolean(st.blinkFrozen)

  // Weights: invalid eye → downweight; never global hold for single-eye invalid.
  let wL = left?.valid ? Math.max(relL, 0) : 0
  let wR = right?.valid ? Math.max(relR, 0) : 0
  if (!leftClosure.trackingValid && rightClosure.trackingValid) wL = 0
  if (!rightClosure.trackingValid && leftClosure.trackingValid) wR = 0
  const wSum = wL + wR

  let fusedX = null
  let fusedY = null
  let fusedBeforeDisagreementX = null
  let fusedBeforeDisagreementY = null
  let disagreementX = false
  let disagreementY = false
  let binocularDisagreement = false
  let arbitrationModeX = "unavailable"
  let arbitrationModeY = "unavailable"
  let geometryMode = left?.geometryMode || right?.geometryMode || null

  if ((left || right) && (wSum > 1e-6 || (left?.valid && right?.valid))) {
    if (left?.valid && right?.valid) {
      // V2.4b: normalizedX/Y already canonical look-right / look-up (right mirrored).
      const lookRightL = left.normalizedX
  const lookRightR = right.normalizedX
      const lookUpL = left.normalizedY
      const lookUpR = right.normalizedY
      const dx = Math.abs(lookRightL - lookRightR)
      const dy = Math.abs(lookUpL - lookUpR)
      disagreementX = dx > cfg.binocularDisagreementThreshold
      disagreementY = dy > cfg.binocularDisagreementThreshold
      binocularDisagreement = disagreementX || disagreementY

      const weightSum = Math.max(wL + wR, 1e-6)
      fusedBeforeDisagreementX = (wL * lookRightL + wR * lookRightR) / weightSum
      fusedBeforeDisagreementY = (wL * lookUpL + wR * lookUpR) / weightSum

      const ax = arbitrateBinocularAxis({
        valueLeft: lookRightL,
        valueRight: lookRightR,
        relL: wL,
        relR: wR,
        disagreement: disagreementX,
        usableThreshold: cfg.usableReliabilityThreshold,
      })
      const ay = arbitrateBinocularAxis({
        valueLeft: lookUpL,
        valueRight: lookUpR,
        relL: wL,
        relR: wR,
        disagreement: disagreementY,
        usableThreshold: cfg.usableReliabilityThreshold,
      })
      fusedX = ax.value
      fusedY = ay.value
      arbitrationModeX = ax.arbitrationMode
      arbitrationModeY = ay.arbitrationMode
      if (left.geometryMode !== right.geometryMode) geometryMode = "eye-local-mixed"
    } else if (left?.valid && (wL > 0 || leftClosure.trackingValid)) {
      fusedX = left.normalizedX
      fusedY = left.normalizedY
      fusedBeforeDisagreementX = fusedX
      fusedBeforeDisagreementY = fusedY
      arbitrationModeX = "left_only"
      arbitrationModeY = "left_only"
      if (wL <= 0) wL = Math.max(relL, 0.2)
    } else if (right?.valid && (wR > 0 || rightClosure.trackingValid)) {
      fusedX = right.normalizedX
      fusedY = right.normalizedY
      fusedBeforeDisagreementX = fusedX
      fusedBeforeDisagreementY = fusedY
      arbitrationModeX = "right_only"
      arbitrationModeY = "right_only"
      if (wR <= 0) wR = Math.max(relR, 0.2)
    }
  }

  const fusedAfterDisagreementX = fusedX
  const fusedAfterDisagreementY = fusedY

  const rigidResidualX = (() => {
    const vals = []
    if (left?.valid && Number.isFinite(left.preHeadCompensationX) && Number.isFinite(left.postHeadCompensationX)) {
      vals.push(left.preHeadCompensationX - left.postHeadCompensationX)
    }
    if (right?.valid && Number.isFinite(right.preHeadCompensationX) && Number.isFinite(right.postHeadCompensationX)) {
      // Right pre is still eye-corner signed; mirror to look-right before residual.
      vals.push(-right.preHeadCompensationX - right.postHeadCompensationX)
    }
    if (!vals.length) return null
    return vals.reduce((a, b) => a + b, 0) / vals.length
  })()
  const rigidResidualY = (() => {
    const vals = []
    if (left?.valid && Number.isFinite(left.preHeadCompensationY) && Number.isFinite(left.postHeadCompensationY)) {
      vals.push(left.preHeadCompensationY - left.postHeadCompensationY)
    }
    if (right?.valid && Number.isFinite(right.preHeadCompensationY) && Number.isFinite(right.postHeadCompensationY)) {
      vals.push(right.preHeadCompensationY - right.postHeadCompensationY)
    }
    if (!vals.length) return null
    return vals.reduce((a, b) => a + b, 0) / vals.length
  })()

  const neutralUpdateAllowed = !st.neutralReady
  const neutralUpdateBlockedReason = st.neutralReady ? "neutral_locked" : null

  const packDebug = (extra = {}) => ({
    algorithm: GAZE_ALGORITHM_V2,
    geometryMode,
    left: buildEyeDebug(left, wL, relL, {
      opennessRatio: opennessRatioLeft,
      trackingValid: leftClosure.trackingValid,
      geometryValid: leftClosure.geometryValid,
      irisValid: leftClosure.irisValid,
      closureCandidate: leftClosure.closureCandidate,
      closureConfidence: leftClosure.closureConfidence,
      closureReason: leftClosure.reason,
    }),
    right: buildEyeDebug(right, wR, relR, {
      opennessRatio: opennessRatioRight,
      trackingValid: rightClosure.trackingValid,
      geometryValid: rightClosure.geometryValid,
      irisValid: rightClosure.irisValid,
      closureCandidate: rightClosure.closureCandidate,
      closureConfidence: rightClosure.closureConfidence,
      closureReason: rightClosure.reason,
    }),
    fused: { normalizedX: fusedX, normalizedY: fusedY },
    frame: {
      faceNormal: faceRef.faceNormal,
      verticalReferenceSource: headCtx.headCompensationMode || faceRef.verticalReferenceSource,
      headCompensationMode: headCtx.headCompensationMode,
      headRotationValid: headCtx.headRotationValid,
      headYawUsed: headCtx.headYawUsed,
      headPitchUsed: headCtx.headPitchUsed,
      headRollUsed: headCtx.headRollUsed,
      headRight: headCtx.headRight,
      headUp: headCtx.headUp,
      headForward: headCtx.headForward,
      imageWidth: headCtx.imageWidth,
      imageHeight: headCtx.imageHeight,
    },
    headCompensation: {
      mode: headCtx.headCompensationMode,
      rotationValid: Boolean(headCtx.headRotationValid),
      yawUsed: headCtx.headYawUsed,
      pitchUsed: headCtx.headPitchUsed,
      rollUsed: headCtx.headRollUsed,
      rigidMotionResidualX: rigidResidualX,
      rigidMotionResidualY: rigidResidualY,
      legacyLocalFusedX,
      legacyLocalFusedY,
      canonicalFusedX: fusedX,
      canonicalFusedY: fusedY,
    },
    headCanonical: {
      available: Boolean(headCtx.available),
      matrixValid: Boolean(headCtx.matrixValid),
      rotationMatrix: headCtx.rotationMatrix,
      left: left?.headCanonical
        ? {
            irisCamera: left.headCanonical.irisCamera,
            irisHead: left.headCanonical.irisHead,
            outerHead: left.headCanonical.outerHead,
            innerHead: left.headCanonical.innerHead,
            normalizedX: left.canonicalX,
            normalizedY: left.canonicalY,
          }
        : null,
      right: right?.headCanonical
        ? {
            irisCamera: right.headCanonical.irisCamera,
            irisHead: right.headCanonical.irisHead,
            outerHead: right.headCanonical.outerHead,
            innerHead: right.headCanonical.innerHead,
            normalizedX: right.canonicalX,
            normalizedY: right.canonicalY,
          }
        : null,
    },
    fusion: {
      leftWeight: wL,
      rightWeight: wR,
      bothEyesUnreliable: bothUnreliable || bothTrackingInvalid || Boolean(st.trueClosureActive),
      disagreementX,
      disagreementY,
      fusedBeforeDisagreementX,
      fusedBeforeDisagreementY,
      fusedAfterDisagreementX,
      fusedAfterDisagreementY,
      arbitrationModeX,
      arbitrationModeY,
    },
    closure: {
      trueClosureActive: Boolean(st.trueClosureActive),
      enterCount: st.closureEnterCount,
      releaseCount: st.closureReleaseCount,
      bothClosureCandidates,
      decision: shouldHold
        ? "hold_both_tracking_invalid"
        : bothClosureCandidates
          ? "pending_enter"
          : "tracking",
      reason: st.holdReason,
      evidenceLeft: {
        trackingValid: leftClosure.trackingValid,
        geometryValid: leftClosure.geometryValid,
        irisValid: leftClosure.irisValid,
        opennessRatio: opennessRatioLeft,
        blendBlink: Number.isFinite(Number(blendshapes?.eyeBlinkLeft))
          ? Number(blendshapes.eyeBlinkLeft)
          : null,
        realBlinkHint:
          Number.isFinite(Number(blendshapes?.eyeBlinkLeft)) &&
          Number(blendshapes.eyeBlinkLeft) >= 0.55,
        closureCandidate: leftClosure.closureCandidate,
        reason: leftClosure.reason,
      },
      evidenceRight: {
        trackingValid: rightClosure.trackingValid,
        geometryValid: rightClosure.geometryValid,
        irisValid: rightClosure.irisValid,
        opennessRatio: opennessRatioRight,
        blendBlink: Number.isFinite(Number(blendshapes?.eyeBlinkRight))
          ? Number(blendshapes.eyeBlinkRight)
          : null,
        realBlinkHint:
          Number.isFinite(Number(blendshapes?.eyeBlinkRight)) &&
          Number(blendshapes.eyeBlinkRight) >= 0.55,
        closureCandidate: rightClosure.closureCandidate,
        reason: rightClosure.reason,
      },
    },
    output: { holdReason: st.holdReason },
    neutral: {
      x: st.neutralReady ? st.neutralX : null,
      y: st.neutralReady ? st.neutralY : null,
      ready: Boolean(st.neutralReady),
      sampleCount: st.samplesX.length,
      eyeOpennessLeft: st.neutralReady ? st.neutralEyeOpennessLeft : null,
      eyeOpennessRight: st.neutralReady ? st.neutralEyeOpennessRight : null,
      updateAllowed: neutralUpdateAllowed,
      updateBlockedReason: neutralUpdateBlockedReason,
    },
    signal: { preDeadzoneX: null, preDeadzoneY: null, postDeadzoneX: null, postDeadzoneY: null },
    filter: { outputX: null, outputY: null },
    final: { sharedRadarX: center, sharedRadarY: center },
    binocularDisagreement,
    disagreementX,
    disagreementY,
    blinkFrozen: Boolean(st.blinkFrozen),
    trueClosureActive: Boolean(st.trueClosureActive),
    leftWeight: wL,
    rightWeight: wR,
    ...extra,
  })

  if (fusedX == null || fusedY == null) {
    const holdX = st.lastReliable?.x ?? center
    const holdY = st.lastReliable?.y ?? center
    if (shouldHold) {
      return {
        gazeX: holdX,
        gazeY: holdY,
        sharedRadarX: holdX,
        sharedRadarY: holdY,
        available: true,
        frozenByBlink: true,
        rawX: null,
        rawY: null,
        neutralReady: true,
        neutralX: st.neutralX,
        neutralY: st.neutralY,
        candidateSharedRadarX: holdX,
        candidateSharedRadarY: holdY,
        emittedSharedRadarX: holdX,
        emittedSharedRadarY: holdY,
        outputMode: "gaze_hold_both_eyes_unreliable",
        debug: packDebug({
          outputMode: "gaze_hold_both_eyes_unreliable",
          filter: { outputX: holdX, outputY: holdY },
          final: { sharedRadarX: holdX, sharedRadarY: holdY },
          blinkFrozen: true,
        }),
        nextState: st,
      }
    }
    return {
      gazeX: holdX,
      gazeY: holdY,
      sharedRadarX: holdX,
      sharedRadarY: holdY,
      available: false,
      debug: packDebug({
        outputMode: "invalid_geometry",
        final: { sharedRadarX: holdX, sharedRadarY: holdY },
        output: { holdReason: st.holdReason || "invalid_geometry" },
      }),
      nextState: st,
    }
  }

  // Neutral warmup — collect gaze + eye openness baselines together.
  if (!st.neutralReady) {
    st.warmupFrames += 1
    if (!Array.isArray(st.samplesOpenL)) st.samplesOpenL = []
    if (!Array.isArray(st.samplesOpenR)) st.samplesOpenR = []
    // Skip only when both eyes lack tracking validity (not lid-narrow).
    if (!(bothTrackingInvalid || bothGeometryInvalid)) {
      st.samplesX.push(fusedX)
      st.samplesY.push(fusedY)
      if (left?.valid && Number.isFinite(left.eyeOpennessRaw ?? left.eyeOpenness)) {
        st.samplesOpenL.push(left.eyeOpennessRaw ?? left.eyeOpenness)
      }
      if (right?.valid && Number.isFinite(right.eyeOpennessRaw ?? right.eyeOpenness)) {
        st.samplesOpenR.push(right.eyeOpennessRaw ?? right.eyeOpenness)
      }
    }
    const n = st.samplesX.length
    if (
      n >= cfg.neutralWarmupSamples ||
      (st.warmupFrames >= cfg.neutralMaxWaitFrames && n >= Math.max(4, Math.floor(cfg.neutralWarmupSamples * 0.5)))
    ) {
      st.neutralX = median(st.samplesX)
      st.neutralY = median(st.samplesY)
      st.neutralEyeOpennessLeft = median(st.samplesOpenL)
      st.neutralEyeOpennessRight = median(st.samplesOpenR)
      if (st.neutralX != null && st.neutralY != null) {
        st.neutralReady = true
        st.filter.reset(0, 0)
      }
    }
    return {
      gazeX: center,
      gazeY: center,
      sharedRadarX: center,
      sharedRadarY: center,
      available: true,
      warmingUp: true,
      rawX: fusedX,
      rawY: fusedY,
      neutralReady: false,
      neutralX: null,
      neutralY: null,
      candidateSharedRadarX: center,
      candidateSharedRadarY: center,
      emittedSharedRadarX: center,
      emittedSharedRadarY: center,
      outputMode: "warmingUp",
      debug: packDebug({ outputMode: "warmingUp" }),
      nextState: st,
    }
  }

  if (shouldHold) {
    const hx = st.lastReliable?.x ?? center
    const hy = st.lastReliable?.y ?? center
    return {
      gazeX: hx,
      gazeY: hy,
      sharedRadarX: hx,
      sharedRadarY: hy,
      available: true,
      frozenByBlink: true,
      rawX: fusedX,
      rawY: fusedY,
      neutralReady: true,
      neutralX: st.neutralX,
      neutralY: st.neutralY,
      eyeLookX: fusedX - st.neutralX,
      eyeLookY: fusedY - st.neutralY,
      candidateSharedRadarX: hx,
      candidateSharedRadarY: hy,
      emittedSharedRadarX: hx,
      emittedSharedRadarY: hy,
      outputMode: "gaze_hold_both_eyes_unreliable",
      debug: packDebug({
        outputMode: "gaze_hold_both_eyes_unreliable",
        filter: { outputX: hx, outputY: hy },
        final: { sharedRadarX: hx, sharedRadarY: hy },
        blinkFrozen: true,
      }),
      nextState: st,
    }
  }

  let signalX = fusedX - st.neutralX
  let signalY = fusedY - st.neutralY
  // V2.2: binocular disagreement must NOT amplitude-suppress the gaze vector.
  // V2.4b: polarity / head decoupling applied in head-local eye frame (pre-neutral).

  const preX = signalX
  const preY = signalY
  const postX = applyDeadzone(signalX, cfg.deadZoneX)
  const postY = applyDeadzone(signalY, cfg.deadZoneY)

  const filtered = st.filter.filter(postX, postY, ts)
  const candidateX = clampPct(center + filtered.x * cfg.horizontalGain)
  // V2.4: directional full-scale Y — do NOT multiply verticalGain (prevents double gain).
  const vertMap = mapVerticalDirectionalResponse(filtered.y, cfg)
  const candidateY = vertMap.mappedY

  st.lastFiltered = { x: candidateX, y: candidateY }
  st.lastReliable = { x: candidateX, y: candidateY }
  st.lastTimestampMs = ts

  const mode = "tracking"
  return {
    gazeX: candidateX,
    gazeY: candidateY,
    sharedRadarX: candidateX,
    sharedRadarY: candidateY,
    available: true,
    stable: true,
    rawX: fusedX,
    rawY: fusedY,
    eyeLookX: filtered.x,
    eyeLookY: filtered.y,
    neutralReady: true,
    neutralX: st.neutralX,
    neutralY: st.neutralY,
    neutralSampleCount: st.samplesX.length,
    candidateSharedRadarX: candidateX,
    candidateSharedRadarY: candidateY,
    emittedSharedRadarX: candidateX,
    emittedSharedRadarY: candidateY,
    outputMode: mode,
    debug: packDebug({
      outputMode: mode,
      signal: {
        preDeadzoneX: preX,
        preDeadzoneY: preY,
        postDeadzoneX: postX,
        postDeadzoneY: postY,
      },
      filter: { outputX: filtered.x, outputY: filtered.y },
      vertical: {
        polarity: vertMap.polarity,
        signalPrePolarity: null, // polarity applied at axis orientation, not post-fusion
        signalPostPolarity: signalY,
        filteredSignal: filtered.y,
        direction: vertMap.direction,
        fullScaleUsed: vertMap.fullScaleUsed,
        responseNormalized: vertMap.responseNormalized,
        mappedY: vertMap.mappedY,
      },
      final: { sharedRadarX: candidateX, sharedRadarY: candidateY },
      blinkFrozen: false,
    }),
    nextState: st,
  }
}

export function resolveGazeAlgorithm(config = {}) {
  const raw =
    config.gazeAlgorithm ??
    config.gaze?.gazeAlgorithm ??
    config.gazeV2?.gazeAlgorithm ??
    GAZE_ALGORITHM_V2
  const id = String(raw || GAZE_ALGORITHM_V2).toLowerCase()
  if (id === GAZE_ALGORITHM_LEGACY || id === "legacy" || id === "processgaze") {
    return GAZE_ALGORITHM_LEGACY
  }
  return GAZE_ALGORITHM_V2
}
