/**
 * frameProject Optional Neck module state (product-level).
 * Independent of CharacterPose.neck data — does not delete keyframe neck.
 */

/**
 * New projects: Face-only by default.
 * @returns {{ neck: { enabled: boolean, locked: boolean } }}
 */
export function createDefaultProjectModules() {
  return {
    neck: {
      enabled: false,
      locked: false,
    },
  }
}

/**
 * Normalize modules.neck.
 *
 * Migration rule (R4.2+ UI product):
 * - Missing `modules` / `modules.neck` entirely → enabled=true (preserve existing Neck projects)
 * - Missing only `enabled` field on an existing neck object → enabled=true
 * - New projects use createDefaultProjectModules() → enabled=false
 *
 * @param {unknown} modules
 * @returns {{ neck: { enabled: boolean, locked: boolean } }}
 */
export function normalizeProjectModules(modules) {
  if (!modules || typeof modules !== "object") {
    return {
      neck: { enabled: true, locked: false },
    }
  }
  const neck = modules.neck
  if (!neck || typeof neck !== "object") {
    return {
      neck: { enabled: true, locked: false },
    }
  }
  const enabled = Object.prototype.hasOwnProperty.call(neck, "enabled")
    ? Boolean(neck.enabled)
    : true
  const locked = Boolean(neck.locked)
  return {
    neck: { enabled, locked },
  }
}

/**
 * @param {object|null|undefined} project
 * @returns {{ enabled: boolean, locked: boolean }}
 */
export function getProjectNeckModule(project) {
  return normalizeProjectModules(project?.modules).neck
}

/**
 * @param {object} project
 * @param {{ enabled?: boolean, locked?: boolean }} patch
 * @returns {object}
 */
export function patchProjectNeckModule(project, patch = {}) {
  const current = normalizeProjectModules(project?.modules)
  const nextNeck = {
    enabled:
      patch.enabled !== undefined ? Boolean(patch.enabled) : current.neck.enabled,
    locked: patch.locked !== undefined ? Boolean(patch.locked) : current.neck.locked,
  }
  return {
    ...project,
    modules: {
      ...(project?.modules && typeof project.modules === "object" ? project.modules : {}),
      neck: nextNeck,
    },
  }
}

/**
 * Can the user edit Neck semantic pose (pad/yaw/neutral)?
 */
export function canEditNeckPose(project) {
  const m = getProjectNeckModule(project)
  return Boolean(m.enabled && !m.locked)
}

/**
 * Module-level: may this project participate in Neck hardware at all?
 * (Timeline/manual still need runtime gates via canDispatchNeckPhysical.)
 */
export function canDispatchNeckHardware(project) {
  return Boolean(getProjectNeckModule(project).enabled)
}

/**
 * Single physical dispatch gate — derived from Runtime + module truth.
 * Character semantic edit is independent; only physical TX uses this.
 *
 * @param {{
 *   project?: object|null,
 *   moduleEnabled?: boolean,
 *   transportReady?: boolean,
 *   motorsEnabled?: boolean,
 *   estop?: boolean,
 *   calibrating?: boolean,
 *   hardwarePreview?: boolean,
 *   source?: string,
 * }} opts
 */
export function canDispatchNeckPhysical(opts = {}) {
  const moduleEnabled =
    opts.moduleEnabled !== undefined
      ? Boolean(opts.moduleEnabled)
      : canDispatchNeckHardware(opts.project)
  if (!moduleEnabled) return false
  if (!opts.transportReady) return false
  if (opts.estop) return false
  if (opts.calibrating) return false
  if (!opts.motorsEnabled) return false
  // Manual editor path requires Hardware Preview (Bridge-aligned)
  if ((opts.source || "editor") === "editor" && !opts.hardwarePreview) return false
  return true
}

/**
 * Should Full Character Key write current Neck pose?
 * - disabled → Face only (preserve existing neck on key)
 * - locked → Face only (preserve existing neck on key)
 * - enabled unlocked → Face + Neck
 */
export function shouldWriteNeckOnFullCharacterKey(project) {
  return canEditNeckPose(project)
}
