"""RJ_SBUS packet tests — vectors from Face Console JS self-test."""

from __future__ import annotations

import pytest

from rj_sbus.codec import degrees_to_ticks, parse_id_ret_content, parse_read_angle_content
from rj_sbus.packet import (
    build_move_on_angle_mode,
    build_move_on_angle_mode_ex,
    build_ping,
    compute_checksum,
    parse_response_packet,
    to_hex,
)
from rj_sbus.safety import SafetyError, default_window


def _hex_eq(actual: bytes, expected: str, label: str) -> None:
    exp = " ".join(expected.strip().replace("0x", "").split())
    got = to_hex(actual)
    assert got == exp, f"{label}\n  expected: {exp}\n  actual:   {got}"


def test_degrees_to_ticks():
    assert degrees_to_ticks(90) == 900


def test_ping_id3():
    _hex_eq(build_ping(3), "12 4C 01 01 03 63", "PING id=3")


def test_ping_response():
    rx = bytes([0x05, 0x1C, 0x01, 0x01, 0x03, 0x26])
    parsed = parse_response_packet(rx, expected_id=3, expected_cmd=1)
    assert parsed["ok"] is True
    assert parsed["id"] == 3
    assert compute_checksum(rx[:5]) == 0x26


def test_move_90deg():
    _hex_eq(
        build_move_on_angle_mode(2, angle_ticks=900, time_ms=0, power=0),
        "12 4C 08 07 02 84 03 00 00 00 00 F6",
        "MOVE 90deg",
    )


def test_move_response():
    rx = bytes([0x05, 0x1C, 0x08, 0x02, 0x02, 0x01, 0x2E])
    parsed = parse_response_packet(rx, expected_id=2, expected_cmd=8)
    assert parsed["ok"] is True
    ret = parse_id_ret_content(parsed["content"])
    assert ret is not None and ret["ok"] is True


def test_move_90deg_500ms():
    _hex_eq(
        build_move_on_angle_mode(2, angle_ticks=900, time_ms=500, power=0),
        "12 4C 08 07 02 84 03 F4 01 00 00 EB",
        "MOVE 90deg/500ms",
    )


def test_move_ex_interval():
    _hex_eq(
        build_move_on_angle_mode_ex(
            0,
            angle_ticks=900,
            interval_ms=600,
            acc_interval_ms=100,
            dec_interval_ms=100,
            power=0,
        ),
        "12 4C 0B 0B 00 84 03 58 02 64 00 64 00 00 00 1D",
        "MOVE_EX",
    )


def test_read_angle_parse():
    parsed = parse_read_angle_content([0x00, 0x84, 0x03])
    assert parsed is not None
    assert parsed["angle_ticks"] == 900
    assert parsed["degrees"] == 90.0


def test_safety_window():
    w = default_window()
    assert w.zero_ticks == 0
    assert w.min_ticks == -900
    assert w.max_ticks == 900
    assert w.check_ticks(450) == 450
    with pytest.raises(SafetyError):
        w.check_ticks(1200, strict=True)
    with pytest.raises(SafetyError):
        w.check_ticks(-1000, strict=True)
