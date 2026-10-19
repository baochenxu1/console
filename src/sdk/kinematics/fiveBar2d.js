/**
 * 平面五杆机构 FK / IK（与 MATLAB 版几何一致，角度为度）。
 * 坐标系：A、B 为固定铰；qA/qB 为相对零位的关节增量（度）。
 */

/** @param {number} d */
export function degToRad(d) {
  return (d * Math.PI) / 180
}

/**
 * 将角度折到 (-180, 180]（度）。
 * @param {number} angleDeg
 */
export function wrapTo180Deg(angleDeg) {
  let a = Number(angleDeg)
  if (!Number.isFinite(a)) {
    return 0
  }
  a = ((((a + 180) % 360) + 360) % 360) - 180
  if (a <= -180) {
    return 180
  }
  return a
}

/**
 * 两圆交点：圆心 P1 半径 r1，圆心 P2 半径 r2。
 * @param {[number, number]} P1
 * @param {number} r1
 * @param {[number, number]} P2
 * @param {number} r2
 */
export function circleCircleIntersections(P1, r1, P2, r2) {
  const x1 = P1[0]
  const y1 = P1[1]
  const x2 = P2[0]
  const y2 = P2[1]
  const dx = x2 - x1
  const dy = y2 - y1
  const d = Math.hypot(dx, dy)
  const eps = 1e-9

  if (d < eps) {
    if (Math.abs(r1 - r2) < 1e-6) {
      return { ok: false, message: "同心圆无穷多解", pts: [] }
    }
    return { ok: false, message: "圆心重合半径不同", pts: [] }
  }
  if (d > r1 + r2 + 1e-6) {
    return { ok: false, message: "两圆相离", pts: [] }
  }
  if (d < Math.abs(r1 - r2) - 1e-6) {
    return { ok: false, message: "一圆内含另一圆", pts: [] }
  }

  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d)
  const h2 = r1 * r1 - a * a
  const h = Math.sqrt(Math.max(0, h2))
  const mx = x1 + (a * dx) / d
  const my = y1 + (a * dy) / d
  const rx = (-dy * h) / d
  const ry = (dx * h) / d
  const pA = [mx - rx, my - ry]
  const pB = [mx + rx, my + ry]
  return { ok: true, message: "", pts: [pA, pB] }
}

/** @deprecated 使用 {@link circleCircleIntersections} */
export const circle2Intersection = circleCircleIntersections

/**
 * @param {[number, number]} p0
 * @param {[number, number]} p1
 * @param {"left" | "right"} branch
 */
function pickDByXBranch(p0, p1, branch) {
  if (Math.abs(p0[0] - p1[0]) < 1e-10) {
    if (branch === "left") {
      return p0[1] <= p1[1] ? p0 : p1
    }
    return p0[1] >= p1[1] ? p0 : p1
  }
  if (branch === "left") {
    return p0[0] < p1[0] ? p0 : p1
  }
  return p0[0] > p1[0] ? p0 : p1
}

/**
 * @param {object} params
 * @param {[number, number]} params.A
 * @param {[number, number]} params.B
 * @param {number} params.L_AE
 * @param {number} params.L_BC
 * @param {number} params.L_ED
 * @param {number} params.L_CD
 * @param {number} params.thetaA0Deg
 * @param {number} params.thetaB0Deg
 * @param {number} params.dirA
 * @param {number} params.dirB
 * @param {"left" | "right"} params.fkDBranch
 */
export function fivebarFk(qA_deg, qB_deg, params) {
  const A = params.A
  const B = params.B
  const L_AE = params.L_AE
  const L_BC = params.L_BC
  const L_ED = params.L_ED
  const L_CD = params.L_CD
  const thetaA0Deg = params.thetaA0Deg
  const thetaB0Deg = params.thetaB0Deg
  const dirA = params.dirA ?? 1
  const dirB = params.dirB ?? 1
  const fkDBranch = params.fkDBranch || "left"

  const thetaADeg = thetaA0Deg + dirA * qA_deg
  const thetaBDeg = thetaB0Deg + dirB * qB_deg
  const tA = degToRad(thetaADeg)
  const tB = degToRad(thetaBDeg)
  const E = [A[0] + L_AE * Math.cos(tA), A[1] + L_AE * Math.sin(tA)]
  const C = [B[0] + L_BC * Math.cos(tB), B[1] + L_BC * Math.sin(tB)]

  const inter = circleCircleIntersections(E, L_ED, C, L_CD)
  if (!inter.ok || inter.pts.length < 2) {
    return {
      ok: false,
      message: inter.message || "D 圆交点无解",
      D: null,
      E,
      C,
      thetaA_deg: thetaADeg,
      thetaB_deg: thetaBDeg,
      D1: null,
      D2: null,
    }
  }
  const [p0, p1] = inter.pts
  const D = pickDByXBranch(p0, p1, fkDBranch)
  return {
    ok: true,
    message: "",
    D,
    E,
    C,
    thetaA_deg: thetaADeg,
    thetaB_deg: thetaBDeg,
    D1: p0,
    D2: p1,
  }
}

