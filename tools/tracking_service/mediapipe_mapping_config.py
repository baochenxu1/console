"""
MediaPipe → Rig 映射 JSON 的加载、保存与数值工具。
不涉及 WebSocket 与舵机。
"""

from __future__ import annotations

import json
import math
from copy import deepcopy
from pathlib import Path
from typing import Any

# mouth_corner_geometry 延迟导入会循环；默认表在下方局部构造后由 normalize 合并。

_DEFAULT_NEUTRAL: dict[str, float] = {
    "jawOpen": 0.0,
    "eyeBlinkLeft": 0.0,
    "eyeBlinkRight": 0.0,
    "eyeWideLeft": 0.0,
    "eyeWideRight": 0.0,
    "mouthSmileLeft": 0.0,
    "mouthSmileRight": 0.0,
    "mouthUpperUpLeft": 0.0,
    "mouthUpperUpRight": 0.0,
    "mouthLowerDownLeft": 0.0,
    "mouthLowerDownRight": 0.0,
    "mouthPucker": 0.0,
    "mouthFunnel": 0.0,
    "mouthClose": 0.0,
    "browInnerUp": 0.0,
    "browOuterUpLeft": 0.0,
    "browOuterUpRight": 0.0,
    "eyeLookX": 0.0,
    "eyeLookY": 0.0,
}

_DEFAULT_GAINS: dict[str, float] = {
    "jaw": 1.0,
    "blinkLeft": 1.0,
    "blinkRight": 1.0,
    "smileLeft": 1.0,
    "smileRight": 1.0,
    "browLeft": 1.0,
    "browRight": 1.0,
    "browInner": 1.0,
    "browOuterLeft": 1.0,
    "browOuterRight": 1.0,
    "eyeLookX": 1.0,
    "eyeLookY": 1.0,
    "eyeOpenLeft": 1.0,
    "eyeOpenRight": 1.0,
    "browTipLeft": 1.0,
    "browTipRight": 1.0,
    "browTailLeft": 1.0,
    "browTailRight": 1.0,
    "upperLipLeft": 1.0,
    "upperLipRight": 1.0,
    "lowerLipLeft": 1.0,
    "lowerLipRight": 1.0,
}

_DEFAULT_INVERT: dict[str, bool] = {
    "jaw": True,
    "blinkLeft": False,
    "blinkRight": False,
    "smileLeft": False,
    "smileRight": False,
    "browLeft": False,
    "browRight": False,
    "browInner": False,
    "browOuterLeft": False,
    "browOuterRight": False,
    "eyeLookX": False,
    "eyeLookY": False,
    "eyeOpenLeft": False,
    "eyeOpenRight": False,
    "browTipLeft": False,
    "browTipRight": False,
    "browTailLeft": False,
    "browTailRight": False,
    "upperLipLeft": False,
    "upperLipRight": False,
    "lowerLipLeft": False,
    "lowerLipRight": False,
}

_DEFAULT_DEADZONE: dict[str, float] = {
    "jaw": 0.03,
    "blink": 0.03,
    "smile": 0.03,
    "brow": 0.03,
    "eyeLook": 0.03,
    "eyeOpen": 0.03,
    "lip": 0.03,
}

_DEFAULT_LIMITS: dict[str, list[float]] = {
    "jaw": [0.0, 100.0],
    "blink": [0.0, 100.0],
    "smile": [0.0, 100.0],
    "brow": [0.0, 100.0],
    "browPoint": [0.0, 100.0],
    "eyeLookX": [30.0, 70.0],
    "eyeLookY": [30.0, 70.0],
    "eyeOpen": [-100.0, 100.0],
    "lip": [0.0, 100.0],
}

_DEFAULT_SMOOTHING: dict[str, Any] = {"enabled": False, "alpha": 0.6}

