import { TRACKING_PREVIEW_TAB_LABELS } from "../../trackingPreview/trackingPreviewConstants.js"

/**
 * @param {object} props
 * @param {string} [props.activeTab]
 * @param {React.ReactNode} props.children
 */
export default function SourcePreviewCard({ activeTab, children }) {
  const tag = activeTab ? TRACKING_PREVIEW_TAB_LABELS[activeTab] : "Source"

  return (
    <section className="tp-monitor-card tp-monitor-card--main-source">
      <header className="tp-monitor-card-head tp-monitor-card-head--compact">
        <h2 className="tp-monitor-card-title">Source Preview</h2>
        <span className="tp-monitor-card-tag">{tag}</span>
      </header>
      <div className="tp-main-source-body">{children}</div>
    </section>
  )
}
