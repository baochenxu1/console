/**
 * BrowFiveBarKinematics — 新眉毛五杆（MATLAB 验证几何）。
 *
 * 全局坐标：DD' 为 X，中点原点，+X 右，+Y 上。
 * Canonical = 右眉几何；左眉仅通过 X 镜像复用同一 Solver。
 *
 * UI brow.x/y (-100..100, 中位 0) → A(x,y) → IK → qD,qF（相对机械中位）
 * Pad X/Y 为屏幕绝对方向（左右眉一致）；左眉求解前再经 X 镜像进 Canonical。
 * 右眉 Binding：brow_r_F ← qF → ID1，brow_r_D ← qD → ID2。
 * 遗留字段 tipA_deg≡qD、tipB_deg≡qF（tip_a≡D、tip_b≡F）；真实舵机方向/零点由 Binding 处理。
 * 20.39° / DC 初始角仅属 Neutral Geometry，不是舵机命令。
 */

import { clampNumber } from "../../utils/clamp.js"
import { circleCircleIntersections, wrapTo180Deg, degToRad } from "./fiveBar2d.js"

/** @typedef {[number, number]} Vec2 */

export const BROW_FIVEBAR_PAD_SPAN = 100

/** 右眉固定点与杆长（mm / deg）— MATLAB 定版 */
export const BROW_FIVEBAR_RIGHT_GEOMETRY = Object.freeze({
  D: /** @type {Vec2} */ ([41.95, 0]),
  F: /** @type {Vec2} */ ([10.26, 0]),
  DC: 10.0,
  FE: 10.0,
  BC: 28.35,
  BE: 22.05,
  AB: 19.0,
  AC: 47.35,
  /** 机械中位绝对角：D→C */
  thetaD0Deg: 180,
  /** 机械中位绝对角：F→E */
  thetaF0Deg: -20.39,
  /** MATLAB 验证中位 A */
  A0: /** @type {Vec2} */ ([11.376557, -42.646875]),
})

/** 左眉固定点（镜像）；A0 亦镜像。不单独写 Left IK。 */
export const BROW_FIVEBAR_LEFT_ANCHORS = Object.freeze({
  D: /** @type {Vec2} */ ([-41.95, 0]),
  F: /** @type {Vec2} */ ([-10.26, 0]),
  A0: /** @type {Vec2} */ ([-11.376557, -42.646875]),
  thetaD0Deg: 0,
  thetaF0Deg: -159.61,
})

/**
 * Structure Profile 可调工作空间（mm）：A = A0 + (brow/100)*range
 * 默认由 ±90° 采样得到的安全包络，可被 profile.kinematics 覆盖。
 */
export const DEFAULT_BROW_FIVEBAR_STRUCTURE = Object.freeze({
  /** ±90° FK 采样包络内的安全半宽（mm）；可由 Structure/kinematics 覆盖 */
  rangeX: 12,
  rangeY: 4.5,
  qDMinDeg: -90,
  qDMaxDeg: 90,
  qFMinDeg: -90,
  qFMaxDeg: 90,
})

function vAdd(a, b) {
  return [a[0] + b[0], a[1] + b[1]]
}

function vSub(a, b) {
  return [a[0] - b[0], a[1] - b[1]]
}

function vScale(a, s) {
  return [a[0] * s, a[1] * s]
}

function vDist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

function vMirrorX(p) {
  return [-p[0], p[1]]
}

function isFiniteVec(p) {
  return Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])
}

function atan2Deg(dy, dx) {
  return (Math.atan2(dy, dx) * 180) / Math.PI
}

/**
 * @param {Partial<typeof DEFAULT_BROW_FIVEBAR_STRUCTURE>} [override]
 */
export function resolveBrowFiveBarStructure(override = null) {
  const o = override && typeof override === "object" ? override : {}
  return {
    rangeX: Number.isFinite(Number(o.rangeX)) ? Number(o.rangeX) : DEFAULT_BROW_FIVEBAR_STRUCTURE.rangeX,
    rangeY: Number.isFinite(Number(o.rangeY)) ? Number(o.rangeY) : DEFAULT_BROW_FIVEBAR_STRUCTURE.rangeY,
    qDMinDeg: Number.isFinite(Number(o.qDMinDeg))
      ? Number(o.qDMinDeg)
      : DEFAULT_BROW_FIVEBAR_STRUCTURE.qDMinDeg,
    qDMaxDeg: Number.isFinite(Number(o.qDMaxDeg))
      ? Number(o.qDMaxDeg)
      : DEFAULT_BROW_FIVEBAR_STRUCTURE.qDMaxDeg,
    qFMinDeg: Number.isFinite(Number(o.qFMinDeg))
      ? Number(o.qFMinDeg)
      : DEFAULT_BROW_FIVEBAR_STRUCTURE.qFMinDeg,
    qFMaxDeg: Number.isFinite(Number(o.qFMaxDeg))
      ? Number(o.qFMaxDeg)
      : DEFAULT_BROW_FIVEBAR_STRUCTURE.qFMaxDeg,
  }
}

