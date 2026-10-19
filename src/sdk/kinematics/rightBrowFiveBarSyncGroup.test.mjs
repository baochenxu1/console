/**
 * 右眉 Continuous V2：A-space / retarget / reverse / SyncWrite / slow transport / no double-smooth
 */
import assert from "node:assert/strict"
import test from "node:test"
import {
  createRightBrowFiveBarSyncGroup,
  stepRightBrowFiveBarSyncGroup,
  markRightBrowFiveBarSyncBatchSent,
  getRightBrowFiveBarSyncDiagnostics,
  stepTaskSpaceAServo,
  computeRightBrowSyncDurationMs,
  RIGHT_BROW_MOTION_MODE,
  RIGHT_BROW_PAIR_SERVO_CONFIG,
  smoothstep01,
} from "./rightBrowFiveBarSyncGroup.js"
import {
  BROW_FIVEBAR_RIGHT_GEOMETRY,
  browFiveBarFkWorld,
  browPadToWorldA,
  solveBrowFiveBarFromWorldA,
} from "./browFiveBarKinematics.js"
import { groupBusCommandsForSyncWrite } from "../servoAdapters/busServo/sendBusServoFrameSyncWrite.js"

const A0 = BROW_FIVEBAR_RIGHT_GEOMETRY.A0

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

test("smoothstep endpoints", () => {
  assert.equal(smoothstep01(0), 0)
  assert.equal(smoothstep01(1), 1)
})

test("discrete params still faster than old 450ms", () => {
  const dur = computeRightBrowSyncDurationMs(60, 60)
  assert.ok(dur <= 160)
  assert.ok(dur < 450)
})

test("A-space path: each nextA has valid IK and FK≈nextA", () => {
  const g = createRightBrowFiveBarSyncGroup()
  markRightBrowFiveBarSyncBatchSent(g, 0, { qF: 0, qD: 0 })
  const start = browPadToWorldA({ x: 0, y: 0 }, "right")
  const end = browPadToWorldA({ x: 80, y: -40 }, "right")
  g.lastSuccessfullySentA = { x: start[0], y: start[1] }

  let now = 0
  const samples = []
  for (let i = 0; i < 40; i++) {
    now += 8
    const r = stepRightBrowFiveBarSyncGroup(g, {
      mode: RIGHT_BROW_MOTION_MODE.CONTINUOUS_SERVO,
      targetX: 80,
      targetY: -40,
      desiredA: { x: end[0], y: end[1] },
      nowMs: now,
    })
    assert.equal(r.accept, true, r.reason)
    assert.equal(r.space, "A")
    samples.push({ ...r.nextA, qF: r.qF, qD: r.qD })
    markRightBrowFiveBarSyncBatchSent(g, now, { qF: r.qF, qD: r.qD })
    if (g.groupFinished) break
  }
  assert.ok(samples.length >= 2)
  for (const s of samples) {
    const ik = solveBrowFiveBarFromWorldA([s.x, s.y], "right")
    assert.equal(ik.ok, true, ik.message)
    const fk = browFiveBarFkWorld(ik.qDDeg, ik.qFDeg, "right")
    assert.equal(fk.ok, true)
    assert.ok(Math.hypot(fk.Aworld[0] - s.x, fk.Aworld[1] - s.y) < 1e-6)
  }
})

test("retarget: velocityA not zeroed; latest desired wins; no queue", () => {
  const g = createRightBrowFiveBarSyncGroup()
  const a0 = browPadToWorldA({ x: 0, y: 0 }, "right")
  markRightBrowFiveBarSyncBatchSent(g, 0, { qF: 0, qD: 0 })
  g.lastSuccessfullySentA = { x: a0[0], y: a0[1] }

  const targets = [
    { x: 40, y: 0 },
    { x: 80, y: 20 },
    { x: -20, y: -30 },
  ].map((p) => {
    const w = browPadToWorldA(p, "right")
    return { pad: p, A: { x: w[0], y: w[1] } }
  })

  let now = 0
  let prevSpeed = 0
  let zeroWhileFar = 0
  for (let i = 0; i < 30; i++) {
    now += 8
    const t = targets[Math.min(targets.length - 1, Math.floor(i / 10))]
    stepRightBrowFiveBarSyncGroup(g, {
      mode: RIGHT_BROW_MOTION_MODE.CONTINUOUS_SERVO,
      targetX: t.pad.x,
      targetY: t.pad.y,
      desiredA: t.A,
      nowMs: now,
    })
    markRightBrowFiveBarSyncBatchSent(g, now, {
      qF: g.lastScheduledF,
      qD: g.lastScheduledD,
    })
    const speed = Math.hypot(g.velocityA.x, g.velocityA.y)
    const err = dist(g.lastSuccessfullySentA, t.A)
    if (i > 2 && prevSpeed > 20 && speed < 1e-6 && err > 0.5) zeroWhileFar += 1
    prevSpeed = speed
  }
  assert.equal(zeroWhileFar, 0)
  assert.ok(Math.abs(g.desiredA.x - targets[2].A.x) < 1e-9)
  assert.equal(g.lastReplanReason, "a-space-continuous")
})

