"""Mouth Corner Geometry V2 unit tests (no hardware)."""

from __future__ import annotations

import math
import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from mouth_corner_geometry import (
    MODEL_DIAGONAL_V1,
    MODEL_LANDMARK_2D_V2,
    apply_mouth_corner_to_rig,
    build_canonical_mouth_corner_observation,
    build_face_local_corner_frame,
    create_mouth_corner_state,
    default_mouth_corner_config,
    extract_raw_mouth_corner_observation,
    normalize_mouth_corner_config,
    project_mouth_corners_diagonal_v1,
    project_mouth_corners_landmark_2d_v2,
    project_mouth_corners_to_rig,
    reset_mouth_corner_state,
    update_mouth_corner_neutral,
)
from mediapipe_mapping_config import normalize_mapping_config


class _Pt:
    def __init__(self, x, y, z=0.0):
        self.x = float(x)
        self.y = float(y)
        self.z = float(z)


def _face(
    *,
    nose=(0.5, 0.5, 0.0),
    chin=(0.5, 0.8, 0.0),
    le=(0.35, 0.4, 0.0),
    re=(0.65, 0.4, 0.0),
    left=(0.42, 0.62, 0.0),
    right=(0.58, 0.62, 0.0),
    n=478,
):
    pts = [_Pt(0.5, 0.5, 0.0) for _ in range(n)]
    pts[1] = _Pt(*nose)
    pts[152] = _Pt(*chin)
    pts[33] = _Pt(*le)
    pts[263] = _Pt(*re)
    pts[61] = _Pt(*left)
    pts[291] = _Pt(*right)
    return pts


def _get_xy(landmarks, index):
    p = landmarks[index]
    return float(p.x), float(p.y)


def _seed_neutral(state, canon_left, canon_right, cfg):
    """Force neutral ready with known values."""
    state["neutralReady"] = True
    state["neutralSampleCount"] = int(cfg.get("neutralSampleCount", 30))
    state["neutralLeftX"], state["neutralLeftY"] = canon_left
    state["neutralRightX"], state["neutralRightY"] = canon_right


class TestRawExtract(unittest.TestCase):
    def test_missing_returns_unavailable_nulls(self):
        obs = extract_raw_mouth_corner_observation(None, default_mouth_corner_config(), _get_xy)
        self.assertFalse(obs["available"])
        self.assertIsNone(obs["left"]["x"])
        self.assertIsNone(obs["right"]["y"])

    def test_indices_left_right(self):
        lm = _face(left=(0.41, 0.61), right=(0.59, 0.61))
        obs = extract_raw_mouth_corner_observation(lm, default_mouth_corner_config(), _get_xy)
        self.assertTrue(obs["available"])
        self.assertAlmostEqual(obs["left"]["x"], 0.41)
        self.assertAlmostEqual(obs["right"]["x"], 0.59)
        self.assertEqual(obs["landmarkIndices"]["left"], 61)
        self.assertEqual(obs["landmarkIndices"]["right"], 291)

    def test_mirror_swaps_sides(self):
        cfg = default_mouth_corner_config()
        cfg["sourceMirror"] = True
        lm = _face(left=(0.41, 0.61), right=(0.59, 0.61))
        obs = extract_raw_mouth_corner_observation(lm, cfg, _get_xy)
        self.assertAlmostEqual(obs["left"]["x"], 0.59)
        self.assertAlmostEqual(obs["right"]["x"], 0.41)


class TestCanonicalInvariance(unittest.TestCase):
    def test_translate_scale_roll_invariance(self):
        base = _face()
        cfg = default_mouth_corner_config()
        cfg["rejectOnHeadMotion"] = False
        c0 = build_canonical_mouth_corner_observation(base, cfg, _get_xy)
        self.assertTrue(c0["available"])
        l0 = (c0["left"]["canonicalX"], c0["left"]["canonicalY"])
        r0 = (c0["right"]["canonicalX"], c0["right"]["canonicalY"])

        def transform(pts, *, tx=0.0, ty=0.0, s=1.0, roll_deg=0.0):
            rad = math.radians(roll_deg)
            cos_a, sin_a = math.cos(rad), math.sin(rad)
            cx, cy = 0.5, 0.5
            out = []
            for p in pts:
                x, y, z = p.x - cx, p.y - cy, p.z
                x, y = cos_a * x - sin_a * y, sin_a * x + cos_a * y
                x, y = x * s + cx + tx, y * s + cy + ty
                out.append(_Pt(x, y, z))
            return out

        for name, lm in (
            ("translate", transform(base, tx=0.07, ty=-0.04)),
            ("scale", transform(base, s=1.35)),
            ("roll", transform(base, roll_deg=12.0)),
        ):
            c = build_canonical_mouth_corner_observation(lm, cfg, _get_xy)
            self.assertTrue(c["available"], name)
            self.assertAlmostEqual(c["left"]["canonicalX"], l0[0], places=5, msg=name)
            self.assertAlmostEqual(c["left"]["canonicalY"], l0[1], places=5, msg=name)
            self.assertAlmostEqual(c["right"]["canonicalX"], r0[0], places=5, msg=name)
            self.assertAlmostEqual(c["right"]["canonicalY"], r0[1], places=5, msg=name)


