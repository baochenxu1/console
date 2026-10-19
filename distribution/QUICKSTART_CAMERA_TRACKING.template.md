# 摄像头追踪发布版 — 快速开始

**版本标签**：`{{VERSION_LABEL}}`  
**适用场景**：在他人电脑上运行 **摄像头人脸追踪 + 前端预览**（Python MediaPipe → WebSocket → React Tracking Preview）。

解压后根目录名：`{{VERSION_LABEL}}/`

> **一键启动逐步说明**（解压 → 首次运行）：见 **[ONE_CLICK_START_GUIDE.md](./ONE_CLICK_START_GUIDE.md)**。

---

## 0. 压缩包内容自检

解压后应包含：

| 路径 | 说明 |
|------|------|
| `QUICKSTART.md` | 环境与协议总览 |
| `ONE_CLICK_START_GUIDE.md` | **一键启动逐步指南**（解压到首次运行） |
| `start-camera-tracking.bat` / `.ps1` / `.sh` | 一键启动 |
| `setup-camera-tracking.ps1` / `.sh` | 首次环境准备 |
| `src/` | React 前端源码 |
| `tools/tracking_service/` | Python 追踪服务 |
| `package.json` | 前端依赖清单 |
| `docs/` | 协议与架构文档 |

**不应出现**（若存在请退回构建方）：

- `node_modules/`、`.venv/`、`venv/`
- `face_landmarker.task`（体积大，需自行下载）
- `STServo_Python/`、`dist/` 构建缓存

---

## 1. 环境要求

| 组件 | 要求 | 用途 |
|------|------|------|
| **Node.js** | 18 或更高 | 前端 Vite 开发服务器 |
| **npm** | 随 Node 安装 | 安装前端依赖 |
| **Python** | **3.10 或 3.11**（推荐） | MediaPipe 追踪服务 |
| **浏览器** | Chrome / Edge | 打开前端页面 |
| **摄像头** | 系统可用 USB/内置摄像头 | 后端 OpenCV 采集 |

> MediaPipe 在 Python 3.12 上可能可用，但 **3.13+ 通常无法安装**。若 `pip install mediapipe` 失败，请换 3.10/3.11。

### 1.1 安装 Node.js（Windows）

1. 打开 https://nodejs.org/ ，下载 **LTS** 安装包。  
2. 安装时勾选 “Add to PATH”。  
3. 打开新的 PowerShell，验证：

```powershell
node -v    # 应 >= v18
npm -v
```

### 1.2 安装 Python（Windows）

1. 打开 https://www.python.org/downloads/ ，安装 **3.10.x 或 3.11.x**。  
2. 安装界面勾选 **“Add python.exe to PATH”**。  
3. 验证：

```powershell
python --version
pip --version
```

### 1.3 安装 Node.js / Python（macOS）

```bash
# 使用 Homebrew 示例
brew install node@20
brew install python@3.11
```

### 1.4 安装 Node.js / Python（Linux / Ubuntu 示例）

```bash
# Node（使用 nvm 示例）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 20
nvm use 20

# Python 3.11
sudo apt update
sudo apt install -y python3.11 python3.11-venv python3-pip
```

---

## 2. 下载 MediaPipe 模型（必须）

将 **`face_landmarker.task`** 放到：

```text
tools/tracking_service/models/face_landmarker.task
```

**官方下载地址**（若失效请以 [Face Landmarker 文档](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) 为准）：

```text
https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task
```

**Windows PowerShell 下载示例**：

```powershell
cd tools\tracking_service\models
Invoke-WebRequest -Uri "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task" -OutFile "face_landmarker.task"
```

**macOS / Linux**：

```bash
cd tools/tracking_service/models
curl -L -o face_landmarker.task \
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task"
```

未放置模型时，Python 服务会**报错退出**。

---

## 3. 首次环境准备（只需一次）

在**解压后的根目录**执行：

### Windows（推荐双击或 PowerShell）

```powershell
.\setup-camera-tracking.ps1
```

### macOS / Linux

```bash
chmod +x setup-camera-tracking.sh start-camera-tracking.sh
./setup-camera-tracking.sh
```

