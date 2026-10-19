import { useEffect, useMemo, useState } from "react"
import {
  LEFT_MOUTH_BASELINE_CHANGED_EVENT,
  getLeftMouthFiveBarRuntime,
  reloadLeftMouthRuntimeBaseline,
} from "../kinematics/leftMouthFiveBarRuntime.js"

export function useLeftMouthFiveBarRuntime() {
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const onChanged = () => setVersion((v) => v + 1)
    window.addEventListener(LEFT_MOUTH_BASELINE_CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(LEFT_MOUTH_BASELINE_CHANGED_EVENT, onChanged)
  }, [])

  const runtime = useMemo(() => getLeftMouthFiveBarRuntime(), [version])

  const reload = () => {
    reloadLeftMouthRuntimeBaseline()
  }

  return { runtime, version, reload }
}
