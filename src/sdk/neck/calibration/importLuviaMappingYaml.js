/**
 * Optional engineering helper: import Luvia neutral_calibration offsets into a FaceDEV profile.
 * Accepts a small JS object shaped like the YAML `neutral_calibration` section (no YAML dep).
 *
 * FaceDEV product Calibration remains software trim only — this is an engineering import path.
 */

import {
  applyWorkingOffsetsToProfile,
  getOffsetAbsLimitDeg,
  NEUTRAL_INSTALLATION_OFFSET_TOO_LARGE,
} from "./softwareNeutralCalibration.js"
import { normalizeNeckRuntimeProfile } from "../core/neckRuntimeProfile.js"

function num(v, fallback = null) {
  if (v == null || v === "") return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function readSideOffset(section, sideKey) {
  const side = section?.[sideKey] || section?.[sideKey.replace("_", "")] || null
  if (!side || typeof side !== "object") return null
  return num(side.offset_deg ?? side.offsetDeg, null)
}

/**
 * @param {object} jsonLike — e.g. `{ neutral_calibration: { side_1: { offset_deg }, side_2: { offset_deg } } }`
 *   or the `neutral_calibration` object itself.
 * @param {object} [baseProfile]
 * @returns {{ ok: true, profile: object, offsets: {side1:number,side2:number} } | { ok: false, code: string, message: string }}
 */
export function importLuviaNeutralCalibration(jsonLike, baseProfile = null) {
  const root = jsonLike && typeof jsonLike === "object" ? jsonLike : {}
  const section =
    root.neutral_calibration ||
    root.neutralCalibration ||
    (root.side_1 || root.side1 || root.side_2 || root.side2 ? root : null)

  if (!section || typeof section !== "object") {
    return {
      ok: false,
      code: "NEUTRAL_CALIBRATION_MISSING",
      message: "neutral_calibration section not found",
    }
  }

  const side1 = readSideOffset(section, "side_1") ?? readSideOffset(section, "side1")
  const side2 = readSideOffset(section, "side_2") ?? readSideOffset(section, "side2")
  if (side1 == null || side2 == null) {
    return {
      ok: false,
      code: "NEUTRAL_OFFSETS_INCOMPLETE",
      message: "side_1/side_2 offset_deg required",
    }
  }

  const base = normalizeNeckRuntimeProfile(baseProfile || {})
  const limit = getOffsetAbsLimitDeg(base)
  if (Math.abs(side1) > limit + 1e-12 || Math.abs(side2) > limit + 1e-12) {
    return {
      ok: false,
      code: NEUTRAL_INSTALLATION_OFFSET_TOO_LARGE,
      message: `imported offsets exceed ±${limit}°`,
    }
  }

  const profile = applyWorkingOffsetsToProfile(base, { side1, side2 })
  return {
    ok: true,
    profile,
    offsets: { side1, side2 },
  }
}
