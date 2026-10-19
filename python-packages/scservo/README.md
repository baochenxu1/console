# SC Servo Python API（飞特 SC / scscl）

独立包，仅依赖 `pyserial`。与 ST、RJ 包分离，专用于 **Feetech SC** 总线舵机。

## 安装

```bash
pip install pyserial>=3.5
pip install scservo-0.1.1-py3-none-any.whl
```

或解压本目录后：

```bash
pip install .
```

## 中位与行程

| 项 | 值 |
|----|-----|
| 装配中位 | 机构 **90°** |
| 协议中位 | position **512**（约 150°） |
| 默认安全窗 | **205～819**（±90°） |
| 默认波特率 | **1_000_000** |

## 用法

```python
from scservo import ScServoClient

with ScServoClient.open("COM3") as bus:
    print(bus.ping(1))
    print(bus.scan(0, 20))
    bus.go_zero(1)
    bus.write_position(1, 600, time_ms=200)
    print(bus.read_position(1))
```

标定安装中位：

```python
bus = ScServoClient.open("COM3", zero=520)
```

## API

`ping` / `scan` / `read_position` / `write_position` / `go_zero`

## 许可

MIT
