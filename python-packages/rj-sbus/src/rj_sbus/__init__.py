"""Ruijie RJ_SBUS bus servo driver (pyserial).

Independent package — does not depend on feetech-scservo.

Safety / Face Console model:
  logical 0..1000 ↔ mechanism 0°..180° (mid ±90°)
  RJ protocol (MID_OFFSET=0): signed ticks mid=0 → -900 / 0 / +900
"""

from .client import DEFAULT_WRITE_POWER, RjSbusClient
from .codec import degrees_to_ticks, ticks_to_degrees
from .constants import (
    ANGLE_DEG_CENTER,
    ANGLE_DEG_MAX,
    ANGLE_DEG_MIN,
    ANGLE_TICK_CENTER,
    ANGLE_TICK_HARD_MAX,
    ANGLE_TICK_HARD_MIN,
    ANGLE_TICK_MAX,
    ANGLE_TICK_MIN,
    DEFAULT_BAUDRATE,
)
from .mapping import (
    LOGICAL_CENTER,
    LOGICAL_MAX,
    LOGICAL_MIN,
    logical_to_mechanism_deg,
    logical_to_protocol_deg,
    logical_to_protocol_ticks,
    protocol_ticks_to_logical,
)
from .safety import SafetyError, TravelWindow, default_window
from .transport import SerialTransport

__all__ = [
    "RjSbusClient",
    "SerialTransport",
    "TravelWindow",
    "SafetyError",
    "default_window",
    "degrees_to_ticks",
    "ticks_to_degrees",
    "logical_to_protocol_ticks",
    "logical_to_protocol_deg",
    "logical_to_mechanism_deg",
    "protocol_ticks_to_logical",
    "DEFAULT_BAUDRATE",
    "DEFAULT_WRITE_POWER",
    "LOGICAL_MIN",
    "LOGICAL_CENTER",
    "LOGICAL_MAX",
    "ANGLE_TICK_MIN",
    "ANGLE_TICK_CENTER",
    "ANGLE_TICK_MAX",
    "ANGLE_TICK_HARD_MIN",
    "ANGLE_TICK_HARD_MAX",
    "ANGLE_DEG_MIN",
    "ANGLE_DEG_CENTER",
    "ANGLE_DEG_MAX",
]

__version__ = "0.1.2"
