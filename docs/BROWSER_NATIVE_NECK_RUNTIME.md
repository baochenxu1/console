# Browser-Native Neck Runtime

**分支：** `feature/neck-character-integration`  
**主开发日：** 2026-09-07（R1 → R4.2）  
**本文档：** 合并原 R1～R4.2 / Software Neutral Calibration / R1 Checkpoint 多份 Completion 报告。

---

## 1. 目标与边界

在浏览器内建立与 Luvia 对齐的 Neck 控制栈：

```text
CharacterPose.neck
  → Pure Core（planNeckPose）
  → MotorCommand
  → MotorProtocol Adapter（默认 BM_HMD）
  → CanFrame
  → SLCAN Codec
  → WebSerialSlcanTransport（主线程）
```

**并行保留** Cloud / local **Luvia Bridge** 真机路径；默认 backend 仍为 `luvia-bridge`。Browser CAN 为可选 / 实验通路，真机 A/B 与长期验收通过前不切换默认、不删除 Bridge。

**明确不做 / 禁止：**

- 产品标定路径上的固件绝对零点（BM_HMD `0x39` / FLASH / Set Current as Motor Zero）
- CharacterPose / Timeline 插值公式改写、Face Rig / SC·ST·RJ 底层驱动改写
- Worker 内持有 `SerialPort`（不可 transfer，会抛 `DOMException`）

Luvia Python 仓库只读，作为 **REFERENCE + GOLDEN ORACLE**；JS 与 Python 不一致时修 JS。

---

## 2. 分层架构

| 层 | 目录 | 职责 |
|----|------|------|
| Pure Core | `src/sdk/neck/core/` | 几何 / IK·FK / mapping / safety / `planNeckPose`（纯函数，无 DOM/串口） |
| Protocol | `src/sdk/neck/protocol/` | MotorProtocol 契约、BM_HMD Adapter、CanFrame、Fake adapter、Registry |
| Transport | `src/sdk/neck/transport/` | SLCAN codec、WebSerial、写队列、framer、backend 枚举 |
| Runtime | `src/sdk/neck/runtime/` | Dedicated Worker 100Hz、Host、Enable/ESTOP/Watchdog |
| Calibration | `src/sdk/neck/calibration/` | 软件安装中性 trim + IndexedDB profile |
| Shadow | `src/sdk/neck/neckBrowserShadow.js` | 可选与 Bridge 并行诊断（默认 OFF） |

依赖方向冻结：

```text
Core ↛ Protocol / Transport
Transport/slcanCodec ↛ bmHmdProtocol
Transport ↛ CharacterPose / Timeline
```

---

## 3. R1 前 Checkpoint

开始 Browser-Native 前冻结已验证的 Bridge 真机基线：

- **Checkpoint commit：** `f1033d1`
- **Hardware baseline：** `a64211b`（Cloud → Luvia Bridge → physical neck）
- 当时覆盖：CharacterPose `{ face, neck }`、Bridge 连通、`neck.connect`、Target 门控、Physical Debug

策略：R1 起 Pure Core 先做 shadow / golden，不替换 Bridge。

---

## 4. 阶段一览

| 阶段 | Commit（短） | 内容 |
|------|--------------|------|
| R1 | `69e68a3` | Pure Core + Luvia pose golden |
| R2 | （含于协议栈） | BM_HMD + CAN FD + SLCAN 编解码 + protocol golden |
| R2.1 | `332944a` / tag `neck-r2-r21-checkpoint` | MotorProtocol / Transport 解耦 |
| R3 | `aa05a0b` | WebSerial → CANable → SLCAN 物理通路 |
| R3.1 | `d627d76` / tag `neck-r3-r31-checkpoint` | Hardware Backend UI 切换 |
| R4 | `0a5c5e3` | Worker 100Hz + Enable/Disable + Watchdog |
| R4.1 | `0f92f5c` | Software Neutral Calibration |
| R4.2 | `8a80b3a` | ESTOP Clear / 标定归属 / Profile 启动 / Backend 生命周期 |

---

## 5. Pure Core（R1）

**文件：** `math3.js`、`neckRuntimeProfile.js`、`neckGeometry.js`、`neckKinematics.js`、`neckHardwareMapping.js`、`neckSafetyCore.js`、`planNeckPose.js`

**NeckRuntimeProfile：** `semantic` / `geometry`（来自 Luvia `neck_geometry.yaml` 硬编码）/ `mapping`（side signs、motor IDs、`offsetDeg`、yaw、limits）/ `safety`（vmax=85°/s、amax=400°/s²、period=0.01s）/ `kinematics`。

**机械中位：** 默认 `offset1=offset2=0`；允许非零 trim。映射：`command = offset + sign * q` → signed raw（half-away-from-zero）。

**API：**

```js
planNeckPose({ pose, profile, previousState, applySafetyLimiter?, dt? })
→ { accepted, rejectReason, semanticPose, joints, motorTargets, diagnostics, nextState }
```

