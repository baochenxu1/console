import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  CHANNEL_VALUE,
  CHANNEL_X,
  CHANNEL_LATERAL,
  BINDING_RANGE_MODE_CUSTOM,
  buildFaceRigExportPayload,
  createDefaultFaceRigProfile,
  loadFaceRigProfile,
  normalizeBinding,
  normalizeFaceRigProfile,
  parseFaceRigImport,
  saveFaceRigProfile,
  buildFaceRigExportFilename,
} from "../core/faceRigProfile.js"
import {
  createInitialEliteRig,
  mapFaceRigToPose,
  normalizeEliteRig,
  rigValuesFromEliteRig,
} from "../core/faceDofMapper.js"
import {
  createRightMouthCornerFivebarState,
  resetRightMouthCornerFivebarState,
} from "../sdk/kinematics/mouthCornerFivebar.js"
import {
  clearRightMouthRuntimeBaseline,
  RIGHT_MOUTH_BASELINE_CHANGED_EVENT,
} from "../sdk/kinematics/rightMouthFiveBarRuntime.js"
import { buildMapFaceRigToPoseOptionsFromMouthRuntimes } from "../sdk/kinematics/mouthFiveBarRuntimeOptions.js"
import { createBrowTipFivebarState } from "../sdk/kinematics/browTipFivebar.js"
import {
  createLeftBrowFiveBarPairServo,
  createRightBrowFiveBarSyncGroup,
  markBrowFiveBarPairServoSent,
  BROW_FIVEBAR_MOTION_MODE,
  BROW_FIVEBAR_PAIR_SERVO_CONFIG,
  isLeftBrowTipDragControlId,
  isRightBrowTipDragControlId,
  resolveBrowFiveBarControlIntervalMs,
} from "../sdk/kinematics/rightBrowFiveBarSyncGroup.js"
import {
  clearLeftMouthRuntimeBaseline,
  LEFT_MOUTH_BASELINE_CHANGED_EVENT,
} from "../sdk/kinematics/leftMouthFiveBarRuntime.js"
import { clearAllBindings } from "../sdk/binding/bindingActions.js"
import { resolveMouthCornerNeutralCapture } from "../sdk/kinematics/mouthCornerKinematics.js"
import { resolveJawNeutralCapture } from "../sdk/kinematics/jawKinematics.js"
import { persistMouthLabNeutralPwm } from "../sdk/kinematics/mouthCornerFiveBarLab.js"
import {
  BINDING_OUTPUT_MODE_STORAGE_KEY,
  BINDING_OUTPUT_MODES,
  buildBindingWorkbenchState,
  dispatchBindingWorkbenchOutputs,
  normalizeBindingOutputMode,
} from "../sdk/output/bindingWorkbench/index.js"
import { applySelectedBindingTestPose } from "../sdk/output/bindingWorkbench/bindingWorkbenchRig.js"
import { migrateFaceRigProfileToBusSemantics } from "../sdk/binding/migrateFaceRigProfileToBusSemantics.js"
import { traceBindingNormalized } from "../sdk/binding/bindingActuatorFields.js"
import { fixAndSaveActuatorProfileAlignment } from "../sdk/output/fixAndSaveActuatorProfileAlignment.js"
import { loadActuatorProfiles } from "../sdk/output/loadActuatorProfiles.js"
import { buildBusCommandsFromFinalOutputs } from "../sdk/output/adapters/busServoOutputAdapter.js"
import { resetRjHostMotionState } from "../sdk/output/rjHostMotionAdapter.js"
import {
  getActiveBusTransportLabel,
  getStoredBusTransportFamily,
  isSharedBusWireConnected,
} from "../sdk/servoAdapters/busServo/resolveBusTransport.js"
import {
  PHYSICAL_MOTION_OWNERS,
  acquirePhysicalMotionOwner,
  releasePhysicalMotionOwner,
} from "../sdk/expression/physicalMotionOwner.js"
import { BUS_SERVO_PROFILES_CHANGED_EVENT } from "../sdk/servoAdapters/scservo/scServoLabStore.js"
import { clampNumber } from "../utils/clamp.js"
import { exportJsonFile } from "../utils/fileExport.js"
import { attachDragSession, tryCapturePointer } from "../sdk/react/faceRig/faceRigPointer.js"
import { createDoubleTapDetector } from "../sdk/react/faceRig/useFaceRigScrubAdjustGate.js"
import {
  EYE_RADAR_DRAG_GAIN,
  SCRUB_CLICK_SLOP_PX,
} from "../sdk/react/faceRig/faceRigScrubMath.js"
import { JAW_TRACK_PX } from "../sdk/react/faceRig/faceRigScrubMath.js"
import { DEFAULT_REALTIME_TUNING, REALTIME_RJ_MOTION_CONFIG, BINDING_PREVIEW_RJ_MOTION_CONFIG } from "./realtimeTrackingTuning.js"
import {
  expandControlIdsForDrag,
  filterFinalOutputsByControlIds,
  filterFinalOutputsByPwmDelta,
  rememberSentPwm,
} from "./faceRigRealtimeDragFilter.js"

export { DEFAULT_REALTIME_TUNING, REALTIME_THROTTLE_MS, REALTIME_RJ_MOTION_CONFIG } from "./realtimeTrackingTuning.js"
export { JAW_TRACK_PX } from "../sdk/react/faceRig/faceRigScrubMath.js"
export { attachDragSession, tryCapturePointer } from "../sdk/react/faceRig/faceRigPointer.js"

export const JAW_HANDLE_PX = 42
export const RADAR_BOX_PX = 110
export const RADAR_CURSOR_PX = 16
export const EYE_RADAR_CX = 50
export const EYE_RADAR_CY = 50
export const EYE_RADAR_R = 50

export function clampScr(v) {
  return clampNumber(Number(v), -100, 100)
}

export function jawOffsetPx(jawVal) {
  const margin = (JAW_TRACK_PX - JAW_HANDLE_PX) / 2
  const t = clampScr(jawVal)
  return (-t / 100) * margin
}

export function clampPctLogicalCircleEyexy(xPct, yPct) {
  let dx = xPct - EYE_RADAR_CX
  let dy = yPct - EYE_RADAR_CY
  const d = Math.hypot(dx, dy)
  if (d <= EYE_RADAR_R + 1e-12) {
    return { x: clampNumber(xPct, 0, 100), y: clampNumber(yPct, 0, 100) }
  }
  const s = EYE_RADAR_R / d
  dx *= s
  dy *= s
  return {
    x: clampNumber(EYE_RADAR_CX + dx, 0, 100),
    y: clampNumber(EYE_RADAR_CY + dy, 0, 100),
  }
}

export function radarCursorCenterPx(xyPct, axis) {
  const v = axis === "x" ? xyPct.x : xyPct.y
  return (
    ((Number(v) || 50) / 100) * (RADAR_BOX_PX - RADAR_CURSOR_PX) + RADAR_CURSOR_PX / 2
  )
}

/** rig sharedRadar.y+ = 向上看 → UI 圆点向上（屏幕 top 减小） */
export function radarCursorCenterPxEyey(sharedRadarY) {
  const centerY = RADAR_BOX_PX / 2
  const radius = (RADAR_BOX_PX - RADAR_CURSOR_PX) / 2
  const y = Number(sharedRadarY) || 50
  return centerY - ((y - 50) / 50) * radius
}

/** +1 = 向右看 */
export function eyeRadarDotXNorm(sharedRadarX) {
  return ((Number(sharedRadarX) || 50) - 50) / 50
}

/** +1 = 向上看，与 rig.sharedRadar.y 语义一致（供诊断/UI 对照） */
export function eyeRadarDotYNorm(sharedRadarY) {
  return ((Number(sharedRadarY) || 50) - 50) / 50
}

/** 雷达 pad 屏幕坐标（0=顶）→ rig sharedRadar.y */
export function screenPctToSharedRadarY(screenPct) {
  return clampNumber(100 - Number(screenPct), 0, 100)
}

export function eyeRadarDisplayPx(sharedRadarX, sharedRadarY) {
  const disp = clampPctLogicalCircleEyexy(Number(sharedRadarX) || 50, Number(sharedRadarY) || 50)
  return {
    disp,
    cxPx: radarCursorCenterPx(disp, "x"),
    cyPx: radarCursorCenterPxEyey(disp.y),
  }
}

/**
 * Face Rig 面部控件、profile、mapFaceRigToPose、下发等与 {@link FaceRigPage} 共用。
 */
