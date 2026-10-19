/**
 * Closed-chain IK / FK — port of Luvia inverse.py + forward.py + branch_selector.
 */

import { wrapDeg, hypot2, vec3Dot, vec3Sub, vec3Cross, vec3Add, vec3Clone } from "./math3.js"
import {
  closureResiduals,
  decomposeCrank,
  platformAnchor,
  crankPin,
  requireFormallyUsable,
  validateNeutralGeometry,
  getSide,
} from "./neckGeometry.js"

const ACOS_EPS = 1e-9

/** abs distance — NOT wrap distance (Luvia branch_selector). */
export function selectNearest(candidates, previous) {
  if (!candidates || candidates.length === 0) return null
  let best = candidates[0]
  let bestD = Math.abs(Number(best) - Number(previous))
  for (let i = 1; i < candidates.length; i++) {
    const d = Math.abs(Number(candidates[i]) - Number(previous))
    if (d < bestD) {
      best = candidates[i]
      bestD = d
    }
  }
  return best
}

export function analyticSideRoots(geom, { side, pitchDeg, rollDeg }) {
  const sideG = getSide(geom, side)
  if (sideG.linkLengthMm == null) return { roots: [], reject: "missing_link_length" }
  const dec = decomposeCrank(sideG, `SIDE_${side}`)
  const a = platformAnchor(geom, { side, pitchDeg, rollDeg })
  const o = vec3Clone(sideG.oMm)
  const cPt = vec3Add(o, dec.vParallel)
  const u = dec.vRadial
  const w = vec3Cross(dec.nHat, u)
  const ac = vec3Sub(a, cPt)
  const r2 = Number(dec.crankRadiusMm) ** 2
  const l = Number(sideG.linkLengthMm)
  const alpha = vec3Dot(ac, u)
  const beta = vec3Dot(ac, w)
  const c = 0.5 * (vec3Dot(ac, ac) + r2 - l * l)
  const rho = hypot2(alpha, beta)
  if (rho <= ACOS_EPS) {
    if (Math.abs(c) <= ACOS_EPS * Math.max(1, Math.abs(l))) return { roots: [0], reject: "" }
    return { roots: [], reject: "UNREACHABLE" }
  }
  let ratio = c / rho
  if (Math.abs(ratio) > 1 + ACOS_EPS) return { roots: [], reject: "UNREACHABLE" }
  if (Math.abs(ratio) > 1) ratio = Math.sign(ratio)
  const psi = Math.atan2(beta, alpha)
  const delta = Math.acos(ratio)
  const rootsRaw = [wrapDeg((psi + delta) * (180 / Math.PI)), wrapDeg((psi - delta) * (180 / Math.PI))]
  const uniq = []
  for (const r of rootsRaw) {
    if (!uniq.some((u0) => Math.abs(r - u0) < 1e-7)) uniq.push(r)
  }
  return { roots: uniq, reject: "" }
}

