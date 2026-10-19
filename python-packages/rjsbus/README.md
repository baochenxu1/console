# RJ_SBUS Python API（锐捷）

独立包，仅依赖 `pyserial`。与 SC、ST 包分离，专用于 **Ruijie RJ_SBUS** 总线舵机。

## 安装

```bash
pip install pyserial>=3.5
pip install rjsbus-0.1.2-py3-none-any.whl
```

或解压本目录后：

```bash
pip install .
```

## 中位与映射

| 项 | 值 |
|----|-----|
| 模型铁律 | `logical 0～1000` ↔ 机构 **0°～180°** |
| 协议中位 | ticks **0**（有符号 0.1°） |
| 固定映射 | `0/500/1000` → **-900 / 0 / +900** |
| 默认写功率 | **600** |
| 默认波特率 | **115200** |

## 用法

```python
from rjsbus import RjSbusClient, logical_to_protocol_ticks

with RjSbusClient.open("COM5") as bus:
    print(bus.ping(1))
    bus.write_logical(1, 500)   # → 0
    bus.write_logical(1, 0)     # → -900
    bus.write_logical(1, 1000)  # → +900
    print(bus.read_angle(1))
    print(logical_to_protocol_ticks(500))  # 0
```

## API

`ping` / `scan` / `read_angle` / `write_logical` / `write_degrees` / `write_angle_ticks` / `go_zero`

## 许可

MIT
