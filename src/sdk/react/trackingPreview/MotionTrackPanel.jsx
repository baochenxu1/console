import { MOTION_TRACK_VERSION } from "../../trackingPreview/trackingPreviewConstants.js"
import PreviewViewportPlaceholder from "./PreviewViewportPlaceholder.jsx"
import VideoStatusHud from "./VideoStatusHud.jsx"

export default function MotionTrackPanel() {
  return (
    <>
      <PreviewViewportPlaceholder
        variant="motion"
        emptyTitle="No motion track loaded"
        emptyHint="Import a motion track JSON to preview playback"
        statusHud={<VideoStatusHud status={{}} />}
      />

      <div className="tp-source-toolbar tp-source-toolbar--disabled">
        <button type="button" className="tp-btn-start" disabled>
          Import
        </button>
        <button type="button" className="tp-btn-stop" disabled>
          Play
        </button>
      </div>

      <p className="tp-phase-hint">
        格式 <code>{MOTION_TRACK_VERSION}</code> — Phase 4.3
      </p>
    </>
  )
}
