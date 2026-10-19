/**
 * 左眉 Five-Bar Pair Servo：与右眉共用 A-space Continuous / Discrete；
 * 镜像 / 耦合 / Binding 防串线 / tip_a 非正式写出。
 */
import assert from "node:assert/strict"
import test from "node:test"
import {
  createLeftBrowFiveBarPairServo,
  createRightBrowFiveBarSyncGroup,
  stepBrowFiveBarPairServo,
  markBrowFiveBarPairServoSent,
  BROW_FIVEBAR_MOTION_MODE,
  BROW_FIVEBAR_PAIR_SERVO_CONFIG,
} from "./rightBrowFiveBarSyncGroup.js"
import {
  BROW_FIVEBAR_LEFT_ANCHORS,
  BROW_FIVEBAR_RIGHT_GEOMETRY,
  browFiveBarFkWorld,
  browPadToWorldA,
  solveBrowFiveBarFromWorldA,
  worldAToCanonical,
} from "./browFiveBarKinematics.js"
import {
  createInitialEliteRig,
  mapFaceRigToPose,
  normalizeEliteRig,
  rigValuesFromEliteRig,
} from "../../core/faceDofMapper.js"
import { normalizeFaceRigProfile } from "../../core/faceRigProfile.js"
import {
  BROW_L_D_SERVO_ID,
  BROW_L_F_SERVO_ID,
  BROW_R_D_SERVO_ID,
  BROW_R_F_SERVO_ID,
} from "../binding/browTipDualBindingDefaults.js"

const A0R = BROW_FIVEBAR_RIGHT_GEOMETRY.A0
const A0L = BROW_FIVEBAR_LEFT_ANCHORS.A0

function dist(a, b) {
  const ax = Array.isArray(a) ? a[0] : a.x
  const ay = Array.isArray(a) ? a[1] : a.y
  const bx = Array.isArray(b) ? b[0] : b.x
  const by = Array.isArray(b) ? b[1] : b.y
  return Math.hypot(ax - bx, ay - by)
}

function readPwm(pose, sid) {
  const v = pose.logicalPose?.[String(sid)]
  return v != null && typeof v === "object" ? v.logicalPwm : v
}

test("Neutral: left/right A0 are X-mirrors; q≈0", () => {
  assert.ok(Math.abs(A0L[0] + A0R[0]) < 1e-9)
  assert.ok(Math.abs(A0L[1] - A0R[1]) < 1e-9)
  const Ar = browPadToWorldA({ x: 0, y: 0 }, "right")
  const Al = browPadToWorldA({ x: 0, y: 0 }, "left")
  assert.ok(dist(Ar, A0R) < 1e-9)
  assert.ok(dist(Al, A0L) < 1e-9)
  assert.ok(Math.abs(Al[0] + Ar[0]) < 1e-9)
  assert.ok(Math.abs(Al[1] - Ar[1]) < 1e-9)

  const ikR = solveBrowFiveBarFromWorldA(Ar, "right")
  const ikL = solveBrowFiveBarFromWorldA(Al, "left")
  assert.equal(ikR.ok, true, ikR.message)
  assert.equal(ikL.ok, true, ikL.message)
  assert.ok(Math.abs(ikR.qFDeg) < 1e-6)
  assert.ok(Math.abs(ikR.qDDeg) < 1e-6)
  assert.ok(Math.abs(ikL.qFDeg) < 1e-6)
  assert.ok(Math.abs(ikL.qDDeg) < 1e-6)
})

