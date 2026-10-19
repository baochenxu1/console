/**
 * mediapipe_iris_only_v1 — eye-local iris offset → sharedRadar.
 * Faithful port of tools/tracking_service/gaze_iris_only.py (no DOM).
 */

import { clamp, lerp, safeFloat, softNorm } from "./trackingMath.js"
import { normalizeMappingConfig } from "./mappingConfig.js"

export const LEFT_IRIS_IDX = Object.freeze([468, 469, 470, 471, 472])
export const RIGHT_IRIS_IDX = Object.freeze([473, 474, 475, 476, 477])
export const LEFT_EYE_OUTER = 33
export const LEFT_EYE_INNER = 133
export const RIGHT_EYE_OUTER = 263
export const RIGHT_EYE_INNER = 362

export const IRIS_ONLY_MODE = "mediapipe_iris_only_v1"

const IRIS_RUNTIME_POP_KEYS = [
  "_iris_init_session",
  "iris_init",
  "baseline_lx",
  "baseline_ly",
  "_warmup_lx",
  "_warmup_ly",
  "iris_warmup_frame",
  "iris_blink_hold",
  "iris_blink_freeze_active",
  "iris_blink_release_count",
  "iris_blink_freeze_frames",
  "iris_blink_level",
  "iris_blink_release_blend",
  "iris_blink_release_from",
  "iris_blink_last_hold",
]

function getLandmarkXy(landmarks, index) {
  if (!Array.isArray(landmarks) || index < 0 || index >= landmarks.length) return null
  const p = landmarks[index]
  if (p == null) return null
  let x
  let y
  if (typeof p === "object" && !Array.isArray(p)) {
    x = p.x
    y = p.y
  } else if (Array.isArray(p) && p.length >= 2) {
    x = p[0]
    y = p[1]
  }
  const xf = typeof x === "number" ? x : Number(x)
  const yf = typeof y === "number" ? y : Number(y)
  if (!Number.isFinite(xf) || !Number.isFinite(yf)) return null
  return [xf, yf]
}

function median(values) {
  if (!values || values.length === 0) return 0
  const s = values.slice().sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  if (s.length % 2) return s[mid]
  return (s[mid - 1] + s[mid]) / 2
}

function pickIrisYGain(driveY, ySign, gz) {
  const upGain = safeFloat(gz.irisYGainUp, safeFloat(gz.irisYGain, 5))
  const downGain = safeFloat(gz.irisYGainDown, upGain * safeFloat(gz.irisYGainDownRatio, 2.6))
  const effective = driveY * ySign
  return effective < 0 ? downGain : upGain
}

function frameHeadMotionPx(st) {
  const fm = st.init_frame_motion
  if (!fm || typeof fm !== "object") return 0
  return Math.max(
    safeFloat(fm.noseDeltaPx, 0),
    safeFloat(fm.eyeCenterDeltaPx, 0),
    safeFloat(fm.faceBoxCenterDeltaPx, 0),
  )
}

function computeEyeLocalIrisOffset(lm, irisIndices, outerIdx, innerIdx) {
  const irisPts = []
  for (const i of irisIndices) {
    const p = getLandmarkXy(lm, i)
    if (p) irisPts.push(p)
  }
  if (irisPts.length < 2) return null

  const outer = getLandmarkXy(lm, outerIdx)
  const inner = getLandmarkXy(lm, innerIdx)
  if (!outer || !inner) return null

  const irisCx = irisPts.reduce((s, p) => s + p[0], 0) / irisPts.length
  const irisCy = irisPts.reduce((s, p) => s + p[1], 0) / irisPts.length
  const eyeCx = (outer[0] + inner[0]) * 0.5
  const eyeCy = (outer[1] + inner[1]) * 0.5

  const vx = inner[0] - outer[0]
  const vy = inner[1] - outer[1]
  const eyeWidth = Math.hypot(vx, vy)
  if (eyeWidth < 1e-6) return null

  const ux = vx / eyeWidth
  const uy = vy / eyeWidth
  const perpX = -uy
  const perpY = ux

  const rx = irisCx - eyeCx
  const ry = irisCy - eyeCy
  let localX = (rx * ux + ry * uy) / eyeWidth
  let localY = (rx * perpX + ry * perpY) / eyeWidth
  localX = clamp(localX, -1.5, 1.5)
  localY = clamp(localY, -1.5, 1.5)
  return [localX, localY, eyeWidth]
}

