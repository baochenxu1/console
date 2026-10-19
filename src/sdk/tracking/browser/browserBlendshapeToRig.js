/**
 * @deprecated Phase 1 compatibility only.
 * Browser Provider 已在 Phase 1B 切换为 Canonical Observation → Shared Semantic Core。
 * 本文件仅保留给旧 SDK 调用方，禁止再接入正式 Provider。
 */

import { createInitialEliteRig, normalizeEliteRig } from "../../../core/faceDofMapper.js"

export const DEBUG_BLEND_KEYS = Object.freeze([
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
  "browInnerUp",
  "browOuterUpLeft",
  "browOuterUpRight",
])

const DEFAULT_GAINS = Object.freeze({
  jaw: 1.18,
  blinkLeft: 1.0,
  blinkRight: 1.0,
  smileLeft: 1.0,
  smileRight: 1.0,
  browInner: 1.0,
  browOuterLeft: 1.0,
  browOuterRight: 1.0,
  upperLipLeft: 1.0,
  upperLipRight: 1.0,
  lowerLipLeft: 1.0,
  lowerLipRight: 1.0,
  eyeLookInLeft: 1.0,
  eyeLookOutLeft: 1.0,
  eyeLookUpLeft: 1.0,
  eyeLookDownLeft: 1.0,
  eyeLookInRight: 1.0,
  eyeLookOutRight: 1.0,
  eyeLookUpRight: 1.0,
  eyeLookDownRight: 1.0,
})

function clamp(n, lo, hi) {
  const v = Number(n)
  if (!Number.isFinite(v)) return lo
  return Math.max(lo, Math.min(hi, v))
}

function deadzoneUnipolar(v, thr = 0.03) {
  const x = Math.max(0, Number(v) || 0)
  if (x < thr) return 0
  return (x - thr) / Math.max(1e-6, 1 - thr)
}

function toSigned100(strength, gain = 1, invert = false) {
  let s = clamp(strength, 0, 1) * 100 * (Number(gain) || 1)
  if (invert) s = -s
  return clamp(Math.round(s), -100, 100)
}

function toPct100(strength, gain = 1) {
  return clamp(Math.round(clamp(strength, 0, 1) * 100 * (Number(gain) || 1)), 0, 100)
}

/**
 * @param {Record<string, number>} blend
 * @param {object} [options]
 */
