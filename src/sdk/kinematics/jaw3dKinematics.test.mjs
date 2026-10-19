/**
 * Jaw 2DOF 3D Kinematics：中位 / 开合 / 左右 / 组合 / Binding / Legacy / Branch
 */
import assert from "node:assert/strict"
import test from "node:test"
import {
  JAW3D_GEOMETRY,
  JAW3D_OM_LENGTH_MM,
  computeJawOmLengthMm,
  createJaw3dState,
  jaw3dFk,
  solveJaw3dFromPad,
  qToBetaDeg,
} from "./jaw3dKinematics.js"
import {
  createInitialEliteRig,
  mapFaceRigToPose,
  normalizeEliteRig,
  rigValuesFromEliteRig,
} from "../../core/faceDofMapper.js"
import { normalizeFaceRigProfile } from "../../core/faceRigProfile.js"
import {
  JAW_A_DEFAULT_SERVO_ID,
  JAW_D_DEFAULT_SERVO_ID,
  JAW_NODE_BINDING_VERSION,
  patchJawNodeBindings,
} from "../binding/jawNodeBindingDefaults.js"

function readPwm(pose, sid) {
  const v = pose.logicalPose?.[String(sid)]
  return v != null && typeof v === "object" ? v.logicalPwm : v
}

test("OM length from beta0=-5.5, not legacy 37.4166", () => {
  const om = computeJawOmLengthMm()
  assert.ok(Math.abs(om - JAW3D_OM_LENGTH_MM) < 1e-12)
  assert.ok(Math.abs(om - Math.sqrt(1400)) > 1)
  assert.ok(om > 39 && om < 41)
})

test("Neutral: qA=qD=0, beta=-5.5, residuals < 1e-6", () => {
  const st = createJaw3dState()
  const r = solveJaw3dFromPad({ value: 0, lateral: 0 }, st)
  assert.equal(r.ok, true, r.message)
  assert.ok(Math.abs(r.qA) < 1e-12)
  assert.ok(Math.abs(r.qD) < 1e-12)
  assert.ok(Math.abs(r.betaA - JAW3D_GEOMETRY.beta0Deg) < 1e-12)
  assert.ok(Math.abs(r.betaD - JAW3D_GEOMETRY.beta0Deg) < 1e-12)
  const c = r.diagnostics.constraints
  assert.ok(c.errAB < 1e-6)
  assert.ok(c.errDE < 1e-6)
  assert.ok(c.errBC < 1e-6)
  assert.ok(c.errEF < 1e-6)
  assert.ok(c.errCF < 1e-6)
  assert.ok(c.errOM < 1e-6)
  assert.equal(c.branch, "locked-hemisphere-negZ")
})

test("Open-only recomputes both qA and qD as differential (not single-servo)", () => {
  const st = createJaw3dState()
  const r = solveJaw3dFromPad({ value: 25, lateral: 0 }, st)
  assert.equal(r.ok, true, r.message)
  assert.ok(Math.abs(r.qA) > 1e-6)
  assert.ok(Math.abs(r.qD) > 1e-6)
  /* 开合 = 差模；正值闭嘴（qA>0,qD<0），与追踪负值张嘴一致 */
  assert.ok(Math.abs(r.qA + r.qD) < 1e-9)
  assert.ok(Math.abs(r.qA - r.qD) > 1e-6)
  assert.ok(r.qA > 0)
  assert.ok(r.qD < 0)
})

test("Lateral-only: both joints move in common mode", () => {
  const st = createJaw3dState()
  const r = solveJaw3dFromPad({ value: 0, lateral: 20 }, st)
  assert.equal(r.ok, true, r.message)
  assert.ok(Math.abs(r.qA) > 1e-6)
  assert.ok(Math.abs(r.qD) > 1e-6)
  /* 左右 = 共模；正值向右 → latPart 为负 */
  assert.ok(Math.abs(r.qA - r.qD) < 1e-9)
  assert.ok(r.qA < 0)
  assert.ok(r.qD < 0)
})

test("Combined 2DOF value+lateral", () => {
  const st = createJaw3dState()
  const r = solveJaw3dFromPad({ value: 30, lateral: -15 }, st)
  assert.equal(r.ok, true, r.message)
  assert.ok(Number.isFinite(r.qA) && Number.isFinite(r.qD))
  assert.ok(Math.abs(r.qA - r.qD) > 1e-6)
})

test("Branch lock: beyond structure limit holds last valid, no flip", () => {
  const st = createJaw3dState()
  const ok = solveJaw3dFromPad({ value: 10, lateral: 0 }, st)
  assert.equal(ok.ok, true)
  const lastA = ok.qA
  const lastD = ok.qD
  const bad = solveJaw3dFromPad({ value: 100, lateral: 50 }, st, {
    openGainDeg: 0.6,
    lateralGainDeg: 0.6,
    betaMinDeg: -20,
    betaMaxDeg: 5,
  })
  assert.equal(bad.ok, false)
  assert.equal(bad.hold, true)
  assert.equal(bad.qA, lastA)
  assert.equal(bad.qD, lastD)
  assert.ok(
    bad.message === "beta-structure-limit" ||
      bad.diagnostics?.constraints?.limitReason === "beta-structure-limit"
  )
})