脚本会自动：

1. `npm install` — 安装前端依赖  
2. `python -m venv tools/tracking_service/.venv` — 创建 Python 虚拟环境  
3. `pip install -r tools/tracking_service/requirements.txt` — 安装 MediaPipe、OpenCV 等  

**手动安装（可选，与脚本等价）**：

```bash
# 前端
npm install

# Python
cd tools/tracking_service
python -m venv .venv

# Windows 激活
.venv\Scripts\activate

# macOS / Linux 激活
source .venv/bin/activate

pip install -r requirements.txt
cd ../..
```

---

## 4. 一键启动

环境准备完成后，在根目录：

### Windows

- **双击** `start-camera-tracking.bat`  
- 或在 PowerShell 中：

```powershell
.\start-camera-tracking.ps1
```

### macOS / Linux

```bash
./start-camera-tracking.sh
```

启动脚本会：

1. 检查 `node_modules`、`.venv`、模型文件；缺失时自动调用 setup  
2. 在新窗口/后台启动 **Python 追踪服务**（默认摄像头 0，WebSocket `ws://127.0.0.1:8766/tracking`）  
3. 等待端口 **8766** 就绪  
4. 启动 **Vite 前端** 并打开 `http://localhost:5173/?page=trackingPreview`

### 使用非默认摄像头

```powershell
# Windows
$env:TRACKING_CAMERA = "1"
.\start-camera-tracking.ps1
```

```bash
# macOS / Linux
TRACKING_CAMERA=1 ./start-camera-tracking.sh
```

---

## 5. 页面操作与验收

浏览器进入 **追踪预览** 页后：

1. 确认顶部 Tab 为 **Camera Preview**  
2. 点击 **Start Camera Tracking**  
3. 左侧应出现 MJPEG 画面（`http://127.0.0.1:8767/preview.mjpg`）  
4. 右侧 Face Rig 控件应随人脸运动  

| 检查项 | 期望 |
|--------|------|
| Python 窗口无报错 | 监听 8766 / 8767 |
| 状态栏 `faceDetected` | 对脸时为 true |
| FPS | 有稳定数值 |
| Drive Mode | 默认 **Preview Only**（不下发舵机） |

> 第一轮联调请保持 **Preview Only**，不要开启 Device Drive 或串口实时下发。

---

## 6. 手动分步启动（排障用）

若一键脚本异常，可分两终端手动启动：

**终端 1 — Python 后端**：

```bash
cd tools/tracking_service

# Windows
.venv\Scripts\activate
python mediapipe_tracking_server.py

# macOS / Linux
source .venv/bin/activate
python mediapipe_tracking_server.py
```

**终端 2 — 前端**：

```bash
npm run dev
```

浏览器打开：`http://localhost:5173/?page=trackingPreview`

---

## 7. 常见问题

| 现象 | 处理 |
|------|------|
| `pip install mediapipe` 失败 | 换 Python 3.10/3.11；不要用 3.13+ |
| 摄像头打不开 | `python mediapipe_tracking_server.py --camera 1` |
| MJPEG 黑屏但 WS 有数据 | 确认未加 `--no-preview-mjpeg` |
| 端口 8766 被占用 | 关闭旧进程，或 `--port 8768` 并同步改前端 WS URL |
| 页面连不上 WS | 先确认 Python 窗口已启动且无报错 |
| 浏览器无画面权限 | 本方案画面由 Python MJPEG 提供，**不需要**浏览器摄像头权限 |

---

## 8. 更多文档

| 文档 | 内容 |
|------|------|
| `tools/tracking_service/README.md` | 追踪服务详细说明 |
| `docs/PYTHON_TRACKING_SERVICE.md` | 映射参数、校准 |
| `docs/TRACKING_PROTOCOL.md` | WebSocket 协议 |
| `docs/ARCHITECTURE.md` | 整体架构 |

---

## 9. 构建方重新打包

在源码仓库根目录：

```bash
npm run dist:camera-tracking
```

产物：`dist/{{VERSION_LABEL}}.zip`
