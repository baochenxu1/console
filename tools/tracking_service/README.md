# Tracking WebSocket 服务（Mock + MediaPipe）

向浏览器推送统一 **`tracking.rigFrame`** JSON（与前端 `createWebSocketTrackingAdapter` / `normalizeRigFrameMessage` 兼容）。不含舵机协议、不涉及 binding profile。

默认 WebSocket 地址（Mock 与 MediaPipe **二选一**占用同端口）：

```text
ws://127.0.0.1:8766/tracking
```

---

## 第一轮联调：先看控件，不要开实时下发

**目标链路**：摄像头 → MediaPipe → WebSocket → 前端 Face Rig **控件**。

第一轮请**关闭**表情页工具栏里的 **「实时预览」**（以及任何会经 WebSerial **自动下发舵机** 的操作）。一旦同时下发，MediaPipe / WS / 控件 / binding / 串口等问题会混在一起，难以定位。

第一轮只确认两件事：

1. **Tracking 面板**里：`source`、`fps`、`quality`、`faceDetected` 是否合理。  
2. 打开 **Drive Rig** 后，**面控滑块/雷达**是否跟人脸动；**logicalPose** 是否随控件变（侧栏/调试里可见）。

**不要在第一轮做**：连接串口、依赖实时预览把命令打出、用「下发 Face Rig」做强验证（可留到第二轮）。

### 跑通步骤（推荐顺序）

**Step 1：准备 Python 环境**

```bash
cd tools/tracking_service
python -m venv .venv
```

Windows 激活：`.venv\Scripts\activate`  
Linux / macOS：`source .venv/bin/activate`

```bash
pip install -r requirements.txt
```

**Step 2：放置模型文件**

确认文件存在：

`tools/tracking_service/models/face_landmarker.task`

若缺失，`mediapipe_tracking_server.py` 会**直接报错退出**，属预期行为。下载说明见 [`models/README.md`](./models/README.md)。

> **Git**：`*.task` 默认已被根目录 `.gitignore` 忽略，避免大文件进库；克隆仓库后需在本地自行放置模型。

**Step 3：启动 Python MediaPipe 服务（Phase 3.0 多模态 / idle）**

推荐 **idle 模式**：后端启动时不占用摄像头，由映射预览页顶部 **Source** 切换 Camera / Video / Upload：

```bash
python mediapipe_tracking_server.py --source idle
```

等价于默认（省略 `--source` 即为 idle）：

```bash
python mediapipe_tracking_server.py
```

启动后日志应含：

- `ws://127.0.0.1:8766/tracking` — RigFrame WebSocket  
- `http://127.0.0.1:8767/api/tracking/source` — 前端切换输入源 REST API  
- `[SOURCE] idle — 等待前端 POST /api/tracking/source 切换`

**映射预览页流程**：Source → Camera（选设备）→ **Start** 开始追踪；**Stop** 停止并回 idle。Video / Upload 同理经 API 切换，无需重启 Python。

> **兼容 CLI 直开**：`--source camera` / `--source video --video-path …` 仍可用（调试或脚本），但日常联调请用 idle，避免与前端 Source 管理冲突。

非 0 号摄像头可在前端选择；CLI 直开时：

```bash
python mediapipe_tracking_server.py --source camera --camera 1
```

显式指定模型：

```bash
python mediapipe_tracking_server.py --model models/face_landmarker.task
```

正常时应监听：`ws://127.0.0.1:8766/tracking`。

**Camera 画面预览（Phase 4.1-D，双通道）**

| 通道 | 地址 | 用途 |
|------|------|------|
| WebSocket tracking | `ws://127.0.0.1:8766/tracking` | `tracking.rigFrame`、rig、mapping、fps |
| MJPEG preview | `http://127.0.0.1:8767/preview.mjpg` | 左侧 Camera Preview 画面（低帧率） |

默认启动时 **同时开启** MJPEG 预览（`--preview-mjpeg`，可用 `--no-preview-mjpeg` 关闭）：

```bash
python mediapipe_tracking_server.py
# 自定义预览帧率/质量
python mediapipe_tracking_server.py --preview-fps 12 --preview-quality 60
```

图像 **不会** 写入 WebSocket JSON；MJPEG 在独立 HTTP 线程按 `--preview-fps` 编码最近一帧，不阻塞 MediaPipe 主循环。

**Landmark / Mesh Overlay（Phase 4.1-E）**

在 MJPEG 帧上由 OpenCV 绘制追踪点（不进入 `tracking.rigFrame`）：

