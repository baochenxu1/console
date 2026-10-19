import { buildKeyframeCommand, playKeyframe, playKeyframes } from "../../core/actionPlayer.js"

export { buildKeyframeCommand, playKeyframe, playKeyframes }

export function buildCommandPreviewForKeyframe(keyframe, configs) {
  return buildKeyframeCommand({ keyframe, configs })
}
