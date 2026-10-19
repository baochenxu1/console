"""Unit tests: Face Console logical ↔ RJ protocol mapping + safety window."""

from __future__ import annotations

import pytest

from rj_sbus.constants import (
    ANGLE_TICK_CENTER,
    ANGLE_TICK_HARD_MAX,
    ANGLE_TICK_HARD_MIN,
    ANGLE_TICK_MAX,
    ANGLE_TICK_MIN,
)
from rj_sbus.mapping import (
    LOGICAL_CENTER,
    logical_to_mechanism_deg,
    logical_to_protocol_ticks,
    protocol_ticks_to_logical,
)
from rj_sbus.codec import angle_ticks_from_adc
from rj_sbus.packet import build_move_on_angle_mode, to_hex
from rj_sbus.safety import SafetyError, default_window


@pytest.mark.parametrize(
    "logical,ticks,mech_deg",
    [
        (0, -900, 0.0),
        (250, -450, 45.0),
        (500, 0, 90.0),
        (750, 450, 135.0),
        (1000, 900, 180.0),
        (823, 581, 148.14),
    ],
)
def test_logical_to_protocol_matches_face_console(logical, ticks, mech_deg):
    assert logical_to_protocol_ticks(logical) == ticks
    assert logical_to_mechanism_deg(logical) == pytest.approx(mech_deg, abs=0.02)


def test_protocol_ticks_roundtrip_keypoints():
    for logical in (0, 250, 500, 750, 1000):
        ticks = logical_to_protocol_ticks(logical)
        assert protocol_ticks_to_logical(ticks) == logical


def test_safety_window_signed_mid_zero():
    w = default_window()
    assert w.zero_ticks == ANGLE_TICK_CENTER == 0
    assert w.min_ticks == ANGLE_TICK_MIN == -900
    assert w.max_ticks == ANGLE_TICK_MAX == 900
    assert w.check_ticks(0) == 0
    assert w.check_ticks(-900) == -900
    assert w.check_ticks(900) == 900
    with pytest.raises(SafetyError):
        w.check_ticks(-901, strict=True)
    with pytest.raises(SafetyError):
        w.check_ticks(901, strict=True)
    assert w.check_ticks(1200, strict=False) == 900


def test_installed_center_clamped_to_hard_limits():
    w = default_window(zero_ticks=0)
    assert w.min_ticks >= ANGLE_TICK_HARD_MIN
    assert w.max_ticks <= ANGLE_TICK_HARD_MAX


@pytest.mark.parametrize(
    "adc,expected_ticks",
    [
        (2042, 0),
        (1485, -450),
        (2608, 450),
        (3168, 900),
        (920, -900),
    ],
)
def test_angle_ticks_from_adc_live_calibration(adc, expected_ticks):
    ticks = angle_ticks_from_adc(
        adc,
        limit_high=1500,
        limit_low=-1500,
        mid_offset=0,
        adc_high=3920,
        adc_low=170,
    )
    assert abs(ticks - expected_ticks) <= 3


def test_move_packet_for_logical_endpoints():
    # mid → ticks 0
    _hex = to_hex(build_move_on_angle_mode(1, angle_ticks=0, time_ms=0, power=600))
    assert _hex.startswith("12 4C 08 07 01 00 00 00 00 58 02")
    # logical 1000 → +900 = 0x0384 → 84 03
    _hex = to_hex(build_move_on_angle_mode(1, angle_ticks=900, time_ms=0, power=600))
    assert "01 84 03 00 00 58 02" in _hex
    # logical 0 → -900 = 0xFC7C → 7C FC
    _hex = to_hex(build_move_on_angle_mode(1, angle_ticks=-900, time_ms=0, power=600))
    assert "01 7C FC 00 00 58 02" in _hex
