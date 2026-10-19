"""Feetech ST (sms_sts) bus servo driver (pyserial)."""

from .client import StServoClient
from .constants import DEFAULT_BAUDRATE, PROTOCOL_SMS_STS, ST_SAFE
from .safety import SafetyError, TravelWindow, default_window
from .transport import SerialTransport

__all__ = [
    "StServoClient",
    "SerialTransport",
    "TravelWindow",
    "SafetyError",
    "default_window",
    "PROTOCOL_SMS_STS",
    "DEFAULT_BAUDRATE",
    "ST_SAFE",
]

__version__ = "0.1.1"
