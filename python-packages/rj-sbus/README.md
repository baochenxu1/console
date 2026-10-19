# RJ_SBUS Bus Servo (Python)

**独立包**：锐捷 **RJ_SBUS** 总线协议，仅依赖 **pyserial**。  
不依赖 Face Console 前端、Web Serial 或 `feetech-scservo`。

## 安装

```bash
pip install pyserial>=3.5
pip install rj_sbus-0.1.2-py3-none-any.whl
# 或：pip install rj_sbus-0.1.2.tar.gz
```

开发模式（源码目录内）：

```bash
pip install -e ".[dev]"
pytest tests/test_mapping.py tests/test_packet.py -v
```

## 中位与映射（必读）

| 项 | 值 |
|----|-----|
| **模型铁律** | `logical 0～1000` ↔ 机构 **0°～180°**（中位 ±90°） |
| **协议坐标** | 有符号 0.1° ticks，`MID_OFFSET=0` 时中位 **0** |
| **固定映射** | `logical 0 / 500 / 1000` → ticks **-900 / 0 / +900** |
| **默认安全窗** | ticks **-900～+900**（机构 0°～180°） |
| **实机硬限位** | 常见 **-1500～1500**（±150°） |
| **默认写功率** | **600** |

装配：机构 90° 对准协议中位 **0**（非绝对 90°=900 ticks）。

## 用法

```python
from rj_sbus import RjSbusClient, logical_to_protocol_ticks, protocol_ticks_to_logical

with RjSbusClient.open("COM5", baudrate=115_200) as bus:
    print(bus.ping(1))
    bus.write_logical(1, 500)   # 机构中位 → 协议 0
    bus.write_logical(1, 0)     # → -900
    bus.write_logical(1, 1000)  # → +900
    print(bus.read_angle(1))
    print(logical_to_protocol_ticks(823))   # 581
    print(protocol_ticks_to_logical(581))   # 823
```

底层角度写：

```python
bus.write_angle_ticks(1, 0, power=600)
bus.write_degrees(1, 0.0)
bus.go_zero(1)
```

## API

| 方法 | 说明 |
|------|------|
| `ping(id)` / `scan(...)` | 在线检测 |
| `read_angle(id)` | 读角度（ticks / 度） |
| `write_logical(id, 0..1000)` | Face Console 逻辑空间写入 |
| `write_angle_ticks` / `write_degrees` | 协议角写入 |
| `go_zero(id)` | 协议中位 0 |

映射函数（无需开串口）：`logical_to_protocol_ticks`, `protocol_ticks_to_logical`, `logical_to_mechanism_deg`。

未默认开放：批量 A/B 区、改 ID、重启/清保护（装机调试请用 Face Console）。

## 测试

```bash
# 单元
pytest tests/test_mapping.py tests/test_packet.py -v

# 真机（需 RJ 舵机；先关闭 Face Console 串口）
pytest tests/test_hardware_live.py -v -s
# 环境变量：RJ_SBUS_PORT=COM5  RJ_SBUS_ID=1
```

## 许可

MIT
