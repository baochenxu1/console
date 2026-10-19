# Python Tracking Service

Python 侧服务仅通过 WebSocket 推送 **`tracking.rigFrame`**，**不控制舵机、不写串口**。前端用 `createWebSocketTrackingAdapter` 订阅后，由 `FaceExpressionEditor` 等在「Drive Rig」时更新 Face Rig 状态，再经既有链路得到 `logicalPose` 与可选串口下发。

---

## 1. 环境准备

在仓库内：

```bash
cd tools/tracking_service
python -m venv .venv
```

**Windows（PowerShell / CMD）：**

```bat
.venv\Scripts\activate
```

**Linux / macOS：**

```bash
source .venv/bin/activate
```

安装依赖：

```bash
pip install -r requirements.txt
```

---

## 2. Mock WebSocket 服务

周期性发送模拟 `tracking.rigFrame`（含 jaw / mouth / blink 等周期变化），用于无摄像头时的前端联调。

```bash
cd tools/tracking_service
python mock_tracking_server.py
```

默认 WebSocket 地址：**`ws://127.0.0.1:8766/tracking`**（路径 `/tracking`）。

---

## 3. MediaPipe 跟踪服务

使用 OpenCV 读摄像头 + MediaPipe Face Landmarker，输出 `source: "python-mediapipe"` 的 RigFrame。

### 3.1 模型文件路径

将 **`face_landmarker.task`** 放在：

```
tools/tracking_service/models/face_landmarker.task
```

说明见同目录 `models/README.md`。

### 3.2 启动

```bash
cd tools/tracking_service
python mediapipe_tracking_server.py
```

同样默认 **`ws://127.0.0.1:8766/tracking`**。

### 3.3 映射配置（`mediapipe_mapping*.json`）

| 文件 | 说明 |
|------|------|
| `mediapipe_mapping.default.json` | 仓库默认映射（`neutral` / `gains` / `invert` / `deadzone` / `limits` / `smoothing` / **`gaze`** / **`eye`** / **`brow`** / **`lip`**）。 |
| `models/mediapipe_mapping.json` | 可选：本地覆盖或 **`--calibrate-neutral`** 写入的中性脸结果（若不存在则仅用默认或 `--mapping` 指定文件）。 |

**命令行参数：**

| 参数 | 默认 | 说明 |
|------|------|------|
| `--mapping <path>` | `tools/tracking_service/mediapipe_mapping.default.json` | 启动时加载的映射 JSON。 |
| `--save-mapping <path>` | `tools/tracking_service/models/mediapipe_mapping.json` | **`--calibrate-neutral`** 完成后写入 **neutral** 的保存路径。 |
| `--calibrate-neutral` | 关闭 | 启动后检测到人脸时连续采集 **30** 帧：对 **`extract_debug_blendshapes`** 中的键（含 **`eyeWide*`**、**`mouthUpperUp*`**、**`mouthLowerDown*`**、**`mouthPucker` / `mouthFunnel`** 等）求 **neutral** 平均；若该帧 **gaze（iris）可用**，同时累计 **neutral.eyeLookX / eyeLookY**（融合视线在 −1～1 空间的平均），最后写入 `--save-mapping`，然后继续推流。 |

调参方式：直接编辑 JSON 中的 **`gains.*`**、**`deadzone.*`**、**`limits.*`**；**`smoothing.enabled`** 默认 `false`，便于观察原始响应。

**视线 gaze（阶段 2.5-B）**：`gaze.enabled` 为 true 且模型输出 **≥478** 个 face landmarks（含 iris）时，Python 用 iris + 眼眶参考点估算双眼融合视线，写入 **`rig.sharedRadar`**，并在 **`debug.gaze`** / **`debug.mapping`**（`eyeLookX` / `eyeLookY` / `sharedRadarX` / `sharedRadarY`）中输出。不可用时 **`sharedRadar` 保持 50/50**、**`debug.gaze.available=false`**，不抛错。语义与限幅见 [FACE_RIG_SEMANTIC_CONTRACT.md](./FACE_RIG_SEMANTIC_CONTRACT.md)。方向微调优先 **`invert.eyeLookX` / `invert.eyeLookY`** 与 **Binding**，勿在协议层写舵机极性。

**眼 / 眉 / 唇（阶段 2.5-C）**

