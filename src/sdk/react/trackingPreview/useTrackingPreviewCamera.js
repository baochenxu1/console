import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createInitialEliteRig } from "../../../core/faceDofMapper.js"
import { loadFaceRigProfile, normalizeFaceRigProfile, FACE_RIG_STORAGE_KEY, FACE_RIG_PROFILE_CHANGED_EVENT } from "../../../core/faceRigProfile.js"
import {
  applyBrowGateBypass,
  applyTrackingCalibration,
  buildBrowDebugFromFrame,
  createDefaultTrackingCalibration,
  isIrisOnlyGaze,
  resetTrackingEyeReleaseState,
} from "../../tracking/index.js"
import { buildTrackingDryRunResult } from "../../trackingPreview/buildTrackingDryRunResult.js"
import { createTrackingBusPipelineState } from "../../output/trackingBusPipelineState.js"
import {
  createNeutralTrackingStatus,
  EMPTY_DRY_RUN_RESULT,
  resetTrackingPreviewToNeutral,
} from "../../trackingPreview/trackingPreviewNeutral.js"
import {
  DRIVE_MODES,
  DEFAULT_WS_CAMERA,
  TRACKING_PREVIEW_TABS,
  OUTPUT_MODES,
} from "../../trackingPreview/trackingPreviewConstants.js"
import {
  ROI_TRACKING_OFF,
  resolveRoiTrackingControl,
} from "../../trackingPreview/videoRoiTrackingConstants.js"
import {
  TRACKING_BACKEND_BROWSER,
  resolveTrackingBackend,
} from "../../tracking/browser/index.js"
import { useTrackingAdapterController } from "../useTrackingAdapterController.js"
import { useVideoNeutralCalibration } from "./useVideoNeutralCalibration.js"
import {
  buildVideoNeutralFrameDiagnostic,
  buildRawTrackingSignals,
} from "../../tracking/videoNeutralCalibration.js"
import { resolveTrackingSourceContext } from "../../tracking/input/trackingSourceContext.js"
import {
  buildVideoSourceTuningShadow,
  DEFAULT_VIDEO_SOURCE_TUNING,
} from "../../tracking/videoSourceTuning.js"
import { RIGHT_MOUTH_BASELINE_CHANGED_EVENT } from "../../kinematics/rightMouthFiveBarRuntime.js"
import { LEFT_MOUTH_BASELINE_CHANGED_EVENT } from "../../kinematics/leftMouthFiveBarRuntime.js"

/**
 * Phase 4.1-C：Camera WebSocket + Stop 回中 + 画面预览框架。
 */
