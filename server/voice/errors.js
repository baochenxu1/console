/**
 * FaceDEV Voice Backend error codes（temporary token only）。
 */

export const VOICE_TOKEN_ERROR_CODES = Object.freeze({
  MissingServerApiKey: "MISSING_SERVER_API_KEY",
  UpstreamAuthFailed: "UPSTREAM_AUTH_FAILED",
  UpstreamPermissionDenied: "UPSTREAM_PERMISSION_DENIED",
  UpstreamTokenFailed: "UPSTREAM_TOKEN_FAILED",
  UpstreamUnavailable: "UPSTREAM_UNAVAILABLE",
  UnknownProvider: "UNKNOWN_PROVIDER",
  UnknownServerError: "UNKNOWN_SERVER_ERROR",
})

export function jsonError(code, message, status = 500) {
  return {
    status,
    body: {
      error: {
        code,
        message,
      },
    },
  }
}
