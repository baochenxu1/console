# ST Servo Python API（飞特 ST / sms_sts）

独立包，仅依赖 `pyserial`。与 SC、RJ 包分离，专用于 **Feetech ST (SMS/STS)** 总线舵机。

## 安装

```bash
pip install pyserial>=3.5
pip install stservo-0.1.1-py3-none-any.whl
```

或解压本目录后：

```bash
pip install .
```

## 中位与行程

| 项 | 值 |
|----|-----|
| 装配中位 | 机构 **90°** |
| 协议中位 | position **2048**（约 180°） |
| 默认安全窗 | **1024～3072**（±90°） |
| 默认波特率 | **1_000_000** |

## 用法

```python
from stservo import StServoClient

with StServoClient.open("COM3") as bus:
    print(bus.ping(1))
    print(bus.scan(0, 20))
    bus.go_zero(1)
    bus.write_position(1, 2048, speed=1000, acc=50)
    print(bus.read_position(1))
```

标定安装中位：

```python
bus = StServoClient.open("COM3", zero=2100)
```

## API

`ping` / `scan` / `read_position` / `write_position` / `go_zero`

## 许可

MIT
