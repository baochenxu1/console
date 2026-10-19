# Servo Face Console / FaceDEV

基于 **Web Serial API** 的机器人面部舵机上位机（浏览器端）。提供 **24 路舵机**的串口通信、单舵机调校、以及 **单表情关键帧**编辑与播放。界面为中文；逻辑 PWM 统一为 **500～2500**，通过配置映射为实际控制 PWM。

本仓库同时包含 **FaceDEV SDK**（`src/sdk`）与 **Python Tracking Service**（`tools/tracking_service`）。详细文档见 **[docs/README.md](./docs/README.md)**；目录与数据流见 **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)**。

在仓库根目录执行 **`npm run tree:clean`** 可打印排除 `node_modules`、`dist*`、`.venv` 等后的项目树；**`npm run tree:docs`** 会更新 **`docs/PROJECT_TREE.md`**。

**发给外部的 SDK 压缩包**：在仓库根执行 **`npm run dist:release`**，生成 **`dist/facedev-sdk-v0.2.0-beta.zip`**（结构、验收项见 **`docs/DISTRIBUTION_PACKAGING.md`**）。

**Face Console 发布包**（基础面部控制 + 基础追踪展示 + 一键启动）：执行 **`npm run dist:faceconsole`**，生成 **`dist/FaceConsole-v0.6.2.zip`**。模型默认由 setup/start **自动下载**；离线打包可加 `CAMERA_TRACKING_INCLUDE_MODEL=1`。本版不包含 MediaPipe 录制学习数据集管线。

---

## FaceDEV：三种使用方式

### 1. 完整工具模式（内部调试）

含 WebSerial、面部绑定、表情编排、Tracking 等完整页面。

```bash
npm install
npm run dev
```

### 2. SDK 模式（嵌入其它 React 项目）

在仓库根目录构建并打包本地可安装的 `@facedev/sdk`：

```bash
npm run build:sdk
npm run pack:sdk
```

- 构建产物：`dist-sdk/`；可安装包目录：`dist-sdk-package/`（由 `scripts/prepare-sdk-package.mjs` 生成）。
- `npm pack` 会在当前目录生成 `facedev-sdk-<version>.tgz`。
- 快速开始与 API：[docs/SDK_QUICK_START.md](./docs/SDK_QUICK_START.md)、[docs/SDK_API.md](./docs/SDK_API.md)。
- 验证示例：`examples/basic-sdk-host/`（依赖 `file:../../dist-sdk-package`）。

### 3. Python Tracking Service 模式（视觉输入源）

仅输出 **`tracking.rigFrame`**，不控制舵机。

```bash
cd tools/tracking_service
pip install -r requirements.txt
python mediapipe_tracking_server.py
# 或：python mock_tracking_server.py
```

前端连接默认 **`ws://127.0.0.1:8766/tracking`**。说明见 [docs/PYTHON_TRACKING_SERVICE.md](./docs/PYTHON_TRACKING_SERVICE.md)；协议见 [docs/TRACKING_PROTOCOL.md](./docs/TRACKING_PROTOCOL.md)。

### 边界说明（摘要）

1. SDK 核心输出为 **`logicalPose`**，**不等于**实际舵机 PWM；**`actualPose`** 仅诊断。
2. **WebSerial** 为内部硬件联调能力；Python 服务**不写串口**。
3. Tracking **仅经 RigFrame** 驱动 Face Rig；MediaPipe 映射为第一版，后续单独调参；识别点与控件不对应属 **mapping** 问题。

---

## 技术栈

- **运行时**：React 18、Vite 5
- **动效**：Framer Motion（舵机控制面板内使用）
- **通信**：Chromium 系浏览器的 [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API)

## 环境要求

- **Node.js**：建议 18+（与 Vite 5 兼容）
- **浏览器**：Chrome / Edge 等支持 Web Serial 的 Chromium 内核浏览器（需 **HTTPS** 或 **localhost**）
- **硬件**：通过 USB 串口连接的下位机，协议需与 `src/core/servoProtocol.js` 中命令格式一致

## 快速开始

```bash
npm install
npm run dev
```

默认在本地开发服务器打开应用（一般为 `http://localhost:5173`，以终端输出为准）。

```bash
npm run build    # 生产构建
npm run preview  # 预览构建结果
```

## 应用结构（两页切换）

顶部可在两个大页面间切换：

| 页面 | 内容 |
|------|------|
| **串口与单舵机控制** | `SerialPanel`：串口连接、收发日志；`ServoControlPanel`：单舵机 HUD 控制、参数配置、分组/方向、逻辑→实际 PWM 预览、舵机配置导入/导出 |
| **动作帧编辑与预览** | `FrameEditor`：24 路阵列编辑、**单表情**多关键帧时间轴、播放/区间/循环、本地存储与 JSON 导入导出、串口实时下发与多舵机同步命令 |

