import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  evaluateBindingLogical,
  channelRawToDriver,
} from "../../core/faceDofMapper.js"
import {
  normalizeBinding,
  normalizeFaceRigProfile,
  createDefaultFaceRigProfile,
  CHANNEL_X,
  CHANNEL_Y,
  CHANNEL_VALUE,
  bindingWithRestoredEndpointsVsNeutral,
} from "../../core/faceRigProfile.js"
import { bindingTargetPatch } from "./bindingActuatorFields.js"
import {
  addBinding,
  updateBinding,
  deleteBinding,
  reverseBinding,
  duplicateBinding,
  duplicateBindingAsReverse,
  restoreBindingFullRange,
  setBindingPositiveFromContribution,
  setBindingNegativeFromContribution,
  setBindingNeutralFromContribution,
} from "./bindingActions.js"
import {
  BINDING_DIR_FORWARD,
  BINDING_DIR_REVERSE,
  LOWER_LIMIT_TARGET_FIELD,
  UPPER_LIMIT_TARGET_FIELD,
  readBindingMappingDirection,
  readLowerLimitPwm,
  readUpperLimitPwm,
  shouldReverseBindingForDirection,
  travelLimitToTargetField,
  TRAVEL_LIMIT_LOWER,
  TRAVEL_LIMIT_NEUTRAL,
  TRAVEL_LIMIT_UPPER,
} from "./bindingInspectorWorkflowUi.js"
import {
  resolveBrowTipBindingHost,
  BROW_TIP_BIND_CHANNEL_F,
  BROW_TIP_BIND_CHANNEL_D,
} from "./browTipBindingUi.js"
import {
  resolveJawBindingHost,
  JAW_BIND_CHANNEL_A,
  JAW_BIND_CHANNEL_D,
} from "./jawBindingUi.js"
import { migrateFaceRigProfileToBusSemantics } from "./migrateFaceRigProfileToBusSemantics.js"

function sampleBinding(overrides = {}) {
  return normalizeBinding({
    bindingId: "bind_test_1",
    controlId: "brow_l_tail",
    channel: CHANNEL_VALUE,
    servoId: 21,
    neutralPwm: 1500,
    positiveTargetPwm: 2500,
    negativeTargetPwm: 500,
    weight: 1,
    curve: "linear",
    enabled: true,
    rangeMode: "custom",
    ...overrides,
  })
}

function stampedProfile(bindings) {
  const base = normalizeFaceRigProfile(createDefaultFaceRigProfile())
  return normalizeFaceRigProfile({
    ...base,
    bindings,
  })
}