test("fast reverse pad -100→+100→-100 keeps continuous A motion", () => {
  const g = createRightBrowFiveBarSyncGroup()
  const pads = [-100, 100, -100]
  markRightBrowFiveBarSyncBatchSent(g, 0, { qF: 0, qD: 0 })
  g.lastSuccessfullySentA = {
    x: browPadToWorldA({ x: 0, y: 0 }, "right")[0],
    y: browPadToWorldA({ x: 0, y: 0 }, "right")[1],
  }
  let now = 0
  let positions = []
  for (const padX of pads) {
    const w = browPadToWorldA({ x: padX, y: 0 }, "right")
    for (let k = 0; k < 12; k++) {
      now += 8
      const before = { ...g.lastSuccessfullySentA }
      stepRightBrowFiveBarSyncGroup(g, {
        mode: RIGHT_BROW_MOTION_MODE.CONTINUOUS_SERVO,
        targetX: padX,
        targetY: 0,
        desiredA: { x: w[0], y: w[1] },
        nowMs: now,
      })
      markRightBrowFiveBarSyncBatchSent(g, now, {
        qF: g.lastScheduledF,
        qD: g.lastScheduledD,
      })
      positions.push({ ...g.lastSuccessfullySentA })
      assert.notEqual(g.lastReplanReason, "discrete-replan")
      /* 位置连续：相邻步长受 maxV*dt 约束 */
      const step = dist(before, g.lastSuccessfullySentA)
      const maxStep =
        (RIGHT_BROW_PAIR_SERVO_CONFIG.maxVelocityMmPerSec * 8) / 1000 + 1e-6
      assert.ok(step <= maxStep + 0.05, `step ${step} > ${maxStep}`)
    }
  }
  assert.ok(positions.length > 10)
})

test("task-space shared vector: X/Y not independently slewed", () => {
  const r = stepTaskSpaceAServo({
    currentA: { x: 0, y: 0 },
    velocityA: { x: 0, y: 0 },
    desiredA: { x: 10, y: 5 },
    dtSec: 0.01,
    maxVelocityMmPerSec: 100,
    maxAccelerationMmPerSec2: 5000,
    arriveEpsMm: 0.01,
  })
  const dx = r.nextA.x
  const dy = r.nextA.y
  assert.ok(Math.abs(dy / dx - 0.5) < 1e-6, "must move along delta vector")
})

test("Atomic SyncWrite grouping includes ID1 and ID2 together", () => {
  const scProfile = {
    protocol: "scscl",
    id: 1,
    busServoId: 1,
    center: 1500,
    min: 0,
    max: 4095,
  }
  const commands = [
    {
      busServoId: 1,
      protocol: "scscl",
      targetPosition: 1500,
      time: 0,
      speed: 0,
      profile: { ...scProfile, id: 1, busServoId: 1 },
    },
    {
      busServoId: 2,
      protocol: "scscl",
      targetPosition: 1600,
      time: 0,
      speed: 0,
      profile: { ...scProfile, id: 2, busServoId: 2 },
    },
  ]
  const { groups, skipped } = groupBusCommandsForSyncWrite(commands)
  assert.equal(skipped.length, 0, JSON.stringify(skipped))
  assert.equal(groups.length, 1)
  const ids = groups[0].commands.map((c) => c.id)
  assert.deepEqual(ids, [1, 2])
})

