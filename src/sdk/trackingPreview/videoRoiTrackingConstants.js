/** Phase 2.3/2.4 — Video ROI tracking 选项（Preview Only）。 */

export const ROI_TRACKING_OFF = "off"

export const ROI_TRACKING_OPTIONS = [
  { id: ROI_TRACKING_OFF, label: "Off", mode: "full-frame", multiplier: null },
  { id: "1.5", label: "1.5x", mode: "roi-tracking", multiplier: 1.5 },
  { id: "1.8", label: "1.8x", mode: "roi-tracking", multiplier: 1.8 },
  { id: "2.0", label: "2.0x", mode: "roi-tracking", multiplier: 2.0 },
  { id: "stable-1.5", label: "Stable 1.5x", mode: "stable-roi", multiplier: 1.5 },
  { id: "stable-1.8", label: "Stable 1.8x", mode: "stable-roi", multiplier: 1.8 },
  { id: "stable-2.0", label: "Stable 2.0x", mode: "stable-roi", multiplier: 2.0 },
]

export function resolveRoiTrackingControl(optionId) {
  const opt =
    ROI_TRACKING_OPTIONS.find((o) => o.id === optionId) ?? ROI_TRACKING_OPTIONS[0]
  const roiMode = opt.mode === "full-frame" ? "full-frame" : opt.mode
  return {
    action: "setRoiTracking",
    mode: roiMode,
    enabled: roiMode === "roi-tracking" || roiMode === "stable-roi",
    multiplier: opt.multiplier,
  }
}

export function formatRoiTrackingLabel(optionId) {
  const opt = ROI_TRACKING_OPTIONS.find((o) => o.id === optionId)
  return opt?.label ?? "Off"
}
