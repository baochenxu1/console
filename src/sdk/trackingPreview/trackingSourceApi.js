/**
 * Phase 3.0 — Tracking source control REST API client.
 */

import { DEFAULT_PREVIEW_PORT } from "./trackingPreviewConstants.js"

/**
 * @param {string} [wsUrl]
 * @param {number} [apiPort]
 */
export function buildTrackingApiBaseUrl(wsUrl, apiPort = DEFAULT_PREVIEW_PORT) {
  try {
    const u = new URL(wsUrl || "ws://127.0.0.1:8766/tracking")
    const host = u.hostname || "127.0.0.1"
    return `http://${host}:${apiPort}`
  } catch {
    return `http://127.0.0.1:${apiPort}`
  }
}

/**
 * @param {string} baseUrl
 */
export async function fetchTrackingSourceState(baseUrl) {
  const res = await fetch(`${baseUrl}/api/tracking/source`)
  if (!res.ok) {
    throw new Error(`GET /api/tracking/source failed: ${res.status}`)
  }
  return res.json()
}

/**
 * @param {string} baseUrl
 */
export async function fetchDefaultVideos(baseUrl) {
  const res = await fetch(`${baseUrl}/api/tracking/videos`)
  if (!res.ok) {
    throw new Error(`GET /api/tracking/videos failed: ${res.status}`)
  }
  const data = await res.json()
  return Array.isArray(data?.videos) ? data.videos : []
}

/**
 * @param {string} baseUrl
 * @param {number} videoTimeMs
 */
export async function postVideoSeek(baseUrl, videoTimeMs) {
  const res = await fetch(`${baseUrl}/api/tracking/video/seek`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoTimeMs: Number(videoTimeMs) || 0 }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data?.ok === false) {
    throw new Error(String(data?.error || data?.message || `HTTP ${res.status}`))
  }
  return data
}

/**
 * @param {string} baseUrl
 * @param {boolean} paused
 */
export async function postVideoPause(baseUrl, paused) {
  const res = await fetch(`${baseUrl}/api/tracking/video/pause`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paused: Boolean(paused) }),
  })
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
export async function postTrackingSourceSwitch(baseUrl, request) {
  const res = await fetch(`${baseUrl}/api/tracking/source`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data?.ok === false) {
    throw new Error(String(data?.error || data?.message || `HTTP ${res.status}`))
  }
  return data
}

/** @typedef {'idle' | 'camera' | 'video' | 'uploaded-video'} TrackingSourceType */

/**
 * @typedef {Object} TrackingSourceRequest
 * @property {TrackingSourceType} sourceType
 * @property {number} [cameraIndex]
 * @property {string} [cameraId]
 * @property {string} [sourceId]
 * @property {string} [videoPath]
 * @property {string} [uploadedVideoId]
 * @property {number} [videoStartMs]
 * @property {number} [playbackRate]
 * @property {boolean} [deterministic]
 */

/**
 * @typedef {Object} TrackingSourceState
 * @property {TrackingSourceType} sourceType
 * @property {string | null} sourceId
 * @property {number} sourceEpoch
 * @property {string} status
 * @property {boolean} previewOnlyForced
 * @property {boolean} [videoSourceTuningEnabled]
 * @property {boolean} [videoDeviceDryRunEnabled]
 * @property {string} [message]
 * @property {number} [videoStartMs]
 * @property {number} [videoDurationMs]
 * @property {boolean} [videoPaused]
 * @property {number} [playbackRate]
 * @property {boolean} [switching]
 * @property {string | null} [switchTarget]
 * @property {string | null} [error]
 */
