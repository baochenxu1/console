/**
 * Canonical MotorCommand — semantic motor intent before any protocol adapter.
 * Must NOT contain CAN arbitration IDs, payload bytes, or SLCAN lines.
 */

export class MotorCommandError extends Error {
  constructor(message, code = "MOTOR_COMMAND_ERROR") {
    super(message)
    this.name = "MotorCommandError"
    this.code = code
  }
}

/**
 * @typedef {{
 *   logicalMotorId: number,
 *   positionRaw: number,
 *   positionDeg?: number|null,
 * }} MotorCommandSlot
 *
 * @typedef {{
 *   mode: 'POSITION',
 *   motors: MotorCommandSlot[],
 * }} MotorCommand
 */

/**
 * @param {{ mode?: string, motors?: MotorCommandSlot[] }} [input]
 * @returns {MotorCommand}
 */
export function createMotorCommand({ mode = "POSITION", motors = [] } = {}) {
  if (mode !== "POSITION") {
    throw new MotorCommandError(
      `R2.1 only supports mode=POSITION (got ${mode})`,
      "UNSUPPORTED_MODE"
    )
  }
  const list = Array.isArray(motors) ? motors : []
  const normalized = list.map((m) => {
    if (!m || typeof m !== "object") {
      throw new MotorCommandError("invalid motor slot", "INVALID_SLOT")
    }
    if ("arbitrationId" in m || "payload" in m || "slcanLine" in m || "data" in m) {
      throw new MotorCommandError(
        "MotorCommand must not include CAN/SLCAN fields",
        "PROTOCOL_LEAK"
      )
    }
    const logicalMotorId = Math.trunc(Number(m.logicalMotorId))
    if (!Number.isFinite(logicalMotorId) || logicalMotorId < 1) {
      throw new MotorCommandError(
        `invalid logicalMotorId: ${m.logicalMotorId}`,
        "INVALID_MOTOR_ID"
      )
    }
    const positionRaw = Math.trunc(Number(m.positionRaw) || 0)
    const positionDeg =
      m.positionDeg == null || m.positionDeg === undefined
        ? undefined
        : Number(m.positionDeg)
    return {
      logicalMotorId,
      positionRaw,
      ...(positionDeg !== undefined && Number.isFinite(positionDeg)
        ? { positionDeg }
        : {}),
    }
  })
  return Object.freeze({
    mode: "POSITION",
    motors: Object.freeze(normalized.map((s) => Object.freeze(s))),
  })
}

/**
 * Build MotorCommand from R1 planNeckPose motorTargets.
 * @param {{ raw?: object, commandDeg?: object, command?: object }|null|undefined} motorTargets
 * @returns {MotorCommand}
 */
export function createMotorCommandFromMotorTargets(motorTargets) {
  const raw = motorTargets?.raw || {}
  const deg = motorTargets?.commandDeg || motorTargets?.command || {}
  const motors = [
    {
      logicalMotorId: 1,
      positionRaw: Number(raw.id1) || 0,
      positionDeg: deg.id1 != null ? Number(deg.id1) : undefined,
    },
    {
      logicalMotorId: 2,
      positionRaw: Number(raw.id2) || 0,
      positionDeg: deg.id2 != null ? Number(deg.id2) : undefined,
    },
    {
      logicalMotorId: 3,
      positionRaw: Number(raw.id3) || 0,
      positionDeg: deg.id3 != null ? Number(deg.id3) : undefined,
    },
    {
      logicalMotorId: 4,
      positionRaw: Number(raw.id4) || 0,
      positionDeg: deg.id4 != null ? Number(deg.id4) : undefined,
    },
  ]
  return createMotorCommand({ mode: "POSITION", motors })
}

/**
 * @param {unknown} cmd
 * @returns {MotorCommand}
 */
export function assertMotorCommand(cmd) {
  if (!cmd || typeof cmd !== "object") {
    throw new MotorCommandError("missing MotorCommand", "INVALID_COMMAND")
  }
  if (cmd.mode !== "POSITION") {
    throw new MotorCommandError(
      `expected mode=POSITION, got ${cmd.mode}`,
      "UNSUPPORTED_MODE"
    )
  }
  if (!Array.isArray(cmd.motors)) {
    throw new MotorCommandError("motors must be an array", "INVALID_COMMAND")
  }
  if (
    "arbitrationId" in cmd ||
    "slcanLine" in cmd ||
    "canFrame" in cmd ||
    "payload" in cmd
  ) {
    throw new MotorCommandError(
      "MotorCommand must not include CAN/SLCAN fields",
      "PROTOCOL_LEAK"
    )
  }
  return /** @type {MotorCommand} */ (cmd)
}
