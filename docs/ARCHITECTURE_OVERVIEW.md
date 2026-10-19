# FaceDEV 全工程架构总结

> 本文是对当前工程**已实现架构**的整体梳理与总结，覆盖前端 App、FaceDEV SDK、Python Tracking Service 三大形态，以及核心数据模型、数据链路、安全机制、构建分发体系与当前进度边界。
>
> 与现有文档的关系：`ARCHITECTURE.md` 侧重目录边界；本文侧重**实现层面的模块职责、数据流与设计决策**，可作为新成员的入门总览与团队回顾材料。

---

## 1. 项目是什么

FaceDEV 是一套**机器人面部舵机上位机系统**：以浏览器为运行环境（Web Serial API），驱动 24 路面部舵机（眉、眼睑、眼球、唇、嘴角、下颌、舌），支持：

- **手动面控**：Face Rig 控件拖拽 → 实时驱动舵机；
- **表情编排**：关键帧工程编辑与播放；
- **视觉跟踪**：摄像头 MediaPipe 面捕 → 实时驱动机器人脸；
- **机构标定**：嘴角五连杆（FiveBar）IK 在面部绑定主链路中标定与驱动；SC/ST 总线舵机在「串口与单舵机控制」中调校。

### 三种产品形态

| 形态 | 入口 | 职责 |
|------|------|------|
| **FaceDEV App** | `npm run dev` | 完整浏览器上位机（5 个页面，含 WebSerial 联调） |
| **`@facedev/sdk`** | `npm run build:sdk` + `pack:sdk` | 可嵌入其它 React 项目的库（`src/sdk` 打包为 7 个 ES 入口） |
| **Python Tracking Service** | `tools/tracking_service/` | MediaPipe 面捕服务，**只输出 `tracking.rigFrame`**，不控制舵机 |

---

## 2. 总体分层架构

```text
┌─────────────────────────────────────────────────────────────┐
│ 页面层  src/App.jsx + src/pages/                            │
│   control / frame / facerig / expression /                  │
│   trackingPreview                                           │
├─────────────────────────────────────────────────────────────┤
│ React 组件 / Hook 层  src/sdk/react/ + src/hooks/           │
│   FaceBindingEditor、FaceExpressionEditor、FaceTrackingPanel│
│   useFaceRigInteraction、useTrackingPreview*                │
├─────────────────────────────────────────────────────────────┤
│ SDK 子域层  src/sdk/                                        │
│   core(引擎) │ binding │ expression │ protocol │            │
│   kinematics(五连杆) │ tracking │ trackingPreview │ output  │
├─────────────────────────────────────────────────────────────┤
│ 领域核心层  src/core/（无 React 依赖）                       │
│   faceRigProfile │ faceDofMapper │ servoConfig │            │
│   servoProtocol │ frameProject │ actionPlayer               │
├─────────────────────────────────────────────────────────────┤
│ 物理 I/O 层                                                  │
│   webSerial（PWM 文本协议）│ scServoTransport（SC/ST 总线） │
└─────────────────────────────────────────────────────────────┘
        ▲ WebSocket（tracking.rigFrame）
┌─────────────────────────────────────────────────────────────┐
│ Python Tracking Service  tools/tracking_service/            │
│   摄像头 → MediaPipe FaceLandmarker → 映射 → RigFrame       │
└─────────────────────────────────────────────────────────────┘
```

**依赖方向自上而下**；`webSerial` / `scServoTransport` 不理解 Rig、Binding、Keyframe，只接收已拼好的命令；`sdk/core`、`binding`、`expression`、`protocol`、`tracking` 等计算层**零 WebSerial 依赖**。

---

## 3. 核心数据模型

整个系统围绕几个关键数据结构流转，是理解架构的钥匙：

### 3.1 Elite Rig State（面控状态）

`src/core/faceDofMapper.js` 的 `createInitialEliteRig()`，嵌套结构与 UI 控件一一对应：

