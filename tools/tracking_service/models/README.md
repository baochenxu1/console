# Face Landmarker 模型

## 版本管理

- **`face_landmarker.task` 体积较大**，默认**不纳入 Git**（见仓库根目录 `.gitignore` 中 `tools/tracking_service/models/*.task`）。
- 每位开发者或 CI 机器需在本地按下文下载后放入本目录；若团队策略允许将二进制纳入 LFS 或制品库，可再单独约定。

---

请将 **MediaPipe Tasks** 配套的 **`face_landmarker.task`** 放在本目录下：

```text
tools/tracking_service/models/face_landmarker.task
```

可从 Google AI Edge 官方模型存储桶获取（若链接变更，请以 [Face Landmarker 文档](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) 为准）：

`https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task`

未放置模型时，`mediapipe_tracking_server.py` 启动会报错并退出，不会静默失败。