export function mapBlendshapesToEliteRig(blend = {}, options = {}) {
  const gains = { ...DEFAULT_GAINS, ...(options.gains || {}) }
  const invertJaw = options.invertJaw !== false
  const b = blend || {}

  const jawRaw = deadzoneUnipolar(b.jawOpen, 0.03)
  const jaw = toSigned100(jawRaw, gains.jaw, invertJaw)

  const blinkL = toPct100(deadzoneUnipolar(b.eyeBlinkLeft, 0.03), gains.blinkLeft)
  const blinkR = toPct100(deadzoneUnipolar(b.eyeBlinkRight, 0.03), gains.blinkRight)
  const bias = 20
  const eyeLUp = clamp(Math.round(bias - blinkL + toPct100(deadzoneUnipolar(b.eyeWideLeft, 0.03), 0.3)), -100, 100)
  const eyeRUp = clamp(Math.round(bias - blinkR + toPct100(deadzoneUnipolar(b.eyeWideRight, 0.03), 0.3)), -100, 100)
  const eyeLLo = clamp(Math.round(-(blinkL * 0.5)), -100, 100)
  const eyeRLo = clamp(Math.round(-(blinkR * 0.5)), -100, 100)

  const smileL = toSigned100(deadzoneUnipolar(b.mouthSmileLeft, 0.03), gains.smileLeft, false)
  const smileR = toSigned100(deadzoneUnipolar(b.mouthSmileRight, 0.03), gains.smileRight, false)
  const upperL = toSigned100(deadzoneUnipolar(b.mouthUpperUpLeft, 0.03), gains.upperLipLeft, false)
  const upperR = toSigned100(deadzoneUnipolar(b.mouthUpperUpRight, 0.03), gains.upperLipRight, false)
  const lowerL = toSigned100(deadzoneUnipolar(b.mouthLowerDownLeft, 0.03), gains.lowerLipLeft, true)
  const lowerR = toSigned100(deadzoneUnipolar(b.mouthLowerDownRight, 0.03), gains.lowerLipRight, true)

  const browInner = toSigned100(deadzoneUnipolar(b.browInnerUp, 0.03), gains.browInner, false)
  const browOuterL = toSigned100(deadzoneUnipolar(b.browOuterUpLeft, 0.03), gains.browOuterLeft, false)
  const browOuterR = toSigned100(deadzoneUnipolar(b.browOuterUpRight, 0.03), gains.browOuterRight, false)

  // 简化视线：lookIn/Out/Up/Down → sharedRadar 0~100
  const lookX =
    (Number(b.eyeLookOutLeft) || 0) -
    (Number(b.eyeLookInLeft) || 0) +
    ((Number(b.eyeLookInRight) || 0) - (Number(b.eyeLookOutRight) || 0))
  const lookY =
    (Number(b.eyeLookUpLeft) || 0) -
    (Number(b.eyeLookDownLeft) || 0) +
    ((Number(b.eyeLookUpRight) || 0) - (Number(b.eyeLookDownRight) || 0))
  const radarX = clamp(Math.round(50 + clamp(lookX, -1, 1) * 50), 0, 100)
  const radarY = clamp(Math.round(50 - clamp(lookY, -1, 1) * 50), 0, 100)

  const tipL = clamp(Math.round(browInner * 0.6 + browOuterL * 0.4), -100, 100)
  const tipR = clamp(Math.round(browInner * 0.6 + browOuterR * 0.4), -100, 100)
  const midL = clamp(Math.round(browInner * 0.4 + browOuterL * 0.6), -100, 100)
  const midR = clamp(Math.round(browInner * 0.4 + browOuterR * 0.6), -100, 100)
  const tailL = browOuterL
  const tailR = browOuterR

  const cornerLX = clamp(50 + smileL * 0.35, 0, 100)
  const cornerRX = clamp(50 - smileR * 0.35, 0, 100)
  const cornerY = clamp(50 - Math.max(smileL, smileR) * 0.2, 0, 100)

  const rig = normalizeEliteRig({
    ...createInitialEliteRig(),
    browL: { x: 0, y: tipL, tipA: 0, tipB: 0, tip: tipL, mid: midL, tail: tailL },
    browR: { x: 0, y: tipR, tipA: 0, tipB: 0, tip: tipR, mid: midR, tail: tailR },
    eyeL: { up: eyeLUp, lo: eyeLLo, x: radarX, y: radarY },
    eyeR: { up: eyeRUp, lo: eyeRLo, x: radarX, y: radarY },
    sharedRadar: { x: radarX, y: radarY },
    mouth: {
      UL: upperL,
      UR: upperR,
      LL: lowerL,
      LR: lowerR,
      sideL: { x: cornerLX, y: cornerY },
      sideR: { x: cornerRX, y: cornerY },
    },
    jaw: { val: jaw, lateral: 0 },
  })

  const mapping = {
    jaw,
    blinkLeft: blinkL,
    blinkRight: blinkR,
    smileLeft: smileL,
    smileRight: smileR,
    browInner,
    browOuterLeft: browOuterL,
    browOuterRight: browOuterR,
    eyeOpenBiasLeft: bias,
    eyeOpenBiasRight: bias,
    eyeLUp,
    eyeLLo,
    eyeRUp,
    eyeRLo,
    browLeftTip: tipL,
    browLeftMid: midL,
    browLeftTail: tailL,
    browRightTip: tipR,
    browRightMid: midR,
    browRightTail: tailR,
    upperLipLeft: upperL,
    upperLipRight: upperR,
    lowerLipLeft: lowerL,
    lowerLipRight: lowerR,
    mouthPucker: toPct100(deadzoneUnipolar(b.mouthPucker, 0.03), 1),
    mouthFunnel: toPct100(deadzoneUnipolar(b.mouthFunnel, 0.03), 1),
    eyeLookX: clamp(lookX, -1, 1),
    eyeLookY: clamp(lookY, -1, 1),
    sharedRadarX: radarX,
    sharedRadarY: radarY,
  }

  return { rig, mapping }
}

/**
 * 与 Python estimate_tracking_quality 近似：按可用 blendshape 数量粗估。
 */
export function estimateBrowserTrackingQuality(faceDetected, blendCount) {
  if (!faceDetected) return 0
  const n = Number(blendCount) || 0
  if (n >= 48) return 0.96
  if (n >= 35) return 0.93
  if (n >= 12) return 0.88
  if (n > 0) return 0.82
  return 0.8
}
