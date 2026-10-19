/**
 * browInnerUp / browOuterUpLeft/Right → browL/R tip/mid/tail (0..100).
 * Port of mediapipe_to_rig.py brow mapping (pre-gate).
 */

import { applyInvertUnipolar, clampPct, pipeUnipolarStrength, safeFloat } from "./trackingMath.js"
import { normalizeMappingConfig } from "./mappingConfig.js"

function blendScore(blend, key) {
  return safeFloat(blend?.[key], 0)
}

function normBrowSlot(name, fallback) {
  const s = String(name || fallback).trim().toLowerCase()
  return s === "tip" || s === "tail" ? s : fallback
}

/**
 * @param {Record<string, number>} blendshapes
 * @param {object} [config]
 * @returns {{
 *   browL:{tip:number,mid:number,tail:number},
 *   browR:{tip:number,mid:number,tail:number},
 *   mapping: Record<string, number>
 * }}
 */
export function mapBrowsFromBlendshapes(blendshapes = {}, config) {
  const cfg = normalizeMappingConfig(config)
  const blend = blendshapes && typeof blendshapes === "object" ? blendshapes : {}
  const { neutral, gains, invert, deadzone, limits, brow: browCfg } = cfg

  const limBp = Array.isArray(limits.browPoint) ? limits.browPoint : [0, 100]
  const loBp = safeFloat(limBp[0], 0)
  const hiBp = safeFloat(limBp[1], 100)
  const dzb = safeFloat(deadzone.brow, 0.03)

  const pipe = (cent, gainKey, invertKey) =>
    pipeUnipolarStrength(cent, {
      deadzoneThr: dzb,
      gain: safeFloat(gains[gainKey], 1),
      invert: Boolean(invert[invertKey]),
      limLo: loBp,
      limHi: hiBp,
    })

  const biS = Math.max(0, blendScore(blend, "browInnerUp") - safeFloat(neutral.browInnerUp, 0))
  const bolS = Math.max(0, blendScore(blend, "browOuterUpLeft") - safeFloat(neutral.browOuterUpLeft, 0))
  const borS = Math.max(0, blendScore(blend, "browOuterUpRight") - safeFloat(neutral.browOuterUpRight, 0))

  const biV = pipe(biS, "browInner", "browInner")
  const bolV = pipe(bolS, "browOuterLeft", "browOuterLeft")
  const borV = pipe(borS, "browOuterRight", "browOuterRight")

  const wIn = safeFloat(browCfg.midInnerWeight, 0.4)
  const wOut = safeFloat(browCfg.midOuterWeight, 0.6)

  const tipL = clampPct(
    applyInvertUnipolar(
      clampPct(biV * safeFloat(gains.browTipLeft, 1)),
      Boolean(invert.browTipLeft),
      0,
      100,
    ),
  )
  const tailL = clampPct(
    applyInvertUnipolar(
      clampPct(bolV * safeFloat(gains.browTailLeft, 1)),
      Boolean(invert.browTailLeft),
      0,
      100,
    ),
  )
  const midL = clampPct(biV * wIn + bolV * wOut)

  const tipR = clampPct(
    applyInvertUnipolar(
      clampPct(biV * safeFloat(gains.browTipRight, 1)),
      Boolean(invert.browTipRight),
      0,
      100,
    ),
  )
  const tailR = clampPct(
    applyInvertUnipolar(
      clampPct(borV * safeFloat(gains.browTailRight, 1)),
      Boolean(invert.browTailRight),
      0,
      100,
    ),
  )
  const midR = clampPct(biV * wIn + borV * wOut)

  let ltTip = normBrowSlot(browCfg.leftTipChannel, "tip")
  let ltTail = normBrowSlot(browCfg.leftTailChannel, "tail")
  if (ltTip === ltTail) ltTail = ltTip === "tip" ? "tail" : "tip"

  let rtTip = normBrowSlot(browCfg.rightTipChannel, "tip")
  let rtTail = normBrowSlot(browCfg.rightTailChannel, "tail")
  if (rtTip === rtTail) rtTail = rtTip === "tip" ? "tail" : "tip"

  const browL = { tip: 0, mid: midL, tail: 0 }
  const browR = { tip: 0, mid: midR, tail: 0 }
  browL[ltTip] = tipL
  browL[ltTail] = tailL
  browR[rtTip] = tipR
  browR[rtTail] = tailR

  return {
    browL,
    browR,
    mapping: {
      browInner: biV,
      browOuterLeft: bolV,
      browOuterRight: borV,
      browLeftTip: browL.tip,
      browLeftMid: browL.mid,
      browLeftTail: browL.tail,
      browRightTip: browR.tip,
      browRightMid: browR.mid,
      browRightTail: browR.tail,
      browLeft: midL,
      browRight: midR,
    },
  }
}
