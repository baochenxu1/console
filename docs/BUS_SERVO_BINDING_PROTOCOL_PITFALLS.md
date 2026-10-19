# 总线舵机 × 面部绑定：型号接入与下发踩坑手册

> 适用：新增舵机型号（协议 / 安全窗 / 中位语义）、面部绑定实时下发、与「舵机与串口控制」页对齐验收。  
> 背景：2026-09 Face Rig + RJ_SBUS 共总线联调中暴露的一组问题；修复后整理，避免下一型号再踩同一类坑。

---

## 1. 正确分层（不要拆掉）

```text
控件通道实时值 (−100…+100 / 0…100)
  → evaluateBindingLogical / 五杆 IK
  → 绑定逻辑 PWM（500–2500，存于 binding.*TargetPwm）
  → pwmToLogical → busLogical（0–1000）
  → resolveActuatorProfile（按 actuatorKey + 总线族择优）
  → computeServoTargetFromLogical(profile)   ← 型号安全窗只在这里夹紧
  → SC/ST write 或 RJ Host Motion + Batch TX
```

| 层 | 拥有什么 | 禁止做什么 |
|----|----------|------------|
| Binding | 表情行程端点（逻辑 PWM） | 把型号 `positionMin/Max` 写回 `positiveTargetPwm` |
| Actuator Profile | 协议、型号、`installed_center`、安全窗 | 用多数协议盲目压过当前 UI 总线族 |
| Adapter / TX | 实发 `targetPosition` | 把绑定 PWM 数字当成协议 ticks 直接发 |

**铁律：** 绑定卡片上的 **2500 ≠ RJ 发 2500 ticks**。满行程上极限典型换算：

`binding PWM 2500 → busLogical 1000 → RJ 实发 pos ≈ +900`（标准窗）。

对照文档：[BUS_SERVO_CENTER_POSITION.md](./BUS_SERVO_CENTER_POSITION.md)。

---

## 2. 已发生问题与根因（按优先级）

### 2.1 同 ID 多协议残留 → 绑定行程「远大于」舵机页 / **部分 ID 绑定不动**

**现象 A：** 舵机控制页拖 RJ 上限正常（约 ±900）；面部绑定一动就冲过大行程。

**现象 B（同根因变种）：** 只有某个 ID（常为 ID1）绑定有预览，ID2 / ID4 等在舵机页能动、面部绑定完全不动。

**根因：**

1. 同一 `busServoId` 下同时残留 **RJ + ST（常带 `installed_center`）**。  
   折叠 / 择优若**不带 UI 总线族 preferredProtocol**，ST 以 `installed_center` +1e6 分压过 RJ，文档里只剩 ST。
2. **舵机页** `useBusServoProfile` 会把 UI「主用总线族」强制写成 `protocol: rj_sbus` 再发包；  
   **面部绑定**旧逻辑却按**存储协议**组包 → 对 ID2/4 发出飞特帧，RJ 真机忽略。

**正确做法：**

1. `collapseProfilesToOnePerBusId` / `migrate` / `pickBest` 均传入 `preferredProtocolFromBusTransportFamily`。
2. `resolveActuatorProfile`：UI 主用 RJ 且存储非 RJ 时，覆盖为 `rj_sbus`（与舵机页一致），并提示重新保存中位。
3. 配置页对每路 RJ ID 执行一次保存 / 设中位，确保落盘协议就是 RJ。
4. 验收时看实发 `protocol` + `targetPosition`，不要只看绑定 PWM。

代码：`actuatorProfilePick.js`、`scServoLabStore.js`（collapse）、`resolveActuatorProfile.js`、`migrateLegacyBusProfilesToActuatorProfiles.js`。

---

### 2.2 新增绑定默认舵机号 0

**现象：** 清空绑定后「新增」看似成功，拖动完全不下发。

**根因：** 空闲号从 `0` 起选；总线 `isForbiddenBusId(id≤0)` 跳过；且 `servo_0` 常无 actuator profile。

**正确做法：** 新增绑定 **永不选用 ≤0**；优先占用 `loadActuatorProfiles()` 里已启用的 `busServoId`。

代码：`pickUnusedServoId` / `pickPreferredBindingServoId`（`bindingActions.js`）、`FaceRigBindingInspector`。

---

### 2.3 五杆控件：改 F/D 通道「测试位姿」≠ 实发变化

**现象：** 对眉尖 F/D 做端点硬预览时提示成功，舵机停在中位。

**根因：** `contributionExcludedForBrowFiveBar` 会丢掉 F/D 通道贡献，改由 tip XY → IK 写 PWM。只改 F 的 raw 仍按 tip 中位输出。

**产品结论：** **不要做「上/中/下极限硬预览」按钮。**  
标定应依赖：**开启实时预览 → 拖面部控件 → 看「控件实时值 / 本条逻辑脉宽」→ 写入行程。**

---

### 2.4 RJ `forceTimeMs = 0` → 实机不动

**现象：** 报文似已发，RJ 舵机无响应；或仅部分 ID 有跟手。

