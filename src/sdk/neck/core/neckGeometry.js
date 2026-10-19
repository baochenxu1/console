/**
 * BASE neck geometry helpers — port of Luvia geometry.py (formal A0/O/n/B0/L).
 */

import {
  applyRotation,
  rBh,
  rodriguesRotate,
  vec3Clone,
  vec3Cross,
  vec3Dot,
  vec3Norm,
  vec3Scale,
  vec3Sub,
  vec3Add,
} from "./math3.js"

export class GeometryError extends Error {
  constructor(message) {
    super(message)
    this.name = "GeometryError"
  }
}

function normalizeAxis(n, label, atol = 1e-3) {
  const arr = vec3Clone(n)
  const norm = vec3Norm(arr)
  if (norm < 1e-12) throw new GeometryError(`${label}: crank_axis_direction_n has near-zero norm`)
  if (Math.abs(norm - 1) > atol) {
    throw new GeometryError(
      `${label}: crank_axis_direction_n must be unit length (|n|≈1), got |n|=${norm}`
    )
  }
  return vec3Scale(arr, 1 / norm)
}

export function sideMissingFields(side) {
  const missing = []
  if (!side?.a0Mm) missing.push("platform_anchor_A0")
  if (!side?.oMm) missing.push("crank_axis_point_O")
  if (!side?.n) missing.push("crank_axis_direction_n")
  if (!side?.b0Mm) missing.push("crank_pin_B0")
  if (side?.linkLengthMm == null || !Number.isFinite(Number(side.linkLengthMm))) {
    missing.push("link_length_mm")
  }
  return missing
}

export function sideComplete(side) {
  return sideMissingFields(side).length === 0
}

export function hasCompleteSides(geom) {
  return sideComplete(geom.side1) && sideComplete(geom.side2)
}

export function getSide(geom, side) {
  if (side === 1) return geom.side1
  if (side === 2) return geom.side2
  throw new GeometryError("side must be 1 or 2")
}

export function decomposeCrank(side, label = "side") {
  if (!side?.oMm || !side?.n || !side?.b0Mm) {
    throw new GeometryError(`${label}: O/n/B0 required for crank decomposition`)
  }
  const nHat = normalizeAxis(side.n, label)
  const v = vec3Sub(side.b0Mm, side.oMm)
  const vParallel = vec3Scale(nHat, vec3Dot(v, nHat))
  const vRadial = vec3Sub(v, vParallel)
  if (Math.abs(vec3Dot(vRadial, nHat)) > 1e-8) {
    throw new GeometryError(`${label}: v_radial not perpendicular to n after decomposition`)
  }
  return {
    nHat,
    v,
    vParallel,
    vRadial,
    axialOffsetMm: vec3Norm(vParallel),
    crankRadiusMm: vec3Norm(vRadial),
  }
}

export function platformAnchor(geom, { side, pitchDeg, rollDeg }) {
  const s = getSide(geom, side)
  if (!s.a0Mm) throw new GeometryError(`SIDE_${side}: platform_anchor_A0 is not defined`)
  return applyRotation(rBh(pitchDeg, rollDeg), s.a0Mm)
}

export function crankPin(geom, { side, qDeg }) {
  const s = getSide(geom, side)
  const dec = decomposeCrank(s, `SIDE_${side}`)
  const rotated = rodriguesRotate(dec.vRadial, dec.nHat, Number(qDeg))
  return vec3Add(vec3Add(vec3Clone(s.oMm), dec.vParallel), rotated)
}

export function requireComplete(geom) {
  if (!hasCompleteSides(geom)) {
    throw new GeometryError("BASE geometry incomplete: missing A0/O/n/B0/L on one or both sides")
  }
}

