"""Face Console model-layer mapping for RJ_SBUS.

Iron rule (same as JS Face Console):
  logical 0..1000 ↔ mechanism travel 180°, mid ±90°

RJ protocol (MID_OFFSET=0): signed 0.1° ticks, mid = 0.
Fixed map used by Face Console:
  logical 0 / 500 / 1000 → protocol ticks -900 / 0 / +900
"""

from __future__ import annotations

from .constants import ANGLE_TICK_CENTER, ANGLE_TICK_MAX, ANGLE_TICK_MIN

LOGICAL_MIN = 0
LOGICAL_MAX = 1000
LOGICAL_CENTER = 500
MECHANISM_TRAVEL_DEG = 180


def clamp_logical(value: float) -> int:
    n = int(round(float(value)))
    return max(LOGICAL_MIN, min(LOGICAL_MAX, n))


def logical_to_mechanism_deg(logical: float) -> float:
    """UI / model mechanism angle: 0°..180°, mid 90°."""
    return (clamp_logical(logical) / LOGICAL_MAX) * MECHANISM_TRAVEL_DEG


def logical_to_protocol_ticks(logical: float) -> int:
    """
    Map bus logical → RJ protocol ticks (signed, mid 0).

    Piecewise linear about logical 500, matching JS computeServoAngleFromLogical
    for RJ_SPEC (protocol angles -90 / 0 / +90).
    """
    L = clamp_logical(logical)
    if L <= LOGICAL_CENTER:
        t = L / LOGICAL_CENTER
        return int(round(ANGLE_TICK_MIN + t * (ANGLE_TICK_CENTER - ANGLE_TICK_MIN)))
    t = (L - LOGICAL_CENTER) / LOGICAL_CENTER
    return int(round(ANGLE_TICK_CENTER + t * (ANGLE_TICK_MAX - ANGLE_TICK_CENTER)))


def protocol_ticks_to_logical(ticks: float) -> int:
    """Inverse map: protocol ticks → nearest logical 0..1000."""
    n = int(round(float(ticks)))
    if n <= ANGLE_TICK_CENTER:
        span = ANGLE_TICK_CENTER - ANGLE_TICK_MIN
        if span <= 0:
            return LOGICAL_CENTER
        t = (n - ANGLE_TICK_MIN) / span
        return clamp_logical(t * LOGICAL_CENTER)
    span = ANGLE_TICK_MAX - ANGLE_TICK_CENTER
    if span <= 0:
        return LOGICAL_CENTER
    t = (n - ANGLE_TICK_CENTER) / span
    return clamp_logical(LOGICAL_CENTER + t * LOGICAL_CENTER)


def logical_to_protocol_deg(logical: float) -> float:
    """Protocol degrees (signed): -90..+90."""
    return logical_to_protocol_ticks(logical) / 10.0
