"""legacy_iris_offset_v1：iris 相对眼框偏移 + session legacy neutral（runtime only）。"""

from __future__ import annotations

import math
import statistics
import time
from typing import Any, Callable


def _median(values: list[float]) -> float:
    if not values:
        return 0.0
    return float(statistics.median(values))


def _safe_float(v: Any, fallback: float = 0.0) -> float:
    try:
        n = float(v)
        if n != n or n in (float("inf"), float("-inf")):
            return fallback
        return n
    except (TypeError, ValueError):
        return fallback


def _clamp(v: float, lo: float, hi: float) -> float:
    return float(max(lo, min(hi, v)))


def _one_eye_legacy_offset(
    lm: Any,
    idx: dict[str, int],
    iris_cx: float,
    iris_cy: float,
    get_xy: Callable[[Any, int], tuple[float, float] | None],
    gaze_cfg: dict[str, Any] | None,
) -> tuple[float, float, float] | None:
    """水平沿 inner-outer 轴；垂直用眼宽尺度（不用眼睑 half_h / 法向 primary_y）。"""
    inner = get_xy(lm, idx["inner"])
    outer = get_xy(lm, idx["outer"])
    if not inner or not outer:
        return None
    cx = (inner[0] + outer[0]) * 0.5
    cy = (inner[1] + outer[1]) * 0.5
    half_w = math.hypot(outer[0] - inner[0], outer[1] - inner[1]) * 0.5
    if half_w < 1e-6:
        return None
    hx = outer[0] - inner[0]
    hy = outer[1] - inner[1]
    h_len = math.hypot(hx, hy)
    if h_len < 1e-6:
        return None
    ux, uy = hx / h_len, hy / h_len
    dx = iris_cx - cx
    dy = iris_cy - cy
    local_x = (dx * ux + dy * uy) / half_w
    gz = gaze_cfg if isinstance(gaze_cfg, dict) else {}
    vert_factor = max(
        1e-6,
        _safe_float(
            gz.get("legacyVerticalScaleFromEyeWidth"),
            _safe_float(gz.get("gazeVerticalScaleFromEyeWidth"), 0.32) * 4.0,
        ),
    )
    vert_scale = half_w * vert_factor
    local_y = (iris_cy - cy) / vert_scale
    local_x = _clamp(local_x, -1.5, 1.5)
    local_y = _clamp(local_y, -1.5, 1.5)
    return float(local_x), float(local_y), float(half_w)


