import { createInitialEliteRig } from "../../core/faceDofMapper.js"

export const TRACKING_FRAME_TYPE = "tracking.rigFrame"

/** @typedef {ReturnType<createInitialEliteRig>} EliteRigState */

/**
 * @typedef {Object} RigFrameDebugBlendshapes
 * @property {number} jawOpen
 * @property {number} eyeBlinkLeft
 * @property {number} eyeBlinkRight
 * @property {number} eyeWideLeft
 * @property {number} eyeWideRight
 * @property {number} mouthSmileLeft
 * @property {number} mouthSmileRight
 * @property {number} mouthUpperUpLeft
 * @property {number} mouthUpperUpRight
 * @property {number} mouthLowerDownLeft
 * @property {number} mouthLowerDownRight
 * @property {number} mouthPucker
 * @property {number} mouthFunnel
 * @property {number} mouthClose
 * @property {number} browInnerUp
 * @property {number} browOuterUpLeft
 * @property {number} browOuterUpRight
 */

/**
 * @typedef {Object} RigFrameDebugMapping
 * @property {number} jaw
 * @property {number} blinkLeft
 * @property {number} blinkRight
 * @property {number} smileLeft
 * @property {number} smileRight
 * @property {number} browLeft
 * @property {number} browRight
 * @property {number} eyeOpenBiasLeft
 * @property {number} eyeOpenBiasRight
 * @property {number} eyeLUp
 * @property {number} eyeLLo
 * @property {number} eyeRUp
 * @property {number} eyeRLo
 * @property {number} browInner
 * @property {number} browOuterLeft
 * @property {number} browOuterRight
 * @property {number} browLeftTip
 * @property {number} browLeftMid
 * @property {number} browLeftTail
 * @property {number} browRightTip
 * @property {number} browRightMid
 * @property {number} browRightTail
 * @property {number} upperLipLeft
 * @property {number} upperLipRight
 * @property {number} lowerLipLeft
 * @property {number} lowerLipRight
 * @property {number} [lipGeoUpperL] — landmark geometry 平滑后（signed100 语义）
 * @property {number} [lipGeoUpperR]
 * @property {number} [lipGeoLowerL]
 * @property {number} [lipGeoLowerR]
 * @property {number} mouthPucker - 仅调试 0～100，第一版不参与 rig
 * @property {number} mouthFunnel - 同上
 * @property {number} [eyeLookX] — 视线语义水平分量（约 −1～1，经 deadzone/gain/invert 后）
 * @property {number} [eyeLookY] — 视线语义垂直分量
 * @property {number} [sharedRadarX] — 映射到 rig.sharedRadar.x 的 0～100
 * @property {number} [sharedRadarY] — 映射到 rig.sharedRadar.y 的 0～100
 */

/**
 * @typedef {Object} RigFrameDebugGaze
 * @property {boolean} available
 * @property {number} eyeLookX
 * @property {number} eyeLookY
 * @property {number} leftEyeX
 * @property {number} leftEyeY
 * @property {number} rightEyeX
 * @property {number} rightEyeY
 */

/**
 * @typedef {Object} RigFrameLipAxis4
 * @property {number} upperL
 * @property {number} upperR
 * @property {number} lowerL
 * @property {number} lowerR
 */

/**
 * @typedef {Object} RigFrameDebugLipGeometry
 * @property {boolean} enabled
 * @property {boolean} neutralReady
 * @property {number} neutralCount
 * @property {number} mouthWidth
 * @property {RigFrameLipAxis4} deltaSmooth — 闭嘴时应接近 0
 * @property {RigFrameLipAxis4} deltaRaw
 * @property {RigFrameLipAxis4} [deltaAfterPoseGate]
 * @property {RigFrameLipAxis4} currentY
 * @property {RigFrameLipAxis4} neutralY
 * @property {RigFrameLipAxis4} rigWrite — 写入 rig 的最终值
 * @property {RigFrameLipAxis4} blendshapeTerm
 * @property {{ upperOpenPositive?: boolean, lowerOpenNegative?: boolean, upperSign?: number, lowerSign?: number, yAxisTowardChin?: boolean }} [signConvention]
 * @property {string} [coordinateMode]
 * @property {Record<string, unknown>} [pose]
 * @property {Record<string, unknown>} [poseNeutral]
 * @property {Record<string, unknown>} [poseGate]
 * @property {Record<string, unknown>} [closedHeadTurnLock]
 * @property {Record<string, unknown>} [gateDecision]
 * @property {string} [mouthScenario]
 * @property {boolean} [noseAnchorMotion]
 * @property {RigFrameDebugNoseAnchor} [noseAnchor]
 * @property {number} [upperL] — 扁平兼容，同 deltaSmooth.upperL
 * @property {number} [upperR]
 * @property {number} [lowerL]
 * @property {number} [lowerR]
 * @property {number} [upperLRaw]
 * @property {number} [upperRRaw]
 * @property {number} [lowerLRaw]
 * @property {number} [lowerRRaw]
 * @property {number} [isolation] — (upperMag−lowerMag) / sum；正负粗略区分主导唇轴
 * @property {{ suppressedUpper?: boolean, suppressedLower?: boolean }} [crossTalk]
 * @property {Record<string, unknown>} [sourceBreakdown]
 * @property {string} [skipped]
 */

