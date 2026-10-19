# Servo Python API（独立发布）

面向外部开发者的 **三个独立** 总线舵机 Python 包。不包含 Face Console 前端/后端。

| 下载包 | 协议 | pip 包名 | import |
|--------|------|----------|--------|
| `scservo-python-api-0.1.1.zip` | 飞特 **SC** (`scscl`) | `scservo` | `from scservo import ScServoClient` |
| `stservo-python-api-0.1.1.zip` | 飞特 **ST** (`sms_sts`) | `stservo` | `from stservo import StServoClient` |
| `rjsbus-python-api-0.1.2.zip` | 锐捷 **RJ_SBUS** | `rjsbus` | `from rjsbus import RjSbusClient` |

## 安装

解压对应 zip 后：

```bash
pip install pyserial>=3.5
pip install scservo-0.1.1-py3-none-any.whl   # 或 stservo / rjsbus 的 whl
```

每个 zip 内含：`README.md`、`INSTALL.txt`、对应 `.whl`。

## 说明

- 三个包相互独立，按需只装一种协议即可
- 默认安全窗为机构中位 ±90°
- 使用前请关闭占用串口的其它程序