_DEFAULT_GAZE: dict[str, Any] = {
    "gazeEstimatorMode": "mediapipe_iris_only_v1",
    "enabled": True,
    "preferIrisLandmarks": True,
    "irisInitEnabled": False,
    "irisXGain": 5.0,
    "irisYGain": 5.0,
    "irisYGainUp": 5.0,
    "irisYGainDown": 13.0,
    "irisYGainDownRatio": 2.6,
    "irisWarmupFrames": 20,
    "irisWarmupMinSamples": 12,
    "irisWarmupMaxWaitFrames": 45,
    "irisWarmupMaxHeadPx": 0.35,
    "irisSoftNormKnee": 0.22,
    "irisSoftNormKneeX": 0.22,
    "irisSoftNormKneeY": 0.18,
    "irisLocalDriveDeadzone": 0.012,
    "irisLocalDriveDeadzoneX": 0.012,
    "irisLocalDriveDeadzoneY": 0.007,
    "irisQuietRecenterDrive": 0.014,
    "irisQuietRecenterAlpha": 0.32,
    "irisQuietRecenterAlphaY": 0.42,
    "irisQuietBaselineAlpha": 0.006,
    "irisQuietBaselineAlphaY": 0.012,
    "irisHeadMotionHoldPx": 1.4,
    "irisHeadMotionSoftPx": 0.65,
    "irisInvertX": False,
    "irisInvertY": False,
    "irisDeadzoneX": 0.001,
    "irisDeadzoneY": 0.001,
    "irisOutputSpanX": 18.0,
    "irisOutputSpanY": 20.0,
    "irisEmaAlpha": 0.58,
    "irisMaxDeltaNormPerFrame": 0.18,
    "irisMaxStepSharedRadar": 10.0,
    "irisMissingHoldFrames": 10,
    "irisMissingDecayLerp": 0.05,
    "irisMinEyeWidth": 0.003,
    "irisMaxEyeWidth": 0.5,
    "freezeOnBlink": True,
    "blinkFreezeEnterThreshold": 0.48,
    "blinkInstantHoldThreshold": 0.42,
    "blinkFreezeReleaseThreshold": 0.38,
    "blinkFreezeReleaseHoldFrames": 3,
    "blinkFreezeMaxFrames": 10,
    "blinkReleaseBlendFrames": 2,
    "blinkWarmupBlockThreshold": 0.48,
    "blinkFreezeThreshold": 0.48,
}

_DEFAULT_EYE: dict[str, Any] = {
    "openBiasLeft": 20.0,
    "openBiasRight": 20.0,
    "lowerLidOpenRatio": 0.25,
    "lowerLidCloseRatio": 0.5,
    "useEyeWide": False,
    "eyeWideScale": 30.0,
}

_DEFAULT_BROW: dict[str, Any] = {
    "midInnerWeight": 0.4,
    "midOuterWeight": 0.6,
    "leftTipChannel": "tip",
    "leftTailChannel": "tail",
    "rightTipChannel": "tip",
    "rightTailChannel": "tail",
}

_DEFAULT_LIP: dict[str, Any] = {
    "enabled": True,
    "upperScale": 100.0,
    "lowerScale": 100.0,
    "puckerEnabled": False,
    "funnelEnabled": False,
}