```text
browL/R:  { tip, mid, tail }     // signed100 (-100..100)
eyeL/R:   { up, lo }             // 眼睑
sharedRadar: { x, y }            // 双眼共同视线，percent 0..100，(50,50) 正视
mouth:    { UL, UR, LL, LR,      // 唇四轴 signed100
            sideL: {x,y}, sideR: {x,y} }  // 嘴角 pad，percent
tongue:   { val }
jaw:      { val }                // 下颌（常用负半轴）
```

经 `rigValuesFromEliteRig()` 扁平化为 19 个控件通道（`brow_l_tip.value`、`eye_xy.x/y`、`mouth_corner_r.x/y`…），供绑定层消费。语义契约见 `FACE_RIG_SEMANTIC_CONTRACT.md`。

### 3.2 RigFrame（Tracking 协议帧）

WebSocket 消息 `tracking.rigFrame`（`docs/TRACKING_PROTOCOL.md`）：

- 必选：`type`、`source`、`timestampMs`、`faceDetected`、`quality`、`rig`（结构同 Elite Rig）；
- 可选：`debug`（blendshapes、mapping 中间量、gaze、lipGeometry、jawGeometry、mouthScenario 等，**只用于诊断，不驱动舵机**）。

### 3.3 Face Rig Profile 与 Binding（绑定配置）

`src/core/faceRigProfile.js`（版本 2.1.0）：

```text
Profile: { version, controls[19], bindings[], ignoredControls,
           各类迁移版本号（bus / 左眼皮 / 下颌第二路 补丁标记） }

Binding: { bindingId, controlId, channel,             // 输入端：控件通道
           servoId, actuatorKey, legacyServoIndex,    // 输出端：执行器（Bus 语义）
           neutralPwm, positiveTargetPwm, negativeTargetPwm,
           weight, curve(linear|smoothstep), enabled, rangeMode(full|custom) }
```

加载时自动执行迁移补丁：legacy 索引 → Bus actuatorId、左眼眼皮默认行程、下颌第二路禁用（`jawSecondaryBindingDefaults.js`，actuator profile 未配置时静默禁用避免每帧告警）。

### 3.4 logicalPose / actualPose

- **logicalPose**：`Record<servoId, 逻辑PWM>`，统一 500–2500、1500 为中位；**SDK 的核心输出，全工程编辑/存储统一空间**；
- **actualPose**：经 `logicalToActualPwm()`（机械零位 + 方向 + 限位线性映射）后的物理脉宽，**仅诊断**，下发前才转换。

### 3.5 Keyframe / 表情工程

`src/core/frameProject.js`：`{ keyframeId, name, durationMs, easing, positions: logicalPose, rigSnapshot?: EliteRig }`。`rigSnapshot` 是后加字段，使播放时可重走 `mapFaceRigToPose`（含五连杆 IK），旧关键帧无此字段是已知缺口。

### 3.6 Servo Config

`src/core/servoConfig.js`：24 路，每路 `{ servoId, direction, actualMin/MaxPwm, mechanicalZeroPwm, zeroOffsetPwm, protocol(pwm|scscl|sms_sts), busId, groupId... }`，localStorage 持久化。

### 3.7 FinalServoOutput（输出中间表示）

`src/sdk/output/buildFinalServoOutputsFromBindings.js` 产出的**协议无关**中间结构：按 `actuatorKey` 聚合的目标值 + 绑定来源 + 安全信息，之后才由 PWM / Bus adapter 翻译为具体协议。

---

## 4. 四条核心数据链路

### 4.1 手动面控链路（实时预览下发）

