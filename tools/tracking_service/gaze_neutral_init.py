"""Session-only gaze neutral init（摄像头启动后中性脸采样 + post-validation，不写磁盘）。"""

from __future__ import annotations

import statistics
import time
from typing import Any


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


class GazeNeutralInitSession:
    """idle → collecting_neutral → validating_neutral → neutral_ready | neutral_failed"""

    def __init__(self) -> None:
        self._session_key: str | None = None
        self._state = "idle"
        self._started_at_ms: float = 0.0
        self._validation_started_at_ms: float = 0.0
        self._reason = ""
        self._required_samples = 45
        self._duration_ms = 3000.0
        self._max_duration_ms = 5000.0
        self._validation_duration_ms = 1000.0
        self._validation_min_samples = 20
        self._validation_delta_x_thr = 0.035
        self._validation_delta_y_thr = 0.06
        self._samples: dict[str, list[float]] = {}
        self._validation_samples: dict[str, list[float]] = {}
        self._session_neutral: dict[str, float] = {}
        self._post_validation: dict[str, Any] = {}

    def reset(self) -> None:
        self._session_key = None
        self._state = "idle"
        self._started_at_ms = 0.0
        self._validation_started_at_ms = 0.0
        self._reason = ""
        self._samples = {}
        self._validation_samples = {}
        self._session_neutral = {}
        self._post_validation = {}

    def begin_session(
        self,
        *,
        session_key: str,
        gaze_cfg: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        gz = gaze_cfg if isinstance(gaze_cfg, dict) else {}
        if not bool(gz.get("neutralInitEnabled", True)):
            self._state = "neutral_ready"
            self._reason = "neutral_init_disabled"
            self._session_key = session_key
            return self.status_dict()

        self._session_key = session_key
        self._state = "collecting_neutral"
        self._started_at_ms = time.time() * 1000.0
        self._validation_started_at_ms = 0.0
        self._reason = ""
        self._samples = {}
        self._validation_samples = {}
        self._session_neutral = {}
        self._post_validation = {}
        self._required_samples = max(
            1, int(_safe_float(gz.get("neutralInitMinSamples"), 45))
        )
        self._duration_ms = max(
            500.0, _safe_float(gz.get("neutralInitDurationMs"), 3000.0)
        )
        self._max_duration_ms = max(
            self._duration_ms,
            _safe_float(gz.get("neutralInitMaxDurationMs"), 5000.0),
        )
        self._validation_duration_ms = max(
            800.0,
            _safe_float(gz.get("neutralInitValidationDurationMs"), 1000.0),
        )
        self._validation_min_samples = max(
            1, int(_safe_float(gz.get("neutralInitValidationMinSamples"), 20))
        )
        self._validation_delta_x_thr = _safe_float(
            gz.get("neutralInitPostValidationDeltaX"), 0.035
        )
        self._validation_delta_y_thr = _safe_float(
            gz.get("neutralInitPostValidationDeltaY"), 0.06
        )
        return self.status_dict()

    def is_ready(self) -> bool:
        return self._state == "neutral_ready"

    def is_collecting(self) -> bool:
        return self._state in ("collecting_neutral", "validating_neutral")

    def is_failed(self) -> bool:
        return self._state == "neutral_failed"

    def session_neutral(self) -> dict[str, float]:
        return dict(self._session_neutral)

    def _elapsed_ms(self) -> float:
        if self._started_at_ms <= 0:
            return 0.0
        return max(0.0, time.time() * 1000.0 - self._started_at_ms)

    def _validation_elapsed_ms(self) -> float:
        if self._validation_started_at_ms <= 0:
            return 0.0
        return max(0.0, time.time() * 1000.0 - self._validation_started_at_ms)

    def _remaining_ms(self) -> float:
        if self._state == "validating_neutral":
            return max(0.0, self._validation_duration_ms - self._validation_elapsed_ms())
        return max(0.0, self._duration_ms - self._elapsed_ms())

    def _progress(self) -> float:
        if self._state == "validating_neutral":
            n = len(self._validation_samples.get("rawPrimaryX", []))
            by_samples = n / max(1, self._validation_min_samples)
            by_time = self._validation_elapsed_ms() / max(
                1.0, self._validation_duration_ms
            )
            return float(min(1.0, max(by_samples, min(by_time, 1.0))))
        n = len(self._samples.get("rawPrimaryX", []))
        by_samples = n / max(1, self._required_samples)
        by_time = self._elapsed_ms() / max(1.0, self._duration_ms)
        return float(min(1.0, max(by_samples, min(by_time, 1.0))))

    def _append_sample(self, bucket: dict[str, list[float]], key: str, val: float) -> None:
        bucket.setdefault(key, []).append(float(val))

    def _begin_validation(self) -> None:
        sx = self._samples.get("rawPrimaryX") or []
        sy = self._samples.get("rawStableY") or []
        if len(sx) < self._required_samples or len(sy) < self._required_samples:
            self._fail("insufficient_neutral_samples")
            return
        self._session_neutral = {
            "sessionNeutralX": _median(sx),
            "sessionNeutralY": _median(sy),
            "sessionNeutralStableY": _median(sy),
            "neutralRawPrimaryX": _median(sx),
            "neutralRawPrimaryY": _median(self._samples.get("rawPrimaryY") or sy),
            "neutralRawStableY": _median(sy),
            "neutralEyeLookX": _median(self._samples.get("eyeLookX") or sx),
            "neutralEyeLookY": _median(self._samples.get("eyeLookY") or sy),
            "neutralRawLidAsymmetryY": _median(
                self._samples.get("rawLidAsymmetryY") or [0.0]
            ),
            "neutralBlinkLeft": _median(self._samples.get("blinkLeft") or [0.0]),
            "neutralBlinkRight": _median(self._samples.get("blinkRight") or [0.0]),
            "neutralFaceCenterX": _median(self._samples.get("faceCenterX") or [0.0]),
            "neutralFaceCenterY": _median(self._samples.get("faceCenterY") or [0.0]),
        }
        self._state = "validating_neutral"
        self._validation_started_at_ms = time.time() * 1000.0
        self._validation_samples = {}
        self._post_validation = {
            "neutralPostValidated": False,
            "neutralPostValidationAdjusted": False,
            "neutralPostValidationDeltaX": 0.0,
            "neutralPostValidationDeltaY": 0.0,
        }

    def _finalize_validation(self) -> None:
        vx = self._validation_samples.get("rawPrimaryX") or []
        vy = self._validation_samples.get("rawStableY") or []
        if len(vx) < self._validation_min_samples or len(vy) < self._validation_min_samples:
            self._fail("validation_insufficient_samples")
            return

        valid_median_x = _median(vx)
        valid_median_y = _median(vy)
        sn = self._session_neutral
        orig_x = _safe_float(sn.get("sessionNeutralX"), 0.0)
        orig_y = _safe_float(sn.get("sessionNeutralStableY"), orig_x)

        delta_x = valid_median_x - orig_x
        delta_y = valid_median_y - orig_y
        adjusted = False

        if abs(delta_x) > self._validation_delta_x_thr:
            sn["sessionNeutralX"] = valid_median_x
            sn["neutralRawPrimaryX"] = valid_median_x
            adjusted = True
        if abs(delta_y) > self._validation_delta_y_thr:
            sn["sessionNeutralStableY"] = valid_median_y
            sn["sessionNeutralY"] = valid_median_y
            sn["neutralRawStableY"] = valid_median_y
            adjusted = True

        self._post_validation = {
            "neutralPostValidated": True,
            "neutralPostValidationAdjusted": adjusted,
            "neutralPostValidationDeltaX": float(delta_x),
            "neutralPostValidationDeltaY": float(delta_y),
        }
        self._state = "neutral_ready"
        self._reason = ""

    def _fail(self, reason: str) -> None:
        self._state = "neutral_failed"
        self._reason = str(reason or "neutral_init_failed")

    @staticmethod
    def _motion_ok(motion: dict[str, Any] | None) -> bool:
        if not isinstance(motion, dict):
            return True
        lm = (
            motion.get("landmarkMotion")
            if isinstance(motion.get("landmarkMotion"), dict)
            else motion
        )
        nose_d = _safe_float(lm.get("noseDeltaPx"), 0.0)
        eye_d = _safe_float(lm.get("eyeCenterDeltaPx"), 0.0)
        face_d = _safe_float(lm.get("faceBoxCenterDeltaPx"), 0.0)
        if nose_d >= 1.2 or eye_d >= 1.2 or face_d >= 1.5:
            return False
        return True

    @staticmethod
    def _jaw_closed(blend: dict[str, Any], mouth: dict[str, Any] | None) -> bool:
        jaw_open = _safe_float(
            (mouth or {}).get("jawOpen"),
            _safe_float(blend.get("jawOpen"), 0.0),
        )
        return jaw_open < 0.03

    @classmethod
    def _stable_sample_ok(
        cls,
        *,
        face_detected: bool,
        gaze: dict[str, Any],
        blend: dict[str, Any],
        blink_gaze_weight: float,
        motion: dict[str, Any] | None,
        mouth: dict[str, Any] | None,
    ) -> bool:
        if not face_detected:
            return False
        if not bool(gaze.get("available")):
            return False
        rel = _safe_float(gaze.get("reliabilityScore"), 0.0)
        if rel < 0.75:
            return False
        if float(blink_gaze_weight) < 0.75:
            return False
        bl = _safe_float(blend.get("eyeBlinkLeft"), 0.0)
        br = _safe_float(blend.get("eyeBlinkRight"), 0.0)
        if bl >= 0.45 or br >= 0.45:
            return False
        if not cls._jaw_closed(blend, mouth):
            return False
        if not cls._motion_ok(motion):
            return False
        raw_x = gaze.get("rawPrimaryX", gaze.get("eyeLookX"))
        raw_y = gaze.get("rawStableY", gaze.get("eyeLookY", gaze.get("rawPrimaryY")))
        if not isinstance(raw_x, (int, float)) or not isinstance(raw_y, (int, float)):
            return False
        return True

    def _record_stable_sample(
        self,
        bucket: dict[str, list[float]],
        *,
        gaze: dict[str, Any],
        blend: dict[str, float],
        face_center: tuple[float, float] | None,
    ) -> None:
        raw_x = float(gaze.get("rawPrimaryX", gaze.get("eyeLookX", 0.0)))
        raw_y_stable = float(
            gaze.get("rawStableY", gaze.get("eyeLookY", gaze.get("rawPrimaryY", 0.0)))
        )
        self._append_sample(bucket, "rawPrimaryX", raw_x)
        self._append_sample(bucket, "rawPrimaryY", float(gaze.get("rawPrimaryY", raw_y_stable)))
        self._append_sample(bucket, "rawStableY", raw_y_stable)
        self._append_sample(bucket, "eyeLookX", float(gaze.get("eyeLookX", raw_x)))
        self._append_sample(bucket, "eyeLookY", float(gaze.get("eyeLookY", raw_y_stable)))
        self._append_sample(
            bucket, "rawLidAsymmetryY", float(gaze.get("rawLidAsymmetryY", 0.0))
        )
        self._append_sample(bucket, "blinkLeft", float(blend.get("eyeBlinkLeft", 0.0)))
        self._append_sample(bucket, "blinkRight", float(blend.get("eyeBlinkRight", 0.0)))
        if face_center is not None:
            self._append_sample(bucket, "faceCenterX", float(face_center[0]))
            self._append_sample(bucket, "faceCenterY", float(face_center[1]))

    def maybe_collect(
        self,
        *,
        gaze_cfg: dict[str, Any] | None,
        face_detected: bool,
        gaze: dict[str, Any],
        blend: dict[str, float],
        blink_gaze_weight: float,
        motion: dict[str, Any] | None = None,
        mouth: dict[str, Any] | None = None,
        face_center: tuple[float, float] | None = None,
    ) -> dict[str, Any]:
        gz = gaze_cfg if isinstance(gaze_cfg, dict) else {}
        if not bool(gz.get("neutralInitEnabled", True)):
            return self.status_dict()

        if self._state == "collecting_neutral":
            elapsed = self._elapsed_ms()
            n = len(self._samples.get("rawPrimaryX", []))
            if elapsed >= self._max_duration_ms:
                if n >= self._required_samples:
                    self._begin_validation()
                else:
                    self._fail("timeout_insufficient_samples")
                return self.status_dict()

            if elapsed >= self._duration_ms and n >= self._required_samples:
                self._begin_validation()
                return self.status_dict()

            if self._stable_sample_ok(
                face_detected=face_detected,
                gaze=gaze,
                blend=blend,
                blink_gaze_weight=blink_gaze_weight,
                motion=motion,
                mouth=mouth,
            ):
                self._record_stable_sample(
                    self._samples,
                    gaze=gaze,
                    blend=blend,
                    face_center=face_center,
                )
                if len(self._samples.get("rawPrimaryX", [])) >= self._required_samples:
                    if elapsed >= self._duration_ms:
                        self._begin_validation()

            return self.status_dict()

        if self._state == "validating_neutral":
            val_elapsed = self._validation_elapsed_ms()
            vn = len(self._validation_samples.get("rawPrimaryX", []))

            if val_elapsed >= self._validation_duration_ms:
                if vn >= self._validation_min_samples:
                    self._finalize_validation()
                else:
                    self._fail("validation_insufficient_samples")
                return self.status_dict()

            if self._stable_sample_ok(
                face_detected=face_detected,
                gaze=gaze,
                blend=blend,
                blink_gaze_weight=blink_gaze_weight,
                motion=motion,
                mouth=mouth,
            ):
                self._record_stable_sample(
                    self._validation_samples,
                    gaze=gaze,
                    blend=blend,
                    face_center=face_center,
                )
                if vn + 1 >= self._validation_min_samples and val_elapsed >= 800.0:
                    self._finalize_validation()

            return self.status_dict()

        return self.status_dict()

    def status_dict(self) -> dict[str, Any]:
        if self._state == "validating_neutral":
            n = len(self._validation_samples.get("rawPrimaryX", []))
            required = self._validation_min_samples
        else:
            n = len(self._samples.get("rawPrimaryX", []))
            required = self._required_samples
        sn = self._session_neutral
        pv = self._post_validation
        return {
            "neutralInitState": self._state,
            "neutralInitSampleCount": int(n),
            "neutralInitRequiredSamples": int(required),
            "neutralInitProgress": float(self._progress()),
            "neutralInitReady": bool(self._state == "neutral_ready"),
            "neutralInitFailed": bool(self._state == "neutral_failed"),
            "neutralInitReason": str(self._reason or ""),
            "neutralInitRemainingMs": float(self._remaining_ms()),
            "neutralInitElapsedMs": float(self._elapsed_ms()),
            "neutralInitShowPrompt": True,
            "sessionNeutralX": float(sn.get("sessionNeutralX", 0.0)),
            "sessionNeutralY": float(sn.get("sessionNeutralY", 0.0)),
            "sessionNeutralStableY": float(sn.get("sessionNeutralStableY", 0.0)),
            "neutralPostValidated": bool(pv.get("neutralPostValidated", False)),
            "neutralPostValidationAdjusted": bool(
                pv.get("neutralPostValidationAdjusted", False)
            ),
            "neutralPostValidationDeltaX": float(
                pv.get("neutralPostValidationDeltaX", 0.0)
            ),
            "neutralPostValidationDeltaY": float(
                pv.get("neutralPostValidationDeltaY", 0.0)
            ),
            "sessionKey": self._session_key,
        }

    def sync_to_gaze_state(self, gaze_state: dict[str, Any]) -> None:
        prev = (
            gaze_state.get("neutral_init")
            if isinstance(gaze_state.get("neutral_init"), dict)
            else {}
        )
        merged: dict[str, Any] = {
            **self.status_dict(),
            **self.session_neutral(),
        }
        if self._state == "neutral_ready" and isinstance(prev, dict):
            for k in (
                "sessionNeutralX",
                "sessionNeutralY",
                "sessionNeutralStableY",
            ):
                pv = prev.get(k)
                if isinstance(pv, (int, float)):
                    merged[k] = float(pv)
                    self._session_neutral[k] = float(pv)
        gaze_state["neutral_init"] = merged
