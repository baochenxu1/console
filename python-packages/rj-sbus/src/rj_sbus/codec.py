"""Angle ticks / degrees helpers + ADC→angle conversion."""

from __future__ import annotations

from typing import Optional, Sequence

from .constants import ANGLE_TICK_MAX, ANGLE_TICK_MIN
from .packet import decode_i16_le, decode_u16_le, decode_u32_le


def degrees_to_ticks(degrees: float) -> int:
    return int(round(float(degrees) * 10))


def ticks_to_degrees(ticks: int) -> float:
    return float(ticks) / 10.0


def clamp_ticks(ticks: int, *, min_ticks: int = ANGLE_TICK_MIN, max_ticks: int = ANGLE_TICK_MAX) -> int:
    n = int(round(ticks))
    return max(min_ticks, min(max_ticks, n))


def angle_ticks_from_adc(
    adc: int,
    *,
    limit_high: int,
    limit_low: int,
    mid_offset: int,
    adc_high: int,
    adc_low: int,
) -> int:
    """
    Convert potentiometer ADC to protocol angle ticks (0.1°).

    Datasheet writes: ((x-b)*(m-n)/(a-b) - p)/10 for degrees.
    Empirically (and as a proper lerp [b,a]→[n,m]) the ticks form is:

        ticks = (x - b) * (m - n) / (a - b) + n - p

    where m/n = angle_limit_high/low, p = angle_mid_offset,
    a/b = angle_upper/lower_limit_ADC.
    """
    a = int(adc_high)
    b = int(adc_low)
    if a == b:
        raise ValueError("invalid ADC calibration: adc_high == adc_low")
    x = int(adc)
    m = int(limit_high)
    n = int(limit_low)
    p = int(mid_offset)
    return int(round((x - b) * (m - n) / (a - b) + n - p))


def parse_read_angle_content(content: Sequence[int]) -> Optional[dict]:
    c = list(content or [])
    if len(c) < 3:
        return None
    sid = c[0] & 0xFF
    angle_ticks = decode_i16_le(c, 1)
    return {"id": sid, "angle_ticks": angle_ticks, "degrees": ticks_to_degrees(angle_ticks)}


def parse_id_ret_content(content: Sequence[int]) -> Optional[dict]:
    c = list(content or [])
    if len(c) < 2:
        return None
    sid = c[0] & 0xFF
    ret = c[1] & 0xFF
    return {"id": sid, "ret": ret, "ok": ret == 1}


def parse_read_data_content(content: Sequence[int]) -> Optional[dict]:
    c = list(content or [])
    if len(c) < 2:
        return None
    return {"id": c[0] & 0xFF, "data_id": c[1] & 0xFF, "data": c[2:]}


def decode_data_payload(data_id: int, data: Sequence[int]) -> Optional[int]:
    """Decode common data_id payloads (little-endian)."""
    arr = list(data or [])
    # 1-byte
    if data_id in {5, 33, 34, 36, 37, 46, 48, 49}:
        return arr[0] & 0xFF if arr else None
    # signed int16
    if data_id in {51, 52, 53}:
        return decode_i16_le(arr, 0) if len(arr) >= 2 else None
    # unsigned int16
    if data_id in {1, 2, 3, 4, 6, 7, 9, 10, 38, 39, 40, 41, 42, 43, 50}:
        return decode_u16_le(arr, 0) if len(arr) >= 2 else None
    # unsigned int32
    if data_id in {8, 100, 101, 102, 103, 106, 107, 108, 109}:
        return decode_u32_le(arr, 0) if len(arr) >= 4 else None
    return None