test("same pad: world relative-to-A0 match; canonical X opposite via shared solver", () => {
  const pad = { x: 30, y: 20 }
  const Ar = browPadToWorldA(pad, "right")
  const Al = browPadToWorldA(pad, "left")
  assert.ok(Math.abs(Al[0] - A0L[0] - (Ar[0] - A0R[0])) < 1e-9)
  assert.ok(Math.abs(Al[1] - A0L[1] - (Ar[1] - A0R[1])) < 1e-9)

  const cr = worldAToCanonical(Ar, "right")
  const cl = worldAToCanonical(Al, "left")
  assert.ok(Math.abs(cr[0] - A0R[0] + (cl[0] - A0R[0])) < 1e-9)
  assert.ok(Math.abs(cl[1] - cr[1]) < 1e-9)

  const ikR = solveBrowFiveBarFromWorldA(Ar, "right")
  const ikL = solveBrowFiveBarFromWorldA(Al, "left")
  assert.equal(ikR.ok, true, ikR.message)
  assert.equal(ikL.ok, true, ikL.message)
  const fkR = browFiveBarFkWorld(ikR.qDDeg, ikR.qFDeg, "right")
  const fkL = browFiveBarFkWorld(ikL.qDDeg, ikL.qFDeg, "left")
  assert.equal(fkR.ok, true)
  assert.equal(fkL.ok, true)
  assert.ok(dist(fkR.Aworld, Ar) < 1e-6)
  assert.ok(dist(fkL.Aworld, Al) < 1e-6)
})

test("left A-space continuous: IK→FK round-trip < 1e-6; shared config", () => {
  assert.equal(BROW_FIVEBAR_PAIR_SERVO_CONFIG.continuousDeviceTimeMs, 0)
  const g = createLeftBrowFiveBarPairServo()
  assert.equal(g.sideId, "left")
  markBrowFiveBarPairServoSent(g, 0, { qF: 0, qD: 0 })
  const end = browPadToWorldA({ x: 40, y: -20 }, "left")
  g.lastSuccessfullySentA = {
    x: browPadToWorldA({ x: 0, y: 0 }, "left")[0],
    y: browPadToWorldA({ x: 0, y: 0 }, "left")[1],
  }

  let now = 0
  let samples = 0
  for (let i = 0; i < 40; i++) {
    now += 8
    const r = stepBrowFiveBarPairServo(g, {
      sideId: "left",
      mode: BROW_FIVEBAR_MOTION_MODE.CONTINUOUS_SERVO,
      targetX: 40,
      targetY: -20,
      desiredA: { x: end[0], y: end[1] },
      nowMs: now,
    })
    assert.equal(r.accept, true, r.reason)
    assert.equal(r.space, "A")
    const ik = solveBrowFiveBarFromWorldA([r.nextA.x, r.nextA.y], "left")
    assert.equal(ik.ok, true, ik.message)
    const fk = browFiveBarFkWorld(ik.qDDeg, ik.qFDeg, "left")
    assert.ok(dist(fk.Aworld, r.nextA) < 1e-6)
    markBrowFiveBarPairServoSent(g, now, { qF: r.qF, qD: r.qD })
    samples += 1
    if (g.groupFinished) break
  }
  assert.ok(samples >= 2)
  assert.equal(g.syncWrite, false)
})

test("left X-only and Y-only both update qF and qD (coupling)", () => {
  const g = createLeftBrowFiveBarPairServo()
  markBrowFiveBarPairServoSent(g, 0, { qF: 0, qD: 0 })
  const a0 = browPadToWorldA({ x: 0, y: 0 }, "left")
  g.lastSuccessfullySentA = { x: a0[0], y: a0[1] }

  const wx = browPadToWorldA({ x: 20, y: 0 }, "left")
  const rx = stepBrowFiveBarPairServo(g, {
    mode: BROW_FIVEBAR_MOTION_MODE.DIRECT,
    qFTarget: solveBrowFiveBarFromWorldA(wx, "left").qFDeg,
    qDTarget: solveBrowFiveBarFromWorldA(wx, "left").qDDeg,
    targetX: 20,
    targetY: 0,
    desiredA: { x: wx[0], y: wx[1] },
    nowMs: 1,
    ikOk: true,
  })
  assert.equal(rx.accept, true, rx.reason)
  assert.ok(Math.abs(rx.qF) > 1e-6 || Math.abs(rx.qD) > 1e-6)
  const qFx = rx.qF
  const qDx = rx.qD
  assert.ok(Math.abs(qFx) > 1e-9 || Math.abs(qDx) > 1e-9)
  /* X-only：两路都应相对中位变化（禁止单轴单舵机） */
  const ikX = solveBrowFiveBarFromWorldA(wx, "left")
  assert.ok(Math.abs(ikX.qFDeg) > 1e-6)
  assert.ok(Math.abs(ikX.qDDeg) > 1e-6)

  const wy = browPadToWorldA({ x: 0, y: 20 }, "left")
  const ikY = solveBrowFiveBarFromWorldA(wy, "left")
  assert.ok(Math.abs(ikY.qFDeg) > 1e-6)
  assert.ok(Math.abs(ikY.qDDeg) > 1e-6)
  assert.ok(Math.abs(ikY.qFDeg - ikX.qFDeg) > 1e-6 || Math.abs(ikY.qDDeg - ikX.qDDeg) > 1e-6)
})

