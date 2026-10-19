# Mapping Debug 观察与记录指南

本指南对应 **FaceDEV 阶段 2.5-A**：在调整 MediaPipe → RigState 映射公式之前，先用 **Mapping Debug Recorder** 做人工观察与记录，避免「凭感觉改系数」导致方向与语义混乱。

## 为什么先记录，而不是马上调公式

- **Blendshape 与舵机没有一一对应**：同一组 ARKit/MediaPipe 系数可能同时影响多个控件；改一个 gain 可能牵连微笑、嘴角、下颌等多个通道。
- **问题可能不在映射层**：前端控件方向、绑定极性、PWM 区间与实体舵机方向都可能与「mapping 数值」不一致；若没有快照，很难复盘。
- **记录可复用**：导出 JSON/CSV 后可在评审、对表、回归时对照，比口头描述准确。

## 三层分离原则

调试时建议始终区分下面三层，并在记录的「预期说明」里写明你观察的是哪一层。

| 层级 | 含义 | 典型数据 |
|------|------|----------|
| **MediaPipe 原始层** | 模型输出的 blendshape 等原始量 | `lastFrame.debug.blendshapes` |
| **Face Rig 控件层** | 映射语义强度、原始 rig、校准后的 rig | `debug.mapping`、`rawFrameRig`、`calibratedRig` |
| **舵机绑定层** | 控件值如何变成 PWM、正负方向 | `logicalPose`、Face Rig Binding、`positiveTargetPwm` / `negativeTargetPwm` 等 |

## 记录中的 rig 与 pose（重要）

每条 **observation** 现在区分三类快照（兼容旧数据：若仅有 `rig` 而无 `calibratedRig`，读取时将 `rig` 视为 `calibratedRig`）：

1. **`rawFrameRig`**：最近一次 WebSocket 收到的 `tracking.rigFrame.rig`（协议归一化后、**未经**前端 `applyTrackingCalibration` 平滑/死区）。用于判断 **Python / 网络侧映射** 是否已把 blendshape 写进面控结构。
2. **`calibratedRig`**：记录瞬间 **Face Rig 编辑器中的当前 rig**（开启 **Drive Rig** 时，即为前端校准/平滑后的结果）。用于对照「原始帧」与「你看到的面控」是否一致。
3. **`logicalPose`**：绑定后的舵机逻辑姿态输出，用于对照 **Binding** 与实体方向。

CSV 导出列：`rawFrameRigJson`、`calibratedRigJson`、`logicalPoseJson`；另保留 **`rigJson`** 列（**deprecated**），语义与 `calibratedRigJson` 一致，便于旧脚本兼容。

## 重置追踪状态（平滑残留）

Tracking 面板提供 **「重置追踪状态」**：清空前端 **上一帧校准状态**（`previousCalibratedFrame`），并将 **当前面控 rig** 恢复为 **`createInitialEliteRig()`** 中性姿态。**不**停止 WebSocket、**不**自动下发舵机、**不**清空关键帧；**保留**最近一次 `lastFrame`（含 debug），便于继续看 MediaPipe 数值。

**建议每次记录新动作前点击一次**，避免嘴角等通道因 EMA/死区仍拖着上一动作的 `calibratedRig`。

**「清空追踪状态」** 与之不同：会停止适配器、清空适配器状态并关闭 Tracking，用于完全断开输入。

## 如何判断问题属于哪一层

1. **blendshape 异常**（例如张嘴时 `jawOpen` 仍接近 0）  
   → 优先怀疑 **采集 / MediaPipe / 摄像头与模型**。

2. **`rawFrameRig` 已正确**（嘴角等随微笑变化），但 **`calibratedRig` 有残留或与 raw 不一致**  
   → 优先怀疑 **前端 smoothing / calibration**（或记录前未点「重置追踪状态」）。可对比同一条记录内的 `rawFrameRig` 与 `calibratedRig`。

