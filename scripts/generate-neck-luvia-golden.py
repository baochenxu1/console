#!/usr/bin/env python3
"""Generate Luvia golden fixture for FaceDEV Browser Neck Runtime R1.

Adds Luvia src to PYTHONPATH, solves IK + map_qs for curated A–N cases + 1000 seeded random.
Writes: tests/fixtures/neck-luvia-golden-v1.json

Usage (from FaceDEV 04_Software):
  python scripts/generate-neck-luvia-golden.py
  python scripts/generate-neck-luvia-golden.py --luvia-root F:/Dreame_PJ/luvia_neck_control/04_Software
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
from datetime import datetime, timezone
from pathlib import Path


def _add_luvia(luvia_root: Path) -> None:
    src = luvia_root / "src"
    if not src.is_dir():
        raise SystemExit(f"Luvia src not found: {src}")
    sys.path.insert(0, str(src))


def _round_half_up_signed(x: float) -> int:
    v = float(x)
    if v >= 0.0:
        return int(math.floor(v + 0.5))
    return int(math.ceil(v - 0.5))


def main() -> int:
    here = Path(__file__).resolve().parent
    facedev_root = here.parent
    default_luvia = Path(r"F:/Dreame_PJ/luvia_neck_control/04_Software")
    ap = argparse.ArgumentParser()
    ap.add_argument("--luvia-root", type=Path, default=default_luvia)
    ap.add_argument(
        "--out",
        type=Path,
        default=facedev_root / "tests" / "fixtures" / "neck-luvia-golden-v1.json",
    )
    ap.add_argument("--seed", type=int, default=20260907)
    ap.add_argument("--random-count", type=int, default=1000)
    args = ap.parse_args()

    _add_luvia(args.luvia_root)

    from luvia.control.kinematics_hardware_mapper import (  # noqa: E402
        KinematicsHardwareMapper,
        load_hardware_mapping,
    )
    from luvia.kinematics.forward import solve_fk  # noqa: E402
    from luvia.kinematics.geometry import load_neck_geometry  # noqa: E402
    from luvia.kinematics.inverse import solve_ik  # noqa: E402

    cfg = args.luvia_root / "configs"
    geom = load_neck_geometry(cfg / "neck_geometry.yaml")
    hw = load_hardware_mapping(cfg / "kinematics_hardware_mapping.yaml")
    mapper = KinematicsHardwareMapper(hw)

    profile_snapshot = {
        "geometry": {
            "status": geom.status,
            "mathematicalStatus": geom.mathematical_status or geom.status,
            "frame": geom.frame,
            "side1": {
                "a0Mm": geom.side_1.a0_mm.tolist(),
                "oMm": geom.side_1.o_mm.tolist(),
                "n": geom.side_1.n.tolist(),
                "b0Mm": geom.side_1.b0_mm.tolist(),
                "linkLengthMm": float(geom.side_1.link_length_mm),
            },
            "side2": {
                "a0Mm": geom.side_2.a0_mm.tolist(),
                "oMm": geom.side_2.o_mm.tolist(),
                "n": geom.side_2.n.tolist(),
                "b0Mm": geom.side_2.b0_mm.tolist(),
                "linkLengthMm": float(geom.side_2.link_length_mm),
            },
        },
        "mapping": {
            "side1": {
                "motorId": hw.side_1.motor_id,
                "qToModuleSign": hw.side_1.q_to_module_sign,
                "offsetDeg": float(hw.cal_1.offset_deg),
            },
            "side2": {
                "motorId": hw.side_2.motor_id,
                "qToModuleSign": hw.side_2.q_to_module_sign,
                "offsetDeg": float(hw.cal_2.offset_deg),
            },
            "yaw": {
                "motorId": hw.yaw.motor_id,
                "qToModuleSign": hw.yaw.q_to_module_sign,
                "minDeg": hw.yaw.min_deg,
                "maxDeg": hw.yaw.max_deg,
                "enabled": True,
            },
            "limits": {
                "jointAbsDeg": hw.limits.joint_abs_deg,
                "relativeModuleAbsDeg": hw.limits.relative_module_abs_deg,
                "neutralOffsetAbsDeg": hw.limits.neutral_offset_abs_deg,
            },
        },
        "safety": {
            "maxVelocityDegS": 85.0,
            "maxAccelerationDegS2": 400.0,
            "periodS": 0.01,
        },
    }

    def solve_case(
        *,
        case_id: str,
        category: str,
        pitch: float,
        roll: float,
        yaw: float,
        previous_q1: float = 0.0,
        previous_q2: float = 0.0,
        offset1: float = 0.0,
        offset2: float = 0.0,
        yaw_enabled: bool = True,
    ) -> dict:
        # temporary offset override
        old1, old2 = hw.cal_1.offset_deg, hw.cal_2.offset_deg
        from luvia.control.kinematics_hardware_mapper import SideNeutralCalibration

        hw.cal_1 = SideNeutralCalibration(offset_deg=float(offset1), status=hw.cal_1.status)
        hw.cal_2 = SideNeutralCalibration(offset_deg=float(offset2), status=hw.cal_2.status)
        try:
            ik = solve_ik(
                geom,
                pitch_deg=float(pitch),
                roll_deg=float(roll),
                previous_q1_deg=float(previous_q1),
                previous_q2_deg=float(previous_q2),
            )
            fk = None
            mapped = None
            if ik.valid:
                fk = solve_fk(
                    geom,
                    q1_deg=float(ik.q1_deg),
                    q2_deg=float(ik.q2_deg),
                    previous_pitch_deg=float(pitch),
                    previous_roll_deg=float(roll),
                )
                mapped = mapper.map_qs(
                    pitch_deg=float(pitch),
                    roll_deg=float(roll),
                    q1_deg=float(ik.q1_deg),
                    q2_deg=float(ik.q2_deg),
                    yaw_deg=float(yaw),
                    yaw_enabled=bool(yaw_enabled),
                    yaw_sign=int(hw.yaw.q_to_module_sign),
                    yaw_min=float(hw.yaw.min_deg),
                    yaw_max=float(hw.yaw.max_deg),
                )
                valid = bool(mapped.valid)
                reject = "" if valid else (mapped.reject_reason or "MAP_REJECTED")
            else:
                valid = False
                reject = ik.reject_reason or "IK_INVALID"

            ref = {
                "valid": valid,
                "rejectReason": reject,
                "q1": float(ik.q1_deg),
                "q2": float(ik.q2_deg),
                "q3": float(mapped.q3_deg) if mapped and mapped.valid else float(yaw if yaw_enabled else 0.0),
                "branch": ik.branch,
                "closureError": float(ik.closure_error_mm)
                if math.isfinite(ik.closure_error_mm)
                else None,
                "moduleDeg": {
                    "id1": float(mapped.module1_deg) if mapped and mapped.valid else 0.0,
                    "id2": float(mapped.module2_deg) if mapped and mapped.valid else 0.0,
                    "id3": float(mapped.module3_deg) if mapped and mapped.valid else 0.0,
                },
                "raw": {
                    "id1": int(mapped.raw1) if mapped and mapped.valid else 0,
                    "id2": int(mapped.raw2) if mapped and mapped.valid else 0,
                    "id3": int(mapped.raw3) if mapped and mapped.valid else 0,
                },
                "fk": None
                if fk is None
                else {
                    "valid": bool(fk.valid),
                    "pitch": float(fk.pitch_deg),
                    "roll": float(fk.roll_deg),
                    "branch": fk.branch,
                    "closureError": float(fk.closure_error_mm)
                    if math.isfinite(fk.closure_error_mm)
                    else None,
                },
            }
            return {
                "id": case_id,
                "category": category,
                "input": {
                    "pitch": float(pitch),
                    "roll": float(roll),
                    "yaw": float(yaw),
                    "previousQ": {"q1": float(previous_q1), "q2": float(previous_q2)},
                    "offsets": {"side1": float(offset1), "side2": float(offset2)},
                    "yawEnabled": bool(yaw_enabled),
                },
                "reference": ref,
            }
        finally:
            hw.cal_1 = SideNeutralCalibration(offset_deg=float(old1), status=hw.cal_1.status)
            hw.cal_2 = SideNeutralCalibration(offset_deg=float(old2), status=hw.cal_2.status)

    cases: list[dict] = []

    # A Neutral
    cases.append(solve_case(case_id="A-neutral", category="A", pitch=0, roll=0, yaw=0))
    # B Pitch
    for i, p in enumerate([2, 5, 8, 10, -2, -5, -8, -10]):
        cases.append(solve_case(case_id=f"B-pitch-{i}", category="B", pitch=p, roll=0, yaw=0))
    # C Roll
    for i, r in enumerate([3, 8, 12, 15, -3, -8, -12, -15]):
        cases.append(solve_case(case_id=f"C-roll-{i}", category="C", pitch=0, roll=r, yaw=0))
    # D Combined
    for i, (p, r) in enumerate([(5, 5), (8, -8), (-5, 10), (-8, -5), (10, 15), (-10, -15)]):
        cases.append(solve_case(case_id=f"D-comb-{i}", category="D", pitch=p, roll=r, yaw=0))
    # E Yaw
    for i, y in enumerate([10, 45, 90, -10, -45, -90]):
        cases.append(solve_case(case_id=f"E-yaw-{i}", category="E", pitch=0, roll=0, yaw=y))
    # F envelope boundaries
    for i, (p, r, y) in enumerate([(10, 15, 0), (-10, -15, 0), (0, 0, 90), (0, 0, -90)]):
        cases.append(solve_case(case_id=f"F-env-{i}", category="F", pitch=p, roll=r, yaw=y))
    # G joint-ish (pose that may approach joint limit after IK)
    for i, (p, r) in enumerate([(12, 0), (0, 18), (15, 15)]):
        cases.append(solve_case(case_id=f"G-jointish-{i}", category="G", pitch=p, roll=r, yaw=0))
    # H unreachable (extreme pose)
    for i, (p, r) in enumerate([(45, 0), (0, 45), (30, 30), (60, 60)]):
        cases.append(solve_case(case_id=f"H-unreach-{i}", category="H", pitch=p, roll=r, yaw=0))
    # I yaw reject
    for i, y in enumerate([91, -91, 120, -120]):
        cases.append(solve_case(case_id=f"I-yaw-rej-{i}", category="I", pitch=0, roll=0, yaw=y))
    # J near-neutral continuity path
    path = [(0, 0), (1, 0), (2, 0), (2, 1), (1, 1), (0, 0)]
    pq1 = pq2 = 0.0
    for i, (p, r) in enumerate(path):
        c = solve_case(
            case_id=f"J-cont-{i}",
            category="J",
            pitch=p,
            roll=r,
            yaw=0,
            previous_q1=pq1,
            previous_q2=pq2,
        )
        cases.append(c)
        if c["reference"]["valid"]:
            pq1 = c["reference"]["q1"]
            pq2 = c["reference"]["q2"]
    # K previous-q branch selection (same pose, different previous)
    for i, (pq1, pq2) in enumerate([(0, 0), (5, -5), (-8, 8), (15, 15)]):
        cases.append(
            solve_case(
                case_id=f"K-prev-{i}",
                category="K",
                pitch=5,
                roll=-3,
                yaw=0,
                previous_q1=pq1,
                previous_q2=pq2,
            )
        )
    # L non-zero offsets
    for i, (o1, o2) in enumerate([(1.5, -1.0), (3.0, 3.0), (-2.5, 1.25)]):
        cases.append(
            solve_case(
                case_id=f"L-off-{i}",
                category="L",
                pitch=4,
                roll=-4,
                yaw=10,
                offset1=o1,
                offset2=o2,
            )
        )

    rng = random.Random(args.seed)
    # M/N random
    for i in range(args.random_count):
        mode = rng.random()
        if mode < 0.55:
            # reachable-ish inside UI envelope
            p = rng.uniform(-10, 10)
            r = rng.uniform(-15, 15)
            y = rng.uniform(-90, 90)
            cat = "M"
        elif mode < 0.8:
            # near boundary
            p = rng.choice([-10, -9.5, 0, 9.5, 10]) + rng.uniform(-0.2, 0.2)
            r = rng.choice([-15, -14.5, 0, 14.5, 15]) + rng.uniform(-0.2, 0.2)
            y = rng.choice([-90, -89, 0, 89, 90]) + rng.uniform(-0.5, 0.5)
            cat = "M"
        else:
            # invalid / extreme
            p = rng.uniform(-60, 60)
            r = rng.uniform(-60, 60)
            y = rng.uniform(-150, 150)
            cat = "N"
        cases.append(
            solve_case(
                case_id=f"{cat}-rand-{i:04d}",
                category=cat,
                pitch=p,
                roll=r,
                yaw=y,
                previous_q1=rng.uniform(-5, 5),
                previous_q2=rng.uniform(-5, 5),
            )
        )

    # mapping raw sanity for a few known angles
    raw_checks = []
    for deg in [0.0, 0.18, 0.36, 1.0, -1.0, 7.2, -7.2]:
        raw_checks.append({"commandDeg": deg, "raw": _round_half_up_signed(deg / 360.0 * 1000.0)})

    payload = {
        "meta": {
            "fixture": "neck-luvia-golden-v1",
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "seed": args.seed,
            "luviaRoot": str(args.luvia_root),
            "caseCount": len(cases),
            "profileSnapshot": profile_snapshot,
            "rawRoundingChecks": raw_checks,
            "notes": [
                "Python Luvia is golden oracle",
                "select_nearest uses abs distance not wrap",
                "IK success branch is always nearest_continuous",
                "closure tol 0.1 mm",
            ],
        },
        "cases": cases,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote {len(cases)} cases → {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