test("slow transport: latest-wins, no backlog of historical targets", () => {
  const g = createRightBrowFiveBarSyncGroup()
  const a0 = browPadToWorldA({ x: 0, y: 0 }, "right")
  markRightBrowFiveBarSyncBatchSent(g, 0, { qF: 0, qD: 0 })
  g.lastSuccessfullySentA = { x: a0[0], y: a0[1] }

  const history = []
  let now = 0
  /* 模拟总线耗时 40ms > 理想 8ms：每帧只消费最新 pad */
  for (let i = 0; i < 10; i++) {
    const padX = -100 + i * 20
    history.push(padX)
    now += 40
    const w = browPadToWorldA({ x: padX, y: 0 }, "right")
    stepRightBrowFiveBarSyncGroup(g, {
      mode: RIGHT_BROW_MOTION_MODE.CONTINUOUS_SERVO,
      targetX: padX,
      targetY: 0,
      desiredA: { x: w[0], y: w[1] },
      nowMs: now,
    })
    markRightBrowFiveBarSyncBatchSent(g, now, {
      qF: g.lastScheduledF,
      qD: g.lastScheduledD,
    })
  }
  const last = history[history.length - 1]
  const want = browPadToWorldA({ x: last, y: 0 }, "right")
  assert.ok(Math.abs(g.desiredA.x - want[0]) < 1e-9)
  assert.ok(g.actualDtMs >= 39)
  assert.equal(g.latestTargetSeq, history.length)
})

test("continuous device time is 0 (no host+servo double slow trajectory)", () => {
  assert.equal(RIGHT_BROW_PAIR_SERVO_CONFIG.continuousDeviceTimeMs, 0)
  const g = createRightBrowFiveBarSyncGroup()
  const w = browPadToWorldA({ x: 50, y: 0 }, "right")
  stepRightBrowFiveBarSyncGroup(g, {
    mode: RIGHT_BROW_MOTION_MODE.CONTINUOUS_SERVO,
    targetX: 50,
    targetY: 0,
    desiredA: { x: w[0], y: w[1] },
    nowMs: 10,
  })
  assert.equal(g.servoInternalTime, 0)
  /* Face Rig 实机为 single-write；Host 仍做 A-space 成对 */
  assert.equal(g.syncWrite, false)
  const d = getRightBrowFiveBarSyncDiagnostics(g)
  assert.equal(d.space, "A")
  assert.equal(d.servoInternalTime, 0)
})

test("pointerup final settle uses A-space and finishes", () => {
  const g = createRightBrowFiveBarSyncGroup()
  const w = browPadToWorldA({ x: 60, y: -20 }, "right")
  markRightBrowFiveBarSyncBatchSent(g, 0, { qF: 0, qD: 0 })
  g.lastSuccessfullySentA = {
    x: browPadToWorldA({ x: 0, y: 0 }, "right")[0],
    y: browPadToWorldA({ x: 0, y: 0 }, "right")[1],
  }
  g.velocityA = { x: 100, y: -40 }
  let now = 0
  for (let i = 0; i < 25; i++) {
    now += 8
    stepRightBrowFiveBarSyncGroup(g, {
      mode: RIGHT_BROW_MOTION_MODE.FINAL_SETTLE,
      beginFinalSettle: i === 0,
      targetX: 60,
      targetY: -20,
      desiredA: { x: w[0], y: w[1] },
      nowMs: now,
    })
    markRightBrowFiveBarSyncBatchSent(g, now, {
      qF: g.lastScheduledF,
      qD: g.lastScheduledD,
    })
    if (g.groupFinished) break
  }
  assert.ok(dist(g.lastSuccessfullySentA, { x: w[0], y: w[1] }) < 0.2)
})

test("continuous does not use q-space sharedStep as primary", () => {
  const g = createRightBrowFiveBarSyncGroup()
  const w = browPadToWorldA({ x: 30, y: 10 }, "right")
  stepRightBrowFiveBarSyncGroup(g, {
    mode: RIGHT_BROW_MOTION_MODE.CONTINUOUS_SERVO,
    qFTarget: 99,
    qDTarget: -99,
    targetX: 30,
    targetY: 10,
    desiredA: { x: w[0], y: w[1] },
    nowMs: 8,
  })
  assert.equal(g.space, "A")
  assert.equal(g.lastReplanReason, "a-space-continuous")
  /* q 来自 IK(nextA)，不是 99/-99 插值 */
  assert.ok(Math.abs(g.nextF) < 50)
  assert.ok(Math.abs(g.nextD) < 50)
})
