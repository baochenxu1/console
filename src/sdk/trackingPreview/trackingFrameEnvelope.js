/**
 * Tracking 帧原子信封：mapping / binding / device / timing 必须绑定同一 frameSeq。
 */

/**
 * @param {object} parts
 * @returns {object}
 */
export function createTrackingFrameEnvelope({
  frameSeq = null,
  frameIndex = null,
  timestampMs = null,
  source = null,
  faceRig = null,
  mapping = null,
  binding = null,
  device = null,
  safety = null,
  diagnostic = null,
  pipelineStateDebug = null,
} = {}) {
  const seq = normalizeFrameSeq(frameSeq)
  return {
    frameSeq: seq,
    frameIndex: Number.isFinite(Number(frameIndex)) ? Number(frameIndex) : null,
    timestampMs: Number.isFinite(Number(timestampMs)) ? Number(timestampMs) : null,
    source: source ? { ...source, frameSeq: normalizeFrameSeq(source.frameSeq ?? seq) } : null,
    faceRig: faceRig ? { ...faceRig, frameSeq: normalizeFrameSeq(faceRig.frameSeq ?? seq) } : null,
    mapping: mapping ? { ...mapping, frameSeq: normalizeFrameSeq(mapping.frameSeq ?? seq) } : null,
    binding: binding ? { ...binding, frameSeq: normalizeFrameSeq(binding.frameSeq ?? seq) } : null,
    device: device ? { ...device, frameSeq: normalizeFrameSeq(device.frameSeq ?? seq) } : null,
    safety: safety ? { ...safety, frameSeq: normalizeFrameSeq(safety.frameSeq ?? seq) } : null,
    diagnostic: diagnostic
      ? { ...diagnostic, frameSeq: normalizeFrameSeq(diagnostic.frameSeq ?? seq) }
      : null,
    pipelineStateDebug: pipelineStateDebug || null,
  }
}

/**
 * @param {number | string | null | undefined} v
 * @returns {number | null}
 */
export function normalizeFrameSeq(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * 检查各层 frameSeq 是否一致。
 * @param {object} parts
 * @returns {{ sourceSeq: number | null, mappingSeq: number | null, faceRigSeq: number | null, bindingSeq: number | null, deviceSeq: number | null, safetySeq: number | null, timingSeq: number | null, consistent: boolean, mismatchFields: string[] }}
 */
export function buildFrameConsistency({
  sourceSeq = null,
  mappingSeq = null,
  faceRigSeq = null,
  bindingSeq = null,
  deviceSeq = null,
  safetySeq = null,
  timingSeq = null,
} = {}) {
  const fields = {
    sourceSeq: normalizeFrameSeq(sourceSeq),
    mappingSeq: normalizeFrameSeq(mappingSeq),
    faceRigSeq: normalizeFrameSeq(faceRigSeq),
    bindingSeq: normalizeFrameSeq(bindingSeq),
    deviceSeq: normalizeFrameSeq(deviceSeq),
    safetySeq: normalizeFrameSeq(safetySeq),
    timingSeq: normalizeFrameSeq(timingSeq),
  }

  const present = Object.entries(fields).filter(([, v]) => v != null)
  const mismatchFields = []
  let consistent = true

  if (present.length >= 2) {
    const anchor = present[0][1]
    for (const [key, val] of present) {
      if (val !== anchor) {
        consistent = false
        mismatchFields.push(key)
      }
    }
  }

  return {
    ...fields,
    consistent,
    mismatchFields,
  }
}

/**
 * 按 frameSeq 查找真实发送快照（recorder 用；无快照 = 本帧未发送，非 seq 错误）。
 * @param {number | null} sourceSeq
 * @param {Map<number, object> | Record<number, object> | null | undefined} snapshots
 */
export function resolveRealSendSnapshotForFrame(sourceSeq, snapshots) {
  const srcSeq = normalizeFrameSeq(sourceSeq)
  if (srcSeq == null) {
    return { snapshot: null, matched: false, reason: "source-seq-missing" }
  }
  if (!snapshots) {
    return { snapshot: null, matched: false, reason: "no-send-snapshots" }
  }
  const snap =
    snapshots instanceof Map
      ? snapshots.get(srcSeq)
      : snapshots[srcSeq] ?? snapshots[String(srcSeq)] ?? null
  if (snap) {
    return { snapshot: snap, matched: true, reason: "snapshot-matched" }
  }
  return { snapshot: null, matched: false, reason: "not-sent-this-frame" }
}

/**
 * device 调试快照仅在与 source 同 seq 时合并（legacy envelope 路径）。
 * @param {number | null} sourceSeq
 * @param {object | null} deviceDebug
 */
export function resolveDeviceDebugForFrame(sourceSeq, deviceDebug) {
  if (!deviceDebug || typeof deviceDebug !== "object") {
    return { deviceDebug: null, matched: false, reason: "no-device-debug" }
  }
  const devSeq = normalizeFrameSeq(deviceDebug.frameSeq)
  const srcSeq = normalizeFrameSeq(sourceSeq)
  if (srcSeq == null) {
    return { deviceDebug, matched: true, reason: "source-seq-missing" }
  }
  if (devSeq == null) {
    return { deviceDebug: null, matched: false, reason: "device-seq-missing" }
  }
  if (devSeq !== srcSeq) {
    return { deviceDebug: null, matched: false, reason: "not-sent-this-frame" }
  }
  return { deviceDebug, matched: true, reason: "matched" }
}