_DEFAULT_LIP_GEOMETRY: dict[str, Any] = {
    "enabled": True,
    "neutralFrames": 30,
    "neutralWarmupFrames": 8,
    "minMouthWidth": 0.03,
    "autoNeutralOnStart": True,
    "requireNeutralReadyForOutput": True,
    "neutralMaxJaw": 8.0,
    "neutralMaxJawOpen": 8.0,
    "neutralMaxSmile": 12.0,
    "neutralMaxSideOffset": 10.0,
    "neutralMaxLipDelta": 8.0,
    "neutralMaxLipVelocity": 3.0,
    "neutralStableFrames": 10,
    "neutralTrackMinQuality": 0.5,
    "driftCorrectionEnabled": True,
    "driftCorrectionAlpha": 0.015,
    "driftCorrectionMaxStep": 0.0008,
    "driftCorrectionStartAfterMs": 1500.0,
    "upperGain": 1000.0,
    "lowerGain": 1000.0,
    "upperSign": 1.0,
    "lowerSign": 1.0,
    "deadzone": 0.8,
    "snapToZero": 0.6,
    "alphaSlow": 0.32,
    "alphaFast": 0.86,
    "fastDelta": 7.0,
    "outputHoldDeadband": 1.0,
    "outputReleaseThreshold": 2.0,
    "maxStepPerFrame": 24.0,
    "minOutputDelta": 0.0,
    "stableHoldFrames": 0,
    "blendshapeMix": 0.06,
    "useApertureForLip": False,
    "useJawForLip": False,
    "removeJawFromLip": False,
    "jawToUpperCompensation": 0.18,
    "jawToLowerCompensation": 0.35,
    "reAddJawToLip": False,
    "jawToUpperLipGain": 0.10,
    "jawToLowerLipGain": 0.18,
    "crossTalkSuppressionEnabled": False,
    "poseAwareFrameEnabled": True,
    "poseGateEnabled": True,
    "maxYawProxyDelta": 0.10,
    "maxPitchProxyDelta": 0.10,
    "maxRollDeltaDeg": 12.0,
    "maxFaceScaleDelta": 0.18,
    "poseMotionSuppressScale": 0.20,
    "poseGateZeroWhenNoMouthMotion": True,
    "poseGateMouthMotionThreshold": 6.0,
    "poseGateOutputClamp": 5.0,
    "use3dLocalCoordinate": True,
    "closedHeadTurnLockEnabled": True,
    "headMotionYawThreshold": 0.020,
    "headMotionPitchThreshold": 0.035,
    "headMotionRollThresholdDeg": 4.0,
    "headMotionScaleThreshold": 0.020,
    "closedHeadTurnJawAbsMax": 8.0,
    "closedHeadTurnUseLipAbsAsVeto": False,
    "closedHeadTurnLipVetoAbsMax": 35.0,
    "closedHeadTurnUseApertureEvidence": True,
    "closedHeadTurnApertureDeltaMax": 0.018,
    "closedHeadTurnUseBlendshapeEvidence": True,
    "closedHeadTurnMouthOpenMax": 12.0,
    "closedHeadTurnJawOpenMax": 12.0,
    "closedHeadTurnSmileMax": 18.0,
    "closedHeadTurnUseCornerEvidence": True,
    "closedHeadTurnCornerOffsetMax": 18.0,
    "closedHeadTurnOutputClamp": 0.0,
    "closedHeadTurnResetPrev": True,
    "closedHeadTurnRequirePoseMotion": True,
    "frontalMouthMotionThreshold": 4.0,
    "neutralThreshold": 2.0,
    "crossTalkRatio": 1.8,
    "crossTalkPassiveMax": 12.0,
    "crossTalkAttenuation": 0.25,
    "upperLeftIndices": [40, 80, 81],
    "upperRightIndices": [270, 310, 311],
    "lowerLeftIndices": [91, 88, 178],
    "lowerRightIndices": [321, 318, 402],
    "leftCornerIndex": 61,
    "rightCornerIndex": 291,
    "chinIndex": 152,
}

