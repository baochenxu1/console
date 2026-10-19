import { useEffect, useRef, useState } from "react"

export default function ExpressionPresetCard({
  preset,
  selected,
  playing,
  playDisabled,
  addDisabled,
  libraryLocked,
  onSelect,
  onPlay,
  onAdd,
  onRename,
  onChangeGroup,
  onReplace,
  onExport,
  onDelete,
}) {
  const durationSec = (Number(preset.durationMs) / 1000).toFixed(1)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef(null)
  const closed = Boolean(preset.closedClip)

  useEffect(() => {
    if (!menuOpen) return undefined
    const onDoc = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [menuOpen])

  return (
    <article
      className={`xp-row${selected ? " is-selected" : ""}${playing ? " is-playing" : ""}`}
      onClick={() => onSelect(preset.id)}
    >
      <div className="xp-row-main">
        <div className="xp-row-title-line">
          <h3 className="xp-row-title">{preset.name}</h3>
          {!closed ? <span className="xp-row-tag">非闭环</span> : null}
          {playing ? <span className="xp-row-tag xp-row-tag-live">播放中</span> : null}
        </div>
        <p className="xp-row-meta">
          {preset.group} · {durationSec}s
        </p>
      </div>
      <div className="xp-row-actions" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="btn-primary btn-tiny"
          disabled={playDisabled}
          title={playDisabled ? "播放锁定中" : "播放"}
          onClick={() => onPlay(preset.id)}
        >
          ▶
        </button>
        <button
          type="button"
          className="btn-secondary btn-tiny"
          disabled={addDisabled || !closed}
          title={!closed ? "非闭环动作仅支持单次播放。" : "加入播放序列"}
          onClick={() => onAdd(preset.id)}
        >
          +
        </button>
        <div className="xp-card-menu" ref={menuRef}>
          <button
            type="button"
            className="btn-ghost btn-tiny"
            disabled={libraryLocked}
            title="更多"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            ⋯
          </button>
          {menuOpen ? (
            <div className="xp-card-menu-pop" role="menu">
              <button type="button" role="menuitem" disabled={libraryLocked} onClick={() => { setMenuOpen(false); onRename?.(preset) }}>
                重命名
              </button>
              <button type="button" role="menuitem" disabled={libraryLocked} onClick={() => { setMenuOpen(false); onChangeGroup?.(preset) }}>
                修改分类
              </button>
              <button type="button" role="menuitem" disabled={libraryLocked} onClick={() => { setMenuOpen(false); onReplace?.(preset) }}>
                替换动画
              </button>
              <button type="button" role="menuitem" disabled={libraryLocked} onClick={() => { setMenuOpen(false); onExport?.(preset) }}>
                导出
              </button>
              <hr />
              <button type="button" role="menuitem" className="is-danger" disabled={libraryLocked} onClick={() => { setMenuOpen(false); onDelete?.(preset) }}>
                删除
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </article>
  )
}
