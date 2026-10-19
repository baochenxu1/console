/**
 * eyeBlink / eyeWide blendshapes → eyeL/R.up/lo.
 * Port of mediapipe_to_rig.py blink + open-bias mapping.
 */

import { clampSigned100, pipeUnipolarStrength, safeFloat } from "./trackingMath.js"
import { normalizeMappingConfig } from "./mappingConfig.js"

function blendScore(blend, key) {
  return safeFloat(blend?.[key], 0)
}

/**
 * @param {Record<string, number>} blendshapes
 * @param {object} [config]
 * @returns {{ eyeL:{up:number,lo:number}, eyeR:{up:number,lo:number}, mapping: Record<string, number> }}
 */
export function mapEyesFromBlendshapes(blendshapes = {}, config) {
  const cfg = normalizeMappingConfig(config)
  const blend = blendshapes && typeof blendshapes === "object" ? blendshapes : {}
  const { neutral, gains, invert, deadzone, limits, eye: eyeCfg } = cfg

  const limBl = Array.isArray(limits.blink) ? limits.blink : [0, 100]
  const loB = safeFloat(limBl[0], 0)
  const hiB = safeFloat(limBl[1], 100)
  const dzBlink = safeFloat(deadzone.blink, 0.03)

  const eblCent = blendScore(blend, "eyeBlinkLeft") - safeFloat(neutral.eyeBlinkLeft, 0)
  const blinkL = pipeUnipolarStrength(eblCent, {
    deadzoneThr: dzBlink,
    gain: safeFloat(gains.blinkLeft, 1),
    invert: Boolean(invert.blinkLeft),
    limLo: loB,
    limHi: hiB,
  })

  const ebrCent = blendScore(blend, "eyeBlinkRight") - safeFloat(neutral.eyeBlinkRight, 0)
  const blinkR = pipeUnipolarStrength(ebrCent, {
    deadzoneThr: dzBlink,
    gain: safeFloat(gains.blinkRight, 1),
    invert: Boolean(invert.blinkRight),
    limLo: loB,
    limHi: hiB,
  })

  const biasL = safeFloat(eyeCfg.openBiasLeft, 20)
  const biasR = safeFloat(eyeCfg.openBiasRight, 20)
  const ratioOpen = safeFloat(eyeCfg.lowerLidOpenRatio, 0.25)
  const ratioClose = safeFloat(eyeCfg.lowerLidCloseRatio, 0.5)
  const useWide = Boolean(eyeCfg.useEyeWide)
  const wideScale = safeFloat(eyeCfg.eyeWideScale, 30)

  let wideL = 0
  let wideR = 0
  if (useWide) {
    wideL = Math.max(0, blendScore(blend, "eyeWideLeft") - safeFloat(neutral.eyeWideLeft, 0))
    wideR = Math.max(0, blendScore(blend, "eyeWideRight") - safeFloat(neutral.eyeWideRight, 0))
  }
  const boostL = useWide ? wideL * wideScale : 0
  const boostR = useWide ? wideR * wideScale : 0

  const eyeL = {
    up: clampSigned100(biasL - blinkL + boostL),
    lo: clampSigned100(blinkL * ratioClose - biasL * ratioOpen),
  }
  const eyeR = {
    up: clampSigned100(biasR - blinkR + boostR),
    lo: clampSigned100(blinkR * ratioClose - biasR * ratioOpen),
  }

  return {
    eyeL,
    eyeR,
    mapping: {
      blinkLeft: blinkL,
      blinkRight: blinkR,
      eyeOpenBiasLeft: biasL,
      eyeOpenBiasRight: biasR,
      eyeLUp: eyeL.up,
      eyeLLo: eyeL.lo,
      eyeRUp: eyeR.up,
      eyeRLo: eyeR.lo,
    },
  }
}