_DEFAULT_JAW_GEOMETRY: dict[str, Any] = {
    "enabled": True,
    "neutralFrames": 30,
    "neutralWarmupFrames": 8,
    "minMouthWidth": 0.03,
    "neutralTrackMinQuality": 0.5,
    "neutralMaxJawBlend": 8.0,
    "neutralMaxSmile": 12.0,
    "neutralMaxSideOffset": 10.0,
    "jawOutputSign": -1.0,
    "use3dLocalCoordinate": True,
    "useChinAsPrimary": False,
    "chinWeight": 0.0,
    "apertureGain": 780.0,
    "lowerInnerGain": 520.0,
    "lowerLipCenterGain": 280.0,
    "blendshapeMix": 0.08,
    "apertureWeight": 0.50,
    "lowerInnerWeight": 0.35,
    "lowerLipCenterWeight": 0.15,
    "upperLipOpenCompensation": 0.55,
    "poseGateEnabled": True,
    "maxYawProxyDelta": 0.10,
    "maxPitchProxyDelta": 0.10,
    "maxRollDeltaDeg": 12.0,
    "maxFaceScaleDelta": 0.18,
    "poseMotionSuppressScale": 0.25,
    "deadzone": 2.0,
    "snapToZero": 0.9,
    "alphaSlow": 0.30,
    "alphaFast": 0.92,
    "fastDelta": 5.0,
    "maxStepPerFrame": 34.0,
    "outputHoldDeadband": 1.4,
    "outputReleaseThreshold": 2.6,
    "curveDeadzoneInput": 2.0,
    "curveSmallKneeInput": 12.0,
    "curveSmallOutput": 10.0,
    "curveFullInput": 38.0,
    "curveMaxOutput": 95.0,
    "jawBlendshapeName": "jawOpen",
    "leftCornerIndex": 61,
    "rightCornerIndex": 291,
    "upperInnerIndex": 13,
    "lowerInnerIndex": 14,
    "upperOuterIndex": 0,
    "lowerOuterIndex": 17,
    "chinIndex": 152,
    "noseTipIndex": 1,
    "foreheadIndex": 10,
    "lowerLipCenterIndices": [14, 17, 87, 317],
}

_JAW_GEOMETRY_BOOL_KEYS = ("enabled", "use3dLocalCoordinate", "useChinAsPrimary", "poseGateEnabled")


_LIP_GEOMETRY_BOOL_KEYS = (
    "enabled",
    "autoNeutralOnStart",
    "requireNeutralReadyForOutput",
    "driftCorrectionEnabled",
    "useApertureForLip",
    "useJawForLip",
    "removeJawFromLip",
    "reAddJawToLip",
    "crossTalkSuppressionEnabled",
    "poseAwareFrameEnabled",
    "poseGateEnabled",
    "poseGateZeroWhenNoMouthMotion",
    "use3dLocalCoordinate",
    "closedHeadTurnLockEnabled",
    "closedHeadTurnResetPrev",
    "closedHeadTurnRequirePoseMotion",
    "closedHeadTurnUseLipAbsAsVeto",
    "closedHeadTurnUseApertureEvidence",
    "closedHeadTurnUseBlendshapeEvidence",
    "closedHeadTurnUseCornerEvidence",
)


# Nose Anchor Gate V1：只用鼻部锚点判断 head motion。
_DEFAULT_NOSE_ANCHOR = {
    "enabled": True,
    "noseTipIndex": 1,
    "noseBridgeIndices": [4, 5, 6, 195, 197],
    "useNoseClusterCenter": True,
    "useNoseBridgeVector": True,
    "minNoseScale": 0.005,
    "use3d": True,
    "neutralWarmupFrames": 8,
    "neutralFrames": 30,
    "motionThreshold": 0.12,
    "positionThreshold": 0.10,
    "scaleThreshold": 0.08,
    "vectorThreshold": 0.12,
}
_NOSE_ANCHOR_BOOL_KEYS = ("enabled", "useNoseClusterCenter", "useNoseBridgeVector", "use3d")

