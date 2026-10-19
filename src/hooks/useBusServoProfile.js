import { useCallback, useMemo, useState } from "react"
import {
  loadScServoLabProject,
  saveScServoLabProject,
  getLabProfile,
  setLabProfile,
  normalizeLabServoProfile,
  validateServoProfile,
  PROTOCOL,
  defaultServoModelForProtocol,
} from "../sdk/servoAdapters/index.js"
import { normalizeBusProtocol } from "../sdk/servoAdapters/busServo/resolveBusTransport.js"

/**
 * 将 PWM 表条目与本地「当前生效舵机配置文档」桥接（每 busId 一条 Profile）。
 */
export function useBusServoProfile(servoConfigEntry, protocol) {
  const [labProject, setLabProject] = useState(() => loadScServoLabProject())

  const busProtocol = normalizeBusProtocol(protocol)
  const busId = Number.isFinite(Number(servoConfigEntry?.busId))
    ? Number(servoConfigEntry.busId)
    : Number(servoConfigEntry?.servoId ?? 0)

  const profile = useMemo(
    () =>
      normalizeLabServoProfile({
        ...getLabProfile(labProject, busId, busProtocol),
        id: busId,
        label: servoConfigEntry?.name || `舵机 ${busId}`,
        protocol: busProtocol,
      }),
    [labProject, busId, busProtocol, servoConfigEntry?.name]
  )

  const validation = useMemo(() => validateServoProfile(profile), [profile])

  const persistProfileToProject = useCallback((nextProfile) => {
    const normalized = normalizeLabServoProfile({
      ...nextProfile,
      id: busId,
      protocol: busProtocol,
      label: nextProfile.label ?? profile.label,
    })
    let savedProject = null
    setLabProject((prev) => {
      savedProject = saveScServoLabProject(setLabProfile(prev, normalized))
      return savedProject
    })
    return { profile: normalized, project: savedProject }
  }, [busId, busProtocol, profile.label])

  const patchProfile = useCallback(
    (patch) => {
      const isFullProfile =
        patch &&
        typeof patch === "object" &&
        (patch.servoModel != null || patch.centerMode != null) &&
        patch.id != null

      const merged = isFullProfile
        ? { ...patch, id: busId, protocol: busProtocol, label: patch.label ?? profile.label }
        : { ...profile, ...patch, id: busId, protocol: busProtocol, label: patch.label ?? profile.label }

      const { profile: next } = persistProfileToProject(merged)
      return next
    },
    [profile, busId, busProtocol, persistProfileToProject]
  )

  const persistProject = useCallback((project) => {
    const saved = saveScServoLabProject(project)
    setLabProject(saved)
    return saved
  }, [])

  /** @param {object} [explicitProfile] 传入则保存该 profile（避免 React 状态滞后） */
  const saveProfile = useCallback(
    (explicitProfile) => {
      const target = explicitProfile
        ? normalizeLabServoProfile({
            ...explicitProfile,
            id: busId,
            protocol: busProtocol,
            label: explicitProfile.label ?? profile.label,
          })
        : profile

      const v = validateServoProfile(target)
      if (!v.ok) {
        return { ok: false, error: v.errors[0], errors: v.errors, warnings: v.warnings }
      }

      const { profile: saved, project } = persistProfileToProject(target)
      return { ok: true, profile: saved, project, warnings: v.warnings }
    },
    [profile, busId, busProtocol, persistProfileToProject]
  )

  const applyProtocolDefaults = useCallback(
    (nextProtocol) => {
      const p = normalizeBusProtocol(nextProtocol)
      const servoModel = defaultServoModelForProtocol(p)
      return patchProfile({ protocol: p, servoModel })
    },
    [patchProfile]
  )

  return {
    labProject,
    setLabProject,
    persistProject,
    profile,
    patchProfile,
    saveProfile,
    validation,
    busId,
    busProtocol,
    applyProtocolDefaults,
  }
}
