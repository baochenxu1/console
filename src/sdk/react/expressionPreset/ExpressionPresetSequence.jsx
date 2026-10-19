import { PRESET_PLAYBACK_STATES, PRESET_REPEAT_MODES } from "../../expression/expressionPresetPlaybackController.js"
import { getExpressionPreset } from "../../expression/expressionPresetRegistry.js"
import { estimateSequenceDurationMs } from "../../expression/expressionPresetSequence.js"

export default function ExpressionPresetSequence({
  items,
  snapshot,
  sequenceMode,
  sequenceRepeatCount,
  locked,
  onModeChange,
  onRepeatCountChange,
  onMove,
  onRemove,
  onClear,
  onPlay,
  onChangeItemRepeat,
  onSelectItem,
}) {
  const empty = !items.length
  const busy = snapshot.state === PRESET_PLAYBACK_STATES.PLAYING_SEQUENCE
  const anyBusy =
    busy ||
    snapshot.state === PRESET_PLAYBACK_STATES.PLAYING_PRESET ||
    snapshot.state === PRESET_PLAYBACK_STATES.STOPPING_TO_NEUTRAL
  const estMs = estimateSequenceDurationMs(items, getExpressionPreset)
  const estSec = (estMs / 1000).toFixed(1)
  const loopEst =
    sequenceMode === PRESET_REPEAT_MODES.REPEAT
      ? (estMs * Math.max(1, Number(sequenceRepeatCount) || 1)) / 1000
      : null

  return (
    <section className={`xp-sequence${empty ? " is-empty" : ""}`} aria-label="播放序列">
      <header className="xp-section-head">
        <h2>播放序列</h2>
        <span className="xp-section-count">
          {items.length} 项{items.length ? ` · ${estSec}s` : ""}
          {loopEst != null ? ` · 总约 ${loopEst.toFixed(1)}s` : ""}
        </span>
      </header>
      {empty ? (
        <p className="xp-empty xp-empty-compact">
          尚未添加动作
          <br />
          点击预设右侧 “+” 加入播放序列
        </p>
      ) : (
        <>
          <ol className="xp-seq-list">
            {items.map((item, index) => {
              const preset = getExpressionPreset(item.presetId)
              const current = busy && snapshot.sequenceIndex === index
              return (
                <li
                  key={item.instanceId || item.id}
                  className={current ? "is-current" : ""}
                  onClick={() => onSelectItem?.(item.presetId)}
                >
                  <span className="xp-seq-idx">{index + 1}</span>
                  <div className="xp-seq-body">
                    <span className="xp-seq-name">{preset?.name || item.presetId}</span>
                    {current ? (
                      <span className="xp-seq-live">
                        播放中 · 第 {snapshot.sequenceItemRepeatIndex} / {snapshot.sequenceItemRepeatTotal} 次
                      </span>
                    ) : null}
                  </div>
                  <label className="xp-seq-repeat" onClick={(e) => e.stopPropagation()}>
                    ×
                    <input
                      type="number"
                      min={1}
                      max={99}
                      disabled={locked}
                      value={item.repeatCount}
                      onChange={(e) => onChangeItemRepeat(item.id, e.target.value)}
                    />
                  </label>
                  <div className="xp-seq-item-actions" onClick={(e) => e.stopPropagation()}>
                    <button type="button" className="btn-ghost btn-tiny" disabled={locked} title="上移" onClick={() => onMove(item.id, -1)}>
                      ↑
                    </button>
                    <button type="button" className="btn-ghost btn-tiny" disabled={locked} title="下移" onClick={() => onMove(item.id, 1)}>
                      ↓
                    </button>
                    <button type="button" className="btn-ghost btn-tiny" disabled={locked} title="删除" onClick={() => onRemove(item.id)}>
                      ×
                    </button>
                  </div>
                </li>
              )
            })}
          </ol>
          <fieldset className="xp-fieldset xp-fieldset-inline" disabled={locked}>
            <legend>整体播放</legend>
            <label>
              <input
                type="radio"
                name="xp-seq-repeat"
                checked={sequenceMode === PRESET_REPEAT_MODES.ONCE}
                onChange={() => onModeChange(PRESET_REPEAT_MODES.ONCE)}
              />
              单次
            </label>
            <label>
              <input
                type="radio"
                name="xp-seq-repeat"
                checked={sequenceMode === PRESET_REPEAT_MODES.REPEAT}
                onChange={() => onModeChange(PRESET_REPEAT_MODES.REPEAT)}
              />
              重复 N 次
            </label>
            <label>
              <input
                type="radio"
                name="xp-seq-repeat"
                checked={sequenceMode === PRESET_REPEAT_MODES.INFINITE}
                onChange={() => onModeChange(PRESET_REPEAT_MODES.INFINITE)}
              />
              无限循环
            </label>
            {sequenceMode === PRESET_REPEAT_MODES.REPEAT ? (
              <label className="xp-repeat-n">
                次数
                <input
                  className="xp-repeat-input"
                  type="number"
                  min={1}
                  max={999}
                  value={sequenceRepeatCount}
                  onChange={(e) => onRepeatCountChange(e.target.value)}
                />
              </label>
            ) : null}
          </fieldset>
          <div className="xp-seq-actions">
            <button type="button" className="btn-ghost" disabled={locked} onClick={onClear}>
              清空
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={anyBusy && snapshot.state !== PRESET_PLAYBACK_STATES.ERROR}
              onClick={onPlay}
            >
              播放序列
            </button>
          </div>
        </>
      )}
    </section>
  )
}
