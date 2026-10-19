import { useMouthPadFiveBarDebug } from "./useMouthPadFiveBarDebug.js"

/** @deprecated 使用 useMouthPadFiveBarDebug({ sideId: "right", ... }) */
export function useRightMouthPadFiveBarDebug(args) {
  return useMouthPadFiveBarDebug({ sideId: "right", ...args })
}