**根因：** 锐捷 CMD08 对 `time=0` 常表现为不执行；Host Motion 跟手若强制 0 会「看起来成功」。手动实时路径曾误用 `timeMs=0` + 默认 Motion（无 `forceTimeMs`），与追踪路径不一致。

**正确做法：** 实时跟手（手动拖控件 / 追踪）统一 `REALTIME_RJ_MOTION_CONFIG`（`forceTimeMs≥20`，`minSendIntervalMs` 对齐控制环）。见 `useFaceRigInteraction.pushToServo`。

---

### 2.5 RJ Host Motion `minSendInterval` defer

**现象：** 改方向后 ST 立刻动、RJ 偶发丢包。

**根因：** 默认 `minSendIntervalMs` 把改方向那一帧标成 `deferred`，上层若把 `ok:true`（deferredOnly）当成已发送会误报。

**正确做法：** 绑定方向/行程变更且实时预览开启时，走 `bindingPreview`（关闭 defer / 跳过 PWM delta），与滑条跟手路径对齐。

---

### 2.6 共总线 RJ@1M + ST：勿开双口分发

**现象：** 选 RJ 却把 ST 帧写到另一口，或双开互相抢口。

**正确做法：** 工程约定 **一条 UART、1M、开一次口、按协议切换报文**。  
门控用 `isSharedBusWireConnected` / `getSharedBusWireTransport`。

---

### 2.7 实时下发门控

**现象：** 拖控件无串口活动。

**检查清单：**

1. 顶部「实时预览」已开（会 Arm + `bus-servo`）。
2. 串口胶囊已 Open。
3. 绑定 `enabled`，舵机号 > 0，且存在匹配 actuator profile。
4. 右侧诊断 `finalServoOutputs` / `busBuilt.commands` / `skipped` 原因。

---

## 3. 新增舵机型号检查清单

接入新型号前，逐项打勾：

- [ ] **型号规格**：在 `servoMechanicalSafety.js` 增加 `SERVO_MODEL_SPECS`（`positionMin/Max/Center`、`logicalAngle*`、分辨率、协议）。
- [ ] **标准窗映射**：`logical 0/500/1000` → 协议位置端点/中位；与装配 0°～180° / 中位 90° 文档对齐。
- [ ] **`installed_center`**：读数符号域（RJ 可为 0/负）合法；安全窗不塌成单点。
- [ ] **normalizeLabServoProfile**：不会把新型号误归一成 SC/ST/CUSTOM 错误量程。
- [ ] **择优**：同 ID 多协议时，`preferredProtocolFromBusTransportFamily` 优先当前 UI 族；禁止「仅靠 installed_center 分」压过当前族。
- [ ] **TX 路径**：走 `computeServoTargetFromLogical` → 既有 adapter；禁止绑定层直接写协议 ticks。
- [ ] **跟手 time**：确认 time=0 / 过短时是否被驱动板忽略；必要时固定短时下限。
- [ ] **对照验收**：同一 ID，舵机页滑条 `logical=1000` 的 `targetPosition` **等于** 绑定满行程上极限经 adapter 后的 `targetPosition`。
- [ ] **文档**：更新 [BUS_SERVO_CENTER_POSITION.md](./BUS_SERVO_CENTER_POSITION.md) 型号表。

---

## 4. 面部绑定工作流（现行）

1. 舵机配置页：为每路建立正确协议的 profile，标定中位。
2. 面部绑定：选控件 → 新增绑定 → 舵机号对齐 profile ID（≥1）。
3. 开启 **实时预览**，拖动面部控件。
4. 卡片上对照 **控件实时值** 与 **本条逻辑脉宽**，再设上/中/下极限。
5. 改方向后依赖实时预览重发当前姿态（不是端点硬预览）。

**已移除：** 绑定卡片「预览 · 上极限 / 中位 / 下极限」硬下发。

---

## 5. 关键代码索引

| 主题 | 路径 |
|------|------|
| Profile 择优 / 总线族 preferred | `src/sdk/output/actuatorProfilePick.js` |
| Bus → Actuator 迁移 | `src/sdk/output/migrateLegacyBusProfilesToActuatorProfiles.js` |
| 逻辑→协议夹紧 | `src/sdk/servoAdapters/core/servoProfileMath.js` |
| 绑定 → Bus 命令 | `src/sdk/output/adapters/busServoOutputAdapter.js` |
| Face Rig 实时下发 | `src/hooks/useFaceRigInteraction.js` |
| RJ Motion / time | `src/sdk/output/rjHostMotionAdapter.js`、`src/hooks/realtimeTrackingTuning.js` |
| 新增绑定舵机号 | `src/sdk/binding/bindingActions.js`、`FaceRigBindingInspector.jsx` |
| 共总线 transport | `src/sdk/servoAdapters/busServo/resolveBusTransport.js` |
| 中位与安全窗约定 | `docs/BUS_SERVO_CENTER_POSITION.md` |

---

## 6. 自测入口（回归）

```bash
node src/sdk/output/actuatorProfilePick.rjPreferred.selftest.mjs
node src/sdk/binding/bindingActionsPickServo.selftest.mjs
```

新增型号后建议补一条：`logical 0/500/1000` → `targetPosition` 断言，并与舵机页滑条日志交叉比对。