# Mouth Scenario 阈值（lip / jaw 共用）。Evidence-First V2。
_DEFAULT_MOUTH_SCENARIO = {
    # legacy（兼容旧路径）
    "frontalMouthMotionThreshold": 4.0,
    "neutralThreshold": 2.0,
    # Evidence-First：嘴部 raw 证据阈值（0~100 量级）
    "mouthOnThreshold": 3.5,
    "mouthOffThreshold": 1.5,
    # head motion 证据阈值（nose motionScore 量级）
    "headOnThreshold": 0.12,
    "headOffThreshold": 0.08,
    # 只有嘴部 raw 证据低于该值才允许判定 closed_head_turn
    "closedTurnRequireMouthBelow": 2.2,
    # 状态机确认帧数（迟滞）
    "frontalConfirmFrames": 2,
    "closedTurnConfirmFrames": 3,
    "neutralConfirmFrames": 5,
    # 嘴动优先
    "preferMouthMotionOverHeadMotion": True,
    # raw 证据归一化缩放
    "apertureScoreScale": 300.0,
    # reliableMouthEvidence：head motion 时判断是否真有嘴部动作（不含 lipAbsMax）
    "reliableApertureThreshold": 12.0,
    "reliableJawInputThreshold": 12.0,
    "reliableJawScoreThreshold": 12.0,
    "reliableBlendOpenThreshold": 8.0,
    "reliableCornerOffsetThreshold": 10.0,
    "reliableMinSourceCount": 2,
    # head_motion_mouth_motion 保守输出比例（分 lip / jaw，不再统一 0.35 压死）
    "headMotionMouthSuppressScale": 0.85,
    "headMotionLipSuppressScale": 0.85,
    "headMotionJawSuppressScale": 0.75,
    # Strong Mouth Override：强嘴部动作覆盖 head motion，避免大张嘴被压成 closed_head_turn
    "strongMouthOverrideEnabled": True,
    "strongMouthScoreThreshold": 12.0,
    "strongJawScoreThreshold": 45.0,
    "strongJawInputThreshold": 45.0,
    "strongApertureThreshold": 35.0,
    "strongBlendOpenThreshold": 18.0,
    "strongReliableSourceCount": 3,
    "strongOverrideScenario": "frontal_mouth_motion",
    # Open-Close Guard：连续张闭嘴保护，否决 Immediate Artifact Lock（lipAbsMax 不能单独触发）
    "openCloseGuardEnabled": True,
    "openCloseJawInputThreshold": 8.0,
    "openCloseJawScoreThreshold": 8.0,
    "openCloseApertureThreshold": 8.0,
    "openCloseBlendOpenThreshold": 6.0,
    "openCloseMinReliableSources": 1,
    "openCloseConfirmFrames": 2,
    "openCloseHoldFrames": 8,
    "openCloseBlockImmediateArtifactLock": True,
    "openCloseScenario": "frontal_mouth_motion",
    "openCloseOutputScale": 0.75,
    "openCloseLipScale": 0.85,
    "openCloseJawScale": 0.75,
    # 稳定 headScore（偏高但不再变化）时允许正脸嘴动
    "headScoreVelocityThreshold": 0.08,
    "stableHeadStrongMouthThreshold": 18.0,
    "stableHeadRawMouthThreshold": 12.0,
    "closedHeadTurnMouthMax": 8.0,
    # head_motion_mouth_motion 适度缩放（不锁零）
    "headMotionMouthLipScale": 0.95,
    "headMotionMouthJawScale": 0.85,
    "artifactLockSoftMouthThreshold": 30.0,
    "artifactLockSoftLipScale": 0.75,
    "artifactLockSoftJawScale": 0.65,
}
_MOUTH_SCENARIO_BOOL_KEYS = (
    "preferMouthMotionOverHeadMotion",
    "strongMouthOverrideEnabled",
    "openCloseGuardEnabled",
    "openCloseBlockImmediateArtifactLock",
)
_MOUTH_SCENARIO_STR_KEYS = ("strongOverrideScenario", "openCloseScenario")

# Brow Scenario Gate（强化版独立 artifact gate）。
_DEFAULT_BROW_GATE = {
    "enabled": True,
    "lockOnHeadMotionLikely": True,
    "suppressDuringMouthMotion": True,
    "browMinQuality": 0.5,
    "browHeadMotionScoreThreshold": 0.08,
    "browMouthMotionScoreThreshold": 3.5,
    "browRawOnThreshold": 14.0,
    "browRawOffThreshold": 6.0,
    "browConfirmFrames": 4,
    "mouthMotionSuppressScale": 0.15,
    "headMotionSuppressScale": 0.0,
    "snapToZero": 2.5,
    "outputDeadband": 5.0,
    "resetPrevOnLock": True,
}
_BROW_GATE_BOOL_KEYS = (
    "enabled",
    "lockOnHeadMotionLikely",
    "suppressDuringMouthMotion",
    "resetPrevOnLock",
)


def _safe_float(v: Any, fallback: float = 0.0) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return fallback
    if math.isnan(x) or math.isinf(x):
        return fallback
    return x


