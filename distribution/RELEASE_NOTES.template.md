# FaceDEV SDK 发行说明 — {{VERSION_LABEL}}

## 包内容

| 路径 | 说明 |
|------|------|
| `facedev-sdk-{{NPM_PKG_VERSION}}.tgz` | 本地可安装的 `@facedev/sdk` npm 包 |
| `docs/` | SDK 快速开始、API、Tracking 协议、Python 服务等 |
| `examples/basic-sdk-host/` | 最小宿主示例（依赖指向压缩包根目录下的 tgz） |
| `tools/tracking_service/` | Python Mock / MediaPipe WebSocket 服务源码（**不含** `face_landmarker.task`） |

## 版本信息

- **发行标签**：{{VERSION_LABEL}}
- **npm 包版本**（`package.json` version 字段）：{{NPM_PKG_VERSION}}
- **阶段**：**Beta** — 主链路可用，部分 Tracking Preview / 实机验收仍在完善

## 0.2.0-beta 相对 0.1.0-alpha 的主要变化

1. **新增 npm 子路径**：`@facedev/sdk/output`、`@facedev/sdk/servo-adapters`（共 9 个 ES 入口）。
2. **Output 层正式对外**：`FinalServoOutput`、Actuator Profile 加载/迁移、PWM 与 SC/ST 总线命令构建。
3. **Core 含五连杆 V1 冻结导出**：嘴角 IK/FK、runtime baseline API（见 `MOUTH_CORNER_FIVEBAR_V1_FREEZE.md`）。
4. **React 增补**：`ServoOutputInspector`、`BindingWorkbenchOutputPanel`、五连杆可达性调试组件等。
5. **文档**：`SDK_API.md` 重写，补充数据流与 beta 已知限制。

## 已知边界（Beta）

- SDK 核心语义输出为 **`logicalPose`** 与 **`FinalServoOutput`**，不等于下位机实际 PWM。
- `servo-adapters` / `sdk/react` 含 **WebSerial 浏览器联调**路径；Python 服务**不控制舵机**。
- MediaPipe → Rig 映射为第一版；Tracking Preview 4.1–4.4 路线图**未全部验收**。
- 左嘴角实机验收 blocked；SyncWrite 原子性、部分参数 UI 仍在迭代。
- **非 1.0 stable**：小版本内 export 名称可能微调；集成请锁定 tgz 版本号。

## 升级自 0.1.0-alpha

- 仍可从 `@facedev/sdk` 顶层 import 常用 API；若只需 logicalPose → PWM，可继续用 `@facedev/sdk/protocol`。
- 推荐新集成走：`bindingEngine` → `buildFinalServoOutputsFromBindings` → `buildPwmCommandFromFinalOutputs` / `buildBusCommandsFromFinalOutputs`。
- 业务 JSON（profile / frameProject / actuatorProfiles）版本迁移逻辑不变，加载时自动 patch。

## 反馈

请使用同目录 **`FEEDBACK_TEMPLATE.md`** 提交问题与集成场景。