export function normalizeBrowFiveBarSideId(sideId = "right") {
  return String(sideId || "right").toLowerCase() === "left" ? "left" : "right"
}

/**
 * Pad → 世界系 A。中位 (0,0) → A0。
 * UI 左右语义为屏幕绝对方向（与右眉一致）：x<0 向左、x>0 向右；Y 同向。
 * 左右位移增量相同：Al − A0l = Ar − A0r。左眉机构仍经 worldAToCanonical 镜像求解。
 */
export function browPadToWorldA(pad, sideId = "right", structure = DEFAULT_BROW_FIVEBAR_STRUCTURE) {
  const side = normalizeBrowFiveBarSideId(sideId)
  const A0 = side === "left" ? BROW_FIVEBAR_LEFT_ANCHORS.A0 : BROW_FIVEBAR_RIGHT_GEOMETRY.A0
  const st = resolveBrowFiveBarStructure(structure)
  const x = clampNumber(Number(pad?.x) || 0, -BROW_FIVEBAR_PAD_SPAN, BROW_FIVEBAR_PAD_SPAN)
  const y = clampNumber(Number(pad?.y) || 0, -BROW_FIVEBAR_PAD_SPAN, BROW_FIVEBAR_PAD_SPAN)
  return [
    A0[0] + (x / BROW_FIVEBAR_PAD_SPAN) * st.rangeX,
    A0[1] + (y / BROW_FIVEBAR_PAD_SPAN) * st.rangeY,
  ]
}

/**
 * 世界 A → canonical（右）局部：左眉镜像 X。
 * @param {Vec2} Aworld
 * @param {"left"|"right"} sideId
 */
export function worldAToCanonical(Aworld, sideId = "right") {
  if (normalizeBrowFiveBarSideId(sideId) === "left") {
    return vMirrorX(Aworld)
  }
  return [Aworld[0], Aworld[1]]
}

/**
 * Canonical A → 世界系（左眉镜像 X）。
 * @param {Vec2} Acan
 * @param {"left"|"right"} sideId
 */
export function canonicalAToWorld(Acan, sideId = "right") {
  if (normalizeBrowFiveBarSideId(sideId) === "left") {
    return vMirrorX(Acan)
  }
  return [Acan[0], Acan[1]]
}

/**
 * qD/qF → 世界系 A（右眉 FK 后按侧镜像）。
 */
export function browFiveBarFkWorld(qDDeg, qFDeg, sideId = "right", cBranch = "lower", eBranch = "lower") {
  const fk = browFiveBarFkCanonical(qDDeg, qFDeg, cBranch, eBranch)
  if (!fk.ok || !fk.A) return { ...fk, Aworld: null }
  return {
    ...fk,
    Acanonical: fk.A,
    Aworld: canonicalAToWorld(fk.A, sideId),
  }
}

/**
 * 世界系 A → IK → qD/qF（不改几何方程；仅入口）。
 * @param {Vec2} Aworld
 * @param {"left"|"right"} sideId
 * @param {ReturnType<typeof createBrowFiveBarState>} [state]
 * @param {object} [structure]
 */
