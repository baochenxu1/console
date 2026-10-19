"""Safety: zero (mid) + travel window. Assembly face mid = 90°."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from .constants import PROTOCOL_SCSCL, PROTOCOL_SMS_STS, SC_SAFE, ST_SAFE


class SafetyError(ValueError):
    """Raised when a command violates the configured travel window."""


@dataclass(frozen=True)
class TravelWindow:
    zero: int
    min_pos: int
    max_pos: int
    travel_deg: int = 180
    label: str = ""

    def clamp(self, position: int) -> int:
        p = int(round(position))
        return max(self.min_pos, min(self.max_pos, p))

    def check(self, position: int, *, strict: bool = True) -> int:
        p = int(round(position))
        if self.min_pos <= p <= self.max_pos:
            return p
        if strict:
            raise SafetyError(
                f"position {p} outside safe window [{self.min_pos}, {self.max_pos}] "
                f"(zero={self.zero}, travel≈±{self.travel_deg // 2}°)"
            )
        return self.clamp(p)


def default_window(protocol: str, *, zero: Optional[int] = None) -> TravelWindow:
    if protocol not in (PROTOCOL_SCSCL, PROTOCOL_SMS_STS):
        raise ValueError(f"unsupported protocol: {protocol}")

    base = SC_SAFE if protocol == PROTOCOL_SCSCL else ST_SAFE
    hw_max = 1023 if protocol == PROTOCOL_SCSCL else 4095

    if zero is None:
        return TravelWindow(
            zero=int(base["zero"]),
            min_pos=int(base["min"]),
            max_pos=int(base["max"]),
            travel_deg=int(base["travel_deg"]),
            label=protocol,
        )

    z = int(zero)
    half = (int(base["max"]) - int(base["min"])) // 2
    lo = max(0, z - half)
    hi = min(hw_max, z + half)
    return TravelWindow(zero=z, min_pos=lo, max_pos=hi, travel_deg=180, label=f"{protocol}:installed")