class TestAxisAndSideIndependence(unittest.TestCase):
    def _project_delta(self, left_dx=0.0, left_dy=0.0, right_dx=0.0, right_dy=0.0):
        cfg = default_mouth_corner_config()
        cfg["deadzoneX"] = 0.0
        cfg["deadzoneY"] = 0.0
        return project_mouth_corners_landmark_2d_v2(
            {
                "leftDx": left_dx,
                "leftDy": left_dy,
                "rightDx": right_dx,
                "rightDy": right_dy,
            },
            cfg,
        )

    def test_left_x_only(self):
        p0 = self._project_delta()
        p1 = self._project_delta(left_dx=0.04)
        self.assertNotAlmostEqual(p1["sideL"]["x"], p0["sideL"]["x"])
        self.assertAlmostEqual(p1["sideL"]["y"], p0["sideL"]["y"])
        self.assertAlmostEqual(p1["sideR"]["x"], p0["sideR"]["x"])
        self.assertAlmostEqual(p1["sideR"]["y"], p0["sideR"]["y"])

    def test_left_y_only(self):
        p0 = self._project_delta()
        p1 = self._project_delta(left_dy=-0.04)
        self.assertAlmostEqual(p1["sideL"]["x"], p0["sideL"]["x"])
        self.assertNotAlmostEqual(p1["sideL"]["y"], p0["sideL"]["y"])

    def test_right_x_only(self):
        p0 = self._project_delta()
        p1 = self._project_delta(right_dx=0.04)
        self.assertNotAlmostEqual(p1["sideR"]["x"], p0["sideR"]["x"])
        self.assertAlmostEqual(p1["sideR"]["y"], p0["sideR"]["y"])
        self.assertAlmostEqual(p1["sideL"]["x"], p0["sideL"]["x"])

    def test_right_y_only(self):
        p0 = self._project_delta()
        p1 = self._project_delta(right_dy=0.03)
        self.assertAlmostEqual(p1["sideR"]["x"], p0["sideR"]["x"])
        self.assertNotAlmostEqual(p1["sideR"]["y"], p0["sideR"]["y"])

    def test_side_independence_via_landmarks(self):
        cfg = default_mouth_corner_config()
        cfg["rejectOnHeadMotion"] = False
        cfg["deadzoneX"] = 0.0
        cfg["deadzoneY"] = 0.0
        base = _face()
        c0 = build_canonical_mouth_corner_observation(base, cfg, _get_xy)
        state = create_mouth_corner_state()
        _seed_neutral(
            state,
            (c0["left"]["canonicalX"], c0["left"]["canonicalY"]),
            (c0["right"]["canonicalX"], c0["right"]["canonicalY"]),
            cfg,
        )
        out0 = apply_mouth_corner_to_rig(
            landmarks=base,
            get_landmark_xy=_get_xy,
            cfg=cfg,
            state=state,
            smile_left=0.0,
            smile_right=0.0,
            head_motion_active=False,
            tracking_quality=1.0,
        )
        left_moved = _face(left=(0.38, 0.62))
        out_l = apply_mouth_corner_to_rig(
            landmarks=left_moved,
            get_landmark_xy=_get_xy,
            cfg=cfg,
            state=state,
            smile_left=0.0,
            smile_right=0.0,
            head_motion_active=False,
            tracking_quality=1.0,
        )
        self.assertNotAlmostEqual(out_l["sideL"]["x"], out0["sideL"]["x"], places=4)
        self.assertAlmostEqual(out_l["sideR"]["x"], out0["sideR"]["x"], places=4)
        self.assertAlmostEqual(out_l["sideR"]["y"], out0["sideR"]["y"], places=4)

        right_moved = _face(right=(0.62, 0.62))
        out_r = apply_mouth_corner_to_rig(
            landmarks=right_moved,
            get_landmark_xy=_get_xy,
            cfg=cfg,
            state=state,
            smile_left=0.0,
            smile_right=0.0,
            head_motion_active=False,
            tracking_quality=1.0,
        )
        self.assertNotAlmostEqual(out_r["sideR"]["x"], out0["sideR"]["x"], places=4)
        self.assertAlmostEqual(out_r["sideL"]["x"], out0["sideL"]["x"], places=4)