/**
 * @typedef {Object} RigFrameDebugMouthAxis4
 * @property {number} [upperL]
 * @property {number} [upperR]
 * @property {number} [lowerL]
 * @property {number} [lowerR]
 */

/**
 * @typedef {Object} RigFrameDebugMouthDebug
 * @property {{ upperL?: number, upperR?: number, lowerL?: number, lowerR?: number, aperture?: number, upperLip?: number, lowerLip?: number, pucker?: number, funnel?: number }} [geometryRaw]
 * @property {{ upperL?: number, upperR?: number, lowerL?: number, lowerR?: number, aperture?: number }} [relative]
 * @property {RigFrameDebugMouthAxis4 & { rawMouthScore?: number }} [normalizedBeforeClamp]
 * @property {RigFrameDebugMouthAxis4 & { rawMouthScore?: number }} [normalizedAfterClamp]
 * @property {RigFrameDebugMouthAxis4} [final]
 */

/**
 * @typedef {Object} RigFrameDebugInputSource
 * @property {'camera' | 'video' | 'replay'} sourceType
 * @property {string} sourceId
 * @property {number} sourceSeq
 * @property {number} frameIndex
 * @property {number} timestampMs
 * @property {number | null} [videoTimeMs]
 * @property {number | null} [playbackRate]
 * @property {boolean} [paused]
 * @property {boolean} [seeking]
 * @property {number} [seekEpoch]
 */

/**
 * @typedef {Object} RigFrameDebugJawGeometry
 * @property {boolean} [enabled]
 * @property {boolean} [neutralReady]
 * @property {number} [semanticOpen] — 张嘴语义 0～100（独立 jaw 通道）
 * @property {number | {jaw?: number}} [rigWrite]
 * @property {number} [smoothSemantic]
 * @property {number} [raw]
 * @property {number} [curved]
 * @property {number} [jawSigned]
 * @property {number} [jawSmooth]
 * @property {"3d" | "2d_fallback" | string} [coordinateMode]
 * @property {string} [skipped]
 * @property {Record<string, unknown>} [pose]
 * @property {Record<string, unknown>} [poseGate]
 * @property {Record<string, unknown>} [neutralState]
 * @property {Record<string, unknown>} [components]
 * @property {Record<string, unknown>} [gating]
 * @property {Record<string, unknown>} [curve]
 * @property {Record<string, unknown>} [stabilizer]
 * @property {{ internalOpenPositive?: boolean, jawOutputSign?: number, rigOpenNegative?: boolean, yAxisTowardChin?: boolean }} [signConvention]
 * @property {string} [mouthScenario]
 * @property {boolean} [noseAnchorMotion]
 * @property {boolean} [oldMouthPoseHeadMotionActive]
 * @property {Record<string, unknown>} [gateDecision]
 * @property {RigFrameDebugNoseAnchor} [noseAnchor]
 */

/**
 * @typedef {Object} RigFrameDebugNoseAnchor
 * @property {boolean} [enabled]
 * @property {boolean} [ok]
 * @property {"3d" | "2d_fallback" | string} [coordinateMode]
 * @property {{ x?: number, y?: number, z?: number }} [center]
 * @property {number} [scale]
 * @property {{ x?: number, y?: number, z?: number }} [vector]
 * @property {Record<string, unknown>} [neutral]
 * @property {boolean} [neutralReady]
 * @property {Record<string, unknown>} [neutralState]
 * @property {boolean} [calibrating]
 * @property {Record<string, unknown>} [delta]
 * @property {number} [motionScore]
 * @property {boolean} [motionActive]
 * @property {Record<string, unknown>} [thresholds]
 * @property {string} [error]
 */