test("Legacy jaw/value 8+15 migrates to jaw_A/jaw_D without direct jaw bindings", () => {
  const legacy = [
    {
      bindingId: "b1",
      controlId: "jaw",
      channel: "value",
      enabled: true,
      servoId: 8,
      neutralPwm: 1500,
      positiveTargetPwm: 2400,
      negativeTargetPwm: 600,
    },
    {
      bindingId: "b2",
      controlId: "jaw",
      channel: "value",
      enabled: true,
      servoId: 15,
      neutralPwm: 1500,
      positiveTargetPwm: 2200,
      negativeTargetPwm: 800,
    },
    {
      bindingId: "b3",
      controlId: "jaw",
      channel: "lateral",
      enabled: true,
      servoId: 28,
    },
  ]
  const next = patchJawNodeBindings(legacy)
  assert.equal(next.filter((b) => b.controlId === "jaw").length, 0)
  const a = next.find((b) => b.controlId === "jaw_A")
  const d = next.find((b) => b.controlId === "jaw_D")
  assert.ok(a && d)
  assert.equal(Number(a.servoId), 8)
  assert.equal(Number(d.servoId), 15)
  assert.equal(Number(a.positiveTargetPwm), 2400)
  assert.equal(Number(d.negativeTargetPwm), 800)
})

test("Profile normalize: jawNodeBindingVersion + defaults A=8 D=15", () => {
  const profile = normalizeFaceRigProfile({})
  assert.equal(profile.jawNodeBindingVersion, JAW_NODE_BINDING_VERSION)
  const a = profile.bindings.find((b) => b.controlId === "jaw_A" && b.channel === "value")
  const d = profile.bindings.find((b) => b.controlId === "jaw_D" && b.channel === "value")
  const direct = profile.bindings.filter((b) => b.controlId === "jaw")
  assert.ok(a && d)
  assert.equal(Number(a.servoId), JAW_A_DEFAULT_SERVO_ID)
  assert.equal(Number(d.servoId), JAW_D_DEFAULT_SERVO_ID)
  assert.equal(direct.length, 0)
})

test("mapFaceRigToPose: jaw IK writes only A/D servos; open/lateral couple both", () => {
  const profile = normalizeFaceRigProfile({})
  const pose0 = mapFaceRigToPose(rigValuesFromEliteRig(createInitialEliteRig()), profile, [])
  const kin0 = pose0.kinematics?.jaw3d
  assert.equal(kin0?.readyForIk, true, kin0?.ikMessage)
  assert.ok(kin0?.ikOk !== false, kin0?.ikMessage)
  assert.equal(Number(kin0.binding.servoAId), JAW_A_DEFAULT_SERVO_ID)
  assert.equal(Number(kin0.binding.servoDId), JAW_D_DEFAULT_SERVO_ID)

  const pwmA0 = readPwm(pose0, JAW_A_DEFAULT_SERVO_ID)
  const pwmD0 = readPwm(pose0, JAW_D_DEFAULT_SERVO_ID)

  const poseOpen = mapFaceRigToPose(
    rigValuesFromEliteRig(normalizeEliteRig({ ...createInitialEliteRig(), jaw: { val: 40, lateral: 0 } })),
    profile,
    []
  )
  assert.ok(poseOpen.kinematics?.jaw3d?.ikOk !== false, poseOpen.kinematics?.jaw3d?.ikMessage)
  const pwmAO = readPwm(poseOpen, JAW_A_DEFAULT_SERVO_ID)
  const pwmDO = readPwm(poseOpen, JAW_D_DEFAULT_SERVO_ID)
  /* open-only：差模，两路都应变化且方向相反（PWM 相对中位） */
  assert.ok(pwmAO !== pwmA0)
  assert.ok(pwmDO !== pwmD0)
  assert.ok(pwmAO !== pwmDO)

  const poseLat = mapFaceRigToPose(
    rigValuesFromEliteRig(normalizeEliteRig({ ...createInitialEliteRig(), jaw: { val: 0, lateral: 30 } })),
    profile,
    []
  )
  assert.ok(poseLat.kinematics?.jaw3d?.ikOk !== false, poseLat.kinematics?.jaw3d?.ikMessage)
  const pwmAL = readPwm(poseLat, JAW_A_DEFAULT_SERVO_ID)
  const pwmDL = readPwm(poseLat, JAW_D_DEFAULT_SERVO_ID)
  assert.ok(pwmAL !== pwmA0)
  assert.ok(pwmDL !== pwmD0)
  /* lateral-only：共模，两路同向同量 */
  assert.equal(pwmAL, pwmDL)

  assert.equal(poseLat.kinematics.jaw3d.binding.nodeAKey, "jaw_A")
  assert.equal(poseLat.kinematics.jaw3d.binding.nodeDKey, "jaw_D")
})

test("q/beta conversion matches Geometry Neutral", () => {
  assert.equal(qToBetaDeg(0), -5.5)
  const fk = jaw3dFk(-5.5, -5.5)
  assert.equal(fk.ok, true)
  assert.ok(fk.errOM < 1e-6)
})