function fuseBinocularIrisLocal(leftLocal, rightLocal) {
  if (leftLocal && rightLocal) {
    const localX = (leftLocal[0] - rightLocal[0]) * 0.5
    const localY = (leftLocal[1] - rightLocal[1]) * 0.5
    const localScale = Math.max(leftLocal[2], rightLocal[2])
    return [localX, localY, localScale, "binocular_difference_v1"]
  }
  if (leftLocal) return [leftLocal[0], leftLocal[1], leftLocal[2], "monocular_left_v1"]
  if (rightLocal) return [rightLocal[0], rightLocal[1], rightLocal[2], "monocular_right_v1"]
  return null
}

function irisInvalidReason(lm, iris) {
  if (!lm || !lm.length) return "no_landmarks"
  const n = lm.length
  if (n < 468) return `landmark_count_${n}`
  if (n < 478) return `landmark_count_${n}_need_iris_478`
  if (!iris.valid) {
    const scale = iris.irisLocalScale
    if (typeof scale === "number" && Number.isFinite(scale)) return "scale_out_of_range"
    return "iris_local_compute_failed"
  }
  return ""
}

function irisBlinkLevel(rawBlinkL, rawBlinkR) {
  return Math.max(safeFloat(rawBlinkL), safeFloat(rawBlinkR))
}

function irisBlinkEnterThreshold(gz) {
  return safeFloat(gz.blinkFreezeEnterThreshold, safeFloat(gz.blinkFreezeThreshold, 0.48))
}

function irisBlinkReleaseThreshold(gz) {
  return safeFloat(gz.blinkFreezeReleaseThreshold, 0.38)
}

function irisBlinkInstantThreshold(gz) {
  return safeFloat(gz.blinkInstantHoldThreshold, 0.42)
}

function freezeOnBlinkEnabled(gz) {
  return gz.freezeOnBlink !== false
}

function irisBlinkBlocksWarmup(rawBlinkL, rawBlinkR, gz) {
  if (!freezeOnBlinkEnabled(gz)) return false
  const blink = irisBlinkLevel(rawBlinkL, rawBlinkR)
  const thr = safeFloat(gz.blinkWarmupBlockThreshold, irisBlinkEnterThreshold(gz))
  return blink >= thr
}

function cloneIrisState(state) {
  const src = state && typeof state === "object" ? state : {}
  const next = { ...src }
  if (src.last_emit && typeof src.last_emit === "object") {
    next.last_emit = { ...src.last_emit }
  }
  if (Array.isArray(src._warmup_lx)) next._warmup_lx = src._warmup_lx.slice()
  if (Array.isArray(src._warmup_ly)) next._warmup_ly = src._warmup_ly.slice()
  if (src.iris_blink_hold && typeof src.iris_blink_hold === "object") {
    next.iris_blink_hold = { ...src.iris_blink_hold }
  }
  if (src.iris_blink_last_hold && typeof src.iris_blink_last_hold === "object") {
    next.iris_blink_last_hold = { ...src.iris_blink_last_hold }
  }
  if (src.iris_blink_release_from && typeof src.iris_blink_release_from === "object") {
    next.iris_blink_release_from = { ...src.iris_blink_release_from }
  }
  if (src.init_frame_motion && typeof src.init_frame_motion === "object") {
    next.init_frame_motion = { ...src.init_frame_motion }
  }
  return next
}

export function createIrisGazeState() {
  return {
    iris_gaze_armed: true,
    iris_warmup_done: false,
    iris_x_norm: 0,
    iris_y_norm: 0,
    last_emit: { x: 50, y: 50 },
    iris_missing_count: 0,
  }
}

/**
 * Clear iris output runtime. Mutates `state` when provided (Python reset_iris_gaze_runtime).
 * Session `iris_gaze_armed` is preserved.
 */
export function resetIrisGazeState(state) {
  const armed = state && typeof state === "object" ? state.iris_gaze_armed : undefined
  const motion = state && typeof state === "object" ? state.init_frame_motion : undefined
  const fresh = createIrisGazeState()
  if (armed !== undefined) fresh.iris_gaze_armed = Boolean(armed)
  if (motion && typeof motion === "object") fresh.init_frame_motion = { ...motion }
  if (state && typeof state === "object") {
    for (const k of Object.keys(state)) delete state[k]
    for (const k of IRIS_RUNTIME_POP_KEYS) delete state[k]
    Object.assign(state, fresh)
    return state
  }
  return fresh
}