**Golden：** `scripts/generate-neck-luvia-golden.py` → `tests/fixtures/neck-luvia-golden-v1.json`（A–N + 1000 random，seed `20260907`）。IK/FK/branch/raw 与 Python 对齐。

**Shadow：** `createNeckBridgeClient({ browserCoreShadow: true })` 或 `FACEDEV_NECK_BROWSER_SHADOW=1`，默认 OFF，只写诊断不发硬件。

**Bench：** `node scripts/bench-plan-neck-pose.mjs`（约 ≫100 Hz）。

---

## 6. Protocol（R2 / R2.1）

**CanFrame：** `{ arbitrationId, isExtendedId, isFd, brs, data: Uint8Array }`。生产 TX：`isFd=true` 且 `brs=false`。

**BM_HMD：**

- `0x32` 位置：4× int16 BE，±1000
- `0x36` 位置模式；`0x38` ENABLE/DISABLE/CALIBRATE
- Feedback：`0x50+id` / `0x70+id` / `0xA0+id`（不伪造 temperature）

**SLCAN：** FD no-BRS 用 `d…`；打开序列冻结 `C → S8 → Y5 → M0 → A1 → O`（正式路径禁止仅 `O`/`L`）。

**解耦（R2.1）：**

- `MotorCommand` 不含 CAN ID / SLCAN
- `createBmHmdProtocolAdapter` 只产出 CanFrame
- Registry：`bm-hmd` / `fake`；未知类型绝不 fallback BM_HMD
- Classic CAN 仅 Fake 证明通路；BM_HMD + classic → `PROTOCOL_TRANSPORT_INCOMPATIBLE`
- `CanTransport` 契约：`open` / `close` / `sendFrame` / `onFrame` / `getState`

**Golden：** `scripts/generate-neck-luvia-protocol-golden.py` → `tests/fixtures/neck-luvia-protocol-golden-v1.json`（含 1000 组 0x32 random）。

**Pipeline：** `planNeckTransportCommand` = pose → planNeckPose → raw → 0x32 → slcanLine（无 I/O）。

---

## 7. WebSerial Transport（R3 / R3.1）

**文件：** `webSerialSlcanTransport.js`、`serialWriteQueue.js`、`slcanStreamFramer.js`、`webSerialCapability.js`、`mockSerialPort.js`、`neckHardwareBackend.js`

**串口配置（对齐 Luvia）：** 115200 8N1，无流控。Open 后跑上述 SLCAN 序列；写失败 cleanup → `ERROR`，永不伪 READY。

**FSM：** `CLOSED | OPENING | PORT_OPEN | SLCAN_INITIALIZING | READY | CLOSING | ERROR | DISCONNECTED`。

**安全烟测：** UI「Send Safe Disable」仅 READY + 显式点击；经 Adapter 编码，Transport 不 import BM_HMD。R3 阶段不自动 Enable/Move。

**Backend：** `luvia-bridge`（默认）| `browser-slcan`。一侧硬件占用时切换另一侧会冲突提示，**不自动抢占**。

**R3.1 UI：** 可切换 Hardware Backend；Browser CAN 隐藏 Bridge Runtime 连接，显示 Select/Open/Close/Safe Disable；Transport READY ≠ Motor Enabled。

**真机前：** 关闭占用同一 COM 的 `python -m luvia.bridge` / Luvia Qt 等。

---

## 8. Worker Runtime（R4）

**架构（强制）：**

```text
Worker：latestTarget + 10ms scheduler + planNeckPose + Adapter → CanFrame（postMessage）
主线程：permission / open / close / sendFrame + commandPriority 队列
```

100Hz **不**跑在 React timers。Missed tick **不追赶连发**。

**FSM：** `DISCONNECTED → TRANSPORT_READY → DISABLED → ENABLING → ENABLED → RUNNING / HOLD / STALE_SAFE_HOLD → ESTOP / ERROR`（另有 R4.1 的 `CALIBRATING_NEUTRAL`）。Open 后不自动 Enable。

**Enable 序列（对齐 Luvia open-loop commissioning，经 Adapter）：** Disable settle → 每轴 POSITION 模式 → user-zero 位置 → Enable → posthold。失败不进 ENABLED。

**ESTOP：** 最高优先；best-effort hold → DISABLE → latch。普通 Disable **不清** latch。

**Watchdog：** 主线程 ~100ms heartbeat；超时 → `STALE_SAFE_HOLD`（停动画 target，继续 100Hz hold；需 heartbeat + 显式 Resume）。

**断线：** → `ERROR`，清 enabled；插回**不**自动 reopen/enable。无 RX 时不伪造 actualPose。

---

## 9. Software Neutral Calibration（R4.1）

**产品规则：** 只 trim `mapping.side1.offsetDeg` / `side2.offsetDeg`。公式不变：`commandDeg = offsetDeg + sign * q`。

- Yaw **无**安装 offset UI
- 默认 0/0（非 Luvia 历史 `-10.5/-18`）
- 超限拒绝 `NEUTRAL_INSTALLATION_OFFSET_TOO_LARGE`（后期产品化可将绝对上限调至 30°，以代码 `neutralOffsetAbsDeg` 为准）
- IndexedDB：`facedev-neck-runtime-profile` / key `active`
- 标定中拒绝 Timeline target；允许 nudge / Save / Cancel / Reset / ESTOP
- **无**固件零点按钮

