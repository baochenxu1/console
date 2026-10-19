# SDK 边界与子路径

## 阶段 1.1 方向说明

- **`src/sdk/core`、`binding`、`expression`、`protocol`**：**不依赖 WebSerial**，作为相对干净的 SDK 计算与协议层，适合复用测试与日后对外收口。
- **`src/sdk/react`（尤其是 `FaceExpressionEditor`）**：当前视为**内部硬件联调组件**，**保留 WebSerial 真实下发**，用于封装后的整机/舵机验证。

**暂不实施**：不因「硬件解耦」把 `FaceExpressionEditor` 改为 transport / `WebSerial` 的 props 注入模式。

**若后续对外发布 SDK**：再将 `sdk/react` 中与串口强相关的路径改为宿主注入（`sendCommand` / `serial` 适配器等），彼时 `README` 与导出策略需同步修订。

硬件联调用例与勾选验收见：**[INTERNAL_HARDWARE_VALIDATION.md](./INTERNAL_HARDWARE_VALIDATION.md)**。

---

| 目录 | 职责 | WebSerial |
|------|------|-----------|
| `core/` | `createFaceRigBindingEngine`、`createExpressionEngine`、`types`；纯计算与状态编排 | ❌ |
| `binding/` | Profile 绑定不可变 Action / Selector / 限位工具 | ❌ |
| `expression/` | 关键帧工程 Selector、playback 适配、positions 合并等 | ❌ |
| `protocol/` | logicalPose → moves / command 字符串 | ❌（仅序列化，不发送） |
| `output/` | FinalServoOutput、Actuator Profile、PWM/总线输出适配 | ❌（下发函数需宿主 transport） |
| `servoAdapters/` | SC/ST/PWM 协议、Profile 数学、WebSerial transport | ⚠️ transport 为浏览器 |
| `react/` | 内部硬件工具 UI：`FaceBindingEditor`、`FaceExpressionEditor` 等；**含直连 WebSerial 的编排能力**（联调验证用） | ✅ 见 `FaceExpressionEditor` 等 |
| `tracking/` | Tracking 输入层：统一 RigFrame、`TrackingAdapter`、Mock/WebSocket 占位、校准占位 | ❌ |

## Tracking 输入层（阶段 2.0）

- **`TrackingAdapter` 的职责**：仅从底层源（Mock、MediaPipe Web、Python WebSocket）**产生 `tracking.rigFrame`（RigFrame）**；不向舵机写入协议。
- **RigFrame 驱动 Face Rig 控件**：上层（如 `FaceExpressionEditor` + `useFaceRigInteraction`）在「Drive Rig」开启且 `faceDetected` 时合并校准后更新控件 state，再走既有 **`rigValuesFromEliteRig` → `mapFaceRigToPose`**。
- **Tracking 不直连舵机**：不替代 `protocol`/`WebSerial`；不自动写入关键帧（仍由用户在编辑器操作）。
- **后续 MediaPipe / Python**：均需输出结构化一致的 **RigFrame**（`createEmptyRigFrame`/`normalizeRigFrameMessage`）。
- **WebSerial**：仍以现有 **`useFaceRigInteraction` 实时预览**、`pushToServo` 等为唯一真实下发链路；tracking 模块与 `src/sdk/core`、`binding`、`expression`、`protocol` 均保持 **零 WebSerial 依赖**。

导出：`createEmptyRigFrame`、`createWebSocketTrackingAdapter`、`createDefaultTrackingCalibration`、`applyTrackingCalibration`（见 `@/sdk/tracking` 或通过 `@/sdk` 顶层 `export *`）。

React：`FaceTrackingPanel`（表情页挂载；见 `@/sdk/react`）。

