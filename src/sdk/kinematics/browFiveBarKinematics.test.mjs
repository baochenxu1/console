/**
 * 新眉毛五杆：Neutral / Coupling / Mirror / Round-trip / Safety
 */
import assert from "node:assert/strict"
import test from "node:test"
import {
  BROW_FIVEBAR_RIGHT_GEOMETRY,
  BROW_FIVEBAR_LEFT_ANCHORS,
  DEFAULT_BROW_FIVEBAR_STRUCTURE,
  browFiveBarFkCanonical,
  browFiveBarIkCanonical,
  browPadToWorldA,
  createBrowFiveBarState,
  projectAToReachable,
  solveBrowFiveBarFromPad,
  worldAToCanonical,
} from "./browFiveBarKinematics.js"
import { solveBrowTipIk } from "./browTipFivebar.js"
import { normalizeFaceRigProfile } from "../../core/faceRigProfile.js"
import {
  mapFaceRigToPose,
  createInitialEliteRig,
  normalizeEliteRig,
  rigValuesFromEliteRig,
} from "../../core/faceDofMapper.js"

const A0R = BROW_FIVEBAR_RIGHT_GEOMETRY.A0
const A0L = BROW_FIVEBAR_LEFT_ANCHORS.A0

function almostEqual(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps
}

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

test("Neutral: right pad(0,0) → A≈A0_right, qD≈0, qF≈0", () => {
  const A = browPadToWorldA({ x: 0, y: 0 }, "right")
  assert.ok(dist(A, A0R) < 1e-9)
  const ik = browFiveBarIkCanonical(A0R)
  assert.equal(ik.ok, true, ik.message)
  assert.ok(almostEqual(ik.qDDeg, 0, 1e-4), `qD=${ik.qDDeg}`)
  assert.ok(almostEqual(ik.qFDeg, 0, 1e-4), `qF=${ik.qFDeg}`)

  const st = createBrowFiveBarState()
  const r = solveBrowFiveBarFromPad({ x: 0, y: 0 }, "right", st)
  assert.equal(r.ok, true, r.message)
  assert.ok(almostEqual(r.qDDeg, 0, 1e-4))
  assert.ok(almostEqual(r.qFDeg, 0, 1e-4))
  assert.ok(dist(r.Aworld, A0R) < 1e-9)
})

test("Neutral: left pad(0,0) → A≈A0_left, mirrored of right", () => {
  const A = browPadToWorldA({ x: 0, y: 0 }, "left")
  assert.ok(dist(A, A0L) < 1e-9)
  assert.ok(almostEqual(A[0], -A0R[0], 1e-9))
  assert.ok(almostEqual(A[1], A0R[1], 1e-9))

  const r = solveBrowFiveBarFromPad({ x: 0, y: 0 }, "left", createBrowFiveBarState())
  assert.equal(r.ok, true, r.message)
  assert.ok(almostEqual(r.qDDeg, 0, 1e-4))
  assert.ok(almostEqual(r.qFDeg, 0, 1e-4))
})

test("FK(0,0) matches MATLAB A0 within 1e-6 mm", () => {
  const fk = browFiveBarFkCanonical(0, 0)
  assert.equal(fk.ok, true, fk.message)
  assert.ok(dist(fk.A, A0R) < 1e-6, `err=${dist(fk.A, A0R)}`)
})

test("IK→FK round-trip |A'-A| < 1e-6 mm", () => {
  const targets = [
    A0R,
    browPadToWorldA({ x: 30, y: 0 }, "right"),
    browPadToWorldA({ x: 0, y: 40 }, "right"),
    browPadToWorldA({ x: -25, y: -30 }, "right"),
  ]
  for (const A of targets) {
    const proj = projectAToReachable(A, A0R)
    assert.ok(proj.ik?.ok, proj.message)
    const fk = browFiveBarFkCanonical(proj.ik.qDDeg, proj.ik.qFDeg)
    assert.equal(fk.ok, true, fk.message)
    const err = dist(fk.A, proj.A)
    assert.ok(err < 1e-6, `round-trip err ${err} at A=${A}`)
  }
})