test("atomic pair reject: invalid IK does not half-write left pair", () => {
  const g = createLeftBrowFiveBarPairServo()
  markBrowFiveBarPairServoSent(g, 0, { qF: 1.5, qD: -2.5 })
  const r = stepBrowFiveBarPairServo(g, {
    mode: BROW_FIVEBAR_MOTION_MODE.CONTINUOUS_SERVO,
    targetX: 50,
    targetY: 0,
    nowMs: 10,
    ikOk: false,
  })
  assert.equal(r.accept, false)
  assert.equal(r.qF, 1.5)
  assert.equal(r.qD, -2.5)
})

test("binding isolation: left F/D → 24/23, right F/D → 1/2; no tip_a formal keys", () => {
  const profile = normalizeFaceRigProfile({})
  const tipLegacy = (profile.bindings || []).filter(
    (b) =>
      String(b.controlId || "").endsWith("_tip_a") || String(b.controlId || "").endsWith("_tip_b")
  )
  assert.equal(tipLegacy.length, 0, "formal bindings must not keep tip_a/tip_b keys")

  const fL = profile.bindings.find((b) => b.controlId === "brow_l_F" && b.channel === "value")
  const dL = profile.bindings.find((b) => b.controlId === "brow_l_D" && b.channel === "value")
  const fR = profile.bindings.find((b) => b.controlId === "brow_r_F" && b.channel === "value")
  const dR = profile.bindings.find((b) => b.controlId === "brow_r_D" && b.channel === "value")
  assert.ok(fL && dL && fR && dR, "F/D bindings required")
  assert.equal(Number(fL.servoId), BROW_L_F_SERVO_ID)
  assert.equal(Number(dL.servoId), BROW_L_D_SERVO_ID)
  assert.equal(Number(fR.servoId), BROW_R_F_SERVO_ID)
  assert.equal(Number(dR.servoId), BROW_R_D_SERVO_ID)

  const leftGroup = createLeftBrowFiveBarPairServo()
  const rightGroup = createRightBrowFiveBarSyncGroup()
  let rig = normalizeEliteRig({
    ...createInitialEliteRig(),
    browL: { x: 35, y: -15 },
    browR: { x: -25, y: 20 },
  })
  const pose = mapFaceRigToPose(rigValuesFromEliteRig(rig), profile, [], {
    leftBrowFiveBarSyncGroup: leftGroup,
    rightBrowFiveBarSyncGroup: rightGroup,
    leftBrowSyncMode: BROW_FIVEBAR_MOTION_MODE.OBSERVE,
    rightBrowSyncMode: BROW_FIVEBAR_MOTION_MODE.OBSERVE,
    leftBrowSyncNowMs: 1,
    rightBrowSyncNowMs: 1,
  })

  const kinL = pose.kinematics?.leftBrowTipFivebar || pose.kinematics?.leftBrowFivebar
  const kinR = pose.kinematics?.rightBrowTipFivebar || pose.kinematics?.rightBrowFivebar
  assert.equal(kinL?.readyForIk, true, kinL?.ikMessage || kinL?.skipReason || "left not ready")
  assert.equal(kinR?.readyForIk, true, kinR?.ikMessage || kinR?.skipReason || "right not ready")
  assert.ok(kinL?.ikOk !== false && kinL?.ok !== false, kinL?.ikMessage || "left IK failed")
  assert.ok(kinR?.ikOk !== false && kinR?.ok !== false, kinR?.ikMessage || "right IK failed")

  assert.equal(Number(kinL.servoFId), BROW_L_F_SERVO_ID)
  assert.equal(Number(kinL.servoDId), BROW_L_D_SERVO_ID)
  assert.equal(Number(kinR.servoFId), BROW_R_F_SERVO_ID)
  assert.equal(Number(kinR.servoDId), BROW_R_D_SERVO_ID)
  assert.equal(kinL.nodeFBindingKey, "brow_l_F")
  assert.equal(kinL.nodeDBindingKey, "brow_l_D")
  assert.equal(kinR.nodeFBindingKey, "brow_r_F")
  assert.equal(kinR.nodeDBindingKey, "brow_r_D")

  /* 左眉变化不得改写右眉舵机；右眉变化不得改写左眉舵机 */
  const pwmLF = readPwm(pose, BROW_L_F_SERVO_ID)
  const pwmLD = readPwm(pose, BROW_L_D_SERVO_ID)
  const pwmRF = readPwm(pose, BROW_R_F_SERVO_ID)
  const pwmRD = readPwm(pose, BROW_R_D_SERVO_ID)
  assert.ok(Number.isFinite(Number(pwmLF)) && Number.isFinite(Number(pwmLD)))
  assert.ok(Number.isFinite(Number(pwmRF)) && Number.isFinite(Number(pwmRD)))

  const mapOpts = {
    leftBrowSyncMode: BROW_FIVEBAR_MOTION_MODE.OBSERVE,
    rightBrowSyncMode: BROW_FIVEBAR_MOTION_MODE.OBSERVE,
    leftBrowSyncNowMs: 2,
    rightBrowSyncNowMs: 2,
  }
  const poseLeftOnly = mapFaceRigToPose(
    rigValuesFromEliteRig(normalizeEliteRig({ ...createInitialEliteRig(), browL: { x: 40, y: 10 } })),
    profile,
    [],
    mapOpts
  )
  const poseNeutral = mapFaceRigToPose(
    rigValuesFromEliteRig(createInitialEliteRig()),
    profile,
    [],
    { ...mapOpts, leftBrowSyncNowMs: 3, rightBrowSyncNowMs: 3 }
  )
  assert.ok(
    readPwm(poseLeftOnly, BROW_L_F_SERVO_ID) !== readPwm(poseNeutral, BROW_L_F_SERVO_ID) ||
      readPwm(poseLeftOnly, BROW_L_D_SERVO_ID) !== readPwm(poseNeutral, BROW_L_D_SERVO_ID),
    "left brow pad change must move left F and/or D PWM"
  )
  assert.equal(readPwm(poseLeftOnly, BROW_R_F_SERVO_ID), readPwm(poseNeutral, BROW_R_F_SERVO_ID))
  assert.equal(readPwm(poseLeftOnly, BROW_R_D_SERVO_ID), readPwm(poseNeutral, BROW_R_D_SERVO_ID))
})

test("right brow regression: continuous A-space still accepts and pairs", () => {
  const g = createRightBrowFiveBarSyncGroup()
  markBrowFiveBarPairServoSent(g, 0, { qF: 0, qD: 0 })
  const end = browPadToWorldA({ x: 50, y: 10 }, "right")
  g.lastSuccessfullySentA = {
    x: browPadToWorldA({ x: 0, y: 0 }, "right")[0],
    y: browPadToWorldA({ x: 0, y: 0 }, "right")[1],
  }
  const r = stepBrowFiveBarPairServo(g, {
    mode: BROW_FIVEBAR_MOTION_MODE.CONTINUOUS_SERVO,
    targetX: 50,
    targetY: 10,
    desiredA: { x: end[0], y: end[1] },
    nowMs: 8,
  })
  assert.equal(r.accept, true, r.reason)
  assert.equal(r.space, "A")
  assert.equal(g.sideId, "right")
})
