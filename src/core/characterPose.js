/**
 * CharacterPose = Face Rig Snapshot + Neck 3DOF。
 * Face 与 Neck 分属不同设备子系统，同一 Character Animation。
 */

import { createInitialEliteRig, normalizeEliteRig } from "./faceDofMapper.js"
import {
  createNeutralNeckPose,
  normalizeNeckPose,
} from "../sdk/neck/neckPose.js"

/**
 * @typedef {{ face: object, neck: { pitch: number, roll: number, yaw: number } }} CharacterPose
 */

export function createNeutralCharacterPose() {
  return {
    face: createInitialEliteRig(),
    neck: createNeutralNeckPose(),
  }
}

/**
 * @param {object|null|undefined} raw
 * @param {{ neckLimits?: object, clampNeck?: boolean }} [opts]
 * @returns {CharacterPose}
 */
export function normalizeCharacterPose(raw, opts = {}) {
  const src = raw && typeof raw === "object" ? raw : {}
  let face = src.face
  // v2 compat：顶层即 face rig，或仅有 legacy rigSnapshot 外层传入
  if (!face || typeof face !== "object") {
    if (src.browL || src.jaw || src.eyeL) {
      face = src
    } else {
      face = createInitialEliteRig()
    }
  }
  return {
    face: normalizeEliteRig(face),
    neck: normalizeNeckPose(src.neck, {
      limits: opts.neckLimits,
      clamp: opts.clampNeck !== false,
    }),
  }
}

export function cloneCharacterPose(pose, opts = {}) {
  return normalizeCharacterPose(
    {
      face: pose?.face ? structuredClone(pose.face) : createInitialEliteRig(),
      neck: pose?.neck ? { ...pose.neck } : createNeutralNeckPose(),
    },
    opts
  )
}

/**
 * 从 v2 keyframe / rigSnapshot 构造 CharacterPose（Neck = Neutral）。
 */
export function characterPoseFromFaceRig(faceRig, opts = {}) {
  return normalizeCharacterPose(
    {
      face: faceRig,
      neck: createNeutralNeckPose(),
    },
    opts
  )
}

export function getFaceFromCharacterPose(pose) {
  return normalizeCharacterPose(pose).face
}

export function getNeckFromCharacterPose(pose) {
  return normalizeCharacterPose(pose).neck
}