class TestLegacyDiagonal(unittest.TestCase):
    def test_exact_old_formula(self):
        for s_l, s_r in ((0.0, 0.0), (20.0, 10.0), (100.0, 100.0), (42.5, 33.3)):
            out = project_mouth_corners_diagonal_v1(s_l, s_r)
            self.assertAlmostEqual(out["sideL"]["x"], max(0.0, min(100.0, 50.0 - s_l * 0.35)))
            self.assertAlmostEqual(out["sideL"]["y"], max(0.0, min(100.0, 50.0 - s_l * 0.25)))
            self.assertAlmostEqual(out["sideR"]["x"], max(0.0, min(100.0, 50.0 + s_r * 0.35)))
            self.assertAlmostEqual(out["sideR"]["y"], max(0.0, min(100.0, 50.0 - s_r * 0.25)))

    def test_missing_section_defaults_to_v1(self):
        cfg = normalize_mapping_config({})
        self.assertEqual(cfg["mouthCorner"]["model"], MODEL_DIAGONAL_V1)

    def test_default_json_model_v2(self):
        from mediapipe_mapping_config import load_mapping_config
        import pathlib

        p = pathlib.Path(ROOT) / "mediapipe_mapping.default.json"
        cfg = load_mapping_config(p)
        self.assertEqual(cfg["mouthCorner"]["model"], MODEL_LANDMARK_2D_V2)


class TestNeutral(unittest.TestCase):
    def test_not_ready_keeps_center_no_diagonal_fallback(self):
        cfg = default_mouth_corner_config()
        cfg["rejectOnHeadMotion"] = False
        state = create_mouth_corner_state()
        lm = _face()
        out = apply_mouth_corner_to_rig(
            landmarks=lm,
            get_landmark_xy=_get_xy,
            cfg=cfg,
            state=state,
            smile_left=80.0,
            smile_right=80.0,
            head_motion_active=False,
            tracking_quality=1.0,
        )
        self.assertEqual(out["sideL"]["x"], 50.0)
        self.assertEqual(out["sideL"]["y"], 50.0)
        self.assertEqual(out["debug"]["model"], MODEL_LANDMARK_2D_V2)
        # Must NOT equal diagonal-v1 smile expand
        self.assertNotAlmostEqual(out["sideL"]["x"], 50.0 - 80.0 * 0.35)

    def test_neutral_median_and_reset(self):
        cfg = default_mouth_corner_config()
        cfg["rejectOnHeadMotion"] = False
        cfg["neutralWarmupFrames"] = 2
        cfg["neutralSampleCount"] = 5
        state = create_mouth_corner_state()
        lm = _face()
        for _ in range(2 + 5):
            c = build_canonical_mouth_corner_observation(lm, cfg, _get_xy)
            info = update_mouth_corner_neutral(
                state, c, cfg, face_detected=True, head_motion_active=False, mouth_motion_score=0.0
            )
        self.assertTrue(info["ready"])
        reset_mouth_corner_state(state)
        self.assertFalse(state["neutralReady"])

    def test_outlier_does_not_poison_median(self):
        cfg = default_mouth_corner_config()
        cfg["rejectOnHeadMotion"] = False
        cfg["neutralWarmupFrames"] = 0
        cfg["neutralSampleCount"] = 5
        state = create_mouth_corner_state()
        base = _face()
        c_ok = build_canonical_mouth_corner_observation(base, cfg, _get_xy)
        # 4 good + 1 extreme
        for _ in range(4):
            update_mouth_corner_neutral(state, c_ok, cfg, mouth_motion_score=0.0)
        bad_lm = _face(left=(0.10, 0.90))
        c_bad = build_canonical_mouth_corner_observation(bad_lm, cfg, _get_xy)
        # Force available for collection
        c_bad["available"] = True
        update_mouth_corner_neutral(state, c_bad, cfg, mouth_motion_score=0.0)
        self.assertTrue(state["neutralReady"])
        # Median of 4 good + 1 bad ≈ good
        self.assertAlmostEqual(state["neutralLeftX"], c_ok["left"]["canonicalX"], places=3)