```text
Face Rig 控件 UI（FaceRigControls）
  → setEliteRigControlRaw → Elite Rig State
  → rigValuesFromEliteRig()
  → mapFaceRigToPose(rigValues, profile, configs, mouthFiveBarOptions)
      ├─ 逐绑定：channelRawToDriver → evaluateBindingLogical → contributions
      ├─ 同舵机多绑定：neutral + Σdelta 合并
      └─ 嘴角：五连杆 IK 覆盖 X/Y 直驱绑定（见 §5.4）
  → logicalPose（+ actualPose / contributions 诊断）
  → buildFinalServoOutputsFromBindings → FinalServoOutput[]
  → dispatchBindingWorkbenchOutputs
      ├─ PWM 模式：buildPwmCommandFromFinalOutputs → webSerial.writeText
      └─ Bus 模式：sendBusServoOutputs → scServoTransport
```

由 `useFaceRigInteraction`（`src/hooks/`）编排，绑定页与表情页共用；实时下发节流由 `realtimeTuning.sendIntervalMs` 控制。

### 4.2 Tracking 输入链路（视觉驱动）

```text
Python MediaPipe（tools/tracking_service）
  →（WebSocket JSON）createWebSocketTrackingAdapter
  → normalizeRigFrameMessage（trackingMapper.js：结构校验 + clamp，不做语义映射）
  → applyTrackingCalibration（前端帧间平滑：deadzone / EMA / 眉迟滞 / 眨眼稳定器）
  → previewRig（Elite Rig）
  → 与 4.1 同链路：mapFaceRigToPose → logicalPose → …
```

关键边界：**语义映射在 Python 侧完成**（blendshape/landmark → rig），前端 `trackingMapper` 只做数值边界与 debug 结构整理；前端校准（`trackingCalibration.js`）只做帧间平滑，与 Python mapping 解耦。

### 4.3 表情播放链路

```text
ExpressionEngine.playAll({ sendCommand })
  → playKeyframes → playKeyframe
    → buildKeyframeCommand（actionPlayer.js）
        ├─ 有 rigSnapshot：mapFaceRigToPose 重算（含五连杆）
        └─ 无：直接用 keyframe.positions
    → logicalToActualPwm 逐路 → buildMultiServoMoveCommand
  → sendCommand(cmd)   // 宿主注入，如 webSerial.writeText
```

### 4.4 Tracking Device Drive 链路（实机驱动 + 安全管线）

`useTrackingPreviewDeviceDrive`（`src/sdk/react/trackingPreview/`）按 `maxSendFps`（默认 25）定时执行：

```text
previewRig
  → applyLipRigDeadbandToRig（唇 rig 死区，|值|<5 → 0）
  → buildFinalServoOutputsFromBindings(sourceType: "tracking")
  → applyPwmDeadbandToFinalOutputs（按 jaw/lip/other 角色的 minPwmDelta 抑抖）
  → 分模式：
     ├─ PWM：buildMultiServoMoveCommand → webSerial.tryWriteText（忙则丢帧）
     └─ Bus：buildBusCommandsFromFinalOutputs
              ├─ applyActuatorTargetSafety（per-frame slew 限速，按角色 max delta）
              ├─ computeServoTargetFromLogical（profile 机械安全窗 + clamp）
              └─ sendBusServoCommands（single-write）→ commitActuatorSafetyStates
```

实机下发前还有**门控**（`evaluateDeviceDriveGates`）：必须 Arm、摄像头运行、串口已连、profile 就绪、`faceDetected` 且 `quality ≥ 0.5`，任一不满足即停发。

---

## 5. 模块详解

### 5.1 `src/core/` — 领域核心（无 UI）

