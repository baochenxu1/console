"""Feetech SC/ST bus servo driver (pyserial)."""

from .client import ScServoClient
from .constants import (
    DEFAULT_BAUDRATE,
    PROTOCOL_SCSCL,
    PROTOCOL_SMS_STS,
    SC_SAFE,
    ST_SAFE,
)
from .safety import SafetyError, TravelWindow, default_window
from .transport import SerialTransport

__all__ = [
    "ScServoClient",
    "SerialTransport",
    "TravelWindow",
    "SafetyError",
    "default_window",
    "PROTOCOL_SCSCL",
    "PROTOCOL_SMS_STS",
    "DEFAULT_BAUDRATE",
    "SC_SAFE",
    "ST_SAFE",
]

__version__ = "0.1.1"
