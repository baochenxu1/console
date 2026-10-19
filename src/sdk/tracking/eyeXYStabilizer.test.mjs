/**
 * Eye XY Stabilizer — Vertical Recovery tests
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  stabilizeEyeXY,
  DEFAULT_EYE_XY_STABILIZATION,
} from "./eyeXYStabilizer.js"

function runSeries(inputs, cfg = DEFAULT_EYE_XY_STABILIZATION) {
  const state = {}
  let prev = { x: 50, y: 50 }
  const outs = []
  for (const inp of inputs) {
    const r = stabilizeEyeXY(prev, inp, cfg, state)
    outs.push(r)
    prev = { x: r.x, y: r.y }
  }
  return outs
}

test("Y: candidateY continuously below center → outputY can leave 50", () => {
  // EYE_VERTICAL real min candidate ≈ 48.17 (offset 1.83)
  const inputs = Array.from({ length: 8 }, () => ({ x: 50, y: 48.17 }))
  const outs = runSeries(inputs)
  const below = outs.filter((o) => o.y < 49.5)
  assert.ok(below.length >= 1, `expected Y to leave 50, got ${outs.map((o) => o.y).join(",")}`)
  assert.ok(outs[outs.length - 1].y < 49.5)
})

test("Y: positive and negative use symmetric escape semantics", () => {
  const neg = runSeries(Array.from({ length: 6 }, () => ({ x: 50, y: 48.2 })))
  const pos = runSeries(Array.from({ length: 6 }, () => ({ x: 50, y: 51.8 })))
  const nMag = Math.abs(neg[neg.length - 1].y - 50)
  const pMag = Math.abs(pos[pos.length - 1].y - 50)
  assert.ok(nMag > 0.3 && pMag > 0.3)
  assert.ok(Math.abs(nMag - pMag) < 0.35, `asymmetry n=${nMag} p=${pMag}`)
})

test("Y: small noise stays at center", () => {
  const outs = runSeries(Array.from({ length: 10 }, (_, i) => ({
    x: 50,
    y: 50 + (i % 2 === 0 ? 0.3 : -0.3),
  })))
  for (const o of outs) {
    assert.ok(Math.abs(o.y - 50) < 0.05, `noise leaked: ${o.y}`)
  }
})

test("Y: 3-frame awayConfirm forces leave center", () => {
  const cfg = {
    ...DEFAULT_EYE_XY_STABILIZATION,
    snapToCenterDeadbandY: 2.5, // intentionally high snap
    awayActivateThresholdY: 1.0,
    awayConfirmFrames: 3,
  }
  const outs = runSeries(
    [
      { x: 50, y: 48.5 },
      { x: 50, y: 48.5 },
      { x: 50, y: 48.5 },
      { x: 50, y: 48.5 },
    ],
    cfg
  )
  assert.equal(outs[0].debug.actionY, "snap_center")
  assert.equal(outs[1].debug.actionY, "snap_center")
  assert.ok(outs[2].y < 49.9 || outs[3].y < 49.9)
  assert.ok(["force_away", "track"].includes(outs[3].debug.actionY) || outs[3].y < 50)
})

test("X: horizontal snap threshold unchanged (regression)", () => {
  assert.equal(DEFAULT_EYE_XY_STABILIZATION.snapToCenterDeadbandX, 1.2)
  assert.equal(DEFAULT_EYE_XY_STABILIZATION.centerLatchXEnabled, false)
  // Offset 1.5 on X from center: EMA 0.93 < snap 1.2 → stay center (same as before)
  const outs = runSeries(Array.from({ length: 5 }, () => ({ x: 48.5, y: 50 })))
  assert.ok(Math.abs(outs[outs.length - 1].x - 50) < 0.05)
})

test("X: large horizontal motion still escapes", () => {
  const outs = runSeries(Array.from({ length: 5 }, () => ({ x: 40, y: 50 })))
  assert.ok(outs[outs.length - 1].x < 48)
})

test("debug exports per-axis thresholds", () => {
  const r = stabilizeEyeXY({ x: 50, y: 50 }, { x: 50, y: 48.17 }, DEFAULT_EYE_XY_STABILIZATION, {})
  assert.equal(typeof r.debug.activationThresholdY, "number")
  assert.equal(typeof r.debug.snapThreshold.y, "number")
  assert.ok(r.debug.snapThreshold.y < r.debug.snapThreshold.x)
  assert.equal(r.debug.inputY, 48.17)
})

test("Y: EYE_VERTICAL-like negative candidate loss rate < 5%", () => {
  // Recording: 156 frames candidateY≈48.17..48.6 all snapped to 50 under old snap=1.2
  const inputs = []
  for (let i = 0; i < 156; i += 1) inputs.push({ x: 50, y: 48.17 + (i % 5) * 0.1 })
  for (let i = 0; i < 100; i += 1) inputs.push({ x: 50, y: 50 + (i / 100) * 7.7 })
  const outs = runSeries(inputs)
  let negCand = 0
  let lost = 0
  for (let i = 0; i < inputs.length; i += 1) {
    if (inputs[i].y < 50) {
      negCand += 1
      if (Math.abs(outs[i].y - 50) < 1e-6) lost += 1
    }
  }
  const lossRate = negCand ? lost / negCand : 0
  assert.ok(lossRate < 0.05, `lossRate=${lossRate}`)
  assert.ok(Math.min(...outs.map((o) => o.y)) < 49)
  assert.ok(Math.max(...outs.map((o) => o.y)) > 55)
})