| 文件 | 职责 |
|------|------|
| `faceRigProfile.js` | Profile/Binding 模型、规范化、默认 19 控件 + 24 绑定、行程工具、导入导出、加载时自动迁移补丁 |
| `faceDofMapper.js` | **映射中枢**：Elite Rig 状态、`mapFaceRigToPose`（绑定求值 + 五连杆覆盖）、关键帧 → Rig 反推 |
| `servoConfig.js` | 24 路配置、`logicalToActualPwm` 分段线性映射、localStorage |
| `servoProtocol.js` | PWM 文本协议拼装（`#000P1500T1000!`、`{...}` 多舵机、`$DST!` 等），纯函数 |
| `frameProject.js` | 单表情关键帧工程 CRUD 与持久化 |
| `actionPlayer.js` | 关键帧 → 命令 → 顺序播放 |
| `webSerial.js` | Web Serial 封装：`writeText`（阻塞）/ `tryWriteText`（忙丢帧），**唯一 PWM 物理 I/O** |

### 5.2 `src/sdk/core` + `binding` + `expression` + `protocol` — SDK 计算层

- **`createFaceRigBindingEngine`**：有状态绑定引擎，`setRigState → evaluate → getLogicalPose / getCommandPreview`，预览只读不写串口；
- **`createExpressionEngine`**：关键帧项目管理 + 播放控制（`sendCommand` 注入式）；
- **`binding/`**：profile 不可变操作套件（`bindingActions` 增删改/反向/设 neutral）、selector、行程诊断、actuator 字段对齐、Bus 语义迁移、眼/颌专项补丁与诊断；
- **`expression/`**：关键帧合并、查询、播放预览（薄封装 core）；
- **`protocol/`**：`buildServoMovesFromPose` / `buildServoCommandFromPose`，logicalPose → 命令字符串，**只序列化不发送**。

### 5.3 `src/sdk/output/` — 输出与安全层

绑定语义 → 协议无关中间表示 → adapter 的三段式：

| 文件 | 职责 |
|------|------|
| `buildFinalServoOutputsFromBindings.js` | 核心：Rig → `mapFaceRigToPose` → `FinalServoOutput[]` |
| `actuatorOutputSafety.js` | **slew 限速**：每帧每执行器最大位移（jaw 35 / lip 40 / eye 30…），跨帧记忆 last safe target |
| `trackingBusPipeline.js` | dry run / 诊断用管线封装：build → safety → commit → 命令预览 |
| `trackingBusPipelineState.js` | **双单例状态**：实机（device）与诊断（diagnostic）的 safetyState 隔离，互不污染 |
| `adapters/pwmOutputAdapter.js` | FinalOutput → PWM 多舵机文本命令 |
| `adapters/busServoOutputAdapter.js` | FinalOutput → Bus 命令（含 clamp、slew、profile 限位、发送） |
| `resolveActuatorProfile.js` 等 | Bus actuator profile 查表 / 加载 |

### 5.4 `src/sdk/kinematics/` — 嘴角五连杆

嘴角 pad（`mouth_corner_l/r` 的 x/y）**不直接 1:1 驱动两个舵机**，而是：

```text
Pad(x,y) → Pad→D 点映射 → 五连杆 IK（fivebarIkAllCandidates + 最近解）
        → 双关节角 → angleToBindingLogicalPwm → 覆盖原 X/Y 绑定的舵机贡献
```

分层：`fiveBar2d.js`（FK/IK 数学内核）→ `mouthCornerFivebar.js`（机构参数 + 滤波）→ `mouthCornerKinematics.js`（正式链路入口，在 `mapFaceRigToPose` 内做覆盖）→ `right/leftMouthFiveBarRuntime.js`（localStorage 校准 baseline，**唯一参数源**）→ 绑定页中位/行程标定 + 调试可视化。

五连杆需跨帧状态（`qPrev`、`lastOk`），引擎与 hook 各持一份，profile 变更时重置。Lab 标定出的 baseline 写 localStorage 后，手控 / Tracking / 关键帧播放统一读取。

### 5.5 `src/sdk/tracking/` + `trackingPreview/` — 跟踪输入与预览