```bash
# 默认 regions：眼/唇/眉/脸廓分区轮廓
python mediapipe_tracking_server.py

# 完整网格 + 关键点 + 分区
python mediapipe_tracking_server.py --preview-landmark-style full

# 仅关键点（嘴角/眼/眉/下巴等映射相关点）
python mediapipe_tracking_server.py --preview-landmark-style minimal

# 显式开关覆盖 style 预设
python mediapipe_tracking_server.py --preview-draw-mesh --no-preview-draw-regions
```

**映射与调试（阶段 2.5）**

- 默认加载同目录 **`mediapipe_mapping.default.json`**；可用 **`--mapping <path>`** 指定其它 JSON。
- 可选 **`--save-mapping`**（默认写入 **`models/mediapipe_mapping.json`**）与 **`--calibrate-neutral`**：采集中性脸 30 帧后更新 `neutral` 并保存。
- 服务在 `faceDetected=true` 时可在 RigFrame 上附加 **`debug`**（`blendshapes` / `mapping`）；前端 **Tracking → MediaPipe Debug** 折叠区展示，不参与舵机。
- 实现模块：`mediapipe_mapping_config.py`、`mediapipe_to_rig.py`（`mediapipe_result_to_rig(result, config=None, gaze_state=None)` 返回 `{ rig, debug }`；WebSocket 服务传入持久 **`gaze_state`** 以实现眨眼冻结与 last valid gaze）。**`invert.jaw`**：强度取负写入 **`jaw.val` 负半轴**；**blink/smile/brow** 的 invert 为区间内反射。舵机方向建议在 **Face Rig Binding** 调整。详见 **`docs/PYTHON_TRACKING_SERVICE.md`**、**`docs/TRACKING_PROTOCOL.md`**。

**Step 4：打开前端表情编排（只看 Tracking 状态）**

路径：**表情编排 → Tracking 面板**：

- **输入源**：WebSocket  
- **URL**：`ws://127.0.0.1:8766/tracking`  
- 点击 **使用 WebSocket 输入**  
- 开启 **Tracking**（**暂不**开「实时预览」）  

本步验收：面板里 `source = python-mediapipe`，`running = true`，`fps` / `quality` 有读数，`faceDetected` 随人脸变化。

**Step 5：只开 Drive Rig（仍不开实时下发）**

开启 **Drive Rig**，观察面控：

- 张嘴 → **jaw**  
- 眨眼 → **eyeL / eyeR** 眼皮相关通道  
- 微笑 → **mouth sideL / sideR**  
- 抬眉 → **brow mid**（映射在 `mediapipe_to_rig.py` 当前版以 `browL.mid` / `browR.mid` 为主）  

再配合侧栏或现有逻辑确认 **logicalPose** 随控件变化。

### 第一轮验收（6 项全过即认为链路跑通）

| 检查项 | 期望结果 |
|--------|----------|
| Python 服务启动 | 不报错，监听 **8766**（及路径 `/tracking`） |
| 前端 WebSocket 连接 | `source = python-mediapipe` |
| 人脸检测 | 对脸时 **`faceDetected = true`** |
| Tracking FPS | **有稳定数值** |
| Drive Rig | Face Rig **控件**跟随人脸变化 |
| logicalPose | 随控件变化而更新 |

若以上成立，可认为 **Python MediaPipe → React Face Rig** 数据链已跑通；再在第二轮单独开 **实时预览 / 串口** 验证舵机与 binding。

虚拟环境与 `pip install` 的指令与 **Step 1** 相同，下文不再重复。

---

## 模型（仅 MediaPipe 服务需要）

将 **`face_landmarker.task`** 放到：

```text
tools/tracking_service/models/face_landmarker.task
```

说明与下载线索见同目录 [`models/README.md`](./models/README.md)。若文件缺失，`mediapipe_tracking_server.py` 会打印明确错误并退出。

---

## 1) 纯模拟数据（无摄像头）

```bash
python mock_tracking_server.py
```

- 定时生成正弦 RigFrame，`source: "python-websocket"`（历史命名，与 MediaPipe 真实源区分见下）。

---

## 2) MediaPipe 摄像头追踪（阶段 2.2）

```bash
python mediapipe_tracking_server.py
```

### 指定摄像头

```bash
python mediapipe_tracking_server.py --camera 1
```

### 指定模型路径

```bash
python mediapipe_tracking_server.py --model models/face_landmarker.task
```

### 其它参数

- `--host`（默认 `127.0.0.1`）
- `--port`（默认 `8766`）
- `--path`（默认 `/tracking`）
- `--interval`（默认 `0.033` 秒，约 30fps）
- `--width` / `--height`（默认 `640` / `480`；打开摄像头后设置采集分辨率请求值，实际以驱动为准）
- **`--camera-fps`**（默认 `30`）→ `CAP_PROP_FPS`
- **`--fourcc`**（默认 `MJPG`）→ `CAP_PROP_FOURCC`；传空字符串则跳过
- **`--buffer-size`**（默认 `1`）→ `CAP_PROP_BUFFERSIZE`
- **`--camera-backend`**：`auto` | `dshow` | `msmf`（Windows 下 `auto` 优先尝试 DirectShow）

