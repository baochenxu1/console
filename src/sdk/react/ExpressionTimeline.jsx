import FrameEditor from "../../components/FrameEditor.jsx"

/** 与「动作帧编辑与预览」中底部时间轴同源：{@link FrameEditor} `timelineOnly`，运输条在轨道内一并显示。 */
export default function ExpressionTimeline({
  externalPlaybackBar = false,
  playbackExposeRef,
  onPlaybackUiBump,
  ...rest
}) {
  return (
    <FrameEditor
      {...rest}
      timelineOnly
      externalPlaybackBar={externalPlaybackBar}
      playbackExposeRef={playbackExposeRef}
      onPlaybackUiBump={onPlaybackUiBump}
    />
  )
}
