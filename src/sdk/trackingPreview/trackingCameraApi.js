/**
 * Phase 3.2B — Camera device manager REST API client.
 */

import { buildTrackingApiBaseUrl } from "./trackingSourceApi.js"

/**
 * @param {string} baseUrl
 */
export async function listCameras(baseUrl) {
  const res = await fetch(`${baseUrl}/api/tracking/cameras`)
  if (!res.ok) {
    throw new Error(`GET /api/tracking/cameras failed: ${res.status}`)
  }
  return res.json()
}

/**
 * @param {string} baseUrl
 * @param {number} [maxIndex]
 */
export async function rescanCameras(baseUrl, maxIndex = 8) {
  const res = await fetch(`${baseUrl}/api/tracking/cameras/rescan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxIndex }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data?.ok === false) {
    throw new Error(String(data?.error || `HTTP ${res.status}`))
  }
  return data
}

/**
 * @param {string} baseUrl
 * @param {string} cameraId
 */
export async function testCamera(baseUrl, cameraId) {
  const res = await fetch(`${baseUrl}/api/tracking/cameras/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cameraId }),
  })
  return res.json().catch(() => ({}))
}

/**
 * @param {string} baseUrl
 * @param {string} cameraId
 */
export async function setPreferredCamera(baseUrl, cameraId) {
  const res = await fetch(`${baseUrl}/api/tracking/cameras/preferred`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cameraId }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data?.ok === false) {
    throw new Error(String(data?.error || `HTTP ${res.status}`))
  }
  return data
}

/**
 * @param {string} wsUrl
 * @param {string} cameraId
 * @param {(req: Record<string, unknown>) => Promise<unknown>} switchSource
 */
export async function switchToCamera(wsUrl, cameraId, switchSource) {
  return switchSource({
    sourceType: "camera",
    cameraId,
  })
}

export { buildTrackingApiBaseUrl }
