import { legacyServoIndexToActuatorKey } from "../../output/actuatorKeys.js"
import {
  buildBusCommandsFromFinalOutputs,
  sendBusServoOutputs,
} from "../../output/adapters/busServoOutputAdapter.js"
import {
  getActiveBusTransport,
  getActiveBusTransportLabel,
  getSharedBusWireTransport,
  isSharedBusWireConnected,
} from "./resolveBusTransport.js"

const DEFAULT_TEST_INDICES = [0, 1, 13]

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/**
 * Bus Direct Test Frame：不依赖 tracking，经 finalServoOutputs → actuator profile 发送。
 */
export async function runBusDirectTestFrame({
  profiles,
  actuatorProfiles = profiles,
  transport = getSharedBusWireTransport(),
  testIndices = DEFAULT_TEST_INDICES,
  sequence = [500, 560, 500],
  stepDelayMs = 300,
  txMode = "sync-write",
} = {}) {
  if (!isSharedBusWireConnected() && !transport.getStatus()?.connected) {
    return { ok: false, error: `${getActiveBusTransportLabel()} 串口未连接` }
  }

  const steps = []

  for (const logicalValue of sequence) {
    const finalOutputs = testIndices.map((idx) => ({
      actuatorKey: legacyServoIndexToActuatorKey(idx),
      legacyServoIndex: idx,
      logicalValue,
      pwmValue: 500 + logicalValue * 2,
      sourceType: "manual",
      enabled: true,
    }))

    const built = buildBusCommandsFromFinalOutputs(finalOutputs, actuatorProfiles)

    if (!built.commands.length) {
      return {
        ok: false,
        error: "无有效测试命令（检查 actuator profile）",
        steps,
        skipped: built.skipped,
      }
    }

    const sendRes = await sendBusServoOutputs(finalOutputs, actuatorProfiles, {
      transport,
      txMode,
      syncMode: "reg-action",
    })

    steps.push({
      step: steps.length + 1,
      logicalValue,
      finalServoOutputs: finalOutputs,
      commands: built.commands.map((c) => ({
        actuatorKey: c.actuatorKey,
        busServoId: c.busServoId,
        protocol: c.protocol,
        logicalValue: c.busLogical,
        targetPosition: c.targetPosition,
      })),
      send: sendRes.send,
      skipped: built.skipped,
    })

    if (!sendRes.ok) {
      return {
        ok: false,
        error: sendRes.error || "Direct Test 发送失败",
        steps,
      }
    }

    if (stepDelayMs > 0 && logicalValue !== sequence[sequence.length - 1]) {
      await delay(stepDelayMs)
    }
  }

  return {
    ok: true,
    message: `Direct Test OK (${txMode}): ${testIndices.map((i) => legacyServoIndexToActuatorKey(i)).join(", ")} ${sequence.join("→")}`,
    steps,
    testIndices,
    sequence,
    txMode,
  }
}
