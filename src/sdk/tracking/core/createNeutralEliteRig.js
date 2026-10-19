/**
 * Neutral Elite Rig — matches mediapipe_to_rig.create_neutral_rig.
 */

export function createNeutralEliteRig() {
  return {
    browL: { tip: 0, mid: 0, tail: 0 },
    browR: { tip: 0, mid: 0, tail: 0 },
    eyeL: { up: 0, lo: 0 },
    eyeR: { up: 0, lo: 0 },
    sharedRadar: { x: 50, y: 50 },
    mouth: {
      UL: 0,
      UR: 0,
      LL: 0,
      LR: 0,
      sideL: { x: 50, y: 50 },
      sideR: { x: 50, y: 50 },
    },
    tongue: { val: 0 },
    jaw: { val: 0 },
  }
}