export function solveIk(
  geom,
  {
    pitchDeg,
    rollDeg,
    previousQ1Deg = 0,
    previousQ2Deg = 0,
    qLimitDeg = 180,
  } = {}
) {
  const report = validateNeutralGeometry(geom)
  if (report.status === "INCOMPLETE" || report.status === "FAIL") {
    return {
      q1Deg: previousQ1Deg,
      q2Deg: previousQ2Deg,
      valid: false,
      branch: "none",
      closureErrorMm: Infinity,
      rejectReason: `IK disabled: ${report.status} — ${report.message}`,
    }
  }
  if (geom.status !== "VALIDATED") {
    return {
      q1Deg: previousQ1Deg,
      q2Deg: previousQ2Deg,
      valid: false,
      branch: "none",
      closureErrorMm: Infinity,
      rejectReason: "SKIPPED_GEOMETRY_NOT_VALIDATED",
    }
  }
  try {
    requireFormallyUsable(geom)
  } catch (exc) {
    return {
      q1Deg: previousQ1Deg,
      q2Deg: previousQ2Deg,
      valid: false,
      branch: "none",
      closureErrorMm: Infinity,
      rejectReason: String(exc.message || exc),
    }
  }

  const { roots: q1Roots, reject: rej1 } = analyticSideRoots(geom, {
    side: 1,
    pitchDeg,
    rollDeg,
  })
  const { roots: q2Roots, reject: rej2 } = analyticSideRoots(geom, {
    side: 2,
    pitchDeg,
    rollDeg,
  })
  if (rej1 === "UNREACHABLE" || rej2 === "UNREACHABLE" || !q1Roots.length || !q2Roots.length) {
    return {
      q1Deg: previousQ1Deg,
      q2Deg: previousQ2Deg,
      valid: false,
      branch: "none",
      closureErrorMm: Infinity,
      rejectReason: "UNREACHABLE",
    }
  }

  const inWindow = (roots, prev) => {
    const win = roots.filter((r) => Math.abs(wrapDeg(r - prev)) <= Number(qLimitDeg) + 1e-9)
    return win.length ? win : roots
  }
  const q1Cands = inWindow(q1Roots, previousQ1Deg)
  const q2Cands = inWindow(q2Roots, previousQ2Deg)

  let q1
  let q2
  if (Math.abs(previousQ1Deg) < 1e-9 && Math.abs(pitchDeg) < 1e-9 && Math.abs(rollDeg) < 1e-9) {
    q1 = selectNearest(q1Cands, 0)
  } else {
    q1 = selectNearest(q1Cands, previousQ1Deg)
  }
  if (Math.abs(previousQ2Deg) < 1e-9 && Math.abs(pitchDeg) < 1e-9 && Math.abs(rollDeg) < 1e-9) {
    q2 = selectNearest(q2Cands, 0)
  } else {
    q2 = selectNearest(q2Cands, previousQ2Deg)
  }

  if (q1 == null || q2 == null) {
    return {
      q1Deg: previousQ1Deg,
      q2Deg: previousQ2Deg,
      valid: false,
      branch: "none",
      closureErrorMm: Infinity,
      rejectReason: "UNREACHABLE",
    }
  }

  const res = closureResiduals(geom, {
    q1Deg: q1,
    q2Deg: q2,
    pitchDeg,
    rollDeg,
    lengthTolMm: 0.1,
  })
  return {
    q1Deg: Number(q1),
    q2Deg: Number(q2),
    valid: Boolean(res.valid),
    branch: "nearest_continuous",
    closureErrorMm: Number(res.maxLengthErrorMm),
    rejectReason: res.valid ? "" : "closure residual above tolerance",
  }
}

function sideF(geom, side, pitch, roll, q) {
  const sideG = getSide(geom, side)
  const a = platformAnchor(geom, { side, pitchDeg: pitch, rollDeg: roll })
  const b = crankPin(geom, { side, qDeg: q })
  const l = Number(sideG.linkLengthMm)
  const d = vec3Sub(a, b)
  return vec3Dot(d, d) - l * l
}

function residuals(geom, q1, q2, pitch, roll) {
  return [sideF(geom, 1, pitch, roll, q1), sideF(geom, 2, pitch, roll, q2)]
}

function norm2(f) {
  return Math.hypot(f[0], f[1])
}

