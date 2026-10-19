/**
 * Nose Anchor Gate V1 — port of tools/tracking_service/nose_anchor_frame.py
 */

import { safeFloat } from "./trackingMath.js"
import { cloneDeepPlain, readPoint3 } from "./geomMath.js"

const EPS = 1e-6

const DEFAULT_NOSE_ANCHOR = Object.freeze({
  enabled: true,
  noseTipIndex: 1,
  noseBridgeIndices: Object.freeze([4, 5, 6, 195, 197]),
  useNoseClusterCenter: true,
  useNoseBridgeVector: true,
  minNoseScale: 0.005,
  use3d: true,
  neutralWarmupFrames: 8,
  neutralFrames: 30,
  motionThreshold: 0.12,
  positionThreshold: 0.10,
  scaleThreshold: 0.08,
  vectorThreshold: 0.12,
})

const BOOL_KEYS = new Set(["enabled", "useNoseClusterCenter", "useNoseBridgeVector", "use3d"])

function zeroAnchor() {
  return { centerX: 0, centerY: 0, centerZ: 0, scale: 0, vectorX: 0, vectorY: 0, vectorZ: 0 }
}

export function createNoseAnchorState() {
  return {
    neutral_ready: false,
    neutral_mode: "idle",
    neutral_count: 0,
    neutral_warmup_count: 0,
    neutral_sum: zeroAnchor(),
    neutral: zeroAnchor(),
    last_debug: {},
  }
}

export function resetNoseAnchorState(state) {
  const fresh = createNoseAnchorState()
  if (state && typeof state === "object") {
    for (const k of Object.keys(state)) delete state[k]
    Object.assign(state, createNoseAnchorState())
    return state
  }
  return fresh
}

export function normalizeNoseAnchorConfig(raw) {
  const base = {
    ...DEFAULT_NOSE_ANCHOR,
    noseBridgeIndices: DEFAULT_NOSE_ANCHOR.noseBridgeIndices.slice(),
  }
  if (!raw || typeof raw !== "object") return base
  for (const [k, v] of Object.entries(DEFAULT_NOSE_ANCHOR)) {
    if (k === "noseBridgeIndices") {
      const arr = raw[k]
      base[k] = Array.isArray(arr) ? arr.map((x) => Math.trunc(Number(x))) : v.slice()
    } else if (k === "noseTipIndex") {
      base[k] = Math.trunc(safeFloat(raw[k], v))
    } else if (BOOL_KEYS.has(k)) {
      base[k] = raw[k] == null ? Boolean(v) : Boolean(raw[k])
    } else {
      base[k] = safeFloat(raw[k], v)
    }
  }
  return base
}

function resolveCfg(config) {
  if (config && typeof config === "object" && config.noseAnchor) {
    return normalizeNoseAnchorConfig(config.noseAnchor)
  }
  if (config && typeof config === "object" && "noseTipIndex" in config) {
    return normalizeNoseAnchorConfig(config)
  }
  return normalizeNoseAnchorConfig(null)
}

export function buildNoseAnchorFrame(landmarks, cfg) {
  const ncfg = resolveCfg(cfg)
  const tipIdx = Math.trunc(ncfg.noseTipIndex ?? 1)
  const bridgeIdx = (ncfg.noseBridgeIndices || [4, 5, 6, 195, 197]).map((i) => Math.trunc(i))
  let tip = readPoint3(landmarks, tipIdx)
  if (!tip) return { ok: false, error: "nose-tip-missing", coordinateMode: "invalid" }

  let bridgePts = []
  for (const i of bridgeIdx) {
    const p = readPoint3(landmarks, i)
    if (p) bridgePts.push(p)
  }
  if (!bridgePts.length) return { ok: false, error: "nose-bridge-missing", coordinateMode: "invalid" }

  const use3d = ncfg.use3d !== false
  const hasZ = Math.abs(tip[2]) > 1e-6 || bridgePts.some((p) => Math.abs(p[2]) > 1e-6)
  const coordinateMode = use3d && hasZ ? "3d" : "2d_fallback"
  if (coordinateMode === "2d_fallback") {
    tip = [tip[0], tip[1], 0]
    bridgePts = bridgePts.map((p) => [p[0], p[1], 0])
  }

  const bridgeCenter = [
    bridgePts.reduce((s, p) => s + p[0], 0) / bridgePts.length,
    bridgePts.reduce((s, p) => s + p[1], 0) / bridgePts.length,
    bridgePts.reduce((s, p) => s + p[2], 0) / bridgePts.length,
  ]
  const center = ncfg.useNoseClusterCenter !== false
    ? [
        ([tip, ...bridgePts].reduce((s, p) => s + p[0], 0) / (bridgePts.length + 1)),
        ([tip, ...bridgePts].reduce((s, p) => s + p[1], 0) / (bridgePts.length + 1)),
        ([tip, ...bridgePts].reduce((s, p) => s + p[2], 0) / (bridgePts.length + 1)),
      ]
    : tip

  const tipToBridge = Math.hypot(tip[0] - bridgeCenter[0], tip[1] - bridgeCenter[1], tip[2] - bridgeCenter[2])
  let spread = 0
  if (bridgePts.length > 1) {
    spread =
      bridgePts.reduce(
        (s, p) => s + Math.hypot(p[0] - bridgeCenter[0], p[1] - bridgeCenter[1], p[2] - bridgeCenter[2]),
        0,
      ) / bridgePts.length
  }
  const scale = Math.max(tipToBridge, spread)
  const minScale = Math.max(EPS, safeFloat(ncfg.minNoseScale, 0.005))
  if (scale < minScale) {
    return {
      ok: false,
      error: "nose-scale-too-small",
      coordinateMode,
      center: { x: center[0], y: center[1], z: center[2] },
      scale,
    }
  }

  let vx
  let vy
  let vz
  if (ncfg.useNoseBridgeVector !== false) {
    vx = bridgeCenter[0] - tip[0]
    vy = bridgeCenter[1] - tip[1]
    vz = bridgeCenter[2] - tip[2]
  } else {
    vx = tip[0] - center[0]
    vy = tip[1] - center[1]
    vz = tip[2] - center[2]
  }
  const vnorm = Math.hypot(vx, vy, vz)
  const vector = vnorm < EPS ? [0, 0, 0] : [vx / vnorm, vy / vnorm, vz / vnorm]

  return {
    ok: true,
    coordinateMode,
    center: { x: center[0], y: center[1], z: center[2] },
    scale,
    vector: { x: vector[0], y: vector[1], z: vector[2] },
    error: "",
  }
}