export function extractIrisSignal(landmarks, gazeCfg = {}) {
  const gz = gazeCfg && typeof gazeCfg === "object" ? gazeCfg : {}
  const lm = Array.isArray(landmarks) ? landmarks : null
  const out = {
    valid: false,
    irisLocalMode: true,
    landmarkCount: lm ? lm.length : 0,
    irisLocalX: null,
    irisLocalY: null,
    irisLocalScale: null,
    leftIrisLocalX: null,
    leftIrisLocalY: null,
    rightIrisLocalX: null,
    rightIrisLocalY: null,
    irisLeftCx: null,
    irisLeftCy: null,
    irisRightCx: null,
    irisRightCy: null,
    irisCx: null,
    irisCy: null,
    irisScale: null,
    irisLocalFusion: null,
  }
  if (!lm || lm.length < 468) {
    out.irisInvalidReason = irisInvalidReason(lm, out)
    return out
  }

  const leftPts = []
  for (const i of LEFT_IRIS_IDX) {
    if (i >= lm.length) break
    const p = getLandmarkXy(lm, i)
    if (p) leftPts.push(p)
  }
  const rightPts = []
  for (const i of RIGHT_IRIS_IDX) {
    if (i >= lm.length) break
    const p = getLandmarkXy(lm, i)
    if (p) rightPts.push(p)
  }

  let licx = null
  let licy = null
  let ricx = null
  let ricy = null
  if (leftPts.length >= 2) {
    licx = leftPts.reduce((s, p) => s + p[0], 0) / leftPts.length
    licy = leftPts.reduce((s, p) => s + p[1], 0) / leftPts.length
    out.irisLeftCx = licx
    out.irisLeftCy = licy
  }
  if (rightPts.length >= 2) {
    ricx = rightPts.reduce((s, p) => s + p[0], 0) / rightPts.length
    ricy = rightPts.reduce((s, p) => s + p[1], 0) / rightPts.length
    out.irisRightCx = ricx
    out.irisRightCy = ricy
  }

  if (typeof licx === "number" && typeof ricx === "number") {
    out.irisCx = (licx + ricx) * 0.5
    out.irisCy = (licy + ricy) * 0.5
    out.irisScale = Math.hypot(licx - ricx, licy - ricy)
  }

  const leftLocal = computeEyeLocalIrisOffset(lm, LEFT_IRIS_IDX, LEFT_EYE_OUTER, LEFT_EYE_INNER)
  const rightLocal = computeEyeLocalIrisOffset(lm, RIGHT_IRIS_IDX, RIGHT_EYE_OUTER, RIGHT_EYE_INNER)

  if (leftLocal) {
    out.leftIrisLocalX = leftLocal[0]
    out.leftIrisLocalY = leftLocal[1]
  }
  if (rightLocal) {
    out.rightIrisLocalX = rightLocal[0]
    out.rightIrisLocalY = rightLocal[1]
  }

  const fused = fuseBinocularIrisLocal(leftLocal, rightLocal)
  if (!fused) {
    out.irisInvalidReason = irisInvalidReason(lm, out)
    return out
  }

  const [irisLocalX, irisLocalY, irisLocalScale, fusionMode] = fused
  out.irisLocalFusion = fusionMode

  const minScale = Math.max(
    1e-9,
    safeFloat(gz.irisMinEyeWidth, safeFloat(gz.irisMinScale, 0.001)),
  )
  const maxScale = Math.max(minScale, safeFloat(gz.irisMaxEyeWidth, safeFloat(gz.irisMaxScale, 0.5)))

  if (![irisLocalX, irisLocalY, irisLocalScale].every((v) => Number.isFinite(v))) {
    out.irisInvalidReason = "non_finite_local"
    return out
  }
  if (irisLocalScale < minScale || irisLocalScale > maxScale) {
    out.irisInvalidReason = "scale_out_of_range"
    out.irisLocalX = irisLocalX
    out.irisLocalY = irisLocalY
    out.irisLocalScale = irisLocalScale
    return out
  }

  out.valid = true
  out.irisLocalX = irisLocalX
  out.irisLocalY = irisLocalY
  out.irisLocalScale = irisLocalScale
  out.irisInvalidReason = ""
  return out
}

