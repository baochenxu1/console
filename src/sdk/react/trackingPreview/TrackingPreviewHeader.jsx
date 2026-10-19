import {
  DRIVE_MODES,
  DRIVE_MODE_LABELS,
  TRACKING_SOURCE_SEGMENT_IDS,
  TRACKING_SOURCE_SEGMENT_LABELS,
} from "../../trackingPreview/trackingPreviewConstants.js"
import {
  isEffectiveSourceSegmentActive,
  resolveSourceSegmentAvailability,
} from "../../trackingPreview/resolveEffectiveTrackingSource.js"
import SerialCapsulePanel from "./SerialCapsulePanel.jsx"

const SOURCE_SEGMENTS = [
  TRACKING_SOURCE_SEGMENT_IDS.IDLE,
  TRACKING_SOURCE_SEGMENT_IDS.CAMERA,
  TRACKING_SOURCE_SEGMENT_IDS.VIDEO,
  TRACKING_SOURCE_SEGMENT_IDS.MOTION_TRACK,
  TRACKING_SOURCE_SEGMENT_IDS.UPLOAD,
]

/**
 * @param {object} props
 */
export default function TrackingPreviewHeader({
  activeTab,
  onSourceSelect,
  effectiveSource = null,
  trackingBackend = "python",
  sourceCapabilityMessage = "",
  driveMode,
  onDriveModeChange,
  outputMode = "bus-servo",
  onOutputModeChange,
  deviceDriveNote = "",
  deviceDriveArmed = false,
  eyeCenterStatus = null,
  transportFamily = "feetech",
  onTransportFamilyChange,
}) {
  void outputMode
  void onOutputModeChange
  const busy = Boolean(effectiveSource?.switching)
  const previewOnlyForced = Boolean(effectiveSource?.previewOnlyForced)
  const sourceError = effectiveSource?.error ? String(effectiveSource.error) : ""

  return (
    <header className="tp-monitor-header">
      <h1 className="tp-monitor-title">Tracking Preview</h1>

      <div className="tp-monitor-header-controls">
        <div className="tp-header-segment-group tp-header-source-group" aria-label="输入源">
          <div className="tp-header-source-row">
            <span className="tp-header-segment-label">Source</span>
            <div className="segmented-control" role="tablist">
              {SOURCE_SEGMENTS.map((segmentId) => {
                const active = isEffectiveSourceSegmentActive(
                  segmentId,
                  effectiveSource,
                  activeTab
                )
                const availability = resolveSourceSegmentAvailability(
                  trackingBackend,
                  segmentId
                )
                const disabled = busy || !availability.allowed
                return (
                  <button
                    key={segmentId}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    disabled={disabled}
                    title={
                      availability.allowed
                        ? undefined
                        : availability.hint || "当前 Runtime 不支持"
                    }
                    className={`segmented-btn${active ? " active" : ""}${
                      !availability.allowed ? " segmented-btn--disabled" : ""
                    }`}
                    onClick={() => onSourceSelect?.(segmentId)}
                  >
                    {TRACKING_SOURCE_SEGMENT_LABELS[segmentId]}
                  </button>
                )
              })}
            </div>
          </div>
          {(busy ||
            previewOnlyForced ||
            sourceError ||
            sourceCapabilityMessage ||
            trackingBackend === "browser") ? (
            <div className="tp-header-source-meta">
              {busy ? (
                <span className="tp-header-source-meta-busy">Switching…</span>
              ) : null}
              {!busy && previewOnlyForced ? <span>Preview only</span> : null}
              {trackingBackend === "browser" && !sourceCapabilityMessage ? (
                <span className="tp-header-source-meta-hint">
                  Browser：Camera 可用 · Video/Upload 需 Python Runtime
                </span>
              ) : null}
              {sourceCapabilityMessage ? (
                <span className="tp-header-source-meta-hint">{sourceCapabilityMessage}</span>
              ) : null}
              {sourceError ? (
                <span className="tp-header-source-meta-error">{sourceError}</span>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="tp-header-segment-group tp-header-eye-center-group" aria-label="Eye center">
          <span className="tp-header-segment-label">Eye Center</span>
          <span className="tp-header-eye-center-value">
            {eyeCenterStatus?.mode === "auto" ? "Auto" : "—"}
            {eyeCenterStatus?.collecting ? "…" : ""}
          </span>
        </div>

        <div className="tp-header-segment-group" aria-label="Drive Mode">
          <span className="tp-header-segment-label">Drive</span>
          <div className="segmented-control" role="radiogroup">
            {Object.values(DRIVE_MODES).map((mode) => {
              const isDevice = mode === DRIVE_MODES.DEVICE_DRIVE
              const armed = isDevice && deviceDriveArmed && driveMode === DRIVE_MODES.DEVICE_DRIVE
              return (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={driveMode === mode}
                  title={armed ? "Device Drive 已 Arm" : undefined}
                  className={`segmented-btn${
                    driveMode === mode ? " active" : ""
                  }${isDevice ? " segmented-btn--caution" : ""}${
                    armed ? " segmented-btn--armed" : ""
                  }`}
                  onClick={() => onDriveModeChange(mode)}
                >
                  {DRIVE_MODE_LABELS[mode]}
                  {armed ? " ●" : ""}
                </button>
              )
            })}
          </div>
        </div>

        <SerialCapsulePanel
          transportFamily={transportFamily}
          onTransportFamilyChange={onTransportFamilyChange}
        />
      </div>

      {driveMode === DRIVE_MODES.DEVICE_DRIVE && deviceDriveNote ? (
        <p className="tp-monitor-header-warn" role="status">
          {deviceDriveNote}
        </p>
      ) : null}
    </header>
  )
}