export function evaluateNoseAnchorMotion(anchor, neutral, cfg) {
  const ncfg = resolveCfg(cfg)
  const posThr = Math.max(0, safeFloat(ncfg.positionThreshold, 0.1))
  const scaleThr = Math.max(0, safeFloat(ncfg.scaleThreshold, 0.08))
  const vecThr = Math.max(0, safeFloat(ncfg.vectorThreshold, 0.12))
  const motionThr = Math.max(0, safeFloat(ncfg.motionThreshold, 0.12))
  const thresholds = {
    positionThreshold: posThr,
    scaleThreshold: scaleThr,
    vectorThreshold: vecThr,
    motionThreshold: motionThr,
  }
  const c = anchor?.center && typeof anchor.center === "object" ? anchor.center : {}
  const v = anchor?.vector && typeof anchor.vector === "object" ? anchor.vector : {}
  const nc = neutral?.center && typeof neutral.center === "object" ? neutral.center : {}
  const nv = neutral?.vector && typeof neutral.vector === "object" ? neutral.vector : {}
  const neutralScale = Math.max(EPS, safeFloat(neutral?.scale, 0))

  const dx = safeFloat(c.x, 0) - safeFloat(nc.x, 0)
  const dy = safeFloat(c.y, 0) - safeFloat(nc.y, 0)
  const dz = safeFloat(c.z, 0) - safeFloat(nc.z, 0)
  const ndx = Math.abs(dx) / neutralScale
  const ndy = Math.abs(dy) / neutralScale
  const ndz = Math.abs(dz) / neutralScale
  const scaleDelta = Math.abs(safeFloat(anchor?.scale, 0) - neutralScale) / neutralScale
  const vdx = safeFloat(v.x, 0) - safeFloat(nv.x, 0)
  const vdy = safeFloat(v.y, 0) - safeFloat(nv.y, 0)
  const vdz = safeFloat(v.z, 0) - safeFloat(nv.z, 0)
  const vectorDelta = Math.hypot(vdx, vdy, vdz)
  const motionScore = Math.max(ndx, ndy, ndz, scaleDelta, vectorDelta)
  const motionActive =
    ndx > posThr || ndy > posThr || ndz > posThr || scaleDelta > scaleThr || vectorDelta > vecThr

  return {
    delta: { dx, dy, dz, normDx: ndx, normDy: ndy, normDz: ndz, scaleDelta, vectorDelta },
    motionScore,
    motionActive,
    thresholds,
  }
}