def estimate_legacy_iris_gaze(
    lm: Any,
    *,
    get_xy: Callable[[Any, int], tuple[float, float] | None],
    gaze_cfg: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """返回 legacyRawX/Y、left/right eye、irisReliable 等。"""
    gz = gaze_cfg if isinstance(gaze_cfg, dict) else {}
    out: dict[str, Any] = {
        "available": False,
        "legacyIrisReliable": False,
        "irisReliable": False,
        "legacyRawX": 0.0,
        "legacyRawY": 0.0,
        "leftEyeX": 0.0,
        "leftEyeY": 0.0,
        "rightEyeX": 0.0,
        "rightEyeY": 0.0,
        "eyeLookX": 0.0,
        "eyeLookY": 0.0,
        "reliabilityScore": 0.0,
    }
    if not lm or len(lm) < 478:
        return out

    left_iris: list[tuple[float, float]] = []
    for i in range(468, 473):
        p = get_xy(lm, i)
        if p:
            left_iris.append(p)
    right_iris: list[tuple[float, float]] = []
    for i in range(473, 478):
        p = get_xy(lm, i)
        if p:
            right_iris.append(p)
    if len(left_iris) < 2 or len(right_iris) < 2:
        return out

    licx = sum(p[0] for p in left_iris) / len(left_iris)
    licy = sum(p[1] for p in left_iris) / len(left_iris)
    ricx = sum(p[0] for p in right_iris) / len(right_iris)
    ricy = sum(p[1] for p in right_iris) / len(right_iris)

    left_idx = {"inner": 133, "outer": 33, "upper": 159, "lower": 145}
    right_idx = {"inner": 362, "outer": 263, "upper": 386, "lower": 374}

    le = _one_eye_legacy_offset(lm, left_idx, licx, licy, get_xy, gz)
    re = _one_eye_legacy_offset(lm, right_idx, ricx, ricy, get_xy, gz)
    if le is None or re is None:
        return out

    legacy_x = (le[0] + re[0]) * 0.5
    legacy_y = (le[1] + re[1]) * 0.5
    min_extent = max(1e-6, _safe_float(gz.get("minIrisEyeHalfExtent"), 0.003))
    geo_min = min(le[2], re[2])
    reliability = _clamp(geo_min / (min_extent * 2.5), 0.0, 1.0)
    if geo_min >= min_extent:
        reliability = max(reliability, 0.55)
    iris_ok = bool(reliability >= 0.45 and geo_min >= min_extent)

    out["available"] = True
    out["legacyRawX"] = float(legacy_x)
    out["legacyRawY"] = float(legacy_y)
    out["leftEyeX"] = float(le[0])
    out["leftEyeY"] = float(le[1])
    out["rightEyeX"] = float(re[0])
    out["rightEyeY"] = float(re[1])
    out["eyeLookX"] = float(legacy_x)
    out["eyeLookY"] = float(legacy_y)
    out["reliabilityScore"] = float(reliability)
    out["legacyIrisReliable"] = iris_ok
    out["irisReliable"] = iris_ok
    return out


def compute_legacy_blink_gaze_weight(blink_left: float, blink_right: float) -> float:
    """legacy 模式 blink 权重（与 eye_corner 路径独立）。"""
    blink_max = max(_safe_float(blink_left, 0.0), _safe_float(blink_right, 0.0))
    if blink_max < 0.45:
        return 1.0
    if blink_max < 0.70:
        t = (blink_max - 0.45) / 0.25
        return _clamp(1.0 + t * (0.35 - 1.0), 0.35, 1.0)
    return 0.15


def legacy_neutral_is_ready(leg: dict[str, Any]) -> bool:
    nx = leg.get("sessionNeutralLegacyX")
    ny = leg.get("sessionNeutralLegacyY")
    n = leg.get("legacyNeutralInitSampleCount")
    req = leg.get("legacyNeutralInitRequiredSamples")
    if str(leg.get("legacyNeutralInitState") or "") != "neutral_ready":
        return False
    if not isinstance(nx, (int, float)) or not isinstance(ny, (int, float)):
        return False
    if not isinstance(n, (int, float)) or not isinstance(req, (int, float)):
        return False
    if int(n) < int(req):
        return False
    return True


class GazeLegacyNeutralInitSession:
    """摄像头启动 ~2s 采 legacyRawX/Y 中位数作为 session neutral。"""

    def __init__(self) -> None:
        self._session_key: str | None = None
        self._state = "idle"
        self._reason = ""
        self._started_at_ms = 0.0
        self._duration_ms = 2000.0
        self._max_duration_ms = 4000.0
        self._required_samples = 30
        self._samples_x: list[float] = []
        self._samples_y: list[float] = []
        self._session_neutral: dict[str, float] = {}

    def reset(self) -> None:
        self._session_key = None
        self._state = "idle"
        self._reason = ""
        self._samples_x = []
        self._samples_y = []
        self._session_neutral = {}

    def begin_session(self, *, session_key: str, gaze_cfg: dict[str, Any] | None = None) -> dict[str, Any]:
        gz = gaze_cfg if isinstance(gaze_cfg, dict) else {}
        if not bool(gz.get("legacyNeutralInitEnabled", True)):
            self._state = "neutral_failed"
            self._reason = "legacy_neutral_init_disabled"
            self._session_key = session_key
            self._session_neutral = {}
            return self.status_dict()

        self._session_key = session_key
        self._state = "collecting_neutral"
        self._reason = ""
        self._started_at_ms = time.time() * 1000.0
        self._samples_x = []
        self._samples_y = []
        self._session_neutral = {}
        self._duration_ms = max(500.0, _safe_float(gz.get("legacyNeutralInitDurationMs"), 2000.0))
        self._max_duration_ms = max(
            self._duration_ms, _safe_float(gz.get("legacyNeutralInitMaxDurationMs"), 4000.0)
        )
        self._required_samples = max(
            1, int(_safe_float(gz.get("legacyNeutralInitMinSamples"), 30))
        )
        return self.status_dict()

    def is_ready(self) -> bool:
        return self._state == "neutral_ready"

    def is_collecting(self) -> bool:
        return self._state == "collecting_neutral"

    def is_failed(self) -> bool:
        return self._state == "neutral_failed"

    def _elapsed_ms(self) -> float:
        if self._started_at_ms <= 0:
            return 0.0
        return max(0.0, time.time() * 1000.0 - self._started_at_ms)

    def _remaining_ms(self) -> float:
        return max(0.0, self._duration_ms - self._elapsed_ms())

    @staticmethod
    def _sample_ok(
        *,
        face_detected: bool,
        gaze: dict[str, Any],
        blend: dict[str, float],
        motion: dict[str, Any] | None,
    ) -> bool:
        if not face_detected:
            return False
        if not bool(gaze.get("available")) or not bool(gaze.get("legacyIrisReliable")):
            return False
        if _safe_float(gaze.get("reliabilityScore"), 0.0) < 0.65:
            return False
        if _safe_float(blend.get("eyeBlinkLeft"), 0.0) >= 0.55:
            return False
        if _safe_float(blend.get("eyeBlinkRight"), 0.0) >= 0.55:
            return False
        if _safe_float(blend.get("jawOpen"), 0.0) >= 0.05:
            return False
        if isinstance(motion, dict):
            if _safe_float(motion.get("noseDeltaPx"), 0.0) >= 1.5:
                return False
            if _safe_float(motion.get("eyeCenterDeltaPx"), 0.0) >= 1.5:
                return False
        return True

    def _finalize(self) -> None:
        if len(self._samples_x) < self._required_samples:
            self._state = "neutral_failed"
            self._reason = "insufficient_legacy_neutral_samples"
            return
        self._session_neutral = {
            "sessionNeutralLegacyX": _median(self._samples_x),
            "sessionNeutralLegacyY": _median(self._samples_y),
        }
        self._state = "neutral_ready"
        self._reason = ""

    def is_neutral_ready_valid(self) -> bool:
        if self._state != "neutral_ready":
            return False
        if len(self._samples_x) < self._required_samples:
            return False
        sx = self._session_neutral.get("sessionNeutralLegacyX")
        sy = self._session_neutral.get("sessionNeutralLegacyY")
        return isinstance(sx, (int, float)) and isinstance(sy, (int, float))

    def maybe_collect(
        self,
        *,
        gaze_cfg: dict[str, Any] | None,
        face_detected: bool,
        gaze: dict[str, Any],
        blend: dict[str, float],
        motion: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        gz = gaze_cfg if isinstance(gaze_cfg, dict) else {}
        if not bool(gz.get("legacyNeutralInitEnabled", True)):
            return self.status_dict()
        if self._state != "collecting_neutral":
            return self.status_dict()

        elapsed = self._elapsed_ms()
        n = len(self._samples_x)
        if elapsed >= self._max_duration_ms:
            if n >= self._required_samples:
                self._finalize()
            else:
                self._state = "neutral_failed"
                self._reason = "timeout_insufficient_samples"
            return self.status_dict()

        if self._sample_ok(
            face_detected=face_detected, gaze=gaze, blend=blend, motion=motion
        ):
            self._samples_x.append(_safe_float(gaze.get("legacyRawX"), 0.0))
            self._samples_y.append(_safe_float(gaze.get("legacyRawY"), 0.0))
            if n + 1 >= self._required_samples and elapsed >= self._duration_ms:
                self._finalize()

        return self.status_dict()

    def status_dict(self) -> dict[str, Any]:
        sn = self._session_neutral
        ready = self.is_neutral_ready_valid()
        out: dict[str, Any] = {
            "legacyNeutralInitState": self._state,
            "legacyNeutralInitReady": ready,
            "legacyNeutralInitFailed": bool(self._state == "neutral_failed"),
            "legacyNeutralInitReason": str(self._reason or ""),
            "legacyNeutralInitSampleCount": int(len(self._samples_x)),
            "legacyNeutralInitRequiredSamples": int(self._required_samples),
            "legacyNeutralInitRemainingMs": float(self._remaining_ms()),
            "legacyNeutralInitShowPrompt": True,
            "sessionKey": self._session_key,
        }
        if "sessionNeutralLegacyX" in sn:
            out["sessionNeutralLegacyX"] = float(sn["sessionNeutralLegacyX"])
        if "sessionNeutralLegacyY" in sn:
            out["sessionNeutralLegacyY"] = float(sn["sessionNeutralLegacyY"])
        return out

    def sync_to_gaze_state(self, gaze_state: dict[str, Any]) -> None:
        gaze_state["legacy_neutral_init"] = {
            **self.status_dict(),
            **self._session_neutral,
        }