**阶段 2.1 / 2.2**：Python 侧服务见 **`tools/tracking_service`**（默认 `ws://127.0.0.1:8766/tracking`）：`mediapipe_tracking_server.py` 使用摄像头与 Face Landmarker，发送 **`source: "python-mediapipe"`** 等 RigFrame。前端在 Tracking 面板填写 **WS URL** 并「应用 WebSocket」，协议无需改 JSON 字段名。

---

## 顶层入口 `@/sdk`

已从 `vite.config.js` 与根目录 `jsconfig.json` 将 `@` 映射到 `src/`（供 `@/sdk` 等别名）。

聚合文件：`src/sdk/index.js`：对 `core`、`output`、`protocol`、`react`、`tracking` 为扁平导出；`binding` 与 `expression` 在顶层分别为命名空间。npm 包另提供 **`@facedev/sdk/output`**、**`@facedev/sdk/servo-adapters`** 子路径（0.2.0-beta+）。

---

## BindingEngine（最小）

```javascript
import { createFaceRigBindingEngine } from '@/sdk'

const engine = createFaceRigBindingEngine({
  configs: servoConfigsArray,
})

engine.setRigState(/* elite rig state */)
const result = engine.evaluate()
const preview = engine.getCommandPreview(500)

console.log(result.logicalPose)
console.log(preview.logicalPose)
console.log(preview.moves)
console.log(preview.command)
```

说明：

- **`getMovesPreview(timeMs)`** / **`getCommandPreview(timeMs)`**：只读预览，基于最近一次内部求值所用的 **logicalPose**；经 `@/sdk/protocol` 生成 **moves** 与 **`{…}` 协议帧**，**不写串口、不触发 WebSerial**。
- **`logicalPose` 为空**：返回空 **`moves`** / 空 **`command`**，warnings 中与 evaluate/configs 相关信息保留或追加说明。
- **真实下发**仍由页面、`useFaceRigInteraction`、`sdk/react` 等宿主路径完成。

诊断也可单独调用（不必先解构 `evaluate`）：`engine.getMovesPreview(500)` 内部会先 **`ensureEvaluate`**。

从 binding 命名空间微调 profile（返回新 profile，不就地修改）：

```javascript
import { bindingActions } from '@/sdk/binding'

let profile = engine.getProfile()
profile = bindingActions.addBinding(profile, { /* normalized fields */ })
engine.setProfile(profile)
```

---

## ExpressionEngine（最小）

```javascript
import { createExpressionEngine } from '@/sdk'
// 或等价：import { createExpressionEngine } from '@/sdk/expression'

const ex = createExpressionEngine({ project, configs: servoConfigs })
ex.setAmbientPose(currentPoseMergedFromHost)
ex.savePoseAsNewKeyframe({ name: '新帧', durationMs: 500, pose: logicalPoseOverlay })
ex.updateSelectedKeyframeWithPose(logicalPoseOverlay)

await ex.playAll({
  sendCommand: (cmdString) => yourSerialWriter(cmdString),
})
```

---

## React（最小）

```javascript
import { FaceBindingEditor, FaceExpressionEditor } from '@/sdk'
import { useFaceRigInteraction } from '@/hooks/useFaceRigInteraction.js'

// 面部绑定宿主：钩子提供 rigApi，编辑器负责布局与检视
const rig = useFaceRigInteraction(configs)
// <FaceBindingEditor configs={configs} rigApi={rig} realtimeThrottleMs={80} />

// 表情编排：与宿主 frameProject/currentPose props 对齐；内含 WebSerial 联调路径
// <FaceExpressionEditor configs={configs} frameProject={...} ... />
```

---

## `@/sdk` 与 `@/sdk/*` 映射表

| 需求 | 建议 import |
|------|-------------|
| 引擎与 types | `@/sdk` 或 `@/sdk/core` |
| 绑定纯函数套件 | `@/sdk/binding` |
| 表达引擎与同目录工具 | `@/sdk/expression` |
| 舵机命令串 | `@/sdk/protocol` |
| React 拼装件 | `@/sdk/react` 或 `@/sdk` |