def apply_deadzone(value: float, threshold: float) -> float:
    t = max(0.0, _safe_float(threshold, 0.0))
    v = _safe_float(value, 0.0)
    if abs(v) < t:
        return 0.0
    return v


def apply_soft_deadzone(value: float, threshold: float, knee: float) -> float:
    """软 deadzone：阈值内为 0，超出后平滑过渡，保留小幅趋势。"""
    t = max(0.0, _safe_float(threshold, 0.0))
    k = max(1e-6, _safe_float(knee, t * 0.5))
    v = _safe_float(value, 0.0)
    ax = abs(v)
    if ax <= t:
        return 0.0
    y = ax - t
    smooth = (y * y) / (2.0 * k) if y < k else y - k / 2.0
    return math.copysign(smooth, v)


def apply_gain(value: float, gain: float) -> float:
    return _safe_float(value, 0.0) * _safe_float(gain, 1.0)


def apply_invert_signed(value: float, enabled: bool) -> float:
    """有符号中间量取反：value → -value。勿用于已落在 [min,max] 的单极强度。"""
    v = _safe_float(value, 0.0)
    return -v if bool(enabled) else v


def apply_invert(value: float, enabled: bool) -> float:
    """兼容旧名，等同 `apply_invert_signed`。"""
    return apply_invert_signed(value, enabled)


def apply_invert_unipolar(
    value: float, enabled: bool, min_value: float, max_value: float
) -> float:
    """
    在同一单极区间 [min,max] 内做反射：inverted = min + max - clamp(value)。
    适用于仍须落在该区间内的语义强度（如 blink→眼睑、smile/brow 的百分比派生）。
    **jaw** 在 `mediapipe_to_rig` 中单独处理：invert 时对强度取负写入 signed `jaw.val`（约 0～−100），勿用本函数。
    """
    lo = _safe_float(min_value, 0.0)
    hi = _safe_float(max_value, 100.0)
    if hi < lo:
        lo, hi = hi, lo
    v = clamp(value, lo, hi)
    if not bool(enabled):
        return v
    return lo + hi - v


def clamp(value: float, min_value: float, max_value: float) -> float:
    lo = _safe_float(min_value, 0.0)
    hi = _safe_float(max_value, 100.0)
    if hi < lo:
        lo, hi = hi, lo
    return max(lo, min(hi, _safe_float(value, 0.0)))


def create_default_mapping_config() -> dict[str, Any]:
    from mouth_corner_geometry import default_mouth_corner_config

    return {
        "version": "1.0.0",
        "neutral": deepcopy(_DEFAULT_NEUTRAL),
        "gains": deepcopy(_DEFAULT_GAINS),
        "invert": deepcopy(_DEFAULT_INVERT),
        "deadzone": deepcopy(_DEFAULT_DEADZONE),
        "limits": deepcopy(_DEFAULT_LIMITS),
        "smoothing": deepcopy(_DEFAULT_SMOOTHING),
        "gaze": deepcopy(_DEFAULT_GAZE),
        "eye": deepcopy(_DEFAULT_EYE),
        "brow": deepcopy(_DEFAULT_BROW),
        "lip": deepcopy(_DEFAULT_LIP),
        "lipGeometry": deepcopy(_DEFAULT_LIP_GEOMETRY),
        "jawGeometry": deepcopy(_DEFAULT_JAW_GEOMETRY),
        "noseAnchor": deepcopy(_DEFAULT_NOSE_ANCHOR),
        "mouthScenario": deepcopy(_DEFAULT_MOUTH_SCENARIO),
        "browGate": deepcopy(_DEFAULT_BROW_GATE),
        "mouthCorner": default_mouth_corner_config(),
    }


def _merge_nested_dict(
    base: dict[str, Any], raw_section: Any, defaults: dict[str, Any]
) -> None:
    if not isinstance(raw_section, dict):
        return
    for k, v in defaults.items():
        if k in _BOOL_KEYS_NESTED:
            base[k] = bool(raw_section.get(k, v))
        elif isinstance(v, bool):
            base[k] = bool(raw_section.get(k, v))
        elif isinstance(v, (int, float)):
            base[k] = _safe_float(raw_section.get(k), float(v))
        else:
            base[k] = raw_section.get(k, v)


