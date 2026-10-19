# FaceDEV Architecture

本文描述仓库**目录边界**与**数据流**，便于区分源码、构建产物与本地环境。构建产物与依赖目录不应作为「架构源码」阅读；见文末「构建产物」与根目录 `npm run tree:clean`。

---

## 1. 产品形态

FaceDEV 当前包含三种形态：

1. **FaceDEV App**：`npm run dev` / `npm run build`，完整浏览器上位机（含 WebSerial、面部绑定、表情编排、Tracking 等）。
2. **`@facedev/sdk`**：`npm run build:sdk` + `npm run pack:sdk`，供其它 React 项目本地安装的可复用库（见 `docs/SDK_QUICK_START.md`）。
3. **Python Tracking Service**：`tools/tracking_service/`，仅通过 WebSocket 输出 **`tracking.rigFrame`**，不控制舵机。

---

## 2. 总体数据流

### 2.1 手动控件输入

```text
Face Rig Controls
  → RigState（Elite Rig）
  → mapFaceRigToPose / profile（绑定与映射）
  → logicalPose
  → Expression 关键帧 / protocol（moves、command 预览）
  → 可选 WebSerial 下发
```

### 2.2 Tracking 输入

```text
Python MediaPipe /（未来）MediaPipe Web
  → tracking.rigFrame
  → TrackingAdapter（createWebSocketTrackingAdapter）
  → RigState 更新（Drive Rig 且 faceDetected 等策略满足时）
  → 同上：logicalPose → …
```

### 2.3 表情编排

```text
logicalPose / 当前面控
  → keyframe.positions（工程数据）
  → ExpressionProject + ExpressionPlayback
  → 播放时 pose / command 预览 / 可选 WebSerial
```

---

## 3. `docs/`

| 内容 | 文件示例 |
|------|-----------|
| SDK 使用与安装 | `SDK_QUICK_START.md` |
| API 摘要 | `SDK_API.md` |
| Tracking 协议 | `TRACKING_PROTOCOL.md` |
| Python 服务 | `PYTHON_TRACKING_SERVICE.md` |
| 架构说明 | `ARCHITECTURE.md`（本文） |
| 发布前检查 | `RELEASE_CHECKLIST.md` |
| 干净目录树 | `PROJECT_TREE.md`（`npm run tree:docs` 生成） |

---

## 4. `examples/`

- **职责**：展示外部项目如何依赖 `@facedev/sdk`，**不承载**主工程业务逻辑。
- **当前**：`examples/basic-sdk-host/`（Vite + React；仓库内常用 `file:../../dist-sdk-package`，**外发 zip** 内由脚本改为 `file:../../facedev-sdk-<version>.tgz`，见 **`docs/DISTRIBUTION_PACKAGING.md`**）。
- **`node_modules/`、`dist/`**：由 `.gitignore` 排除，不纳入版本管理。

---

## 5. `scripts/`

- **职责**：SDK 打包、工程维护、干净项目树输出、**外发 zip 组包**等。
- **已有**：`prepare-sdk-package.mjs`、`print-project-tree.mjs`（`npm run tree:clean` / `tree:docs`）。
- **外发**：`make-distribution-zip.mjs`（`npm run dist:zip`；与 `pack:sdk` 组合为 `npm run dist:release`）。说明见 **`docs/DISTRIBUTION_PACKAGING.md`**。

## 5.1 `distribution/`（维护者模板）

- **职责**：生成 zip 根目录下 `TEST_GUIDE_*` / `RELEASE_NOTES_*` / `FEEDBACK_TEMPLATE.md` 的模板源文件；**不**随 zip 整目录复制，仅由脚本读取。

---

## 6. `public/`

- **职责**：Vite 静态资源根（构建时原样拷贝到 `dist/`）。当前可为空；保留目录便于后续放 favicon、静态说明等。

---

## 7. `src/core/`