export function solveBrowFiveBarFromWorldA(Aworld, sideId = "right", state = null, structure = null) {
  const st = state || createBrowFiveBarState()
  const side = normalizeBrowFiveBarSideId(sideId)
  const struct = resolveBrowFiveBarStructure(structure)
  const A0 = side === "left" ? BROW_FIVEBAR_LEFT_ANCHORS.A0 : BROW_FIVEBAR_RIGHT_GEOMETRY.A0
  const Acan = worldAToCanonical(Aworld, side)
  const A0can = worldAToCanonical(A0, side)
  const prev = {
    C: st.CPrev,
    E: st.EPrev,
    qDDeg: st.qPrev?.[0],
    qFDeg: st.qPrev?.[1],
  }
  const projected = projectAToReachable(Acan, A0can, prev, struct)
  let ik = projected.ik
  if (!ik?.ok) {
    ik = browFiveBarIkCanonical(projected.A, prev, struct)
  }
  if (!ik?.ok || !Number.isFinite(ik.qDDeg) || !Number.isFinite(ik.qFDeg)) {
    const msg = ik?.message || projected.message || "IK 失败"
    const hold = st.lastOk
    const diagnostics = {
      ok: false,
      sideId: side,
      Aworld: Array.isArray(Aworld) ? [...Aworld] : Aworld,
      Acanonical: Acan,
      Asafe: projected.A,
      scale: projected.scale,
      message: msg,
      heldLastSolution: hold,
      qDDeg: hold ? st.qPrev[0] : null,
      qFDeg: hold ? st.qPrev[1] : null,
    }
    st.lastDiagnostics = diagnostics
    if (hold) {
      return {
        ok: true,
        held: true,
        message: msg,
        qDDeg: st.qPrev[0],
        qFDeg: st.qPrev[1],
        tipA_deg: st.qPrev[0],
        tipB_deg: st.qPrev[1],
        Aworld: Array.isArray(Aworld) ? [...Aworld] : Aworld,
        Acanonical: st.APrev,
        diagnostics,
      }
    }
    st.lastOk = false
    return {
      ok: false,
      held: false,
      message: msg,
      qDDeg: null,
      qFDeg: null,
      tipA_deg: null,
      tipB_deg: null,
      Aworld: Array.isArray(Aworld) ? [...Aworld] : Aworld,
      Acanonical: Acan,
      diagnostics,
    }
  }
  st.qPrev = [ik.qDDeg, ik.qFDeg]
  st.CPrev = ik.C
  st.EPrev = ik.E
  st.APrev = ik.A
  st.lastOk = true
  const AworldOut = canonicalAToWorld(ik.A, side)
  const diagnostics = {
    ok: true,
    sideId: side,
    Aworld: AworldOut,
    Acanonical: ik.A,
    Asafe: ik.A,
    scale: projected.scale,
    B: ik.B,
    C: ik.C,
    E: ik.E,
    qDDeg: ik.qDDeg,
    qFDeg: ik.qFDeg,
    thetaDDeg: ik.thetaDDeg,
    thetaFDeg: ik.thetaFDeg,
    candidateCount: ik.candidateCount,
    message: projected.message || "",
  }
  st.lastDiagnostics = diagnostics
  return {
    ok: true,
    held: false,
    message: "",
    qDDeg: ik.qDDeg,
    qFDeg: ik.qFDeg,
    tipA_deg: ik.qDDeg,
    tipB_deg: ik.qFDeg,
    Aworld: AworldOut,
    Acanonical: ik.A,
    diagnostics,
  }
}

/**
 * Canonical FK：给定相对中位的 qD/qF（度）→ A 及中间点。
 * @param {number} qDDeg
 * @param {number} qFDeg
 * @param {"upper"|"lower"} [cBranch] C 相对 DF 线的侧（默认与中位一致：偏下）
 * @param {"upper"|"lower"} [eBranch]
 */
function pickBranchByY(pts, prefer) {
  if (!pts?.length) return null
  if (pts.length === 1) return pts[0]
  if (prefer === "upper") return pts[0][1] >= pts[1][1] ? pts[0] : pts[1]
  return pts[0][1] <= pts[1][1] ? pts[0] : pts[1]
}