export function useTrackingPreviewCamera({
  configs = [],
  activeTab,
  driveMode,
  outputMode = OUTPUT_MODES.BUS_SERVO,
  bypassBrowGate = false,
  bypassEyeRelease = false,
  videoSourceTuningEnabled = true,
}) {
  const ctrl = useTrackingAdapterController({ defaultWsUrl: DEFAULT_WS_CAMERA })
  const {
    trackingEnabled,
    setTrackingEnabled,
    wsUrlDraft,
    setWsUrlDraft,
    lastFrame,
    status,
    replaceWithWebSocket,
    clearLastFrame,
    sendTrackingControl,
    connectedUrl,
    setFrameValidator,
    setOnSourceChanged,
    trackingBackend,
    switchTrackingBackend,
    browserMetrics,
    bindBrowserVideoElement,
    startBrowserCamera,
  } = ctrl
  const isBrowserBackend = trackingBackend === TRACKING_BACKEND_BROWSER || resolveTrackingBackend({ backend: trackingBackend }) === TRACKING_BACKEND_BROWSER
  const stopBrowserCamera = ctrl.stopBrowserCamera

  const calibrationRef = useRef(createDefaultTrackingCalibration())
  const prevCalibratedRef = useRef(/** @type {import("../../tracking/trackingTypes.js").RigFrame | null} */ (null))
  const autoLipNeutralSentRef = useRef(false)
  const autoIrisArmSentRef = useRef(false)
  const videoReplaySentRef = useRef(false)
  const videoRoiSentRef = useRef(false)
  const [roiTrackingOption, setRoiTrackingOption] = useState(ROI_TRACKING_OFF)
  const [videoDiagnosticStartMs, setVideoDiagnosticStartMs] = useState(3000)
  /** dry-run 专用 pipeline 状态：避免与诊断单例 / device state 交叉 commit 污染 prev target */
  const dryRunPipelineRef = useRef(/** @type {{ safetyState: object } | null} */ (null))
  const [profileEpoch, setProfileEpoch] = useState(0)

  const reloadProfile = useCallback(() => {
    setProfileEpoch((epoch) => epoch + 1)
  }, [])

  const profile = useMemo(
    () => normalizeFaceRigProfile(loadFaceRigProfile()),
    [profileEpoch]
  )

  useEffect(() => {
    const bump = () => reloadProfile()
    const onStorage = (event) => {
      if (event.key === FACE_RIG_STORAGE_KEY || event.key == null) {
        bump()
      }
    }
    window.addEventListener("storage", onStorage)
    window.addEventListener(RIGHT_MOUTH_BASELINE_CHANGED_EVENT, bump)
    window.addEventListener(LEFT_MOUTH_BASELINE_CHANGED_EVENT, bump)
    window.addEventListener(FACE_RIG_PROFILE_CHANGED_EVENT, bump)
    return () => {
      window.removeEventListener("storage", onStorage)
      window.removeEventListener(RIGHT_MOUTH_BASELINE_CHANGED_EVENT, bump)
      window.removeEventListener(LEFT_MOUTH_BASELINE_CHANGED_EVENT, bump)
      window.removeEventListener(FACE_RIG_PROFILE_CHANGED_EVENT, bump)
    }
  }, [reloadProfile])
  const isCameraTab = activeTab === TRACKING_PREVIEW_TABS.CAMERA
  const isVideoTab =
    activeTab === TRACKING_PREVIEW_TABS.VIDEO || activeTab === TRACKING_PREVIEW_TABS.UPLOAD
  const previewSourceActive = isCameraTab || isVideoTab
  const trackingLive = Boolean(previewSourceActive && trackingEnabled)

  const inputSourceType = lastFrame?.debug?.inputSource?.sourceType ?? null
  const isVideoInputActive = inputSourceType === "video"
  const videoPlaybackEnded = Boolean(lastFrame?.debug?.videoPlayback?.ended)

  useEffect(() => {
    calibrationRef.current.eye = {
      ...calibrationRef.current.eye,
      releaseEnabled: !bypassEyeRelease,
      openRecoveryEnabled: !bypassEyeRelease,
    }
  }, [bypassEyeRelease])

  const videoNeutral = useVideoNeutralCalibration({
    calibrationRef,
    prevCalibratedRef,
    isVideoTab,
  })

  useEffect(() => {
    if (!isVideoTab || !videoNeutral.snapshot || !lastFrame) {
      return
    }
    const src = lastFrame?.debug?.inputSource
    if (src?.sourceType !== "video") {
      return
    }
    if (String(src.sourceId ?? "") !== String(videoNeutral.snapshot.sourceId ?? "")) {
      videoNeutral.setEnabled(false)
    }
  }, [isVideoTab, lastFrame, videoNeutral.snapshot, videoNeutral.setEnabled])

  const videoNeutralSourceMismatch = useMemo(() => {
    if (!videoNeutral.snapshot || !lastFrame) {
      return false
    }
    const src = lastFrame?.debug?.inputSource
    if (src?.sourceType !== "video") {
      return false
    }
    return String(src.sourceId ?? "") !== String(videoNeutral.snapshot.sourceId ?? "")
  }, [videoNeutral.snapshot, lastFrame])

  const neutralApplyResult = useMemo(() => {
    if (!trackingLive || !lastFrame || typeof lastFrame !== "object") {
      return null
    }
    return videoNeutral.applyNeutralToFrame(lastFrame)
  }, [trackingLive, lastFrame, videoNeutral.applyNeutralToFrame, videoNeutral.snapshot, videoNeutral.enabled])

  const frameForCalibration = useMemo(() => {
    if (!trackingLive || !lastFrame || typeof lastFrame !== "object") {
      return null
    }
    let f = neutralApplyResult?.frame ?? lastFrame
    if (!bypassBrowGate) {
      return f
    }
    const rig = applyBrowGateBypass(f.rig, f)
    return { ...f, rig }
  }, [trackingLive, lastFrame, neutralApplyResult, bypassBrowGate])

  const calibratedFrame = useMemo(() => {
    if (!frameForCalibration || typeof frameForCalibration !== "object") {
      return null
    }
    const prev = prevCalibratedRef.current
    const calib = calibrationRef.current
    try {
      return applyTrackingCalibration(frameForCalibration, prev, calib)
    } catch {
      return frameForCalibration
    }
  }, [frameForCalibration])

  useEffect(() => {
    if (calibratedFrame) {
      prevCalibratedRef.current = calibratedFrame
    }
  }, [calibratedFrame])

  const videoTuningBundle = useMemo(() => {
    if (!trackingLive || !calibratedFrame || !lastFrame) {
      return null
    }
    const sourceContext = resolveTrackingSourceContext(lastFrame, {}, { isVideoTab })
    if (!sourceContext.isVideoSource) {
      return null
    }
    return buildVideoSourceTuningShadow({
      calibratedFrame,
      sourceFrame: lastFrame,
      tuning: DEFAULT_VIDEO_SOURCE_TUNING,
      previewUsesTuned: videoSourceTuningEnabled,
    })
  }, [trackingLive, calibratedFrame, lastFrame, isVideoTab, videoSourceTuningEnabled])

  const videoSourceTuningResult = useMemo(() => {
    if (!videoTuningBundle) {
      return null
    }
    if (!videoSourceTuningEnabled) {
      return {
        rig: videoTuningBundle.untunedRig,
        applied: false,
        diagnostic: videoTuningBundle.tunedResult?.diagnostic
          ? { ...videoTuningBundle.tunedResult.diagnostic, applied: false }
          : { enabled: false, applied: false, sourceType: "video" },
        jawTrace: videoTuningBundle.tunedResult?.jawTrace ?? null,
      }
    }
    return {
      rig: videoTuningBundle.tunedRig,
      applied: true,
      diagnostic: videoTuningBundle.tunedResult?.diagnostic ?? null,
      jawTrace: videoTuningBundle.tunedResult?.jawTrace ?? null,
    }
  }, [videoTuningBundle, videoSourceTuningEnabled])

  const previewRig = useMemo(() => {
    if (!trackingLive) {
      return createInitialEliteRig()
    }
    if (videoTuningBundle) {
      return videoSourceTuningEnabled
        ? videoTuningBundle.tunedRig
        : videoTuningBundle.untunedRig
    }
    const rigBase =
      calibratedFrame?.rig && typeof calibratedFrame.rig === "object"
        ? calibratedFrame.rig
        : lastFrame?.rig && typeof lastFrame.rig === "object"
          ? lastFrame.rig
          : createInitialEliteRig()
    const serverRig = lastFrame?.rig
    if (
      isIrisOnlyGaze(lastFrame?.debug?.gaze) &&
      serverRig?.sharedRadar &&
      typeof serverRig.sharedRadar === "object"
    ) {
      const x = Number(serverRig.sharedRadar.x) || 50
      const y = Number(serverRig.sharedRadar.y) || 50
      return {
        ...rigBase,
        sharedRadar: { x, y },
        eyeL: { ...rigBase.eyeL, x, y },
        eyeR: { ...rigBase.eyeR, x, y },
      }
    }
    return rigBase
  }, [trackingLive, videoTuningBundle, videoSourceTuningEnabled, calibratedFrame, lastFrame])

  const mapping = useMemo(() => {
    if (!trackingLive) {
      return null
    }
    return lastFrame?.debug?.mapping ?? null
  }, [trackingLive, lastFrame])

  const lipGeometry = useMemo(() => {
    if (!trackingLive) {
      return null
    }
    return lastFrame?.debug?.lipGeometry ?? null
  }, [trackingLive, lastFrame])

  const jawGeometry = useMemo(() => {
    if (!trackingLive) {
      return null
    }
    return lastFrame?.debug?.jawGeometry ?? null
  }, [trackingLive, lastFrame])

  const mouthScenarioClassifier = useMemo(() => {
    if (!trackingLive) {
      return null
    }
    return lastFrame?.debug?.mouthScenarioClassifier ?? null
  }, [trackingLive, lastFrame])

  const browGate = useMemo(() => {
    if (!trackingLive) {
      return null
    }
    return lastFrame?.debug?.browGate ?? null
  }, [trackingLive, lastFrame])

  const browDebug = useMemo(() => {
    if (!trackingLive || !lastFrame) {
      return null
    }
    return buildBrowDebugFromFrame(lastFrame, calibratedFrame?.rig ?? null)
  }, [trackingLive, lastFrame, calibratedFrame])

  const dryRunResult = useMemo(() => {
    if (!trackingLive || driveMode !== DRIVE_MODES.DRY_RUN) {
      dryRunPipelineRef.current = null
      return { ...EMPTY_DRY_RUN_RESULT }
    }
    if (!dryRunPipelineRef.current) {
      dryRunPipelineRef.current = createTrackingBusPipelineState({
        ownerId: isVideoTab ? "video-dry-run" : "camera-dry-run",
        consumerType: isVideoTab ? "preview-video" : "preview-camera",
      })
    }
    const lf = lastFrame
    const eyeDbg = calibratedFrame?.debug?.eyeTrack?.eyeReleaseDebug
    const srcTs =
      lf?.debug?.inputSource?.timestampMs ?? lf?.debug?.inputSource?.videoTimeMs ?? lf?.timestampMs ?? null
    return buildTrackingDryRunResult({
      profile,
      rig: previewRig,
      configs,
      outputMode,
      busPipelineState: dryRunPipelineRef.current,
      sourceFrameIndex: lf?.debug?.inputSource?.sourceSeq ?? lf?.frameSeq ?? null,
      sourceTimestampMs: srcTs,
      eyeReleasing: Boolean(eyeDbg?.leftReleasing || eyeDbg?.rightReleasing),
    })
  }, [trackingLive, driveMode, profile, previewRig, configs, outputMode, lastFrame, calibratedFrame, isVideoTab])

  const trackingStatus = useMemo(() => {
    const st = status
    if (!trackingLive) {
      return {
        ...createNeutralTrackingStatus(),
        lifecycle: st.lifecycle != null ? String(st.lifecycle) : null,
        trackingBackend: trackingBackend,
        error: st.error != null ? String(st.error) : "",
        modelErrorCode: st.modelErrorCode != null ? String(st.modelErrorCode) : null,
        modelErrorName: st.modelErrorName != null ? String(st.modelErrorName) : null,
        modelErrorMessage: st.modelErrorMessage != null ? String(st.modelErrorMessage) : null,
        modelErrorStack: st.modelErrorStack != null ? String(st.modelErrorStack) : null,
      }
    }
    const srcLabel = isBrowserBackend
      ? "mediapipe-web"
      : isVideoInputActive
        ? "video-mediapipe"
        : st.source || "camera-mediapipe"
    return {
      source: srcLabel,
      previewOnly: isVideoInputActive,
      videoEnded: videoPlaybackEnded,
      videoPaused: Boolean(
        lastFrame?.debug?.inputSource?.paused ?? lastFrame?.inputSource?.paused
      ),
      inputSourceType: inputSourceType || (isVideoTab ? "video" : "camera"),
      running: Boolean(st.wsOpen || st.running),
      faceDetected: Boolean(st.faceDetected),
      quality: Number.isFinite(Number(st.quality)) ? Number(st.quality) : 0,
      fps: Number.isFinite(Number(st.fps)) ? Number(st.fps) : 0,
      pythonFps: st.pythonFps != null && Number.isFinite(Number(st.pythonFps)) ? Number(st.pythonFps) : null,
      rxFps: Number.isFinite(Number(st.rxFps)) ? Number(st.rxFps) : 0,
      rx: Number.isFinite(Number(st.receivedFrameCount)) ? Number(st.receivedFrameCount) : 0,
      error: st.error != null ? String(st.error) : "",
      modelErrorCode: st.modelErrorCode != null ? String(st.modelErrorCode) : null,
      modelErrorName: st.modelErrorName != null ? String(st.modelErrorName) : null,
      modelErrorMessage: st.modelErrorMessage != null ? String(st.modelErrorMessage) : null,
      modelErrorStack: st.modelErrorStack != null ? String(st.modelErrorStack) : null,
      lastAt: Number.isFinite(Number(st.lastFrameAt)) && st.lastFrameAt > 0 ? st.lastFrameAt : null,
      wsConnecting: Boolean(st.wsConnecting),
      wsOpen: Boolean(st.wsOpen),
      lifecycle: st.lifecycle != null ? String(st.lifecycle) : null,
      trackingBackend: st.trackingBackend != null ? String(st.trackingBackend) : trackingBackend,
    }
  }, [trackingLive, status, isVideoInputActive, isVideoTab, inputSourceType, videoPlaybackEnded, lastFrame, trackingBackend, isBrowserBackend])

  const resetPreviewToNeutral = useCallback(() => {
    return resetTrackingPreviewToNeutral({
      clearLastFrame,
      prevCalibratedRef,
    })
  }, [clearLastFrame])

  const prepareVideoDiagnostic = useCallback(
    (videoStartMs = videoDiagnosticStartMs) => {
      const ms = Math.max(0, Number(videoStartMs) || 0)
      sendTrackingControl({
        action: "prepareVideoDiagnostic",
        videoStartMs: ms,
        reason: "diagnostic-align",
      })
      return ms
    },
    [sendTrackingControl, videoDiagnosticStartMs]
  )

  const requestLipNeutral = useCallback(() => {
    sendTrackingControl({ action: "resetLipNeutral", reason: "manual" })
  }, [sendTrackingControl])

  const sendRoiTrackingControl = useCallback(
    (optionId = roiTrackingOption) => {
      sendTrackingControl({
        ...resolveRoiTrackingControl(optionId),
        reason: "ui",
      })
    },
    [sendTrackingControl, roiTrackingOption]
  )

  const setRoiTrackingOptionAndSend = useCallback(
    (optionId) => {
      setRoiTrackingOption(optionId)
      if (isVideoTab && status?.wsOpen) {
        sendRoiTrackingControl(optionId)
      }
    },
    [isVideoTab, status?.wsOpen, sendRoiTrackingControl]
  )

  useEffect(() => {
    if (!trackingLive || !isCameraTab) {
      if (!trackingLive) {
        autoLipNeutralSentRef.current = false
        autoIrisArmSentRef.current = false
      }
      return
    }
    if (!status?.wsOpen) {
      return
    }
    if (autoLipNeutralSentRef.current) {
      return
    }
    autoLipNeutralSentRef.current = true
    sendTrackingControl({
      action: "autoLipNeutralOnStart",
      reason: "startCameraTracking",
    })
  }, [trackingLive, isCameraTab, status?.wsOpen, sendTrackingControl])

  useEffect(() => {
    if (!trackingLive || !isCameraTab) {
      return
    }
    if (!status?.wsOpen) {
      return
    }
    if (autoIrisArmSentRef.current) {
      return
    }
    autoIrisArmSentRef.current = true
    sendTrackingControl({
      action: "resetIrisGaze",
      reason: "startCameraTracking",
      armed: true,
    })
  }, [trackingLive, isCameraTab, status?.wsOpen, sendTrackingControl])

  useEffect(() => {
    if (!trackingLive || !isVideoTab) {
      if (!trackingLive) {
        videoReplaySentRef.current = false
        videoRoiSentRef.current = false
      }
      return
    }
    if (!status?.wsOpen) {
      return
    }
    if (videoReplaySentRef.current) {
      if (!videoRoiSentRef.current) {
        videoRoiSentRef.current = true
        sendRoiTrackingControl(roiTrackingOption)
      }
      return
    }
    videoReplaySentRef.current = true
    sendRoiTrackingControl(roiTrackingOption)
  }, [
    trackingLive,
    isVideoTab,
    status?.wsOpen,
    sendTrackingControl,
    sendRoiTrackingControl,
    roiTrackingOption,
  ])

  const stopPreviewTracking = useCallback(() => {
    if (isCameraTab && !isBrowserBackend) {
      sendTrackingControl({ action: "resetLipNeutral" })
      sendTrackingControl({
        action: "resetIrisGaze",
        reason: "stopCameraTracking",
        armed: false,
      })
    }
    videoReplaySentRef.current = false
    videoRoiSentRef.current = false
    setTrackingEnabled(false)
    if (isBrowserBackend) {
      try {
        stopBrowserCamera?.()
      } catch {
        //
      }
    }
    resetTrackingEyeReleaseState(calibrationRef.current)
    resetPreviewToNeutral()
  }, [
    isCameraTab,
    isBrowserBackend,
    sendTrackingControl,
    setTrackingEnabled,
    stopBrowserCamera,
    resetPreviewToNeutral,
  ])

  const startPreviewTracking = useCallback(async () => {
    if (!previewSourceActive && !isBrowserBackend) {
      return false
    }
    reloadProfile()
    resetTrackingEyeReleaseState(calibrationRef.current)
    if (isBrowserBackend) {
      try {
        await startBrowserCamera({ video: true, audio: false })
      } catch (error) {
        console.error("[browser-tracking] camera start failed:", error)
        throw error
      }
      setTrackingEnabled(true)
      return true
    }
    const url = String(wsUrlDraft ?? "").trim() || DEFAULT_WS_CAMERA
    if (connectedUrl !== url) {
      replaceWithWebSocket()
    }
    setTrackingEnabled(true)
    return true
  }, [
    previewSourceActive,
    isBrowserBackend,
    startBrowserCamera,
    wsUrlDraft,
    connectedUrl,
    replaceWithWebSocket,
    setTrackingEnabled,
    reloadProfile,
  ])

  useEffect(() => {
    if (!previewSourceActive && trackingEnabled) {
      setTrackingEnabled(false)
      resetPreviewToNeutral()
    }
  }, [previewSourceActive, trackingEnabled, setTrackingEnabled, resetPreviewToNeutral])

  useEffect(() => {
    return () => {
      setTrackingEnabled(false)
    }
  }, [setTrackingEnabled])

  const videoNeutralFrameDiag = useMemo(() => {
    if (!lastFrame) return null
    return buildVideoNeutralFrameDiagnostic(
      lastFrame,
      videoNeutral.snapshot,
      videoNeutral.enabled,
      neutralApplyResult
    )
  }, [lastFrame, videoNeutral.snapshot, videoNeutral.enabled, neutralApplyResult])

  return {
    ctrl: {
      wsUrlDraft,
      setWsUrlDraft,
      replaceWithWebSocket,
      clearLastFrame,
      lastFrame,
      status,
      sendTrackingControl,
      trackingBackend,
      switchTrackingBackend,
      browserMetrics,
    bindBrowserVideoElement,
    startBrowserCamera,
    stopBrowserCamera,
    isBrowserBackend,
  },
  profile,
    calibratedFrame,
    previewRig,
    dryRunResult,
    trackingStatus,
    cameraRunning: isCameraTab && trackingLive,
    previewSourceRunning: trackingLive,
    isVideoInputActive,
    inputSourceType,
    trackingBackend,
    isBrowserBackend,
    browserMetrics,
    switchTrackingBackend,
    bindBrowserVideoElement,
    stopBrowserCamera,
    startCameraTracking: startPreviewTracking,
    startPreviewTracking,
    stopCameraTracking: stopPreviewTracking,
    stopPreviewTracking,
    resetPreviewToNeutral,
    mapping,
    lipGeometry,
    jawGeometry,
    mouthScenarioClassifier,
    browGate,
    browDebug,
    bypassBrowGate,
    bypassEyeRelease,
    requestLipNeutral,
    videoNeutral: {
      ...videoNeutral,
      sourceMismatch: videoNeutralSourceMismatch,
      neutralApplyResult,
      frameDiagnostic: videoNeutralFrameDiag,
      getRawTrackingSignals: () =>
        buildRawTrackingSignals(lastFrame, videoNeutralFrameDiag),
    },
    roiTracking: {
      option: roiTrackingOption,
      setOption: setRoiTrackingOptionAndSend,
      faceScale: lastFrame?.debug?.trackingDebug?.faceScale ?? null,
      trackingMode: lastFrame?.debug?.inputSource?.trackingMode ?? null,
      roiMultiplier: lastFrame?.debug?.inputSource?.roiMultiplier ?? null,
    },
    videoDiagnostic: {
      startMs: videoDiagnosticStartMs,
      setStartMs: setVideoDiagnosticStartMs,
      prepare: prepareVideoDiagnostic,
    },
    videoSourceTuning: {
      enabled: isVideoInputActive && videoSourceTuningEnabled,
      frameDiagnostic: videoSourceTuningResult?.diagnostic ?? null,
      shadowDiagnostic: videoTuningBundle?.shadow ?? null,
      jawTrace: videoSourceTuningResult?.jawTrace ?? null,
    },
    setFrameValidator,
    setOnSourceChanged,
  }
}
