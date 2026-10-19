import { useCallback, useMemo, useRef } from "react"
import FaceRigWorkspace from "../../components/FaceRigWorkspace.jsx"
import { eyeRadarDisplayPx } from "../../hooks/useFaceRigInteraction.js"
import { normalizeEliteRig as normalizeTrackingEliteRig } from "../tracking/trackingMapper.js"
import { normalizeEliteRig as upgradeEliteRigFields } from "../../core/faceDofMapper.js"
import { useFaceRigPreviewScale } from "./trackingPreview/useFaceRigPreviewScale.js"

/**
 * 只读 Face Rig 控件预览：用于映射预览页等，不驱动 binding、不写串口。
 * @param {{ rig: object, fitMode?: "none" | "contain", className?: string, variant?: "default" | "preset" }} props
 */
export default function FaceRigPreviewCanvas({
  rig,
  fitMode = "none",
  className = "",
  variant = "default",
}) {
  const padLRef = useRef(null)
  const padRRef = useRef(null)
  const contain = fitMode === "contain"
  const presetVariant = variant === "preset"
  const { containerRef, contentRef, scale, baseWidth, baseHeight } = useFaceRigPreviewScale(
    contain ? [rig, variant] : [],
    { safePadding: presetVariant ? 8 : undefined }
  )

  const normalized = useMemo(() => upgradeEliteRigFields(normalizeTrackingEliteRig(rig)), [rig])

  const radarLPx = useMemo(
    () => eyeRadarDisplayPx(normalized.eyeL?.x ?? 50, normalized.eyeL?.y ?? 50),
    [normalized]
  )
  const radarRPx = useMemo(
    () => eyeRadarDisplayPx(normalized.eyeR?.x ?? 50, normalized.eyeR?.y ?? 50),
    [normalized]
  )

  const noop = useCallback(() => {}, [])
  const startRadar = useCallback((e) => {
    e?.preventDefault?.()
    e?.stopPropagation?.()
  }, [])

  const canvas = (
    <div
      className={`sdk-face-rig-preview-canvas${contain ? " sdk-face-rig-preview-canvas--contain" : ""}${
        presetVariant ? " sdk-face-rig-preview-canvas--preset" : ""
      }`}
      aria-label="Face Rig 映射预览（只读）"
    >
      <FaceRigWorkspace
        rig={normalized}
        setRig={noop}
        setSelectedControlId={noop}
        setDraggingControlId={noop}
        padLRef={padLRef}
        padRRef={padRRef}
        startRadar={startRadar}
        radarLCxPx={radarLPx.cxPx}
        radarLCyPx={radarLPx.cyPx}
        radarRCxPx={radarRPx.cxPx}
        radarRCyPx={radarRPx.cyPx}
      />
    </div>
  )

  if (!contain) {
    return className ? <div className={className}>{canvas}</div> : canvas
  }

  return (
    <div className={`sdk-face-rig-preview-fit${className ? ` ${className}` : ""}`} ref={containerRef}>
      <div
        className="sdk-face-rig-preview-fit-inner"
        ref={contentRef}
        style={{
          width: baseWidth,
          height: baseHeight,
          transform: `scale(${scale})`,
        }}
      >
        {canvas}
      </div>
    </div>
  )
}
