import { useCallback } from "react"
import FaceBindingEditor from "../sdk/react/FaceBindingEditor.jsx"
import FaceRealtimePreviewToggle from "../sdk/react/FaceRealtimePreviewToggle.jsx"
import { useFaceRigInteraction } from "../hooks/useFaceRigInteraction.js"
import { BINDING_OUTPUT_MODES } from "../sdk/output/bindingWorkbench/index.js"
import SerialCapsulePanel from "../sdk/react/serial/SerialCapsulePanel.jsx"
import "../styles/face-rig.css"

const RAIL_OUTPUT_MODES = [BINDING_OUTPUT_MODES.BUS_SERVO]

export default function FaceRigPage({ configs = [] }) {
  const rig = useFaceRigInteraction(configs)

  const syncDriveArm = useCallback(
    (mode, realtimeOn) => {
      rig.setDriveArmed(Boolean(realtimeOn && RAIL_OUTPUT_MODES.includes(mode)))
    },
    [rig]
  )

  const handleRealtimePreviewChange = useCallback(
    (checked) => {
      const mode = RAIL_OUTPUT_MODES.includes(rig.outputMode)
        ? rig.outputMode
        : BINDING_OUTPUT_MODES.BUS_SERVO
      if (!RAIL_OUTPUT_MODES.includes(rig.outputMode)) {
        rig.setOutputMode(mode)
      }
      rig.setRealtimePreview(checked)
      syncDriveArm(mode, checked)
    },
    [rig, syncDriveArm]
  )

  return (
    <section className="face-rig-page">
      <input
        ref={rig.importInputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: "none" }}
        onChange={rig.handleImportFile}
      />

      <header className="face-rig-header face-rig-header--toolbar" aria-label="面部绑定工具栏">
        <label className="face-rig-header-name" htmlFor="face-rig-doc-name">
          <span className="face-rig-header-name-label">配置名称</span>
          <input
            id="face-rig-doc-name"
            type="text"
            value={rig.normalizedProfile?.name || ""}
            onChange={(e) => rig.handleProfileNameChange(e.target.value)}
            placeholder="未命名面部绑定"
          />
        </label>
        <div className="face-rig-header-rail">
          <SerialCapsulePanel transportMode="bus" />
          <FaceRealtimePreviewToggle
            checked={rig.realtimePreview}
            onChange={handleRealtimePreviewChange}
          />
        </div>
      </header>

      <FaceBindingEditor configs={configs} rigApi={rig} />
    </section>
  )
}
