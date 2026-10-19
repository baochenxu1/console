/**
 * Shared landmark / mouth-pose geometry helpers.
 * Ports mouth_pose_frame.py + common 3D reads used by jaw/lip/nose/corners.
 */

import { safeFloat } from "./trackingMath.js"

export function getLandmarkXy(landmarks, index) {
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

export function readPoint3(landmarks, idx) {
  if (!Array.isArray(landmarks)) return null
  const i = Math.trunc(idx)
  if (i < 0 || i >= landmarks.length) return null
  const p = landmarks[i]
  if (p == null) return null
  if (typeof p === "object" && !Array.isArray(p) && "x" in p && "y" in p) {
    const z = Number.isFinite(Number(p.z)) ? Number(p.z) : 0
    return [Number(p.x), Number(p.y), z]
  }
  if (Array.isArray(p) && p.length >= 2) {
    return [Number(p[0]), Number(p[1]), p.length >= 3 ? Number(p[2]) || 0 : 0]
  }
  const xy = getLandmarkXy(landmarks, i)
  if (!xy) return null
  return [xy[0], xy[1], 0]
}

export function avgPoint3(landmarks, indices) {
  const pts = []
  for (const i of indices || []) {
    const p = readPoint3(landmarks, i)
    if (p) pts.push(p)
  }
  if (!pts.length) return null
  const n = pts.length
  return [
    pts.reduce((s, p) => s + p[0], 0) / n,
    pts.reduce((s, p) => s + p[1], 0) / n,
    pts.reduce((s, p) => s + p[2], 0) / n,
  ]
}

export function v3Sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

export function v3Dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

export function v3Norm(v) {
  return Math.sqrt(Math.max(1e-12, v3Dot(v, v)))
}

export function v3Normalize(v) {
  const n = v3Norm(v)
  if (n < 1e-9) return null
  return [v[0] / n, v[1] / n, v[2] / n]
}

/**
 * mouth_pose_frame.build_mouth_pose_frame
 */
export function buildMouthPoseFrame(landmarks, cfg = {}) {
  const li = Math.trunc(cfg.leftCornerIndex ?? 61)
  const ri = Math.trunc(cfg.rightCornerIndex ?? 291)
  const ni = Math.trunc(cfg.noseTipIndex ?? 1)
  const ci = Math.trunc(cfg.chinIndex ?? 152)
  let l = readPoint3(landmarks, li)
  let r = readPoint3(landmarks, ri)
  let n = readPoint3(landmarks, ni)
  let c = readPoint3(landmarks, ci)
  if (!l || !r || !n || !c) {
    return { ok: false, error: "key-landmarks-missing", coordinateMode: "invalid", mouthWidth: 0 }
  }

  let coordinateMode = "3d"
  const use3d = cfg.use3dLocalCoordinate !== false
  if (!use3d) {
    coordinateMode = "2d_fallback"
    l = [l[0], l[1], 0]
    r = [r[0], r[1], 0]
    n = [n[0], n[1], 0]
    c = [c[0], c[1], 0]
  } else if (Math.abs(l[2]) < 1e-6 && Math.abs(r[2]) < 1e-6 && Math.abs(n[2]) < 1e-6 && Math.abs(c[2]) < 1e-6) {
    coordinateMode = "2d_fallback"
  }

  const mouthCenter = [(l[0] + r[0]) * 0.5, (l[1] + r[1]) * 0.5, (l[2] + r[2]) * 0.5]
  const xAxis = v3Normalize(v3Sub(r, l))
  if (!xAxis) {
    return { ok: false, error: "x-axis-invalid", coordinateMode, mouthWidth: 0 }
  }
  const faceDown = v3Normalize(v3Sub(c, n))
  if (!faceDown) {
    return { ok: false, error: "face-down-invalid", coordinateMode, mouthWidth: 0 }
  }
  const proj = v3Dot(faceDown, xAxis)
  let yAxis = v3Normalize([
    faceDown[0] - proj * xAxis[0],
    faceDown[1] - proj * xAxis[1],
    faceDown[2] - proj * xAxis[2],
  ])
  if (!yAxis) {
    return { ok: false, error: "y-axis-invalid", coordinateMode, mouthWidth: 0 }
  }
  if (v3Dot(yAxis, v3Sub(c, mouthCenter)) < 0) {
    yAxis = [-yAxis[0], -yAxis[1], -yAxis[2]]
  }
  const yAxisTowardChin = v3Dot(yAxis, v3Sub(c, mouthCenter)) > 0
  const mouthWidth = v3Norm(v3Sub(r, l))
  const minW = Math.max(1e-6, safeFloat(cfg.minMouthWidth, 0.03))
  if (mouthWidth < minW) {
    return {
      ok: false,
      error: "mouth-width-too-small",
      coordinateMode,
      mouthWidth,
      yAxisTowardChin,
    }
  }

  const projectY = (point) => v3Dot(v3Sub(point, mouthCenter), yAxis) / Math.max(1e-6, mouthWidth)
  const yawProxy = (v3Norm(v3Sub(n, r)) - v3Norm(v3Sub(n, l))) / Math.max(1e-6, mouthWidth)
  const pitchProxy = v3Norm(v3Sub(c, mouthCenter)) / Math.max(1e-6, mouthWidth)
  const rollDeg = (Math.atan2(r[1] - l[1], r[0] - l[0]) * 180) / Math.PI

  return {
    ok: true,
    coordinateMode,
    mouthCenter,
    mouthWidth,
    xAxis,
    yAxis,
    projectY,
    pose: {
      rollDeg,
      yawProxy,
      pitchProxy,
      faceScale: mouthWidth,
    },
    yAxisTowardChin,
    error: "",
  }
}

export function evaluateMouthPoseGate(currentPose, neutralPose, cfg = {}) {
  const yawDelta = Math.abs(safeFloat(currentPose?.yawProxy, 0) - safeFloat(neutralPose?.yawProxy, 0))
  const pitchDelta = Math.abs(safeFloat(currentPose?.pitchProxy, 0) - safeFloat(neutralPose?.pitchProxy, 0))
  const rollDelta = Math.abs(safeFloat(currentPose?.rollDeg, 0) - safeFloat(neutralPose?.rollDeg, 0))
  const ns = Math.max(1e-6, safeFloat(neutralPose?.faceScale, 1))
  const scaleDelta = Math.abs(safeFloat(currentPose?.faceScale, ns) - ns) / ns
  const reasons = []
  if (yawDelta > safeFloat(cfg.maxYawProxyDelta, 0.1)) reasons.push("yaw")
  if (pitchDelta > safeFloat(cfg.maxPitchProxyDelta, 0.1)) reasons.push("pitch")
  if (rollDelta > safeFloat(cfg.maxRollDeltaDeg, 12)) reasons.push("roll")
  if (scaleDelta > safeFloat(cfg.maxFaceScaleDelta, 0.18)) reasons.push("scale")
  const active = cfg.poseGateEnabled !== false && reasons.length > 0
  return {
    active,
    reasons,
    yawDelta,
    pitchDelta,
    rollDelta,
    scaleDelta,
    poseMotionSuppressScale: safeFloat(cfg.poseMotionSuppressScale, 0.25),
  }
}

export function cloneDeepPlain(value) {
  if (value == null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map((x) => cloneDeepPlain(x))
  const out = {}
  for (const [k, v] of Object.entries(value)) out[k] = cloneDeepPlain(v)
  return out
}

export function mergeNumericConfig(defaults, raw) {
  const base = cloneDeepPlain(defaults)
  if (!raw || typeof raw !== "object") return base
  for (const [k, v] of Object.entries(defaults)) {
    if (typeof v === "boolean") {
      base[k] = raw[k] == null ? v : Boolean(raw[k])
    } else if (typeof v === "string") {
      const cand = raw[k]
      base[k] = cand == null || cand === "" ? v : String(cand)
    } else if (Array.isArray(v)) {
      const arr = raw[k]
      base[k] = Array.isArray(arr) ? arr.map((x) => (typeof x === "number" ? x : Math.trunc(Number(x) || 0))) : v.slice()
    } else if (typeof v === "number") {
      base[k] = safeFloat(raw[k], v)
    } else if (v && typeof v === "object") {
      base[k] = mergeNumericConfig(v, raw[k])
    } else {
      base[k] = raw[k] == null ? v : raw[k]
    }
  }
  return base
}
