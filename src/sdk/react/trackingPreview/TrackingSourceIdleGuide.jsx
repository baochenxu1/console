import { TRACKING_SOURCE_IDLE_GUIDE } from "../../trackingPreview/trackingPreviewConstants.js"

/**
 * 顶部 Source 各模式说明（idle 预览区用）。
 */
export default function TrackingSourceIdleGuide({
  title = "Tracking 输入源待机",
  note = "Camera 需先选择设备，确认后才会打开摄像头。",
}) {
  return (
    <div className="tp-source-idle-guide">
      <p className="tp-source-idle-guide__title">{title}</p>
      <p className="tp-source-idle-guide__lead">请在顶部 Source 选择输入模式：</p>
      <ul className="tp-source-idle-guide__list">
        {TRACKING_SOURCE_IDLE_GUIDE.map((item) => (
          <li key={item.id}>
            <strong>{item.label}</strong>
            <span>{item.desc}</span>
          </li>
        ))}
      </ul>
      <p className="tp-source-idle-guide__note">{note}</p>
    </div>
  )
}
