"""Safe Feetech SC (scscl) client (zero + travel)."""

from __future__ import annotations

from typing import Optional, Sequence

from .constants import (
    PROTOCOL_SCSCL,
    SC_REG_GOAL_POSITION_L,
    SC_REG_PRESENT_POSITION_L,
    SCS_END_SC,
)
from .packet import (
    build_ping,
    build_read,
    build_write,
    decode_position,
    encode_sc_position,
)
from .safety import TravelWindow, default_window
from .transport import SerialTransport


class ScServoClient:
    """Safe SC bus client with zero + travel enforcement."""

    def __init__(
        self,
        transport: SerialTransport,
        *,
        zero: Optional[int] = None,
        strict: bool = True,
        window: Optional[TravelWindow] = None,
    ) -> None:
        self.transport = transport
        self.protocol = PROTOCOL_SCSCL
        self.strict = strict
        self.window = window or default_window(PROTOCOL_SCSCL, zero=zero)

    @classmethod
    def open(
        cls,
        port: str,
        *,
        baudrate: int = 1_000_000,
        zero: Optional[int] = None,
        strict: bool = True,
    ) -> "ScServoClient":
        tr = SerialTransport(port, baudrate=baudrate)
        tr.open()
        return cls(tr, zero=zero, strict=strict)

    def close(self) -> None:
        self.transport.close()

    def __enter__(self) -> "ScServoClient":
        if not self.transport.connected:
            self.transport.open()
        return self

    def __exit__(self, *args) -> None:
        self.close()

    def ping(self, servo_id: int, timeout_ms: int = 100) -> dict:
        tx = build_ping(servo_id)
        res = self.transport.request(tx, expected_id=servo_id, timeout_ms=timeout_ms)
        return {"ok": bool(res.get("ok")), "id": servo_id, "error": res.get("reason", ""), "raw": res}

    def scan(self, start_id: int = 0, end_id: int = 20, timeout_ms: int = 40) -> list:
        found = []
        for sid in range(int(start_id), int(end_id) + 1):
            if self.ping(sid, timeout_ms=timeout_ms)["ok"]:
                found.append(sid)
        return found

    def write_position(
        self,
        servo_id: int,
        position: int,
        *,
        time_ms: int = 0,
        speed: int = 0,
        wait_ack: bool = False,
    ) -> dict:
        pos = self.window.check(position, strict=self.strict)
        data = encode_sc_position(pos, time_ms=time_ms, speed=speed)
        tx = build_write(servo_id, SC_REG_GOAL_POSITION_L, data)

        if not wait_ack:
            self.transport.write(tx)
            return {"ok": True, "id": servo_id, "position": pos, "tx": list(tx)}

        res = self.transport.request(tx, expected_id=servo_id, timeout_ms=80)
        if not res.get("ok") and res.get("reason") == "timeout":
            return {"ok": True, "id": servo_id, "position": pos, "acked": False, "tx": list(tx)}
        return {
            "ok": bool(res.get("ok")),
            "id": servo_id,
            "position": pos,
            "acked": bool(res.get("ok")),
            "tx": list(tx),
            "error": res.get("reason", ""),
        }

    def go_zero(self, servo_id: int, *, time_ms: int = 200, speed: int = 0) -> dict:
        return self.write_position(servo_id, self.window.zero, time_ms=time_ms, speed=speed)

    def read_position(self, servo_id: int, timeout_ms: int = 100) -> dict:
        tx = build_read(servo_id, SC_REG_PRESENT_POSITION_L, 2)
        res = self.transport.request(tx, expected_id=servo_id, timeout_ms=timeout_ms)
        if not res.get("ok"):
            return {"ok": False, "id": servo_id, "error": res.get("reason", "")}
        value = decode_position(res.get("params") or [], SCS_END_SC)
        return {"ok": value is not None, "id": servo_id, "position": value}

    def write_positions(
        self,
        commands: Sequence[dict],
        *,
        time_ms: int = 0,
        speed: int = 0,
    ) -> dict:
        results = []
        for cmd in commands:
            results.append(
                self.write_position(
                    int(cmd["id"]),
                    int(cmd["position"]),
                    time_ms=int(cmd.get("time", time_ms)),
                    speed=int(cmd.get("speed", speed)),
                    wait_ack=False,
                )
            )
        ok = all(r.get("ok") for r in results) if results else False
        return {"ok": ok, "results": results}
