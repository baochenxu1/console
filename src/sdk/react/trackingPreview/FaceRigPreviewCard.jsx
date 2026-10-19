import FaceRigPreviewCanvas from "../FaceRigPreviewCanvas.jsx"
import { useFaceRigPreviewScale } from "./useFaceRigPreviewScale.js"

/**
 * @param {object} props
 * @param {object} props.rig
 * @param {boolean} [props.deviceDriveActive]
 */
export default function FaceRigPreviewCard({ rig, deviceDriveActive = false }) {
  const { containerRef, contentRef, scale, baseWidth, baseHeight } = useFaceRigPreviewScale([rig])

  return (
    <section
      className={`tp-monitor-card tp-monitor-card--rig-hero tp-face-rig-column${
        deviceDriveActive ? " tp-monitor-card--device-drive" : ""
      }`}
    >
      <header className="tp-monitor-card-head tp-monitor-card-head--compact">
        <h2 className="tp-monitor-card-title">Face Rig</h2>
        <span className="tp-monitor-card-tag">Digital Twin</span>
      </header>
      <div className="face-rig-viewport" ref={containerRef}>
        <div
          className="scaling-engine-wrapper"
          ref={contentRef}
          style={{
            width: baseWidth,
            height: baseHeight,
            transform: `scale(${scale})`,
          }}
        >
          <FaceRigPreviewCanvas rig={rig} />
        </div>
      </div>
    </section>
  )
}