- **职责**：内部**底层业务实现**（舵机配置、协议、WebSerial、单表情工程、播放、面部 profile、控件 ↔ pose 映射等）。
- **关系**：服务主 **App**；被 **`src/sdk`** 通过相对路径引用并组合为稳定 API。
- **注意**：此处 API **不承诺**为最终对外稳定契约；对外以 `src/sdk` 导出为准。
- **原则**：不继续堆叠大块 UI 逻辑。

---

## 8. `src/sdk/`

- **职责**：可打包的 **SDK/API 外壳**（`vite.sdk.config.js` → `dist-sdk/`）。
- **结构**：`binding/`、`core/`、`expression/`、`protocol/`、`tracking/`、`react/`、`index.js`、`style.css`、`README.md` 等。
- **边界**（与 WebSerial）：
  - `sdk/core`、`binding`、`expression`、`protocol`、`tracking`：**不**直接依赖 WebSerial。
  - `sdk/react`：当前视为**内部硬件联调 UI**（如 `FaceExpressionEditor` 可走 WebSerial）；后续对外发布时再考虑 transport / props 注入。

---

## 9. `src/sdk/react/`

- 面部绑定、表情编排、Tracking 面板等 React 组件。
- **现状**：允许 WebSerial 联调路径；与纯计算层分离在 `sdk/core` 等目录。

---

## 10. `src/pages/`

- **职责**：内部 App **页面入口**，以组合为主（串口与单舵机、底层帧编辑、面部绑定、表情编排等）。
- **原则**：业务逻辑尽量在 `src/core` 或 `src/sdk`；页面避免膨胀为巨型单文件组件。

---

## 11. `src/components/`

- **职责**：主 App 专用组件及尚未迁往 SDK 的旧组件。
- **原则**：稳定且应对外复用的 UI 逐步迁到 `src/sdk/react`；**不把新的对外 SDK 组件**长期堆在 `components/`。

---

## 12. `src/hooks/`

- **职责**：通用 React Hooks（如 `useFaceRigInteraction`）。
- **原则**：宿主可继续从 `hooks/` 引用；SDK 需暴露时由 `src/sdk/react/index.js` **再导出**（与当前 `useFaceRigInteraction` 一致）。

---

## 13. `src/styles/` 与 `src/sdk/style.css`

- **`src/styles/`**：主 App 与各面板样式源文件。
- **`src/sdk/style.css`**：SDK 样式聚合入口（当前 `@import` 主样式中的面部/帧编辑相关 CSS）；后续可再拆分为 App 专用 / SDK 专用 / 调试样式。

---

## 14. `src/state/`

- **当前**：仅保留 **`README.md`** 占位，说明与 `App.jsx` 全局状态的分工；业务状态仍以 `App.jsx` 等为主。
- **后续**：若引入可预测的跨页状态模块，可在此目录收敛，避免与 `components/` 混放。

---

## 15. `tools/tracking_service/`

- **Python** WebSocket 服务（如 `mediapipe_tracking_server.py` 等），只输出 **`tracking.rigFrame`**。
- **不**生成舵机命令、**不**写串口。
- 模型 **`face_landmarker.task`**：本地放入 `models/`，下载说明见 `models/README.md`；大文件默认**不提交**（见根 `.gitignore`）。

---

## 16. 构建产物与本地环境（非架构源码）

以下目录/文件为**生成物或环境**，阅读架构时请忽略（并已列入 `.gitignore`）：

| 路径 | 说明 |
|------|------|
| `dist/` | 主 App 生产构建 |
| `dist-sdk/` | SDK 库构建 |
| `dist-sdk-package/` | `npm pack` 前的可安装包目录 |
| `examples/**/dist/` | 示例工程构建 |
| `node_modules/`、`examples/**/node_modules/` | 前端依赖 |
| `tools/**/.venv/`、`tools/**/venv/` | Python 虚拟环境 |
| `tools/**/__pycache__/`、`*.pyc` 等 | Python 缓存 |
| `.vite/` | Vite 缓存 |
| `*.tgz` | `npm pack` 生成的 SDK 压缩包 |

生成「干净项目树」：`npm run tree:clean`；写入文档：`npm run tree:docs`。