function irisUpdateBlinkFreezeState(st, lemit, rawBlinkL, rawBlinkR, gz) {
  const blink = irisBlinkLevel(rawBlinkL, rawBlinkR)
  const freezeOn = gz.freezeOnBlink !== false
  if (!freezeOn) {
    delete st.iris_blink_hold
    st.iris_blink_freeze_active = false
    st.iris_blink_release_count = 0
    st.iris_blink_freeze_frames = 0
    st.iris_blink_level = blink
    return { active: false, reason: "", blink, justReleased: false }
  }

  const enterThr = irisBlinkEnterThreshold(gz)
  const releaseThr = irisBlinkReleaseThreshold(gz)
  const holdFrames = Math.max(1, Math.trunc(safeFloat(gz.blinkFreezeReleaseHoldFrames, 3)))
  const maxFrames = Math.max(holdFrames + 1, Math.trunc(safeFloat(gz.blinkFreezeMaxFrames, 10)))

  const wasActive = Boolean(st.iris_blink_freeze_active)
  let active = wasActive
  let releaseCount = Math.trunc(st.iris_blink_release_count || 0)
  let freezeFrames = Math.trunc(st.iris_blink_freeze_frames || 0)
  let reason = ""

  if (!active) {
    if (blink >= enterThr) {
      active = true
      releaseCount = 0
      freezeFrames = 0
      reason = "blink_enter"
      st.iris_blink_hold = {
        x: safeFloat(lemit.x, 50),
        y: safeFloat(lemit.y, 50),
        xn: safeFloat(st.iris_x_norm, 0),
        yn: safeFloat(st.iris_y_norm, 0),
      }
    }
  } else {
    freezeFrames += 1
    if (blink <= releaseThr) {
      releaseCount += 1
      reason = "blink_release_wait"
    } else {
      releaseCount = 0
      reason = "blink_hold"
    }
    const timedOut = freezeFrames >= maxFrames
    if (releaseCount >= holdFrames || timedOut) {
      const hold = st.iris_blink_hold
      if (hold && typeof hold === "object") {
        st.iris_blink_last_hold = { ...hold }
      }
      active = false
      releaseCount = 0
      freezeFrames = 0
      delete st.iris_blink_hold
      reason = timedOut ? "blink_max_hold" : ""
    }
  }

  st.iris_blink_freeze_active = active
  st.iris_blink_release_count = releaseCount
  st.iris_blink_freeze_frames = active ? freezeFrames : 0
  st.iris_blink_level = blink
  return { active, reason, blink, justReleased: wasActive && !active }
}

function irisBeginBlinkReleaseBlend(st, gz) {
  let hold = st.iris_blink_last_hold
  delete st.iris_blink_last_hold
  if (!hold || typeof hold !== "object") hold = st.iris_blink_hold
  if (!hold || typeof hold !== "object") {
    const lemit = st.last_emit
    hold = {
      x: safeFloat(lemit && typeof lemit === "object" ? lemit.x : null, 50),
      y: safeFloat(lemit && typeof lemit === "object" ? lemit.y : null, 50),
    }
  }
  const blendFrames = Math.max(1, Math.trunc(safeFloat(gz.blinkReleaseBlendFrames, 2)))
  st.iris_blink_release_from = {
    x: safeFloat(hold.x, 50),
    y: safeFloat(hold.y, 50),
  }
  st.iris_blink_release_blend = blendFrames
}

function irisApplyBlinkOutputGate({
  st,
  gz,
  freezeActive,
  freezeReason,
  blinkLevel,
  lastEx,
  lastEy,
  lastXn,
  lastYn,
  emitX,
  emitY,
  xNorm,
  yNorm,
}) {
  if (freezeActive) {
    let hold = st.iris_blink_hold
    if (!hold || typeof hold !== "object") {
      hold = { x: emitX, y: emitY, xn: xNorm, yn: yNorm }
      st.iris_blink_hold = hold
    }
    const outX = safeFloat(hold.x, emitX)
    const outY = safeFloat(hold.y, emitY)
    const outXn = safeFloat(hold.xn, xNorm)
    const outYn = safeFloat(hold.yn, yNorm)
    const mode = freezeReason === "blink_release_wait" ? "iris_blink_release_hold" : "iris_blink_hold"
    return {
      emitX: outX,
      emitY: outY,
      xNorm: outXn,
      yNorm: outYn,
      outputMode: mode,
      frozenByBlink: true,
      freezeReasonOut: freezeReason || "blink_hold",
    }
  }

  let blendLeft = Math.trunc(st.iris_blink_release_blend || 0)
  if (blendLeft > 0) {
    const blendTotal = Math.max(1, Math.trunc(safeFloat(gz.blinkReleaseBlendFrames, 2)))
    let fr = st.iris_blink_release_from
    if (!fr || typeof fr !== "object") fr = { x: emitX, y: emitY }
    const progress = clamp((blendTotal - blendLeft + 1) / blendTotal, 0, 1)
    const outX = lerp(safeFloat(fr.x, emitX), emitX, progress)
    const outY = lerp(safeFloat(fr.y, emitY), emitY, progress)
    st.iris_blink_release_blend = blendLeft - 1
    if (blendLeft <= 1) delete st.iris_blink_release_from
    return {
      emitX: outX,
      emitY: outY,
      xNorm,
      yNorm,
      outputMode: "iris_blink_release_blend",
      frozenByBlink: false,
      freezeReasonOut: "blink_release_blend",
    }
  }

  const freezeOn = gz.freezeOnBlink !== false
  if (freezeOn && blinkLevel >= irisBlinkInstantThreshold(gz)) {
    return {
      emitX: lastEx,
      emitY: lastEy,
      xNorm: lastXn,
      yNorm: lastYn,
      outputMode: "iris_blink_instant",
      frozenByBlink: true,
      freezeReasonOut: "blink_instant",
    }
  }

  return {
    emitX,
    emitY,
    xNorm,
    yNorm,
    outputMode: "iris_tracking",
    frozenByBlink: false,
    freezeReasonOut: "",
  }
}

