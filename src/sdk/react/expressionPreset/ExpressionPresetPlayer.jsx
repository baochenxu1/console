import { PRESET_PLAYBACK_STATES, PRESET_REPEAT_MODES } from "../../expression/expressionPresetPlaybackController.js"
import { canRepeatPreset } from "../../expression/expressionPresetRegistry.js"
import CharacterPresetPreviewStage from "./CharacterPresetPreviewStage.jsx"

const REPEAT_MAX = 999

export default function ExpressionPresetPlayer({
  preset,
  snapshot,
  repeatMode,
  repeatCount,
  sequenceReadyCount = 0,
  onRepeatModeChange,
  onRepeatCountChange,
  onPlay,
  onStop,
  playLocked,
}) {
  const playingPreset = snapshot.state === PRESET_PLAYBACK_STATES.PLAYING_PRESET
  const playingSequence = snapshot.state === PRESET_PLAYBACK_STATES.PLAYING_SEQUENCE
  const playing = playingPreset || playingSequence
  const stopping = snapshot.state === PRESET_PLAYBACK_STATES.STOPPING_TO_NEUTRAL
  const busy = playing || stopping
  const pose = snapshot.lastCharacterPose
  const durationSec = preset ? (Number(preset.durationMs) / 1000).toFixed(1) : "—"
  const closed = canRepeatPreset(preset)
  const scopeLabel = preset?.scope === "character" ? "Character" : "Face"

  let statusLabel = "空闲"
  if (playingPreset) statusLabel = "播放中"
  else if (playingSequence) statusLabel = "序列播放中"
  else if (stopping) statusLabel = "正在回中"
  else if (snapshot.state === PRESET_PLAYBACK_STATES.ERROR) statusLabel = "错误"

  return (
    <section className="xp-player" aria-label="当前预览与播放">
      <CharacterPresetPreviewStage characterPose={pose} scopeLabel={scopeLabel} />

      <div className="xp-playback-dock">
        {playingSequence ? (
          <div className="xp-player-meta">
            <h3 className="xp-player-name">当前播放</h3>
            <p className="xp-player-title">播放序列</p>
            <p className="xp-card-meta">
              第 {(snapshot.sequenceIndex || 0) + 1} / {snapshot.sequenceItemCount || "?"} 项
              {preset ? ` · ${preset.name}` : ""}
            </p>
            <p className="xp-status-detail">
              Item 第 {snapshot.sequenceItemRepeatIndex} / {snapshot.sequenceItemRepeatTotal} 次
              {snapshot.sequenceCycleTotal
                ? ` · Sequence 第 ${snapshot.sequenceCycleIndex} / ${snapshot.sequenceCycleTotal} 次`
                : snapshot.sequenceCycleIndex
                  ? ` · Sequence 第 ${snapshot.sequenceCycleIndex} 次 · 无限`
                  : ""}
            </p>
          </div>
        ) : preset ? (
          <div className="xp-player-meta">
            <h3 className="xp-player-name">{playing ? "当前播放" : "当前预设"}</h3>
            <p className="xp-player-title">{preset.name}</p>
            <p className="xp-card-meta">
              {preset.group} · {durationSec}s · {closed ? "闭环" : "非闭环"}
            </p>
            {!playing ? (
              <p className="xp-player-desc">{preset.description || "用户导入的表情预设"}</p>
            ) : null}
          </div>
        ) : (
          <p className="xp-empty">从左侧选择预设，或导入表情工程</p>
        )}

        {!playing && !stopping && sequenceReadyCount > 0 ? (
          <p className="xp-seq-ready-hint">播放序列已准备：{sequenceReadyCount} 项</p>
        ) : null}

        <div className="xp-status-row">
          <span className="xp-status-pill">{statusLabel}</span>
          {playingPreset ? (
            <span className="xp-status-detail">
              {snapshot.playingRepeatTotal
                ? `第 ${snapshot.playingRepeatIndex} / ${snapshot.playingRepeatTotal} 次`
                : `第 ${snapshot.playingRepeatIndex} 次 · 无限`}
            </span>
          ) : null}
        </div>

        {(playing || stopping) && (
          <div className="xp-progress" aria-hidden="true">
            <i style={{ width: `${Math.round((snapshot.progress01 || 0) * 100)}%` }} />
          </div>
        )}

        {!playing && !stopping ? (
          <fieldset className="xp-fieldset" disabled={busy || !preset}>
            <legend>播放方式</legend>
            <label>
              <input
                type="radio"
                name="xp-repeat"
                checked={repeatMode === PRESET_REPEAT_MODES.ONCE}
                onChange={() => onRepeatModeChange(PRESET_REPEAT_MODES.ONCE)}
              />
              单次
            </label>
            <label className={!closed ? "is-disabled" : undefined} title={!closed ? "非闭环动作仅支持单次播放。" : undefined}>
              <input
                type="radio"
                name="xp-repeat"
                disabled={!closed}
                checked={repeatMode === PRESET_REPEAT_MODES.REPEAT}
                onChange={() => onRepeatModeChange(PRESET_REPEAT_MODES.REPEAT)}
              />
              重复 N 次
            </label>
            <label className={!closed ? "is-disabled" : undefined} title={!closed ? "非闭环动作仅支持单次播放。" : undefined}>
              <input
                type="radio"
                name="xp-repeat"
                disabled={!closed}
                checked={repeatMode === PRESET_REPEAT_MODES.INFINITE}
                onChange={() => onRepeatModeChange(PRESET_REPEAT_MODES.INFINITE)}
              />
              无限循环
            </label>
            {repeatMode === PRESET_REPEAT_MODES.REPEAT && closed ? (
              <label className="xp-repeat-n">
                次数
                <input
                  className="xp-repeat-input"
                  type="number"
                  min={1}
                  max={REPEAT_MAX}
                  value={repeatCount}
                  onChange={(e) => onRepeatCountChange(e.target.value)}
                />
              </label>
            ) : null}
          </fieldset>
        ) : null}

        {snapshot.blockReason ? <p className="xp-inline-reason">{snapshot.blockReason}</p> : null}
        {snapshot.neckWarning ? <p className="xp-inline-warn">{snapshot.neckWarning}</p> : null}
        {snapshot.leaveStatus ? <p className="xp-inline-reason">{snapshot.leaveStatus}</p> : null}

        <div className="xp-player-actions">
          {stopping ? (
            <button type="button" className="btn-secondary" disabled>
              正在回中…
            </button>
          ) : playing ? (
            <button type="button" className="btn-secondary" onClick={onStop}>
              停止并回中
            </button>
          ) : (
            <button type="button" className="btn-primary" disabled={!preset || playLocked} onClick={onPlay}>
              播放
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
