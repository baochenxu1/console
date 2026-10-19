"""ST packet / safety unit tests (no hardware)."""

from __future__ import annotations

import pytest

from stservo.packet import (
    build_ping,
    build_write,
    compute_checksum,
    encode_st_position,
    parse_status_packet,
)
from stservo.safety import SafetyError, default_window


def test_ping_packet():
    tx = build_ping(1)
    assert tx[:4] == bytes([0xFF, 0xFF, 0x01, 0x02])
    assert tx[-1] == compute_checksum(list(tx[2:-1]))


def test_st_position_encode():
    data = encode_st_position(2048, speed=0, acc=0)
    assert len(data) >= 5
    tx = build_write(1, 41, data)
    assert tx[0] == 0xFF


def test_parse_status():
    body = [0x01, 0x02, 0x00]
    cs = compute_checksum(body)
    frame = bytes([0xFF, 0xFF, *body, cs])
    parsed = parse_status_packet(frame, expected_id=1)
    assert parsed["ok"] is True
    assert parsed["id"] == 1


def test_st_safety_window():
    w = default_window("sms_sts")
    assert w.zero == 2048
    assert w.min_pos == 1024
    assert w.max_pos == 3072
    with pytest.raises(SafetyError):
        w.check(100, strict=True)
