/**
 * Blendshape-only mouth / jaw / corners when landmark geometry is not ready.
 * Ports:
 *  - lip_geometry._blendshape_lip_signed_deltas (UL/UR/LL/LR)
 *  - mediapipe_to_rig smile pipe + mouth_corner diagonal-v1 (sideL/R)
 *  - jaw _semantic_strength_base + jawOutputSign (signed jaw.val)
 *  - pucker / funnel mapping percentages
 */

import {
  clampPct,
  clampSigned100,
  pipeUnipolarStrength,
  safeFloat,
  semanticStrengthBase,
} from "./trackingMath.js"
import { normalizeMappingConfig } from "./mappingConfig.js"

function blendScore(blend, key) {
  return safeFloat(blend?.[key], 0)
}

function blendshapeLipSignedDeltas(blend, cfg) {
  const { neutral, gains, invert, deadzone, limits } = cfg
  const lipCfg = cfg.lip && typeof cfg.lip === "object" ? cfg.lip : {}
  const limLip = Array.isArray(limits.lip) ? limits.lip : [0, 100]
  const loLp = safeFloat(limLip[0], 0)
  const hiLp = safeFloat(limLip[1], 100)
  const dzLip = safeFloat(deadzone.lip, 0.03)
  const upScale = safeFloat(lipCfg.upperScale, 100) / 100
  const loScale = safeFloat(lipCfg.lowerScale, 100) / 100

  const ullS = Math.max(0, blendScore(blend, "mouthUpperUpLeft") - safeFloat(neutral.mouthUpperUpLeft, 0))
  const ulrS = Math.max(0, blendScore(blend, "mouthUpperUpRight") - safeFloat(neutral.mouthUpperUpRight, 0))
  const lllS = Math.max(0, blendScore(blend, "mouthLowerDownLeft") - safeFloat(neutral.mouthLowerDownLeft, 0))
  const llrS = Math.max(0, blendScore(blend, "mouthLowerDownRight") - safeFloat(neutral.mouthLowerDownRight, 0))

  const ullV = pipeUnipolarStrength(ullS, {
    deadzoneThr: dzLip,
    gain: safeFloat(gains.upperLipLeft, 1),
    invert: Boolean(invert.upperLipLeft),
    limLo: loLp,
    limHi: hiLp,
  })
  const ulrV = pipeUnipolarStrength(ulrS, {
    deadzoneThr: dzLip,
    gain: safeFloat(gains.upperLipRight, 1),
    invert: Boolean(invert.upperLipRight),
    limLo: loLp,
    limHi: hiLp,
  })
  const lllV = pipeUnipolarStrength(lllS, {
    deadzoneThr: dzLip,
    gain: safeFloat(gains.lowerLipLeft, 1),
    invert: false,
    limLo: loLp,
    limHi: hiLp,
  })
  const llrV = pipeUnipolarStrength(llrS, {
    deadzoneThr: dzLip,
    gain: safeFloat(gains.lowerLipRight, 1),
    invert: false,
    limLo: loLp,
    limHi: hiLp,
  })

  return {
    UL: clampSigned100(Math.abs(ullV * upScale)),
    UR: clampSigned100(Math.abs(ulrV * upScale)),
    LL: clampSigned100(-Math.abs(lllV * loScale)),
    LR: clampSigned100(-Math.abs(llrV * loScale)),
  }
}

function smilePair(blend, cfg) {
  const { neutral, gains, invert, deadzone, limits } = cfg
  const limSm = Array.isArray(limits.smile) ? limits.smile : [0, 100]
  const loS = safeFloat(limSm[0], 0)
  const hiS = safeFloat(limSm[1], 100)
  const dz = safeFloat(deadzone.smile, 0.03)
  const smileL = pipeUnipolarStrength(
    blendScore(blend, "mouthSmileLeft") - safeFloat(neutral.mouthSmileLeft, 0),
    {
      deadzoneThr: dz,
      gain: safeFloat(gains.smileLeft, 1),
      invert: Boolean(invert.smileLeft),
      limLo: loS,
      limHi: hiS,
    },
  )
  const smileR = pipeUnipolarStrength(
    blendScore(blend, "mouthSmileRight") - safeFloat(neutral.mouthSmileRight, 0),
    {
      deadzoneThr: dz,
      gain: safeFloat(gains.smileRight, 1),
      invert: Boolean(invert.smileRight),
      limLo: loS,
      limHi: hiS,
    },
  )
  return { smileL, smileR }
}

/**
 * Diagonal-v1 smile → side pads (mouth_corner_geometry.project_mouth_corners_diagonal_v1).
 */
function diagonalSmilePads(smileL, smileR, sx = 0.35, sy = 0.25) {
  return {
    sideL: {
      x: clampPct(50 - smileL * sx),
      y: clampPct(50 - smileL * sy),
    },
    sideR: {
      x: clampPct(50 + smileR * sx),
      y: clampPct(50 - smileR * sy),
    },
  }
}

/**
 * @param {Record<string, number>} blendshapes
 * @param {object} [config]
 */
export function mapMouthFromBlendshapes(blendshapes = {}, config) {
  const cfg = normalizeMappingConfig(config)
  const blend = blendshapes && typeof blendshapes === "object" ? blendshapes : {}
  const lips = blendshapeLipSignedDeltas(blend, cfg)
  const { smileL, smileR } = smilePair(blend, cfg)
  const pads = diagonalSmilePads(smileL, smileR)

  const jawBsName = "jawOpen"
  const jawCent = blendScore(blend, jawBsName) - safeFloat(cfg.neutral[jawBsName], 0)
  const jawOpen = semanticStrengthBase(jawCent, {
    deadzoneThr: safeFloat(cfg.deadzone.jaw, 0.03),
    gain: safeFloat(cfg.gains.jaw, 1),
    limLo: 0,
    limHi: 100,
  })
  const jawSign = cfg.invert.jaw ? -1 : 1
  const jawVal = clampSigned100(jawSign * jawOpen)

  const puck = Math.max(0, blendScore(blend, "mouthPucker") - safeFloat(cfg.neutral.mouthPucker, 0))
  const funnel = Math.max(0, blendScore(blend, "mouthFunnel") - safeFloat(cfg.neutral.mouthFunnel, 0))

  return {
    mouth: {
      UL: lips.UL,
      UR: lips.UR,
      LL: lips.LL,
      LR: lips.LR,
      sideL: pads.sideL,
      sideR: pads.sideR,
    },
    jaw: { val: jawVal },
    mapping: {
      smileLeft: smileL,
      smileRight: smileR,
      upperLipLeft: lips.UL,
      upperLipRight: lips.UR,
      lowerLipLeft: lips.LL,
      lowerLipRight: lips.LR,
      jaw: jawVal,
      mouthPucker: clampPct(puck * 100),
      mouthFunnel: clampPct(funnel * 100),
    },
  }
}

export { blendshapeLipSignedDeltas, smilePair, diagonalSmilePads }
