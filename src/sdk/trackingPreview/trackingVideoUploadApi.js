/**
 * Phase 3.2 — Uploaded video REST API client.
 */

import { buildTrackingApiBaseUrl } from "./trackingSourceApi.js"
import { DEFAULT_PREVIEW_PORT } from "./trackingPreviewConstants.js"

/**
 * @param {string} [wsUrl]
 * @param {number} [apiPort]
 */
export function buildTrackingUploadApiBaseUrl(wsUrl, apiPort = DEFAULT_PREVIEW_PORT) {
  return buildTrackingApiBaseUrl(wsUrl, apiPort)
}

/**
 * @param {string} baseUrl
 */
export async function listUploadedVideos(baseUrl) {
  const res = await fetch(`${baseUrl}/api/tracking/videos/uploads`)
  if (!res.ok) {
    throw new Error(`GET /api/tracking/videos/uploads failed: ${res.status}`)
  }
  const data = await res.json()
  return Array.isArray(data?.videos) ? data.videos : []
}

/**
 * @param {string} baseUrl
 * @param {File} file
 * @param {(pct: number) => void} [onProgress]
 */
export function uploadVideo(baseUrl, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("POST", `${baseUrl}/api/tracking/videos/upload`)
    xhr.upload.onprogress = (evt) => {
      if (evt.lengthComputable && typeof onProgress === "function") {
        onProgress(Math.round((evt.loaded / evt.total) * 100))
      }
    }
    xhr.onload = () => {
      let data = {}
      try {
        data = JSON.parse(xhr.responseText || "{}")
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300 && data?.ok !== false) {
        resolve(data)
        return
      }
      reject(new Error(String(data?.error || `HTTP ${xhr.status}`)))
    }
    xhr.onerror = () => reject(new Error("upload-network-error"))
    const form = new FormData()
    form.append("file", file, file.name)
    xhr.send(form)
  })
}

/**
 * @param {string} baseUrl
 * @param {string} uploadedVideoId
 */
export async function deleteUploadedVideo(baseUrl, uploadedVideoId) {
  const res = await fetch(
    `${baseUrl}/api/tracking/videos/uploads/${encodeURIComponent(uploadedVideoId)}`,
    { method: "DELETE" }
  )
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data?.ok === false) {
    throw new Error(String(data?.error || `HTTP ${res.status}`))
  }
  return data
}

/**
 * @param {string} baseUrl
 * @param {string} uploadedVideoId
 * @param {Record<string, unknown>} [options]
 */
export async function switchToUploadedVideo(baseUrl, uploadedVideoId, options = {}) {
  const res = await fetch(`${baseUrl}/api/tracking/source`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceType: "uploaded-video",
      uploadedVideoId,
      videoStartMs: options.videoStartMs ?? 0,
      playbackRate: options.playbackRate ?? 1,
      deterministic: options.deterministic ?? true,
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data?.ok === false) {
    throw new Error(String(data?.error || `HTTP ${res.status}`))
  }
  return data
}
