"""RJ_SBUS packet encode / decode."""

from __future__ import annotations

from typing import Iterable, List, Optional, Sequence

from .constants import (
    CMD_MOVE_ON_ANGLE_MODE,
    CMD_MOVE_ON_ANGLE_MODE_EX,
    CMD_PING,
    CMD_READ_ANGLE,
    CMD_READ_DATA,
    REQUEST_HEADER_0,
    REQUEST_HEADER_1,
    RESPONSE_HEADER_0,
    RESPONSE_HEADER_1,
)


def u8(value: int) -> int:
    return int(value) & 0xFF


def encode_u16_le(value: int) -> List[int]:
    w = int(value) & 0xFFFF
    return [w & 0xFF, (w >> 8) & 0xFF]


def encode_i16_le(value: int) -> List[int]:
    return encode_u16_le(value)


def decode_u16_le(data: Sequence[int], offset: int = 0) -> int:
    a = data[offset] & 0xFF
    b = data[offset + 1] & 0xFF
    return a | (b << 8)


def decode_i16_le(data: Sequence[int], offset: int = 0) -> int:
    u = decode_u16_le(data, offset)
    return u - 0x10000 if u > 0x7FFF else u


def decode_u32_le(data: Sequence[int], offset: int = 0) -> int:
    a = data[offset] & 0xFF
    b = data[offset + 1] & 0xFF
    c = data[offset + 2] & 0xFF
    d = data[offset + 3] & 0xFF
    return a | (b << 8) | (c << 16) | (d << 24)


def compute_checksum(data: Sequence[int]) -> int:
    return sum(b & 0xFF for b in data) & 0xFF


def build_request(cmd_id: int, content: Optional[Iterable[int]] = None) -> bytes:
    body = [u8(x) for x in (content or [])]
    n = len(body)
    prefix = [REQUEST_HEADER_0, REQUEST_HEADER_1, u8(cmd_id), u8(n), *body]
    return bytes([*prefix, compute_checksum(prefix)])


def build_ping(servo_id: int) -> bytes:
    return build_request(CMD_PING, [u8(servo_id)])


def build_read_data(servo_id: int, data_id: int) -> bytes:
    return build_request(CMD_READ_DATA, [u8(servo_id), u8(data_id)])


def build_move_on_angle_mode(
    servo_id: int,
    *,
    angle_ticks: int,
    time_ms: int = 0,
    power: int = 0,
) -> bytes:
    return build_request(
        CMD_MOVE_ON_ANGLE_MODE,
        [
            u8(servo_id),
            *encode_i16_le(angle_ticks),
            *encode_u16_le(time_ms),
            *encode_u16_le(power),
        ],
    )


def build_move_on_angle_mode_ex(
    servo_id: int,
    *,
    angle_ticks: int,
    interval_ms: int = 0,
    acc_interval_ms: int = 0,
    dec_interval_ms: int = 0,
    power: int = 0,
) -> bytes:
    return build_request(
        CMD_MOVE_ON_ANGLE_MODE_EX,
        [
            u8(servo_id),
            *encode_i16_le(angle_ticks),
            *encode_u16_le(interval_ms),
            *encode_u16_le(acc_interval_ms),
            *encode_u16_le(dec_interval_ms),
            *encode_u16_le(power),
        ],
    )


def build_read_angle(servo_id: int) -> bytes:
    return build_request(CMD_READ_ANGLE, [u8(servo_id)])


def parse_response_packet(
    buffer: Sequence[int],
    *,
    expected_id: Optional[int] = None,
    expected_cmd: Optional[int] = None,
) -> dict:
    data = list(buffer)
    for i in range(0, max(0, len(data) - 4)):
        if data[i] != RESPONSE_HEADER_0 or data[i + 1] != RESPONSE_HEADER_1:
            continue
        cmd_id = data[i + 2]
        n = data[i + 3]
        total = 5 + n
        if i + total > len(data):
            return {"ok": False, "reason": "incomplete"}
        frame = data[i : i + total]
        content = frame[4 : 4 + n]
        checksum = frame[total - 1]
        if checksum != compute_checksum(frame[: total - 1]):
            continue
        sid = content[0] if content else None
        if expected_cmd is not None and cmd_id != expected_cmd:
            continue
        if expected_id is not None and sid != expected_id:
            continue
        return {
            "ok": True,
            "cmd_id": cmd_id,
            "id": sid,
            "content": content,
            "raw": frame,
            "consumed_until": i + total,
        }
    return {"ok": False, "reason": "not-found"}


def to_hex(data: bytes | Sequence[int]) -> str:
    return " ".join(f"{(b & 0xFF):02X}" for b in data)
