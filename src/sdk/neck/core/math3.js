/**
 * Pure 3D math for BASE neck kinematics (Luvia rotation.py / inverse wrap).
 * No DOM / React / timers.
 */

export function deg2rad(deg) {
  return (Number(deg) * Math.PI) / 180
}

export function rad2deg(rad) {
  return (Number(rad) * 180) / Math.PI
}

/** Wrap to (-180, 180]. */
export function wrapDeg(q) {
  let x = (((Number(q) + 180) % 360) + 360) % 360 - 180
  if (Math.abs(x + 180) < 1e-12) return 180
  return x
}

export function vec3(x = 0, y = 0, z = 0) {
  return [Number(x), Number(y), Number(z)]
}

export function vec3Clone(v) {
  return [Number(v[0]), Number(v[1]), Number(v[2])]
}

export function vec3Add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

export function vec3Sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

export function vec3Scale(a, s) {
  const k = Number(s)
  return [a[0] * k, a[1] * k, a[2] * k]
}

export function vec3Dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

export function vec3Cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

export function vec3Norm(a) {
  return Math.hypot(a[0], a[1], a[2])
}

export function vec3Normalize(a, eps = 1e-12) {
  const n = vec3Norm(a)
  if (n < eps) throw new Error("vector has near-zero norm")
  return vec3Scale(a, 1 / n)
}

/** Right-hand rotation about BASE +X (Roll ϕ). Returns row-major 3×3. */
export function rx(phiDeg) {
  const c = Math.cos(deg2rad(phiDeg))
  const s = Math.sin(deg2rad(phiDeg))
  return [
    [1, 0, 0],
    [0, c, -s],
    [0, s, c],
  ]
}

/** Right-hand rotation about BASE +Y (Pitch θ). */
export function ry(thetaDeg) {
  const c = Math.cos(deg2rad(thetaDeg))
  const s = Math.sin(deg2rad(thetaDeg))
  return [
    [c, 0, s],
    [0, 1, 0],
    [-s, 0, c],
  ]
}

export function mat3Mul(a, b) {
  const out = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j]
    }
  }
  return out
}

export function mat3Vec(r, p) {
  return [
    r[0][0] * p[0] + r[0][1] * p[1] + r[0][2] * p[2],
    r[1][0] * p[0] + r[1][1] * p[1] + r[1][2] * p[2],
    r[2][0] * p[0] + r[2][1] * p[1] + r[2][2] * p[2],
  ]
}

/** Platform attitude in BASE: R_BH(θ, ϕ) = Rx(ϕ) Ry(θ). */
export function rBh(pitchDeg, rollDeg) {
  return mat3Mul(rx(rollDeg), ry(pitchDeg))
}

export function applyRotation(r, point) {
  return mat3Vec(r, vec3Clone(point))
}

/** Rodrigues rotation of vector about unit axis by angle_deg. */
export function rodriguesRotate(vector, axis, angleDeg) {
  const v = vec3Clone(vector)
  let k = vec3Clone(axis)
  const n = vec3Norm(k)
  if (n < 1e-12) throw new Error("rotation axis has near-zero norm")
  k = vec3Scale(k, 1 / n)
  const ang = deg2rad(angleDeg)
  const c = Math.cos(ang)
  const s = Math.sin(ang)
  const kxv = vec3Cross(k, v)
  const kdotv = vec3Dot(k, v)
  return vec3Add(vec3Add(vec3Scale(v, c), vec3Scale(kxv, s)), vec3Scale(k, kdotv * (1 - c)))
}

export function hypot2(a, b) {
  return Math.hypot(Number(a), Number(b))
}