function finalizeIrisWarmup(st) {
  const xs = Array.isArray(st._warmup_lx) ? st._warmup_lx.slice() : []
  const ys = Array.isArray(st._warmup_ly) ? st._warmup_ly.slice() : []
  st.baseline_lx = xs.length ? median(xs) : 0
  st.baseline_ly = ys.length ? median(ys) : 0
  st.iris_warmup_done = true
  delete st._warmup_lx
  delete st._warmup_ly
  st.iris_x_norm = 0
  st.iris_y_norm = 0
  st.last_emit = { x: 50, y: 50 }
}

function applyMediapipeIrisOnlyGaze({ gazeState, iris, gazeCfg, limits, faceDetected, blend }) {
  const gz = gazeCfg && typeof gazeCfg === "object" ? gazeCfg : {}
  const st = gazeState && typeof gazeState === "object" ? gazeState : {}
  const blendMap = blend && typeof blend === "object" ? blend : {}
  const rawBlinkL = safeFloat(blendMap.eyeBlinkLeft, 0)
  const rawBlinkR = safeFloat(blendMap.eyeBlinkRight, 0)

  if (!st.last_emit || typeof st.last_emit !== "object") st.last_emit = { x: 50, y: 50 }
  if (st.iris_x_norm == null) st.iris_x_norm = 0
  if (st.iris_y_norm == null) st.iris_y_norm = 0
  if (st.iris_missing_count == null) st.iris_missing_count = 0
  const lemit = st.last_emit

  const limX = Array.isArray(limits?.eyeLookX) ? limits.eyeLookX : [30, 70]
  const limY = Array.isArray(limits?.eyeLookY) ? limits.eyeLookY : [30, 70]
  const loX = safeFloat(limX[0], 30)
  const hiX = safeFloat(limX[1], 70)
  const loY = safeFloat(limY[0], 30)
  const hiY = safeFloat(limY[1], 70)

  const sharedRadar = { x: 50, y: 50 }
  const mapping = { sharedRadarX: 50, sharedRadarY: 50 }
  const invalidReason = String(iris?.irisInvalidReason || "")

  const gazeDbg = {
    gazeEstimatorMode: IRIS_ONLY_MODE,
    irisOnlyActive: true,
    irisLocalMode: true,
    irisInitState: "iris_tracking",
    irisInitReady: Boolean(iris?.valid),
    irisInitShowPrompt: false,
    landmarkCount: Math.trunc(iris?.landmarkCount || 0),
    irisInvalidReason: invalidReason,
    irisLocalX: iris?.irisLocalX ?? null,
    irisLocalY: iris?.irisLocalY ?? null,
    irisLocalScale: iris?.irisLocalScale ?? null,
    leftIrisLocalX: iris?.leftIrisLocalX ?? null,
    leftIrisLocalY: iris?.leftIrisLocalY ?? null,
    rightIrisLocalX: iris?.rightIrisLocalX ?? null,
    rightIrisLocalY: iris?.rightIrisLocalY ?? null,
    irisLeftCx: iris?.irisLeftCx ?? null,
    irisLeftCy: iris?.irisLeftCy ?? null,
    irisRightCx: iris?.irisRightCx ?? null,
    irisRightCy: iris?.irisRightCy ?? null,
    irisCx: iris?.irisCx ?? null,
    irisCy: iris?.irisCy ?? null,
    irisScale: iris?.irisScale ?? null,
    safeCenterActive: false,
    available: Boolean(iris?.valid),
    frozenByBlink: false,
    freezeReason: "",
    eyeBlinkLeftRaw: rawBlinkL,
    eyeBlinkRightRaw: rawBlinkR,
  }

  function emitCenter(mode) {
    const center = 50
    sharedRadar.x = center
    sharedRadar.y = center
    mapping.sharedRadarX = center
    mapping.sharedRadarY = center
    lemit.x = center
    lemit.y = center
    gazeDbg.candidateSharedRadarX = center
    gazeDbg.candidateSharedRadarY = center
    gazeDbg.emittedSharedRadarX = center
    gazeDbg.emittedSharedRadarY = center
    gazeDbg.outputMode = mode
  }

  function emitXy(emitX, emitY, mode) {
    sharedRadar.x = emitX
    sharedRadar.y = emitY
    mapping.sharedRadarX = emitX
    mapping.sharedRadarY = emitY
    lemit.x = emitX
    lemit.y = emitY
    gazeDbg.candidateSharedRadarX = emitX
    gazeDbg.candidateSharedRadarY = emitY
    gazeDbg.emittedSharedRadarX = emitX
    gazeDbg.emittedSharedRadarY = emitY
    gazeDbg.outputMode = mode
  }

  if (!st.iris_gaze_armed) {
    emitCenter("iris_disarmed")
    gazeDbg.irisInitState = "iris_disarmed"
    gazeDbg.irisGazeArmed = false
    return { sharedRadar, mapping, gazeDebug: gazeDbg }
  }

  gazeDbg.irisGazeArmed = true

  if (!faceDetected) {
    emitCenter("iris_no_face")
    return { sharedRadar, mapping, gazeDebug: gazeDbg }
  }

  if (!iris?.valid) {
    st.iris_missing_count = Math.trunc(st.iris_missing_count || 0) + 1
    const holdThr = Math.max(1, Math.trunc(safeFloat(gz.irisMissingHoldFrames, 10)))
    const lastX = safeFloat(lemit.x, 50)
    const lastY = safeFloat(lemit.y, 50)
    let emitX
    let emitY
    let mode
    if (st.iris_missing_count < holdThr) {
      emitX = lastX
      emitY = lastY
      mode = "iris_missing_hold"
    } else {
      const decay = safeFloat(gz.irisMissingDecayLerp, 0.05)
      emitX = lerp(lastX, 50, decay)
      emitY = lerp(lastY, 50, decay)
      mode = "iris_missing_decay"
    }
    emitXy(emitX, emitY, mode)
    return { sharedRadar, mapping, gazeDebug: gazeDbg }
  }

  st.iris_missing_count = 0

  const localX = Number(iris.irisLocalX)
  const localY = Number(iris.irisLocalY)
  const headMotionPx = frameHeadMotionPx(st)

  if (!st.iris_warmup_done) {
    const required = Math.max(8, Math.trunc(safeFloat(gz.irisWarmupFrames, 20)))
    const minSamples = Math.max(6, Math.trunc(safeFloat(gz.irisWarmupMinSamples, 12)))
    const maxWait = Math.max(required + 5, Math.trunc(safeFloat(gz.irisWarmupMaxWaitFrames, 45)))
    const maxHead = Math.max(0.1, safeFloat(gz.irisWarmupMaxHeadPx, 0.35))

    const frameIdx = Math.trunc(st.iris_warmup_frame || 0) + 1
    st.iris_warmup_frame = frameIdx

    if (headMotionPx < maxHead && !irisBlinkBlocksWarmup(rawBlinkL, rawBlinkR, gz)) {
      if (!Array.isArray(st._warmup_lx)) st._warmup_lx = []
      if (!Array.isArray(st._warmup_ly)) st._warmup_ly = []
      st._warmup_lx.push(localX)
      st._warmup_ly.push(localY)
    }

    const sampleN = (st._warmup_lx || []).length
    gazeDbg.irisInitState = "iris_warmup"
    gazeDbg.irisInitReady = false
    gazeDbg.irisWarmupSampleCount = sampleN
    gazeDbg.irisWarmupRequiredSamples = required
    gazeDbg.irisWarmupFrameIndex = frameIdx

    const warmupReady = sampleN >= required || (frameIdx >= maxWait && sampleN >= minSamples)
    if (warmupReady && sampleN >= 3) {
      finalizeIrisWarmup(st)
      gazeDbg.irisInitState = "iris_tracking"
      gazeDbg.irisInitReady = true
    } else {
      emitCenter("iris_warmup")
      Object.assign(gazeDbg, {
        irisLocalDx: 0,
        irisLocalDy: 0,
        irisBaselineLocalX: null,
        irisBaselineLocalY: null,
        irisHeadMotionPx: headMotionPx,
        irisXNorm: 0,
        irisYNorm: 0,
        candidateSharedRadarX: 50,
        candidateSharedRadarY: 50,
        emittedSharedRadarX: 50,
        emittedSharedRadarY: 50,
        outputMode: "iris_warmup",
      })
      return { sharedRadar, mapping, gazeDebug: gazeDbg }
    }
  }

  const freeze = irisUpdateBlinkFreezeState(st, lemit, rawBlinkL, rawBlinkR, gz)
  if (freeze.justReleased) irisBeginBlinkReleaseBlend(st, gz)

  if (st.baseline_lx == null) {
    st.baseline_lx = localX
    st.baseline_ly = localY
  }

  const headHoldPx = Math.max(0.5, safeFloat(gz.irisHeadMotionHoldPx, 1.4))
  let headSoftPx = Math.max(0.2, safeFloat(gz.irisHeadMotionSoftPx, 0.65))
  headSoftPx = Math.min(headSoftPx, headHoldPx - 1e-6)

  let driveX = localX - Number(st.baseline_lx)
  let driveY = localY - Number(st.baseline_ly)

  const quietThr = Math.max(0, safeFloat(gz.irisQuietRecenterDrive, 0.014))
  const quietBaseAlphaX = clamp(safeFloat(gz.irisQuietBaselineAlpha, 0.006), 0, 0.03)
  const quietBaseAlphaY = clamp(safeFloat(gz.irisQuietBaselineAlphaY, 0.012), 0, 0.05)
  if (headMotionPx < 0.25) {
    if (quietBaseAlphaX > 0 && Math.abs(driveX) < quietThr) {
      st.baseline_lx = lerp(Number(st.baseline_lx), localX, quietBaseAlphaX)
      driveX = localX - Number(st.baseline_lx)
    }
    if (quietBaseAlphaY > 0 && Math.abs(driveY) < quietThr) {
      st.baseline_ly = lerp(Number(st.baseline_ly), localY, quietBaseAlphaY)
      driveY = localY - Number(st.baseline_ly)
    }
  }

  const driveDzX = Math.max(
    0,
    safeFloat(gz.irisLocalDriveDeadzoneX, safeFloat(gz.irisLocalDriveDeadzone, 0.012)),
  )
  const driveDzY = Math.max(0, safeFloat(gz.irisLocalDriveDeadzoneY, 0.007))
  if (Math.abs(driveX) < driveDzX) driveX = 0
  if (Math.abs(driveY) < driveDzY) driveY = 0

  const lastEx = safeFloat(lemit.x, 50)
  const lastEy = safeFloat(lemit.y, 50)
  const lastXn = safeFloat(st.iris_x_norm, 0)
  const lastYn = safeFloat(st.iris_y_norm, 0)

  let headScale = 1
  if (headMotionPx > headSoftPx) {
    headScale = clamp(
      1 - (headMotionPx - headSoftPx) / Math.max(1e-6, headHoldPx - headSoftPx),
      0.2,
      1,
    )
  }
  driveX *= headScale
  driveY *= headScale

  const xGain = safeFloat(gz.irisLocalXGain, safeFloat(gz.irisXGain, 5))
  const normKneeX = Math.max(1e-6, safeFloat(gz.irisSoftNormKneeX, safeFloat(gz.irisSoftNormKnee, 0.22)))
  const normKneeY = Math.max(1e-6, safeFloat(gz.irisSoftNormKneeY, 0.18))
  const xSign = gz.irisInvertX ? -1 : 1
  const ySign = gz.irisInvertY ? 1 : -1
  const yGain = pickIrisYGain(driveY, ySign, gz)
  let xNormRaw = softNorm(driveX * xSign, { gain: xGain, knee: normKneeX })
  let yNormRaw = softNorm(driveY * ySign, { gain: yGain, knee: normKneeY })

  const dzX = Math.max(0, safeFloat(gz.irisDeadzoneX, 0.0015))
  const dzY = Math.max(0, safeFloat(gz.irisDeadzoneY, 0.0015))
  if (Math.abs(xNormRaw) < dzX) xNormRaw = 0
  if (Math.abs(yNormRaw) < dzY) yNormRaw = 0

  let xNorm = clamp(xNormRaw, -1, 1)
  let yNorm = clamp(yNormRaw, -1, 1)

  const ema = safeFloat(gz.irisEmaAlpha, 0.58)
  xNorm = lerp(lastXn, xNorm, ema)
  yNorm = lerp(lastYn, yNorm, ema)

  const quietRecenterAlphaX = clamp(safeFloat(gz.irisQuietRecenterAlpha, 0.32), 0, 1)
  const quietRecenterAlphaY = clamp(safeFloat(gz.irisQuietRecenterAlphaY, 0.42), 0, 1)
  if (headMotionPx < 0.25) {
    if (Math.abs(driveX) < quietThr) xNorm = lerp(xNorm, 0, quietRecenterAlphaX)
    if (Math.abs(driveY) < quietThr) yNorm = lerp(yNorm, 0, quietRecenterAlphaY)
  }

  const maxDelta = safeFloat(gz.irisMaxDeltaNormPerFrame, 0.18)
  xNorm = clamp(xNorm, lastXn - maxDelta, lastXn + maxDelta)
  yNorm = clamp(yNorm, lastYn - maxDelta, lastYn + maxDelta)

  st.iris_x_norm = xNorm
  st.iris_y_norm = yNorm

  const spanX = Math.max(1, safeFloat(gz.irisOutputSpanX, 18))
  const spanY = Math.max(1, safeFloat(gz.irisOutputSpanY, 20))
  let candX = 50 + xNorm * spanX
  let candY = 50 + yNorm * spanY
  candX = clamp(candX, loX, hiX)
  candY = clamp(candY, loY, hiY)

  const maxStep = Math.max(1, safeFloat(gz.irisMaxStepSharedRadar, 10))
  let emitX = clamp(candX, lastEx - maxStep, lastEx + maxStep)
  let emitY = clamp(candY, lastEy - maxStep, lastEy + maxStep)

  const gated = irisApplyBlinkOutputGate({
    st,
    gz,
    freezeActive: freeze.active,
    freezeReason: freeze.reason,
    blinkLevel: freeze.blink,
    lastEx,
    lastEy,
    lastXn,
    lastYn,
    emitX,
    emitY,
    xNorm,
    yNorm,
  })
  emitX = gated.emitX
  emitY = gated.emitY
  xNorm = gated.xNorm
  yNorm = gated.yNorm
  st.iris_x_norm = xNorm
  st.iris_y_norm = yNorm

  sharedRadar.x = emitX
  sharedRadar.y = emitY
  mapping.sharedRadarX = emitX
  mapping.sharedRadarY = emitY
  lemit.x = emitX
  lemit.y = emitY

  Object.assign(gazeDbg, {
    irisLocalDx: driveX,
    irisLocalDy: driveY,
    irisBaselineLocalX: Number(st.baseline_lx),
    irisBaselineLocalY: Number(st.baseline_ly),
    irisHeadMotionPx: headMotionPx,
    irisHeadMotionScale: headScale,
    irisLocalFusion: iris.irisLocalFusion,
    irisXNorm: xNorm,
    irisYNorm: yNorm,
    irisYGainApplied: yGain,
    candidateSharedRadarX: candX,
    candidateSharedRadarY: candY,
    emittedSharedRadarX: emitX,
    emittedSharedRadarY: emitY,
    outputMode: gated.outputMode,
    frozenByBlink: gated.frozenByBlink,
    freezeReason: String(gated.freezeReasonOut),
    irisBlinkFreezeActive: Boolean(freeze.active),
    irisBlinkLevel: freeze.blink,
    irisBlinkReleaseCount: Math.trunc(st.iris_blink_release_count || 0),
    irisBlinkFreezeFrames: Math.trunc(st.iris_blink_freeze_frames || 0),
    irisBlinkReleaseBlendLeft: Math.trunc(st.iris_blink_release_blend || 0),
    eyeBlinkLeftRaw: rawBlinkL,
    eyeBlinkRightRaw: rawBlinkR,
  })

  return { sharedRadar, mapping, gazeDebug: gazeDbg }
}

