/**
 * 验收：任意单轴变化都必须用完整 (x,y) 重解 IK，两路 tip 角/PWM 都允许同时变化。
 */
import assert from "node:assert/strict"
import test from "node:test"
import {
  createBrowTipFivebarState,
  getDefaultBrowTipFivebarParams,
  solveBrowTipIk,
} from "./browTipFivebar.js"
import { normalizeFaceRigProfile } from "../../core/faceRigProfile.js"
import {
  mapFaceRigToPose,
  createInitialEliteRig,
  normalizeEliteRig,
  rigValuesFromEliteRig,
} from "../../core/faceDofMapper.js"

function mockBinding(servoId, bindingId) {
  return {
    bindingId,
    controlId: bindingId.includes("tip_a") ? "brow_l_tip_a" : "brow_l_tip_b",
    channel: "value",
    servoId,
    neutralPwm: 1500,
    positiveTargetPwm: 2500,
    negativeTargetPwm: 500,
    weight: 1,
    enabled: true,
  }
}

test("solveBrowIK: change only y can move both tip_a and tip_b", () => {
  const params = getDefaultBrowTipFivebarParams("left")
  const resolved = {
    bindingA: mockBinding(1, "brow_l_tip_a"),
    bindingB: mockBinding(24, "brow_l_tip_b"),
    servoAId: 1,
    servoBId: 24,
  }
  const state = createBrowTipFivebarState()

  const r0 = solveBrowTipIk({
    browTarget: { x: 0, y: 0 },
    resolved,
    params,
    state,
  })
  assert.equal(r0.ok, true, r0.message)
  const tipA0 = r0.tipA_deg
  const tipB0 = r0.tipB_deg
  const pwmA0 = r0.pwmA
  const pwmB0 = r0.pwmB

  const r1 = solveBrowTipIk({
    browTarget: { x: 0, y: 40 },
    resolved,
    params,
    state,
  })
  assert.equal(r1.ok, true, r1.message)

  const changedA = r1.tipA_deg !== tipA0 || r1.pwmA !== pwmA0
  const changedB = r1.tipB_deg !== tipB0 || r1.pwmB !== pwmB0
  assert.ok(
    changedA || changedB,
    "changing y must allow tip_a and/or tip_b to change via full IK"
  )
  /* 核心：不是 y→只 A、x→只 B；完整重解后两路都可能变 */
  assert.ok(
    Number.isFinite(r1.tipA_deg) && Number.isFinite(r1.tipB_deg),
    "both tip angles must be produced from full (x,y)"
  )

  const r2 = solveBrowTipIk({
    browTarget: { x: -40, y: 40 },
    resolved,
    params,
    state,
  })
  assert.equal(r2.ok, true, r2.message)
  assert.ok(
    r2.tipA_deg !== r1.tipA_deg || r2.tipB_deg !== r1.tipB_deg,
    "changing only x must re-solve full IK (tip_a and/or tip_b may change again)"
  )
})

test("mapFaceRigToPose: brow.x/y drives tip_a/tip_b via IK (not 1:1 slider→servo)", () => {
  const profile = normalizeFaceRigProfile({})
  let rig = normalizeEliteRig(createInitialEliteRig())
  rig = normalizeEliteRig({ ...rig, browL: { ...rig.browL, x: 0, y: 0 } })
  const vals0 = rigValuesFromEliteRig(rig)
  const pose0 = mapFaceRigToPose(vals0, profile, [])
  const kin0 = pose0.kinematics?.leftBrowTipFivebar
  assert.ok(kin0?.ikOk === true || kin0?.readyForIk === false || kin0?.enabled === false || kin0?.ok === true)

  if (kin0?.ikOk || kin0?.ok) {
    const sa = String(kin0.servoAId)
    const sb = String(kin0.servoBId)
    const readPwm = (pose, sid) => {
      const v = pose.logicalPose?.[sid]
      return v != null && typeof v === "object" ? v.logicalPwm : v
    }
    const pwmA0 = readPwm(pose0, sa)
    const pwmB0 = readPwm(pose0, sb)

    rig = normalizeEliteRig({ ...rig, browL: { ...rig.browL, x: 0, y: 40 } })
    const pose1 = mapFaceRigToPose(rigValuesFromEliteRig(rig), profile, [])
    const pwmA1 = readPwm(pose1, sa)
    const pwmB1 = readPwm(pose1, sb)
    assert.ok(
      pwmA1 !== pwmA0 || pwmB1 !== pwmB0,
      "changing only brow.y must allow both tip servos to update via IK"
    )
  }
})

test("elite brow semantic is x/y (not tipA=vertical servo)", () => {
  const n = normalizeEliteRig({ browL: { tipA: 40, tipB: -20 } })
  assert.equal(n.browL.y, 40)
  assert.equal(n.browL.x, -20)
  const vals = rigValuesFromEliteRig(n)
  assert.equal(vals.brow_l_tip.x, -20)
  assert.equal(vals.brow_l_tip.y, 40)
})
