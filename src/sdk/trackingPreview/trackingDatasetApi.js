/**
 * Phase 3.1 — Tracking dataset export REST API client.
 */

import { buildTrackingApiBaseUrl } from "./trackingSourceApi.js"
import { DEFAULT_PREVIEW_PORT } from "./trackingPreviewConstants.js"

/**
 * @param {string} [wsUrl]
 * @param {number} [apiPort]
 */
export function buildTrackingDatasetApiBaseUrl(wsUrl, apiPort = DEFAULT_PREVIEW_PORT) {
  return buildTrackingApiBaseUrl(wsUrl, apiPort)
}

async function parseJsonResponse(res) {
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data?.ok === false) {
    throw new Error(String(data?.error || data?.message || `HTTP ${res.status}`))
  }
  return data
}

/**
 * @param {string} baseUrl
 * @param {Record<string, unknown>} request
 */
export async function startTrackingDatasetRecording(baseUrl, request) {
  const res = await fetch(`${baseUrl}/api/tracking/dataset/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  })
  return parseJsonResponse(res)
}

/**
 * @param {string} baseUrl
 * @param {Record<string, unknown>} [body]
 */
export async function stopTrackingDatasetRecording(baseUrl, body = {}) {
  const res = await fetch(`${baseUrl}/api/tracking/dataset/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return parseJsonResponse(res)
}

/**
 * @param {string} baseUrl
 */
export async function fetchTrackingDatasetStatus(baseUrl) {
  const res = await fetch(`${baseUrl}/api/tracking/dataset/status`)
  if (!res.ok) {
    throw new Error(`GET /api/tracking/dataset/status failed: ${res.status}`)
  }
  return res.json()
}

/**
 * @param {string} baseUrl
 */
export async function fetchTrackingDatasetFiles(baseUrl) {
  const res = await fetch(`${baseUrl}/api/tracking/dataset/files`)
  if (!res.ok) {
    throw new Error(`GET /api/tracking/dataset/files failed: ${res.status}`)
  }
  const data = await res.json()
  return Array.isArray(data?.files) ? data.files : []
}

/**
 * @param {string} baseUrl
 * @param {string} sessionId
 * @param {'metadata' | 'frames'} fileKind
 */
export function buildTrackingDatasetDownloadUrl(baseUrl, sessionId, fileKind) {
  const kind = fileKind === "metadata" ? "metadata" : "frames"
  return `${baseUrl}/api/tracking/dataset/download/${encodeURIComponent(sessionId)}/${kind}`
}

/**
 * @param {string} baseUrl
 * @param {object} frame
 */
export async function appendTrackingDatasetFrame(baseUrl, frame) {
  const res = await fetch(`${baseUrl}/api/tracking/dataset/append`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ frame }),
  })
  return parseJsonResponse(res)
}