export function browFiveBarFkCanonical(qDDeg, qFDeg, cBranch = "lower", eBranch = "lower") {
  const g = BROW_FIVEBAR_RIGHT_GEOMETRY
  const thetaD = wrapTo180Deg(g.thetaD0Deg + Number(qDDeg))
  const thetaF = wrapTo180Deg(g.thetaF0Deg + Number(qFDeg))
  const C = [
    g.D[0] + g.DC * Math.cos(degToRad(thetaD)),
    g.D[1] + g.DC * Math.sin(degToRad(thetaD)),
  ]
  const E = [
    g.F[0] + g.FE * Math.cos(degToRad(thetaF)),
    g.F[1] + g.FE * Math.sin(degToRad(thetaF)),
  ]

  /* A：|A-C|=AC, |A-B| via B on AC；先求 B 再求 A 不便 — 用两圆 |A-C|=AC 与经 B 的 BE/AB 链。
   * 正向：C 已知后，B 在以 C 为圆心、|BC| 圆上且 |B-E|=BE；再 A = 沿 C→B 反延长到 AC。
   * 更直接：B 满足 |B-C|=BC, |B-E|=BE；A 在射线从 C 过 B，|A-C|=AC，且 |A-B|=AB。
   */
  const bInter = circleCircleIntersections(C, g.BC, E, g.BE)
  if (!bInter.ok || !bInter.pts.length) {
    return { ok: false, message: bInter.message || "FK: B 无解", A: null, B: null, C, E }
  }
  const B =
    pickBranchByY(bInter.pts, cBranch === "lower" ? "lower" : "upper") || bInter.pts[0]

  /* A 在直线 C–B 上：A = C + (AC/|B-C|) * (B-C) 当 B 在 C→A 段上（AB+BC 不一定共线于 A-C）。
   * 几何：A-B-C 共线？ 规格：B = A + (AB/AC)*(C-A) ⇒ B 在 A→C 上，|A-B|=AB, |A-C|=AC。
   * 故 A = C + (AC / |B-C| 方向从 C 背离 B？) ：从 C 指向 A 与从 C 指向 B 相反？
   * B = A + (AB/AC)*(C-A) = (1-AB/AC)*A + (AB/AC)*C
   * ⇒ A = (B - (AB/AC)*C) / (1 - AB/AC) = (AC*B - AB*C) / (AC-AB)
   */
  const denom = g.AC - g.AB
  if (Math.abs(denom) < 1e-12) {
    return { ok: false, message: "FK: AC≈AB", A: null, B, C, E }
  }
  const A = vScale(vSub(vScale(B, g.AC), vScale(C, g.AB)), 1 / denom)

  return {
    ok: true,
    message: "",
    A,
    B,
    C,
    E,
    thetaDDeg: thetaD,
    thetaFDeg: thetaF,
    qDDeg: Number(qDDeg),
    qFDeg: Number(qFDeg),
  }
}

/**
 * Canonical IK：目标 A → qD,qF（相对机械中位）。
 * @param {Vec2} A
 * @param {{ C?: Vec2, E?: Vec2, qDDeg?: number, qFDeg?: number }} [prev]
 * @param {ReturnType<typeof resolveBrowFiveBarStructure>} [structure]
 */
export function browFiveBarIkCanonical(A, prev = null, structure = DEFAULT_BROW_FIVEBAR_STRUCTURE) {
  const g = BROW_FIVEBAR_RIGHT_GEOMETRY
  const st = resolveBrowFiveBarStructure(structure)

  if (!isFiniteVec(A) || !Number.isFinite(A[0]) || !Number.isFinite(A[1])) {
    return { ok: false, message: "A 无效", qDDeg: null, qFDeg: null, candidates: [] }
  }

  const cInter = circleCircleIntersections(g.D, g.DC, A, g.AC)
  if (!cInter.ok || !cInter.pts.length) {
    return {
      ok: false,
      message: cInter.message || "C 无交点",
      qDDeg: null,
      qFDeg: null,
      candidates: [],
      A,
    }
  }

  const candidates = []
  for (const C of cInter.pts) {
    const B = vAdd(A, vScale(vSub(C, A), g.AB / g.AC))
    const eInter = circleCircleIntersections(g.F, g.FE, B, g.BE)
    if (!eInter.ok || !eInter.pts.length) continue
    for (const E of eInter.pts) {
      const thetaD = atan2Deg(C[1] - g.D[1], C[0] - g.D[0])
      const thetaF = atan2Deg(E[1] - g.F[1], E[0] - g.F[0])
      const qDDeg = wrapTo180Deg(thetaD - g.thetaD0Deg)
      const qFDeg = wrapTo180Deg(thetaF - g.thetaF0Deg)
      if (qDDeg < st.qDMinDeg - 1e-6 || qDDeg > st.qDMaxDeg + 1e-6) continue
      if (qFDeg < st.qFMinDeg - 1e-6 || qFDeg > st.qFMaxDeg + 1e-6) continue
      candidates.push({ A, B, C, E, thetaDDeg: thetaD, thetaFDeg: thetaF, qDDeg, qFDeg })
    }
  }

  if (!candidates.length) {
    return {
      ok: false,
      message: "无满足行程的 IK 候选",
      qDDeg: null,
      qFDeg: null,
      candidates: [],
      A,
    }
  }

  let picked = candidates[0]
  if (prev && (isFiniteVec(prev.C) || Number.isFinite(prev.qDDeg))) {
    let bestScore = Infinity
    for (const c of candidates) {
      const dC = isFiniteVec(prev.C) ? vDist(c.C, prev.C) : 0
      const dE = isFiniteVec(prev.E) ? vDist(c.E, prev.E) : 0
      const dQ =
        (Number.isFinite(prev.qDDeg) ? Math.abs(wrapTo180Deg(c.qDDeg - prev.qDDeg)) : 0) +
        (Number.isFinite(prev.qFDeg) ? Math.abs(wrapTo180Deg(c.qFDeg - prev.qFDeg)) : 0)
      const score = dC + dE + 0.05 * dQ
      if (score < bestScore) {
        bestScore = score
        picked = c
      }
    }
  } else {
    /* 中位装配：优先贴近 A0 FK 的 C/E（偏下） */
    const nearNeutral = candidates
      .map((c) => ({
        c,
        score: Math.abs(c.qDDeg) + Math.abs(c.qFDeg) + (c.C[1] > 0 ? 10 : 0) + (c.E[1] > 5 ? 5 : 0),
      }))
      .sort((a, b) => a.score - b.score)
    picked = nearNeutral[0].c
  }

  return {
    ok: true,
    message: "",
    qDDeg: picked.qDDeg,
    qFDeg: picked.qFDeg,
    A: picked.A,
    B: picked.B,
    C: picked.C,
    E: picked.E,
    thetaDDeg: picked.thetaDDeg,
    thetaFDeg: picked.thetaFDeg,
    candidates,
    candidateCount: candidates.length,
  }
}

