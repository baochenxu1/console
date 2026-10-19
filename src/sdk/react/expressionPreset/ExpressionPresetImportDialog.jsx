import { PRESET_USER_GROUPS } from "../../expression/expressionPresetImport.js"

/**
 * Lightweight import / replace confirm dialog.
 */
export default function ExpressionPresetImportDialog({
  open,
  title = "导入表情",
  draft,
  name,
  group,
  confirmLabel = "导入",
  onNameChange,
  onGroupChange,
  onCancel,
  onConfirm,
}) {
  if (!open || !draft) return null
  const durationSec = (Number(draft.durationMs) / 1000).toFixed(1)
  return (
    <div className="xp-modal-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="xp-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="xp-modal-head">
          <h3>{title}</h3>
        </header>
        <div className="xp-modal-body">
          <label className="xp-modal-field">
            <span>名称</span>
            <input type="text" value={name} onChange={(e) => onNameChange(e.target.value)} />
          </label>
          <label className="xp-modal-field">
            <span>分类</span>
            <select value={group} onChange={(e) => onGroupChange(e.target.value)}>
              {PRESET_USER_GROUPS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </label>
          <dl className="xp-modal-meta">
            <div>
              <dt>动画时长</dt>
              <dd>{durationSec} s</dd>
            </div>
            <div>
              <dt>关键帧</dt>
              <dd>{draft.keyframeCount}</dd>
            </div>
            <div>
              <dt>Face</dt>
              <dd>✓</dd>
            </div>
            <div>
              <dt>Neck</dt>
              <dd>{draft.hasNeck ? "✓" : "—"}</dd>
            </div>
            <div>
              <dt>闭环状态</dt>
              <dd>{draft.closedClip ? "✓ 闭环" : "⚠ 非闭环"}</dd>
            </div>
          </dl>
          {!draft.closedClip ? (
            <p className="xp-inline-warn">
              非闭环动作仅支持单次播放，不能重复或加入序列。
            </p>
          ) : null}
        </div>
        <footer className="xp-modal-foot">
          <button type="button" className="btn-ghost" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="btn-primary" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  )
}