- **中性脸校准**：建议部署前执行 **`--calibrate-neutral`**，使 `neutral.*` 与操作者自然脸一致；否则 blink 基线偏高时仅靠默认 `neutral` 仍可能让眼睛偏小。
- **`eye`**：**`openBiasLeft` / `openBiasRight`**（默认约 **20**）、**`lowerLidOpenRatio`**（默认 **0.25**）、**`lowerLidCloseRatio`**（默认 **0.5**）与 blink 强度合成 **`rig.eyeL` / `rig.eyeR`** 的 **`up` / `lo`**；**`useEyeWide`** 默认 **false**（`eyeWide*` 仅进 **`debug.blendshapes`**）；若启用 **`useEyeWide`**，可按 **`eyeWideScale`** 将宽眼 blend 叠加到 **`eye*.up`**。**`limits.eyeOpen`** 默认 **[-100, 100]**，与眼睑控件 signed 范围一致。
- **`brow`**：**`midInnerWeight` / `midOuterWeight`**、**`leftTipChannel` / `leftTailChannel`**（及右侧）为 **`"tip"` / `"tail"`**：内侧强度写入 **`leftTipChannel`** 对应键，外侧写入 **`leftTailChannel`**，**`mid`** 为内外加权；对调通道名即可交换眉头/眉尾映射，无需改代码。
- **`lip`**：**`enabled`**、**`upperScale` / `lowerScale`**；**`puckerEnabled` / `funnelEnabled`** 默认 false，pucker/funnel **仅** 写入 **`debug.mapping`** 与 blend 调试。

**`invert.*` 语义（务必区分）**

| 键 | 行为 |
|----|------|
| **`invert.jaw`** | 先得到语义张嘴强度 **`s ∈ [limits.jaw]`**（常为 0～100），再写入 **`jaw.val = -s`（invert=true）或 `+s`（false）**，并 clamp 到 **[-100, 100]**（与前端 `jaw.val` 一致）。即 **0～100 的强度映射到 0～−100 的负半轴**，**不是**在同一区间内做 `100−s`（那会在「单向 jawOpen」下像「从满刻度往回减」，且与「强度取负」的直觉不一致）。 |
| **`invert.blink*` / `smile*` / `brow*`** | 仍在 **`limits.*`** 对应区间内做 **`min + max − v`** 反射，供后续 **0～100** 派生公式使用。 |
| **`invert.eyeLookX` / `invert.eyeLookY`** | 对 **减 neutral 后、deadzone/gain 之后** 的有符号视线分量取反（**非**单极反射），用于修正左右/上下与 Face Rig 语义相反的情况。 |

**约定**：**`invert.jaw`** 的默认值以 **`mediapipe_mapping.default.json`** 为准（当前为 **`true`**，张嘴强度写入 **`jaw.val`** 负半轴）。若实机舵机方向反了，优先在 **Face Rig Binding**（`positiveTargetPwm` / `negativeTargetPwm`）处理。修改后重启 Python 服务生效。

**不提供**前端 Mapping Editor（阶段 2.6 规划）；前端仅在 **Tracking 面板 → MediaPipe Debug** 折叠区展示 `debug.blendshapes` / `debug.mapping` / **`debug.gaze`**（见 [TRACKING_PROTOCOL.md](./TRACKING_PROTOCOL.md) §2.1）。

### 3.4 中性脸校准示例

```bash
cd tools/tracking_service
python mediapipe_tracking_server.py --calibrate-neutral
```

保持中性表情直至日志出现「校准完成」；若需保存到其它路径：

```bash
python mediapipe_tracking_server.py --calibrate-neutral --save-mapping ./my_mapping.json
```

---

## 4. 前端连接方式

1. 启动本仓库主应用或 `examples/basic-sdk-host`，打开 **表情编排** 页。
2. 在 Tracking 区域选择 **WebSocket**（或等价「使用 WebSocket 输入」），URL 填 **`ws://127.0.0.1:8766/tracking`**。
3. 开启 Tracking；若需控件跟随，再开启 **Drive Rig**。

---

## 5. 常见问题

| 现象 | 建议 |
|------|------|
| 连接失败 | 确认 Python 进程已启动、防火墙未拦截本机 `8766` 端口 |
| 无画面 / 无帧 | MediaPipe 服务需摄像头权限；检查 OpenCV 设备索引 |
| 动作与实机不符 | 调整 **`mediapipe_mapping*.json`** 中 gain / invert / neutral / deadzone，或使用 **`--calibrate-neutral`**；前端 Debug 区对照 `blendshapes` 与 `mapping` |

---

## 6. 与 SDK 的关系

- SDK **`@facedev/sdk/tracking`** 提供 `createWebSocketTrackingAdapter` 等，与上述服务协议一致。
- 协议字段详见 [TRACKING_PROTOCOL.md](./TRACKING_PROTOCOL.md)。