describe("Face Binding Inspector Workflow UI", () => {
  it("J: +100/-100 map to positive/negative targets unchanged", () => {
    assert.equal(travelLimitToTargetField(TRAVEL_LIMIT_UPPER), UPPER_LIMIT_TARGET_FIELD)
    assert.equal(travelLimitToTargetField(TRAVEL_LIMIT_LOWER), LOWER_LIMIT_TARGET_FIELD)
    assert.equal(travelLimitToTargetField(TRAVEL_LIMIT_NEUTRAL), "neutralPwm")

    const b = sampleBinding({
      neutralPwm: 1500,
      positiveTargetPwm: 2000,
      negativeTargetPwm: 1000,
      rangeMode: "custom",
    })
    const driverPos = channelRawToDriver(100, { mode: "signed100" })
    const driverNeg = channelRawToDriver(-100, { mode: "signed100" })
    assert.equal(driverPos, 1)
    assert.equal(driverNeg, -1)
    assert.equal(evaluateBindingLogical(driverPos, b), 2000)
    assert.equal(evaluateBindingLogical(driverNeg, b), 1000)
    assert.equal(readUpperLimitPwm(b), b.positiveTargetPwm)
    assert.equal(readLowerLimitPwm(b), b.negativeTargetPwm)
  })

  it("A: addBinding keeps schema and actuatorKey", () => {
    const profile = stampedProfile([])
    const before = profile.bindings.length
    const next = addBinding(profile, {
      bindingId: "bind_added_a",
      controlId: "brow_l_tail",
      channel: CHANNEL_VALUE,
      servoId: 7,
    })
    assert.equal(next.bindings.length, before + 1)
    const added = next.bindings.find((b) => b.bindingId === "bind_added_a")
    assert.ok(added)
    assert.equal(added.servoId, 7)
    assert.equal(added.actuatorKey, "servo_7")
  })

  it("B/K: setup is presentation-only (session Set semantics)", () => {
    const setupIds = new Set()
    const b = sampleBinding({ bindingId: "bind_new_ui" })
    setupIds.add(b.bindingId)
    assert.ok(setupIds.has("bind_new_ui"))
    const completed = new Set(setupIds)
    completed.delete("bind_new_ui")
    assert.equal(completed.has("bind_new_ui"), false)
    assert.equal(b.bindingId, "bind_new_ui")
    assert.equal(Object.prototype.hasOwnProperty.call(b, "setupComplete"), false)
  })

  it("C/D: servoId update syncs actuatorKey", () => {
    let profile = stampedProfile([sampleBinding({ servoId: 3 })])
    const id = profile.bindings[0].bindingId
    profile = updateBinding(profile, id, bindingTargetPatch(21))
    assert.equal(profile.bindings[0].servoId, 21)
    assert.equal(profile.bindings[0].actuatorKey, "servo_21")
  })

  it("E/L: direction is invert flag (travel endpoints unchanged)", () => {
    let profile = stampedProfile([sampleBinding()])
    const id = profile.bindings[0].bindingId
    assert.equal(readBindingMappingDirection(profile.bindings[0]), BINDING_DIR_FORWARD)
    assert.equal(shouldReverseBindingForDirection(profile.bindings[0], BINDING_DIR_REVERSE), true)
    profile = reverseBinding(profile, id)
    assert.equal(profile.bindings[0].invert, true)
    assert.equal(profile.bindings[0].positiveTargetPwm, 2500)
    assert.equal(profile.bindings[0].negativeTargetPwm, 500)
    assert.equal(readBindingMappingDirection(profile.bindings[0]), BINDING_DIR_REVERSE)
    const driverPos = channelRawToDriver(100, { mode: "signed100" })
    assert.equal(evaluateBindingLogical(driverPos, profile.bindings[0]), 500)
  })

  it("E2: invert survives normalize / save roundtrip", () => {
    const profile = stampedProfile([sampleBinding({ invert: true })])
    assert.equal(profile.bindings[0].invert, true)
    const again = normalizeFaceRigProfile(profile)
    assert.equal(again.bindings[0].invert, true)
    assert.equal(readBindingMappingDirection(again.bindings[0]), BINDING_DIR_REVERSE)
  })

  it("F: contribution logical pwm is 本条逻辑脉宽 source", () => {
    const b = sampleBinding()
    const logical = evaluateBindingLogical(0.5, b)
    const contributions = [{ bindingId: b.bindingId, logicalPwm: logical }]
    assert.equal(contributions[0].logicalPwm, logical)
  })

  it("G/H/I: set upper/lower/neutral handlers write correct fields", () => {
    let profile = stampedProfile([sampleBinding()])
    const id = profile.bindings[0].bindingId
    const contributions = [{ bindingId: id, logicalPwm: 1800 }]
    profile = setBindingPositiveFromContribution(profile, id, contributions)
    assert.equal(profile.bindings[0].positiveTargetPwm, 1800)
    contributions[0].logicalPwm = 1200
    profile = setBindingNegativeFromContribution(profile, id, contributions)
    assert.equal(profile.bindings[0].negativeTargetPwm, 1200)
    contributions[0].logicalPwm = 1550
    profile = setBindingNeutralFromContribution(profile, id, contributions)
    assert.equal(profile.bindings[0].neutralPwm, 1550)
  })

  it("M: compact servo overview fields remain available on config", () => {
    const b = sampleBinding({ servoId: 21 })
    assert.equal(b.actuatorKey, "servo_21")
    assert.ok(Number.isFinite(b.neutralPwm))
  })

  it("N: weight and curve update in more-settings path", () => {
    let profile = stampedProfile([sampleBinding()])
    const id = profile.bindings[0].bindingId
    profile = updateBinding(profile, id, { weight: 1.25, curve: "smoothstep" })
    assert.equal(profile.bindings[0].weight, 1.25)
    assert.equal(profile.bindings[0].curve, "smoothstep")
  })

  it("O: restore full range works", () => {
    let profile = stampedProfile([
      sampleBinding({
        positiveTargetPwm: 1700,
        negativeTargetPwm: 1300,
        rangeMode: "custom",
      }),
    ])
    const id = profile.bindings[0].bindingId
    profile = restoreBindingFullRange(profile, id)
    const restored = bindingWithRestoredEndpointsVsNeutral(profile.bindings[0])
    assert.equal(profile.bindings[0].positiveTargetPwm, restored.positiveTargetPwm)
    assert.equal(profile.bindings[0].negativeTargetPwm, restored.negativeTargetPwm)
  })

  it("P/Q/R: copy, copy reverse, delete", () => {
    let profile = stampedProfile([sampleBinding()])
    const id = profile.bindings[0].bindingId
    const start = profile.bindings.length
    profile = duplicateBinding(profile, id)
    assert.equal(profile.bindings.length, start + 1)
    profile = duplicateBindingAsReverse(profile, id)
    assert.equal(profile.bindings.length, start + 2)
    const rev = profile.bindings.find(
      (b) => b.bindingId !== id && b.invert === true && b.positiveTargetPwm === 2500
    )
    assert.ok(rev)
    profile = deleteBinding(profile, id)
    assert.equal(profile.bindings.some((b) => b.bindingId === id), false)
  })

  it("V: migration to bus semantics still works", () => {
    const profile = stampedProfile([
      sampleBinding({ neutralPwm: 1600, positiveTargetPwm: 2000, negativeTargetPwm: 1200 }),
    ])
    const migrated = migrateFaceRigProfileToBusSemantics(profile)
    const b = migrated.bindings[0]
    assert.equal(b.neutralPwm, 1500)
    assert.equal(b.migratedFromNeutralPwm, 1600)
  })

  it("W: Brow F/D host resolution", () => {
    const f = resolveBrowTipBindingHost("brow_l_tip", BROW_TIP_BIND_CHANNEL_F)
    const d = resolveBrowTipBindingHost("brow_l_tip", BROW_TIP_BIND_CHANNEL_D)
    assert.ok(f.isBrowTipBinding)
    assert.ok(d.isBrowTipBinding)
    assert.notEqual(f.hostControlId, d.hostControlId)
  })

  it("X: Jaw A/D host resolution", () => {
    const a = resolveJawBindingHost("jaw", JAW_BIND_CHANNEL_A)
    const d = resolveJawBindingHost("jaw", JAW_BIND_CHANNEL_D)
    assert.ok(a.isJawBinding)
    assert.ok(d.isJawBinding)
    assert.notEqual(a.hostControlId, d.hostControlId)
  })

  it("Y: XY channel constants remain x/y", () => {
    assert.equal(CHANNEL_X, "x")
    assert.equal(CHANNEL_Y, "y")
  })
})
