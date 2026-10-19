import { useEffect, useMemo, useState } from "react"
import {
  RIGHT_MOUTH_BASELINE_CHANGED_EVENT,
  getRightMouthFiveBarRuntime,
  reloadRightMouthRuntimeBaseline,
} from "../kinematics/rightMouthFiveBarRuntime.js"

/**
 * 订阅 Right Mouth runtime baseline 变更（保存 / Reload / 其他页签写入）。
 */
export function useRightMouthFiveBarRuntime() {
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const onChanged = () => setVersion((v) => v + 1)
    window.addEventListener(RIGHT_MOUTH_BASELINE_CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(RIGHT_MOUTH_BASELINE_CHANGED_EVENT, onChanged)
  }, [])

  const runtime = useMemo(() => getRightMouthFiveBarRuntime(), [version])

  const reload = () => {
    reloadRightMouthRuntimeBaseline()
  }

  return { runtime, version, reload }
}
