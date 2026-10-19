/**
 * Neck protocol/transport profile (separate from CharacterPose).
 * protocolProfileVersion is BM_HMD contract — not facedev-neck-v1 Bridge IPC.
 *
 * R2.1 canonical nested shape:
 * {
 *   type: "slcan",
 *   can: { mode: "fd"|"classic", arbitrationBitrate, dataBitrate, brs }
 * }
 *
 * Legacy flat createLuviaTransportProfile() kept for R2 golden callers.
 */

export const PROTOCOL_PROFILE_VERSION = "bm-hmd-luvia-v1"

export class TransportProfileError extends Error {
  constructor(message, code = "TRANSPORT_PROFILE_ERROR") {
    super(message)
    this.name = "TransportProfileError"
    this.code = code
  }
}

/**
 * Hard guard: BRS breaks enable on current CANable — reject, never send.
 * @param {{ brs?: boolean, can?: { brs?: boolean } }|null|undefined} profile
 */
export function rejectBrsConfig(profile) {
  if (!profile) return profile
  if (profile.brs === true || profile.can?.brs === true) {
    throw new TransportProfileError(
      "production neck transport forbids brs=true (BRS breaks motor enable)",
      "BRS_FORBIDDEN"
    )
  }
  return profile
}

/**
 * Luvia Stage-1 production transport defaults (flat R2 shape).
 */
export function createLuviaTransportProfile(overrides = {}) {
  const profile = {
    protocolProfileVersion: PROTOCOL_PROFILE_VERSION,
    canFd: true,
    brs: false,
    arbitrationBitrate: 1_000_000,
    dataBitrate: 5_000_000,
    isExtendedId: false,
    ...overrides,
  }
  rejectBrsConfig(profile)
  if (profile.canFd !== true) {
    throw new TransportProfileError("production profile requires canFd=true", "FD_REQUIRED")
  }
  return Object.freeze({ ...profile })
}

/**
 * Canonical nested FD transport config for NeckRuntimeProfile.transport.
 */
export function createLuviaFdTransportConfig(overrides = {}) {
  const canOverrides = overrides.can && typeof overrides.can === "object" ? overrides.can : {}
  const { can: _drop, ...rest } = overrides
  const config = {
    type: "slcan",
    can: {
      mode: "fd",
      arbitrationBitrate: 1_000_000,
      dataBitrate: 5_000_000,
      brs: false,
      ...canOverrides,
    },
    ...rest,
  }
  rejectBrsConfig(config)
  if (config.can.mode !== "fd") {
    throw new TransportProfileError("Luvia FD transport requires can.mode=fd", "FD_REQUIRED")
  }
  return Object.freeze({
    type: config.type,
    can: Object.freeze({ ...config.can }),
  })
}

/**
 * Test-only Classic CAN transport config (not for BM_HMD hardware).
 */
export function createClassicTransportConfig(overrides = {}) {
  const canOverrides = overrides.can && typeof overrides.can === "object" ? overrides.can : {}
  const bitrate =
    canOverrides.arbitrationBitrate ??
    canOverrides.bitrate ??
    overrides.bitrate ??
    1_000_000
  const { can: _drop, bitrate: _b, ...rest } = overrides
  const config = {
    type: "slcan",
    can: {
      mode: "classic",
      arbitrationBitrate: Number(bitrate),
      dataBitrate: null,
      brs: false,
      ...canOverrides,
      mode: "classic",
      arbitrationBitrate: Number(canOverrides.arbitrationBitrate ?? bitrate),
      brs: false,
    },
    ...rest,
  }
  return Object.freeze({
    type: config.type,
    can: Object.freeze({ ...config.can }),
  })
}

/**
 * Normalize flat or nested transport into canonical nested shape.
 */
export function normalizeTransportConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {}
  if (src.can && typeof src.can === "object") {
    const mode = String(src.can.mode || (src.canFd === false ? "classic" : "fd"))
    const nested = {
      type: String(src.type || "slcan"),
      can: {
        mode,
        arbitrationBitrate: Number(
          src.can.arbitrationBitrate ?? src.arbitrationBitrate ?? 1_000_000
        ),
        dataBitrate:
          mode === "classic"
            ? src.can.dataBitrate == null
              ? null
              : Number(src.can.dataBitrate)
            : Number(src.can.dataBitrate ?? src.dataBitrate ?? 5_000_000),
        brs: Boolean(src.can.brs),
      },
    }
    rejectBrsConfig(nested)
    return nested
  }
  // Flat R2 profile → nested
  const mode = src.canFd === false ? "classic" : "fd"
  const nested = {
    type: String(src.type || "slcan"),
    can: {
      mode,
      arbitrationBitrate: Number(src.arbitrationBitrate ?? 1_000_000),
      dataBitrate: mode === "classic" ? null : Number(src.dataBitrate ?? 5_000_000),
      brs: Boolean(src.brs),
    },
  }
  rejectBrsConfig(nested)
  return nested
}

/**
 * Derive flat R2 transport fields from nested or flat input (diagnostics / legacy).
 */
export function toFlatTransportProfile(raw) {
  const nested = normalizeTransportConfig(raw)
  return Object.freeze({
    protocolProfileVersion:
      raw?.protocolProfileVersion || PROTOCOL_PROFILE_VERSION,
    canFd: nested.can.mode === "fd",
    brs: nested.can.brs,
    arbitrationBitrate: nested.can.arbitrationBitrate,
    dataBitrate: nested.can.dataBitrate,
    isExtendedId: Boolean(raw?.isExtendedId),
    type: nested.type,
    can: nested.can,
  })
}
