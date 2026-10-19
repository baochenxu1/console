# FaceDEV SDK API 摘要（0.2.0-beta）

本文描述 `@facedev/sdk` 常见入口；完整子路径见 `dist-sdk-package/package.json` 的 `exports`。

| 子路径 | 职责 |
|--------|------|
| `@facedev/sdk` | 聚合导出（推荐快速试用） |
| `@facedev/sdk/core` | BindingEngine、ExpressionEngine、五连杆 kinematics |
| `@facedev/sdk/binding` | 绑定纯函数（`bindingActions` / `bindingSelectors` / `bindingLimits`） |
| `@facedev/sdk/expression` | 关键帧工程工具 |
| `@facedev/sdk/protocol` | logicalPose → moves / command 字符串 |
| `@facedev/sdk/output` | **FinalServoOutput**、Actuator Profile、PWM/总线输出适配 |
| `@facedev/sdk/servo-adapters` | SC/ST/PWM 协议适配器、Profile 数学、WebSerial 传输（浏览器） |
| `@facedev/sdk/tracking` | RigFrame 协议、校准、WebSocket 适配器 |
| `@facedev/sdk/react` | 绑定/表情/Tracking React 工作台 |
| `@facedev/sdk/style.css` | SDK UI 样式 |

---

## 边界说明（0.2.0-beta）

1. **`logicalPose`**：绑定引擎核心输出，各舵机逻辑 PWM（500–2500，1500 中位）。
2. **`FinalServoOutput`**：`output` 层输出，含 logical / bus logical / target position 等，经 adapter 转为 PWM 文本或 SC SyncWrite。
3. **`logicalPose` ≠ 实际 PWM**：零位、方向、限位、总线 profile 由 `output` / `servo-adapters` 处理。
4. **WebSerial**：`servo-adapters` 的 `ScServoWebSerialTransport`、`useFaceRigInteraction`、`FaceExpressionEditor` 等含浏览器联调路径；**未连接时不阻塞** profile / 关键帧编辑。
5. **Python Tracking**：只产生 `tracking.rigFrame`，不写串口。
6. **MediaPipe 映射为第一版**；Tracking Preview 4.x 路线图部分能力仍在完善中（见发行说明）。
7. **本版本为 beta**：API 可能在小版本内调整；集成前请阅读 `RELEASE_NOTES` 中的已知限制。

---

## 数据流（推荐集成顺序）

```
RigState + BindingProfile
  → createFaceRigBindingEngine.evaluate()
  → logicalPose
  → buildFinalServoOutputsFromBindings()   // @facedev/sdk/output
  → buildPwmCommandFromFinalOutputs()      // PWM 文本
  或 buildBusCommandsFromFinalOutputs()    // SC/ST 总线
```

legacy 快捷路径（仍可用）：

```
logicalPose + configs
  → buildServoMovesFromPose / buildServoCommandFromPose   // @facedev/sdk/protocol
```

---

## createFaceRigBindingEngine

- **路径**：`@facedev/sdk`、`@facedev/sdk/core`
- **作用**：profile / rigState、evaluate、`logicalPose` / `actualPose` / contributions / warnings；绑定 CRUD；`getMovesPreview` / `getCommandPreview`（只读）。

---

## createExpressionEngine

- **路径**：`@facedev/sdk`、`@facedev/sdk/core`、`@facedev/sdk/expression`
- **作用**：表情工程、关键帧 CRUD、播放、`stop`；不直接依赖 WebSerial。

---

## Output 层（0.2.0 新增子路径）

- **路径**：`@facedev/sdk/output`
- **核心函数**：
  - `buildFinalServoOutputsFromBindings({ profile, rigState, configs, actuatorProfiles })`
  - `buildCenterFinalServoOutputs(...)` — 全中性输出
  - `loadActuatorProfiles` / `resolveActuatorProfile` / `migrateLegacyBusProfilesToActuatorProfiles`
  - `buildPwmMovesFromFinalOutputs` / `buildPwmCommandFromFinalOutputs`
  - `buildBusCommandsFromFinalOutputs` / `sendBusServoOutputs`（需已连接总线 transport）
- **绑定工作台**：`buildBindingWorkbenchState`、`dispatchBindingWorkbenchOutputs`（含可选 WebSerial 下发）

---

## Servo Adapters（0.2.0 新增子路径）

- **路径**：`@facedev/sdk/servo-adapters`
- **作用**：SCSCL / SMS_STS / PWM 协议；`createServoAdapter(protocol, { transport })`；Profile 数学（logical 0–1000、安装中位、安全窗）；Lab store / motion 辅助。
- **WebSerial**：`ScServoWebSerialTransport`、`scServoTransport` — **仅浏览器**；Node 宿主请自行注入 transport 或只用编解码/命令构建 API。
- **面部总线路由**：`FACE_BUS_SERVO_ROUTE`、`resolveBusServoProfile`

---

## Kinematics（经 core 导出）

- **路径**：`@facedev/sdk/core`
- 嘴角五连杆 V1 冻结配置、`mouthCornerFivebar` IK/FK、左右 runtime baseline（localStorage）、`buildMapFaceRigToPoseOptionsFromMouthRuntimes` 等。
- 详见 `docs/MOUTH_CORNER_FIVEBAR_V1_FREEZE.md`。

---

## Protocol（legacy _pose 路径）

- **路径**：`@facedev/sdk/protocol`
- `buildServoMovesFromPose` / `buildServoCommandFromPose` — 由 logicalPose 直接生成 PWM 多舵命令字符串。

---

## React 组件

- **路径**：`@facedev/sdk/react`

| 组件 / Hook | 作用 |
|-------------|------|
| `FaceBindingEditor` | 绑定工作台 |
| `FaceExpressionEditor` | 表情时间轴 + Tracking + 联调下发 |
| `FaceTrackingPanel` | WebSocket Tracking 控制 |
| `MappingDebugRecorder` | 映射观测 JSON/CSV 导出 |
| `ServoOutputInspector` | FinalServoOutput 检视 |
| `BindingWorkbenchOutputPanel` | 绑定页输出预览/门控 |
| `useFaceRigInteraction` | rigApi 工厂（与主 App 一致） |
| `useTrackingAdapterController` | Tracking 适配器生命周期 |

五连杆调试（可选）：`RightMouthFiveBarReachabilityOverlay`、`RightMouthFiveBarReachabilityDebugPanel`、`useRightMouthPadFiveBarDebug`。

---

## Tracking

- **路径**：`@facedev/sdk/tracking`
- `createWebSocketTrackingAdapter`、`createEmptyRigFrame`、`normalizeRigFrameMessage`、`applyTrackingCalibration`、`processTrackingFrame` 等。
- 协议：[TRACKING_PROTOCOL.md](./TRACKING_PROTOCOL.md)

---

## 样式

```javascript
import "@facedev/sdk/style.css"
```

---

## 0.2.0-beta 已知未完成项

以下能力在 App 内可用，但**不承诺**为稳定对外 API 或已完成验收：

- Tracking Preview 页 Device Drive 正式验收（4.4）
- Video / Motion Track 录制回放（4.2 / 4.3）
- 左嘴角实机验收（硬件 blocked）
- 部分 Mapping 参数 UI 与 SyncWrite 原子性优化

集成绑定 + 表情 + Python Tracking + PWM/总线下发主链可放心试用；遇问题请用 zip 内 `FEEDBACK_TEMPLATE.md` 反馈。
