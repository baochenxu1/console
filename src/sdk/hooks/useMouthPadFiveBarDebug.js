import { useCallback, useMemo, useRef, useState } from "react"
import {
  buildRightMouthFkProjectionMap,
  buildRightMouthPadReachabilityMap,
  evaluateRightMouthPadPoint,
  rightMouthPadReachabilityParamsKey,
} from "../kinematics/mouthCornerFivebarDebug.js"
import { createRightMouthCornerFivebarState } from "../kinematics/mouthCornerFivebar.js"
import { resolveMouthCornerKinematics } from "../kinematics/mouthCornerKinematics.js"
import { getMouthCornerLabSide } from "../kinematics/mouthCornerFiveBarLabConfig.js"
import { useRightMouthFiveBarRuntime } from "./useRightMouthFiveBarRuntime.js"
import { useLeftMouthFiveBarRuntime } from "./useLeftMouthFiveBarRuntime.js"

/**
 * @param {import("../kinematics/mouthCornerFiveBarLabConfig.js").MouthCornerLabSideId | string} sideId
 */
function useMouthRuntimeForSide(sideId) {
  const right = useRightMouthFiveBarRuntime()
  const left = useLeftMouthFiveBarRuntime()
  return sideId === "left" ? left : right
}

/**
 * Pad 可达区 Debug（左右嘴角共用 FiveBar 核心，参数由 side / calibration 区分）。
 *
 * @param {object} args
 * @param {import("../kinematics/mouthCornerFiveBarLabConfig.js").MouthCornerLabSideId | string} args.sideId
 */
export function useMouthPadFiveBarDebug({
  sideId = "right",
  profile,
  configs = [],
  pad,
  enabled = true,
  outputMode = "static-target",
  kinematicsOverride = null,
  mapStep = 2,
  skipReachabilityMap = false,
}) {
  const { runtime: rt, version: runtimeVersion } = useMouthRuntimeForSide(sideId)
  const side = getMouthCornerLabSide(sideId)
  const kinKey = sideId === "left" ? "leftMouthCornerFiveBar" : "rightMouthCornerFiveBar"

  const kinematics = kinematicsOverride || {
    [kinKey]: {
      enabled: true,
      runtimeOutputMode: rt.runtime.outputMode,
      ...rt.params,
    },
  }

  const resolved = useMemo(() => {
    const kinSlice =
      kinematics?.[kinKey] ?? kinematics?.rightMouthCornerFiveBar ?? kinematics
    return resolveMouthCornerKinematics(profile, sideId, {
      runtimeParams: kinematicsOverride ? kinSlice : rt.params,
      runtimeBindingOverride: rt.bindingOverride,
      kinematics,
      runtimeSource: kinematicsOverride ? "lab-live" : rt.source,
    })
  }, [profile, sideId, kinematics, kinKey, runtimeVersion, kinematicsOverride, rt.params, rt.bindingOverride, rt.source])

  const params = resolved.params
  const paramsKey = useMemo(() => rightMouthPadReachabilityParamsKey(params), [params])

  const reachabilityMap = useMemo(() => {
    if (!enabled || !resolved.readyForIk || skipReachabilityMap) {
      return null
    }
    return buildRightMouthPadReachabilityMap({ params, step: mapStep, sideId })
  }, [enabled, resolved.readyForIk, skipReachabilityMap, paramsKey, mapStep])

  const evalStateRef = useRef(createRightMouthCornerFivebarState())

  const padX = Number(pad?.x)
  const padY = Number(pad?.y)

  const currentEval = useMemo(() => {
    if (!enabled || !resolved.readyForIk) {
      return null
    }
    return evaluateRightMouthPadPoint({
      pad: { x: padX, y: padY },
      params,
      state: evalStateRef.current,
      bindingA: resolved.bindingA,
      bindingB: resolved.bindingB,
      servoAId: resolved.servoAId,
      servoBId: resolved.servoBId,
      configs,
      outputMode,
      sideId,
    })
  }, [
    enabled,
    resolved.readyForIk,
    resolved.bindingA,
    resolved.bindingB,
    resolved.servoAId,
    resolved.servoBId,
    padX,
    padY,
    paramsKey,
    outputMode,
    configs,
  ])

  const [fkProjectionMap, setFkProjectionMap] = useState(null)
  const [fkProjectionBusy, setFkProjectionBusy] = useState(false)

  const rebuildFkProjection = useCallback(() => {
    if (!resolved.readyForIk) {
      setFkProjectionMap(null)
      return
    }
    setFkProjectionBusy(true)
    window.setTimeout(() => {
      try {
        const map = buildRightMouthFkProjectionMap({ params, qStep: 2, sideId })
        setFkProjectionMap(map)
      } finally {
        setFkProjectionBusy(false)
      }
    }, 0)
  }, [resolved.readyForIk, paramsKey])

  return {
    sideId: side.id,
    resolved,
    reachabilityMap,
    currentEval,
    fkProjectionMap,
    fkProjectionBusy,
    rebuildFkProjection,
  }
}