3. **`rawFrameRig` 不正确**（例如 mapping 在变但 raw 嘴角不动）  
   → 优先怀疑 **Python `mediapipe_to_rig` 映射** 或网络载荷是否被改写。

4. **`calibratedRig` 正确，但 `logicalPose` 与实体舵机不符**  
   → 优先使用 **映射预览页底部的 Servo Output Inspector** 检查 PWM 链路与重复 **servoId**、小行程、percent 小摆动等，再调整 **Binding**（极性、通道、PWM 区间），而不是反复改 mapping。

## 使用 Mapping Debug Recorder

1. 在 **FaceExpressionEditor** 中展开 **Mapping Debug Recorder**。
2. 需要时先点 **「重置追踪状态」**，再摆好动作。
3. 填写 **当前动作名称**、**预期说明**。
4. 保持 Tracking 运行，在动作稳定时点击 **记录当前帧**。
5. 需要时用 **导出 JSON / CSV** 存档；**清空记录**会同时清除浏览器 `localStorage` 中的缓存（键名：`facedev.mappingObservations.v1`）。

**blendshapes / mapping** 来自最近一次收到的 `tracking.rigFrame` 的 `debug` 字段。若未连接 Python 服务或帧内无 `debug`，对应字段可能为默认空值，属正常现象。

## 推荐记录的动作

建议按下列顺序各录 1～多帧，便于后续对照表一次性校准。

- 自然脸（中性）
- 张嘴
- 左眨眼 / 右眨眼
- 微笑
- 抬眉
- 嘟嘴
- 左右看（若协议中有对应 blendshape 或后续扩展）

## 记录表说明（与导出字段对应）

| 字段 | 说明 |
|------|------|
| `createdAt` | ISO 时间戳（UTC） |
| `actionName` / `expectedMotion` | 人工标注的动作名与预期 |
| `source` / `faceDetected` / `quality` | 当前追踪帧来源与质量 |
| `blendshapes` | 协议约定的 MediaPipe 原始键（含眼宽、唇 blend 等） |
| `mapping` | 服务端语义映射强度（含 jaw/blink/smile、brow 细分、唇、openBias、**眼睑 rig 镜像**、**仅调试** pucker/funnel、可选 **视线** 键） |
| `gaze` | **可选**：`debug.gaze` 快照（`available`、融合/分眼视线等）；无 iris 时可为 `null` |
| `rawFrameRig` | WebSocket 原始 `rig` |
| `calibratedRig` | 记录时编辑器当前 rig（Drive Rig 开启时为平滑后） |
| `logicalPose` | 绑定后输出 |

CSV 可含 **`gazeAvailable`、`eyeLookX`、`eyeLookY`、`sharedRadarX`、`sharedRadarY`** 列；另含扩展 **blend** 列（如 **`eyeWideLeft`**、**`mouthUpperUpLeft`** 等）及 **mapping** 列（**`eyeOpenBiasLeft` / `Right`、`eyeLUp` / `eyeLLo` / `eyeRUp` / `eyeRLo`**、眉 **tip/mid/tail**、**`upperLipLeft`** 等）。与 blend 同名的 **`mouthPucker` / `mouthFunnel`** 在 CSV 表头中为 **`mouthPuckerMapping` / `mouthFunnelMapping`**，以免与 blend 列冲突。完整 **`gaze`** 与 **`rawFrameRig.sharedRadar`** 在 JSON 导出中保留。

## Mapping Preview Page（阶段 2.6-A）

主应用顶部导航 **「映射预览」** 打开 **`TrackingMappingPreviewPage`**，用于串联观察：

**MediaPipe `debug.blendshapes` → `debug.mapping` → `rig`（rawFrameRig）→ 只读 Face Rig 控件**。

要点：

