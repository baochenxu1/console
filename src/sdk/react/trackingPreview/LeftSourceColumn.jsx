import { TRACKING_PREVIEW_TAB_LABELS } from "../../trackingPreview/trackingPreviewConstants.js"
import MappingSummaryCard from "./MappingSummaryCard.jsx"

/**
 * 左栏：视频 + 控制 + 折叠诊断（无外层大卡片包裹）。
 * @param {object} props
 */
export default function LeftSourceColumn({
  activeTab,
  sourcePanel,
  previewRig,
  mapping,
  lipGeometry,
  jawGeometry,
  mouthScenarioClassifier,
  browGate,
  browDebug,
  bypassBrowGate,
  showDeveloperDebug,
  cameraRunning,
  onSetLipNeutral,
  driveMode,
  dryRunResult,
  bindings = null,
}) {
  const tabLabel = activeTab ? TRACKING_PREVIEW_TAB_LABELS[activeTab] : "Source"

  return (
    <div className="tp-left-stack">
      <div className="tp-source-block">
        <p className="tp-source-eyebrow">{tabLabel}</p>
        {sourcePanel}
      </div>
      <MappingSummaryCard
        previewRig={previewRig}
        mapping={mapping}
        lipGeometry={lipGeometry}
        jawGeometry={jawGeometry}
        mouthScenarioClassifier={mouthScenarioClassifier}
        browGate={browGate}
        browDebug={browDebug}
        bypassBrowGate={bypassBrowGate}
        showDeveloperDebug={showDeveloperDebug}
        cameraRunning={cameraRunning}
        onSetLipNeutral={onSetLipNeutral}
        driveMode={driveMode}
        dryRunResult={dryRunResult}
        bindings={bindings}
      />
    </div>
  )
}
