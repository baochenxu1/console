"""Live hardware test for RJ_SBUS Face Console mapping.

Requires:
  - RJ servo on serial (default COM5 @ 115200)
  - Face Console must NOT hold the port
  - Env optional: RJ_SBUS_PORT, RJ_SBUS_ID, RJ_SBUS_SKIP=1

Run:
  cd python-packages/rj-sbus
  pytest tests/test_hardware_live.py -v -s
"""

from __future__ import annotations

import os
import time

import pytest

from rj_sbus import RjSbusClient, logical_to_protocol_ticks

pytestmark = pytest.mark.hardware

PORT = os.environ.get("RJ_SBUS_PORT", "COM5")
SERVO_ID = int(os.environ.get("RJ_SBUS_ID", "2"))
SETTLE_S = float(os.environ.get("RJ_SBUS_SETTLE_S", "1.0"))
TOL_TICKS = int(os.environ.get("RJ_SBUS_TOL_TICKS", "100"))


def _skip_requested() -> bool:
    return os.environ.get("RJ_SBUS_SKIP", "").strip() in {"1", "true", "TRUE", "yes"}


@pytest.fixture(scope="module")
def bus():
    if _skip_requested():
        pytest.skip("RJ_SBUS_SKIP set")
    try:
        client = RjSbusClient.open(PORT, baudrate=115_200, strict=True)
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"无法打开 {PORT}: {exc}（请先关闭 Face Console 串口）")
    try:
        found = client.scan(0, 20, timeout_ms=60)
        if SERVO_ID not in found:
            client.close()
            pytest.skip(f"目标 ID={SERVO_ID} 不在线，scan={found}。可设 RJ_SBUS_ID")
        yield client
    finally:
        try:
            client.write_logical(SERVO_ID, 500, time_ms=300)
            time.sleep(0.2)
        except Exception:
            pass
        client.close()


def test_ping_and_read(bus: RjSbusClient):
    assert bus.ping(SERVO_ID)["ok"] is True
    rd = bus.read_angle(SERVO_ID)
    assert rd.get("ok") is True
    assert rd.get("source") == "angle_adc"
    cmd10 = bus.read_angle_cmd10(SERVO_ID)
    print(
        f"\n[live] id={SERVO_ID} adc_ticks={rd['angle_ticks']} "
        f"cmd10={cmd10.get('angle_ticks')} adc_raw={rd.get('angle_adc')}"
    )


@pytest.mark.parametrize("logical,target", [(500, 0), (0, -900), (1000, 900), (500, 0)])
def test_write_logical_motion(bus: RjSbusClient, logical: int, target: int):
    assert logical_to_protocol_ticks(logical) == target
    before = bus.read_angle(SERVO_ID)
    assert before.get("ok")

    wr = bus.write_logical(SERVO_ID, logical, time_ms=600, power=800, wait_ack=True)
    assert wr.get("ok"), f"write_logical failed: {wr}"
    time.sleep(SETTLE_S)
    after = bus.read_angle(SERVO_ID)
    assert after.get("ok"), f"read failed: {after}"
    got = int(after["angle_ticks"])
    cmd10 = bus.read_angle_cmd10(SERVO_ID)
    print(
        f"\n[live] L={logical} target={target} before={before['angle_ticks']} "
        f"after_adc={got} cmd10={cmd10.get('angle_ticks')} ack={wr.get('acked')}"
    )

    if abs(got - target) <= TOL_TICKS:
        return

    moved_toward = abs(got - target) < abs(int(before["angle_ticks"]) - target) - 20
    if wr.get("acked") and moved_toward:
        return

    if wr.get("acked") and not moved_toward:
        pytest.fail(
            f"协议已应答但 ADC 读数未跟上：before={before['angle_ticks']} after={got} target={target}"
        )
    pytest.fail(f"未到位：target={target} got={got} (tol={TOL_TICKS})")
