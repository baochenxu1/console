import {
  buildFaceRigExportPayload,
  createDefaultFaceRigProfile,
  normalizeFaceRigProfile,
  parseFaceRigImport,
  saveFaceRigProfile,
} from "../../core/faceRigProfile.js"
import {
  createInitialEliteRig,
  mapFaceRigToPose,
  mergePose,
  rigValuesFromEliteRig,
  setEliteRigControlRaw,
} from "../../core/faceDofMapper.js"
import {
  createRightMouthCornerFivebarState,
  resetRightMouthCornerFivebarState,
} from "../kinematics/mouthCornerFivebar.js"
import { buildMapFaceRigToPoseOptionsFromMouthRuntimes } from "../kinematics/mouthFiveBarRuntimeOptions.js"
import * as bindingActions from "../binding/bindingActions.js"
import {
  buildServoCommandFromPose,
  buildServoMovesFromPose,
} from "../protocol/poseToServoCommand.js"

/**
 * @param {object} options
 * @param {object} [options.profile]
 * @param {object[]} [options.configs]
 * @param {object} [options.rigState] — elite rig，缺省为 {@link createInitialEliteRig}
 */
export function createFaceRigBindingEngine({ profile, configs = [], rigState } = {}) {
  let _profile = normalizeFaceRigProfile(profile ?? createDefaultFaceRigProfile())
  /** @type {object[]} */
  let _configs = Array.isArray(configs) ? configs : []
  let _rigState = rigState ? structuredClone(rigState) : createInitialEliteRig()
  let _rightFiveBarState = createRightMouthCornerFivebarState()
  let _leftFiveBarState = createRightMouthCornerFivebarState()

  function resetAllFiveBarStates() {
    resetRightMouthCornerFivebarState(_rightFiveBarState)
    resetRightMouthCornerFivebarState(_leftFiveBarState)
  }
  let _eval = null
  let _dirty = true

  function markDirty() {
    _dirty = true
  }

  function runEvaluate() {
    const rigValues = rigValuesFromEliteRig(_rigState)
    const mapped = mapFaceRigToPose(
      rigValues,
      _profile,
      _configs,
      buildMapFaceRigToPoseOptionsFromMouthRuntimes({
        rightState: _rightFiveBarState,
        leftState: _leftFiveBarState,
      })
    )
    _eval = {
      ...mapped,
      logicalPose: mergePose({}, mapped.logicalPose),
    }
    _dirty = false
    return _eval
  }

  function ensureEvaluated() {
    if (_dirty || !_eval) {
      return runEvaluate()
    }
    return _eval
  }

  function previewBase(timeMs) {
    const ev = ensureEvaluated()
    const logicalPose = { ...ev.logicalPose }
    let warnings = [...ev.warnings]
    const t = Number(timeMs)
    const safeTimeMs = Number.isFinite(t) && t >= 0 ? t : 500

    if (!Array.isArray(_configs) || _configs.length === 0) {
      warnings = [
        ...warnings,
        "configs 未配置或为空：舵机预览（moves/command）不可用，返回空结果。",
      ]
      return { logicalPose, warnings, safeTimeMs, skipBuild: true }
    }

    if (!logicalPose || Object.keys(logicalPose).length === 0) {
      return { logicalPose: logicalPose ?? {}, warnings, safeTimeMs, skipBuild: true }
    }

    return { logicalPose, warnings, safeTimeMs, skipBuild: false }
  }

  return {
    setConfigs(nextConfigs) {
      resetAllFiveBarStates()
      _configs = Array.isArray(nextConfigs) ? nextConfigs : []
      markDirty()
    },

    getProfile() {
      return normalizeFaceRigProfile(_profile)
    },

    setProfile(next) {
      resetAllFiveBarStates()
      _profile = normalizeFaceRigProfile(next ?? createDefaultFaceRigProfile())
      markDirty()
    },

    getRigState() {
      return _rigState
    },

    setRigState(next) {
      resetAllFiveBarStates()
      _rigState = next && typeof next === "object" ? structuredClone(next) : createInitialEliteRig()
      markDirty()
    },

    resetRigState() {
      resetAllFiveBarStates()
      _rigState = createInitialEliteRig()
      markDirty()
    },

    reloadRightMouthFiveBarRuntime() {
      resetAllFiveBarStates()
      markDirty()
    },

    reloadLeftMouthFiveBarRuntime() {
      resetAllFiveBarStates()
      markDirty()
    },

    reloadMouthFiveBarRuntimes() {
      resetAllFiveBarStates()
      markDirty()
    },

    resetEyeRigState() {
      const fresh = createInitialEliteRig()
      _rigState = {
        ..._rigState,
        browL: fresh.browL,
        browR: fresh.browR,
        eyeL: fresh.eyeL,
        eyeR: fresh.eyeR,
        noseL: fresh.noseL,
        noseR: fresh.noseR,
        sharedRadar: fresh.sharedRadar,
      }
      markDirty()
    },

    resetMouthRigState() {
      resetAllFiveBarStates()
      const fresh = createInitialEliteRig()
      _rigState = {
        ..._rigState,
        mouth: fresh.mouth,
        tongue: fresh.tongue,
        jaw: fresh.jaw,
      }
      markDirty()
    },

    setControlValue(controlId, channel, value) {
      _rigState = setEliteRigControlRaw(_rigState, controlId, channel, value)
      markDirty()
    },

    evaluate() {
      return runEvaluate()
    },

    getLogicalPose() {
      return { ...ensureEvaluated().logicalPose }
    },

    getActualPose() {
      return { ...ensureEvaluated().actualPose }
    },

    getContributions() {
      return [...ensureEvaluated().contributions]
    },

    getWarnings() {
      return [...ensureEvaluated().warnings]
    },

    /**
     * 只读预览：不写串口。空 logicalPose / 空 configs 时 moves 为空并附加说明性 warnings。
     */
    getMovesPreview(timeMs = 500) {
      const base = previewBase(timeMs)
      if (base.skipBuild) {
        return { moves: [], logicalPose: base.logicalPose, warnings: base.warnings }
      }
      const moves = buildServoMovesFromPose({
        logicalPose: base.logicalPose,
        configs: _configs,
        timeMs: base.safeTimeMs,
      })
      return { moves, logicalPose: base.logicalPose, warnings: base.warnings }
    },

    /**
     * 只读预览：不写串口。command 结构与 WebSerial 下发帧一致（由 protocol 拼装）。
     */
    getCommandPreview(timeMs = 500) {
      const base = previewBase(timeMs)
      if (base.skipBuild) {
        return {
          command: "",
          moves: [],
          logicalPose: base.logicalPose,
          warnings: base.warnings,
        }
      }
      const moves = buildServoMovesFromPose({
        logicalPose: base.logicalPose,
        configs: _configs,
        timeMs: base.safeTimeMs,
      })
      const command =
        moves.length > 0
          ? buildServoCommandFromPose({
              logicalPose: base.logicalPose,
              configs: _configs,
              timeMs: base.safeTimeMs,
            })
          : ""
      return {
        command,
        moves,
        logicalPose: base.logicalPose,
        warnings: base.warnings,
      }
    },

    addBinding(binding) {
      _profile = bindingActions.addBinding(_profile, binding)
      markDirty()
    },

    updateBinding(bindingId, patch) {
      _profile = bindingActions.updateBinding(_profile, bindingId, patch)
      markDirty()
    },

    deleteBinding(bindingId) {
      _profile = bindingActions.deleteBinding(_profile, bindingId)
      markDirty()
    },

    duplicateBinding(bindingId) {
      _profile = bindingActions.duplicateBinding(_profile, bindingId)
      markDirty()
    },

    duplicateBindingAsReverse(bindingId) {
      _profile = bindingActions.duplicateBindingAsReverse(_profile, bindingId)
      markDirty()
    },

    reverseBinding(bindingId) {
      _profile = bindingActions.reverseBinding(_profile, bindingId)
      markDirty()
    },

    restoreBindingFullRange(bindingId) {
      _profile = bindingActions.restoreBindingFullRange(_profile, bindingId)
      markDirty()
    },

    setBindingNeutralFromCurrent(bindingId) {
      const { contributions } = ensureEvaluated()
      _profile = bindingActions.setBindingNeutralFromContribution(_profile, bindingId, contributions)
      markDirty()
    },

    setBindingPositiveFromCurrent(bindingId) {
      const { contributions } = ensureEvaluated()
      _profile = bindingActions.setBindingPositiveFromContribution(_profile, bindingId, contributions)
      markDirty()
    },

    setBindingNegativeFromCurrent(bindingId) {
      const { contributions } = ensureEvaluated()
      _profile = bindingActions.setBindingNegativeFromContribution(_profile, bindingId, contributions)
      markDirty()
    },

    exportProfile() {
      return buildFaceRigExportPayload(_profile)
    },

    importProfile(data) {
      _profile = parseFaceRigImport(data)
      markDirty()
    },

    saveProfile() {
      _profile = saveFaceRigProfile(_profile)
      markDirty()
      return _profile
    },
  }
}