/**
 * 将不可达 A 沿 A0→A 射线上二分投影到最近可达点。
 * @param {Vec2} Araw
 * @param {Vec2} A0
 * @param {object} [prev]
 * @param {object} [structure]
 */
export function projectAToReachable(Araw, A0, prev = null, structure = DEFAULT_BROW_FIVEBAR_STRUCTURE) {
  if (!isFiniteVec(Araw) || !isFiniteVec(A0)) {
    return { A: A0, scale: 0, message: "A/A0 无效" }
  }
  const direct = browFiveBarIkCanonical(Araw, prev, structure)
  if (direct.ok) {
    return { A: [...Araw], scale: 1, message: "", ik: direct }
  }
  const a0Ik = browFiveBarIkCanonical(A0, prev, structure)
  if (!a0Ik.ok) {
    return { A: [...A0], scale: 0, message: "A0 不可达", ik: a0Ik }
  }
  let lo = 0
  let hi = 1
  let best = { A: [...A0], scale: 0, ik: a0Ik }
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    const Am = [A0[0] + mid * (Araw[0] - A0[0]), A0[1] + mid * (Araw[1] - A0[1])]
    const ik = browFiveBarIkCanonical(Am, prev, structure)
    if (ik.ok) {
      lo = mid
      best = { A: Am, scale: mid, ik }
    } else {
      hi = mid
    }
  }
  return {
    A: best.A,
    scale: best.scale,
    message: best.scale < 1 - 1e-9 ? "A 不可达，已投影到可达区" : "",
    ik: best.ik,
  }
}

export function createBrowFiveBarState() {
  return {
    qPrev: /** @type {[number, number]} */ ([0, 0]),
    CPrev: /** @type {Vec2 | null} */ (null),
    EPrev: /** @type {Vec2 | null} */ (null),
    APrev: /** @type {Vec2 | null} */ (null),
    lastOk: false,
    lastDiagnostics: null,
  }
}

/**
 * 统一入口：侧别 + pad → qD/qF（右眉 F/D；遗留 tipA/tipB 字段仍写出）。
 * @param {{ x: number, y: number }} pad
 * @param {"left"|"right"} sideId
 * @param {ReturnType<typeof createBrowFiveBarState>} [state]
 * @param {object} [structure]
 */