export function useFaceRigInteraction(configs = [], options = {}) {
  const blockRealtimeHardwareRef = options.blockRealtimeHardwareRef
  const rightMouthCornerFivebarStateRef = useRef(createRightMouthCornerFivebarState())
  const leftMouthCornerFivebarStateRef = useRef(createRightMouthCornerFivebarState())
  const leftBrowTipFivebarStateRef = useRef(createBrowTipFivebarState())
  const rightBrowTipFivebarStateRef = useRef(createBrowTipFivebarState())
  const rightBrowFiveBarSyncGroupRef = useRef(createRightBrowFiveBarSyncGroup())
  const leftBrowFiveBarSyncGroupRef = useRef(createLeftBrowFiveBarPairServo())
  const rightBrowFinalSettleRef = useRef(false)
  const leftBrowFinalSettleRef = useRef(false)
  const prevDraggingControlIdRef = useRef(/** @type {string | null} */ (null))
  const [mouthRuntimeVersion, setMouthRuntimeVersion] = useState(0)

  useEffect(() => {
    const onChanged = () => setMouthRuntimeVersion((v) => v + 1)
    window.addEventListener(RIGHT_MOUTH_BASELINE_CHANGED_EVENT, onChanged)
    window.addEventListener(LEFT_MOUTH_BASELINE_CHANGED_EVENT, onChanged)
    return () => {
      window.removeEventListener(RIGHT_MOUTH_BASELINE_CHANGED_EVENT, onChanged)
      window.removeEventListener(LEFT_MOUTH_BASELINE_CHANGED_EVENT, onChanged)
    }
  }, [])

  const [profile, setProfile] = useState(() => loadFaceRigProfile())
  const [rig, _setRig] = useState(() => createInitialEliteRig())
  const rigRef = useRef(rig)
  rigRef.current = rig
  const pendingRigUpdateRef = useRef(/** @type {object | null} */ (null))
  const rigRafRef = useRef(/** @type {number | null} */ (null))
  const lastRealtimeSourceRef = useRef(/** @type {"manual"|"tracking"} */ ("manual"))
  const realtimePreviewRef = useRef(false)
  const realtimeSerialBusyRef = useRef(false)
  const realtimeSerialFlushRef = useRef(false)
  const lastTrackingSentPwmRef = useRef(new Map())
  const lastManualSentPwmRef = useRef(new Map())
  const manualRealtimeRafRef = useRef(/** @type {number | null} */ (null))
  const draggingControlIdRef = useRef(/** @type {string | null} */ (null))
  /** 绑定改方向等预览被 busy 挡住时，flush 后仍以 bindingPreview 重发 */
  const pendingBindingPreviewRef = useRef(false)
  const lastRealtimeGateMsgRef = useRef("")
  const pushToServoRef = useRef(
    /** @type {null | ((o?: { realtime?: boolean; silent?: boolean; tracking?: boolean }) => Promise<void>)} */ (
      null
    )
  )
  const [outputMode, setOutputModeState] = useState(() => {
    try {
      const stored = localStorage.getItem(BINDING_OUTPUT_MODE_STORAGE_KEY)
      if (stored) {
        return normalizeBindingOutputMode(stored)
      }
    } catch {
      //
    }
    return BINDING_OUTPUT_MODES.BUS_SERVO
  })
  const [driveArmed, setDriveArmed] = useState(false)
  const [testMode, setTestMode] = useState(/** @type {null | 'center' | 'positive' | 'negative'} */ (null))
  const [testBindingId, setTestBindingId] = useState(/** @type {string | null} */ (null))
  const testModeRef = useRef(testMode)
  const testBindingIdRef = useRef(testBindingId)
  testModeRef.current = testMode
  testBindingIdRef.current = testBindingId
  const [lastDispatch, setLastDispatch] = useState(/** @type {object | null} */ (null))
  const [serialStatus, setSerialStatus] = useState(() => ({
    bus: isSharedBusWireConnected(),
    family: getStoredBusTransportFamily(),
    label: getActiveBusTransportLabel(),
  }))
  const [actuatorProfileReloadNonce, setActuatorProfileReloadNonce] = useState(0)

  const setOutputMode = useCallback((mode) => {
    const next = normalizeBindingOutputMode(mode)
    setOutputModeState(next)
    try {
      localStorage.setItem(BINDING_OUTPUT_MODE_STORAGE_KEY, next)
    } catch {
      //
    }
    if (next === BINDING_OUTPUT_MODES.PREVIEW) {
      setDriveArmed(false)
    }
  }, [])

  const setRig = useCallback((updater) => {
    lastRealtimeSourceRef.current = "manual"
    if (testModeRef.current != null) {
      testModeRef.current = null
      setTestMode(null)
    }
    if (testBindingIdRef.current != null) {
      testBindingIdRef.current = null
      setTestBindingId(null)
    }
    if (rigRafRef.current != null) {
      window.cancelAnimationFrame(rigRafRef.current)
      rigRafRef.current = null
    }
    const base = pendingRigUpdateRef.current ?? rigRef.current
    const next = typeof updater === "function" ? updater(base) : updater
    if (!next || typeof next !== "object") {
      return
    }
    pendingRigUpdateRef.current = null
    rigRef.current = next
    _setRig(next)
    /* 对齐 Bus 滑条：姿态更新后 rAF 合并下发最新值（手动实时） */
    if (realtimePreviewRef.current && lastRealtimeSourceRef.current !== "tracking") {
      if (realtimeSerialBusyRef.current) {
        realtimeSerialFlushRef.current = true
      } else if (manualRealtimeRafRef.current == null) {
        manualRealtimeRafRef.current = window.requestAnimationFrame(() => {
          manualRealtimeRafRef.current = null
          const fn = pushToServoRef.current
          if (fn) void fn({ realtime: true, silent: true, tracking: false })
        })
      }
    }
  }, [])
  const setRigFromWebTracking = useCallback((nextRig) => {
    lastRealtimeSourceRef.current = "tracking"
    if (rigRafRef.current != null) {
      window.cancelAnimationFrame(rigRafRef.current)
      rigRafRef.current = null
    }
    pendingRigUpdateRef.current = null
    const normalized = normalizeEliteRig(nextRig)
    rigRef.current = normalized
    _setRig(normalized)
  }, [])

  const [sendStatus, setSendStatus] = useState("")
  const [realtimePreview, setRealtimePreview] = useState(false)
  realtimePreviewRef.current = realtimePreview
  const [realtimeTuning, setRealtimeTuning] = useState(() => ({ ...DEFAULT_REALTIME_TUNING }))
  const realtimeServoSendCountRef = useRef(0)
  const [realtimeServoFps, setRealtimeServoFps] = useState(/** @type {number | null} */ (null))
  const [selectedControlId, setSelectedControlId] = useState(null)
  const [selectedChannel, setSelectedChannel] = useState(CHANNEL_VALUE)
  const [draggingControlId, setDraggingControlIdState] = useState(null)
  const setDraggingControlId = useCallback((next) => {
    draggingControlIdRef.current = next == null ? null : String(next)
    setDraggingControlIdState(next)
  }, [])
  /* 渲染同步兜底；拖动开始必须经 setDraggingControlId 立刻写 ref，避免 rAF 下发时仍为空 */

  /* 左右眉 tip 松手：冻结当前 brow.x/y，进入 Final Settle（不消费旧 target） */
  useEffect(() => {
    const prev = prevDraggingControlIdRef.current
    prevDraggingControlIdRef.current = draggingControlId
    let triggerSettlePush = false
    if (isRightBrowTipDragControlId(prev) && !isRightBrowTipDragControlId(draggingControlId)) {
      rightBrowFinalSettleRef.current = true
      triggerSettlePush = true
    }
    if (isLeftBrowTipDragControlId(prev) && !isLeftBrowTipDragControlId(draggingControlId)) {
      leftBrowFinalSettleRef.current = true
      triggerSettlePush = true
    }
    if (triggerSettlePush && realtimePreviewRef.current) {
      queueMicrotask(() => {
        const fn = pushToServoRef.current
        if (fn) void fn({ realtime: true, silent: true, tracking: false })
      })
    }
  }, [draggingControlId])

  useEffect(() => {
    return () => {
      if (rigRafRef.current != null) {
        window.cancelAnimationFrame(rigRafRef.current)
        rigRafRef.current = null
      }
    }
  }, [])

  const normalizedProfile = useMemo(() => normalizeFaceRigProfile(profile), [profile])
  const normalizedProfileRef = useRef(normalizedProfile)
  normalizedProfileRef.current = normalizedProfile

  const prevInspectorControlRef = useRef(null)
  useEffect(() => {
    if (prevInspectorControlRef.current === selectedControlId) {
      return
    }
    prevInspectorControlRef.current = selectedControlId
    if (!selectedControlId) {
      return
    }
    const ctrl = normalizedProfile.controls.find((c) => c.controlId === selectedControlId)
    /* 眉尖语义 tip：绑定通道是 F/D，不要默认成 x/y */
    if (selectedControlId === "brow_r_tip" || selectedControlId === "brow_l_tip") {
      setSelectedChannel("F")
      return
    }
    /* 下颌：绑定通道是 A/D，不要默认成 value/lateral */
    if (selectedControlId === "jaw") {
      setSelectedChannel("A")
      return
    }
    if (ctrl?.channels?.x && ctrl?.channels?.y) {
      setSelectedChannel(CHANNEL_X)
    } else if (ctrl?.channels?.lateral && selectedChannel === CHANNEL_LATERAL) {
      // 下颌横向 scrub 已指定 lateral，勿重置为 value
      return
    } else {
      setSelectedChannel(CHANNEL_VALUE)
    }
  }, [selectedControlId, normalizedProfile.controls, selectedChannel])

  const rigValues = useMemo(() => rigValuesFromEliteRig(rig), [rig])

  const mapFaceRigToPoseOptions = useMemo(() => {
    const base = buildMapFaceRigToPoseOptionsFromMouthRuntimes({
      rightState: rightMouthCornerFivebarStateRef.current,
      leftState: leftMouthCornerFivebarStateRef.current,
    })
    return {
      ...base,
      leftBrowTipFivebarState: leftBrowTipFivebarStateRef.current,
      rightBrowTipFivebarState: rightBrowTipFivebarStateRef.current,
      browTipFivebarStates: {
        left: leftBrowTipFivebarStateRef.current,
        right: rightBrowTipFivebarStateRef.current,
      },
      rightBrowFiveBarSyncGroup: rightBrowFiveBarSyncGroupRef.current,
      rightBrowSyncMode: BROW_FIVEBAR_MOTION_MODE.OBSERVE,
      rightBrowSyncNowMs: performance.now(),
      rightBrowPairServoConfig: BROW_FIVEBAR_PAIR_SERVO_CONFIG,
      leftBrowFiveBarSyncGroup: leftBrowFiveBarSyncGroupRef.current,
      leftBrowSyncMode: BROW_FIVEBAR_MOTION_MODE.OBSERVE,
      leftBrowSyncNowMs: performance.now(),
      leftBrowPairServoConfig: BROW_FIVEBAR_PAIR_SERVO_CONFIG,
      /* 手动 UI：旁路嘴角角速率滤波，避免舵机“追不上” */
      bypassMouthServoOutputFilter: lastRealtimeSourceRef.current === "manual",
    }
  }, [rigValues, mouthRuntimeVersion])

  const mapped = useMemo(
    () => mapFaceRigToPose(rigValues, normalizedProfile, configs, mapFaceRigToPoseOptions),
    [rigValues, normalizedProfile, configs, mapFaceRigToPoseOptions]
  )
  const { logicalPose, actualPose, contributions, warnings, kinematics } = mapped

  const logicalPoseRef = useRef(logicalPose)
  logicalPoseRef.current = logicalPose

  const testBinding = useMemo(() => {
    if (!testBindingId) {
      return null
    }
    return normalizedProfile.bindings.find((b) => b.bindingId === testBindingId) ?? null
  }, [testBindingId, normalizedProfile.bindings])

  useEffect(() => {
    const tick = () => {
      const family = getStoredBusTransportFamily()
      setSerialStatus({
        bus: isSharedBusWireConnected(family),
        family,
        label: getActiveBusTransportLabel(family),
      })
    }
    tick()
    const id = window.setInterval(tick, 400)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    const onBusProfilesChanged = () => {
      setActuatorProfileReloadNonce((n) => n + 1)
      setSendStatus("已同步最新总线舵机配置")
    }
    window.addEventListener(BUS_SERVO_PROFILES_CHANGED_EVENT, onBusProfilesChanged)
    return () => window.removeEventListener(BUS_SERVO_PROFILES_CHANGED_EVENT, onBusProfilesChanged)
  }, [])

  const workbenchState = useMemo(
    () =>
      buildBindingWorkbenchState({
        previewRigFrame: rig,
        bindingConfig: normalizedProfile,
        configs,
        mapFaceRigToPoseOptions,
        selectedBinding: testBinding,
        testMode,
        outputMode,
        driveArmed,
        busSerialConnected: serialStatus.bus,
        busFamilyLabel: serialStatus.label,
        timeMs: realtimeTuning.servoMoveTimeMs,
        sourceType: lastRealtimeSourceRef.current === "tracking" ? "tracking" : "manual",
        /* UI 诊断必须完整；light 仅用于实时下发热路径，禁止掏空 activeBindings 显示 */
        light: false,
      }),
    [
      rig,
      normalizedProfile,
      configs,
      mapFaceRigToPoseOptions,
      testBinding,
      testMode,
      outputMode,
      driveArmed,
      serialStatus.bus,
      serialStatus.label,
      realtimeTuning.servoMoveTimeMs,
      actuatorProfileReloadNonce,
    ]
  )

  const handleFixActuatorBusAlignment = useCallback(() => {
    const res = fixAndSaveActuatorProfileAlignment()
    setActuatorProfileReloadNonce((n) => n + 1)
    setSendStatus(res.message)
  }, [])

  const padLRef = useRef(null)
  const padRRef = useRef(null)
  const importInputRef = useRef(null)
  const eyeRadarGateRef = useRef({
    L: { armed: false, tap: createDoubleTapDetector() },
    R: { armed: false, tap: createDoubleTapDetector() },
  })
  const [eyeRadarAdjustArmed, setEyeRadarAdjustArmed] = useState({ L: false, R: false })

  const startRadar = useCallback((event, side = "L") => {
    if (typeof event.button === "number" && event.button !== 0) {
      return
    }
    const isL = side === "L" || side === "l" || side === "left"
    const sideKey = isL ? "L" : "R"
    const controlId = isL ? "eye_l_xy" : "eye_r_xy"
    const eyeKey = isL ? "eyeL" : "eyeR"
    setSelectedControlId(controlId)
    setSelectedChannel(CHANNEL_X)
    event.preventDefault()
    event.stopPropagation()

    let startClientX = event.clientX
    let startClientY = event.clientY
    if (!Number.isFinite(startClientX) || !Number.isFinite(startClientY)) {
      const t = event.touches?.[0] ?? event.changedTouches?.[0]
      if (t) {
        startClientX = t.clientX
        startClientY = t.clientY
      }
    }
    const cx0 = Number.isFinite(startClientX) ? startClientX : 0
    const cy0 = Number.isFinite(startClientY) ? startClientY : 0

    const gate = eyeRadarGateRef.current[sideKey]
    const doubleActivate = gate.tap.isDouble(event, cx0, cy0)
    const wasArmed = gate.armed

    if (doubleActivate) {
      gate.armed = true
      setEyeRadarAdjustArmed((prev) =>
        prev[sideKey] ? prev : { ...prev, [sideKey]: true }
      )
    } else if (!wasArmed) {
      /* 单击且未可调：只选定 */
      return
    }

    tryCapturePointer(event.currentTarget, event.nativeEvent)

    const el = event.currentTarget
    const eye0 = rigRef.current?.[eyeKey]
    const startXY = {
      x: Number(eye0?.x),
      y: Number(eye0?.y),
    }
    const session = {
      startClientX: cx0,
      startClientY: cy0,
      startXY: {
        x: Number.isFinite(startXY.x) ? startXY.x : 50,
        y: Number.isFinite(startXY.y) ? startXY.y : 50,
      },
      dragging: false,
      keepArmedOnTap: doubleActivate,
    }

    function applyRelative(e) {
      if (!el) return
      const r = el.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) return
      let x = e.clientX
      let y = e.clientY
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        const t = e.touches?.[0] ?? e.changedTouches?.[0]
        if (t) {
          x = t.clientX
          y = t.clientY
        }
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) return

      const dxPx = x - session.startClientX
      const dyPx = y - session.startClientY
      if (!session.dragging) {
        if (Math.hypot(dxPx, dyPx) < SCRUB_CLICK_SLOP_PX) return
        session.dragging = true
        setDraggingControlId(controlId)
      }

      const g = EYE_RADAR_DRAG_GAIN
      const dx = (dxPx / r.width) * 100 * g
      /* 屏幕向下 → logical Y 减小（与 screenPctToSharedRadarY 一致） */
      const dy = -(dyPx / r.height) * 100 * g
      const clamped = clampPctLogicalCircleEyexy(session.startXY.x + dx, session.startXY.y + dy)
      setRig((prev) => {
        const nextEye = { ...prev[eyeKey], x: clamped.x, y: clamped.y }
        const other = isL ? prev.eyeR : prev.eyeL
        return {
          ...prev,
          [eyeKey]: nextEye,
          sharedRadar: {
            x: (clamped.x + (Number(other?.x) || 50)) / 2,
            y: (clamped.y + (Number(other?.y) || 50)) / 2,
          },
        }
      })
    }

    attachDragSession({
      onMove: applyRelative,
      onEnd: () => {
        setDraggingControlId(null)
        if (!session.dragging && !session.keepArmedOnTap) {
          gate.armed = false
          setEyeRadarAdjustArmed((prev) =>
            prev[sideKey] ? { ...prev, [sideKey]: false } : prev
          )
        }
      },
    })
  }, [setRig])

  useEffect(() => {
    const id = selectedControlId
    if (id !== "eye_l_xy" && eyeRadarGateRef.current.L.armed) {
      eyeRadarGateRef.current.L.armed = false
      setEyeRadarAdjustArmed((prev) => (prev.L ? { ...prev, L: false } : prev))
    }
    if (id !== "eye_r_xy" && eyeRadarGateRef.current.R.armed) {
      eyeRadarGateRef.current.R.armed = false
      setEyeRadarAdjustArmed((prev) => (prev.R ? { ...prev, R: false } : prev))
    }
  }, [selectedControlId])

  const resetRightMouthCornerFivebarKinematics = useCallback(() => {
    resetRightMouthCornerFivebarState(rightMouthCornerFivebarStateRef.current)
  }, [])

  const resetLeftMouthCornerFivebarKinematics = useCallback(() => {
    resetRightMouthCornerFivebarState(leftMouthCornerFivebarStateRef.current)
  }, [])

  const resetMouthFivebarKinematics = useCallback((sideId = "right") => {
    if (sideId === "left") {
      resetRightMouthCornerFivebarState(leftMouthCornerFivebarStateRef.current)
    } else {
      resetRightMouthCornerFivebarState(rightMouthCornerFivebarStateRef.current)
    }
  }, [])

  const resetAllMouthFivebarKinematics = useCallback(() => {
    resetRightMouthCornerFivebarState(rightMouthCornerFivebarStateRef.current)
    resetRightMouthCornerFivebarState(leftMouthCornerFivebarStateRef.current)
  }, [])

  const resetAllBrowTipFivebarKinematics = useCallback(() => {
    leftBrowTipFivebarStateRef.current = createBrowTipFivebarState()
    rightBrowTipFivebarStateRef.current = createBrowTipFivebarState()
    rightBrowFiveBarSyncGroupRef.current = createRightBrowFiveBarSyncGroup()
    leftBrowFiveBarSyncGroupRef.current = createLeftBrowFiveBarPairServo()
    rightBrowFinalSettleRef.current = false
    leftBrowFinalSettleRef.current = false
  }, [])

  const resetEngine = useCallback(() => {
    resetAllMouthFivebarKinematics()
    resetAllBrowTipFivebarKinematics()
    setDraggingControlId(null)
    setTestMode(null)
    setTestBindingId(null)
    testModeRef.current = null
    testBindingIdRef.current = null
    const fresh = createInitialEliteRig()
    setRig(fresh)
    /* 实时预览开启时立即下发中位，避免只改 UI 舵机仍停在旧姿态 */
    if (realtimePreviewRef.current) {
      queueMicrotask(() => {
        const fn = pushToServoRef.current
        if (fn) {
          void fn({ realtime: true, silent: true, tracking: false })
        }
      })
    }
  }, [resetAllMouthFivebarKinematics, resetAllBrowTipFivebarKinematics, setRig])

  const handleSaveProfile = useCallback(() => {
    const saved = saveFaceRigProfile(normalizedProfile)
    setProfile(saved)
  }, [normalizedProfile])

  const pushToServo = useCallback(
    async ({
      realtime = false,
      silent = false,
      tracking = false,
      armForSend = false,
      /** 绑定方向/行程改完：强制 RJ+ST 立刻预览，跳过 delta / Motion defer */
      bindingPreview = false,
    } = {}) => {
      const effectiveArmed = driveArmed || armForSend
      const finishRealtimeSerial = () => {
        realtimeSerialBusyRef.current = false
        if (realtimeSerialFlushRef.current) {
          realtimeSerialFlushRef.current = false
          const forceBindingPreview = pendingBindingPreviewRef.current
          pendingBindingPreviewRef.current = false
          queueMicrotask(() => {
            const fn = pushToServoRef.current
            if (fn) {
              void fn({
                realtime: true,
                silent: true,
                tracking: lastRealtimeSourceRef.current === "tracking",
                bindingPreview: forceBindingPreview,
              })
            }
          })
        }
      }

      if (realtime) {
        if (blockRealtimeHardwareRef?.current) {
          return
        }
        if (outputMode === BINDING_OUTPUT_MODES.PREVIEW) {
          return
        }
        if (!effectiveArmed) {
          return
        }
        if (realtimeSerialBusyRef.current) {
          /* 绑定预览必须发出去：标 flush，写完后立刻再推一帧 */
          if (bindingPreview || !tracking || realtimeTuning.dropStaleFrame) {
            realtimeSerialFlushRef.current = true
          }
          if (bindingPreview) {
            pendingBindingPreviewRef.current = true
          }
          return
        }
        realtimeSerialBusyRef.current = true
      }

      try {
        const syncNowMs = performance.now()
        const rightSyncGroup = rightBrowFiveBarSyncGroupRef.current
        const leftSyncGroup = leftBrowFiveBarSyncGroupRef.current
        const draggingRightBrow = isRightBrowTipDragControlId(draggingControlId)
        const draggingLeftBrow = isLeftBrowTipDragControlId(draggingControlId)
        const wantRightFinalSettle = Boolean(rightBrowFinalSettleRef.current)
        const wantLeftFinalSettle = Boolean(leftBrowFinalSettleRef.current)
        let rightBrowSyncMode = BROW_FIVEBAR_MOTION_MODE.DISCRETE_TRAJECTORY
        let leftBrowSyncMode = BROW_FIVEBAR_MOTION_MODE.DISCRETE_TRAJECTORY
        let beginFinalSettle = false
        let beginLeftBrowFinalSettle = false
        if (!realtime) {
          rightBrowSyncMode = BROW_FIVEBAR_MOTION_MODE.DISCRETE_TRAJECTORY
          leftBrowSyncMode = BROW_FIVEBAR_MOTION_MODE.DISCRETE_TRAJECTORY
        } else {
          if (wantRightFinalSettle) {
            rightBrowSyncMode = BROW_FIVEBAR_MOTION_MODE.FINAL_SETTLE
            beginFinalSettle = !rightSyncGroup.finalSettleActive
          } else if (draggingRightBrow) {
            rightBrowSyncMode = BROW_FIVEBAR_MOTION_MODE.CONTINUOUS_SERVO
          } else {
            rightBrowSyncMode = BROW_FIVEBAR_MOTION_MODE.CONTINUOUS_SERVO
          }
          if (wantLeftFinalSettle) {
            leftBrowSyncMode = BROW_FIVEBAR_MOTION_MODE.FINAL_SETTLE
            beginLeftBrowFinalSettle = !leftSyncGroup.finalSettleActive
          } else if (draggingLeftBrow) {
            leftBrowSyncMode = BROW_FIVEBAR_MOTION_MODE.CONTINUOUS_SERVO
          } else {
            leftBrowSyncMode = BROW_FIVEBAR_MOTION_MODE.CONTINUOUS_SERVO
          }
        }
        const mapOptsForSend = {
          ...mapFaceRigToPoseOptions,
          rightBrowFiveBarSyncGroup: rightSyncGroup,
          rightBrowSyncNowMs: syncNowMs,
          rightBrowSyncMode,
          beginFinalSettle,
          rightBrowPairServoConfig: BROW_FIVEBAR_PAIR_SERVO_CONFIG,
          leftBrowFiveBarSyncGroup: leftSyncGroup,
          leftBrowSyncNowMs: syncNowMs,
          leftBrowSyncMode,
          beginLeftBrowFinalSettle,
          leftBrowPairServoConfig: BROW_FIVEBAR_PAIR_SERVO_CONFIG,
        }

        const timeMs = realtime
          ? tracking
            ? realtimeTuning.servoMoveTimeMs
            : Number(realtimeTuning.manualServoMoveTimeMs) ||
              DEFAULT_REALTIME_TUNING.manualServoMoveTimeMs
          : 500

        /* 实时热路径只读一次 profile，避免 build + dispatch 双次扫 storage */
        const latestActuators = loadActuatorProfiles()

        const state = buildBindingWorkbenchState({
          previewRigFrame: rigRef.current,
          bindingConfig: normalizedProfileRef.current,
          configs,
          mapFaceRigToPoseOptions: mapOptsForSend,
          selectedBinding: testBinding,
          testMode,
          outputMode,
          driveArmed: effectiveArmed,
          busSerialConnected: isSharedBusWireConnected(),
          timeMs,
          sourceType: tracking ? "tracking" : "manual",
          /* 下发热路径可跳过分析；不得影响 finalServoOutputs */
          light: true,
          actuatorProfiles: latestActuators.actuatorProfiles,
        })

        const { finalServoOutputs: allOutputs } = state
        let finalServoOutputs = allOutputs
        /* 手动拖动：只发当前控件相关轴；绑定方向预览跳过 delta，保证 RJ/ST 都重发 */
        if (realtime && !tracking && !bindingPreview) {
          const dragId = draggingControlIdRef.current
          if (dragId) {
            finalServoOutputs = filterFinalOutputsByControlIds(
              finalServoOutputs,
              expandControlIdsForDrag(dragId)
            )
          }
          finalServoOutputs = filterFinalOutputsByPwmDelta(
            finalServoOutputs,
            lastManualSentPwmRef.current
          )
        }
        if (!finalServoOutputs.length) {
          if (!silent) {
            setSendStatus("无可下发 actuator（检查绑定与启用状态）。")
          }
          if (realtime) {
            finishRealtimeSerial()
          }
          return
        }

        /* 过滤后按实际待发路组包，避免整脸有 ID1 时掩盖 ID2/4 的 profile 失败 */
        const filteredBusBuilt = buildBusCommandsFromFinalOutputs(
          finalServoOutputs,
          latestActuators.actuatorProfiles
        )
        if (
          !filteredBusBuilt.commands?.length &&
          outputMode !== BINDING_OUTPUT_MODES.PREVIEW
        ) {
          const skip = filteredBusBuilt.skipped?.[0]
          const reason = skip?.reason || skip?.message || "profile-not-found"
          const keys = (filteredBusBuilt.skipped || [])
            .map((s) => s.actuatorKey || s.legacyServoIndex)
            .filter(Boolean)
            .slice(0, 4)
            .join(",")
          const msg = keys
            ? `无 bus 命令（${keys}：${reason}）。请在舵机配置页保存该 ID 的 RJ/ST profile。`
            : "无 bus 命令可下发"
          if (!silent || lastRealtimeGateMsgRef.current !== msg) {
            lastRealtimeGateMsgRef.current = msg
            setSendStatus(msg)
          }
          if (realtime) {
            finishRealtimeSerial()
          }
          return
        }

        /* settle 完成后清除标志 */
        if (
          wantRightFinalSettle &&
          rightSyncGroup.finalSettleActive === false &&
          rightSyncGroup.groupFinished &&
          rightSyncGroup.lastReplanReason === "final-settle"
        ) {
          rightBrowFinalSettleRef.current = false
        }
        if (rightSyncGroup.finalSettleActive && rightSyncGroup.groupFinished) {
          rightBrowFinalSettleRef.current = false
        }
        if (
          wantLeftFinalSettle &&
          leftSyncGroup.finalSettleActive === false &&
          leftSyncGroup.groupFinished &&
          leftSyncGroup.lastReplanReason === "final-settle"
        ) {
          leftBrowFinalSettleRef.current = false
        }
        if (leftSyncGroup.finalSettleActive && leftSyncGroup.groupFinished) {
          leftBrowFinalSettleRef.current = false
        }

        /* 单次下发：Discrete 用 plannedDuration；Continuous 强制 time=0 避免舵机二次慢轨迹 */
        const rightPairDuration = Number(rightSyncGroup?.durationMs)
        const leftPairDuration = Number(leftSyncGroup?.durationMs)
        const isASpaceContinuous =
          rightBrowSyncMode === BROW_FIVEBAR_MOTION_MODE.CONTINUOUS_SERVO ||
          rightBrowSyncMode === BROW_FIVEBAR_MOTION_MODE.FINAL_SETTLE ||
          leftBrowSyncMode === BROW_FIVEBAR_MOTION_MODE.CONTINUOUS_SERVO ||
          leftBrowSyncMode === BROW_FIVEBAR_MOTION_MODE.FINAL_SETTLE
        const discreteDuration = Math.max(
          Number.isFinite(rightPairDuration) ? rightPairDuration : 0,
          Number.isFinite(leftPairDuration) ? leftPairDuration : 0
        )
        const sendTimeMs = isASpaceContinuous
          ? Math.max(
              Number(BROW_FIVEBAR_PAIR_SERVO_CONFIG.continuousDeviceTimeMs) || 0,
              Number.isFinite(timeMs) ? timeMs : 0
            )
          : !realtime && discreteDuration > 0
            ? Math.max(
                BROW_FIVEBAR_PAIR_SERVO_CONFIG.discreteMinDurationMs,
                Math.round(discreteDuration)
              )
            : timeMs

        if (realtime) {
          lastRealtimeGateMsgRef.current = ""
        }

        if (
          tracking &&
          realtime &&
          realtimeTuning.minPwmDelta > 0 &&
          lastTrackingSentPwmRef.current.size > 0
        ) {
          const minD = realtimeTuning.minPwmDelta
          const allSmall = finalServoOutputs.every((o) => {
            const prev = lastTrackingSentPwmRef.current.get(o.legacyServoIndex)
            if (prev === undefined || o.pwmValue == null) {
              return false
            }
            return Math.abs(o.pwmValue - prev) < minD
          })
          if (allSmall) {
            if (realtime) {
              finishRealtimeSerial()
            }
            return
          }
        }

        if (
          outputMode !== BINDING_OUTPUT_MODES.PREVIEW &&
          !effectiveArmed &&
          !realtime
        ) {
          const dryRes = {
            ok: true,
            dryRun: true,
            gates: state.gates,
            pwmCommand: state.pwmCommand,
            message: "未 Arm：仅更新 Adapter dry-run（见右侧诊断）",
          }
          setLastDispatch(dryRes)
          if (!silent) {
            setSendStatus(dryRes.message)
          }
          if (realtime) {
            finishRealtimeSerial()
          }
          return
        }

        /*
         * Face Rig：txMode "single-write"（勿改为整页 hybrid）。
         * - SC/ST：保持历史逐台 INST_WRITE，不改飞特原实现
         * - RJ：同帧内仍走 Host Motion + Multi-Packet Batch TX（single-write+rj-batch）
         * Tracking Device Drive 才用 hybrid（SC SyncWrite 0x83）。
         * 上层 busy + latest-flush 不变。
         */
        const res = await dispatchBindingWorkbenchOutputs({
          finalServoOutputs,
          outputMode,
          driveArmed: effectiveArmed,
          configs,
          actuatorProfiles: latestActuators.actuatorProfiles,
          profilesReady: latestActuators.allowRealSend,
          timeMs: sendTimeMs,
          busSerialConnected: isSharedBusWireConnected(),
          txMode: "single-write",
          quiet: Boolean(realtime),
          /*
           * 绑定方向/行程预览：RJ 与 ST 一样立刻发包（关闭 Motion defer）。
           * 追踪 / 手动实时：均用 REALTIME_RJ_MOTION_CONFIG（forceTimeMs≥20，禁 time=0）。
           */
          rjMotionConfig: bindingPreview
            ? BINDING_PREVIEW_RJ_MOTION_CONFIG
            : realtime
              ? REALTIME_RJ_MOTION_CONFIG
              : null,
        })

        if (res.sent || res.ok) {
          const sendEnd = performance.now()
          const markOpts = {
            sendStartTimeMs: syncNowMs,
            fSendTimeMs: sendEnd,
            dSendTimeMs: sendEnd,
            syncWrite: false,
            syncWriteDurationMs: sendEnd - syncNowMs,
            servoInternalTime: sendTimeMs,
            servoInternalSpeed: BROW_FIVEBAR_PAIR_SERVO_CONFIG.continuousDeviceSpeed,
          }
          const gR = rightBrowFiveBarSyncGroupRef.current
          markBrowFiveBarPairServoSent(gR, sendEnd, {
            qF: gR.lastScheduledF,
            qD: gR.lastScheduledD,
            ...markOpts,
          })
          if (gR.finalSettleActive === false && gR.groupFinished && rightBrowFinalSettleRef.current) {
            rightBrowFinalSettleRef.current = false
          }
          const gL = leftBrowFiveBarSyncGroupRef.current
          markBrowFiveBarPairServoSent(gL, sendEnd, {
            qF: gL.lastScheduledF,
            qD: gL.lastScheduledD,
            ...markOpts,
          })
          if (gL.finalSettleActive === false && gL.groupFinished && leftBrowFinalSettleRef.current) {
            leftBrowFinalSettleRef.current = false
          }
        }

        /* 实时 silent：勿每帧 setLastDispatch，否则 100Hz+ 重渲染会卡死 UI */
        if (!(realtime && silent)) {
          setLastDispatch(res)
        } else if (res && !res.ok && !res.dryRun) {
          setLastDispatch(res)
        }

        if (realtime && res.sent) {
          realtimeServoSendCountRef.current += 1
          lastRealtimeGateMsgRef.current = ""
        }

        if (tracking && realtime && res.sent) {
          for (const o of finalServoOutputs) {
            if (o.pwmValue != null && Number.isFinite(o.legacyServoIndex)) {
              lastTrackingSentPwmRef.current.set(o.legacyServoIndex, o.pwmValue)
            }
          }
        }
        if (!tracking && realtime && res.sent) {
          rememberSentPwm(lastManualSentPwmRef.current, finalServoOutputs)
        }
        if (tracking && realtime) {
          lastManualSentPwmRef.current.clear()
        }

        /* 实时成功不刷状态栏；仅暴露失败，避免「Bus 已下发 N 路」干扰 */
        if (realtime && silent && res && !res.ok && !res.dryRun) {
          const err = res.error || state.gates?.note || "实时下发失败"
          if (lastRealtimeGateMsgRef.current !== err) {
            lastRealtimeGateMsgRef.current = err
            setSendStatus(err)
          }
        }

        if (!silent && !realtime) {
          if (res.ok) {
            setSendStatus(res.message || "已下发。")
          } else if (!res.dryRun) {
            setSendStatus(res.error || state.gates?.note || "下发失败")
          } else {
            setSendStatus(res.message || "Preview Only（未发送）")
          }
        }
      } catch (error) {
        if (!silent) {
          setSendStatus(`下发失败：${error.message}`)
        }
      } finally {
        if (realtime) {
          finishRealtimeSerial()
        }
      }
    },
    [
      configs,
      realtimeTuning,
      normalizedProfile,
      mapFaceRigToPoseOptions,
      testBinding,
      testMode,
      outputMode,
      driveArmed,
      draggingControlId,
    ]
  )

  const runBindingTest = useCallback(
    async (bindingId, mode, bindingOverride = null) => {
      const profileNow = normalizedProfileRef.current || normalizedProfile
      const binding =
        bindingOverride ||
        (profileNow.bindings || []).find((b) => b.bindingId === bindingId) ||
        null
      if (!binding) {
        setSendStatus("未找到绑定条目。")
        return
      }

      /* 绑定硬件预览：不依赖顶部「实时预览」Arm，串口已开即可试舵机号 */
      const effectiveMode = BINDING_OUTPUT_MODES.BUS_SERVO
      if (outputMode !== effectiveMode) {
        setOutputMode(effectiveMode)
      }

      acquirePhysicalMotionOwner(PHYSICAL_MOTION_OWNERS.BINDING_HARDWARE_TEST)
      try {
        /* 清 RJ defer/估角，避免预览被当成「已在目标」或 interval 跳过 */
        resetRjHostMotionState()
        setTestBindingId(binding.bindingId)
        setTestMode(mode)

        const newRig = applySelectedBindingTestPose(rigRef.current, profileNow, binding, mode)
        lastRealtimeSourceRef.current = "manual"
        rigRef.current = newRig
        _setRig(newRig)

        const latestActuators = loadActuatorProfiles()
        const state = buildBindingWorkbenchState({
          previewRigFrame: newRig,
          bindingConfig: profileNow,
          configs,
          mapFaceRigToPoseOptions,
          selectedBinding: binding,
          testMode: mode,
          outputMode: effectiveMode,
          driveArmed: true,
          busSerialConnected: isSharedBusWireConnected(),
          timeMs: 500,
          sourceType: "manual",
          actuatorProfiles: latestActuators.actuatorProfiles,
        })

        if (!state.finalServoOutputs?.length) {
          setSendStatus(
            `预览失败：绑定 ID${binding.servoId} 无 finalServoOutputs（检查控件/通道/启用）`
          )
          setLastDispatch({
            ok: false,
            error: "no-final-outputs",
            gates: state.gates,
          })
          return
        }

        if (!state.busBuilt?.commands?.length) {
          const skip = state.busBuilt?.skipped?.[0]
          const reason = skip?.reason || skip?.message || "无匹配 actuator profile"
          setSendStatus(
            `预览失败：舵机号 ${binding.servoId} 无法组包（${reason}）。请先在舵机配置页添加该 RJ/ST ID。`
          )
          setLastDispatch({
            ok: false,
            error: reason,
            busBuilt: state.busBuilt,
            gates: state.gates,
          })
          return
        }

        const res = await dispatchBindingWorkbenchOutputs({
          finalServoOutputs: state.finalServoOutputs,
          outputMode: effectiveMode,
          driveArmed: true,
          configs,
          actuatorProfiles: latestActuators.actuatorProfiles,
          profilesReady: latestActuators.allowRealSend,
          timeMs: 500,
          txMode: "single-write",
          rjMotionConfig: BINDING_PREVIEW_RJ_MOTION_CONFIG,
        })
        setLastDispatch(res)

        const cmd0 = res.busBuilt?.commands?.[0] || state.busBuilt?.commands?.[0]
        const bindingPwm =
          mode === "positive"
            ? binding.positiveTargetPwm
            : mode === "negative"
              ? binding.negativeTargetPwm
              : binding.neutralPwm
        const posHint =
          cmd0 && Number.isFinite(Number(cmd0.targetPosition))
            ? ` · 绑定逻辑PWM ${Math.round(Number(bindingPwm))} → busLogical ${cmd0.busLogical ?? "?"} → 实发 pos=${Math.round(Number(cmd0.targetPosition))}（${cmd0.protocol || "?"}${cmd0.isClamped ? "·profile已夹紧" : ""}）`
            : ""
        const realTx = Number(res.busSend?.realTxCount ?? res.busSend?.txSent ?? 0)
        const reallySent = Boolean(res.sent) && realTx > 0

        if (reallySent) {
          setSendStatus(
            `已实发 ${mode} → 舵机 ${binding.servoId}${posHint}`
          )
        } else if (res.dryRun) {
          setSendStatus(`仅 dry-run，未写串口${posHint}`)
        } else if (res.busSend?.deferredOnly || res.busSend?.deferredServoIds?.length) {
          setSendStatus(
            `预览被 RJ Motion 延迟（未写串口）。请再点一次预览。${posHint}`
          )
        } else {
          setSendStatus(
            res.error ||
              res.message ||
              state.gates?.note ||
              `预览未实发（realTx=${realTx}）。检查串口 Open 与舵机协议。${posHint}`
          )
        }
      } finally {
        releasePhysicalMotionOwner(PHYSICAL_MOTION_OWNERS.BINDING_HARDWARE_TEST)
      }
    },
    [
      normalizedProfile,
      configs,
      mapFaceRigToPoseOptions,
      outputMode,
      setOutputMode,
    ]
  )

  const toggleDriveArm = useCallback(() => {
    if (outputMode === BINDING_OUTPUT_MODES.PREVIEW) {
      setSendStatus("Preview Only 模式无需 Arm。")
      return
    }
    setDriveArmed((v) => {
      const next = !v
      if (next) {
        setSendStatus("已 Arm · Bus Servo 实机下发")
      } else {
        setSendStatus("已 Disarm")
      }
      return next
    })
  }, [outputMode])

  pushToServoRef.current = pushToServo

  useEffect(() => {
    const windowMs = 500
    const id = window.setInterval(() => {
      const n = realtimeServoSendCountRef.current
      realtimeServoSendCountRef.current = 0
      if (!realtimePreview) {
        setRealtimeServoFps(null)
        return
      }
      setRealtimeServoFps(Math.round((n / windowMs) * 1000))
    }, windowMs)
    return () => window.clearInterval(id)
  }, [realtimePreview])

  useEffect(() => {
    if (!realtimePreview) {
      lastTrackingSentPwmRef.current.clear()
      lastManualSentPwmRef.current.clear()
    }
  }, [realtimePreview])

  /*
   * 实时控制环：
   * - 手动拖动：由 setRig → rAF 触发（对齐 Bus 滑条），此处不再 16ms 整脸空转
   * - 追踪：固定间隔唤醒 + busy 时 latest-flush
   */
  useEffect(() => {
    if (!realtimePreview) {
      return
    }

    /* 清掉上次 T=0 / defer 残留估计，避免整脸发不出有效运动 */
    resetRjHostMotionState()
    realtimeSerialBusyRef.current = false
    realtimeSerialFlushRef.current = false
    lastManualSentPwmRef.current.clear()

    rightBrowFiveBarSyncGroupRef.current.requestedTickHz = BROW_FIVEBAR_PAIR_SERVO_CONFIG.maxServoHz
    rightBrowFiveBarSyncGroupRef.current.maxServoHz = BROW_FIVEBAR_PAIR_SERVO_CONFIG.maxServoHz
    leftBrowFiveBarSyncGroupRef.current.requestedTickHz = BROW_FIVEBAR_PAIR_SERVO_CONFIG.maxServoHz
    leftBrowFiveBarSyncGroupRef.current.maxServoHz = BROW_FIVEBAR_PAIR_SERVO_CONFIG.maxServoHz

    const browIntervalMs = Math.max(
      8,
      resolveBrowFiveBarControlIntervalMs(BROW_FIVEBAR_PAIR_SERVO_CONFIG)
    )
    const intervalMs = Math.max(
      browIntervalMs,
      Number(realtimeTuning.sendIntervalMs) || DEFAULT_REALTIME_TUNING.sendIntervalMs
    )

    const tick = () => {
      /* 手动源：只靠 setRig/rAF，避免空闲时整脸刷串口 */
      if (lastRealtimeSourceRef.current !== "tracking") {
        return
      }
      const fn = pushToServoRef.current
      if (!fn) return
      void fn({
        realtime: true,
        silent: true,
        tracking: true,
      })
    }

    const timer = window.setInterval(tick, intervalMs)
    setSendStatus((prev) =>
      typeof prev === "string" && prev.startsWith("Bus 已下发") ? "" : prev
    )

    return () => {
      window.clearInterval(timer)
      if (manualRealtimeRafRef.current != null) {
        window.cancelAnimationFrame(manualRealtimeRafRef.current)
        manualRealtimeRafRef.current = null
      }
    }
  }, [realtimePreview, realtimeTuning.sendIntervalMs])

  const handleExportProfile = useCallback(() => {
    const payload = buildFaceRigExportPayload(normalizedProfile)
    const filename = buildFaceRigExportFilename(payload.name)
    exportJsonFile(filename, payload)
    setSendStatus(`已导出绑定配置：${filename}`)
  }, [normalizedProfile])

  const handleImportClick = useCallback(() => {
    importInputRef.current?.click()
  }, [])

  const handleImportFile = useCallback((event) => {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result || "{}"))
        const imported = parseFaceRigImport(data)
        resetAllMouthFivebarKinematics()
        const saved = saveFaceRigProfile(imported)
        setProfile(saved)
        setSendStatus(`已导入并生效：${saved.name || file.name}（本地旧绑定已替换）`)
      } catch (error) {
        setSendStatus(`导入失败：${error.message}`)
      } finally {
        event.target.value = ""
      }
    }
    reader.readAsText(file)
  }, [resetAllMouthFivebarKinematics])

  const handleProfileNameChange = useCallback((name) => {
    setProfile((prev) => {
      const next = normalizeFaceRigProfile({
        ...prev,
        // Allow clearing the input; do not auto-fill while the user deletes text.
        name: name == null ? "" : String(name),
      })
      return next
    })
  }, [])

  const handleResetProfile = useCallback(() => {
    const fresh = createDefaultFaceRigProfile()
    resetAllMouthFivebarKinematics()
    resetAllBrowTipFivebarKinematics()
    setDraggingControlId(null)
    setProfile(fresh)
    setRig(createInitialEliteRig())
    saveFaceRigProfile(fresh)
  }, [resetAllMouthFivebarKinematics, resetAllBrowTipFivebarKinematics, setRig])

  const handleClearAllBindings = useCallback((options = {}) => {
    const skipConfirm = Boolean(options?.skipConfirm)
    const n = (normalizedProfile.bindings || []).length
    if (n === 0) {
      setSendStatus("当前没有绑定可清除")
      return
    }
    if (!skipConfirm) {
      const ok = window.confirm(
        `确认清除全部 ${n} 条绑定？\n\n不会自动恢复默认绑定，需自行「新增绑定」或「恢复默认映射」。\n嘴角五杆运行时基线也会一并清除。`
      )
      if (!ok) return
    }
    resetAllMouthFivebarKinematics()
    clearRightMouthRuntimeBaseline()
    clearLeftMouthRuntimeBaseline()
    const next = clearAllBindings(normalizedProfile)
    const saved = saveFaceRigProfile(next)
    setProfile(saved)
    setSendStatus(`已清除全部 ${n} 条绑定并已保存`)
  }, [normalizedProfile, resetAllMouthFivebarKinematics])

  const handleBindingsReplace = useCallback((nextBindings) => {
    resetAllMouthFivebarKinematics()
    lastManualSentPwmRef.current.clear()
    /* 清 RJ Motion 估计，避免改方向后仍按旧目标 defer / 估时 */
    resetRjHostMotionState()
    const next = normalizeFaceRigProfile({
      ...normalizedProfileRef.current,
      bindings: nextBindings,
      updatedAt: new Date().toISOString(),
    })
    for (const b of next.bindings) {
      traceBindingNormalized(b)
    }
    normalizedProfileRef.current = next
    setProfile(next)
    /* 改方向/行程后：若已开实时预览，按当前控件姿态立刻重发（非端点硬预览） */
    if (realtimePreviewRef.current) {
      pendingBindingPreviewRef.current = true
      queueMicrotask(() => {
        const fn = pushToServoRef.current
        if (fn) {
          void fn({
            realtime: true,
            silent: true,
            tracking: false,
            bindingPreview: true,
          })
        }
      })
    }
  }, [resetAllMouthFivebarKinematics])

  const captureBindingNeutralFromWorkbench = useCallback(
    (bindingId) => {
      const binding = normalizedProfile.bindings.find((b) => b.bindingId === bindingId)
      if (!binding) {
        return { ok: false, message: "未找到绑定条目" }
      }

      const fiveBarCapture = resolveMouthCornerNeutralCapture(binding, kinematics)
      const jawCapture = fiveBarCapture ? null : resolveJawNeutralCapture(binding, kinematics)
      const contribLm = contributions.find((c) => c.bindingId === bindingId)?.logicalPwm
      const lm = fiveBarCapture?.pwm ?? jawCapture?.pwm ?? contribLm

      if (!Number.isFinite(lm)) {
        return {
          ok: false,
          message: fiveBarCapture
            ? "五杆 IK 无有效 logicalPwm"
            : binding.controlId === "jaw_A" || binding.controlId === "jaw_D"
              ? "下颌 3D IK 无有效 logicalPwm（请确认 jaw_A/jaw_D 已绑定且 IK 成功）"
              : "无 contribution：请先启用绑定并拖动控件",
        }
      }

      const rounded = Math.round(Number(lm))
      if (fiveBarCapture) {
        persistMouthLabNeutralPwm(fiveBarCapture.sideId, {
          [fiveBarCapture.labParam]: rounded,
        })
        setMouthRuntimeVersion((v) => v + 1)
      }

      resetAllMouthFivebarKinematics()
      setProfile((prev) => {
        const nextBindings = prev.bindings.map((b) => {
          const sameRow = b.bindingId === bindingId
          const sameHwFiveBar =
            fiveBarCapture &&
            b.controlId === fiveBarCapture.controlId &&
            b.channel === fiveBarCapture.channel &&
            Number(b.servoId) === fiveBarCapture.hwServoId
          if (!sameRow && !sameHwFiveBar) {
            return b
          }
          return normalizeBinding({
            ...b,
            neutralPwm: rounded,
            rangeMode: BINDING_RANGE_MODE_CUSTOM,
          })
        })
        return normalizeFaceRigProfile({
          ...prev,
          bindings: nextBindings,
          updatedAt: new Date().toISOString(),
        })
      })

      const servoLabel = fiveBarCapture?.hwServoId ?? jawCapture?.hwServoId ?? binding.servoId
      const msg = fiveBarCapture
        ? `已设为中位（五杆 IK）：servo ${servoLabel} → logical ${rounded}（已同步 Lab 校准）`
        : jawCapture
          ? `已设为中位（下颌 3D IK）：servo ${servoLabel} → logical ${rounded}`
          : `已设为中位：logical ${rounded}`
      return { ok: true, message: msg, pwm: rounded, hwServoId: servoLabel }
    },
    [
      normalizedProfile.bindings,
      kinematics,
      contributions,
      resetAllMouthFivebarKinematics,
    ]
  )

  const EYE_QUICK_TEST_POSES = useMemo(
    () => ({
      neutral: { eyeL: { up: 0, lo: 0 }, eyeR: { up: 0, lo: 0 } },
      close: { eyeL: { up: -45, lo: 45 }, eyeR: { up: -45, lo: 45 } },
      open: { eyeL: { up: 35, lo: -15 }, eyeR: { up: 35, lo: -15 } },
      sync: { eyeL: { up: 22, lo: -12 }, eyeR: { up: 22, lo: -12 } },
    }),
    []
  )

  const runEyeQuickTest = useCallback(
    async (poseKey) => {
      const patch = EYE_QUICK_TEST_POSES[poseKey]
      if (!patch) {
        setSendStatus(`未知眼皮测试：${poseKey}`)
        return
      }
      const newRig = {
        ...rigRef.current,
        eyeL: { ...rigRef.current.eyeL, ...patch.eyeL },
        eyeR: { ...rigRef.current.eyeR, ...patch.eyeR },
      }
      lastRealtimeSourceRef.current = "manual"
      rigRef.current = newRig
      _setRig(newRig)

      const state = buildBindingWorkbenchState({
        previewRigFrame: newRig,
        bindingConfig: normalizedProfile,
        configs,
        mapFaceRigToPoseOptions,
        outputMode,
        driveArmed,
        busSerialConnected: isSharedBusWireConnected(),
        timeMs: 500,
        sourceType: "manual",
      })

      if (driveArmed && state.gates?.canSend) {
        const latestActuators = loadActuatorProfiles()
        const res = await dispatchBindingWorkbenchOutputs({
          finalServoOutputs: state.finalServoOutputs,
          outputMode,
          driveArmed,
          configs,
          actuatorProfiles: latestActuators.actuatorProfiles,
          profilesReady: latestActuators.allowRealSend,
          timeMs: 500,
          txMode: "single-write",
        })
        setLastDispatch(res)
        setSendStatus(res.ok ? `眼皮测试 ${poseKey} 已下发` : res.error || res.message || "眼皮测试下发失败")
      } else {
        setSendStatus(`眼皮测试 ${poseKey}（仅诊断，未 Arm）`)
      }
    },
    [
      EYE_QUICK_TEST_POSES,
      normalizedProfile,
      configs,
      mapFaceRigToPoseOptions,
      outputMode,
      driveArmed,
    ]
  )

  const migrateToBusSemantics = useCallback((options = {}) => {
    const skipConfirm = Boolean(options?.skipConfirm)
    if (!skipConfirm) {
      const ok = window.confirm(
        "迁移为 Bus Servo 绑定语义：\n\n" +
          "• 为所有 binding 补 actuatorKey\n" +
          "• active binding 的 neutralPwm 归一到 1500（保留相对正负行程）\n" +
          "• 默认禁用 tongue / servo_11\n\n" +
          "机械零点仍由 actuator profile 的 installed_center 管理。\n\n继续？"
      )
      if (!ok) {
        return
      }
    }
    const migrated = migrateFaceRigProfileToBusSemantics(normalizedProfile)
    resetAllMouthFivebarKinematics()
    setProfile(migrated)
    saveFaceRigProfile(migrated)
    setSendStatus("已迁移为 Bus Servo 绑定语义（neutral=1500，tongue 默认禁用）")
  }, [normalizedProfile, resetAllMouthFivebarKinematics])

  const markControlIgnored = useCallback((controlId) => {
    setProfile((prev) =>
      normalizeFaceRigProfile({
        ...prev,
        ignoredControls: [...new Set([...(prev.ignoredControls || []), String(controlId)])],
        updatedAt: new Date().toISOString(),
      })
    )
    setSendStatus(`已标记 ${controlId} 为暂不使用`)
  }, [])

  const unmarkControlIgnored = useCallback((controlId) => {
    setProfile((prev) =>
      normalizeFaceRigProfile({
        ...prev,
        ignoredControls: (prev.ignoredControls || []).filter((id) => id !== controlId),
        updatedAt: new Date().toISOString(),
      })
    )
    setSendStatus(`已取消 ${controlId} 的暂不使用标记`)
  }, [])

  const radarLPx = eyeRadarDisplayPx(rig.eyeL?.x ?? rig.sharedRadar?.x ?? 50, rig.eyeL?.y ?? rig.sharedRadar?.y ?? 50)
  const radarRPx = eyeRadarDisplayPx(rig.eyeR?.x ?? rig.sharedRadar?.x ?? 50, rig.eyeR?.y ?? rig.sharedRadar?.y ?? 50)
  const radarLCxPx = radarLPx.cxPx
  const radarLCyPx = radarLPx.cyPx
  const radarRCxPx = radarRPx.cxPx
  const radarRCyPx = radarRPx.cyPx
  /** @deprecated 兼容旧调用方；取左右均值光标 */
  const radarCxPx = (radarLCxPx + radarRCxPx) / 2
  const radarCyPx = (radarLCyPx + radarRCyPx) / 2

  return {
    profile,
    setProfile,
    normalizedProfile,
    rig,
    setRig,
    rigValues,
    logicalPose,
    actualPose,
    contributions,
    warnings,
    kinematics,
    outputMode,
    setOutputMode,
    driveArmed,
    setDriveArmed,
    toggleDriveArm,
    workbenchState,
    lastDispatch,
    testMode,
    testBindingId,
    runBindingTest,
    serialStatus,
    sendStatus,
    setSendStatus,
    realtimePreview,
    setRealtimePreview,
    selectedControlId,
    setSelectedControlId,
    selectedChannel,
    setSelectedChannel,
    draggingControlId,
    setDraggingControlId,
    pushToServo,
    setRigFromWebTracking,
    realtimeTuning,
    setRealtimeTuning,
    realtimeServoFps,
    importInputRef,
    padLRef,
    padRRef,
    handleSaveProfile,
    handleExportProfile,
    handleImportClick,
    handleImportFile,
    handleProfileNameChange,
    handleResetProfile,
    handleClearAllBindings,
    handleBindingsReplace,
    captureBindingNeutralFromWorkbench,
    handleFixActuatorBusAlignment,
    actuatorProfileReloadNonce,
    migrateToBusSemantics,
    runEyeQuickTest,
    markControlIgnored,
    unmarkControlIgnored,
    resetEngine,
    mapFaceRigToPoseOptions,
    mouthRuntimeVersion,
    reloadRightMouthRuntime: () => setMouthRuntimeVersion((v) => v + 1),
    reloadLeftMouthRuntime: () => setMouthRuntimeVersion((v) => v + 1),
    reloadMouthRuntimes: () => setMouthRuntimeVersion((v) => v + 1),
    resetRightMouthCornerFivebarKinematics,
    resetLeftMouthCornerFivebarKinematics,
    resetMouthFivebarKinematics,
    resetAllMouthFivebarKinematics,
    startRadar,
    eyeRadarAdjustArmed,
    radarCxPx,
    radarCyPx,
    radarLCxPx,
    radarLCyPx,
    radarRCxPx,
    radarRCyPx,
  }
}
