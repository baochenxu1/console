# Feetech SC / ST Bus Servo (Python)

**独立包**：飞特 **SC (`scscl`)** / **ST (`sms_sts`)** 总线协议，仅依赖 **pyserial**。  
不依赖 Face Console 前端、Web Serial 或本 monorepo 其它目录。

## 安装

```bash
pip install pyserial>=3.5
pip install feetech_scservo-0.1.1-py3-none-any.whl
# 或：pip install feetech_scservo-0.1.1.tar.gz
```

开发模式（源码目录内）：

```bash
pip install -e ".[dev]"
pytest
```

## 中位与行程（必读）

| 坐标 | 含义 | 中位 | 工作区 |
|------|------|------|--------|
| **装配角（机构）** | 装机设计角 | **90°** | **0°～180°**（±90°） |
| **协议 position** | 线缆下发量 | 见下表 | 型号安全窗 |

| 协议 | 全量程（约） | 默认安全窗（position） | 协议中位 | 对应装配 90° |
|------|-------------|------------------------|----------|--------------|
| SC | 300° · 0～1023 | **205～819** | **512**（约 150°） | 机构 90° |
| ST | 360° · 0～4095 | **1024～3072** | **2048**（约 180°） | 机构 90° |

- 默认 `strict=True`：写入越界抛 `SafetyError`
- 标定：构造时传 `zero=`（position 值）重建以该点为中心的 ±90° 窗

## 用法

```python
from feetech_scservo import ScServoClient, PROTOCOL_SCSCL, PROTOCOL_SMS_STS

with ScServoClient.open("COM3", protocol=PROTOCOL_SCSCL, baudrate=1_000_000) as bus:
    print(bus.ping(1))
    print(bus.scan(0, 20))
    bus.go_zero(1)                      # 协议中位
    bus.write_position(1, 600, time_ms=200)
    print(bus.read_position(1))

with ScServoClient.open("COM3", protocol=PROTOCOL_SMS_STS) as bus:
    bus.write_position(1, 2048, speed=1000, acc=50)
```

标定安装中位后：

```python
bus = ScServoClient.open("COM3", protocol=PROTOCOL_SCSCL, zero=520)
```

## API

| 方法 | 说明 |
|------|------|
| `ping(id)` | 检测在线 |
| `scan(start, end)` | 区间扫描 |
| `read_position(id)` | 读当前 position |
| `write_position(id, pos, ...)` | 写目标（SC: `time_ms`；ST: `speed`, `acc`） |
| `go_zero(id)` | 写到协议中位 |

未默认开放：SyncWrite 广播、任意寄存器写、改 ID（请用专用工具或 Face Console 装机流程）。

## 测试

```bash
pytest tests/test_packet.py -v
```

## 许可

MIT
