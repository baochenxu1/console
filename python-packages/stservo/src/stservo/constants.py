"""Feetech SC / ST bus servo protocol constants."""

from __future__ import annotations

PACKET_HEADER = 0xFF
BROADCAST_ID = 0xFF
MAX_ID = 0xFC

INST_PING = 0x01
INST_READ = 0x02
INST_WRITE = 0x03
INST_REG_WRITE = 0x04
INST_ACTION = 0x05
INST_SYNC_WRITE = 0x83

# SC: high byte first; ST: low byte first
SCS_END_SC = 1
SCS_END_ST = 0

PROTOCOL_SCSCL = "scscl"
PROTOCOL_SMS_STS = "sms_sts"

# SC registers (scscl)
SC_REG_ID = 5
SC_REG_TORQUE_ENABLE = 40
SC_REG_GOAL_POSITION_L = 42
SC_REG_PRESENT_POSITION_L = 56
SC_REG_LOCK = 48

# ST registers (sms_sts)
ST_REG_ID = 5
ST_REG_TORQUE_ENABLE = 40
ST_REG_ACC = 41
ST_REG_GOAL_POSITION_L = 42
ST_REG_PRESENT_POSITION_L = 56
ST_REG_LOCK = 55

DEFAULT_BAUDRATE = 1_000_000

# Safety window (protocol position) — assembly mid = face 90°
SC_SAFE = {"zero": 512, "min": 205, "max": 819, "travel_deg": 180}
ST_SAFE = {"zero": 2048, "min": 1024, "max": 3072, "travel_deg": 180}
