/** 表情编排侧栏：当前帧 + 动作工程合并展示；输出诊断单独页签。Phase 1：仅管理 Full-Face Key。 */
export default function ExpressionFramePanel({
  sideTab,
  setSideTab,
  mergeHint,
  hasUnsavedRigPose,
  rig,
  keyframes,
  selectedKeyframe,
  selectedFrameIndex,
  keyframeTimeDraft,
  setKeyframeTimeDraft,
  updateSelectedKeyframeMeta,
  handleWriteCurrentKeyframe,
  currentControlInspect,
  handleInsertKeyframe,
  handleMoveKeyframe,
  handleDeleteKeyframe,
  defaultDurationMs,
  setDefaultDurationMs,
  handleNewExpression,
  handleSaveProject,
  handleClearProject,
  handleExportProject,
  handleProjectImportFile,
  projectFileInputRef,
  structureEditLocked = false,
}) {
  const editActive = sideTab !== "diag"

  return (
    <aside className="face-expression-side" aria-label="属性与工程">
      <div className="face-expression-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={editActive}
          className={editActive ? "active" : ""}
          onClick={() => setSideTab("frame")}
        >
          当前帧
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={sideTab === "diag"}
          className={sideTab === "diag" ? "active" : ""}
          onClick={() => setSideTab("diag")}
        >
          输出诊断
        </button>
      </div>

      <div className="face-expression-side-body">
        {editActive ? (
          <div className="face-expression-tab-panel face-expression-tab-frame" role="tabpanel">
            {hasUnsavedRigPose ? (
              <div className="face-expression-unsaved-banner" role="status">
                当前 Face Rig 姿态尚未写入关键帧
              </div>
            ) : null}

            {selectedKeyframe ? (
              <>
                <div className="form-row">
                  <label>名称</label>
                  <input
                    value={selectedKeyframe.name}
                    disabled={structureEditLocked}
                    onChange={(e) => updateSelectedKeyframeMeta({ name: e.target.value })}
                  />
                </div>
                <div className="form-row">
                  <label>时间 ms</label>
                  <input
                    type="number"
                    min={0}
                    disabled={structureEditLocked}
                    value={
                      keyframeTimeDraft !== null
                        ? keyframeTimeDraft
                        : String(selectedKeyframe.timeMs ?? 0)
                    }
                    onFocus={() => setKeyframeTimeDraft(String(selectedKeyframe.timeMs ?? 0))}
                    onChange={(e) => setKeyframeTimeDraft(e.target.value)}
                    onBlur={() => {
                      if (structureEditLocked || keyframeTimeDraft === null) return
                      const raw = keyframeTimeDraft.trim()
                      setKeyframeTimeDraft(null)
                      if (raw === "") {
                        return
                      }
                      const n = Number.parseInt(raw, 10)
                      if (Number.isNaN(n)) {
                        return
                      }
                      updateSelectedKeyframeMeta({ timeMs: Math.max(0, n) })
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.currentTarget.blur()
                      }
                    }}
                  />
                </div>
              </>
            ) : (
              <p className="hint face-expression-pick-kf-hint">
                未选中关键帧时，「写入」会在当前 Playhead 创建/更新 Character Key（Face + Neck）。也可在下方时间轴点角色圆点选中后编辑。
              </p>
            )}

            <button
              type="button"
              className="btn-primary face-expression-btn-write-kf"
              onClick={handleWriteCurrentKeyframe}
              disabled={structureEditLocked}
            >
              写入当前关键帧
            </button>

            {mergeHint ? <p className="hint face-expression-merge-hint">{mergeHint}</p> : null}

            <details className="face-expression-details">
              <summary>当前控件状态</summary>
              <div className="face-expression-details-body">
                {currentControlInspect ? (
                  <dl className="face-expression-inspect-dl">
                    <div className="face-expression-inspect-row">
                      <dt>控件名称</dt>
                      <dd>{currentControlInspect.label}</dd>
                    </div>
                    <div className="face-expression-inspect-row">
                      <dt>控件通道</dt>
                      <dd>
                        <code className="face-expression-code">{currentControlInspect.channelTag}</code>
                      </dd>
                    </div>
                    <div className="face-expression-inspect-row">
                      <dt>控件值</dt>
                      <dd className="face-expression-inspect-value">{currentControlInspect.valueText}</dd>
                    </div>
                    <div className="face-expression-inspect-row">
                      <dt>输出路数</dt>
                      <dd>{currentControlInspect.outputPathCount}</dd>
                    </div>
                    <div className="face-expression-inspect-row">
                      <dt>舵机 ID</dt>
                      <dd>
                        {currentControlInspect.servoIds.length
                          ? currentControlInspect.servoIds.join(", ")
                          : "—"}
                      </dd>
                    </div>
                  </dl>
                ) : (
                  <p className="hint face-expression-no-control">未选择控件</p>
                )}
              </div>
            </details>

            <details className="face-expression-details" open>
              <summary>整脸关键帧管理</summary>
              <div className="face-expression-details-body">
                <div className="face-expression-kf-manage-grid">
                  <button
                    type="button"
                    className="btn-ghost btn-compact"
                    onClick={() => handleInsertKeyframe(0)}
                    disabled={structureEditLocked}
                  >
                    插入前
                  </button>
                  <button
                    type="button"
                    className="btn-ghost btn-compact"
                    onClick={() => handleInsertKeyframe(1)}
                    disabled={structureEditLocked}
                  >
                    插入后
                  </button>
                  <button
                    type="button"
                    className="btn-ghost btn-compact"
                    onClick={() => handleMoveKeyframe(-1)}
                    disabled={structureEditLocked || selectedFrameIndex <= 0}
                  >
                    上移
                  </button>
                  <button
                    type="button"
                    className="btn-ghost btn-compact"
                    onClick={() => handleMoveKeyframe(1)}
                    disabled={structureEditLocked || selectedFrameIndex >= keyframes.length - 1}
                  >
                    下移
                  </button>
                </div>
                <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
                  写入请用上方「写入当前整脸关键帧」。时间轴上 Alt+拖动整脸圆点可复制到新时间。
                </p>
                <button
                  type="button"
                  className="danger btn-danger-full"
                  onClick={handleDeleteKeyframe}
                  disabled={structureEditLocked || !selectedKeyframe}
                >
                  删除当前关键帧
                </button>
              </div>
            </details>

            <section className="face-expression-project-section" aria-label="动作工程">
              <h4 className="face-expression-section-subhead">动作工程</h4>
              <div className="form-row">
                <label>新建关键帧默认时长 ms</label>
                <input
                  type="number"
                  min={20}
                  value={defaultDurationMs}
                  onChange={(e) => {
                    const n = Number.parseInt(e.target.value, 10)
                    if (!Number.isNaN(n)) setDefaultDurationMs(Math.max(20, n))
                  }}
                />
              </div>
              <div className="button-row button-row-expression">
                <button type="button" className="btn-secondary-full" onClick={handleNewExpression}>
                  新建
                </button>
                <button type="button" className="btn-secondary-full" onClick={handleSaveProject}>
                  保存
                </button>
                <button
                  type="button"
                  className="btn-secondary-full"
                  onClick={handleClearProject}
                  title="清空当前表情工程，恢复为默认整脸关键帧"
                >
                  清空
                </button>
                <button
                  type="button"
                  className="btn-secondary-full"
                  onClick={() => projectFileInputRef.current?.click()}
                >
                  导入
                </button>
                <button type="button" className="btn-secondary-full" onClick={handleExportProject}>
                  导出
                </button>
              </div>
              <input
                ref={projectFileInputRef}
                type="file"
                accept="application/json,.json"
                style={{ display: "none" }}
                onChange={handleProjectImportFile}
              />
            </section>
          </div>
        ) : null}

        {sideTab === "diag" ? (
          <div className="face-expression-tab-panel face-expression-diag-tab" role="tabpanel">
            <details className="face-rig-diag-block">
              <summary>warnings（{rig.warnings.length}）</summary>
              {rig.warnings.length === 0 ? (
                <p className="hint muted">无</p>
              ) : (
                <ul className="face-rig-warnings">
                  {rig.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
            </details>
            <details className="face-rig-diag-block">
              <summary>logicalPose</summary>
              <pre className="face-rig-diag-json">{JSON.stringify(rig.logicalPose, null, 2)}</pre>
            </details>
            <details className="face-rig-diag-block">
              <summary>actualPose</summary>
              <pre className="face-rig-diag-json">{JSON.stringify(rig.actualPose, null, 2)}</pre>
            </details>
            <details className="face-rig-diag-block">
              <summary>contributions</summary>
              <pre className="face-rig-diag-json">{JSON.stringify(rig.contributions, null, 2)}</pre>
            </details>
          </div>
        ) : null}
      </div>
    </aside>
  )
}