/**
 * @param {object} c
 * @param {{ qA_deg: number, qB_deg: number }} qRef
 */
export function chooseNearestIkCandidate(candidates, qRef) {
  const list = Array.isArray(candidates) ? candidates : []
  if (list.length === 0) {
    return null
  }
  const refA = Number(qRef?.qA_deg)
  const refB = Number(qRef?.qB_deg)
  const ra = Number.isFinite(refA) ? refA : 0
  const rb = Number.isFinite(refB) ? refB : 0
  let best = list[0]
  let bestCost = Infinity
  for (const cand of list) {
    const dA = wrapTo180Deg(cand.qA_deg - ra)
    const dB = wrapTo180Deg(cand.qB_deg - rb)
    const cost = dA * dA + dB * dB
    if (cost < bestCost) {
      bestCost = cost
      best = cand
    }
  }
  return best
}

/**
 * @param {[number, number]} D_target
 * @param {object} params
 */
export function fivebarIkAllCandidates(D_target, params) {
  const A = params.A
  const B = params.B
  const L_AE = params.L_AE
  const L_BC = params.L_BC
  const L_ED = params.L_ED
  const L_CD = params.L_CD
  const thetaA0Deg = params.thetaA0Deg
  const thetaB0Deg = params.thetaB0Deg
  const dirA = params.dirA === 0 ? 1 : params.dirA ?? 1
  const dirB = params.dirB === 0 ? 1 : params.dirB ?? 1
  const qAMinDeg = params.qAMinDeg ?? params.qMinDeg ?? -90
  const qAMaxDeg = params.qAMaxDeg ?? params.qMaxDeg ?? 90
  const qBMinDeg = params.qBMinDeg ?? params.qMinDeg ?? -90
  const qBMaxDeg = params.qBMaxDeg ?? params.qMaxDeg ?? 90

  const D = [Number(D_target[0]), Number(D_target[1])]
  if (!Number.isFinite(D[0]) || !Number.isFinite(D[1])) {
    return []
  }

  const interE = circleCircleIntersections(A, L_AE, D, L_ED)
  if (!interE.ok || interE.pts.length < 2) {
    return []
  }
  const E1 = interE.pts[0]
  const E2 = interE.pts[1]

  const interC = circleCircleIntersections(B, L_BC, D, L_CD)
  if (!interC.ok || interC.pts.length < 2) {
    return []
  }
  const C1 = interC.pts[0]
  const C2 = interC.pts[1]

  const combos = [
    [E1, C1],
    [E1, C2],
    [E2, C1],
    [E2, C2],
  ]

  const out = []
  const tol = 1e-4

  for (const [E, C] of combos) {
    const thetaA_deg = (Math.atan2(E[1] - A[1], E[0] - A[0]) * 180) / Math.PI
    const thetaB_deg = (Math.atan2(C[1] - B[1], C[0] - B[0]) * 180) / Math.PI

    const qA_deg = wrapTo180Deg(thetaA_deg - thetaA0Deg) / dirA
    const qB_deg = wrapTo180Deg(thetaB_deg - thetaB0Deg) / dirB

    if (qA_deg < qAMinDeg - 1e-3 || qA_deg > qAMaxDeg + 1e-3 || qB_deg < qBMinDeg - 1e-3 || qB_deg > qBMaxDeg + 1e-3) {
      continue
    }

    const fk = fivebarFk(qA_deg, qB_deg, params)
    if (!fk.ok || !fk.D) {
      continue
    }
    const fkError = Math.hypot(fk.D[0] - D[0], fk.D[1] - D[1])
    if (fkError > tol) {
      continue
    }

    out.push({
      qA_deg,
      qB_deg,
      thetaA_deg,
      thetaB_deg,
      E: [...E],
      C: [...C],
      fkError,
    })
  }

  return out
}
