import { normalizeFaceRigProfile } from "../../core/faceRigProfile.js"

export function getBindings(profile) {
  const p = normalizeFaceRigProfile(profile)
  return p.bindings ?? []
}

export function findBindingById(profile, bindingId) {
  return getBindings(profile).find((b) => b.bindingId === bindingId) ?? null
}

export function selectBindingsForControlChannel(profile, controlId, channel) {
  return getBindings(profile).filter((b) => b.controlId === controlId && b.channel === channel)
}