/**
 * @typedef {Object} RigFrameDebugMouthScenarioClassifier
 * @property {Record<string, unknown>} [rawMouthEvidence]
 * @property {Record<string, unknown>} [headMotionEvidence]
 * @property {Record<string, unknown>} [reliableMouthEvidence]
 * @property {Record<string, unknown>} [strongMouthEvidence]
 * @property {Record<string, unknown>} [openCloseEvidence]
 * @property {Record<string, unknown>} [openCloseGuard]
 * @property {boolean} [rawMouthActive]
 * @property {boolean} [rawMouthInactive]
 * @property {boolean} [headMotionActive]
 * @property {boolean} [reliable]
 * @property {boolean} [lipOnlyArtifact]
 * @property {string} [candidateScenario]
 * @property {string} [finalScenario]
 * @property {number} [candidateCount]
 * @property {number} [requiredConfirmFrames]
 * @property {Record<string, unknown>} [thresholds]
 * @property {Record<string, unknown>} [decision]
 * @property {Record<string, unknown>} [immediateArtifactLock]
 * @property {boolean} [neutralReady]
 */

/**
 * @typedef {Object} RigFrameDebugBrowGate
 * @property {boolean} [enabled]
 * @property {string} [finalScenario]
 * @property {string} [decisionReason]
 * @property {string} [classifierReason]
 * @property {boolean} [immediateArtifactLock]
 * @property {boolean} [neutralReady]
 * @property {Record<string, boolean>} [neutralReadyDetails]
 * @property {boolean} [headMotionLikely]
 * @property {boolean} [mouthMotionLikely]
 * @property {boolean} [browSafePose]
 * @property {number} [browAbsMax]
 * @property {boolean} [explicitBrowActive]
 * @property {number} [explicitBrowCount]
 * @property {string} [gateAction]
 * @property {number} [suppressScale]
 * @property {number} [outputDeadband]
 * @property {number} [snapToZero]
 * @property {boolean} [resetPrevOnLock]
 * @property {Record<string, unknown>} [evidence]
 * @property {Record<string, unknown>} [thresholds]
 * @property {Record<string, number>} [before]
 * @property {Record<string, number>} [after]
 */

/**
 * @typedef {Object} RigFrameDebug
 * @property {RigFrameDebugBlendshapes} [blendshapes]
 * @property {RigFrameDebugMapping} [mapping]
 * @property {RigFrameDebugGaze} [gaze]
 * @property {RigFrameDebugLipGeometry} [lipGeometry]
 * @property {RigFrameDebugMouthDebug} [mouthDebug]
 * @property {RigFrameDebugInputSource} [inputSource]
 * @property {RigFrameDebugJawGeometry} [jawGeometry]
 * @property {RigFrameDebugNoseAnchor} [noseAnchor]
 * @property {RigFrameDebugMouthScenarioClassifier} [mouthScenarioClassifier]
 * @property {RigFrameDebugBrowGate} [browGate]
 * @property {Record<string, unknown>} [brow]
 */

/**
 * @typedef {Object} RigFrame
 * @property {"tracking.rigFrame"} type
 * @property {"none"|"mediapipe-web"|"python-websocket"|"python-mediapipe"|string} source
 * @property {number} timestampMs
 * @property {number} [frameSeq] — 服务端单调序号，用于丢帧检测
 * @property {number} [serverSentAtMs] — 服务端发送时刻（毫秒 epoch）
 * @property {boolean} faceDetected
 * @property {number} quality
 * @property {EliteRigState} rig
 * @property {RigFrameDebug} [debug] — Python MediaPipe 等可选调试；不参与 rig 驱动与舵机。
 * @property {{ isStatusFrame?: boolean, excludeFromSummary?: boolean, statusReason?: string }} [diagnostic]
 */

/**
 * @typedef {Object} TrackingStatus
 * @property {boolean} running
 * @property {string} source
 * @property {boolean} faceDetected
 * @property {number} fps
 * @property {number} quality
 * @property {number} lastFrameAt
 * @property {string | null} error
 */

/**
 * @typedef {Object} TrackingAdapter
 * @property {() => void} start
 * @property {() => void} stop
 * @property {() => void} dispose
 * @property {() => boolean} isRunning
 * @property {(cb: (frame: RigFrame) => void) => void} onFrame
 * @property {(cb: (frame: RigFrame) => void) => void} offFrame
 * @property {() => TrackingStatus} getStatus
 * @property {() => void} [clearState]
 */

/**
 * @returns {RigFrame}
 */
export function createEmptyRigFrame() {
  return {
    type: TRACKING_FRAME_TYPE,
    source: "none",
    timestampMs: 0,
    faceDetected: false,
    quality: 0,
    rig: createInitialEliteRig(),
  }
}
