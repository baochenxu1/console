/**
 * Tracking pipeline 输入入口：接收 TrackingInputFrame metadata，产出/增强 RigFrame。
 * Phase 0：WebSocket 路径在 Python 完成推理；浏览器侧仅归一化 inputSource 并挂到 debug。
 */

import { normalizeInputSource, resolveInputSourceFromRigFrame } from "./input/trackingInputFrame.js"

/** @typedef {import("./input/trackingInputFrame.js").TrackingInputFrame} TrackingInputFrame */
/** @typedef {import("./trackingTypes.js").RigFrame} RigFrame */

/**
 * 将 inputSource 诊断块合并进 RigFrame debug（不修改 rig 数值）。
 * @param {RigFrame | null | undefined} rigFrame
 * @param {import("./input/trackingInputFrame.js").TrackingInputSourceDebug | undefined} inputSource
 * @returns {RigFrame | null | undefined}
 */
export function attachInputSourceToRigFrame(rigFrame, inputSource) {
  if (!rigFrame || typeof rigFrame !== "object" || !inputSource) {
    return rigFrame
  }
  const debug =
    rigFrame.debug && typeof rigFrame.debug === "object"
      ? { ...rigFrame.debug }
      : {}
  debug.inputSource = inputSource
  return { ...rigFrame, debug }
}

/**
 * WebSocket / 已构建 RigFrame：从 debug 解析并补齐 inputSource。
 * @param {RigFrame | null | undefined} rigFrame
 * @returns {RigFrame | null | undefined}
 */
export function processTrackingRigFrame(rigFrame) {
  if (!rigFrame || typeof rigFrame !== "object") {
    return rigFrame
  }
  const inputSource = resolveInputSourceFromRigFrame(rigFrame)
  return attachInputSourceToRigFrame(rigFrame, inputSource)
}

/**
 * 浏览器本地 pipeline 入口（Phase 0 占位）：校验 envelope 并返回 metadata。
 * 实际 MediaPipe 推理当前在 Python；后续 video adapter 可在此扩展。
 *
 * @param {TrackingInputFrame} inputFrame
 * @returns {{ inputSource: import("./input/trackingInputFrame.js").TrackingInputSourceDebug, image: TrackingInputFrame["image"], timestampMs: number }}
 */
export function processTrackingInputFrame(inputFrame) {
  if (!inputFrame || typeof inputFrame !== "object") {
    throw new Error("processTrackingInputFrame: inputFrame required")
  }
  const inputSource = normalizeInputSource({
    sourceType: inputFrame.sourceType,
    sourceId: inputFrame.sourceId,
    sourceSeq: inputFrame.sourceSeq,
    frameIndex: inputFrame.frameIndex,
    timestampMs: inputFrame.timestampMs,
    videoTimeMs: inputFrame.videoTimeMs ?? null,
    playbackRate: inputFrame.playbackRate ?? null,
    paused: inputFrame.paused ?? false,
    seeking: inputFrame.seeking ?? false,
    seekEpoch: inputFrame.seekEpoch ?? 0,
  })
  if (!inputSource) {
    throw new Error("processTrackingInputFrame: invalid inputFrame envelope")
  }
  return {
    inputSource,
    image: inputFrame.image,
    timestampMs: inputFrame.timestampMs,
  }
}