- **`tracking/`**：`createWebSocketTrackingAdapter`（含 FPS/延迟滑窗统计）、`trackingMapper`（归一化）、`trackingCalibration`（deadzone/EMA/眉迟滞）、`eyeReleaseStabilizer`（眨眼/松眼状态机）、`diagnostics/trackingDiagnosticRecorder`（**全链路按帧录制**：MediaPipe → Mapping → Rig → Binding → Device 命令，导出 JSON 可选 gzip）；
- **`trackingPreview/`**：纯函数层——`buildTrackingDryRunResult`（不写串口的"若下发会怎样"）、`buildTrackingBusDryRunResult`（叠加 bus 管线 + slew）、`mapTrackingPreviewPose`（热路径轻量映射）、`evaluateDeviceDriveGates`（门控）、回中工具、常量。

三种 Drive Mode：**Preview Only**（只更新画布）→ **Dry Run**（命令预览）→ **Device Drive**（实机，需 Arm + 多重门控）。

### 5.6 `src/sdk/servoAdapters/` — 舵机协议适配

| 协议 | 适配器 | 说明 |
|------|--------|------|
| `scscl` | `ScsclAdapter` | Feetech SC 系列总线，**主链路**，0–4095，SyncWrite |
| `sms_sts` | `SmsStsAdapter` | ST/SMS/STS 系列，最小兼容 |
| `pwm` | `PwmServoAdapter` | 传统 PWM 文本协议，旧链路保留 |

含 `ScServoWebSerialTransport`（全局 `scServoTransport`，与 PWM 的 `webSerial` **双串口并行**）、profile 数学（logical 0–1000 → position、机械安全窗）、面部总线路由。协议常量参考仓库内 `STServo_Python/`（Feetech 官方 Python SDK 拷贝，仅作协议文档对照与桌面调试，**不是运行时依赖**）。

### 5.7 React 层与页面

App 用本地 state 切换 5 页（无 Router）：

| 页面 | 职责 | 主要组件/Hook |
|------|------|---------------|
| 串口与单舵机控制 | 双串口连接、日志、24 路配置与单舵机调校 | `SerialPanel`、`ServoControlPanel` |
| 动作帧编辑与预览 | 底层关键帧时间轴编辑/播放 | `FrameEditor` |
| 面部绑定 | Profile 编辑、控件→舵机绑定工作台、输出诊断 | `FaceBindingEditor` + `useFaceRigInteraction` |
| 表情编排 | 面控 + 关键帧 + Tracking 一体化创作 | `FaceExpressionEditor` |
| 追踪预览 | Camera/Video/Motion Track、Dry Run、Device Drive | `TrackingPreviewPage` + `useTrackingPreview*` |

**页面职责硬约束**：五杆标定与单舵机调校不得堆进表情编排页或 Tracking Preview 页。

全局状态：`App.jsx` 持 `servoConfigProject` / `frameProject` / `currentPose`；Face Rig profile 由 `useFaceRigInteraction` 自管（localStorage）。`src/state/` 目前仅占位。

### 5.8 Python Tracking Service（`tools/tracking_service/`）

```text
摄像头(OpenCV) → MediaPipe FaceLandmarker(blendshapes + 478 landmarks)
  → mediapipe_result_to_rig()（mediapipe_to_rig.py）
      ├─ 眨眼/眼睑：blink blendshape + openBias
      ├─ 微笑：smile → mouth.sideL/R pad
      ├─ process_nose_anchor：头部运动证据
      ├─ classify_mouth_scenario：场景状态机（neutral_still / closed_head_turn /
      │   frontal_mouth_motion…），lip 与 jaw 共用 gate，防转头误触发
      ├─ apply_lip_geometry_drive：landmark 局部嘴坐标 → 唇四轴（抗漂移）
      ├─ apply_jaw_geometry_drive：嘴开度几何 → jaw.val（与唇解耦）
      └─ 眉 + 视线（iris landmark，眨眼期间冻结 gaze）
  → 可选 EMA 平滑 → tracking.rigFrame → WebSocket 广播（默认 :8766）
  另有 MJPEG 预览流（:8767，仅可视化）与 mock_tracking_server.py
```

