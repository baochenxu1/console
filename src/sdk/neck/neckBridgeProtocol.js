/**
 * facedev-neck-v1 protocol constants & message builders.
 * FaceDEV 只发 semantic pitch/roll/yaw，不发 joint / CAN。
 */

export const FACEDEV_NECK_PROTOCOL_VERSION = "facedev-neck-v1"
export const NECK_BRIDGE_DEFAULT_HTTP = "http://127.0.0.1:8787"
export const NECK_BRIDGE_DEFAULT_WS = "ws://127.0.0.1:8787/v1/session"

export const NECK_BRIDGE_CLIENT_STATES = Object.freeze({
  DISCONNECTED: "DISCONNECTED",
  CONNECTING: "CONNECTING",
  CONNECTED: "CONNECTED",
  SESSION_ACTIVE: "SESSION_ACTIVE",
  STALE: "STALE",
  ERROR: "ERROR",
})

/** UI / connectivity 语义态（可映射到 client state + error） */
export const NECK_BRIDGE_UI_STATES = Object.freeze({
  DISCONNECTED: "DISCONNECTED",
  CONNECTING: "CONNECTING",
  PERMISSION_REQUIRED: "PERMISSION_REQUIRED",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  BRIDGE_NOT_FOUND: "BRIDGE_NOT_FOUND",
  CONNECTED: "CONNECTED",
  SESSION_ACTIVE: "SESSION_ACTIVE",
  BUSY: "BUSY",
  STALE: "STALE",
  ERROR: "ERROR",
  UNSUPPORTED_BROWSER: "UNSUPPORTED_BROWSER",
})

export function createClientHello({ sessionId, client = "facedev" } = {}) {
  return {
    type: "client.hello",
    protocolVersion: FACEDEV_NECK_PROTOCOL_VERSION,
    client,
    sessionId: String(sessionId || ""),
  }
}

export function createNeckTargetMessage({
  sessionId,
  sequence,
  timelineTimeMs,
  pose,
} = {}) {
  return {
    type: "neck.target",
    sessionId: String(sessionId || ""),
    sequence: Math.max(0, Math.round(Number(sequence) || 0)),
    timelineTimeMs: Math.max(0, Math.round(Number(timelineTimeMs) || 0)),
    pose: {
      pitch: Number(pose?.pitch) || 0,
      roll: Number(pose?.roll) || 0,
      yaw: Number(pose?.yaw) || 0,
    },
  }
}

export function createSessionHeartbeat({ sessionId, sequence } = {}) {
  return {
    type: "session.heartbeat",
    sessionId: String(sessionId || ""),
    sequence: Math.max(0, Math.round(Number(sequence) || 0)),
  }
}

export function createSessionResume({ sessionId, sequence } = {}) {
  return {
    type: "session.resume",
    sessionId: String(sessionId || ""),
    sequence: Math.max(0, Math.round(Number(sequence) || 0)),
  }
}

/**
 * Bridge → LuviaApplication.connect(channel=…, virtual=…)
 * Schema 与 Luvia bridge/server.py `_on_command` 对齐：字段名为 channel（非 port）。
 */
export function createNeckConnectMessage({
  sessionId,
  sequence,
  channel = "",
  virtual = false,
  id = "",
} = {}) {
  const msg = {
    type: "neck.connect",
    sessionId: String(sessionId || ""),
    sequence: Math.max(0, Math.round(Number(sequence) || 0)),
    channel: String(channel || ""),
    virtual: Boolean(virtual),
  }
  if (id) msg.id = String(id)
  return msg
}

export function createNeckDisconnectMessage({ sessionId, sequence, id = "" } = {}) {
  const msg = {
    type: "neck.disconnect",
    sessionId: String(sessionId || ""),
    sequence: Math.max(0, Math.round(Number(sequence) || 0)),
  }
  if (id) msg.id = String(id)
  return msg
}

export function isServerHelloAccepted(msg) {
  return (
    msg &&
    typeof msg === "object" &&
    msg.type === "server.hello" &&
    msg.accepted === true &&
    String(msg.protocolVersion || "") === FACEDEV_NECK_PROTOCOL_VERSION
  )
}

/** FaceDEV 侧 neck.target dispatch 决策（不猜 Luvia；仅 Browser 最小前置条件） */
export const NECK_TARGET_DISPATCH_DECISIONS = Object.freeze({
  SENT: "SENT",
  SKIPPED_HARDWARE_PREVIEW_OFF: "SKIPPED_HARDWARE_PREVIEW_OFF",
  SKIPPED_SESSION_INACTIVE: "SKIPPED_SESSION_INACTIVE",
  SKIPPED_HARDWARE_DISCONNECTED: "SKIPPED_HARDWARE_DISCONNECTED",
  SKIPPED_NOT_ENABLED: "SKIPPED_NOT_ENABLED",
  SKIPPED_STALE: "SKIPPED_STALE",
  FAILED_SOCKET: "FAILED_SOCKET",
})

/** @typedef {'editor' | 'timeline' | 'control'} NeckTargetSource */
