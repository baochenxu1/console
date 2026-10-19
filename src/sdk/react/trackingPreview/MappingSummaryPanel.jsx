function fmt2(v) {
  return Number.isFinite(Number(v)) ? Number(v).toFixed(2) : "—"
}

function Row({ label, value }) {
  return (
    <div className="tracking-preview-kv">
      <span className="tracking-preview-k">{label}</span>
      <span className="tracking-preview-v">{value}</span>
    </div>
  )
}

/**
 * @param {object} props
 * @param {object} props.previewRig
 * @param {object | null | undefined} props.mapping
 * @param {import("../../trackingPreview/trackingPreviewConstants.js").TrackingPreviewDriveMode} props.driveMode
 * @param {object | null | undefined} [props.servoDiagnostics]
 */
export default function MappingSummaryPanel({ previewRig, mapping, driveMode, servoDiagnostics }) {
  const mapv = mapping && typeof mapping === "object" ? mapping : null
  const k = servoDiagnostics?.kinematics

  return (
    <section className="tracking-preview-mapping-card">
      <h3 className="tracking-preview-card-title">Mapping Summary</h3>
      <h4 className="tracking-preview-subtitle">Mouth / Jaw</h4>
      <Row
        label="mouth.sideL"
        value={`${fmt2(previewRig?.mouth?.sideL?.x)} / ${fmt2(previewRig?.mouth?.sideL?.y)}`}
      />
      <Row
        label="mouth.sideR"
        value={`${fmt2(previewRig?.mouth?.sideR?.x)} / ${fmt2(previewRig?.mouth?.sideR?.y)}`}
      />
      <Row label="jaw" value={fmt2(previewRig?.jaw?.open ?? previewRig?.jaw)} />
      {mapv ? (
        <>
          <h4 className="tracking-preview-subtitle">debug.mapping</h4>
          <Row label="smileL/R" value={`${fmt2(mapv.smileLeft)} / ${fmt2(mapv.smileRight)}`} />
          <Row label="sharedRadar" value={`${fmt2(mapv.sharedRadarX)} / ${fmt2(mapv.sharedRadarY)}`} />
          <Row label="blinkL/R" value={`${fmt2(mapv.blinkLeft)} / ${fmt2(mapv.blinkRight)}`} />
        </>
      ) : (
        <p className="hint">等待 tracking 帧…</p>
      )}
      {driveMode === "dry-run" && servoDiagnostics ? (
        <>
          <h4 className="tracking-preview-subtitle">Dry Run · Command Preview</h4>
          <Row
            label="logicalPose keys"
            value={
              servoDiagnostics.logicalPose
                ? String(Object.keys(servoDiagnostics.logicalPose).length)
                : "—"
            }
          />
          {k?.rightMouthCorner ? (
            <Row
              label="rightMouth PWM"
              value={`${k.logicalPwmA ?? "—"} / ${k.logicalPwmB ?? "—"}`}
            />
          ) : null}
          {k?.leftMouthCorner ? (
            <Row
              label="leftMouth PWM"
              value={`${k.logicalPwmA ?? "—"} / ${k.logicalPwmB ?? "—"}`}
            />
          ) : null}
          <p className="hint tracking-preview-dry-hint">Dry Run 不写入 WebSerial。</p>
        </>
      ) : null}
      {driveMode === "device-drive" ? (
        <p className="hint tracking-preview-dry-hint">
          Device Drive：Arm 后满足门控条件时自动写串口；Stop All 将 Disarm。
        </p>
      ) : null}
    </section>
  )
}
