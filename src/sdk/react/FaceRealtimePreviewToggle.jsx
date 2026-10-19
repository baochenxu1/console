const DEFAULT_TITLE =
  "开启后每 30ms 下发到总线舵机（通信模式与串口胶囊一致）"

/**
 * 表情编排 / 面部绑定共用的实时预览滑动开关。
 * Neck「硬件预览」复用同一控件形态。
 *
 * @param {object} props
 * @param {boolean} props.checked
 * @param {(checked: boolean) => void} props.onChange
 * @param {string} [props.title]
 * @param {string} [props.label]
 * @param {boolean} [props.disabled]
 * @param {string} [props.className]
 */
export default function FaceRealtimePreviewToggle({
  checked,
  onChange,
  title = DEFAULT_TITLE,
  label = "实时预览",
  disabled = false,
  className = "",
}) {
  return (
    <div className={`face-expression-realtime-group${className ? ` ${className}` : ""}`}>
      <label
        className={`face-expression-realtime face-expression-realtime--compact${
          disabled ? " is-disabled" : ""
        }`}
        title={title}
      >
        <input
          type="checkbox"
          className="face-expression-realtime-input"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="face-expression-realtime-switch" aria-hidden />
        <span className="face-expression-realtime-copy">
          <span className="face-expression-realtime-title">{label}</span>
        </span>
      </label>
    </div>
  )
}
