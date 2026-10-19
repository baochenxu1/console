/**
 * Canonical builtin Preset animation clips (semantic CharacterPose patches).
 *
 * Future authoring path:
 *   表情编排 → export clip → validate closedClip → register here → Catalog metadata
 *
 * Content is currently demo-quality placeholders for playback wiring.
 * Do NOT tune motion inside Preset page JSX.
 */

export const BUILTIN_PRESET_CONTENT_KIND = "BUILTIN_DEMO_CONTENT"

/** All current builtins need motion tuning in the expression editor. */
export const BUILTIN_PRESET_NEEDS_MOTION_TUNING = true

const N = Object.freeze({})
const NECK0 = Object.freeze({ pitch: 0, roll: 0, yaw: 0 })

function closedClip(durationMs, peaks) {
  const keyframes = [{ timeMs: 0, face: N, neck: NECK0 }]
  for (const p of peaks) {
    keyframes.push({
      timeMs: p.timeMs,
      face: p.face || N,
      neck: p.neck || NECK0,
    })
  }
  keyframes.push({
    timeMs: durationMs,
    face: N,
    neck: NECK0,
  })
  return Object.freeze({
    contentKind: BUILTIN_PRESET_CONTENT_KIND,
    needsMotionTuning: BUILTIN_PRESET_NEEDS_MOTION_TUNING,
    durationMs,
    keyframes: Object.freeze(keyframes.map((k) => Object.freeze({ ...k }))),
  })
}

/**
 * clipId → semantic keyframe clip (face/neck patches only; no servo/PWM).
 */
export const EXPRESSION_PRESET_BUILTIN_CLIPS = Object.freeze({
  "natural-smile": closedClip(1200, [
    {
      timeMs: 450,
      face: {
        mouth: { UL: 28, UR: 28, LL: 18, LR: 18, sideL: { x: 42, y: 58 }, sideR: { x: 58, y: 58 } },
      },
    },
  ]),
  "happy-laugh": closedClip(1800, [
    {
      timeMs: 280,
      face: {
        mouth: { UL: 42, UR: 42, LL: 36, LR: 36, sideL: { x: 38, y: 62 }, sideR: { x: 62, y: 62 } },
        jaw: { val: 18, lateral: 0 },
        eyeL: { up: -8, lo: 12 },
        eyeR: { up: -8, lo: 12 },
      },
    },
    {
      timeMs: 1100,
      face: {
        mouth: { UL: 48, UR: 48, LL: 40, LR: 40, sideL: { x: 36, y: 64 }, sideR: { x: 64, y: 64 } },
        jaw: { val: 28, lateral: 0 },
        eyeL: { up: -10, lo: 16 },
        eyeR: { up: -10, lo: 16 },
      },
    },
  ]),
  surprise: closedClip(1400, [
    {
      timeMs: 220,
      face: {
        browL: { y: 42, tip: 18, mid: 22, tail: 12 },
        browR: { y: 42, tip: 18, mid: 22, tail: 12 },
        eyeL: { up: -22, lo: -8 },
        eyeR: { up: -22, lo: -8 },
        jaw: { val: 36, lateral: 0 },
        mouth: { UL: 8, UR: 8, LL: 10, LR: 10 },
      },
    },
  ]),
  confused: closedClip(1600, [
    {
      timeMs: 500,
      face: {
        browL: { y: 28, tip: 20, mid: 8, tail: -6 },
        browR: { y: -12, tip: -8, mid: -10, tail: -4 },
        eyeL: { x: 46, y: 56 },
        eyeR: { x: 58, y: 48 },
      },
      neck: { pitch: 0, roll: 0, yaw: 10 },
    },
  ]),
  angry: closedClip(1600, [
    {
      timeMs: 400,
      face: {
        browL: { y: -32, tip: -18, mid: -22, tail: -10 },
        browR: { y: -32, tip: -18, mid: -22, tail: -10 },
        mouth: { UL: -12, UR: -12, LL: 8, LR: 8, sideL: { x: 46, y: 40 }, sideR: { x: 54, y: 40 } },
        eyeL: { up: 8, lo: 10 },
        eyeR: { up: 8, lo: 10 },
      },
    },
  ]),
  "wink-hello": closedClip(1000, [
    {
      timeMs: 180,
      face: {
        mouth: { UL: 16, UR: 16, LL: 10, LR: 10 },
        eyeL: { up: 55, lo: 55 },
        browL: { y: -8 },
      },
    },
    {
      timeMs: 420,
      face: {
        mouth: { UL: 20, UR: 20, LL: 12, LR: 12 },
        eyeL: { up: 0, lo: 0 },
      },
    },
  ]),
})

export function getBuiltinPresetClip(clipId) {
  return EXPRESSION_PRESET_BUILTIN_CLIPS[clipId] || null
}

export function listBuiltinPresetClipIds() {
  return Object.keys(EXPRESSION_PRESET_BUILTIN_CLIPS)
}
