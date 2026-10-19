"""Generate the immutable Phase 1B Python baseline from the formal mapping path."""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
SERVICE = ROOT / "tools" / "tracking_service"
sys.path.insert(0, str(SERVICE))

from brow_gate import create_brow_state  # noqa: E402
from gaze_iris_only import reset_iris_gaze_runtime  # noqa: E402
from jaw_geometry import create_jaw_geometry_state  # noqa: E402
from lip_geometry import create_lip_geometry_state  # noqa: E402
from mediapipe_mapping_config import load_mapping_config  # noqa: E402
from mediapipe_to_rig import estimate_tracking_quality, mediapipe_result_to_rig  # noqa: E402
from mouth_corner_geometry import create_mouth_corner_state  # noqa: E402
from mouth_scenario import create_mouth_scenario_state  # noqa: E402
from nose_anchor_frame import create_nose_anchor_state  # noqa: E402


def points() -> list[dict[str, float]]:
    pts = [{"x": 0.5, "y": 0.5, "z": 0.0} for _ in range(478)]

    def setp(i: int, x: float, y: float, z: float = 0.0) -> None:
        pts[i] = {"x": x, "y": y, "z": z}

    setp(61, 0.4, 0.55); setp(291, 0.6, 0.55); setp(1, 0.5, 0.4); setp(152, 0.5, 0.75)
    for i in (4, 5, 6, 195, 197): setp(i, 0.5, 0.44 + (i % 3) * 0.002)
    setp(33, 0.38, 0.45); setp(133, 0.46, 0.45); setp(159, 0.42, 0.43); setp(145, 0.42, 0.47)
    setp(263, 0.62, 0.45); setp(362, 0.54, 0.45); setp(386, 0.58, 0.43); setp(374, 0.58, 0.47)
    for i in (468, 469, 470, 471, 472): setp(i, 0.42, 0.45)
    for i in (473, 474, 475, 476, 477): setp(i, 0.58, 0.45)
    for i in (40, 80, 81): setp(i, 0.46, 0.53)
    for i in (270, 310, 311): setp(i, 0.54, 0.53)
    for i in (91, 88, 178): setp(i, 0.46, 0.57)
    for i in (321, 318, 402): setp(i, 0.54, 0.57)
    setp(13, 0.5, 0.535); setp(14, 0.5, 0.565); setp(17, 0.5, 0.57); setp(87, 0.48, 0.57); setp(317, 0.52, 0.57)
    return pts


def make_result(observation: dict) -> SimpleNamespace:
    landmarks = [SimpleNamespace(**p) for p in observation["landmarks"]]
    categories = [SimpleNamespace(category_name=k, display_name="", label="", score=float(v)) for k, v in observation["blendshapes"].items()]
    return SimpleNamespace(
        face_landmarks=[landmarks],
        face_blendshapes=[SimpleNamespace(categories=categories)],
        facial_transformation_matrixes=[],
    )


def make_observation(name: str, frame_id: int, blend: dict | None = None, mutate=None) -> dict:
    lm = points()
    if mutate:
        mutate(lm)
    return {
        "name": name,
        "timestampMs": frame_id * 33.0,
        "frameId": frame_id,
        "faceDetected": True,
        "landmarks": lm,
        "blendshapes": blend or {},
        "facialTransformationMatrix": None,
        "source": "python",
    }