test("Coupling: X-only and Y-only both tip actuators may change", () => {
  const binding = (id) => ({
    bindingId: id,
    controlId: id,
    channel: "value",
    servoId: id.includes("a") ? 1 : 2,
    neutralPwm: 1500,
    positiveTargetPwm: 2500,
    negativeTargetPwm: 500,
    enabled: true,
  })
  const resolved = {
    sideId: "right",
    bindingA: binding("brow_r_tip_a"),
    bindingB: binding("brow_r_tip_b"),
    servoAId: 1,
    servoBId: 2,
  }
  const st = createBrowFiveBarState()
  const r0 = solveBrowTipIk({
    browTarget: { x: 0, y: 0 },
    resolved,
    params: { ...DEFAULT_BROW_FIVEBAR_STRUCTURE, sideId: "right" },
    state: st,
  })
  assert.equal(r0.ok, true, r0.message)

  const rX = solveBrowTipIk({
    browTarget: { x: 50, y: 0 },
    resolved,
    params: { ...DEFAULT_BROW_FIVEBAR_STRUCTURE, sideId: "right" },
    state: st,
  })
  assert.equal(rX.ok, true, rX.message)
  /* X-only：两路 actuator 均应变（禁止 x→单舵机 1:1） */
  assert.ok(rX.tipA_deg !== r0.tipA_deg, `X-only tip_a must change: ${r0.tipA_deg}→${rX.tipA_deg}`)
  assert.ok(rX.tipB_deg !== r0.tipB_deg, `X-only tip_b must change: ${r0.tipB_deg}→${rX.tipB_deg}`)

  const rY = solveBrowTipIk({
    browTarget: { x: 50, y: 40 },
    resolved,
    params: { ...DEFAULT_BROW_FIVEBAR_STRUCTURE, sideId: "right" },
    state: st,
  })
  assert.equal(rY.ok, true, rY.message)
  /* Y-only：两路 actuator 均应变（禁止 y→单舵机 1:1） */
  assert.ok(rY.tipA_deg !== rX.tipA_deg, `Y-only tip_a must change: ${rX.tipA_deg}→${rY.tipA_deg}`)
  assert.ok(rY.tipB_deg !== rX.tipB_deg, `Y-only tip_b must change: ${rX.tipB_deg}→${rY.tipB_deg}`)
})

test("Pad XY: same screen delta on L/R; left IK via mirrored canonical", () => {
  const pads = [
    { x: 0, y: 0 },
    { x: 40, y: -20 },
    { x: -30, y: 35 },
  ]
  const g = BROW_FIVEBAR_RIGHT_GEOMETRY
  const A0r = BROW_FIVEBAR_RIGHT_GEOMETRY.A0
  const A0l = [-A0r[0], A0r[1]]
  for (const pad of pads) {
    const Ar = browPadToWorldA(pad, "right")
    const Al = browPadToWorldA(pad, "left")
    /* 屏幕绝对方向：左右相对各自 A0 的位移相同（不再做局部 X 镜像） */
    assert.ok(
      almostEqual(Al[0] - A0l[0], Ar[0] - A0r[0], 1e-9),
      `x delta pad=${JSON.stringify(pad)}`
    )
    assert.ok(
      almostEqual(Al[1] - A0l[1], Ar[1] - A0r[1], 1e-9),
      `y delta pad=${JSON.stringify(pad)}`
    )

    const cr = worldAToCanonical(Ar, "right")
    const cl = worldAToCanonical(Al, "left")
    /* 相对 A0canonical：左右 pad 同号 X → canonical 增量相反（屏幕同向） */
    assert.ok(
      almostEqual(cr[0] - A0r[0], -(cl[0] - A0r[0]), 1e-9),
      `canonical x opposite delta pad=${JSON.stringify(pad)}`
    )
    assert.ok(almostEqual(cl[1], cr[1], 1e-9), `canonical y same pad=${JSON.stringify(pad)}`)

    const ik = browFiveBarIkCanonical(cr)
    assert.equal(ik.ok, true, ik.message)
    assert.ok(almostEqual(dist(ik.C, g.D), g.DC, 1e-6))
    assert.ok(almostEqual(dist(ik.E, g.F), g.FE, 1e-6))
    assert.ok(almostEqual(dist(ik.A, ik.C), g.AC, 1e-6))
    assert.ok(almostEqual(dist(ik.A, ik.B), g.AB, 1e-6))
    assert.ok(almostEqual(dist(ik.B, ik.E), g.BE, 1e-6))
    assert.ok(almostEqual(dist(ik.B, ik.C), g.BC, 1e-6))

    const ikL = browFiveBarIkCanonical(cl)
    assert.equal(ikL.ok, true, ikL.message)
  }
})

