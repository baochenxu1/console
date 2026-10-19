"""pyserial transport for RJ_SBUS frames."""

from __future__ import annotations

import time
from typing import Optional

try:
    import serial
except ImportError as exc:  # pragma: no cover
    raise ImportError("rj-sbus requires pyserial: pip install pyserial") from exc

from .constants import DEFAULT_BAUDRATE
from .packet import parse_response_packet


class SerialTransport:
    def __init__(
        self,
        port: str,
        baudrate: int = DEFAULT_BAUDRATE,
        *,
        timeout: float = 0.05,
    ) -> None:
        self.port = port
        self.baudrate = baudrate
        self.timeout = timeout
        self._ser: Optional[serial.Serial] = None

    @property
    def connected(self) -> bool:
        return bool(self._ser and self._ser.is_open)

    def open(self) -> None:
        if self.connected:
            return
        self._ser = serial.Serial(
            port=self.port,
            baudrate=self.baudrate,
            bytesize=serial.EIGHTBITS,
            parity=serial.PARITY_NONE,
            stopbits=serial.STOPBITS_ONE,
            timeout=self.timeout,
        )
        self._ser.reset_input_buffer()
        self._ser.reset_output_buffer()

    def close(self) -> None:
        if self._ser:
            try:
                self._ser.close()
            finally:
                self._ser = None

    def __enter__(self) -> "SerialTransport":
        self.open()
        return self

    def __exit__(self, *args) -> None:
        self.close()

    def write(self, data: bytes) -> None:
        if not self.connected or self._ser is None:
            raise RuntimeError("serial port not open")
        self._ser.write(data)
        self._ser.flush()

    def clear_rx(self) -> None:
        if self._ser and self._ser.is_open:
            self._ser.reset_input_buffer()

    def request(
        self,
        tx: bytes,
        *,
        expected_id: Optional[int] = None,
        expected_cmd: Optional[int] = None,
        timeout_ms: int = 100,
    ) -> dict:
        if not self.connected or self._ser is None:
            return {"ok": False, "reason": "not-connected"}
        self.clear_rx()
        self.write(tx)
        buf = bytearray()
        deadline = time.monotonic() + max(0.01, timeout_ms / 1000.0)
        while time.monotonic() < deadline:
            chunk = self._ser.read(64)
            if chunk:
                buf.extend(chunk)
                parsed = parse_response_packet(
                    buf,
                    expected_id=expected_id,
                    expected_cmd=expected_cmd,
                )
                if parsed.get("ok"):
                    return parsed
                if parsed.get("reason") == "incomplete":
                    continue
            else:
                time.sleep(0.002)
        return {"ok": False, "reason": "timeout", "rx": list(buf)}