全局状态在 `App.jsx` 中维护，主要包括：

- `servoConfigProject`：舵机配置工程（含 `servos`、`groups`、`device` 等），由 `loadServoConfigProject()` 初始化
- `frameProject`：单表情关键帧工程（见下文数据模型）
- `currentPose`：当前各舵机 **逻辑 PWM**，键为 `"0"`～`"23"` 字符串

## 核心模块说明

### 舵机配置 `src/core/servoConfig.js`

- **舵机数量**：`SERVO_COUNT = 24`
- **逻辑 PWM 范围**：`500`～`2500`（界面与关键帧中统一使用逻辑值）
- **映射**：`logicalToActualPwm()` 根据机械零位、`zeroOffsetPwm`、方向、实际限位等进行线性映射；单舵机预览与下发均走此逻辑
- **工程形态**：`normalizeServoConfigProject` / `loadServoConfigProject` / `saveServoConfigProject`，导出可含 `device`、`groups`、`servos`

### 串口协议 `src/core/servoProtocol.js`

典型单舵机指令：`#000P1500T1000!`（ID、PWM、时间 ms）  
多舵机同步：`{...}` 包裹多条单舵指令。  
另有停止全部等扩展命令（见文件内注释与 `buildStopAllCommand` 等）。

### 单表情工程 `src/core/frameProject.js`

- **类型标识**：`projectType: "robot-face-single-expression"`，`version: "1.0.0"`
- **关键帧**：`keyframes[]`，每帧含 `keyframeId`、`name`、`durationMs`、`easing`、`positions`  
  - `positions`：对象，键为舵机 ID 字符串，值为 **逻辑 PWM**
- **兼容**：若导入旧结构含 `actionGroups[].frames[]`，会取第一个分组并映射为 `keyframes`（含 `pose`→`positions`）
- **持久化键**（localStorage）：`servo-face-console:single-expression-project`  
- **API 摘要**：`normalizeFrameProject`、`addKeyframe`、`updateKeyframe`、`deleteKeyframe`、`moveKeyframe`、`copyKeyframe`、`insertKeyframe`、`loadFrameProject`、`saveFrameProject`、`buildFrameProjectExport`（导出可附 `servoConfigSnapshot`）

### 播放引擎 `src/core/actionPlayer.js`

- `buildKeyframeCommand`：将一帧内所有启用舵机的逻辑 PWM 转为实际 PWM，组装 **多舵机一条** `buildMultiServoMoveCommand`
- `playKeyframe` / `playKeyframes`：顺序发送并等待每帧 `durationMs`

### 动作编辑器 UI `src/components/FrameEditor.jsx`

- 左侧：4×6 **高密度**舵机卡片（数值、滑条、实际 PWM 与分组/方向提示、回中）
- 调节滑条时：节流后通过串口 **单舵机**命令实时下发（可选 quiet 模式）
- 右侧：表情名称、摘要、新建/保存/加载（浏览器本地）/导入/导出 JSON、关键帧增删改复制插入与排序
- 底部：可拖拽高度时间轴、Shift 范围选择、播放全部/单帧/区间、循环、停止、停止全部舵机
- **注意**：当前工程中 `FramePreviewPanel.jsx` 仍存在，但 **未** 挂在 `App.jsx` 路由上；多分组/多表情播放请以本仓库 `frameProject` + `actionPlayer` 为准

### 单舵机面板 `src/components/ServoControlPanel.jsx`

- 控制与配置双模式、分组与方向下拉、配置导入导出与 `currentPose` 同步  
- 配置变更通过 `onConfigsChange` 回传并更新 `App` 内 `servoConfigProject.servos`

## 本地存储（localStorage）

| 键名 | 用途 |
|------|------|
| `servo-face-console:servo-configs` | 舵机配置工程（`loadServoConfigProject` / `saveServoConfigProject`） |
| `servo-face-console:single-expression-project` | 单表情关键帧工程（`loadFrameProject` / `saveFrameProject`） |

## 样式与布局

- 全局与布局：`src/App.css`、`src/styles/base.css`、`src/styles/layout.css`
- 串口/舵机面板：`serial-panels.css`、`servo-panels.css`
- 帧编辑页专用：`src/styles/frame-editor.css`（浅色 Pro 风、侧栏与时间轴可拖拽尺寸等）

## 仓库目录结构

下列树形为**本仓库源代码与构建配置**的完整清单（不含 `node_modules`；`dist/` 仅在执行 `npm run build` 后出现）。