function updateNoseNeutral(state, anchor, ncfg, faceDetected) {
  if (state.neutral_ready) return { stillCal: false, justDone: false, hint: "ready" }
  if (!(faceDetected && anchor.ok)) return { stillCal: true, justDone: false, hint: "waiting-nose" }
  const warmupNeed = Math.max(0, Math.trunc(safeFloat(ncfg.neutralWarmupFrames, 8)))
  const nFrames = Math.max(1, Math.trunc(safeFloat(ncfg.neutralFrames, 30)))
  const wc = Math.trunc(state.neutral_warmup_count || 0)
  if (wc < warmupNeed) {
    state.neutral_warmup_count = wc + 1
    return { stillCal: true, justDone: false, hint: "warmup" }
  }
  const c = anchor.center || {}
  const v = anchor.vector || {}
  const ns = state.neutral_sum
  ns.centerX += safeFloat(c.x, 0)
  ns.centerY += safeFloat(c.y, 0)
  ns.centerZ += safeFloat(c.z, 0)
  ns.scale += safeFloat(anchor.scale, 0)
  ns.vectorX += safeFloat(v.x, 0)
  ns.vectorY += safeFloat(v.y, 0)
  ns.vectorZ += safeFloat(v.z, 0)
  const nc = Math.trunc(state.neutral_count || 0) + 1
  state.neutral_count = nc
  if (nc < nFrames) return { stillCal: true, justDone: false, hint: "calibrating" }
  const avgScale = ns.scale / nc
  state.neutral = {
    centerX: ns.centerX / nc,
    centerY: ns.centerY / nc,
    centerZ: ns.centerZ / nc,
    scale: avgScale > EPS ? avgScale : Math.max(EPS, safeFloat(ncfg.minNoseScale, 0.005)),
    vectorX: ns.vectorX / nc,
    vectorY: ns.vectorY / nc,
    vectorZ: ns.vectorZ / nc,
  }
  state.neutral_ready = true
  state.neutral_mode = "ready"
  return { stillCal: false, justDone: true, hint: "just-completed" }
}

function neutralToAnchor(neutral) {
  return {
    center: {
      x: Number(neutral.centerX || 0),
      y: Number(neutral.centerY || 0),
      z: Number(neutral.centerZ || 0),
    },
    scale: Number(neutral.scale || 0),
    vector: {
      x: Number(neutral.vectorX || 0),
      y: Number(neutral.vectorY || 0),
      z: Number(neutral.vectorZ || 0),
    },
  }
}

/**
 * @returns {{ motionActive: boolean, motionScore: number, neutralReady: boolean, nextState: object, ...debug }}
 */
export function applyNoseAnchor({ landmarks, config, state, faceDetected = true } = {}) {
  const ncfg = resolveCfg(config)
  const st = cloneDeepPlain(state && typeof state === "object" ? state : createNoseAnchorState())
  if (!st.neutral_sum) st.neutral_sum = zeroAnchor()
  if (!st.neutral) st.neutral = zeroAnchor()

  const enabled = ncfg.enabled !== false
  const anchor =
    !Array.isArray(landmarks) || landmarks.length === 0
      ? { ok: false, error: "no-landmarks", coordinateMode: "invalid" }
      : buildNoseAnchorFrame(landmarks, ncfg)

  const { stillCal, justDone, hint } = updateNoseNeutral(st, anchor, ncfg, faceDetected)
  const neutralAnchor = neutralToAnchor(st.neutral || {})
  const neutralReady = Boolean(st.neutral_ready)

  let motion
  if (enabled && neutralReady && anchor.ok) {
    motion = evaluateNoseAnchorMotion(anchor, neutralAnchor, ncfg)
  } else {
    motion = {
      delta: { dx: 0, dy: 0, dz: 0, normDx: 0, normDy: 0, normDz: 0, scaleDelta: 0, vectorDelta: 0 },
      motionScore: 0,
      motionActive: false,
      thresholds: {
        positionThreshold: safeFloat(ncfg.positionThreshold, 0.1),
        scaleThreshold: safeFloat(ncfg.scaleThreshold, 0.08),
        vectorThreshold: safeFloat(ncfg.vectorThreshold, 0.12),
        motionThreshold: safeFloat(ncfg.motionThreshold, 0.12),
      },
    }
  }

  const debug = {
    enabled,
    ok: Boolean(anchor.ok),
    coordinateMode: String(anchor.coordinateMode || "invalid"),
    center: anchor.center && typeof anchor.center === "object" ? anchor.center : { x: 0, y: 0, z: 0 },
    scale: safeFloat(anchor.scale, 0),
    vector: anchor.vector && typeof anchor.vector === "object" ? anchor.vector : { x: 0, y: 0, z: 0 },
    error: String(anchor.error || ""),
    neutral: neutralAnchor,
    neutralReady,
    neutralState: {
      mode: String(st.neutral_mode || "idle"),
      neutralReady,
      neutralCount: Math.trunc(st.neutral_count || 0),
      neutralWarmupCount: Math.trunc(st.neutral_warmup_count || 0),
      hint,
    },
    calibrating: Boolean(stillCal || justDone),
    delta: motion.delta,
    motionScore: Number(motion.motionScore),
    motionActive: Boolean(motion.motionActive && enabled && neutralReady),
    thresholds: motion.thresholds,
  }
  st.last_debug = debug
  return { ...debug, nextState: st }
}
