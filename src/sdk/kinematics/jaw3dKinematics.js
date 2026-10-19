/**
 * Jaw 3D Kinematics — 2DOF 并联下巴（MATLAB 定版几何）。
 *
 * O = AD 中点 = (0,0,0)；AD ∥ X；Plane a = XY (Z=0)。
 * 舵机角 q 相对机械中位；结构角 beta = q - 5.5°（Geometry Neutral，非 Binding offset）。
 *
 * 中央连杆 OM 由中位 betaA=betaD=-5.5° 反解，禁止使用旧值 37.4166 mm（那是 beta=0 的误用）。
 */

import { clampNumber } from "../../utils/clamp.js"

/** @typedef {[number, number, number]} Vec3 */

export const JAW3D_PAD_VALUE_SPAN = 100
export const JAW3D_PAD_LATERAL_SPAN = 50

export const JAW3D_GEOMETRY = Object.freeze({
  AD: 69.5,
  CF: 69.5,
  AB: 25.0,
  DE: 25.0,
  BC: 45.0,
  EF: 45.0,
  /** Geometry Neutral 结构角（deg）；Servo 中位 q=0 对应此角 */
  beta0Deg: -5.5,
  A: /** @type {Vec3} */ ([-34.75, 0, 0]),
  D: /** @type {Vec3} */ ([34.75, 0, 0]),
})

/**
 * 工作空间：pad → 相对 Geometry Neutral 的 q 增量（deg）。
 * open 为差模，lateral 为共模；任意轴变化都重算整对 qA/qD。
 */
export const DEFAULT_JAW3D_STRUCTURE = Object.freeze({
  /** |value|=100 时共模 |q| 上限 */
  openGainDeg: 0.32,
  /** |lateral|=50 时差模 |q| 上限贡献 */
  lateralGainDeg: 0.28,
  /** 结构角相对 beta0 的允许包络（独立于舵机理论 ±90°） */
  betaMinDeg: -48,
  betaMaxDeg: 42,
  residualTolMm: 1e-6,
  sphereSampleStepDeg: 2.5,
  sphereSearchRadiusDeg: 28,
})

function degToRad(d) {
  return (Number(d) * Math.PI) / 180
}

function radToDeg(r) {
  return (Number(r) * 180) / Math.PI
}

function vAdd(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

function vSub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function vScale(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s]
}

function vDot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function vLen(a) {
  return Math.hypot(a[0], a[1], a[2])
}

function vDist(a, b) {
  return vLen(vSub(a, b))
}

function vCross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function vNormalize(a) {
  const L = vLen(a)
  if (!(L > 1e-15)) return null
  return vScale(a, 1 / L)
}

/**
 * 中位 OM 长度：betaA=betaD=beta0，CF∥X，OM∥-Z。
 * 旧误用 √(45²-25²)=√1400≈37.4166 对应 beta=0，此处禁止。
 */
export function computeJawOmLengthMm(geometry = JAW3D_GEOMETRY) {
  const g = geometry
  const beta = degToRad(g.beta0Deg)
  const c = Math.cos(beta)
  const s = Math.sin(beta)
  const ab = g.AB
  const bc = g.BC
  const inner = bc * bc - ab * ab * c * c
  if (!(inner > 0)) {
    throw new Error("Jaw OM: neutral geometry unreachable")
  }
  /* Cy=0, Cz=-OM；取 OM>0 且 M 在 -Z */
  const om = Math.sqrt(inner) - ab * s
  if (!(om > 0)) {
    throw new Error("Jaw OM: non-positive length at neutral")
  }
  return om
}

export const JAW3D_OM_LENGTH_MM = computeJawOmLengthMm()

export function resolveJaw3dStructure(override = null) {
  const o = override && typeof override === "object" ? override : {}
  return {
    openGainDeg: Number.isFinite(Number(o.openGainDeg))
      ? Number(o.openGainDeg)
      : DEFAULT_JAW3D_STRUCTURE.openGainDeg,
    lateralGainDeg: Number.isFinite(Number(o.lateralGainDeg))
      ? Number(o.lateralGainDeg)
      : DEFAULT_JAW3D_STRUCTURE.lateralGainDeg,
    betaMinDeg: Number.isFinite(Number(o.betaMinDeg))
      ? Number(o.betaMinDeg)
      : DEFAULT_JAW3D_STRUCTURE.betaMinDeg,
    betaMaxDeg: Number.isFinite(Number(o.betaMaxDeg))
      ? Number(o.betaMaxDeg)
      : DEFAULT_JAW3D_STRUCTURE.betaMaxDeg,
    residualTolMm: Number.isFinite(Number(o.residualTolMm))
      ? Number(o.residualTolMm)
      : DEFAULT_JAW3D_STRUCTURE.residualTolMm,
    sphereSampleStepDeg: Number.isFinite(Number(o.sphereSampleStepDeg))
      ? Number(o.sphereSampleStepDeg)
      : DEFAULT_JAW3D_STRUCTURE.sphereSampleStepDeg,
    sphereSearchRadiusDeg: Number.isFinite(Number(o.sphereSearchRadiusDeg))
      ? Number(o.sphereSearchRadiusDeg)
      : DEFAULT_JAW3D_STRUCTURE.sphereSearchRadiusDeg,
  }
}

