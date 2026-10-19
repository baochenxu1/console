# FaceDEV SDK 测试指引 — {{VERSION_LABEL}}

本文面向**收到分发压缩包**的测试同事：解压后根目录应为 `facedev-sdk-{{VERSION_LABEL}}/`，其下含 `facedev-sdk-{{NPM_PKG_VERSION}}.tgz`、`docs/`、`examples/`、`tools/` 及本指引等文件。

## 0. 压缩包自检（发送方应已执行）

解压后确认**不应出现**：

- 任意 `node_modules/` 目录  
- 任意 `.venv/`、`venv/`  
- `dist-sdk-package/`（中间安装目录；分发包只提供 **tgz**）  
- `face_landmarker.task`（体积大，需测试者按文档自行下载）

若发现上述项，请勿继续测试，退回给构建方。

---

## 1. 验证 tgz + 示例宿主

1. 进入示例目录：

   ```bash
   cd facedev-sdk-{{VERSION_LABEL}}/examples/basic-sdk-host
   ```

2. 安装依赖（`package.json` 已指向压缩包根目录下的 `facedev-sdk-{{NPM_PKG_VERSION}}.tgz`）：

   ```bash
   npm install
   ```

3. 构建：

   ```bash
   npm run build
   ```

4. 本地界面验证：

   ```bash
   npm run dev
   ```

   浏览器中确认：**面部绑定**、**表情编排**（含 Tracking 区域）能打开；样式正常。

更详细的集成说明见：**`docs/SDK_QUICK_START.md`**。

---

## 2. 可选：Python Mock Tracking

1. 进入服务目录并创建虚拟环境（任选）：

   ```bash
   cd ../../tools/tracking_service
   python -m venv .venv
   ```

   Windows：`.venv\Scripts\activate`  
   Linux/macOS：`source .venv/bin/activate`

2. `pip install -r requirements.txt`

3. `python mock_tracking_server.py`

4. 在示例 `npm run dev` 打开的页面中，表情页 Tracking 选择 **WebSocket**，地址默认 **`ws://127.0.0.1:8766/tracking`**。

协议说明：**`docs/TRACKING_PROTOCOL.md`**  
Python 说明：**`docs/PYTHON_TRACKING_SERVICE.md`**

---

## 3. 可选：Python MediaPipe Tracking

1. 按 **`docs/PYTHON_TRACKING_SERVICE.md`** 与 **`tools/tracking_service/models/README.md`** 下载 **`face_landmarker.task`** 并放到：

   `tools/tracking_service/models/face_landmarker.task`

2. 在同一 venv 下：`python mediapipe_tracking_server.py`

3. 前端同样连接 **`ws://127.0.0.1:8766/tracking`**（与 Mock **不要同时**占用同端口）。

---

## 4. 反馈

请使用同目录下的 **`FEEDBACK_TEMPLATE.md`** 填写后发回。
