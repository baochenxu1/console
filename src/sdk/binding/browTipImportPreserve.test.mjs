/**
 * 导入绑定：眉尖 F/D 不得冲掉用户已校准的 servoId / 行程。
 */
import assert from "node:assert/strict"
import test from "node:test"
import { normalizeFaceRigProfile } from "../../core/faceRigProfile.js"
import {
  BROW_L_D_SERVO_ID,
  BROW_L_F_SERVO_ID,
  BROW_R_D_SERVO_ID,
  BROW_R_F_SERVO_ID,
  BROW_TIP_DUAL_BINDING_VERSION,
} from "./browTipDualBindingDefaults.js"

function browBinding(controlId, servoId) {
  return {
    bindingId: `b_${controlId}`,
    controlId,
    channel: "value",
    servoId,
    enabled: true,
    neutralPwm: 1500,
    positiveTargetPwm: 1800,
    negativeTargetPwm: 1200,
    weight: 1,
    curve: "linear",
    rangeMode: "custom",
  }
}

test("import without browTipDualBindingVersion preserves calibrated F/D servoIds", () => {
  const raw = {
    version: "3.0.0",
    projectType: "robot-face-rig-profile",
    name: "calibrated",
    controls: [],
    bindings: [
      browBinding("brow_r_F", 5),
      browBinding("brow_r_D", 6),
      browBinding("brow_l_F", 7),
      browBinding("brow_l_D", 8),
    ],
  }
  const norm = normalizeFaceRigProfile(raw)
  const get = (id) => norm.bindings.find((b) => b.controlId === id && b.channel === "value")
  assert.equal(get("brow_r_F").servoId, 5)
  assert.equal(get("brow_r_D").servoId, 6)
  assert.equal(get("brow_l_F").servoId, 7)
  assert.equal(get("brow_l_D").servoId, 8)
  assert.equal(get("brow_r_F").positiveTargetPwm, 1800)
  assert.equal(norm.browTipDualBindingVersion, BROW_TIP_DUAL_BINDING_VERSION)
})

test("missing F/D bindings still fill frozen default hardware ids", () => {
  const raw = {
    version: "3.0.0",
    projectType: "robot-face-rig-profile",
    name: "partial",
    controls: [],
    bindings: [browBinding("brow_r_F", 0)],
  }
  const norm = normalizeFaceRigProfile(raw)
  const get = (id) => norm.bindings.find((b) => b.controlId === id && b.channel === "value")
  assert.equal(get("brow_r_F").servoId, BROW_R_F_SERVO_ID)
  assert.equal(get("brow_r_D").servoId, BROW_R_D_SERVO_ID)
  assert.equal(get("brow_l_F").servoId, BROW_L_F_SERVO_ID)
  assert.equal(get("brow_l_D").servoId, BROW_L_D_SERVO_ID)
})