/**
 * @param {object} args
 * @param {Array<{x:number,y:number,z?:number}>} args.landmarks
 * @param {Record<string, number>} [args.blendshapes]
 * @param {object} [args.state]
 * @param {object} [args.config] full or partial mapping config
 * @param {number} [args.timestampMs] unused by iris math (API symmetry)
 * @param {boolean} [args.faceDetected]
 */
export function applyIrisOnlyGaze({
  landmarks,
  blendshapes,
  state,
  config,
  timestampMs,
  faceDetected,
} = {}) {
  void timestampMs
  const cfg = normalizeMappingConfig(config)
  const nextState = cloneIrisState(state && typeof state === "object" ? state : createIrisGazeState())
  if (nextState.iris_gaze_armed == null) nextState.iris_gaze_armed = true
  const iris = extractIrisSignal(landmarks, cfg.gaze)
  const detected =
    faceDetected != null
      ? Boolean(faceDetected)
      : Array.isArray(landmarks) && landmarks.length > 0
  const result = applyMediapipeIrisOnlyGaze({
    gazeState: nextState,
    iris,
    gazeCfg: cfg.gaze,
    limits: cfg.limits,
    faceDetected: detected,
    blend: blendshapes,
  })
  return {
    sharedRadar: result.sharedRadar,
    mapping: result.mapping,
    gazeDebug: result.gazeDebug,
    nextState,
  }
}
