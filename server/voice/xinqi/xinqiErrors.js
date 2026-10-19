/**
 * Xinqi Gateway error codes（server-side）。
 */

export const XINQI_ERROR_CODES = Object.freeze({
  MissingRobotApiKey: "MISSING_XINQI_ROBOT_API_KEY",
  InvalidBaseUrl: "XINQI_INVALID_BASE_URL",
  Unreachable: "XINQI_UNREACHABLE",
  RobotApiNotConfigured: "XINQI_ROBOT_API_NOT_CONFIGURED",
  AuthFailed: "XINQI_AUTH_FAILED",
  ConnectFailed: "XINQI_CONNECT_FAILED",
  ProtocolUnsupported: "XINQI_PROTOCOL_UNSUPPORTED",
  SessionNotFound: "XINQI_GATEWAY_SESSION_NOT_FOUND",
  SessionExpired: "XINQI_GATEWAY_SESSION_EXPIRED",
  SessionLimit: "XINQI_GATEWAY_SESSION_LIMIT",
  InvalidAudioFrame: "XINQI_INVALID_AUDIO_FRAME",
  Backpressure: "XINQI_BACKPRESSURE",
  UpstreamUnavailable: "XINQI_UPSTREAM_UNAVAILABLE",
  MessageRejected: "XINQI_MESSAGE_REJECTED",
  Unknown: "XINQI_UNKNOWN_ERROR",
})

export function xinqiJsonError(code, message, status = 500, extra = null) {
  const body = {
    error: {
      code,
      message,
    },
  }
  if (extra && typeof extra === "object") {
    body.error.detail = extra
  }
  return { status, body }
}
