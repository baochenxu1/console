# 一键启动脚本使用指南

**版本**：`{{VERSION_LABEL}}`  
**适用对象**：收到 `{{VERSION_LABEL}}.zip` 发布包、需要在他人电脑上**第一次**跑通摄像头追踪的同事。

本文只讲**从解压到首次成功运行**的完整路径，以及 `setup-*` / `start-*` 脚本的用法。环境背景与协议细节见同目录 **[QUICKSTART.md](./QUICKSTART.md)**。

---

## 1. 脚本说明

解压后，在**发布包根目录**（与 `package.json` 同级）可见以下文件：

| 文件 | 平台 | 作用 |
|------|------|------|
| `setup-camera-tracking.ps1` | Windows | **首次**安装 Node 依赖 + Python 虚拟环境 |
| `start-camera-tracking.ps1` | Windows | **每次**启动：Python 后端 + Vite 前端 |
| `start-camera-tracking.bat` | Windows | 双击启动（内部调用 `.ps1`） |
| `setup-camera-tracking.sh` | macOS / Linux | 同 `setup-camera-tracking.ps1` |
| `start-camera-tracking.sh` | macOS / Linux | 同 `start-camera-tracking.ps1` |

**推荐顺序**：

```text
解压 → 安装 Node/Python → 下载模型 → setup（仅首次）→ start（每次使用）
```

`start-*` 脚本在检测到缺少 `node_modules` 或 `.venv` 时，会**自动调用** `setup-*`；但**不会**替你下载 `face_landmarker.task`，模型必须事先放好。

---

## 2. 第一步：解压发布包

1. 将 `{{VERSION_LABEL}}.zip` 解压到任意目录。  
   示例：`D:\FaceDEV\{{VERSION_LABEL}}\`

2. 确认根目录结构（至少应存在）：

```text
{{VERSION_LABEL}}/
├── ONE_CLICK_START_GUIDE.md    ← 本文档
├── QUICKSTART.md
├── README.md
├── setup-camera-tracking.ps1
├── start-camera-tracking.ps1
├── start-camera-tracking.bat
├── package.json
├── index.html
├── src/
└── tools/
    └── tracking_service/
        ├── mediapipe_tracking_server.py
        ├── requirements.txt
        └── models/
            └── README.md
```

3. **后续所有命令**均在此根目录执行（除非特别说明进入子目录）。

---

## 3. 第二步：安装系统环境（解压后、跑脚本前）

### 3.1 检查是否已安装

**Windows（PowerShell）**：

```powershell
node -v
npm -v
python --version
```

**macOS / Linux（终端）**：

```bash
node -v
npm -v
python3 --version
```

| 命令 | 期望结果 |
|------|----------|
| `node -v` | `v18.x` 或更高 |
| `npm -v` | 任意正常版本号 |
| `python --version` | `3.10.x` 或 `3.11.x`（推荐） |

任一命令提示「找不到」时，需先安装：

- **Node.js**：https://nodejs.org/ （选 LTS，安装时勾选加入 PATH）
- **Python**：https://www.python.org/downloads/ （选 3.10 或 3.11，Windows 勾选 “Add python.exe to PATH”）

安装完成后**关闭并重新打开**终端，再执行上表检查命令。

### 3.2 Windows 执行策略（仅 PowerShell 脚本报错时需要）

若运行 `.ps1` 时提示「无法加载，因为在此系统上禁止运行脚本」，在**以管理员身份**打开的 PowerShell 中执行一次：

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

然后重新打开普通 PowerShell，进入发布包根目录继续。

> 也可不改策略，直接使用 **`start-camera-tracking.bat`**（内部已带 `-ExecutionPolicy Bypass`）。

**中文 Windows 编码说明**：`setup-*.ps1` / `start-*.ps1` 脚本正文为**纯英文（ASCII）**，避免 PowerShell 5.x 误读 UTF-8 中文导致乱码和 `ParserError`。操作说明以本文档为准。

---

## 4. 第三步：MediaPipe 模型（默认自动下载）

`setup-*` / `start-*` 会在缺少模型时**自动从 Google 官方地址下载**到：

```text
tools/tracking_service/models/face_landmarker.task
```

首次运行时会看到：`Downloading face_landmarker.task (MediaPipe official)...`

**一般无需手动下载**（需能访问 Google 存储桶）。

### 手动下载（离线环境可选）

**Windows**：

```powershell
cd tools\tracking_service\models
Invoke-WebRequest `
  -Uri "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task" `
  -OutFile "face_landmarker.task"