映射参数集中在 `mediapipe_mapping.default.json`（neutral/gains/invert/deadzone/limits/gaze/brow/lipGeometry/jawGeometry/mouthScenario…），`mediapipe_mapping_config.py` 负责加载/规范化；支持 `--calibrate-neutral` 与运行中 `tracking.control` 消息（如 `setLipNeutral`）在线校准。**服务不生成舵机命令、不写串口**。

---

## 6. 安全与节流机制总览

实机驱动（尤其 Tracking Device Drive）采用**多层防护**，按链路位置排列：

| 层级 | 机制 | 位置 |
|------|------|------|
| 门控 | Arm + 串口 + 人脸 + quality≥0.5，不满足即停发 | `evaluateDeviceDriveGates` |
| Rig 输入 | 唇 rig 死区 | `applyLipRigDeadbandToRig` |
| 输出抑抖 | 按角色 min PWM delta 死区 | `applyPwmDeadbandToFinalOutputs` |
| 下发频率 | 统一节拍：`resolveTrackingSendDecision`（maxSendFps 限频 + stale-frame 跳过；Bus/PWM 共用，已取消 lip/jaw 分频与 same-command cooldown） | `DEVICE_DRIVE_DEFAULTS` + `resolveTrackingSendDecision` |
| 并发 | serial busy 丢帧 / pending 合并（`tryWriteText`） | `webSerial` |
| 速度限制 | per-frame slew 限速（按角色 max delta） | `actuatorOutputSafety` |
| 位置限制 | profile 机械安全窗 + clamp | `computeServoTargetFromLogical` |
| 状态隔离 | 实机 / 诊断双 safetyState 单例互不污染 | `trackingBusPipelineState` |

---

## 7. 关键架构原则（已落地的设计决策）

1. **logicalPose 是核心契约**：全工程编辑/存储统一逻辑 PWM（500–2500），下发前才转实际 PWM；`actualPose` 仅诊断。
2. **语义与实体分离**：MediaPipe 映射层只产**语义 rig**；舵机方向、极性、PWM 区间一律在 Binding 层处理，不在协议或映射层写死。
3. **Tracking 单一入口**：所有视觉源（Python/未来 Web MediaPipe/视频）统一收敛为 `tracking.rigFrame`，再走同一条 `normalize → calibrate → mapFaceRigToPose` 链路；Tracking 不直连舵机、不写关键帧。
4. **计算与 I/O 分离**：映射、协议拼装、dry run 全部可离线复现；`webSerial`/`scServoTransport` 是仅有的物理 I/O 点；SDK 计算层零 WebSerial 依赖，`sdk/react` 作为内部硬件联调 UI 允许直连。
5. **协议无关中间表示**：`FinalServoOutput` 解耦绑定语义与 PWM/Bus 协议，adapter 才碰协议字节。
6. **机构学覆盖而非替换**：五连杆 IK 在 `mapFaceRigToPose` 内**覆盖**嘴角 X/Y 直驱绑定的贡献，标定 baseline 经 localStorage 单一来源共享给所有链路。
7. **数据自带迁移**：profile/工程 JSON 带版本号，加载时自动执行 legacy→Bus、眼皮、下颌第二路等补丁，旧数据可平滑升级。
8. **诊断优先**：contributions、dry run、全链路诊断录制器、Mapping Debug Recorder 等贯穿各层——"先记录再调公式"是 mapping 调试方法论。
9. **对外契约收口在 `src/sdk`**：`src/core` 不承诺稳定 API；页面只做组合。

---

## 8. 构建与分发体系

