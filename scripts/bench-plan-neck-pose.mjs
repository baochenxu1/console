#!/usr/bin/env node
/**
 * Benchmark planNeckPose — 10000 plans, print mean / p95 / max (ms).
 */
import { performance } from "node:perf_hooks"
import {
  planNeckPose,
  createNeckPlannerState,
  createLuviaReferenceProfile,
} from "../src/sdk/neck/core/index.js"

const N = 10000
const profile = createLuviaReferenceProfile()
let state = createNeckPlannerState()
const poses = []
for (let i = 0; i < N; i++) {
  const t = (i / N) * Math.PI * 2
  poses.push({
    pitch: Math.sin(t) * 8,
    roll: Math.cos(t * 1.3) * 10,
    yaw: Math.sin(t * 0.5) * 40,
  })
}

const times = []
for (let i = 0; i < N; i++) {
  const t0 = performance.now()
  const plan = planNeckPose({ pose: poses[i], profile, previousState: state })
  const t1 = performance.now()
  times.push(t1 - t0)
  if (plan.accepted) state = plan.nextState
}

times.sort((a, b) => a - b)
const sum = times.reduce((a, b) => a + b, 0)
const mean = sum / times.length
const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))]
const max = times[times.length - 1]
console.log(
  JSON.stringify(
    {
      n: N,
      meanMs: Number(mean.toFixed(4)),
      p95Ms: Number(p95.toFixed(4)),
      maxMs: Number(max.toFixed(4)),
      hzEstimateFromMean: Number((1000 / mean).toFixed(1)),
    },
    null,
    2
  )
)