export function qToBetaDeg(qDeg, geometry = JAW3D_GEOMETRY) {
  return Number(qDeg) + Number(geometry.beta0Deg)
}

export function betaToQDeg(betaDeg, geometry = JAW3D_GEOMETRY) {
  return Number(betaDeg) - Number(geometry.beta0Deg)
}

/** 曲柄端点：绕过 A/D 的 +X 轴，beta 自 +Y 向 +Z（右手）。 */
export function jawCrankPoint(origin, betaDeg, length) {
  const b = degToRad(betaDeg)
  return [origin[0], origin[1] + length * Math.cos(b), origin[2] + length * Math.sin(b)]
}

/**
 * 固定 M 时，由 |C-B|=BC、|F-E|=EF 解 CF 方向 û（单位向量）的两支。
 * @returns {Vec3[] | null}
 */
export function jawUfCandidatesForM(M, B, E, geometry = JAW3D_GEOMETRY) {
  const h = geometry.CF / 2
  const P = vSub(M, B)
  const Q = vSub(M, E)
  const a = (vDot(P, P) + h * h - geometry.BC * geometry.BC) / (2 * h)
  const b = (geometry.EF * geometry.EF - vDot(Q, Q) - h * h) / (2 * h)
  const pp = vDot(P, P)
  const qq = vDot(Q, Q)
  const pq = vDot(P, Q)
  const det = pp * qq - pq * pq
  if (!(Math.abs(det) > 1e-14)) return null
  const alpha = (a * qq - b * pq) / det
  const beta = (pp * b - pq * a) / det
  const u0 = vAdd(vScale(P, alpha), vScale(Q, beta))
  const u0sq = vDot(u0, u0)
  if (u0sq > 1 + 1e-8) return null
  const N = vCross(P, Q)
  const nLen = vLen(N)
  if (!(nLen > 1e-12)) return null
  const nHat = vScale(N, 1 / nLen)
  const t = Math.sqrt(Math.max(0, 1 - u0sq))
  return [vAdd(u0, vScale(nHat, t)), vAdd(u0, vScale(nHat, -t))]
}

function pickLockedUf(candidates, prevUf) {
  if (!candidates?.length) return null
  const scored = candidates
    .map((u) => {
      const nu = vNormalize(u)
      if (!nu) return null
      const preferX = nu[0]
      const dPrev = prevUf ? vDist(nu, prevUf) : 0
      return { u: nu, score: (preferX >= 0 ? 0 : 100) + dPrev }
    })
    .filter(Boolean)
  if (!scored.length) return null
  scored.sort((a, b) => a.score - b.score)
  return scored[0].u
}

function spherePointFromPolar(om, polarDeg, azimDeg) {
  /* polar=0 → -Z；polar 增大扫向 XY */
  const polar = degToRad(polarDeg)
  const az = degToRad(azimDeg)
  const s = Math.sin(polar)
  return [om * s * Math.cos(az), om * s * Math.sin(az), -om * Math.cos(polar)]
}

/**
 * 锁定装配支：在 -Z 半球邻域搜索 M，取 û·x≥0 且贴近 prev 的一支。
 * 禁止自动翻到对侧数学解。
 */