```
servo-face-console/                 # 项目根目录（与 package.json 的 name 一致；本地文件夹名可能不同，如 04_Software）
├── index.html                      # Vite 入口 HTML
├── package.json
├── package-lock.json
├── vite.config.js                  # Vite + @vitejs/plugin-react
├── README.md
├── dist/                           # 可选：npm run build 产物（勿提交或按 .gitignore）
│   ├── index.html
│   └── assets/
└── src/
    ├── main.jsx                    # ReactDOM.createRoot，挂载 App
    ├── App.jsx                     # 顶层路由：两页切换、全局状态聚合
    ├── App.css                     # 主容器（.app / .app-header 等）
    ├── components/
    │   ├── SerialPanel.jsx        # 串口连接、收发、日志
    │   ├── ServoControlPanel.jsx  # 单舵机控制 + 配置 Tab、currentPose 同步
    │   ├── FrameEditor.jsx         # 单表情关键帧编辑（当前 App 帧页唯一挂载）
    │   └── FramePreviewPanel.jsx  # 遗留：多分组/表情播放面板，当前未在 App.jsx 中使用
    ├── core/
    │   ├── servoConfig.js         # 舵机工程、分组、logicalToActualPwm、localStorage
    │   ├── servoProtocol.js       # 单/多舵机指令、停止等协议字符串
    │   ├── webSerial.js           # Web Serial API 封装（连接、读写）
    │   ├── frameProject.js        # 单表情 keyframes、normalize、导入兼容、localStorage
    │   └── actionPlayer.js        # 关键帧→多舵机命令、playKeyframe / playKeyframes
    ├── styles/
    │   ├── base.css               # 全局 body、按钮/输入默认、.hint 等
    │   ├── layout.css             # app-header、app-grid、页面切换按钮
    │   ├── serial-panels.css      # 串口面板
    │   ├── servo-panels.css       # 舵机控制/配置面板（含 --pro-* 等）
    │   └── frame-editor.css       # FrameEditor 专用（栅格、时间轴、调节柄）
    └── utils/
        ├── clamp.js               # toInt、clampNumber
        ├── storage.js             # readJsonStorage / writeJsonStorage（localStorage）
        └── fileExport.js          # 导出 JSON 文件名与时间戳
```

### 按职责速查

| 路径 | 职责 |
|------|------|
| `index.html` + `src/main.jsx` | 浏览器入口与 React 根组件挂载 |
| `src/App.jsx` | 状态：`servoConfigProject`、`frameProject`、`currentPose`；渲染控制页 / 帧编辑页 |
| `src/components/*.jsx` | UI 组件；业务逻辑多委托给 `core/` |
| `src/core/*.js` | **无 UI**：配置模型、协议、序列化存储、播放与串口 |
| `src/styles/*.css` | 按页面/面板拆分样式；`frame-editor.css` 仅被 `FrameEditor` import |
| `src/utils/*.js` | 纯工具，供 `core/` 与各组件调用 |

## 开发与注意事项

1. **首次使用**需在浏览器中授予串口权限，并选择正确的 USB 串口设备。  
2. **未连接串口**时，编辑器仍会更新关键帧数据；下发命令会提示未连接或使用 quiet 分支不刷屏。  
3. 逻辑值与校准强依赖 **舵机配置**；导出表情工程时可包含 `servoConfigSnapshot`，便于另一端复现。  
4. 若从旧备份恢复，建议先 **导入舵机配置** 再导入表情 JSON，避免映射不一致。

## To-Do

> 用于记录后续迭代项；完成后可打勾并补充 PR/版本号。

### 短期（本周）
- [ ] 关键帧编辑器增加“吸附到刻度”和可视化时间刻度标签（当前仅网格背景）
- [ ] 增加导入 JSON 的结构校验与错误定位（指出字段路径，而非仅 message）
- [ ] 串口发送增加统一重试与超时提示（包括实时拖动发送与批量播放）
- [ ] 增加简单的舵机运动匹配、联动
- [ ] 实现基于面部的运动定义、播放

### 中期（本月）

- [ ] 为关键数据模型补充单元测试（`frameProject` / `actionPlayer` / `servoConfig`）
- [ ] 增加配置与表情工程的版本迁移文档（含旧格式到新格式映射示例）
- [ ] 补充“快速校准流程”文档（首次接线、零位、方向、限位、保存）


### 长期（规划）

- [ ] 将 `FramePreviewPanel` 与当前单表情工程模型统一，决定保留/重构/移除策略
- [ ] 生成桌面端应用程序方便使用。

## 许可证与版本

本项目为私有/工程用代码时请按团队约定添加许可证声明。  

`package.json` 中前端包版本号为 `0.2.0-beta`；表情工程与舵机配置的 **业务版本**分别以 `FRAME_PROJECT_VERSION`、`SERVO_CONFIG_VERSION`（见 `servoConfig.js`）为准。