test("Safety: unreachable A → no NaN, hold/project, no illegal angles", () => {
  const far = [A0R[0] + 500, A0R[1] + 500]
  const st = createBrowFiveBarState()
  /* seed a valid previous solution */
  const ok0 = solveBrowFiveBarFromPad({ x: 0, y: 0 }, "right", st)
  assert.equal(ok0.ok, true)

  const proj = projectAToReachable(far, A0R, {
    C: st.CPrev,
    E: st.EPrev,
    qDDeg: st.qPrev[0],
    qFDeg: st.qPrev[1],
  })
  assert.ok(proj.scale < 1)
  assert.ok(proj.ik?.ok)
  assert.ok(Number.isFinite(proj.ik.qDDeg) && Number.isFinite(proj.ik.qFDeg))
  assert.equal(Number.isNaN(proj.ik.qDDeg), false)

  /* extreme pad still returns finite via projection */
  const extreme = solveBrowFiveBarFromPad({ x: 100, y: 100 }, "right", createBrowFiveBarState())
  assert.equal(extreme.ok, true, extreme.message)
  assert.ok(Number.isFinite(extreme.qDDeg) && Number.isFinite(extreme.qFDeg))
})

test("mapFaceRigToPose: full (x,y) drives both tip servos (not 1:1)", () => {
  const profile = normalizeFaceRigProfile({})
  let rig = normalizeEliteRig(createInitialEliteRig())
  const pose0 = mapFaceRigToPose(rigValuesFromEliteRig(rig), profile, [])
  const kin0 = pose0.kinematics?.leftBrowTipFivebar
  assert.equal(kin0?.readyForIk, true, kin0?.ikMessage || kin0?.skipReason || "left not ready")
  assert.ok(kin0?.ikOk !== false && kin0?.ok !== false, kin0?.ikMessage || "left IK failed")

  const readPwm = (pose, sid) => {
    const v = pose.logicalPose?.[sid]
    return v != null && typeof v === "object" ? v.logicalPwm : v
  }
  const sa = String(kin0.servoDId ?? kin0.servoAId)
  const sb = String(kin0.servoFId ?? kin0.servoBId)
  const a0 = readPwm(pose0, sa)
  const b0 = readPwm(pose0, sb)

  rig = normalizeEliteRig({ ...rig, browL: { ...rig.browL, x: 0, y: 40 } })
  const pose1 = mapFaceRigToPose(rigValuesFromEliteRig(rig), profile, [])
  const a1 = readPwm(pose1, sa)
  const b1 = readPwm(pose1, sb)
  assert.ok(a1 !== a0 || b1 !== b0, "Y-only must allow both servos to update")

  rig = normalizeEliteRig({ ...rig, browL: { ...rig.browL, x: -40, y: 40 } })
  const pose2 = mapFaceRigToPose(rigValuesFromEliteRig(rig), profile, [])
  const a2 = readPwm(pose2, sa)
  const b2 = readPwm(pose2, sb)
  assert.ok(a2 !== a1 || b2 !== b1, "X-only must re-solve full IK")
})