export function jaw3dFk(betaADeg, betaDDeg, prev = null, geometry = JAW3D_GEOMETRY, structure = null) {
  const g = geometry
  const st = resolveJaw3dStructure(structure)
  const om = computeJawOmLengthMm(g)
  const B = jawCrankPoint(g.A, betaADeg, g.AB)
  const E = jawCrankPoint(g.D, betaDDeg, g.DE)

  /* 对称中位：解析解 CF∥X、OM∥-Z，残差应机零 */
  if (
    Math.abs(betaADeg - g.beta0Deg) < 1e-12 &&
    Math.abs(betaDDeg - g.beta0Deg) < 1e-12
  ) {
    const M = [0, 0, -om]
    const uf = [1, 0, 0]
    const h = g.CF / 2
    const C = [-h, 0, -om]
    const F = [h, 0, -om]
    return {
      ok: true,
      message: "",
      B,
      E,
      C,
      F,
      M,
      uf,
      errAB: Math.abs(vDist(B, g.A) - g.AB),
      errDE: Math.abs(vDist(E, g.D) - g.DE),
      errBC: Math.abs(vDist(C, B) - g.BC),
      errEF: Math.abs(vDist(F, E) - g.EF),
      errCF: Math.abs(vDist(C, F) - g.CF),
      errOM: Math.abs(vLen(M) - om),
      residual: 0,
      branch: "locked-hemisphere-negZ",
      omLength: om,
    }
  }

  /* 共模（betaA≈betaD）：CF∥X 解析支，Cy=0 邻域取 -Z 解 */
  if (Math.abs(betaADeg - betaDDeg) < 1e-9) {
    const beta = degToRad(betaADeg)
    const c = Math.cos(beta)
    const s = Math.sin(beta)
    const By = g.AB * c
    const Bz = g.AB * s
    /* (Cy-By)^2+(Cz-Bz)^2 = BC^2 且 Cy^2+Cz^2 = OM^2；对称 Cy=0 */
    const disc = g.BC * g.BC - By * By
    if (disc >= -1e-9) {
      const root = Math.sqrt(Math.max(0, disc))
      /* Cz = Bz ± root；取接近 -OM 的一支（不翻支） */
      const cz1 = Bz + root
      const cz2 = Bz - root
      const Cz = Math.abs(cz1 + om) <= Math.abs(cz2 + om) ? cz1 : cz2
      const Cy = 0
      const M = [0, Cy, Cz]
      /* 投影到球面保持 OM */
      const Mn = vNormalize(M)
      const M2 = Mn ? vScale(Mn, om) : M
      const uf = [1, 0, 0]
      const h = g.CF / 2
      const C = [M2[0] - h, M2[1], M2[2]]
      const F = [M2[0] + h, M2[1], M2[2]]
      const errBC = Math.abs(vDist(C, B) - g.BC)
      const errEF = Math.abs(vDist(F, E) - g.EF)
      const errCF = Math.abs(vDist(C, F) - g.CF)
      const errOM = Math.abs(vLen(M2) - om)
      const tol = Math.max(st.residualTolMm, 1e-6)
      const ok =
        errBC <= 1e-3 &&
        errEF <= 1e-3 &&
        errCF <= tol &&
        errOM <= 1e-3 &&
        M2[2] < 0
      if (ok) {
        return {
          ok: true,
          message: "",
          B,
          E,
          C,
          F,
          M: M2,
          uf,
          errAB: Math.abs(vDist(B, g.A) - g.AB),
          errDE: Math.abs(vDist(E, g.D) - g.DE),
          errBC,
          errEF,
          errCF,
          errOM,
          residual: errBC + errEF + errCF + errOM,
          branch: "locked-hemisphere-negZ",
          omLength: om,
        }
      }
    }
  }

  const prevM = prev?.M && Array.isArray(prev.M) ? prev.M : [0, 0, -om]
  const prevUf = prev?.uf && Array.isArray(prev.uf) ? prev.uf : [1, 0, 0]

  let best = null
  const step = Math.max(1, st.sphereSampleStepDeg)
  const radius = Math.max(step, st.sphereSearchRadiusDeg)

  let centerPolar = 0
  let centerAz = 0
  {
    const n = vNormalize(prevM) || [0, 0, -1]
    const cz = clampNumber(-n[2], -1, 1)
    centerPolar = radToDeg(Math.acos(cz))
    centerAz = radToDeg(Math.atan2(n[1], n[0]))
  }

  for (let dPolar = -radius; dPolar <= radius + 1e-9; dPolar += step) {
    for (let dAz = -radius; dAz <= radius + 1e-9; dAz += step) {
      const M = spherePointFromPolar(om, centerPolar + dPolar, centerAz + dAz)
      if (M[2] > 0.15 * om) continue
      const cands = jawUfCandidatesForM(M, B, E, g)
      const uf = pickLockedUf(cands, prevUf)
      if (!uf) continue
      const h = g.CF / 2
      const C = vSub(M, vScale(uf, h))
      const F = vAdd(M, vScale(uf, h))
      const errAB = Math.abs(vDist(B, g.A) - g.AB)
      const errDE = Math.abs(vDist(E, g.D) - g.DE)
      const errBC = Math.abs(vDist(C, B) - g.BC)
      const errEF = Math.abs(vDist(F, E) - g.EF)
      const errCF = Math.abs(vDist(C, F) - g.CF)
      const errOM = Math.abs(vLen(M) - om)
      const residual =
        errAB + errDE + errBC + errEF + errCF + errOM + vDist(M, prevM) * 1e-3
      if (!best || residual < best.residual) {
        best = {
          ok: true,
          B,
          E,
          C,
          F,
          M,
          uf,
          errAB,
          errDE,
          errBC,
          errEF,
          errCF,
          errOM,
          residual,
          branch: "locked-hemisphere-negZ",
        }
      }
    }
  }

  if (!best) {
    return {
      ok: false,
      message: "FK: no locked-branch assembly",
      B,
      E,
      C: null,
      F: null,
      M: null,
      uf: null,
      errAB: null,
      errDE: null,
      errBC: null,
      errEF: null,
      errCF: null,
      errOM: null,
      branch: "locked-hemisphere-negZ",
    }
  }

  const tol = Math.max(st.residualTolMm, 0.08)
  const geomOk =
    best.errAB <= tol &&
    best.errDE <= tol &&
    best.errBC <= tol &&
    best.errEF <= tol &&
    best.errCF <= tol &&
    best.errOM <= tol

  return {
    ...best,
    ok: geomOk,
    message: geomOk ? "" : "FK: residual above tolerance",
    omLength: om,
  }
}

