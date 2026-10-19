/**
 * facedev-neck-v1 in-memory mock（单元测试用，不启 Python）。
 */

import { EventEmitter } from "node:events"
import {
  FACEDEV_NECK_PROTOCOL_VERSION,
  createNeckTargetMessage,
  isServerHelloAccepted,
} from "./neckBridgeProtocol.js"

export function createMockNeckCapabilities(overrides = {}) {
  return {
    protocolVersion: FACEDEV_NECK_PROTOCOL_VERSION,
    neckSemantic: {
      units: "deg",
      limits: {
        pitch: { min: -10, max: 10 },
        roll: { min: -15, max: 15 },
        yaw: { min: -90, max: 90 },
      },
    },
    targetRateRecommendedHz: 50,
    runtimeRateHz: 100,
    actualPoseAvailable: false,
    supports: ["neck.target", "session.heartbeat", "neck.enable", "neck.disable", "neck.estop"],
    runtimeSafetyMode: "COMMISSIONING_OPEN_LOOP",
    productionReady: false,
    ...overrides,
  }
}

/**
 * 简易 mock session：记录 received messages，可注入 server.hello。
 */
export function createMockNeckBridgeSession(options = {}) {
  const capabilities = createMockNeckCapabilities(options.capabilities)
  const bus = new EventEmitter()
  const received = []
  let lastAcceptedSequence = 0
  let lastTarget = null
  let lastHeartbeatAt = 0
  let acceptHello = options.acceptHello !== false
  let protocolVersion = options.protocolVersion || FACEDEV_NECK_PROTOCOL_VERSION

  function handleClientMessage(raw) {
    const msg = typeof raw === "string" ? JSON.parse(raw) : raw
    received.push(msg)
    if (msg?.type === "client.hello") {
      const reply = {
        type: "server.hello",
        accepted: acceptHello && msg.protocolVersion === protocolVersion,
        protocolVersion,
        reason: acceptHello ? undefined : "protocol mismatch",
      }
      bus.emit("server", reply)
      return reply
    }
    if (msg?.type === "neck.target") {
      if (Number(msg.sequence) >= lastAcceptedSequence) {
        lastAcceptedSequence = Number(msg.sequence)
        lastTarget = msg.pose
      }
      bus.emit("target", msg)
      return { type: "neck.target.ack", sequence: msg.sequence }
    }
    if (msg?.type === "session.heartbeat") {
      lastHeartbeatAt = Date.now()
      bus.emit("heartbeat", msg)
      return { type: "session.heartbeat.ack", sequence: msg.sequence }
    }
    return null
  }

  return {
    capabilities,
    received,
    get lastAcceptedSequence() {
      return lastAcceptedSequence
    },
    get lastTarget() {
      return lastTarget
    },
    get lastHeartbeatAt() {
      return lastHeartbeatAt
    },
    handleClientMessage,
    onServer(fn) {
      bus.on("server", fn)
      return () => bus.off("server", fn)
    },
    /** 校验 hello 辅助 */
    assertHelloAccepted(msg) {
      return isServerHelloAccepted({ ...msg, protocolVersion })
    },
    buildTarget(partial) {
      return createNeckTargetMessage(partial)
    },
  }
}

/**
 * 纯函数级 protocol 断言 helpers（不启 socket）。
 */
export function assertSequenceMonotonic(sequences) {
  for (let i = 1; i < sequences.length; i += 1) {
    if (!(sequences[i] > sequences[i - 1])) {
      throw new Error(`sequence not monotonic at ${i}: ${sequences[i - 1]} → ${sequences[i]}`)
    }
  }
  return true
}