export function solveBrowFiveBarFromPad(pad, sideId = "right", state = null, structure = null) {
  const st = state || createBrowFiveBarState()
  const side = normalizeBrowFiveBarSideId(sideId)
  const struct = resolveBrowFiveBarStructure(structure)
  const A0 = side === "left" ? BROW_FIVEBAR_LEFT_ANCHORS.A0 : BROW_FIVEBAR_RIGHT_GEOMETRY.A0

  const sx = clampNumber(Number(pad?.x) || 0, -BROW_FIVEBAR_PAD_SPAN, BROW_FIVEBAR_PAD_SPAN)
  const sy = clampNumber(Number(pad?.y) || 0, -BROW_FIVEBAR_PAD_SPAN, BROW_FIVEBAR_PAD_SPAN)
  const padClamped = { x: sx, y: sy }

  const Aworld = browPadToWorldA(padClamped, side, struct)
  const Acan = worldAToCanonical(Aworld, side)
  const A0can = worldAToCanonical(A0, side)

  const prev = {
    C: st.CPrev,
    E: st.EPrev,
    qDDeg: st.qPrev?.[0],
    qFDeg: st.qPrev?.[1],
  }

  const projected = projectAToReachable(Acan, A0can, prev, struct)
  let ik = projected.ik
  if (!ik?.ok) {
    ik = browFiveBarIkCanonical(projected.A, prev, struct)
  }

  if (!ik?.ok || !Number.isFinite(ik.qDDeg) || !Number.isFinite(ik.qFDeg)) {
    const msg = ik?.message || projected.message || "IK 失败"
    /* 保持上一有效解，不输出非法角 */
    const hold = st.lastOk
    const diagnostics = {
      ok: false,
      sideId: side,
      pad: padClamped,
      Aworld,
      Acanonical: Acan,
      Asafe: projected.A,
      scale: projected.scale,
      message: msg,
      heldLastSolution: hold,
      qDDeg: hold ? st.qPrev[0] : null,
      qFDeg: hold ? st.qPrev[1] : null,
    }
    st.lastDiagnostics = diagnostics
    if (hold) {
      return {
        ok: true,
        held: true,
        message: msg,
        qDDeg: st.qPrev[0],
        qFDeg: st.qPrev[1],
        tipA_deg: st.qPrev[0],
        tipB_deg: st.qPrev[1],
        Aworld,
        Acanonical: st.APrev,
        diagnostics,
      }
    }
    st.lastOk = false
    return {
      ok: false,
      held: false,
      message: msg,
      qDDeg: null,
      qFDeg: null,
      tipA_deg: null,
      tipB_deg: null,
      Aworld,
      Acanonical: Acan,
      diagnostics,
    }
  }

  st.qPrev = [ik.qDDeg, ik.qFDeg]
  st.CPrev = ik.C
  st.EPrev = ik.E
  st.APrev = ik.A
  st.lastOk = true

  const diagnostics = {
    ok: true,
    sideId: side,
    pad: padClamped,
    Aworld,
    Acanonical: Acan,
    Asafe: ik.A,
    scale: projected.scale,
    B: ik.B,
    C: ik.C,
    E: ik.E,
    qDDeg: ik.qDDeg,
    qFDeg: ik.qFDeg,
    thetaDDeg: ik.thetaDDeg,
    thetaFDeg: ik.thetaFDeg,
    candidateCount: ik.candidateCount,
    message: projected.message || "",
  }
  st.lastDiagnostics = diagnostics

  return {
    ok: true,
    held: false,
    message: "",
    qDDeg: ik.qDDeg,
    qFDeg: ik.qFDeg,
    tipA_deg: ik.qDDeg,
    tipB_deg: ik.qFDeg,
    Aworld,
    Acanonical: ik.A,
    diagnostics,
  }
}

/**
 * 采样 canonical FK 估算安全 range（可选标定工具）。
 */
export function estimateBrowFiveBarSafeRanges(stepDeg = 15) {
  const g = BROW_FIVEBAR_RIGHT_GEOMETRY
  let minX = g.A0[0]
  let maxX = g.A0[0]
  let minY = g.A0[1]
  let maxY = g.A0[1]
  for (let qD = -90; qD <= 90; qD += stepDeg) {
    for (let qF = -90; qF <= 90; qF += stepDeg) {
      const fk = browFiveBarFkCanonical(qD, qF)
      if (!fk.ok || !fk.A) continue
      minX = Math.min(minX, fk.A[0])
      maxX = Math.max(maxX, fk.A[0])
      minY = Math.min(minY, fk.A[1])
      maxY = Math.max(maxY, fk.A[1])
    }
  }
  return {
    rangeX: Math.max(1, Math.min(g.A0[0] - minX, maxX - g.A0[0])),
    rangeY: Math.max(1, Math.min(g.A0[1] - minY, maxY - g.A0[1])),
    minX,
    maxX,
    minY,
    maxY,
  }
}
