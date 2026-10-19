import { useCallback, useState } from "react"
import {
  createBrowserSourceState,
  markBrowserSourceError,
  markBrowserTrackingStarted,
  markBrowserTrackingStopped,
  selectBrowserCamera,
  selectBrowserIdle,
  isBrowserFrameGenerationValid,
} from "../../tracking/browser/browserSourceRuntime.js"

/**
 * Browser Runtime 专属 Source 状态（权威在前端）。
 */
export function useBrowserSourceRuntime() {
  const [state, setState] = useState(() => createBrowserSourceState())

  const resetToIdle = useCallback(() => {
    setState((prev) => selectBrowserIdle(prev))
  }, [])

  const selectCamera = useCallback(() => {
    setState((prev) => selectBrowserCamera(prev))
  }, [])

  const markStarted = useCallback(() => {
    setState((prev) => markBrowserTrackingStarted(prev))
  }, [])

  const markStopped = useCallback((options) => {
    setState((prev) => markBrowserTrackingStopped(prev, options))
  }, [])

  const markError = useCallback((message) => {
    setState((prev) => markBrowserSourceError(prev, message))
  }, [])

  const isFrameGenerationValid = useCallback(
    (frame) => isBrowserFrameGenerationValid(state.sourceGeneration, frame),
    [state.sourceGeneration]
  )

  return {
    browserSourceState: state,
    resetToIdle,
    selectCamera,
    markStarted,
    markStopped,
    markError,
    isFrameGenerationValid,
    getSourceGeneration: () => state.sourceGeneration,
  }
}