| 命令 | 作用 |
|------|------|
| `npm run dev` / `build` / `preview` | 主 App 开发/构建/预览 |
| `npm run build:sdk` | library mode 构建 SDK → `dist-sdk/`（9 个 ES 入口，React external） |
| `npm run pack:sdk` | 生成可安装包目录 → `npm pack` → `facedev-sdk-<version>.tgz` |
| `npm run dist:release` | tgz + 文档 + 示例 + Python 源码组装外发 zip（自动过滤 node_modules/venv/模型等，含树形验收） |
| `npm run tree:clean` / `tree:docs` | 干净项目树打印 / 写入 `PROJECT_TREE.md` |

外发包结构与验收项见 `DISTRIBUTION_PACKAGING.md`；发布前人工回归清单见 `RELEASE_CHECKLIST.md`。

---

## 9. 当前进度与已知边界

### 已冻结 / 已完成

- 手动面控 → 绑定 → 双协议（PWM / SC 总线）下发全链路；
- 表情关键帧工程（含 `rigSnapshot`）与播放；
- 嘴角五连杆 **V1 冻结**（FK/IK、左右 runtime、Lab 标定、`mapFaceRigToPose` 覆盖）；
- Python MediaPipe 服务（眉/眼/视线/唇几何/颌几何/场景状态机）与 RigFrame 协议；
- Tracking Preview 页骨架与 Device Drive 安全管线（slew/死区/统一节拍/门控/状态隔离）；
- 全链路诊断录制与 dry run 体系；
- SDK 打包与外发 zip 流水线。

### 已知限制与未完成（按文档口径）

- **左嘴角硬件验收 blocked**（servo16 损坏），软件链路保留但无实机结论；
- 旧关键帧无 `rigSnapshot`，无法可靠重算五连杆；
- Tracking Preview Roadmap：4.0 骨架待正式验收，4.1（Camera 固化）/ 4.2（Video）/ 4.3（Motion Track v1）/ 4.4（Device Drive 正式启用）未完成；
- MediaPipe 映射为第一版，无前端 Mapping Editor（规划中）；
- 下颌第二路绑定在 actuator profile 配齐前默认禁用；
- `src/state/` 跨页状态收敛、`FramePreviewPanel` 遗留组件处置等待定。

---

## 10. 总结

本工程从"24 路舵机串口上位机"演进为一套**分层清晰的机器人面部驱动系统**：

- **向下**，以 `logicalPose` 与 `FinalServoOutput` 两层中间表示，把表情语义与 PWM/总线协议彻底解耦，并叠加了完整的实机安全管线；
- **向上**，以 Elite Rig + Binding Profile 把"面部语义"与"机械实现"分离，使五连杆这类复杂机构能以"覆盖"方式无侵入地接入；
- **向外**，以 `tracking.rigFrame` 单一协议收口所有视觉输入，Python 服务与前端职责边界明确（语义映射 vs 帧间平滑）；
- **工程化**上，具备 SDK 化打包、外发分发、数据版本迁移、全链路诊断录制等支撑能力。

后续重心（按路线图）是 Camera/Video Face Driver 的固化、Motion Track 录制回放、以及左嘴角硬件验收与 Device Drive 的正式启用。

---

### 延伸阅读

| 主题 | 文档 |
|------|------|
| 目录边界与数据流 | `ARCHITECTURE.md` |
| Face Rig 语义契约 | `FACE_RIG_SEMANTIC_CONTRACT.md` |
| Tracking 协议 | `TRACKING_PROTOCOL.md` |
| 五连杆 V1 冻结 | `MOUTH_FIVEBAR_V1_FREEZE.md` |
| Tracking Preview 路线图 | `TRACKING_PREVIEW_ROADMAP.md` |
| Python 服务 | `PYTHON_TRACKING_SERVICE.md` |
| Mapping 调试方法论 | `MAPPING_DEBUG_GUIDE.md` |
| SDK API 与快速开始 | `SDK_API.md`、`SDK_QUICK_START.md` |
| 打包与发布 | `DISTRIBUTION_PACKAGING.md`、`RELEASE_CHECKLIST.md` |