export function jawBetasWithinStructureLimits(betaADeg, betaDDeg, structure = null) {
  const st = resolveJaw3dStructure(structure)
  const a = Number(betaADeg)
  const d = Number(betaDDeg)
  if (!Number.isFinite(a) || !Number.isFinite(d)) {
    return { ok: false, reason: "non-finite-beta" }
  }
  if (a < st.betaMinDeg || a > st.betaMaxDeg || d < st.betaMinDeg || d > st.betaMaxDeg) {
    return { ok: false, reason: "beta-structure-limit" }
  }
  return { ok: true, reason: "" }
}

/**
 * Pad → qA/qD（共模/差模），再 FK 校验；超限整组拒绝（Hold 由上层 state 处理）。
 * 禁止 Open→单舵机 / Lateral→单舵机。
 *
 * 真机约定：
 *   value（开合）→ 差模；语义与追踪一致：负值张嘴、正值闭嘴
 *   lateral（左右）→ 共模；语义：负值向左、正值向右（latPart 取负以对齐真机）
 * 任意轴变化都用完整 {value, lateral} 重算两路。
 */
export function jawPadToCommandQs(value, lateral, structure = null, geometry = JAW3D_GEOMETRY) {
  const st = resolveJaw3dStructure(structure)
  const v = clampNumber(Number(value) || 0, -JAW3D_PAD_VALUE_SPAN, JAW3D_PAD_VALUE_SPAN)
  const lat = clampNumber(Number(lateral) || 0, -JAW3D_PAD_LATERAL_SPAN, JAW3D_PAD_LATERAL_SPAN)
  /* 开合 / 左右均相对初版增益取负，对齐真机与 UI 语义 */
  const openPart = -st.openGainDeg * v
  const latPart = -st.lateralGainDeg * lat
  const qA = latPart - openPart
  const qD = latPart + openPart
  const betaA = qToBetaDeg(qA, geometry)
  const betaD = qToBetaDeg(qD, geometry)
  return { value: v, lateral: lat, qA, qD, betaA, betaD }
}

export function createJaw3dState() {
  const om = JAW3D_OM_LENGTH_MM
  const beta0 = JAW3D_GEOMETRY.beta0Deg
  const M0 = [0, 0, -om]
  const uf0 = [1, 0, 0]
  const h = JAW3D_GEOMETRY.CF / 2
  const C0 = [-h, 0, -om]
  const F0 = [h, 0, -om]
  return {
    lastOk: true,
    lastQA: 0,
    lastQD: 0,
    lastBetaA: beta0,
    lastBetaD: beta0,
    lastM: M0,
    lastC: C0,
    lastF: F0,
    lastUf: uf0,
    lastRejectReason: "",
  }
}

/**
 * 完整 {value, lateral} → 一次求解 → {qA,qD}。
 * IK 无效：整组拒绝，保持 last valid pair；不翻支。
 */
