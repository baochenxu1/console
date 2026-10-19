/**
 * RJ Host Motion Adapter — 纯函数时间计算自检
 */
import assert from "node:assert/strict"
import {
  computeRjHostMotionTimeMs,
  planRjHostMotion,
  commitRjHostMotionSend,
  resetRjHostMotionState,
  getRjHostMotionState,
  RJ_MOTION_CONFIG,
  patchRjMotionConfig,
} from "./rjHostMotionAdapter.js"

resetRjHostMotionState()
const saved = { ...RJ_MOTION_CONFIG }
patchRjMotionConfig({
  velocityRatio: 0.9,
  defaultVelocityDegS: 400,
  minTimeMs: 20,
  minSendIntervalMs: 20,
})

/* 360°/s → 90° 需要 250ms */
{
  const { timeMs, deltaDeg, velocityDegS } = computeRjHostMotionTimeMs(0, 90)
  assert.equal(velocityDegS, 360)
  assert.equal(deltaDeg, 90)
  assert.equal(timeMs, 250)
}

/* 小于 minTimeMs 时抬到 20 */
{
  const { timeMs } = computeRjHostMotionTimeMs(0, 1)
  assert.ok(timeMs >= 20)
}

/* 最新目标覆盖 + 提交后估计前进 */
{
  resetRjHostMotionState(7)
  const p1 = planRjHostMotion({
    servoId: 7,
    targetPosition: 900,
    protocol: "RJ",
    nowMs: 1000,
  })
  assert.equal(p1.ok, true)
  assert.equal(p1.deferred, false)
  assert.equal(p1.position, 900)
  assert.equal(p1.timeMs, 250)
  commitRjHostMotionSend(7, p1)

  const p2 = planRjHostMotion({
    servoId: 7,
    targetPosition: 0,
    protocol: "RJ",
    nowMs: 1125, /* 半程：估在 45° */
  })
  assert.ok(Math.abs(p2.currentEstimateDeg - 45) < 0.01)
  assert.ok(p2.timeMs > 20)
}

/* minSendInterval 延迟 */
{
  resetRjHostMotionState(8)
  const a = planRjHostMotion({
    servoId: 8,
    targetPosition: 100,
    protocol: "RJ",
    nowMs: 2000,
  })
  commitRjHostMotionSend(8, a)
  const b = planRjHostMotion({
    servoId: 8,
    targetPosition: 200,
    protocol: "RJ",
    nowMs: 2005,
  })
  assert.equal(b.deferred, true)
  assert.ok(b.retryAfterMs >= 1)
}

patchRjMotionConfig(saved)
resetRjHostMotionState()

/* forceTimeMs：跳过速度估时；实机用短非零（0 常不动） */
{
  resetRjHostMotionState(9)
  const p = planRjHostMotion({
    servoId: 9,
    targetPosition: 900,
    protocol: "RJ",
    nowMs: 3000,
    config: { forceTimeMs: 20, minTimeMs: 20, minSendIntervalMs: 0 },
  })
  assert.equal(p.ok, true)
  assert.equal(p.deferred, false)
  assert.equal(p.timeMs, 20)
  assert.equal(p.diag.forcedTime, true)
  commitRjHostMotionSend(9, p)
  const st = getRjHostMotionState(9)
  assert.equal(st.currentEstimateDeg, 90)
  assert.equal(st.motion, null)

  const p2 = planRjHostMotion({
    servoId: 9,
    targetPosition: 0,
    protocol: "RJ",
    nowMs: 3016,
    config: { forceTimeMs: 20, minSendIntervalMs: 0 },
  })
  assert.equal(p2.currentEstimateDeg, 90)
  assert.equal(p2.timeMs, 20)
}

resetRjHostMotionState()
console.log("rjHostMotionAdapter.selftest: ok")
