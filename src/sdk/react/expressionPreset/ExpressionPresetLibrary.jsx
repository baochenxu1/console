import {
  EXPRESSION_PRESET_GROUPS,
  filterExpressionPresets,
} from "../../expression/expressionPresetRegistry.js"
import ExpressionPresetCard from "./ExpressionPresetCard.jsx"

export default function ExpressionPresetLibrary({
  groupId,
  onGroupChange,
  selectedPresetId,
  playingPresetId,
  playLocked,
  sequenceLocked,
  libraryLocked,
  loadError = "",
  onRetryLoad,
  onImport,
  onSelect,
  onPlay,
  onAdd,
  onRename,
  onChangeGroup,
  onReplace,
  onExport,
  onDelete,
}) {
  const presets = filterExpressionPresets(groupId)
  const empty = presets.length === 0 && !loadError

  return (
    <section className="xp-library" aria-label="预设库">
      <header className="xp-section-head">
        <h2>预设库</h2>
        <div className="xp-section-head-actions">
          <span className="xp-section-count">{presets.length}</span>
          <button
            type="button"
            className="btn-primary btn-tiny"
            disabled={libraryLocked}
            onClick={onImport}
          >
            + 导入表情
          </button>
        </div>
      </header>
      <div className="xp-group-tabs" role="tablist">
        {EXPRESSION_PRESET_GROUPS.map((g) => (
          <button
            key={g.id}
            type="button"
            role="tab"
            className={groupId === g.id ? "is-active" : ""}
            onClick={() => onGroupChange(g.id)}
          >
            {g.label}
          </button>
        ))}
      </div>

      {loadError ? (
        <div className="xp-library-empty">
          <p className="xp-empty">本地预设库加载失败</p>
          <p className="xp-empty-hint">{loadError}</p>
          <div className="xp-empty-actions">
            <button type="button" className="btn-secondary" onClick={onRetryLoad}>
              重试
            </button>
            <button type="button" className="btn-primary" disabled={libraryLocked} onClick={onImport}>
              导入表情
            </button>
          </div>
        </div>
      ) : empty ? (
        <div className="xp-library-empty">
          <p className="xp-empty">暂无表情预设</p>
          <p className="xp-empty-hint">
            从「表情编排」导出动作文件后导入。
            <br />
            复杂动作请前往「表情编排」编辑。
          </p>
          <button type="button" className="btn-primary" disabled={libraryLocked} onClick={onImport}>
            导入表情
          </button>
        </div>
      ) : (
        <div className="xp-row-list">
          {presets.map((preset) => (
            <ExpressionPresetCard
              key={preset.id}
              preset={preset}
              selected={preset.id === selectedPresetId}
              playing={preset.id === playingPresetId}
              playDisabled={playLocked}
              addDisabled={sequenceLocked || !preset.closedClip}
              libraryLocked={libraryLocked}
              onSelect={onSelect}
              onPlay={onPlay}
              onAdd={onAdd}
              onRename={onRename}
              onChangeGroup={onChangeGroup}
              onReplace={onReplace}
              onExport={onExport}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </section>
  )
}
