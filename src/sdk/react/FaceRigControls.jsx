import FaceRigControlConsole from "../../components/FaceRigControlConsole.jsx"
import FaceRigWorkspace from "../../components/FaceRigWorkspace.jsx"

/**
 * SDK 包装的面部控件（不含绑定检视）。
 * - workspace：整脸示意图（绑定页）
 * - console：左右分区控制台（表情编排页）
 */
export default function FaceRigControls({
  variant = "workspace",
  rigState,
  onRigStateChange,
  setSelectedControlId,
  setSelectedChannel,
  selectedControlId,
  draggingControlId,
  setDraggingControlId,
  padLRef,
  padRRef,
  startRadar,
  radarCxPx,
  radarCyPx,
  radarLCxPx,
  radarLCyPx,
  radarRCxPx,
  radarRCyPx,
  eyeRadarAdjustArmed = null,
  showFiveBarReachabilityOverlay = false,
  rightMouthPadReachabilityMap = null,
  rightMouthPadEval = null,
  neckSlot = null,
}) {
  const shared = {
    rig: rigState,
    setRig: onRigStateChange,
    setSelectedControlId,
    setSelectedChannel,
    setDraggingControlId,
    padLRef,
    padRRef,
    startRadar,
    radarCxPx: radarLCxPx ?? radarCxPx,
    radarCyPx: radarLCyPx ?? radarCyPx,
    radarLCxPx: radarLCxPx ?? radarCxPx,
    radarLCyPx: radarLCyPx ?? radarCyPx,
    radarRCxPx: radarRCxPx ?? radarCxPx,
    radarRCyPx: radarRCyPx ?? radarCyPx,
    eyeRadarAdjustArmed,
    showFiveBarReachabilityOverlay,
    rightMouthPadReachabilityMap,
    rightMouthPadEval,
    neckSlot,
  }

  if (variant === "console") {
    return (
      <FaceRigControlConsole
        {...shared}
        selectedControlId={selectedControlId}
        draggingControlId={draggingControlId}
      />
    )
  }

  return <FaceRigWorkspace {...shared} selectedControlId={selectedControlId} draggingControlId={draggingControlId} />
}
