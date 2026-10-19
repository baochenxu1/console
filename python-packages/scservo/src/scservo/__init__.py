"""Feetech SC (scscl) bus servo driver (pyserial)."""

from .client import ScServoClient
from .constants import DEFAULT_BAUDRATE, PROTOCOL_SCSCL, SC_SAFE
from .safety import SafetyError, TravelWindow, default_window
from .transport import SerialTransport

__all__ = [
    "ScServoClient",
    "SerialTransport",
    "TravelWindow",
    "SafetyError",
    "default_window",
    "PROTOCOL_SCSCL",
    "DEFAULT_BAUDRATE",
    "SC_SAFE",
]

__version__ = "0.1.1"
