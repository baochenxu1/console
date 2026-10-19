#!/usr/bin/env python3
"""Generate Luvia protocol golden fixture for FaceDEV Browser Neck Runtime R2.

Calls Luvia BmHmdProtocol + encode_slcan_ascii (read-only). Writes:
  tests/fixtures/neck-luvia-protocol-golden-v1.json

Usage (from FaceDEV 04_Software):
  set PYTHONPATH=F:/Dreame_PJ/luvia_neck_control/04_Software/src
  python scripts/generate-neck-luvia-protocol-golden.py
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from datetime import datetime, timezone
from pathlib import Path


def _add_luvia(luvia_root: Path) -> None:
    src = luvia_root / "src"
    if not src.is_dir():
        raise SystemExit(f"Luvia src not found: {src}")
    sys.path.insert(0, str(src))


def _hex(data: bytes) -> str:
    return data.hex(" ").upper()


def _hex_compact(data: bytes) -> str:
    return data.hex().upper()


def _frame_dict(frame, slcan: str) -> dict:
    return {
        "arbitrationId": int(frame.arbitration_id),
        "isExtendedId": bool(frame.is_extended_id),
        "isFd": bool(frame.is_fd),
        "brs": bool(frame.bitrate_switch),
        "dataHex": _hex(frame.data),
        "dataHexCompact": _hex_compact(frame.data),
        "slcanAscii": slcan,
    }


def main() -> int:
    here = Path(__file__).resolve().parent
    facedev_root = here.parent
    default_luvia = Path(r"F:/Dreame_PJ/luvia_neck_control/04_Software")
    ap = argparse.ArgumentParser()
    ap.add_argument("--luvia-root", type=Path, default=default_luvia)
    ap.add_argument(
        "--out",
        type=Path,
        default=facedev_root / "tests" / "fixtures" / "neck-luvia-protocol-golden-v1.json",
    )
    ap.add_argument("--seed", type=int, default=20260907)
    ap.add_argument("--random-count", type=int, default=1000)
    args = ap.parse_args()

    _add_luvia(args.luvia_root)

    from luvia.models.can_frame import CanFrame, FrameDirection  # noqa: E402
    from luvia.models.motor_command import MotorCmd  # noqa: E402
    from luvia.protocol.bm_hmd import BmHmdProtocol  # noqa: E402
    from luvia.protocol.slcan_ascii import encode_slcan_ascii  # noqa: E402
    from luvia.transport.slcan_session import build_init_sequence  # noqa: E402

    proto = BmHmdProtocol(fd=True, brs=False)
    cases: list[dict] = []

    def add_cmd(case_id: str, category: str, note: str, frame) -> None:
        slcan = encode_slcan_ascii(frame)
        cases.append(
            {
                "id": case_id,
                "category": category,
                "kind": "command",
                "note": note,
                "frame": _frame_dict(frame, slcan),
            }
        )

    # A–F: 0x32
    add_cmd(
        "A-zero",
        "A",
        "0x32 all zeros",
        proto.encode_position_command_frame_from_raw(
            motor_1_raw=0, motor_2_raw=0, motor_3_raw=0, motor_4_raw=0
        ),
    )
    add_cmd(
        "B-positive",
        "B",
        "0x32 positive raws",
        proto.encode_position_command_frame_from_raw(
            motor_1_raw=100, motor_2_raw=200, motor_3_raw=50, motor_4_raw=0
        ),
    )
    add_cmd(
        "C-negative",
        "C",
        "0x32 negative raws",
        proto.encode_position_command_frame_from_raw(
            motor_1_raw=-100, motor_2_raw=-200, motor_3_raw=-50, motor_4_raw=0
        ),
    )
    add_cmd(
        "D-mixed",
        "D",
        "0x32 mixed signs 100,-100,50,0",
        proto.encode_position_command_frame_from_raw(
            motor_1_raw=100, motor_2_raw=-100, motor_3_raw=50, motor_4_raw=0
        ),
    )
    add_cmd(
        "E-minmax",
        "E",
        "0x32 min/max valid command raw ±1000",
        proto.encode_position_command_frame_from_raw(
            motor_1_raw=1000, motor_2_raw=-1000, motor_3_raw=1000, motor_4_raw=-1000
        ),
    )
    add_cmd(
        "F-slot4",
        "F",
        "0x32 slot4 non-zero",
        proto.encode_position_command_frame_from_raw(
            motor_1_raw=1, motor_2_raw=2, motor_3_raw=3, motor_4_raw=4
        ),
    )

    # G: 0x36
    add_cmd("G-pos-mode-1", "G", "0x36 position mode motor 1", proto.encode_set_position_mode(1))
    add_cmd("G-pos-mode-2", "G", "0x36 position mode motor 2", proto.encode_set_position_mode(2))
    add_cmd("G-pos-mode-3", "G", "0x36 position mode motor 3", proto.encode_set_position_mode(3))

    # H–J: 0x38
    add_cmd(
        "H-enable-123",
        "H",
        "0x38 ENABLE motors 1,2,3",
        proto.encode_state_control([MotorCmd.ENABLE, MotorCmd.ENABLE, MotorCmd.ENABLE]),
    )
    add_cmd(
        "I-disable-123",
        "I",
        "0x38 DISABLE motors 1,2,3",
        proto.encode_state_control([MotorCmd.DISABLE, MotorCmd.DISABLE, MotorCmd.DISABLE]),
    )
    add_cmd(
        "J-calibrate-1",
        "J",
        "0x38 CALIBRATE motor 1 only",
        proto.encode_state_control([MotorCmd.CALIBRATE]),
    )

    # L–N: feedback decode references
    feedback_cases: list[dict] = []

    # L: DriveFeedback 0x51 sample
    drive_data = bytes.fromhex("FF9C FF06 0800 01E0")
    drive_frame = CanFrame(
        0.0,
        0x51,
        drive_data,
        is_extended_id=False,
        is_fd=True,
        bitrate_switch=False,
        direction=FrameDirection.RX,
    )
    drive_fb = proto.decode_drive_feedback(drive_frame)
    feedback_cases.append(
        {
            "id": "L-drive-0x51",
            "category": "L",
            "kind": "feedback",
            "note": "DriveFeedback 0x51 sample",
            "input": {
                "arbitrationId": 0x51,
                "isFd": True,
                "brs": False,
                "dataHex": _hex(drive_data),
                "dataHexCompact": _hex_compact(drive_data),
            },
            "reference": {
                "motorId": drive_fb.motor_id,
                "speedRpm": drive_fb.speed_rpm,
                "iqA": drive_fb.iq_a,
                "rawAbsolutePosition": drive_fb.raw_absolute_position,
                "absolutePositionDeg": drive_fb.absolute_position_deg,
                "voltageV": drive_fb.voltage_v,
                "rawSpeedI16": drive_fb.raw_speed_i16,
                "rawIqI16": drive_fb.raw_iq_i16,
            },
        }
    )

    # M: Telemetry 0x71
    tel_data = bytes.fromhex("0032 0064 00F0 0000")
    tel_frame = CanFrame(
        0.0,
        0x71,
        tel_data,
        is_extended_id=False,
        is_fd=True,
        bitrate_switch=False,
        direction=FrameDirection.RX,
    )
    tel_fb = proto.decode_telemetry_feedback(tel_frame)
    feedback_cases.append(
        {
            "id": "M-telemetry-0x71",
            "category": "M",
            "kind": "feedback",
            "note": "Telemetry 0x71",
            "input": {
                "arbitrationId": 0x71,
                "isFd": True,
                "brs": False,
                "dataHex": _hex(tel_data),
                "dataHexCompact": _hex_compact(tel_data),
            },
            "reference": {
                "motorId": tel_fb.motor_id,
                "speedRpm": tel_fb.speed_rpm,
                "iqA": tel_fb.iq_a,
                "voltageV": tel_fb.voltage_v,
                "rawAbsolutePosition": tel_fb.raw_absolute_position,
                "absolutePositionDeg": tel_fb.absolute_position_deg,
            },
        }
    )

    # N: State 0xA1
    state_data = bytes.fromhex("01 05 01 01 00 00 FF FF")
    state_frame = CanFrame(
        0.0,
        0xA1,
        state_data,
        is_extended_id=False,
        is_fd=True,
        bitrate_switch=False,
        direction=FrameDirection.RX,
    )
    st = proto.decode_state_feedback(state_frame)
    feedback_cases.append(
        {
            "id": "N-state-0xA1",
            "category": "N",
            "kind": "feedback",
            "note": "StateFeedback 0xA1",
            "input": {
                "arbitrationId": 0xA1,
                "isFd": True,
                "brs": False,
                "dataHex": _hex(state_data),
                "dataHexCompact": _hex_compact(state_data),
            },
            "reference": {
                "motorId": st.motor_id,
                "controlMode": st.control_mode,
                "cmd": st.cmd,
                "calibrated": st.calibrated,
                "faultCode": st.fault_code,
                "warningCode": st.warning_code,
            },
        }
    )

    # Open sequence
    open_seq = build_init_sequence(1_000_000, 5_000_000)

    # 1000 seeded random 0x32 frames
    rng = random.Random(args.seed)
    random_cases: list[dict] = []
    for i in range(args.random_count):
        m1 = rng.randint(-1000, 1000)
        m2 = rng.randint(-1000, 1000)
        m3 = rng.randint(-1000, 1000)
        m4 = rng.randint(-1000, 1000)
        frame = proto.encode_position_command_frame_from_raw(
            motor_1_raw=m1, motor_2_raw=m2, motor_3_raw=m3, motor_4_raw=m4
        )
        slcan = encode_slcan_ascii(frame)
        random_cases.append(
            {
                "id": f"R-{i:04d}",
                "raw": {"m1": m1, "m2": m2, "m3": m3, "m4": m4},
                "frame": _frame_dict(frame, slcan),
            }
        )

    fixture = {
        "meta": {
            "name": "neck-luvia-protocol-golden-v1",
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "seed": args.seed,
            "randomCount": args.random_count,
            "protocolProfileVersion": "bm-hmd-luvia-v1",
            "luviaRoot": str(args.luvia_root),
            "notes": [
                "Command cases A–J from BmHmdProtocol + encode_slcan_ascii",
                "Feedback L–N from decode_*",
                "Open sequence from build_init_sequence(1e6, 5e6)",
                "Random: 1000 seeded 0x32 frames (±1000 raw)",
            ],
            "referenceFacts": {
                "zero32": "00 00 00 00 00 00 00 00",
                "mixed32": "00 64 FF 9C 00 32 00 00",
                "slcanZero": "d03280000000000000000",
                "slcanMixed": "d03280064FF9C00320000",
                "mode36": "01 1D 05 00 00 00 00 00",
                "slcanMode": "d0368011D050000000000",
                "enable38": "02 02 02 00 00 00 00 00",
                "slcanEnable": "d03880202020000000000",
                "open": open_seq,
            },
        },
        "openSequence": open_seq,
        "openSequenceWithCr": [f"{c}\r" for c in open_seq],
        "cases": cases,
        "feedbackCases": feedback_cases,
        "randomCases": random_cases,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(fixture, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {args.out}")
    print(
        f"cases={len(cases)} feedback={len(feedback_cases)} random={len(random_cases)} open={open_seq}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
