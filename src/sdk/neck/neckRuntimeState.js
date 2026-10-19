/**
 * Browser-side Neck runtime snapshot helpers。
 * Runtime 不进入 Expression Project，仅会话态。
 */

import { createNeutralNeckPose, normalizeNeckPose } from "./neckPose.js"
import { NECK_BRIDGE_CLIENT_STATES } from "./neckBridgeProtocol.js"

export function createInitialNeckRuntimeState() {
  return {
    connection: NECK_BRIDGE_CLIENT_STATES.DISCONNECTED,
    sessionId: "",
    targetPose: createNeutralNeckPose(),
    commandedPose: createNeutralNeckPose(),
    actualPoseAvailable: false,
    actualPose: null,
    safety: {
      runtimeSafetyMode: null,
      productionReady: false,
    },
    stale: false,
    lastError: null,
  }
}

export function neckRuntimeFromBridgeSnapshot(snap) {
  const base = createInitialNeckRuntimeState()
  if (!snap || typeof snap !== "object") return base
  return {
    connection: snap.state || base.connection,
    sessionId: snap.sessionId || "",
    targetPose: normalizeNeckPose(snap.lastTargetPose),
    commandedPose: normalizeNeckPose(snap.lastTargetPose),
    actualPoseAvailable: Boolean(snap.actualPoseAvailable),
    actualPose: snap.actualPoseAvailable ? snap.actualPose : null,
    safety: {
      runtimeSafetyMode: snap.runtimeSafetyMode || null,
      productionReady: Boolean(snap.productionReady),
    },
    stale: snap.state === NECK_BRIDGE_CLIENT_STATES.STALE,
    lastError: snap.lastError || null,
  }
}