class TestQualityHold(unittest.TestCase):
    def test_head_motion_hold_then_center(self):
        cfg = default_mouth_corner_config()
        cfg["rejectOnHeadMotion"] = True
        cfg["deadzoneX"] = 0.0
        cfg["deadzoneY"] = 0.0
        cfg["holdLastValidFrames"] = 2
        cfg["decayToCenterFrames"] = 2
        base = _face()
        c0 = build_canonical_mouth_corner_observation(
            base, {**cfg, "rejectOnHeadMotion": False}, _get_xy
        )
        state = create_mouth_corner_state()
        _seed_neutral(
            state,
            (c0["left"]["canonicalX"], c0["left"]["canonicalY"]),
            (c0["right"]["canonicalX"], c0["right"]["canonicalY"]),
            cfg,
        )
        moved = _face(left=(0.38, 0.60))
        out_ok = apply_mouth_corner_to_rig(
            landmarks=moved,
            get_landmark_xy=_get_xy,
            cfg={**cfg, "rejectOnHeadMotion": False},
            state=state,
            smile_left=0.0,
            smile_right=0.0,
            head_motion_active=False,
            tracking_quality=1.0,
        )
        self.assertNotEqual(out_ok["sideL"]["x"], 50.0)
        last_x = out_ok["sideL"]["x"]
        # head motion → hold
        out_h = apply_mouth_corner_to_rig(
            landmarks=moved,
            get_landmark_xy=_get_xy,
            cfg=cfg,
            state=state,
            smile_left=0.0,
            smile_right=0.0,
            head_motion_active=True,
            tracking_quality=1.0,
        )
        self.assertTrue(out_h["debug"]["quality"]["heldLastValid"])
        self.assertAlmostEqual(out_h["sideL"]["x"], last_x)


class TestNoAxisCollapse(unittest.TestCase):
    def test_jacobian_rank_4(self):
        cfg = default_mouth_corner_config()
        cfg["deadzoneX"] = 0.0
        cfg["deadzoneY"] = 0.0
        eps = 1e-4
        base = {
            "leftDx": 0.01,
            "leftDy": -0.01,
            "rightDx": 0.01,
            "rightDy": -0.01,
        }
        keys = ["leftDx", "leftDy", "rightDx", "rightDy"]
        outs = ["sideL.x", "sideL.y", "sideR.x", "sideR.y"]

        def pack(d):
            p = project_mouth_corners_landmark_2d_v2(d, cfg)
            return [
                p["sideL"]["x"],
                p["sideL"]["y"],
                p["sideR"]["x"],
                p["sideR"]["y"],
            ]

        y0 = pack(base)
        J = []
        for k in keys:
            d = dict(base)
            d[k] = float(base[k]) + eps
            y1 = pack(d)
            J.append([(y1[i] - y0[i]) / eps for i in range(4)])
        # J rows = partial outputs / partial inputs → transpose for rank of mapping
        # Check diagonal independence: each input affects only its output
        self.assertGreater(abs(J[0][0]), 1e-6)  # leftDx → sideL.x
        self.assertLess(abs(J[0][1]), 1e-9)  # leftDx ↛ sideL.y
        self.assertGreater(abs(J[1][1]), 1e-6)
        self.assertLess(abs(J[1][0]), 1e-9)
        self.assertGreater(abs(J[2][2]), 1e-6)
        self.assertLess(abs(J[2][3]), 1e-9)
        self.assertGreater(abs(J[3][3]), 1e-6)
        self.assertLess(abs(J[3][2]), 1e-9)
        # rank 4
        import numpy as np

        rank = int(np.linalg.matrix_rank(np.array(J), tol=1e-8))
        self.assertEqual(rank, 4)

    def test_no_fixed_5_7_relation(self):
        cfg = default_mouth_corner_config()
        cfg["deadzoneX"] = 0.0
        cfg["deadzoneY"] = 0.0
        xs, ys = [], []
        for i in range(20):
            p = project_mouth_corners_landmark_2d_v2(
                {
                    "leftDx": 0.01 * math.sin(i),
                    "leftDy": 0.02 * math.cos(i * 0.7),
                    "rightDx": 0.0,
                    "rightDy": 0.0,
                },
                cfg,
            )
            xs.append(p["sideL"]["x"])
            ys.append(p["sideL"]["y"])
        # Fit y = a + b x ; residual should be large vs diagonal-v1 (exact line)
        import numpy as np

        A = np.vstack([xs, np.ones(len(xs))]).T
        b, a = np.linalg.lstsq(A, ys, rcond=None)[0]
        resid = np.max(np.abs(np.array(ys) - (b * np.array(xs) + a)))
        self.assertGreater(resid, 0.5)


