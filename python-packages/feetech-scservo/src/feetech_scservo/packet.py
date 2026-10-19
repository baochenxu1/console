"""Feetech packet encode / decode (FF FF ID LEN INST PARAM… CS)."""

from __future__ import annotations

from typing import Iterable, List, Optional, Sequence, Tuple

from .constants import (
    BROADCAST_ID,
    INST_ACTION,
    INST_PING,
    INST_READ,
    INST_REG_WRITE,
    INST_SYNC_WRITE,
    INST_WRITE,
    PACKET_HEADER,
    SCS_END_SC,
    SCS_END_ST,
)


def u8(value: int) -> int:
    return int(value) & 0xFF


def scs_lo_byte(value: int, end: int = SCS_END_SC) -> int:
    w = int(value) & 0xFFFF
    return (w & 0xFF) if end == 0 else ((w >> 8) & 0xFF)


def scs_hi_byte(value: int, end: int = SCS_END_SC) -> int:
    w = int(value) & 0xFFFF
    return ((w >> 8) & 0xFF) if end == 0 else (w & 0xFF)


def scs_make_word(a: int, b: int, end: int = SCS_END_SC) -> int:
    if end == 0:
        return (a & 0xFF) | ((b & 0xFF) << 8)
    return (b & 0xFF) | ((a & 0xFF) << 8)


def compute_checksum(bytes_from_id: Sequence[int]) -> int:
    s = sum(b & 0xFF for b in bytes_from_id)
    return (~s) & 0xFF


def build_packet(servo_id: int, instruction: int, params: Optional[Iterable[int]] = None) -> bytes:
    params_list = [u8(p) for p in (params or [])]
    length = len(params_list) + 2
    body = [u8(servo_id), u8(length), u8(instruction), *params_list]
    return bytes([PACKET_HEADER, PACKET_HEADER, *body, compute_checksum(body)])


def build_ping(servo_id: int) -> bytes:
    return build_packet(servo_id, INST_PING, [])


def build_read(servo_id: int, address: int, length: int) -> bytes:
    return build_packet(servo_id, INST_READ, [u8(address), u8(length)])


def build_write(servo_id: int, address: int, data: Sequence[int]) -> bytes:
    return build_packet(servo_id, INST_WRITE, [u8(address), *[u8(x) for x in data]])


def build_reg_write(servo_id: int, address: int, data: Sequence[int]) -> bytes:
    return build_packet(servo_id, INST_REG_WRITE, [u8(address), *[u8(x) for x in data]])


def build_action(broadcast_id: int = BROADCAST_ID) -> bytes:
    return build_packet(broadcast_id, INST_ACTION, [])


def build_sync_write(
    start_address: int,
    data_length: int,
    items: Sequence[Tuple[int, Sequence[int]]],
    broadcast_id: int = BROADCAST_ID,
) -> bytes:
    params: List[int] = [u8(start_address), u8(data_length)]
    for sid, data in items:
        chunk = [u8(x) for x in data][:data_length]
        if len(chunk) != data_length:
            raise ValueError(f"SyncWrite data length mismatch for id={sid}")
        params.extend([u8(sid), *chunk])
    return build_packet(broadcast_id, INST_SYNC_WRITE, params)


def encode_sc_position(position: int, time_ms: int = 0, speed: int = 0) -> List[int]:
    end = SCS_END_SC
    return [
        scs_lo_byte(position, end),
        scs_hi_byte(position, end),
        scs_lo_byte(time_ms, end),
        scs_hi_byte(time_ms, end),
        scs_lo_byte(speed, end),
        scs_hi_byte(speed, end),
    ]


def encode_st_position(position: int, speed: int = 0, acc: int = 0) -> List[int]:
    end = SCS_END_ST
    return [
        u8(acc),
        scs_lo_byte(position, end),
        scs_hi_byte(position, end),
        0,
        0,
        scs_lo_byte(speed, end),
        scs_hi_byte(speed, end),
    ]


def decode_position(params: Sequence[int], end: int) -> Optional[int]:
    if not params or len(params) < 2:
        return None
    return scs_make_word(params[0], params[1], end) & 0xFFFF


def parse_status_packet(
    buffer: Sequence[int],
    *,
    expected_id: Optional[int] = None,
) -> dict:
    data = list(buffer)
    for i in range(0, max(0, len(data) - 5)):
        if data[i] != 0xFF or data[i + 1] != 0xFF:
            continue
        if data[i + 2] == 0xFF:
            continue
        sid = data[i + 2]
        length = data[i + 3]
        if length < 2:
            continue
        total = length + 4
        if i + total > len(data):
            return {"ok": False, "reason": "incomplete"}
        frame = data[i : i + total]
        error = frame[4]
        params = frame[5 : total - 1]
        checksum = frame[total - 1]
        calc = compute_checksum(frame[2 : total - 1])
        if checksum != calc:
            continue
        if expected_id is not None and sid != expected_id:
            continue
        return {
            "ok": True,
            "id": sid,
            "error": error,
            "params": params,
            "raw": frame,
            "consumed_until": i + total,
        }
    return {"ok": False, "reason": "not-found"}