cd ..\..\..
```

**macOS / Linux**：

```bash
cd tools/tracking_service/models
curl -L -o face_landmarker.task \
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task"
cd ../../..
```

### 禁用自动下载

```powershell
$env:TRACKING_SKIP_MODEL_DOWNLOAD = "1"
.\start-camera-tracking.ps1
```

### 构建方打入 zip（离线发行，约 +4MB）

```powershell
$env:CAMERA_TRACKING_INCLUDE_MODEL = "1"
npm run dist:camera-tracking
```

---

## 5. 第四步：首次环境准备（`setup-*`，只需一次）

在发布包**根目录**打开终端。

### Windows 方式 A — 双击 / 资源管理器

1. 在资源管理器中进入解压目录。  
2. 右键 `setup-camera-tracking.ps1` → **使用 PowerShell 运行**。  
3. 等待结束，窗口应显示「环境准备完成」。

### Windows 方式 B — PowerShell 命令（推荐）

```powershell
cd D:\FaceDEV\{{VERSION_LABEL}}
.\setup-camera-tracking.ps1
```

将路径替换为你的实际解压路径。

### macOS / Linux

```bash
cd /path/to/{{VERSION_LABEL}}
chmod +x setup-camera-tracking.sh start-camera-tracking.sh
./setup-camera-tracking.sh
```

### `setup-*` 会做什么

| 步骤 | 命令（脚本内部） | 产物 |
|------|------------------|------|
| 1 | `npm install` | 根目录 `node_modules/` |
| 2 | `python -m venv .venv` | `tools/tracking_service/.venv/` |
| 3 | `pip install -r requirements.txt` | MediaPipe、OpenCV 等 |

正常结束时终端最后几行类似：

```text
=== 环境准备完成 ===
下一步: 双击 start-camera-tracking.bat 或执行 .\start-camera-tracking.ps1
```

### 首次 setup 常见问题

| 现象 | 处理 |
|------|------|
| `pip install mediapipe` 失败 | 换 Python 3.10/3.11，不要用 3.13+ |
| `npm install` 很慢 | 检查网络；可配置 npm 镜像后重试 |
| 提示缺少模型 | 回到第 4 步下载 `face_landmarker.task` |

---

## 6. 第五步：第一次正式运行（`start-*`）

环境准备完成后，**每次**使用追踪功能都执行本步。

### Windows 方式 A — 双击（最简单）

双击根目录下的 **`start-camera-tracking.bat`**。

### Windows 方式 B — PowerShell

```powershell
cd D:\FaceDEV\{{VERSION_LABEL}}
.\start-camera-tracking.ps1
```

### macOS / Linux

```bash
cd /path/to/{{VERSION_LABEL}}
./start-camera-tracking.sh
```

### 使用非默认摄像头（可选）

若默认摄像头（索引 0）打不开，可指定索引 1：

**Windows**：

```powershell
$env:TRACKING_CAMERA = "1"
.\start-camera-tracking.ps1
```

**macOS / Linux**：

```bash
TRACKING_CAMERA=1 ./start-camera-tracking.sh
```

### `start-*` 会做什么

```text
1. 检查 node_modules、.venv、face_landmarker.task
      ↓ 缺失依赖时自动调用 setup-*
2. 新开窗口 / 后台启动 Python：
      mediapipe_tracking_server.py --camera 0
      → WebSocket  ws://127.0.0.1:8766/tracking
      → MJPEG      http://127.0.0.1:8767/preview.mjpg
3. 等待端口 8766 就绪（最多约 45 秒）
4. 启动 npm run dev，并打开浏览器：
      http://localhost:5173/?page=trackingPreview
```

**正常运行时你会看到**：

- **新弹出的 PowerShell 窗口**（Windows）：Python 追踪服务日志，**请保持打开**  
- **当前终端**：Vite 开发服务器日志，例如 `Local: http://localhost:5173/`  
- **浏览器**：自动打开「追踪预览」页面

---

## 7. 第六步：浏览器内操作（第一次验收）

页面打开后若未自动进入追踪页，手动访问：

```text
http://localhost:5173/?page=trackingPreview
```

按顺序操作：

