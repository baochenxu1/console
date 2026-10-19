import assert from "node:assert/strict"
import {
  expandControlIdsForDrag,
  filterFinalOutputsByControlIds,
  filterFinalOutputsByPwmDelta,
  rememberSentPwm,
} from "./faceRigRealtimeDragFilter.js"

{
  const ids = expandControlIdsForDrag("brow_r_tip")
  assert.ok(ids.has("brow_r_F") && ids.has("brow_r_D"))
}

{
  const outs = [
    { actuatorKey: "a", sourceChannel: "brow_r_F.value", pwmValue: 1 },
    { actuatorKey: "b", sourceChannel: "jaw.value", pwmValue: 2 },
  ]
  const filtered = filterFinalOutputsByControlIds(outs, expandControlIdsForDrag("brow_r_tip"))
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].actuatorKey, "a")
}

{
  const map = new Map()
  const outs = [
    { actuatorKey: "a", pwmValue: 10 },
    { actuatorKey: "b", pwmValue: 20 },
  ]
  rememberSentPwm(map, outs)
  const next = [
    { actuatorKey: "a", pwmValue: 10 },
    { actuatorKey: "b", pwmValue: 21 },
  ]
  const delta = filterFinalOutputsByPwmDelta(next, map)
  assert.equal(delta.length, 1)
  assert.equal(delta[0].actuatorKey, "b")
}

console.log("faceRigRealtimeDragFilter.selftest: ok")
