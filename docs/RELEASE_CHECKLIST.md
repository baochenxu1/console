# Release Checklist

发布或交付前建议逐项执行；本清单**不替代**自动化测试，仅作人工回归备忘。

---

## App

```bash
npm install
npm run build
```

---

## SDK

```bash
npm run build:sdk
npm run pack:sdk
```

确认根目录生成 `facedev-sdk-<version>.tgz`，且 `dist-sdk-package/package.json` 的 `exports` 与产物一致。

## 外发 zip（可选）

```bash
npm run dist:release
```

确认生成 `dist/facedev-sdk-v0.2.0-beta.zip`（或当前 `FACEDEV_DIST_VERSION` 对应文件名），且脚本输出的 zip 内容验收通过。详见 **`docs/DISTRIBUTION_PACKAGING.md`**。

---

## SDK Example

```bash
cd examples/basic-sdk-host
npm install
npm run build
```

（开发验证可加：`npm run dev`。）

---

## Python Service

```bash
cd tools/tracking_service
python -m py_compile mock_tracking_server.py mediapipe_tracking_server.py
```

运行级验证需本地 venv + 依赖 +（MediaPipe 路径下）`models/face_landmarker.task`，见 `docs/PYTHON_TRACKING_SERVICE.md`。

---

## Manual Validation

1. App 各页面能打开、切换正常。
2. **FaceBindingEditor** 能使用（绑定、控件、诊断）。
3. **FaceExpressionEditor** 能使用（时间轴、关键帧、Tracking 区）。
4. Tracking **WebSocket** 能连接默认 `ws://127.0.0.1:8766/tracking` 并有帧（需先启动 Python 服务）。
5. **SDK 示例** `examples/basic-sdk-host` 能启动并渲染绑定 / 表情页。
6. **JSON** 导入导出格式与历史版本兼容策略**不变**（见各模块注释与既有行为）。
7. **WebSerial** 内部联调能力不回退（连接、预览、下发路径仍可用）。

---

## 文档与结构

1. `docs/ARCHITECTURE.md`、`docs/README.md` 与根 `README.md` 指向一致。
2. `npm run tree:clean` 输出合理；可选 `npm run tree:docs` 更新 `docs/PROJECT_TREE.md`。