1. 确认顶部 **Source** 为 **Camera Preview**（默认已是）。  
2. 确认 **Drive Mode** 为 **Preview Only**（默认已是，不会下发舵机）。  
3. 点击 **Start Camera Tracking**。  
4. 观察左侧 MJPEG 画面与右侧 Face Rig 控件是否随人脸移动。

### 第一次运行验收清单

| # | 检查项 | 期望 |
|---|--------|------|
| 1 | Python 窗口无红色报错 | 正在监听 8766 / 8767 |
| 2 | 浏览器左侧有摄像头画面 | MJPEG 预览正常 |
| 3 | 状态区 `faceDetected` | 对脸时为 `true` |
| 4 | FPS 有数值 | 大致稳定 |
| 5 | Face Rig 滑块/雷达 | 随表情变化 |

全部通过即表示**第一次运行成功**。

---

## 8. 停止与再次启动

### 停止

1. 在运行 `npm run dev` 的终端按 **`Ctrl + C`** 停止前端。  
2. 关闭 Python 追踪服务的窗口（Windows），或在 macOS/Linux 终端对后台进程 `kill`。  

### 再次启动（第二次及以后）

**无需重复 `setup-*`**（除非删除了 `node_modules` 或 `.venv`），直接：

```powershell
# Windows
.\start-camera-tracking.ps1
# 或双击 start-camera-tracking.bat
```

```bash
# macOS / Linux
./start-camera-tracking.sh
```

---

## 9. 脚本行为速查

| 场景 | 用哪个脚本 |
|------|------------|
| 第一次在这台电脑解压 | `setup-*` → `start-*` |
| 日常打开追踪 | 仅 `start-*` |
| 不想记 PowerShell 命令 | 双击 `start-camera-tracking.bat` |
| 换了电脑 / 删了 node_modules | 重新 `setup-*` |
| 只换了摄像头 | `start-*` + `TRACKING_CAMERA=1` |
| 模型没下载 | **先**第 4 步，再 `start-*` |

---

## 10. 排障：一键启动失败时

### 10.1 分步手动启动（确认是哪一侧出问题）

**终端 1 — 仅后端**：

```powershell
# Windows
cd tools\tracking_service
.\.venv\Scripts\activate
python mediapipe_tracking_server.py
```

```bash
# macOS / Linux
cd tools/tracking_service
source .venv/bin/activate
python mediapipe_tracking_server.py
```

**终端 2 — 仅前端**（另开终端，回到根目录）：

```bash
npm run dev
```

浏览器打开：`http://localhost:5173/?page=trackingPreview`

### 10.2 常见错误对照

| 错误信息 / 现象 | 原因 | 解决 |
|-----------------|------|------|
| 缺少模型文件 | 未执行第 4 步 | 下载 `face_landmarker.task` |
| 端口 8766 被占用 | 上次 Python 未关 | 关掉旧窗口或结束 python 进程 |
| 追踪服务 45 秒未就绪 | 摄像头/模型/依赖问题 | 看 Python 窗口具体报错 |
| 页面空白 / 无法连接 | 前端未起或端口不对 | 确认 `npm run dev` 在跑 |
| MJPEG 黑屏但 WS 有数据 | 预览通道异常 | 确认未手动加 `--no-preview-mjpeg` |
| `.ps1` 无法执行 | 执行策略限制 | 用 `.bat` 或见 3.2 节 |
| 脚本报 ParserError / 乱码 | PowerShell 5 编码问题 | 使用最新发布 zip（脚本已为 ASCII）；勿用记事本另存为 ANSI |

---

## 11. 与源码仓库的关系（维护者）

若在**未解压的 Git 仓库**内使用相同脚本，路径在 `release/` 子目录：

```powershell
# 仓库根目录
npm run setup:camera-tracking
npm run start:camera-tracking
```

发布 zip 内脚本位于根目录，命令为 `.\setup-camera-tracking.ps1` / `.\start-camera-tracking.ps1`（无 `release\` 前缀）。

---

## 12. 相关文档

| 文档 | 内容 |
|------|------|
| [QUICKSTART.md](./QUICKSTART.md) | 环境要求、协议、完整背景 |
| [tools/tracking_service/README.md](./tools/tracking_service/README.md) | Python 服务参数说明 |
| [docs/PYTHON_TRACKING_SERVICE.md](./docs/PYTHON_TRACKING_SERVICE.md) | 映射与校准 |
