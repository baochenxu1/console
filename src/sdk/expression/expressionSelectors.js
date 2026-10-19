import { normalizeFrameProject } from "../../core/frameProject.js"

export function getNormalizedProject(project, configs = []) {
  return normalizeFrameProject(project, configs)
}

export function selectKeyframes(project, configs = []) {
  return normalizeFrameProject(project, configs).keyframes ?? []
}

export function selectKeyframeByIndex(project, configs, index) {
  const kf = selectKeyframes(project, configs)
  const i = Math.max(0, Math.min(Number(index) || 0, kf.length - 1))
  return kf[i] ?? null
}
