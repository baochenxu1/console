"""Safe RJ_SBUS client (zero + travel)."""

from __future__ import annotations

from typing import Optional, Sequence

from .codec import (
    angle_ticks_from_adc,
    degrees_to_ticks,
    decode_data_payload,
    parse_id_ret_content,
    parse_read_angle_content,
    ticks_to_degrees,
)
from .constants import (
    CMD_MOVE_ON_ANGLE_MODE,
    CMD_PING,
    CMD_READ_ANGLE,
    CMD_READ_DATA,
    DATA_ID_ANGLE_ADC,
    DATA_ID_ANGLE_LIMIT_HIGH,
    DATA_ID_ANGLE_LIMIT_LOW,
    DATA_ID_ANGLE_LOWER_LIMIT_ADC,
    DATA_ID_ANGLE_MID_OFFSET,
    DATA_ID_ANGLE_UPPER_LIMIT_ADC,
)
from .mapping import LOGICAL_CENTER, logical_to_protocol_ticks
from .packet import build_move_on_angle_mode, build_ping, build_read_angle, build_read_data
from .safety import TravelWindow, default_window
from .transport import SerialTransport

# Face Console realtime write default (0 often means “no torque” on some firmwares).
DEFAULT_WRITE_POWER = 600


class RjSbusClient:
    """
    Safe RJ_SBUS bus client.

    Model-layer iron rule (Face Console):
      logical 0..1000 ↔ mechanism 0°..180°, mid ±90°.

    RJ protocol (MID_OFFSET=0):
      signed ticks, mid = 0; model window -900..+900.
      logical 0/500/1000 → ticks -900/0/+900.
    """

    def __init__(
        self,
        transport: SerialTransport,
        *,
        zero_ticks: Optional[int] = None,
        strict: bool = True,
        window: Optional[TravelWindow] = None,
        default_power: int = DEFAULT_WRITE_POWER,
    ) -> None:
        self.transport = transport
        self.strict = strict
        self.window = window or default_window(zero_ticks=zero_ticks)
        self.default_power = int(default_power)
        self._angle_cal_cache: dict[int, dict] = {}

    @classmethod
    def open(
        cls,
        port: str,
        *,
        baudrate: int = 115_200,
        zero_ticks: Optional[int] = None,
        strict: bool = True,
        default_power: int = DEFAULT_WRITE_POWER,
    ) -> "RjSbusClient":
        tr = SerialTransport(port, baudrate=baudrate)
        tr.open()
        return cls(tr, zero_ticks=zero_ticks, strict=strict, default_power=default_power)

    def close(self) -> None:
        self.transport.close()

    def __enter__(self) -> "RjSbusClient":
        if not self.transport.connected:
            self.transport.open()
        return self

    def __exit__(self, *args) -> None:
        self.close()

    def ping(self, servo_id: int, timeout_ms: int = 100) -> dict:
        tx = build_ping(servo_id)
        res = self.transport.request(
            tx,
            expected_id=servo_id,
            expected_cmd=CMD_PING,
            timeout_ms=timeout_ms,
        )
        return {"ok": bool(res.get("ok")), "id": servo_id, "error": res.get("reason", ""), "raw": res}

    def scan(self, start_id: int = 0, end_id: int = 20, timeout_ms: int = 40) -> list:
        found = []
        for sid in range(int(start_id), int(end_id) + 1):
            if self.ping(sid, timeout_ms=timeout_ms)["ok"]:
                found.append(sid)
        return found

    def write_angle_ticks(
        self,
        servo_id: int,
        angle_ticks: int,
        *,
        time_ms: int = 0,
        power: Optional[int] = None,
        wait_ack: bool = False,
    ) -> dict:
        ticks = self.window.check_ticks(angle_ticks, strict=self.strict)
        pwr = self.default_power if power is None else int(power)
        tx = build_move_on_angle_mode(servo_id, angle_ticks=ticks, time_ms=time_ms, power=pwr)
        if not wait_ack:
            self.transport.write(tx)
            return {"ok": True, "id": servo_id, "angle_ticks": ticks, "degrees": ticks_to_degrees(ticks)}

        res = self.transport.request(
            tx,
            expected_id=servo_id,
            expected_cmd=CMD_MOVE_ON_ANGLE_MODE,
            timeout_ms=80,
        )
        if not res.get("ok") and res.get("reason") == "timeout":
            return {
                "ok": True,
                "id": servo_id,
                "angle_ticks": ticks,
                "degrees": ticks_to_degrees(ticks),
                "acked": False,
            }
        ret = parse_id_ret_content(res.get("content") or [])
        ok = bool(res.get("ok")) and (ret is None or ret.get("ok", True))
        return {
            "ok": ok,
            "id": servo_id,
            "angle_ticks": ticks,
            "degrees": ticks_to_degrees(ticks),
            "acked": bool(res.get("ok")),
            "error": res.get("reason", ""),
        }

    def write_degrees(
        self,
        servo_id: int,
        degrees: float,
        *,
        time_ms: int = 0,
        power: Optional[int] = None,
        wait_ack: bool = False,
    ) -> dict:
        """Write protocol degrees (signed, mid 0). Prefer write_logical for Face Console space."""
        ticks = self.window.check_degrees(degrees, strict=self.strict)
        return self.write_angle_ticks(
            servo_id,
            ticks,
            time_ms=time_ms,
            power=power,
            wait_ack=wait_ack,
        )

    def write_logical(
        self,
        servo_id: int,
        logical: float,
        *,
        time_ms: int = 0,
        power: Optional[int] = None,
        wait_ack: bool = False,
    ) -> dict:
        """
        Write Face Console bus logical 0..1000
        (mechanism 0°..180° / mid ±90° → protocol ticks -900/0/+900).
        """
        ticks = logical_to_protocol_ticks(logical)
        res = self.write_angle_ticks(
            servo_id,
            ticks,
            time_ms=time_ms,
            power=power,
            wait_ack=wait_ack,
        )
        res["logical"] = int(round(float(logical)))
        return res

    def go_zero(self, servo_id: int, *, time_ms: int = 200, power: Optional[int] = None) -> dict:
        """Go to protocol mid (ticks 0) = Face Console logical 500."""
        return self.write_logical(servo_id, LOGICAL_CENTER, time_ms=time_ms, power=power)

    def read_data(self, servo_id: int, data_id: int, timeout_ms: int = 100) -> dict:
        tx = build_read_data(servo_id, data_id)
        res = self.transport.request(
            tx,
            expected_id=servo_id,
            expected_cmd=CMD_READ_DATA,
            timeout_ms=timeout_ms,
        )
        if not res.get("ok"):
            return {"ok": False, "id": servo_id, "data_id": data_id, "error": res.get("reason", "")}
        content = res.get("content") or []
        data = content[2:] if len(content) >= 2 else []
        value = decode_data_payload(data_id, data)
        return {
            "ok": True,
            "id": servo_id,
            "data_id": data_id,
            "value": value,
            "data": data,
        }

    def _load_angle_calibration(self, servo_id: int, timeout_ms: int = 120) -> Optional[dict]:
        if servo_id in self._angle_cal_cache:
            return self._angle_cal_cache[servo_id]
        keys = [
            DATA_ID_ANGLE_LIMIT_HIGH,
            DATA_ID_ANGLE_LIMIT_LOW,
            DATA_ID_ANGLE_MID_OFFSET,
            DATA_ID_ANGLE_UPPER_LIMIT_ADC,
            DATA_ID_ANGLE_LOWER_LIMIT_ADC,
        ]
        vals: dict[int, int] = {}
        for data_id in keys:
            r = self.read_data(servo_id, data_id, timeout_ms=timeout_ms)
            if not r.get("ok") or r.get("value") is None:
                return None
            vals[data_id] = int(r["value"])
        cal = {
            "limit_high": vals[DATA_ID_ANGLE_LIMIT_HIGH],
            "limit_low": vals[DATA_ID_ANGLE_LIMIT_LOW],
            "mid_offset": vals[DATA_ID_ANGLE_MID_OFFSET],
            "adc_high": vals[DATA_ID_ANGLE_UPPER_LIMIT_ADC],
            "adc_low": vals[DATA_ID_ANGLE_LOWER_LIMIT_ADC],
        }
        self._angle_cal_cache[servo_id] = cal
        return cal

    def read_angle_adc(self, servo_id: int, timeout_ms: int = 100) -> dict:
        """Read angle via data_id=9 angle_ADC + B区标定公式（真机推荐）。"""
        cal = self._load_angle_calibration(servo_id, timeout_ms=timeout_ms)
        if not cal:
            return {"ok": False, "id": servo_id, "error": "angle-calibration-read-failed"}
        adc_res = self.read_data(servo_id, DATA_ID_ANGLE_ADC, timeout_ms=timeout_ms)
        if not adc_res.get("ok") or adc_res.get("value") is None:
            return {"ok": False, "id": servo_id, "error": adc_res.get("error", "angle_adc-read-failed")}
        adc = int(adc_res["value"])
        try:
            ticks = angle_ticks_from_adc(
                adc,
                limit_high=cal["limit_high"],
                limit_low=cal["limit_low"],
                mid_offset=cal["mid_offset"],
                adc_high=cal["adc_high"],
                adc_low=cal["adc_low"],
            )
        except ValueError as exc:
            return {"ok": False, "id": servo_id, "error": str(exc), "angle_adc": adc}
        return {
            "ok": True,
            "id": servo_id,
            "angle_ticks": ticks,
            "degrees": ticks_to_degrees(ticks),
            "angle_adc": adc,
            "source": "angle_adc",
        }

    def read_angle_cmd10(self, servo_id: int, timeout_ms: int = 100) -> dict:
        """READ_ANGLE cmd=10（部分固件读数不可靠，仅作对照）。"""
        tx = build_read_angle(servo_id)
        res = self.transport.request(
            tx,
            expected_id=servo_id,
            expected_cmd=CMD_READ_ANGLE,
            timeout_ms=timeout_ms,
        )
        if not res.get("ok"):
            return {"ok": False, "id": servo_id, "error": res.get("reason", "")}
        parsed = parse_read_angle_content(res.get("content") or [])
        if not parsed:
            return {"ok": False, "id": servo_id, "error": "parse-failed"}
        return {
            "ok": True,
            "id": servo_id,
            "angle_ticks": parsed["angle_ticks"],
            "degrees": parsed["degrees"],
            "source": "read_angle_cmd10",
        }

    def read_angle(self, servo_id: int, timeout_ms: int = 100) -> dict:
        """默认用 angle_ADC 换算；失败时回退 READ_ANGLE。"""
        adc = self.read_angle_adc(servo_id, timeout_ms=timeout_ms)
        if adc.get("ok"):
            return adc
        fallback = self.read_angle_cmd10(servo_id, timeout_ms=timeout_ms)
        if fallback.get("ok"):
            fallback["fallback_from"] = adc.get("error", "angle_adc-failed")
        return fallback

    def write_angles(
        self,
        commands: Sequence[dict],
        *,
        time_ms: int = 0,
        power: Optional[int] = None,
    ) -> dict:
        results = []
        for cmd in commands:
            sid = int(cmd["id"])
            if "logical" in cmd:
                results.append(
                    self.write_logical(
                        sid,
                        float(cmd["logical"]),
                        time_ms=int(cmd.get("time", time_ms)),
                        power=int(cmd["power"]) if "power" in cmd else power,
                    )
                )
            elif "degrees" in cmd:
                results.append(
                    self.write_degrees(
                        sid,
                        float(cmd["degrees"]),
                        time_ms=int(cmd.get("time", time_ms)),
                        power=int(cmd["power"]) if "power" in cmd else power,
                    )
                )
            else:
                results.append(
                    self.write_angle_ticks(
                        sid,
                        int(cmd["angle_ticks"]),
                        time_ms=int(cmd.get("time", time_ms)),
                        power=int(cmd["power"]) if "power" in cmd else power,
                    )
                )
        ok = all(r.get("ok") for r in results) if results else False
        return {"ok": ok, "results": results}