export function solveJaw3dFromPad(pad, state = null, structure = null, geometry = JAW3D_GEOMETRY) {
  const st = state || createJaw3dState()
  const struct = resolveJaw3dStructure(structure)
  const cmd = jawPadToCommandQs(pad?.value, pad?.lateral, struct, geometry)

  const lim = jawBetasWithinStructureLimits(cmd.betaA, cmd.betaD, struct)
  if (!lim.ok) {
    return {
      ok: false,
      message: lim.reason || "structure-limit",
      qA: st.lastQA,
      qD: st.lastQD,
      betaA: st.lastBetaA,
      betaD: st.lastBetaD,
      hold: true,
      diagnostics: {
        input: { value: cmd.value, lateral: cmd.lateral },
        geometry: { M: st.lastM, C: st.lastC, F: st.lastF, betaA: st.lastBetaA, betaD: st.lastBetaD },
        servo: { qA: st.lastQA, qD: st.lastQD },
        constraints: {
          errAB: null,
          errDE: null,
          errBC: null,
          errEF: null,
          errCF: null,
          errOM: null,
          branch: "locked-hemisphere-negZ",
          limitReason: lim.reason,
        },
      },
    }
  }

  const fk = jaw3dFk(
    cmd.betaA,
    cmd.betaD,
    { M: st.lastM, uf: st.lastUf },
    geometry,
    struct
  )

  if (!fk.ok || !Number.isFinite(cmd.qA) || !Number.isFinite(cmd.qD)) {
    st.lastRejectReason = fk.message || "ik-failed"
    return {
      ok: false,
      message: st.lastRejectReason,
      qA: st.lastQA,
      qD: st.lastQD,
      betaA: st.lastBetaA,
      betaD: st.lastBetaD,
      hold: true,
      diagnostics: {
        input: { value: cmd.value, lateral: cmd.lateral },
        geometry: { M: st.lastM, C: st.lastC, F: st.lastF, betaA: st.lastBetaA, betaD: st.lastBetaD },
        servo: { qA: st.lastQA, qD: st.lastQD },
        constraints: {
          errAB: fk.errAB,
          errDE: fk.errDE,
          errBC: fk.errBC,
          errEF: fk.errEF,
          errCF: fk.errCF,
          errOM: fk.errOM,
          branch: fk.branch || "locked-hemisphere-negZ",
          limitReason: st.lastRejectReason,
        },
      },
    }
  }

  /* 精确残差：中位与成功解要求 < 1e-4 mm（采样 FK 对非中位放宽到结构包络内） */
  const tight =
    Math.abs(cmd.value) < 1e-9 && Math.abs(cmd.lateral) < 1e-9
      ? struct.residualTolMm
      : Math.max(struct.residualTolMm, 0.05)
  const residualOk =
    fk.errAB <= tight &&
    fk.errDE <= tight &&
    fk.errBC <= tight &&
    fk.errEF <= tight &&
    fk.errCF <= tight &&
    fk.errOM <= tight

  if (!residualOk) {
    st.lastRejectReason = "geometry-residual"
    return {
      ok: false,
      message: "geometry-residual",
      qA: st.lastQA,
      qD: st.lastQD,
      betaA: st.lastBetaA,
      betaD: st.lastBetaD,
      hold: true,
      diagnostics: {
        input: { value: cmd.value, lateral: cmd.lateral },
        geometry: { M: fk.M, C: fk.C, F: fk.F, betaA: cmd.betaA, betaD: cmd.betaD },
        servo: { qA: st.lastQA, qD: st.lastQD },
        constraints: {
          errAB: fk.errAB,
          errDE: fk.errDE,
          errBC: fk.errBC,
          errEF: fk.errEF,
          errCF: fk.errCF,
          errOM: fk.errOM,
          branch: fk.branch,
          limitReason: "geometry-residual",
        },
      },
    }
  }

  st.lastOk = true
  st.lastQA = cmd.qA
  st.lastQD = cmd.qD
  st.lastBetaA = cmd.betaA
  st.lastBetaD = cmd.betaD
  st.lastM = fk.M
  st.lastC = fk.C
  st.lastF = fk.F
  st.lastUf = fk.uf
  st.lastRejectReason = ""

  return {
    ok: true,
    message: "",
    qA: cmd.qA,
    qD: cmd.qD,
    betaA: cmd.betaA,
    betaD: cmd.betaD,
    hold: false,
    diagnostics: {
      input: { value: cmd.value, lateral: cmd.lateral },
      geometry: { M: fk.M, C: fk.C, F: fk.F, betaA: cmd.betaA, betaD: cmd.betaD },
      servo: { qA: cmd.qA, qD: cmd.qD },
      constraints: {
        errAB: fk.errAB,
        errDE: fk.errDE,
        errBC: fk.errBC,
        errEF: fk.errEF,
        errCF: fk.errCF,
        errOM: fk.errOM,
        branch: fk.branch,
        limitReason: "",
      },
      omLength: fk.omLength,
    },
  }
}
