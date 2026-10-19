"""Safety: model mid ±90° mapped onto RJ signed ticks (-900..+900, mid 0)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from .constants import (
    ANGLE_DEG_CENTER,
    ANGLE_DEG_MAX,
    ANGLE_DEG_MIN,
    ANGLE_TICK_CENTER,
    ANGLE_TICK_HARD_MAX,
    ANGLE_TICK_HARD_MIN,
    ANGLE_TICK_MAX,
    ANGLE_TICK_MIN,
)
from .codec import degrees_to_ticks


class SafetyError(ValueError):
    """Raised when angle is outside the configured travel window."""


@dataclass(frozen=True)
class TravelWindow:
    zero_ticks: int = ANGLE_TICK_CENTER
    min_ticks: int = ANGLE_TICK_MIN
    max_ticks: int = ANGLE_TICK_MAX
    zero_deg: float = ANGLE_DEG_CENTER
    min_deg: float = ANGLE_DEG_MIN
    max_deg: float = ANGLE_DEG_MAX
    travel_deg: int = 180

    def clamp_ticks(self, ticks: int) -> int:
        n = int(round(ticks))
        return max(self.min_ticks, min(self.max_ticks, n))

    def check_ticks(self, ticks: int, *, strict: bool = True) -> int:
        n = int(round(ticks))
        if self.min_ticks <= n <= self.max_ticks:
            return n
        if strict:
            raise SafetyError(
                f"angle ticks {n} outside safe window [{self.min_ticks}, {self.max_ticks}] "
                f"(zero={self.zero_ticks}, 0.1° units)"
            )
        return self.clamp_ticks(n)

    def check_degrees(self, degrees: float, *, strict: bool = True) -> int:
        return self.check_ticks(degrees_to_ticks(degrees), strict=strict)


def default_window(*, zero_ticks: Optional[int] = None) -> TravelWindow:
    """
    Default RJ window: protocol ticks -900..+900 (mid 0) ↔ mechanism ±90°.

    If ``zero_ticks`` is set (installed center), rebuild ±900 ticks around it,
    clamped to hard limits -1500..1500.
    """
    if zero_ticks is None:
        return TravelWindow()
    z = int(zero_ticks)
    half = 900
    lo = max(ANGLE_TICK_HARD_MIN, z - half)
    hi = min(ANGLE_TICK_HARD_MAX, z + half)
    return TravelWindow(
        zero_ticks=z,
        min_ticks=lo,
        max_ticks=hi,
        zero_deg=z / 10.0,
        min_deg=lo / 10.0,
        max_deg=hi / 10.0,
        travel_deg=max(0, (hi - lo) // 10),
    )