---

## 10. Runtime Hardening（R4.2）

- **Clear ESTOP：** `clearEstop()` → `ESTOP` → `DISABLED`，不自动 Enable；须显式 Clear
- 标定中 Hold/Resume/start/stop 返回 `CALIBRATION_ACTIVE`，不可逃逸
- 启动：`resolveStartupProfile()` → IndexedDB → 否则 DEFAULT 0/0
- Backend 切换：active（transport/enabled/calib/estop 或 Bridge HW connected）时拒绝
- Dirty 标定 + Disable 需 `discardUnsaved`；Transport lost 恢复 persisted，不自动 Save
- Safe Disable 使用 **active profile** 的 Adapter，不再临时 `createLuviaReferenceProfile()`
- Browser 语义限位来自 active profile；不向控件灌 Bridge `productionReady`

结论当时记为 **READY_FOR_UI_REFACTOR**（后续表情页产品化 UI 另见 Neck 产品接入相关文档）。

---

## 11. 关键源码树

```text
src/sdk/neck/
  core/           planNeckPose, geometry, kinematics, mapping, safety, profile
  protocol/       motorProtocol*, bmHmd*, canFrame, codec, planNeckTransportCommand
  transport/      webSerialSlcanTransport, slcanCodec, serialWriteQueue, framer, backend
  runtime/        browserNeckRuntimeHost, neckRuntime.worker, scheduler, enableSequence
  calibration/    softwareNeutralCalibration, neckProfileStore, importLuviaMappingYaml
  neckBrowserShadow.js
  neckPhysicalDebug.js
```

UI（历史 Bridge 面板路径）：`NeckBridgePanel.jsx`、`FaceExpressionEditor.jsx`（后续产品化控件见 `NeckExpressionControls.jsx`）。

---

## 12. 测试与脚本

```bash
# 分阶段
node --test src/core/neckBrowserRuntimeR1.test.mjs
node --test src/core/neckBrowserRuntimeR2.test.mjs src/core/neckBrowserRuntimeR21.test.mjs
node --test src/core/neckBrowserRuntimeR3.test.mjs src/core/neckBrowserRuntimeR31.test.mjs
node --test src/core/neckBrowserRuntimeR4.test.mjs src/core/neckBrowserRuntimeR41.test.mjs src/core/neckBrowserRuntimeR42.test.mjs

# R1–R4.2 回归（交付时约 199 pass）
node --test src/core/neckBrowserRuntimeR{1,2,21,3,31,4,41,42}.test.mjs

npm run build:faceconsole-web

node scripts/bench-plan-neck-pose.mjs
node scripts/bench-plan-neck-transport.mjs
# Golden 生成需本机 Luvia PYTHONPATH（只读）
python scripts/generate-neck-luvia-golden.py
python scripts/generate-neck-luvia-protocol-golden.py
```

环境变量（默认均 OFF）：

- `FACEDEV_NECK_BROWSER_SHADOW=1`
- `FACEDEV_NECK_BROWSER_PROTOCOL_SHADOW=1`

---

## 13. 实机验收备忘（用户侧）

Browser CAN 最小路径：

1. Hardware Backend = Browser CAN  
2. Select CAN Adapter → CANable（HTTPS / 用户手势）  
3. Open → Transport READY / slcanReady  
4. Load/确认 Profile → Enable（勿自动）  
5. 单轴小范围 → 需要时 ESTOP → Clear ESTOP → 再 Enable  
6. Close；插回不自动 Enable  

Timeline / 60s timing / 后台页 / Python vs Browser 观感 A/B：以实机 Physical Debug 为准；自动化只覆盖协议与生命周期。

---

## 14. 文档整理说明

以下历史单文件已合并入本文，仓库中删除以免重复维护：

- `FaceDEV_Neck_R1_Checkpoint.md`
- `FaceDEV_Browser_Native_Neck_Runtime_R1_Completion.md`
- `FaceDEV_Browser_Native_Neck_Runtime_R2_Completion.md`
- `FaceDEV_Browser_Native_Neck_Runtime_R2_1_Protocol_Decoupling_Completion.md`
- `FaceDEV_Browser_Native_Neck_Runtime_R3_Completion.md`
- `FaceDEV_Browser_Native_Neck_Runtime_R3_1_UI_Wiring_Completion.md`
- `FaceDEV_Browser_Native_Neck_Runtime_R4_Completion.md`
- `FaceDEV_Browser_Native_Neck_Software_Neutral_Calibration_Completion.md`
- `FaceDEV_Browser_Native_Neck_Runtime_R4_2_Hardening_Completion.md`

**未并入本文：** Neck Character / Cloud Bridge / Physical Connect / Target Dispatch / 表情页 Optional Neck UI 等产品接入文档（仍为独立 `FaceDEV_Neck_*` 报告）。