export function requireFormallyUsable(geom) {
  const mathStatus = geom.mathematicalStatus || geom.status
  if (mathStatus !== "VALIDATED" && geom.status !== "VALIDATED") {
    throw new GeometryError(
      `IK/FK disabled: geometry.status=${JSON.stringify(geom.status)} ` +
        `mathematical_status=${JSON.stringify(geom.mathematicalStatus)} (need VALIDATED)`
    )
  }
  requireComplete(geom)
}

export function closureResiduals(
  geom,
  { q1Deg, q2Deg, pitchDeg, rollDeg, lengthTolMm = 0.1 }
) {
  requireComplete(geom)
  const a1 = platformAnchor(geom, { side: 1, pitchDeg, rollDeg })
  const a2 = platformAnchor(geom, { side: 2, pitchDeg, rollDeg })
  const b1 = crankPin(geom, { side: 1, qDeg: q1Deg })
  const b2 = crankPin(geom, { side: 2, qDeg: q2Deg })
  const d1 = vec3Norm(vec3Sub(a1, b1))
  const d2 = vec3Norm(vec3Sub(a2, b2))
  const l1 = Number(geom.side1.linkLengthMm)
  const l2 = Number(geom.side2.linkLengthMm)
  const e1 = d1 - l1
  const e2 = d2 - l2
  const maxAbs = Math.max(Math.abs(e1), Math.abs(e2))
  return {
    a1Mm: a1,
    a2Mm: a2,
    b1Mm: b1,
    b2Mm: b2,
    actualLength1Mm: d1,
    actualLength2Mm: d2,
    configuredLength1Mm: l1,
    configuredLength2Mm: l2,
    residual1Mm: e1,
    residual2Mm: e2,
    maxAbsResidualMm: maxAbs,
    maxLengthErrorMm: maxAbs,
    valid: maxAbs <= Number(lengthTolMm),
  }
}

/** Simplified neutral gate matching Luvia validate_neutral_geometry PASS/WARNING/FAIL/INCOMPLETE. */
export function validateNeutralGeometry(geom) {
  if (!hasCompleteSides(geom)) {
    return {
      status: "INCOMPLETE",
      message: "REQUIRED_MEASUREMENT: BASE geometry fields incomplete",
    }
  }
  try {
    const a1 = platformAnchor(geom, { side: 1, pitchDeg: 0, rollDeg: 0 })
    const a2 = platformAnchor(geom, { side: 2, pitchDeg: 0, rollDeg: 0 })
    const b1 = crankPin(geom, { side: 1, qDeg: 0 })
    const b2 = crankPin(geom, { side: 2, qDeg: 0 })
    const close = (u, v) =>
      Math.abs(u[0] - v[0]) <= 1e-9 && Math.abs(u[1] - v[1]) <= 1e-9 && Math.abs(u[2] - v[2]) <= 1e-9
    if (!close(a1, geom.side1.a0Mm)) throw new GeometryError("neutral A1 != A10")
    if (!close(a2, geom.side2.a0Mm)) throw new GeometryError("neutral A2 != A20")
    if (!close(b1, geom.side1.b0Mm)) throw new GeometryError("neutral B1 != B10")
    if (!close(b2, geom.side2.b0Mm)) throw new GeometryError("neutral B2 != B20")
    const residuals = closureResiduals(geom, {
      q1Deg: 0,
      q2Deg: 0,
      pitchDeg: 0,
      rollDeg: 0,
      lengthTolMm: 0.1,
    })
    const classify = (err) => {
      const ae = Math.abs(err)
      if (ae <= 0.1) return "PASS"
      if (ae <= 0.5) return "WARNING"
      return "FAIL"
    }
    const left = classify(residuals.residual1Mm)
    const right = classify(residuals.residual2Mm)
    const order = { PASS: 0, WARNING: 1, FAIL: 2 }
    const status = order[left] >= order[right] ? left : right
    return { status, message: `NEUTRAL_GEOMETRY_${status}`, residuals }
  } catch (exc) {
    return {
      status: "FAIL",
      message: `NEUTRAL_GEOMETRY_INVALID: ${exc.message || exc}`,
    }
  }
}
