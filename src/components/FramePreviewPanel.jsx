import { useMemo, useRef, useState } from "react"
import { playKeyframes } from "../core/actionPlayer.js"
import { buildFrameProjectExport, normalizeFrameProject } from "../core/frameProject.js"
import { dispatchKeyframeToHardware } from "../sdk/expression/keyframePlaybackDispatch.js"
import { exportJsonFile, getDateTimeText } from "../utils/fileExport.js"

export default function FramePreviewPanel({
  project,
  configs,
  currentPose,
  onCurrentPoseChange,
}) {
  const normalized = useMemo(() => normalizeFrameProject(project, configs), [project, configs])
  const [playing, setPlaying] = useState(false)
  const [message, setMessage] = useState("")
  const abortRef = useRef(null)

  async function runKeyframes(label) {
    const keyframes = normalized.keyframes || []
    if (!keyframes.length) {
      setMessage(`${label} 没有可播放帧。`)
      return
    }
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    setPlaying(true)
    setMessage(`${label} 播放中...`)
    try {
      await playKeyframes({
        keyframes,
        configs,
        signal: abortRef.current.signal,
        sendKeyframe: ({ keyframe, configs: cfgs, signal }) =>
          dispatchKeyframeToHardware({
            keyframe,
            configs: cfgs,
            signal,
            onCommandPreview: (preview) => setMessage(`${label}：${preview}`),
          }),
        onKeyframeStart: (frame) => {
          onCurrentPoseChange?.((prev) => ({ ...prev, ...(frame.positions || {}) }))
        },
      })
      if (!abortRef.current.signal.aborted) {
        setMessage(`${label} 播放完成。`)
      }
    } catch (error) {
      setMessage(`播放失败：${error.message}`)
    } finally {
      setPlaying(false)
    }
  }

  function handleStop() {
    abortRef.current?.abort()
    setPlaying(false)
    setMessage("已停止播放。")
  }

  function handlePlayExpression() {
    runKeyframes(`表情 ${normalized.expressionName || normalized.expressionId}`)
  }

  function handleExportProject() {
    const payload = buildFrameProjectExport(normalized, null, configs)
    const filename = `frame-project_${getDateTimeText()}.json`
    exportJsonFile(filename, payload)
    setMessage(`工程已导出：${filename}`)
  }

  return (
    <section className="panel">
      <h2>动作预览与工程导出</h2>

      <div className="button-row">
        <button type="button" onClick={handlePlayExpression} disabled={playing}>
          播放当前表情
        </button>
        <button type="button" onClick={handleStop} disabled={!playing}>
          停止播放
        </button>
      </div>

      <div className="button-row">
        <button type="button" onClick={handleExportProject}>
          导出工程
        </button>
      </div>

      <p className="hint">{message || "等待操作..."}</p>
      <pre className="pose-preview">{JSON.stringify(currentPose, null, 2)}</pre>
    </section>
  )
}
