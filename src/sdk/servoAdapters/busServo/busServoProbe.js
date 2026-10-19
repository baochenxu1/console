import { runBusDirectTestFrame } from "./busDirectTestFrame.js"

/**
 * 单舵机探针：仅 bus #1（logical 0），logical 500→550→500。
 */
export async function runBusServoProbeId1(opts = {}) {
  return runBusDirectTestFrame({
    ...opts,
    testIndices: [0],
    sequence: [500, 550, 500],
    stepDelayMs: 300,
  })
}