def sequence() -> list[dict]:
    seq = [make_observation("neutral-calibrate", 1), make_observation("neutral", 2)]
    seq.append(make_observation("blink", 3, {"eyeBlinkLeft": 0.8, "eyeBlinkRight": 0.75}))
    seq.append(make_observation("brow", 4, {"browInnerUp": 0.5, "browOuterUpLeft": 0.4, "browOuterUpRight": 0.4}))

    def mouth_open(lm):
        for i in (14,): lm[i]["y"] += 0.035
        for i in (17, 87, 317): lm[i]["y"] += 0.03

    seq.append(make_observation("mouth-open", 5, {"jawOpen": 0.7}, mouth_open))

    def smile(lm):
        lm[61]["x"] -= 0.02; lm[61]["y"] -= 0.01
        lm[291]["x"] += 0.02; lm[291]["y"] -= 0.01

    seq.append(make_observation("smile", 6, {"mouthSmileLeft": 0.8, "mouthSmileRight": 0.8}, smile))
    seq.append(make_observation("pucker", 7, {"mouthPucker": 0.8, "mouthFunnel": 0.6}))

    def gaze_right(lm):
        for i in (*range(468, 473), *range(473, 478)): lm[i]["x"] += 0.02

    def gaze_left(lm):
        for i in (*range(468, 473), *range(473, 478)): lm[i]["x"] -= 0.02

    def gaze_up(lm):
        for i in (*range(468, 473), *range(473, 478)): lm[i]["y"] -= 0.012

    def gaze_down(lm):
        for i in (*range(468, 473), *range(473, 478)): lm[i]["y"] += 0.012

    seq.extend([
        make_observation("gaze-right", 8, mutate=gaze_right),
        make_observation("gaze-left", 9, mutate=gaze_left),
        make_observation("gaze-up", 10, mutate=gaze_up),
        make_observation("gaze-down", 11, mutate=gaze_down),
    ])

    def head_yaw(lm):
        lm[1]["x"] += 0.035

    def head_pitch(lm):
        lm[152]["y"] += 0.035

    def head_roll(lm):
        lm[61]["y"] -= 0.015
        lm[291]["y"] += 0.015

    seq.extend([
        make_observation("head-yaw", 12, mutate=head_yaw),
        make_observation("head-pitch", 13, mutate=head_pitch),
        make_observation("head-roll", 14, mutate=head_roll),
    ])
    return seq


def main() -> None:
    cfg = load_mapping_config(SERVICE / "mediapipe_mapping.default.json")
    for section in ("lipGeometry", "jawGeometry", "noseAnchor"):
        cfg[section]["neutralFrames"] = 1
        cfg[section]["neutralWarmupFrames"] = 0
    cfg["mouthCorner"]["neutralSampleCount"] = 1
    cfg["mouthCorner"]["neutralWarmupFrames"] = 0
    cfg["lipGeometry"]["scenarioTransitionFrames"] = 1
    cfg["browGate"]["browConfirmFrames"] = 1
    cfg["browGate"]["neutralFallbackMs"] = 0
    cfg["gaze"]["irisWarmupFrames"] = 1
    cfg["gaze"]["irisWarmupMinSamples"] = 1
    cfg["gaze"]["irisWarmupMaxWaitFrames"] = 1
    cfg["mouthScenario"]["frontalConfirmFrames"] = 1
    cfg["mouthScenario"]["closedTurnConfirmFrames"] = 1
    cfg["mouthScenario"]["neutralConfirmFrames"] = 1

    gaze_state: dict = {"last_valid": None, "last_emit": {"x": 50.0, "y": 50.0}}
    reset_iris_gaze_runtime(gaze_state)
    states = {
        "gaze_state": gaze_state,
        "lip_state": create_lip_geometry_state(),
        "jaw_state": create_jaw_geometry_state(),
        "nose_state": create_nose_anchor_state(),
        "mouth_scenario_state": create_mouth_scenario_state(),
        "brow_state": create_brow_state(),
        "mouth_corner_state": create_mouth_corner_state(),
    }
    frames = []
    observations = sequence()
    for obs in observations:
        result = make_result(obs)
        pack = mediapipe_result_to_rig(result, cfg, timestamp_ms=obs["timestampMs"], **states)
        frames.append({
            "name": obs["name"],
            "frameId": obs["frameId"],
            "quality": estimate_tracking_quality(result, True),
            "rig": pack["rig"],
            "scenario": (pack.get("debug", {}).get("mouthScenarioClassifier") or {}).get("finalScenario"),
            "headPose": (pack.get("debug", {}).get("jawGeometry") or {}).get("pose"),
        })
    output = {"schema": "facedev.python-baseline.phase1b.v1", "config": "test-fast-neutral", "observations": observations, "frames": frames}
    target = ROOT / "src" / "sdk" / "tracking" / "core" / "fixtures" / "python-baseline-phase1b.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(target)


if __name__ == "__main__":
    main()
