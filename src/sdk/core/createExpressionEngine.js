import {
  addKeyframe,
  buildFrameProjectExport,
  copyKeyframe,
  createDefaultFrameProject,
  createKeyframe,
  deleteKeyframe,
  insertKeyframe,
  moveKeyframe,
  normalizeFrameProject,
  saveFrameProject,
  updateExpressionName,
  updateKeyframe,
} from "../../core/frameProject.js"
import {
  buildKeyframeCommand,
  playKeyframe,
  playKeyframes,
} from "../../core/actionPlayer.js"
import { mergeKeyframePositions } from "../expression/expressionActions.js"

function clampIndex(i, len) {
  if (len <= 0) {
    return 0
  }
  return Math.max(0, Math.min(Number(i) || 0, len - 1))
}

/**
 * @param {object} options
 * @param {object} [options.project]
 * @param {object[]} [options.configs]
 * @param {object} [options.ambientPose] — 保存为新关键帧时与之合并的外部当前姿态（逻辑脉宽表）
 */
export function createExpressionEngine({
  project,
  configs = [],
  ambientPose: initialAmbientPose,
} = {}) {
  let _configs = Array.isArray(configs) ? configs : []
  let _project = normalizeFrameProject(project ?? createDefaultFrameProject(_configs), _configs)
  let _selectedFrameIndex = 0
  /** 与 savePoseAsNewKeyframe 合并：positions = { ...ambientPose, ...pose } */
  let _ambientPose =
    initialAmbientPose && typeof initialAmbientPose === "object"
      ? { ...initialAmbientPose }
      : {}

  let _playAbort = null

  function normalized() {
    return normalizeFrameProject(_project, _configs)
  }

  function keyframesList() {
    return normalized().keyframes ?? []
  }

  function syncSelectionLength() {
    const list = keyframesList()
    _selectedFrameIndex = clampIndex(_selectedFrameIndex, list.length)
  }

  function notifyFrame(frame, index, extras = {}) {
    extras.onFrame?.(frame, index)
    extras.onPose?.(frame?.positions ?? {})
    const cmd = frame ? buildKeyframeCommand({ keyframe: frame, configs: _configs }) : ""
    extras.onCommandPreview?.(cmd, frame, index)
  }

  return {
    setConfigs(nextConfigs) {
      _configs = Array.isArray(nextConfigs) ? nextConfigs : []
      _project = normalizeFrameProject(_project, _configs)
      syncSelectionLength()
    },

    setAmbientPose(pose) {
      _ambientPose = pose && typeof pose === "object" ? { ...pose } : {}
    },

    getAmbientPose() {
      return { ..._ambientPose }
    },

    getProject() {
      return normalized()
    },

    setProject(next) {
      _project = normalizeFrameProject(next ?? createDefaultFrameProject(_configs), _configs)
      syncSelectionLength()
    },

    getKeyframes() {
      return [...keyframesList()]
    },

    getSelectedFrameIndex() {
      syncSelectionLength()
      return _selectedFrameIndex
    },

    setSelectedFrameIndex(index) {
      const list = keyframesList()
      _selectedFrameIndex = clampIndex(index, list.length)
      return _selectedFrameIndex
    },

    getSelectedKeyframe() {
      syncSelectionLength()
      const list = keyframesList()
      return list[_selectedFrameIndex] ?? null
    },

    createNewExpression() {
      _project = createDefaultFrameProject(_configs)
      _selectedFrameIndex = 0
    },

    updateExpressionName(name) {
      _project = updateExpressionName(_project, name, _configs)
    },

    addKeyframeFromPose({ name, durationMs, pose }) {
      const frame = createKeyframe({
        name,
        durationMs,
        positions: pose && typeof pose === "object" ? pose : {},
        configs: _configs,
      })
      _project = addKeyframe(_project, frame, _configs)
      syncSelectionLength()
      _selectedFrameIndex = keyframesList().length - 1
    },

    savePoseAsNewKeyframe({ name, durationMs, pose }) {
      const positions = mergeKeyframePositions(_ambientPose, pose && typeof pose === "object" ? pose : {})
      const frame = createKeyframe({
        name,
        durationMs,
        positions,
        configs: _configs,
      })
      _project = addKeyframe(_project, frame, _configs)
      syncSelectionLength()
      _selectedFrameIndex = keyframesList().length - 1
    },

    updateSelectedKeyframeWithPose(pose) {
      const list = keyframesList()
      const cur = list[_selectedFrameIndex]
      if (!cur || !pose || typeof pose !== "object") {
        return
      }
      const nextPositions = mergeKeyframePositions(cur.positions, pose)
      _project = updateKeyframe(_project, cur.keyframeId, { positions: nextPositions }, _configs)
    },

    mergePoseToSelectedKeyframe(pose) {
      const list = keyframesList()
      const cur = list[_selectedFrameIndex]
      if (!cur || !pose || typeof pose !== "object") {
        return
      }
      const nextPositions = mergeKeyframePositions(cur.positions, pose)
      _project = updateKeyframe(_project, cur.keyframeId, { positions: nextPositions }, _configs)
    },

    copySelectedKeyframe() {
      const cur = keyframesList()[_selectedFrameIndex]
      if (!cur) {
        return
      }
      _project = copyKeyframe(_project, cur.keyframeId, _configs)
      syncSelectionLength()
      _selectedFrameIndex = clampIndex(_selectedFrameIndex + 1, keyframesList().length)
    },

    deleteSelectedKeyframe() {
      const cur = keyframesList()[_selectedFrameIndex]
      if (!cur) {
        return
      }
      _project = deleteKeyframe(_project, cur.keyframeId, _configs)
      syncSelectionLength()
    },

    insertKeyframeBefore(pose) {
      const list = keyframesList()
      const idx = clampIndex(_selectedFrameIndex, list.length)
      const frame = createKeyframe({
        name: `插入帧 ${idx + 1}`,
        durationMs: 500,
        positions: pose && typeof pose === "object" ? pose : {},
        configs: _configs,
      })
      _project = insertKeyframe(_project, idx, frame, _configs)
      syncSelectionLength()
      _selectedFrameIndex = idx
    },

    insertKeyframeAfter(pose) {
      const list = keyframesList()
      const idx = clampIndex(_selectedFrameIndex + 1, list.length + 1)
      const frame = createKeyframe({
        name: `插入帧 ${idx + 1}`,
        durationMs: 500,
        positions: pose && typeof pose === "object" ? pose : {},
        configs: _configs,
      })
      _project = insertKeyframe(_project, idx, frame, _configs)
      syncSelectionLength()
      _selectedFrameIndex = idx
    },

    moveSelectedKeyframe(delta) {
      const list = keyframesList()
      const from = clampIndex(_selectedFrameIndex, list.length)
      const to = clampIndex(from + delta, list.length)
      if (from === to) {
        return
      }
      _project = moveKeyframe(_project, from, to, _configs)
      _selectedFrameIndex = to
    },

    updateSelectedKeyframeMeta(patch) {
      const cur = keyframesList()[_selectedFrameIndex]
      if (!cur) {
        return
      }
      _project = updateKeyframe(_project, cur.keyframeId, patch, _configs)
    },

    async playSingle(options = {}) {
      const {
        sendCommand = async () => {},
        signal: userSignal,
        onFrame,
        onPose,
        onCommandPreview,
      } = options
      stopPlayback()
      _playAbort = userSignal ? null : new AbortController()
      const ctrl = userSignal ?? _playAbort?.signal

      const list = keyframesList()
      const kf = list[_selectedFrameIndex]
      if (!kf) {
        _playAbort = null
        return false
      }
      notifyFrame(kf, _selectedFrameIndex, { onFrame, onPose, onCommandPreview })
      try {
        return await playKeyframe({
          keyframe: kf,
          configs: _configs,
          sendCommand,
          onCommand: onCommandPreview,
          signal: ctrl,
        })
      } finally {
        _playAbort = null
      }
    },

    async playAll(options = {}) {
      const {
        sendCommand = async () => {},
        loop = false,
        signal: userSignal,
        onFrame,
        onPose,
        onCommandPreview,
      } = options
      stopPlayback()
      _playAbort = userSignal ? null : new AbortController()
      const signal = userSignal ?? _playAbort?.signal

      const list = keyframesList()
      try {
        await playKeyframes({
          keyframes: list,
          configs: _configs,
          startIndex: 0,
          endIndex: list.length - 1,
          loop,
          sendCommand: async (cmd) => {
            await sendCommand(cmd)
          },
          onKeyframeStart: (frame, index) => {
            notifyFrame(frame, index, { onFrame, onPose, onCommandPreview })
          },
          onCommand: onCommandPreview,
          signal,
        })
      } finally {
        _playAbort = null
      }
    },

    async playRange({ startIndex, endIndex, loop = false, sendCommand = async () => {}, ...rest } = {}) {
      const list = keyframesList()
      if (!list.length) {
        return
      }
      const { signal: userSignal, onFrame, onPose, onCommandPreview } = rest

      stopPlayback()
      _playAbort = userSignal ? null : new AbortController()
      const signal = userSignal ?? _playAbort?.signal

      const a = clampIndex(startIndex ?? 0, list.length)
      const b = endIndex === undefined ? list.length - 1 : clampIndex(endIndex, list.length)
      const safeStart = Math.min(a, b)
      const safeEnd = Math.max(a, b)
      try {
        await playKeyframes({
          keyframes: list,
          configs: _configs,
          startIndex: safeStart,
          endIndex: safeEnd,
          loop,
          sendCommand: async (cmd) => {
            await sendCommand(cmd)
          },
          onKeyframeStart: (frame, index) => {
            notifyFrame(frame, index, { onFrame, onPose, onCommandPreview })
          },
          onCommand: onCommandPreview,
          signal,
        })
      } finally {
        _playAbort = null
      }
    },

    stopPlayback() {
      if (_playAbort) {
        _playAbort.abort()
        _playAbort = null
      }
    },

    saveProject() {
      _project = saveFrameProject(_project, _configs)
      return _project
    },

    exportProject(servoConfigSnapshot) {
      return buildFrameProjectExport(_project, servoConfigSnapshot, _configs)
    },
  }
}
