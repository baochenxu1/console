# FaceDEV × Luvia — Physical Neck Connection Hotfix 完成报告

分支：`feature/neck-character-integration`（未新建分支）

## 1. 原来为什么只有 Bridge session 而没有 hardware connect

Cloud → Local Bridge 路径只建立了 **Browser ↔ Luvia Bridge**（`SESSION_ACTIVE` + health/caps/ws）。

FaceDEV 此前 **从未发送** `neck.connect`。Enable 只发 `neck.enable`，而 Luvia `enable_all()` / 0x32 循环依赖 **已打开的 SLCAN transport**。因此 Physical Debug 一直是：

- Connected / Enabled / Streaming = false  
- Transport channel = —  
- Command Loop Ticks = 0  

用户点击 Enable 看似无效，本质是 **Hardware 层未 connect**，不是 Timeline / target 坏了。

## 2. `neck.connect` 当前真实 schema（未重新发明）

Luvia `bridge/server.py` `_on_command`：

```text
type: "neck.connect"
channel: string   # COM 名；字段名是 channel，不是 port
virtual: bool     # 默认取 bridge config.virtual
id?: string       # 回写到 neck.connectResult
sessionId / sequence（FaceDEV 一并带上）

→ app.connect(channel=channel, virtual=virtual)
→ neck.connectResult { ok, virtual, reason?, id }
```

`neck.disconnect` → `app.disconnect()` → `neck.disconnectResult { ok, … }`。

## 3. Port discovery

- `LuviaApplication.list_ports()` **原本就有**（`SlcanCanFdTransport.list_channels()`）。
- Bridge **原先未暴露**。
- **唯一允许的小型 Bridge 补充**：`GET /v1/ports` → `{ ok, ports: string[] }`（仅语义端口名，无 raw serial / CAN config）。
- FaceDEV：`listHardwarePorts()` + UI「Refresh Ports」；**同时支持手动输入 COMxx**（列表失败时可继续）。

## 4. Hardware connection UI

`NeckBridgePanel` 区分两层：

| 层 | 含义 | 控件 |
|---|---|---|
| Runtime | Browser ↔ Bridge | Connect / Disconnect **Runtime** |
| Hardware | Bridge ↔ COM | Port + Connect / Disconnect **Hardware** |

Enable / Disable / ESTOP / Hold / Neutral 仍保留；**不改变 Face Rig layout**。

## 5. Enable gate UX

- Hardware 未连接时：Enable **disabled**，并提示 `HARDWARE_NOT_CONNECTED`。
- 若仍调用 `enable()`：返回 `false`，`lastErrorObj.code = HARDWARE_NOT_CONNECTED`（不再 silent fail）。
- **Connect Hardware 成功不自动 Enable**。

## 6. `hardwareExecutionEnabled` 真实语义

审计结论（按代码，非猜字段名）：

- 来源：`facedev_runtime.snapshot()` ← `hardware_execution_allowed(geom)`（math VALIDATED + CAD_VERIFIED + YAML `hardware_execution` ENABLED）。
- `set_external_target_pose` / EXTERNAL_DIRECT **不读取**该标志作为 TX 硬门。
- `enable_all()` 在 `open_loop_commissioning_mode` 下走 `_enable_open_loop_commissioning_exact()`，**也不因该标志拒绝**。
- 因此对当前 **EXTERNAL_DIRECT + COMMISSIONING_OPEN_LOOP**：它是 **production / CAD readiness diagnostic**，不是阻断 FaceDEV 真机 0x32 的 gate。
- **未**把 YAML `hardware_execution` 改为 ENABLED；**未**把 `productionReady` 改 true。

## 7. 是否触碰 production gate

**否。** 未改 `neck_geometry.yaml`、未伪造 `productionReady`、未改 IK / BM_HMD / CAN FD / SLCAN 实现。仅 Bridge HTTP 增加 `/v1/ports`。

## 8–11. 真机实测（需用户 Physical Debug 截图确认）

本回合交付的是 **连接契约 + UI + 自动测试**。真机四项验收仍由用户在本机完成：

1. Connected = true，channel = COMxx  
2. Enabled = true，Streaming = true  
3. Command Loop Ticks > 0  
4. 非零 pose 下 Last 0x32 变化  

建议顺序：**Connect Runtime → Connect Hardware → Enable → Neutral → 单轴小范围**（暂勿立刻播 Timeline）。

三轴 commissioning（P±2 / R±3 / Y±5）待硬件验收后再记结果。

## 自动测试

`src/core/neckPhysicalHardwareConnect.test.mjs`：A–J（含 schema、gate、connect/disconnect、ports、Timeline 未破坏）。

## Luvia 需重启 Bridge

部署 `/v1/ports` 后需 **重启** `python -m luvia.bridge`。FaceDEV 需重新 build/deploy（若用 staging）。