### 推荐启动命令（阶段 2.8-H）

**低延迟优先**（`--interval 0` 不为循环加 sleep，仅受摄像头与推理耗时限制；CPU 高属正常）：

```bash
python mediapipe_tracking_server.py --interval 0 --broadcast-interval 0 --width 640 --height 480 --camera-fps 30 --fourcc MJPG --buffer-size 1
```

**稳定优先**：

```bash
python mediapipe_tracking_server.py --interval 0.02 --broadcast-interval 0 --width 640 --height 480 --camera-fps 30 --fourcc MJPG --buffer-size 1
```

**低性能设备**：

```bash
python mediapipe_tracking_server.py --interval 0.02 --broadcast-interval 0 --width 320 --height 240 --camera-fps 30 --fourcc MJPG --buffer-size 1
```

启动时会打印 **`[CAMERA]`** 请求/实际分辨率、FPS、FOURCC、后端与 buffer；`debug.performance` 中含 **`capReadMs` / `preprocessMs` / `sleepMs` / `totalPeriodMs` / `targetIntervalMs`** 等，便于区分摄像头阻塞与 `--interval` 限速。

### 低延迟联调（阶段 2.8）

为减轻 **WebTracking → 串口** 的排队感，建议：

1. **Python 推流更密**（机器与摄像头允许时）：

```bash
python mediapipe_tracking_server.py --interval 0.033
```

若 CPU 仍有余量，可尝试：

```bash
python mediapipe_tracking_server.py --interval 0.02
```

2. **摄像头分辨率**：`mediapipe_tracking_server.py` 支持 **`--width` / `--height`**（默认 **640×480**），打开设备后会 `cap.set(CAP_PROP_FRAME_WIDTH/HEIGHT)`。低延迟可尝试：

```bash
python mediapipe_tracking_server.py --interval 0.02 --width 320 --height 240
```

若 MediaPipe 识别质量下降，可改回 `--width 640 --height 480`。

3. **Gaze 眨眼冻结（阶段 2.8-B）**：`mediapipe_mapping.default.json` 中 **`gaze.freezeOnBlink`**、**`blinkFreezeThreshold`**、**`maxStepPerFrame`** 等：眨眼或 iris 几何不可靠时 **保持上一有效 sharedRadar**，避免眼球突然回中或跳变；gaze 短时不可用时 **默认保持 last valid**，不立刻回到 50/50。详见帧内 **`debug.gaze`**（`frozenByBlink`、`heldLastValid`、`limitedByMaxStep` 等）。

4. **性能诊断**：有人脸且含 `debug` 时，载荷中带 **`debug.performance`**（`captureMs` / `inferenceMs` / `mappingMs` / `broadcastMs` / `loopMs` / `fps`）。其中 **broadcast / loop / fps 为上一 WebSocket 发送周期测得**，与当前帧 capture～map 相差约一帧。控制台约 **每 2 秒** 打印一行 `[PERF]` 摘要。若 **FPS 长期低于约 10**，端到端延迟会非常明显，优先看 **`inferenceMs`** 是否占主导，并尝试降低分辨率或 `--interval`。

5. **前端**：表情编排页工具栏可设 **实时下发周期**（默认 40 ms）、**Drive Rig + 实时预览** 下对 MediaPipe 使用 **T=50 ms** 与 **minPWMΔ=3**（见应用内 Tracking 区说明）；**关键帧播放**仍使用各关键帧的 `durationMs`，不受影响。

6. **抖动**：本阶段以 **眨眼冻结 + maxStep** 为主；更细的 smoothing / minDelta 等后续再迭代。

---

## 前端连接与操作（速查）

与上文 **Step 4 / Step 5** 一致：**WebSocket URL** 填 `ws://127.0.0.1:8766/tracking` → **使用 WebSocket 输入** → **Tracking** → （第一轮结束后再考虑）**Drive Rig**。

- MediaPipe 服务：`source` 为 **`python-mediapipe`**。  
- Mock 服务：`source` 为 **`python-websocket`**。

本仓库 Python 服务**从不写串口**；实时舵机仅来自前端 **实时预览 / 下发** 等路径，第一轮请保持关闭以便隔离问题。

---

## 说明

- **Mock** 与 **MediaPipe** 默认同端口：**不要同时启动**两套服务。
- MediaPipe 服务在客户端断开时不退出，可重复连接。
- Ctrl+C：MediaPipe 服务会释放摄像头并退出。
