"""Feetech packet / safety unit tests (no hardware)."""

from __future__ import annotations

import pytest

from feetech_scservo.packet import (
    build_ping,
    build_read,
    build_write,
    compute_checksum,
    encode_sc_position,
    parse_status_packet,
)
from feetech_scservo.safety import SafetyError, default_window


def test_ping_packet():
    tx = build_ping(1)
    assert tx[:4] == bytes([0xFF, 0xFF, 0x01, 0x02])
    assert tx[-1] == compute_checksum(list(tx[2:-1]))


def test_sc_position_encode():
    data = encode_sc_position(512, time_ms=0, speed=0)
    assert len(data) == 6
    tx = build_write(1, 42, data)
    assert tx[0] == 0xFF


def test_parse_status():
    # FF FF 01 02 00 CS
    body = [0x01, 0x02, 0x00]
    cs = compute_checksum(body)
    frame = bytes([0xFF, 0xFF, *body, cs])
    parsed = parse_status_packet(frame, expected_id=1)
    assert parsed["ok"] is True
    assert parsed["id"] == 1


def test_sc_safety_window():
    w = default_window("scscl")
    assert w.zero == 512
    assert w.check(600) == 600
    with pytest.raises(SafetyError):
        w.check(100, strict=True)


def test_st_safety_window():
    w = default_window("sms_sts")
    assert w.zero == 2048
    assert w.min_pos == 1024
    assert w.max_pos == 3072