1. **映射预览页**用于对照原始 blend、映射中间量与面控数值，不涉及 **ExpressionEngine**、**关键帧** 或 **WebSerial** 下发。
2. 中间区域由 **`FaceRigPreviewCanvas`** 仅根据 **`lastFrame.rig`** 绘制控件，**不经过 Binding**，也**不生成 `logicalPose`**。
3. 若 **`rig` 与 blend/mapping 不符**，优先检查 **Python `mediapipe_to_rig.py`** 与网络载荷。
4. 若 **`rig` 看起来正确但实机舵机不对**，应优先使用 **Servo Output Inspector（阶段 2.7）** 检查 Face Rig → `logicalPose` → 实际 PWM 全链路，再结合 **Face Binding** 与串口链路排查，而不是在预览页改映射文件。

## Servo Output Inspector（阶段 2.7）

主应用 **映射预览** 页底部 **「Servo 输出诊断」** 使用与绑定页相同的 **`mapFaceRigToPose` / `logicalToActualPwm`**，对当前 **`lastFrame.rig`** 与 **本地已保存的 Face Rig profile**、**当前舵机配置** 做离线求值：

- **不经过 WebSerial**，不向实机下发指令。
- 可识别 **重复 servoId**、**正负行程过小 / 严重不对称**、**percent 通道在 50 附近时 PWM 变化过小**、**有 rig 输出但无启用绑定** 等风险。
- **Sweep Control**：对选定 `controlId.channel` 在 −100/0/+100 或 0/50/100 下扫一遍，观察各舵机 **actual PWM** 是否落在足够行程内。
- **当前帧表**：列出各 **servoId** 的合成 **logical / actual** 及相对 **中性 idle** 的 **Δ**，用于判断「MediaPipe 当前输出到底用了多少物理脉宽」。

**重要**：**`rawFrameRig` 正确不代表舵机输出正确**；percent 类通道（嘴角、眼球雷达等）在 **50 附近小幅摆动** 时，经绑定后 **PWM 可能只有十几微秒** 的变化，实机几乎不可见。若 UI 面控正常但实体异常，请优先打开本 Inspector 对照绑定表与 `rangeMode` / 重复 **servoId**。

Profile 与「面部绑定」页共用浏览器 **`loadFaceRigProfile()`** 存储；在绑定页保存后，回到映射预览可点 **「重新读取本地 profile」** 刷新诊断数据。

## Gaze 与性能（阶段 2.8-B）

- **眨眼期间 gaze 冻结**：Python 映射在 **`gaze.freezeOnBlink`** 开启时，若原始 **`eyeBlink*`** 或 **`debug.mapping` 的 blink 强度** 超过阈值，或 **iris 几何不可靠**（眼眶尺度过小），则 **不更新 `sharedRadar`**，保持 **上一有效 gaze**（**不**回到 50/50）。帧内查看 **`debug.gaze.frozenByBlink`**、**`heldLastValid`**、**`limitedByMaxStep`**、**`stable`**。
- **gaze 短时不可用**：同样 **保持 last valid**；仅尚无历史有效值时才回 **50/50**。
- **端到端 FPS**：若 **`debug.performance.fps`** 或工具栏 **py.fps** 长期 **低于约 10**，主观延迟会非常明显；用 **`inferenceMs` vs `captureMs`** 判断瓶颈。可配合 **`--width 320 --height 240`** 降低负载（可能略降识别稳定性）。
- **抖动**：更细的 smoothing / anti-jitter 后续迭代；当前可先依赖 **`maxStepPerFrame`** 与眨眼冻结。
- **调试**：映射 JSON 中 **`gaze.disableGuardForDebug": true`** 时旁路所有 gaze guard（冻结 / iris 门控 / hold / maxStep），仅用于确认 iris 路径是否正常；联调完请改回 **`false`**。帧内用 **`debug.gaze.freezeReason`**、`candidate*` / `emitted*` 对照排查。

---

更多协议与 Python 服务说明见 [TRACKING_PROTOCOL.md](./TRACKING_PROTOCOL.md)、[PYTHON_TRACKING_SERVICE.md](./PYTHON_TRACKING_SERVICE.md)。
