import { createInitialEliteRig, normalizeEliteRig } from "../../core/faceDofMapper.js"
import { createNeutralNeckPose, normalizeNeckPose } from "../neck/neckPose.js"
import { normalizeCharacterPose } from "../../core/characterPose.js"
import {
  createDefaultProjectModules,
  createKeyframe,
  FRAME_PROJECT_TYPE,
  FRAME_PROJECT_VERSION,
  normalizeFrameProject,
} from "../../core/frameProject.js"

function isPlainObject(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v)
}

function mergeDeep(base, patch) {
  if (!isPlainObject(patch)) {
    return base
  }
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = mergeDeep(out[k], v)
    } else {
      out[k] = v
    }
  }
  return out
}

export function applyFacePatch(facePatch) {
  return normalizeEliteRig(mergeDeep(createInitialEliteRig(), facePatch || {}))
}

export function applyNeckPatch(neckPatch) {
  if (!neckPatch) {
    return createNeutralNeckPose()
  }
  return normalizeNeckPose({ ...createNeutralNeckPose(), ...neckPatch })
}

export function poseFromClipKeyframe(rawKf = {}) {
  if (rawKf.characterPose) {
    return normalizeCharacterPose(rawKf.characterPose)
  }
  return normalizeCharacterPose({
    face: applyFacePatch(rawKf.face),
    neck: applyNeckPatch(rawKf.neck),
  })
}

export function clipEndsAtNeutral(clip) {
  const kfs = Array.isArray(clip?.keyframes) ? clip.keyframes : []
  if (kfs.length < 2) {
    return false
  }
  const last = poseFromClipKeyframe(kfs[kfs.length - 1])
  const first = poseFromClipKeyframe(kfs[0])
  const nFace = createInitialEliteRig()
  const nNeck = createNeutralNeckPose()
  return (
    JSON.stringify(last.face) === JSON.stringify(nFace) &&
    JSON.stringify(last.neck) === JSON.stringify(nNeck) &&
    JSON.stringify(first.face) === JSON.stringify(nFace) &&
    JSON.stringify(first.neck) === JSON.stringify(nNeck)
  )
}

export function buildPresetFrameProject(preset, configs = []) {
  if (preset?.animation && Array.isArray(preset.animation.keyframes)) {
    return normalizeFrameProject(
      {
        ...preset.animation,
        expressionId: String(preset.id || preset.animation.expressionId || "preset"),
        expressionName: String(preset.name || preset.animation.expressionName || "preset"),
        timelineDurationMs: Math.max(
          Number(preset.durationMs) || 0,
          Number(preset.animation.timelineDurationMs) || 0,
          1
        ),
      },
      configs
    )
  }
  const clip = preset?.clip || {}
  const raw = Array.isArray(clip.keyframes) ? clip.keyframes : []
  const keyframes = raw.map((kf, index) => {
    const pose = poseFromClipKeyframe(kf)
    return createKeyframe({
      name: `${preset?.name || "preset"} ${index + 1}`,
      timeMs: Math.max(0, Math.round(Number(kf.timeMs) || 0)),
      durationMs: 20,
      characterPose: pose,
      rigSnapshot: pose.face,
      configs,
    })
  })
  const lastT = keyframes.length ? Math.max(...keyframes.map((k) => k.timeMs)) : 0
  const project = {
    version: FRAME_PROJECT_VERSION,
    projectType: FRAME_PROJECT_TYPE,
    expressionId: String(preset?.id || "preset"),
    expressionName: String(preset?.name || "preset"),
    timelineDurationMs: Math.max(lastT, Number(preset?.durationMs) || 0, 1),
    keyframes,
    modules: createDefaultProjectModules(),
    updatedAt: new Date().toISOString(),
  }
  return normalizeFrameProject(project, configs)
}
