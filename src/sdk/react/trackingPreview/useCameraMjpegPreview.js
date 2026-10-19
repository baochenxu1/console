import { useEffect, useMemo, useState } from "react"
import {
  buildCameraPreviewMjpegUrl,
  DEFAULT_WS_CAMERA,
} from "../../trackingPreview/trackingPreviewConstants.js"

/**
 * Phase 4.1-C：由 WS 地址推导 MJPEG URL；后端未实现时 onError 回退占位。
 * @param {object} params
 * @param {boolean} [params.previewActive] 为 true 时拉取 MJPEG（可与 tracking 解耦，便于 Camera 预热）
 * @param {boolean} [params.trackingEnabled] 兼容旧调用，等同 previewActive
 * @param {string} [params.wsUrl]
 */
export function useCameraMjpegPreview({
  previewActive,
  trackingEnabled = false,
  wsUrl = DEFAULT_WS_CAMERA,
}) {
  const active = Boolean(previewActive ?? trackingEnabled)
  const previewUrl = useMemo(() => buildCameraPreviewMjpegUrl(wsUrl), [wsUrl])
  const [streamKey, setStreamKey] = useState(0)
  const [streamFailed, setStreamFailed] = useState(false)
  const [streamLoaded, setStreamLoaded] = useState(false)

  useEffect(() => {
    if (!active) {
      setStreamFailed(false)
      setStreamLoaded(false)
      return
    }
    setStreamFailed(false)
    setStreamLoaded(false)
    setStreamKey((k) => k + 1)
  }, [active, previewUrl])

  const showStream = active && !streamFailed
  const streamSrc = showStream ? `${previewUrl}?t=${streamKey}` : ""

  return {
    previewUrl,
    showStream,
    streamSrc,
    streamLoaded: active && streamLoaded && !streamFailed,
    streamFailed: active && streamFailed,
    onStreamError: () => {
      setStreamFailed(true)
      setStreamLoaded(false)
    },
    onStreamLoad: () => {
      setStreamFailed(false)
      setStreamLoaded(true)
    },
  }
}