export function solveFk(
  geom,
  {
    q1Deg,
    q2Deg,
    previousPitchDeg = 0,
    previousRollDeg = 0,
    poseLimitDeg = 30,
  } = {}
) {
  const report = validateNeutralGeometry(geom)
  if (report.status === "INCOMPLETE" || report.status === "FAIL") {
    return {
      pitchDeg: previousPitchDeg,
      rollDeg: previousRollDeg,
      valid: false,
      branch: "none",
      closureErrorMm: Infinity,
      solverIterations: 0,
      rejectReason: `FK disabled: ${report.status} — ${report.message}`,
    }
  }
  if (geom.status !== "VALIDATED") {
    return {
      pitchDeg: previousPitchDeg,
      rollDeg: previousRollDeg,
      valid: false,
      branch: "none",
      closureErrorMm: Infinity,
      solverIterations: 0,
      rejectReason: "SKIPPED_GEOMETRY_NOT_VALIDATED",
    }
  }
  try {
    requireFormallyUsable(geom)
  } catch (exc) {
    return {
      pitchDeg: previousPitchDeg,
      rollDeg: previousRollDeg,
      valid: false,
      branch: "none",
      closureErrorMm: Infinity,
      solverIterations: 0,
      rejectReason: String(exc.message || exc),
    }
  }

  let th = Number(previousPitchDeg)
  let ph = Number(previousRollDeg)
  if (
    Math.abs(q1Deg) < 1e-9 &&
    Math.abs(q2Deg) < 1e-9 &&
    Math.abs(th) < 1e-9 &&
    Math.abs(ph) < 1e-9
  ) {
    const res0 = closureResiduals(geom, {
      q1Deg: 0,
      q2Deg: 0,
      pitchDeg: 0,
      rollDeg: 0,
      lengthTolMm: 1e-6,
    })
    if (res0.valid) {
      return {
        pitchDeg: 0,
        rollDeg: 0,
        valid: true,
        branch: "neutral",
        closureErrorMm: Number(res0.maxAbsResidualMm),
        solverIterations: 0,
        rejectReason: "",
      }
    }
  }

  let iters = 0
  const eps = 1e-5
  const damped = 1e-8
  for (let k = 0; k < 40; k++) {
    iters += 1
    const f = residuals(geom, q1Deg, q2Deg, th, ph)
    if (norm2(f) < 1e-8) break
    const fTh = residuals(geom, q1Deg, q2Deg, th + eps, ph)
    const fPh = residuals(geom, q1Deg, q2Deg, th, ph + eps)
    // J columns = dF/d(pitch), dF/d(roll)
    const j00 = (fTh[0] - f[0]) / eps
    const j10 = (fTh[1] - f[1]) / eps
    const j01 = (fPh[0] - f[0]) / eps
    const j11 = (fPh[1] - f[1]) / eps
    // Solve (J^T J + λ I) δ = J^T (-f)
    const a00 = j00 * j00 + j10 * j10 + damped
    const a01 = j00 * j01 + j10 * j11
    const a11 = j01 * j01 + j11 * j11 + damped
    const b0 = -(j00 * f[0] + j10 * f[1])
    const b1 = -(j01 * f[0] + j11 * f[1])
    const det = a00 * a11 - a01 * a01
    if (!Number.isFinite(det) || Math.abs(det) < 1e-18) break
    const d0 = (a11 * b0 - a01 * b1) / det
    const d1 = (-a01 * b0 + a00 * b1) / det
    th = th + d0
    ph = ph + d1
    const lim = Number(poseLimitDeg)
    th = Math.max(-lim, Math.min(lim, th))
    ph = Math.max(-lim, Math.min(lim, ph))
    if (Math.hypot(d0, d1) < 1e-10) break
  }

  const res = closureResiduals(geom, {
    q1Deg,
    q2Deg,
    pitchDeg: th,
    rollDeg: ph,
    lengthTolMm: 0.1,
  })
  if (!res.valid) {
    return {
      pitchDeg: Number(th),
      rollDeg: Number(ph),
      valid: false,
      branch: "newton",
      closureErrorMm: Number(res.maxAbsResidualMm),
      solverIterations: iters,
      rejectReason: "closure residual above tolerance",
    }
  }
  return {
    pitchDeg: Number(th),
    rollDeg: Number(ph),
    valid: true,
    branch: "newton_previous_seed",
    closureErrorMm: Number(res.maxAbsResidualMm),
    solverIterations: iters,
    rejectReason: "",
  }
}
