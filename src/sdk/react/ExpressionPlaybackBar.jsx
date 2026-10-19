import "../../styles/frame-editor.css"

/**
 * 外置时间轴运输条：依赖 {@link FrameEditor} 通过 playbackExposeRef 注入的 API。
 */
export default function ExpressionPlaybackBar({ playbackExposeRef, className = "" }) {
  const api = playbackExposeRef?.current

  return (
    <div className={`expression-playback-bar transport-bar-pro ${className}`.trim()}>
      <button
        type="button"
        className="btn-t"
        onClick={() => api?.playAll?.()}
        disabled={api?.isPlaying || !api?.keyframeCount}
        title="从第一帧开始播放全部关键帧"
      >
        ▶ 全部
      </button>

      <button
        type="button"
        className="btn-t"
        onClick={() => api?.playCurrent?.()}
        disabled={api?.isPlaying || !api?.hasSelectedKeyframe}
        title="只发送当前选中关键帧一次"
      >
        单帧
      </button>

      <button
        type="button"
        className="btn-t"
        onClick={() => api?.playRange?.()}
        disabled={api?.isPlaying || !api?.selectedRange}
        title="播放 Shift 选择的关键帧区间"
      >
        区间
      </button>

      {api?.isPaused ? (
        <button
          type="button"
          className="btn-t"
          onClick={() => api?.resume?.()}
          disabled={!api?.isPlaying}
          title="从暂停时刻继续"
        >
          ▶ 继续
        </button>
      ) : (
        <button
          type="button"
          className="btn-t"
          onClick={() => api?.pause?.()}
          disabled={!api?.isPlaying}
          title="暂停：冻结当前 timeline 时间"
        >
          ⏸ 暂停
        </button>
      )}

      <button
        type="button"
        className="btn-t"
        onClick={() => api?.stop?.()}
        disabled={!api?.isPlaying}
        title="停止当前播放流程，不发送舵机停止命令"
      >
        ⏹ 停止
      </button>

      <button
        type="button"
        className={`btn-t ${api?.isLoop ? "active" : ""}`}
        onClick={() => api?.toggleLoop?.()}
        disabled={api?.isPlaying}
        title="循环播放全部或区间；单帧不受循环影响"
      >
        循环
      </button>

      {api?.totalDuration !== undefined ? (
        <span className="time-display">
          {Math.floor(api.playheadPos ?? 0)} / {api.totalDuration} 毫秒
        </span>
      ) : null}
    </div>
  )
}