class TestScenarioIsolationEvidence(unittest.TestCase):
    def test_legacy_evidence_matches_smile_scale(self):
        cfg_v1 = default_mouth_corner_config()
        cfg_v1["model"] = MODEL_DIAGONAL_V1
        cfg_v2 = default_mouth_corner_config()
        cfg_v2["rejectOnHeadMotion"] = False
        lm = _face()
        state = create_mouth_corner_state()
        out_v1 = apply_mouth_corner_to_rig(
            landmarks=lm,
            get_landmark_xy=_get_xy,
            cfg=cfg_v1,
            state=None,
            smile_left=40.0,
            smile_right=20.0,
        )
        out_v2 = apply_mouth_corner_to_rig(
            landmarks=lm,
            get_landmark_xy=_get_xy,
            cfg=cfg_v2,
            state=state,
            smile_left=40.0,
            smile_right=20.0,
        )
        self.assertAlmostEqual(out_v1["legacySmileCornerEvidence"], max(40 * 0.35, 20 * 0.35))
        self.assertAlmostEqual(out_v2["legacySmileCornerEvidence"], out_v1["legacySmileCornerEvidence"])
        self.assertEqual(out_v1["scenarioCornerEvidenceSource"], "legacy-smile-v1")
        self.assertEqual(out_v2["scenarioCornerEvidenceSource"], "legacy-smile-v1")


class TestProjectorDispatch(unittest.TestCase):
    def test_project_to_rig_models(self):
        d = project_mouth_corners_to_rig(model=MODEL_DIAGONAL_V1, smile_left=10, smile_right=10)
        self.assertEqual(d["model"], MODEL_DIAGONAL_V1)
        v2 = project_mouth_corners_to_rig(
            model=MODEL_LANDMARK_2D_V2,
            delta={"leftDx": 0.02, "leftDy": 0.0, "rightDx": 0.0, "rightDy": 0.0},
            cfg=default_mouth_corner_config(),
        )
        self.assertEqual(v2["model"], MODEL_LANDMARK_2D_V2)


class TestFaceFrameUsesStableAnchors(unittest.TestCase):
    def test_corners_not_locked_to_half(self):
        """If we wrongly used mouth_pose (61/291 axes), corners would be ±0.5,0."""
        cfg = default_mouth_corner_config()
        lm = _face(left=(0.40, 0.55), right=(0.60, 0.70))
        frame = build_face_local_corner_frame(lm, cfg, _get_xy)
        self.assertTrue(frame["ok"])
        lx, ly = frame["project"]((lm[61].x, lm[61].y, lm[61].z))
        rx, ry = frame["project"]((lm[291].x, lm[291].y, lm[291].z))
        # Not forced to ±0.5, 0
        self.assertFalse(abs(lx - (-0.5)) < 1e-6 and abs(ly) < 1e-6)
        self.assertFalse(abs(rx - 0.5) < 1e-6 and abs(ry) < 1e-6)
        self.assertLess(lx, 0.0)
        self.assertGreater(rx, 0.0)


class TestConversationHeadMotionNeutral(unittest.TestCase):
    """回归：nose head-motion 高频时仍能完成 Neutral 并输出非 50 的 side*。"""

    def test_default_config_collects_under_head_motion(self):
        cfg = default_mouth_corner_config()
        self.assertFalse(cfg.get("rejectOnHeadMotion"))
        state = create_mouth_corner_state()
        base = _face()
        for _ in range(cfg["neutralWarmupFrames"] + cfg["neutralSampleCount"] + 2):
            out = apply_mouth_corner_to_rig(
                landmarks=base,
                get_landmark_xy=_get_xy,
                cfg=cfg,
                state=state,
                smile_left=30.0,
                smile_right=30.0,
                head_motion_active=True,
                tracking_quality=1.0,
                mouth_motion_score=25.0,
            )
        self.assertTrue(state["neutralReady"])
        moved = _face(left=(0.38, 0.58))
        out = apply_mouth_corner_to_rig(
            landmarks=moved,
            get_landmark_xy=_get_xy,
            cfg=cfg,
            state=state,
            smile_left=30.0,
            smile_right=30.0,
            head_motion_active=True,
            tracking_quality=1.0,
            mouth_motion_score=25.0,
        )
        self.assertTrue(
            abs(out["sideL"]["x"] - 50.0) > 0.5 or abs(out["sideL"]["y"] - 50.0) > 0.5,
            msg=f"expected non-center pad, got {out['sideL']}",
        )


if __name__ == "__main__":
    unittest.main()
