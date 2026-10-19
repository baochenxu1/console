import {
  pickPreferredBindingServoId,
  pickUnusedServoId,
} from "./bindingActions.js"

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

assert(pickUnusedServoId([]) === 1, "empty bindings should start at 1, never 0")
assert(pickUnusedServoId([{ servoId: 1 }]) === 2, "skip used 1")
assert(pickUnusedServoId([{ servoId: 0 }]) === 1, "ignore forbidden 0 as preferred free slot")

assert(
  pickPreferredBindingServoId([], null, [7, 14, 3]) === 3,
  "prefer smallest unused profile bus id"
)
assert(
  pickPreferredBindingServoId([{ servoId: 3 }], null, [7, 14, 3]) === 7,
  "skip used profile id"
)
assert(
  pickPreferredBindingServoId([{ servoId: 3 }, { servoId: 7 }, { servoId: 14 }], 9, [
    7, 14, 3,
  ]) === 9,
  "honor free preferred"
)
assert(
  pickPreferredBindingServoId([{ servoId: 1 }], null, []) === 2,
  "fallback to unused >=1 when no profiles"
)
assert(pickPreferredBindingServoId([], 0, [5]) === 5, "preferred 0 is invalid; use profile")

console.log("bindingActionsPickServo.selftest: ok")