_BOOL_KEYS_NESTED = frozenset(
    {
        "enabled",
        "useEyeWide",
        "preferIrisLandmarks",
        "fallbackToNeutral",
        "puckerEnabled",
        "funnelEnabled",
    }
)


def normalize_mapping_config(raw: Any) -> dict[str, Any]:
    base = create_default_mapping_config()
    if not isinstance(raw, dict):
        return base

    base["version"] = str(raw.get("version") or base["version"])

    if isinstance(raw.get("neutral"), dict):
        for k, v in _DEFAULT_NEUTRAL.items():
            base["neutral"][k] = _safe_float(raw["neutral"].get(k), v)

    for section, defaults in (
        ("gains", _DEFAULT_GAINS),
        ("invert", _DEFAULT_INVERT),
        ("deadzone", _DEFAULT_DEADZONE),
    ):
        if isinstance(raw.get(section), dict):
            for k, v in defaults.items():
                if section == "invert":
                    base[section][k] = bool(raw[section].get(k, v))
                else:
                    base[section][k] = _safe_float(raw[section].get(k), v)

    if isinstance(raw.get("limits"), dict):
        for k, pair in _DEFAULT_LIMITS.items():
            p = raw["limits"].get(k)
            if isinstance(p, (list, tuple)) and len(p) >= 2:
                base["limits"][k] = [
                    _safe_float(p[0], pair[0]),
                    _safe_float(p[1], pair[1]),
                ]
            else:
                base["limits"][k] = list(pair)

    if isinstance(raw.get("smoothing"), dict):
        sm = raw["smoothing"]
        base["smoothing"]["enabled"] = bool(sm.get("enabled", base["smoothing"]["enabled"]))
        base["smoothing"]["alpha"] = clamp(
            _safe_float(sm.get("alpha"), base["smoothing"]["alpha"]), 0.0, 1.0
        )

    if isinstance(raw.get("gaze"), dict):
        gz = raw["gaze"]
        for k, v in _DEFAULT_GAZE.items():
            if k in (
                "enabled",
                "preferIrisLandmarks",
                "fallbackToNeutral",
                "freezeOnBlink",
                "disableGuardForDebug",
                "autoEyeCenterEnabled",
                "eyeCornerV3ProductionEnabled",
                "eyeCornerV3DebugEnabled",
                "gazeYProductionEnabled",
                "gazeXProductionEnabled",
                "neutralInitEnabled",
                "neutralInitRequireMouthClosed",
                "neutralInitRequireLowMotion",
                "neutralInitFreezeOutput",
                "neutralInitShowPrompt",
                "safeCenterFallbackEnabled",
            ):
                base["gaze"][k] = bool(gz.get(k, v))
            elif k in ("gazeEstimatorMode", "gazeXProductionMode"):
                base["gaze"][k] = str(gz.get(k, v))
            elif isinstance(v, bool):
                base["gaze"][k] = bool(gz.get(k, v))
            else:
                base["gaze"][k] = _safe_float(gz.get(k), float(v))

    if isinstance(raw.get("eye"), dict):
        _merge_nested_dict(base["eye"], raw["eye"], _DEFAULT_EYE)
    if isinstance(raw.get("brow"), dict):
        _merge_nested_dict(base["brow"], raw["brow"], _DEFAULT_BROW)
    if isinstance(raw.get("lip"), dict):
        _merge_nested_dict(base["lip"], raw["lip"], _DEFAULT_LIP)
    if isinstance(raw.get("lipGeometry"), dict):
        lg_raw = raw["lipGeometry"]
        lg = base["lipGeometry"]
        for k, v in _DEFAULT_LIP_GEOMETRY.items():
            if k.endswith("Indices"):
                arr = lg_raw.get(k, v)
                if isinstance(arr, (list, tuple)):
                    lg[k] = [int(x) for x in arr]
                else:
                    lg[k] = list(v)
            elif k in _LIP_GEOMETRY_BOOL_KEYS:
                lg[k] = bool(lg_raw.get(k, v))
            elif isinstance(v, (int, float)):
                lg[k] = _safe_float(lg_raw.get(k), float(v))
            else:
                lg[k] = lg_raw.get(k, v)

    if isinstance(raw.get("jawGeometry"), dict):
        jg_raw = raw["jawGeometry"]
        jg = base["jawGeometry"]
        for k, v in _DEFAULT_JAW_GEOMETRY.items():
            if k.endswith("Indices") or k.endswith("Index"):
                arr = jg_raw.get(k, v)
                if isinstance(arr, (list, tuple)):
                    jg[k] = [int(x) for x in arr]
                elif k.endswith("Index"):
                    jg[k] = int(_safe_float(arr, float(v)))
                else:
                    jg[k] = list(v) if isinstance(v, list) else v
            elif k in _JAW_GEOMETRY_BOOL_KEYS:
                jg[k] = bool(jg_raw.get(k, v))
            elif isinstance(v, (int, float)):
                jg[k] = _safe_float(jg_raw.get(k), float(v))
            else:
                jg[k] = jg_raw.get(k, v)

    if isinstance(raw.get("noseAnchor"), dict):
        na_raw = raw["noseAnchor"]
        na = base["noseAnchor"]
        for k, v in _DEFAULT_NOSE_ANCHOR.items():
            if k == "noseBridgeIndices":
                arr = na_raw.get(k, v)
                na[k] = [int(x) for x in arr] if isinstance(arr, (list, tuple)) else list(v)
            elif k == "noseTipIndex":
                na[k] = int(_safe_float(na_raw.get(k), float(v)))
            elif k in _NOSE_ANCHOR_BOOL_KEYS:
                na[k] = bool(na_raw.get(k, v))
            elif isinstance(v, (int, float)):
                na[k] = _safe_float(na_raw.get(k), float(v))
            else:
                na[k] = na_raw.get(k, v)

    if isinstance(raw.get("mouthScenario"), dict):
        ms_raw = raw["mouthScenario"]
        for k, v in _DEFAULT_MOUTH_SCENARIO.items():
            if k in _MOUTH_SCENARIO_BOOL_KEYS:
                base["mouthScenario"][k] = bool(ms_raw.get(k, v))
            elif k in _MOUTH_SCENARIO_STR_KEYS:
                cand = ms_raw.get(k, v)
                base["mouthScenario"][k] = str(cand) if cand else str(v)
            else:
                base["mouthScenario"][k] = _safe_float(ms_raw.get(k), float(v))

    if isinstance(raw.get("browGate"), dict):
        bg_raw = raw["browGate"]
        for k, v in _DEFAULT_BROW_GATE.items():
            if k in _BROW_GATE_BOOL_KEYS:
                base["browGate"][k] = bool(bg_raw.get(k, v))
            else:
                base["browGate"][k] = _safe_float(bg_raw.get(k), float(v))

    from mouth_corner_geometry import normalize_mouth_corner_config

    if "mouthCorner" in raw:
        base["mouthCorner"] = normalize_mouth_corner_config(raw.get("mouthCorner"), section_present=True)
    else:
        base["mouthCorner"] = normalize_mouth_corner_config(None, section_present=False)

    return base


def load_mapping_config(path: str | Path) -> dict[str, Any]:
    p = Path(path)
    if not p.is_file():
        raise FileNotFoundError(f"映射配置文件不存在: {p.resolve()}")
    try:
        text = p.read_text(encoding="utf-8")
    except OSError as exc:
        raise RuntimeError(f"无法读取映射配置: {p.resolve()}") from exc
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"映射 JSON 解析失败 ({p.resolve()}): {exc}") from exc
    return normalize_mapping_config(raw)


def save_mapping_config(path: str | Path, config: dict[str, Any]) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    normalized = normalize_mapping_config(config)
    try:
        p.write_text(json.dumps(normalized, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    except OSError as exc:
        raise RuntimeError(f"无法写入映射配置: {p.resolve()}") from exc
